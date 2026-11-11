-- Inbound (unloading) and outbound (loading) QC, order reconciliation and posting.
-- PRD refs: §7.3 QCI-*, QCO-*, QC-*, REC-01..04, AU-02.
--
-- Lifecycle: draft -> submitted -> posted. A posted record is never edited:
-- it can be reversed (reason required), which writes reversing stock movements,
-- and a corrected record is created that links back to it (amends_id).

create type public.qc_status as enum ('draft', 'submitted', 'posted', 'reversed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Inbound QC
-- ---------------------------------------------------------------------------
create table public.qc_inbound (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  ticket_id uuid not null references public.weighbridge_tickets (id),
  plant_id uuid not null references public.plants (id),
  supplier_id uuid references public.parties (id),
  broker_id uuid references public.brokers (id),
  location_id uuid references public.locations (id),
  status public.qc_status not null default 'draft',
  notes text,
  qc_user uuid default auth.uid(),
  submitted_at timestamptz,
  posted_by uuid,
  posted_at timestamptz,
  reversed_by uuid,
  reversed_at timestamptz,
  reversal_reason text,
  amends_id uuid references public.qc_inbound (id),
  calc_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index qc_inbound_one_active_per_ticket on public.qc_inbound (ticket_id)
  where status in ('draft', 'submitted', 'posted');

create table public.qc_inbound_lines (
  id uuid primary key default gen_random_uuid(),
  qc_id uuid not null references public.qc_inbound (id) on delete cascade,
  line_no integer not null,
  variety_id uuid not null references public.varieties (id),
  po_line_id uuid references public.po_lines (id),
  moisture_pct numeric(5, 2) not null check (moisture_pct between 0 and 60),
  sacks_received integer not null check (sacks_received > 0),
  returned_sacks integer not null default 0 check (returned_sacks >= 0),
  rejected_bags integer not null default 0 check (rejected_bags >= 0),
  -- Computed by post_qc_inbound from the ticket's net weight (snapshot, never recalculated).
  line_net_kg numeric(14, 2),
  rejected_kg numeric(14, 2),
  moisture_deduction_kg numeric(14, 2),
  accepted_kg numeric(14, 2),
  lot_no text,
  unique (qc_id, line_no),
  check (returned_sacks + rejected_bags <= sacks_received)
);

-- ---------------------------------------------------------------------------
-- Outbound QC (loading, multiple varieties per vehicle)
-- ---------------------------------------------------------------------------
create table public.qc_outbound (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  dispatch_no text unique,
  ticket_id uuid not null references public.weighbridge_tickets (id),
  plant_id uuid not null references public.plants (id),
  location_id uuid references public.locations (id),
  driver_name text,
  driver_phone text,
  status public.qc_status not null default 'draft',
  notes text,
  qc_user uuid default auth.uid(),
  submitted_at timestamptz,
  posted_by uuid,
  posted_at timestamptz,
  over_allocation_reason text,
  reversed_by uuid,
  reversed_at timestamptz,
  reversal_reason text,
  amends_id uuid references public.qc_outbound (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence public.dispatch_no_seq start 3001;

create unique index qc_outbound_one_active_per_ticket on public.qc_outbound (ticket_id)
  where status in ('draft', 'submitted', 'posted');

create table public.qc_outbound_lines (
  id uuid primary key default gen_random_uuid(),
  qc_id uuid not null references public.qc_outbound (id) on delete cascade,
  line_no integer not null,
  variety_id uuid not null references public.varieties (id),
  so_line_id uuid references public.so_lines (id),
  bags integer not null check (bags > 0),
  bag_weight_kg numeric(8, 2) not null check (bag_weight_kg > 0),
  -- Placeholder for the client's "classic" calculation (PRD D-04): bags x bag weight.
  qty_kg numeric(14, 2) generated always as (round(bags * bag_weight_kg, 2)) stored,
  lot_no text,
  unique (qc_id, line_no)
);

create trigger qc_inbound_touch before update on public.qc_inbound
  for each row execute function public.touch_updated_at();
create trigger qc_outbound_touch before update on public.qc_outbound
  for each row execute function public.touch_updated_at();

create trigger audit_qc_inbound after insert or update or delete on public.qc_inbound
  for each row execute function public.audit_trigger();
create trigger audit_qc_inbound_lines after insert or update or delete on public.qc_inbound_lines
  for each row execute function public.audit_trigger();
create trigger audit_qc_outbound after insert or update or delete on public.qc_outbound
  for each row execute function public.audit_trigger();
create trigger audit_qc_outbound_lines after insert or update or delete on public.qc_outbound_lines
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Edit guards: only drafts are editable directly; status changes go through RPCs.
-- ---------------------------------------------------------------------------
create or replace function public.qc_header_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('app.via_rpc', true) = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'Start QC from the work queue' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'QC records cannot be deleted. Cancel or reverse instead.' using errcode = '42501';
  end if;
  if old.status <> 'draft' then
    raise exception 'Only draft QC records can be edited (this one is %).', old.status using errcode = '42501';
  end if;
  if new.status <> old.status or new.ticket_id <> old.ticket_id or new.pid <> old.pid
     or new.qc_user is distinct from old.qc_user then
    raise exception 'Use the Submit / Post / Cancel actions to change status.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger qc_inbound_guard before insert or update or delete on public.qc_inbound
  for each row execute function public.qc_header_guard();
create trigger qc_outbound_guard before insert or update or delete on public.qc_outbound
  for each row execute function public.qc_header_guard();

create or replace function public.qc_inbound_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status public.qc_status;
begin
  if current_setting('app.via_rpc', true) = 'on' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.qc_inbound where id = coalesce(new.qc_id, old.qc_id);
  if v_status is distinct from 'draft' then
    raise exception 'Lines can only be changed while the QC record is a draft.' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' then
    new.line_net_kg := null;
    new.rejected_kg := null;
    new.moisture_deduction_kg := null;
    new.accepted_kg := null;
    new.lot_no := null;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger qc_inbound_lines_guard before insert or update or delete on public.qc_inbound_lines
  for each row execute function public.qc_inbound_lines_guard();

create or replace function public.qc_outbound_lines_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status public.qc_status;
begin
  if current_setting('app.via_rpc', true) = 'on' then
    return coalesce(new, old);
  end if;
  select status into v_status from public.qc_outbound where id = coalesce(new.qc_id, old.qc_id);
  if v_status is distinct from 'draft' then
    raise exception 'Lines can only be changed while the QC record is a draft.' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger qc_outbound_lines_guard before insert or update or delete on public.qc_outbound_lines
  for each row execute function public.qc_outbound_lines_guard();

-- ---------------------------------------------------------------------------
-- Order balance views (security invoker => caller's RLS applies)
-- ---------------------------------------------------------------------------
create view public.po_line_balances with (security_invoker = true) as
select
  l.id as po_line_id,
  l.po_id,
  l.line_no,
  l.variety_id,
  l.ordered_kg,
  l.rate_per_qtl,
  coalesce(sum(ql.accepted_kg) filter (where q.status = 'posted'), 0) as accepted_kg,
  coalesce(sum(ql.rejected_kg) filter (where q.status = 'posted'), 0) as rejected_kg,
  coalesce(sum(ql.moisture_deduction_kg) filter (where q.status = 'posted'), 0) as moisture_deduction_kg,
  count(distinct q.id) filter (where q.status = 'submitted') as pending_receipts,
  l.ordered_kg - coalesce(sum(ql.accepted_kg) filter (where q.status = 'posted'), 0) as remaining_kg
from public.po_lines l
left join public.qc_inbound_lines ql on ql.po_line_id = l.id
left join public.qc_inbound q on q.id = ql.qc_id
group by l.id;

create view public.so_line_balances with (security_invoker = true) as
select
  l.id as so_line_id,
  l.so_id,
  l.line_no,
  l.variety_id,
  l.ordered_kg,
  l.rate_per_qtl,
  coalesce(sum(ol.qty_kg) filter (where q.status = 'posted'), 0) as dispatched_kg,
  count(distinct q.id) filter (where q.status = 'submitted') as pending_dispatches,
  l.ordered_kg - coalesce(sum(ol.qty_kg) filter (where q.status = 'posted'), 0) as remaining_kg
from public.so_lines l
left join public.qc_outbound_lines ol on ol.so_line_id = l.id
left join public.qc_outbound q on q.id = ol.qc_id
group by l.id;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_ticket_status(p_ticket uuid, p_status public.ticket_status)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.via_rpc', 'on', true);
  update public.weighbridge_tickets set status = p_status where id = p_ticket;
end;
$$;

revoke execute on function public.set_ticket_status(uuid, public.ticket_status) from public;

create or replace function public.next_lot_no()
returns text language sql volatile security definer set search_path = public as $$
  select 'LOT-' || to_char(now() at time zone 'Asia/Kolkata', 'YYMM') || '-' || lpad(nextval('public.lot_seq')::text, 4, '0');
$$;

-- ---------------------------------------------------------------------------
-- Inbound QC actions
-- ---------------------------------------------------------------------------
create or replace function public.start_qc_inbound(p_ticket uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  t public.weighbridge_tickets;
  v_existing uuid;
  v_prev public.qc_inbound;
  v_id uuid;
begin
  perform public.require_role('qc_unloading', 'qc_head', 'admin');
  select * into t from public.weighbridge_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket not found'; end if;
  if t.direction <> 'inbound' then raise exception 'This ticket is an outbound movement'; end if;

  select id into v_existing from public.qc_inbound
  where ticket_id = p_ticket and status in ('draft', 'submitted', 'posted');
  if v_existing is not null then
    return v_existing;
  end if;

  if t.status not in ('awaiting_qc', 'qc_in_progress') then
    raise exception 'Ticket % is % and cannot start QC', t.pid, t.status;
  end if;

  -- If a previous QC on this ticket was reversed, start the correction from it.
  select * into v_prev from public.qc_inbound
  where ticket_id = p_ticket and status = 'reversed'
  order by reversed_at desc limit 1;

  perform set_config('app.via_rpc', 'on', true);
  insert into public.qc_inbound (ticket_id, plant_id, supplier_id, broker_id, location_id, notes, qc_user, amends_id)
  values (p_ticket, t.plant_id, v_prev.supplier_id, v_prev.broker_id, v_prev.location_id, v_prev.notes, auth.uid(), v_prev.id)
  returning id into v_id;

  if v_prev.id is not null then
    insert into public.qc_inbound_lines (qc_id, line_no, variety_id, po_line_id, moisture_pct, sacks_received, returned_sacks, rejected_bags)
    select v_id, line_no, variety_id, po_line_id, moisture_pct, sacks_received, returned_sacks, rejected_bags
    from public.qc_inbound_lines where qc_id = v_prev.id;
  end if;

  perform public.set_ticket_status(p_ticket, 'qc_in_progress');
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

create or replace function public.submit_qc_inbound(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_inbound;
  v_lines integer;
  v_bad integer;
begin
  perform public.require_role('qc_unloading', 'qc_head', 'admin');
  select * into q from public.qc_inbound where id = p_id for update;
  if not found then raise exception 'QC record not found'; end if;
  if q.status <> 'draft' then raise exception 'Only drafts can be submitted (current: %)', q.status; end if;
  if public.has_role('qc_unloading') and q.qc_user <> auth.uid() then
    raise exception 'This QC record is assigned to another operator';
  end if;
  if q.supplier_id is null then raise exception 'Supplier is required'; end if;
  if q.location_id is null then raise exception 'Unloading location is required'; end if;

  select count(*) into v_lines from public.qc_inbound_lines where qc_id = p_id;
  if v_lines = 0 then raise exception 'Add at least one variety line'; end if;

  select count(*) into v_bad
  from public.qc_inbound_lines ql
  join public.po_lines pl on pl.id = ql.po_line_id
  join public.purchase_orders po on po.id = pl.po_id
  where ql.qc_id = p_id and (pl.variety_id <> ql.variety_id or po.supplier_id <> q.supplier_id or po.status <> 'open');
  if v_bad > 0 then
    raise exception 'A linked PO line does not match the variety/supplier or the PO is not open';
  end if;

  perform set_config('app.via_rpc', 'on', true);
  update public.qc_inbound set status = 'submitted', submitted_at = now() where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'submitted');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Return a submitted record to draft (reviewer sends it back).
create or replace function public.return_qc_inbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_inbound;
begin
  perform public.require_role('qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into q from public.qc_inbound where id = p_id for update;
  if q.status <> 'submitted' then raise exception 'Only submitted records can be returned'; end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);
  update public.qc_inbound set status = 'draft', submitted_at = null where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'qc_in_progress');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Post: compute quantities, write stock receipts, update PO balances — atomically.
-- Calculation is a configurable PLACEHOLDER until the client's method is confirmed (PRD D-03):
--   line net      = ticket net x (line sacks / total sacks)
--   rejected kg   = line net x (rejected + returned) / sacks received
--   moisture ded. = (line net - rejected) x max(0, moisture% - base moisture%) / 100
--   accepted      = line net - rejected - moisture deduction
create or replace function public.post_qc_inbound(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_inbound;
  t public.weighbridge_tickets;
  v_total_sacks numeric;
  v_base numeric;
  r record;
  v_net numeric;
  v_rej numeric;
  v_ded numeric;
  v_lot text;
begin
  perform public.require_role('qc_head', 'admin');
  select * into q from public.qc_inbound where id = p_id for update;
  if not found then raise exception 'QC record not found'; end if;
  if q.status <> 'submitted' then raise exception 'Only submitted records can be posted (current: %)', q.status; end if;

  select * into t from public.weighbridge_tickets where id = q.ticket_id for update;
  if t.net_kg is null then
    raise exception 'Weighing is incomplete for % (RST %). Record the tare weight before posting.', t.pid, t.rst;
  end if;

  select sum(sacks_received) into v_total_sacks from public.qc_inbound_lines where qc_id = p_id;
  v_base := public.calc_setting('moisture_base_pct', 14);

  perform set_config('app.via_rpc', 'on', true);

  for r in select * from public.qc_inbound_lines where qc_id = p_id order by line_no loop
    v_net := round(t.net_kg * r.sacks_received / v_total_sacks, 2);
    v_rej := round(v_net * (r.rejected_bags + r.returned_sacks) / r.sacks_received, 2);
    v_ded := round((v_net - v_rej) * greatest(0, r.moisture_pct - v_base) / 100, 2);
    v_lot := public.next_lot_no();

    update public.qc_inbound_lines
    set line_net_kg = v_net,
        rejected_kg = v_rej,
        moisture_deduction_kg = v_ded,
        accepted_kg = v_net - v_rej - v_ded,
        lot_no = v_lot
    where id = r.id;

    if v_net - v_rej - v_ded > 0 then
      insert into public.stock_movements
        (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
      values
        (q.plant_id, 'receipt', r.variety_id, q.location_id, v_lot, v_net - v_rej - v_ded,
         'qc_inbound', q.id, q.pid, 'RST ' || t.rst || ' · ' || t.vehicle_no);
    end if;
  end loop;

  update public.qc_inbound
  set status = 'posted', posted_by = auth.uid(), posted_at = now(),
      calc_snapshot = jsonb_build_object(
        'method', 'placeholder-v1',
        'moisture_base_pct', v_base,
        'ticket_net_kg', t.net_kg,
        'total_sacks', v_total_sacks)
  where id = p_id;

  perform public.set_ticket_status(q.ticket_id, 'posted');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.reverse_qc_inbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_inbound;
  m public.stock_movements;
begin
  perform public.require_role('qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reverse a posted record'; end if;
  select * into q from public.qc_inbound where id = p_id for update;
  if q.status <> 'posted' then raise exception 'Only posted records can be reversed'; end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);

  for m in select * from public.stock_movements
           where reference_id = p_id and reference_type = 'qc_inbound' and reverses_id is null
             and movement_type <> 'reversal' loop
    insert into public.stock_movements
      (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, reverses_id, note)
    values
      (m.plant_id, 'reversal', m.variety_id, m.location_id, m.lot_no, -m.qty_kg,
       'qc_inbound', p_id, q.pid, m.id, 'Reversal: ' || p_reason);
  end loop;

  update public.qc_inbound
  set status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = p_reason
  where id = p_id;

  perform public.set_ticket_status(q.ticket_id, 'awaiting_qc');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.cancel_qc_inbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_inbound;
begin
  perform public.require_role('qc_unloading', 'qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into q from public.qc_inbound where id = p_id for update;
  if q.status not in ('draft', 'submitted') then raise exception 'Only draft or submitted records can be cancelled'; end if;
  if public.has_role('qc_unloading') and (q.status <> 'draft' or q.qc_user <> auth.uid()) then
    raise exception 'You can only cancel your own drafts';
  end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);
  update public.qc_inbound set status = 'cancelled', notes = coalesce(notes || E'\n', '') || 'Cancelled: ' || p_reason where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'awaiting_qc');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Outbound QC actions
-- ---------------------------------------------------------------------------
create or replace function public.start_qc_outbound(p_ticket uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  t public.weighbridge_tickets;
  v_existing uuid;
  v_prev public.qc_outbound;
  v_id uuid;
begin
  perform public.require_role('qc_loading', 'qc_head', 'admin');
  select * into t from public.weighbridge_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket not found'; end if;
  if t.direction <> 'outbound' then raise exception 'This ticket is an inbound movement'; end if;

  select id into v_existing from public.qc_outbound
  where ticket_id = p_ticket and status in ('draft', 'submitted', 'posted');
  if v_existing is not null then
    return v_existing;
  end if;

  if t.status not in ('awaiting_qc', 'qc_in_progress') then
    raise exception 'Ticket % is % and cannot start QC', t.pid, t.status;
  end if;

  select * into v_prev from public.qc_outbound
  where ticket_id = p_ticket and status = 'reversed'
  order by reversed_at desc limit 1;

  perform set_config('app.via_rpc', 'on', true);
  insert into public.qc_outbound (ticket_id, plant_id, location_id, driver_name, driver_phone, notes, qc_user, amends_id)
  values (p_ticket, t.plant_id, v_prev.location_id, v_prev.driver_name, v_prev.driver_phone, v_prev.notes, auth.uid(), v_prev.id)
  returning id into v_id;

  if v_prev.id is not null then
    insert into public.qc_outbound_lines (qc_id, line_no, variety_id, so_line_id, bags, bag_weight_kg, lot_no)
    select v_id, line_no, variety_id, so_line_id, bags, bag_weight_kg, lot_no
    from public.qc_outbound_lines where qc_id = v_prev.id;
  end if;

  perform public.set_ticket_status(p_ticket, 'qc_in_progress');
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

create or replace function public.submit_qc_outbound(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_outbound;
  v_lines integer;
  v_bad integer;
begin
  perform public.require_role('qc_loading', 'qc_head', 'admin');
  select * into q from public.qc_outbound where id = p_id for update;
  if not found then raise exception 'QC record not found'; end if;
  if q.status <> 'draft' then raise exception 'Only drafts can be submitted (current: %)', q.status; end if;
  if public.has_role('qc_loading') and q.qc_user <> auth.uid() then
    raise exception 'This QC record is assigned to another operator';
  end if;
  if q.location_id is null then raise exception 'Loading location is required'; end if;
  if coalesce(btrim(q.driver_phone), '') = '' then raise exception 'Driver phone number is required'; end if;

  select count(*) into v_lines from public.qc_outbound_lines where qc_id = p_id;
  if v_lines = 0 then raise exception 'Add at least one variety line'; end if;

  select count(*) into v_bad from public.qc_outbound_lines where qc_id = p_id and so_line_id is null;
  if v_bad > 0 then raise exception 'Every variety line must be linked to a sales order line'; end if;

  select count(*) into v_bad
  from public.qc_outbound_lines ol
  join public.so_lines sl on sl.id = ol.so_line_id
  join public.sales_orders so on so.id = sl.so_id
  where ol.qc_id = p_id and (sl.variety_id <> ol.variety_id or so.status <> 'open');
  if v_bad > 0 then raise exception 'A linked SO line does not match the variety or the SO is not open'; end if;

  perform set_config('app.via_rpc', 'on', true);
  update public.qc_outbound set status = 'submitted', submitted_at = now() where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'submitted');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.return_qc_outbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_outbound;
begin
  perform public.require_role('qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into q from public.qc_outbound where id = p_id for update;
  if q.status <> 'submitted' then raise exception 'Only submitted records can be returned'; end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);
  update public.qc_outbound set status = 'draft', submitted_at = null where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'qc_in_progress');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Post a dispatch. Blocks over-allocation against SO balance unless an approver
-- supplies an override reason (QCO-05).
create or replace function public.post_qc_outbound(p_id uuid, p_override_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_outbound;
  t public.weighbridge_tickets;
  r record;
  v_tol numeric;
  v_over text := '';
  v_short text := '';
  v_need numeric;
  v_take numeric;
  v_lot record;
  v_vname text;
begin
  perform public.require_role('qc_head', 'admin');
  select * into q from public.qc_outbound where id = p_id for update;
  if not found then raise exception 'QC record not found'; end if;
  if q.status <> 'submitted' then raise exception 'Only submitted records can be posted (current: %)', q.status; end if;
  select * into t from public.weighbridge_tickets where id = q.ticket_id;

  v_tol := public.calc_setting('so_over_delivery_tolerance_pct', 0);

  -- Lock the SO lines being dispatched against so concurrent postings can't over-allocate.
  perform 1 from public.so_lines sl
  where sl.id in (select so_line_id from public.qc_outbound_lines where qc_id = p_id)
  for update;

  for r in
    select sl.id, so.so_no, sl.line_no, v.name as variety, sl.ordered_kg,
           sum(ol.qty_kg) as this_qty,
           coalesce((select sum(x.qty_kg) from public.qc_outbound_lines x
                     join public.qc_outbound xq on xq.id = x.qc_id
                     where x.so_line_id = sl.id and xq.status = 'posted'), 0) as already
    from public.qc_outbound_lines ol
    join public.so_lines sl on sl.id = ol.so_line_id
    join public.sales_orders so on so.id = sl.so_id
    join public.varieties v on v.id = sl.variety_id
    where ol.qc_id = p_id
    group by sl.id, so.so_no, sl.line_no, v.name, sl.ordered_kg
  loop
    if r.already + r.this_qty > r.ordered_kg * (1 + v_tol / 100) then
      v_over := v_over || format('%s line %s (%s): ordered %s kg, already dispatched %s kg, this load %s kg. ',
        r.so_no, r.line_no, r.variety, r.ordered_kg, r.already, r.this_qty);
    end if;
  end loop;

  if v_over <> '' and coalesce(btrim(p_override_reason), '') = '' then
    raise exception 'OVER_ALLOCATION: %Provide an approval reason to post anyway.', v_over;
  end if;

  perform set_config('app.via_rpc', 'on', true);

  -- Issue stock from the chosen lot, or oldest lots first (FIFO) at the loading location.
  -- A shortfall blocks posting unless an approver gives a reason; the unallocated
  -- remainder is then issued without a lot so the ledger still balances.
  for r in select * from public.qc_outbound_lines where qc_id = p_id order by line_no loop
    v_need := r.qty_kg;
    for v_lot in
      select b.lot_no, sum(b.qty_kg) as avail
      from public.stock_movements b
      where b.plant_id = q.plant_id and b.variety_id = r.variety_id and b.location_id = q.location_id
        and not b.is_estimate and b.lot_no is not null
        and (r.lot_no is null or b.lot_no = r.lot_no)
      group by b.lot_no
      having sum(b.qty_kg) > 0
      order by min(b.created_at)
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_lot.avail);
      insert into public.stock_movements
        (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
      values
        (q.plant_id, 'sales_issue', r.variety_id, q.location_id, v_lot.lot_no, -v_take,
         'qc_outbound', q.id, q.pid, 'RST ' || t.rst || ' · ' || t.vehicle_no);
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      select name into v_vname from public.varieties where id = r.variety_id;
      v_short := v_short || format('Line %s (%s): %s kg more than confirmed stock at the loading location%s. ',
        r.line_no, v_vname, v_need, case when r.lot_no is not null then ' in lot ' || r.lot_no else '' end);
      insert into public.stock_movements
        (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
      values
        (q.plant_id, 'sales_issue', r.variety_id, q.location_id, r.lot_no, -v_need,
         'qc_outbound', q.id, q.pid, 'RST ' || t.rst || ' · ' || t.vehicle_no || ' · issued beyond stock (approved)');
    end if;
  end loop;

  if v_short <> '' and coalesce(btrim(p_override_reason), '') = '' then
    raise exception 'INSUFFICIENT_STOCK: %Provide an approval reason to post anyway.', v_short;
  end if;

  if v_over <> '' or v_short <> '' then
    perform set_config('app.reason', 'Approved: ' || p_override_reason, true);
  end if;

  update public.qc_outbound
  set status = 'posted', posted_by = auth.uid(), posted_at = now(),
      dispatch_no = coalesce(dispatch_no, 'DSP-' || nextval('public.dispatch_no_seq')),
      over_allocation_reason = case when v_over <> '' or v_short <> '' then p_override_reason end
  where id = p_id;

  perform public.set_ticket_status(q.ticket_id, 'posted');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.reverse_qc_outbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_outbound;
  m public.stock_movements;
begin
  perform public.require_role('qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to reverse a posted record'; end if;
  select * into q from public.qc_outbound where id = p_id for update;
  if q.status <> 'posted' then raise exception 'Only posted records can be reversed'; end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);

  for m in select * from public.stock_movements
           where reference_id = p_id and reference_type = 'qc_outbound' and movement_type <> 'reversal' loop
    insert into public.stock_movements
      (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, reverses_id, note)
    values
      (m.plant_id, 'reversal', m.variety_id, m.location_id, m.lot_no, -m.qty_kg,
       'qc_outbound', p_id, q.pid, m.id, 'Reversal: ' || p_reason);
  end loop;

  update public.qc_outbound
  set status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = p_reason
  where id = p_id;

  perform public.set_ticket_status(q.ticket_id, 'awaiting_qc');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.cancel_qc_outbound(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  q public.qc_outbound;
begin
  perform public.require_role('qc_loading', 'qc_head', 'admin');
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required'; end if;
  select * into q from public.qc_outbound where id = p_id for update;
  if q.status not in ('draft', 'submitted') then raise exception 'Only draft or submitted records can be cancelled'; end if;
  if public.has_role('qc_loading') and (q.status <> 'draft' or q.qc_user <> auth.uid()) then
    raise exception 'You can only cancel your own drafts';
  end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_reason, true);
  update public.qc_outbound set status = 'cancelled', notes = coalesce(notes || E'\n', '') || 'Cancelled: ' || p_reason where id = p_id;
  perform public.set_ticket_status(q.ticket_id, 'awaiting_qc');
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.qc_inbound enable row level security;
alter table public.qc_inbound_lines enable row level security;
alter table public.qc_outbound enable row level security;
alter table public.qc_outbound_lines enable row level security;

create policy qc_inbound_read on public.qc_inbound for select to authenticated
  using (public.has_role('admin', 'management', 'qc_head', 'commercial', 'qc_unloading'));
create policy qc_inbound_update on public.qc_inbound for update to authenticated
  using (public.has_role('admin', 'qc_head') or (public.has_role('qc_unloading') and qc_user = auth.uid()))
  with check (public.has_role('admin', 'qc_head') or (public.has_role('qc_unloading') and qc_user = auth.uid()));

create policy qc_inbound_lines_read on public.qc_inbound_lines for select to authenticated
  using (exists (select 1 from public.qc_inbound q where q.id = qc_id));
create policy qc_inbound_lines_write on public.qc_inbound_lines for all to authenticated
  using (exists (select 1 from public.qc_inbound q where q.id = qc_id
                 and (public.has_role('admin', 'qc_head') or (public.has_role('qc_unloading') and q.qc_user = auth.uid()))))
  with check (exists (select 1 from public.qc_inbound q where q.id = qc_id
                 and (public.has_role('admin', 'qc_head') or (public.has_role('qc_unloading') and q.qc_user = auth.uid()))));

create policy qc_outbound_read on public.qc_outbound for select to authenticated
  using (public.has_role('admin', 'management', 'qc_head', 'commercial', 'qc_loading'));
create policy qc_outbound_update on public.qc_outbound for update to authenticated
  using (public.has_role('admin', 'qc_head') or (public.has_role('qc_loading') and qc_user = auth.uid()))
  with check (public.has_role('admin', 'qc_head') or (public.has_role('qc_loading') and qc_user = auth.uid()));

create policy qc_outbound_lines_read on public.qc_outbound_lines for select to authenticated
  using (exists (select 1 from public.qc_outbound q where q.id = qc_id));
create policy qc_outbound_lines_write on public.qc_outbound_lines for all to authenticated
  using (exists (select 1 from public.qc_outbound q where q.id = qc_id
                 and (public.has_role('admin', 'qc_head') or (public.has_role('qc_loading') and q.qc_user = auth.uid()))))
  with check (exists (select 1 from public.qc_outbound q where q.id = qc_id
                 and (public.has_role('admin', 'qc_head') or (public.has_role('qc_loading') and q.qc_user = auth.uid()))));
