-- Purchase slip per truck (client, 18 Nov 2026).
--
-- Today the QC man writes moisture, bags and claims on the weighbridge slip, the accountant types it
-- into Excel and prints a "Paddy/Rice/Wheat slip" that goes to the broker once payment is made.
-- Now the purchaser enters it on the phone (Purchase QC) and the ERP builds the slip:
--
--   Amount        = net weight (q) x rate per quintal            (rounded to the rupee)
--   Percent lines = amount x rate %       (cash discount, khad, moisture, dhalta, TDS)
--   Per-quintal   = net weight (q) x Rs/q (brokerage, unloading)
--   Flat          = Rs                    (RTGS)
--   Manual        = amount typed in       (additional claim)
--   Net payable   = amount - all deductions
--
-- Every parameter is editable by the administrator. A slip keeps the rates it was built with,
-- so changing a parameter never changes an existing slip. Admin and accountant may edit a slip
-- after it is final (reason required, revision number goes up, every change is in the audit log).

-- ---------------------------------------------------------------------------
-- New fields on the truck and on the purchase QC
-- ---------------------------------------------------------------------------
alter table public.weighbridge_tickets add column if not exists vehicle_type text;

alter table public.qc_inbound add column if not exists bag_status text
  check (bag_status in ('received', 'returned'));
alter table public.qc_inbound add column if not exists claim_details text;
alter table public.qc_inbound add column if not exists claim_amount numeric(12, 2) not null default 0
  check (claim_amount >= 0);

-- ---------------------------------------------------------------------------
-- Parameters
-- ---------------------------------------------------------------------------
insert into public.calc_settings (key, value, description) values
  ('slip_moisture_pass_pct', 16, 'Purchase slip: moisture up to this % passes with no deduction'),
  ('slip_moisture_progressive', 1, 'Purchase slip: 1 = each moisture band charged at its own rate (e.g. 22% = 4 pts x 1 + 2 pts x 1.5); 0 = all points at the rate of the band the reading falls in (22% = 6 pts x 1.5)'),
  ('slip_auto_whatsapp', 0, 'Purchase slip: 1 = send the slip to the broker on WhatsApp automatically when payment is recorded')
on conflict (key) do nothing;

-- Moisture bands above the pass level. Each band runs from the previous band's upper limit
-- (or the pass level) up to its own upper limit; a blank upper limit means "and above".
create table if not exists public.moisture_slabs (
  id uuid primary key default gen_random_uuid(),
  upto_pct numeric(5, 2) check (upto_pct is null or upto_pct between 0 and 60),
  per_point numeric(6, 3) not null check (per_point >= 0),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
create unique index if not exists moisture_slabs_one_open on public.moisture_slabs ((upto_pct is null)) where upto_pct is null;
insert into public.moisture_slabs (upto_pct, per_point)
select * from (values (20::numeric, 1::numeric), (24, 1.5), (null, 2)) v
where not exists (select 1 from public.moisture_slabs);

-- Deduction types printed on the slip, in order. New ones can be added by the administrator.
--   basis: percent (of amount), per_qtl (Rs per quintal), flat (Rs), moisture (from the bands),
--          dhalta (percent by bag status), manual (amount typed in), brokerage (Rs/q, broker's own rate first)
--   value / alt_value: cash discount normal / early payment; dhalta bags received / returned.
--   entered_later: filled in after unloading (e.g. Khad, next day). entry_roles may fill it in,
--   besides the admin and accountant.
create table if not exists public.purchase_deduction_types (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null,
  basis text not null check (basis in ('percent', 'per_qtl', 'flat', 'moisture', 'dhalta', 'manual', 'brokerage')),
  value numeric(12, 3) check (value is null or value >= 0),
  alt_value numeric(12, 3) check (alt_value is null or alt_value >= 0),
  alt_label text,
  entered_later boolean not null default false,
  entry_roles public.app_role[] not null default '{}',
  sort_order integer not null default 100,
  active boolean not null default true,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
insert into public.purchase_deduction_types (code, label, basis, value, alt_value, alt_label, entered_later, entry_roles, sort_order) values
  ('cash_discount', 'Cash discount', 'percent', 2, 2.5, 'Early payment', false, '{}', 10),
  ('khad', 'Khad', 'percent', 1, null, null, true, '{management,weighbridge_operator}', 20),
  ('moisture', 'Moisture', 'moisture', null, null, null, false, '{}', 30),
  ('dhalta', 'Dhalta', 'dhalta', 1.25, 1, 'Bags returned', false, '{}', 40),
  ('brokerage', 'Brokerage', 'brokerage', 7, null, null, false, '{}', 50),
  ('claim', 'Claim', 'manual', null, null, null, false, '{}', 60),
  ('unloading', 'Unloading', 'per_qtl', 10, null, null, false, '{}', 70),
  ('tds', 'TDS', 'percent', 0.1, null, null, false, '{}', 80),
  ('rtgs', 'RTGS', 'flat', 200, null, null, false, '{}', 90)
on conflict (code) do nothing;

create trigger moisture_slabs_touch before update on public.moisture_slabs
  for each row execute function public.touch_updated_at();
create trigger purchase_deduction_types_touch before update on public.purchase_deduction_types
  for each row execute function public.touch_updated_at();
create trigger audit_moisture_slabs after insert or update or delete on public.moisture_slabs
  for each row execute function public.audit_trigger();

create or replace function public.audit_purchase_deduction_types()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, record_id, pid, action, old_data, new_data, reason)
  values ('purchase_deduction_types', null, coalesce(new.code, old.code), lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end,
          nullif(current_setting('app.reason', true), ''));
  return coalesce(new, old);
end;
$$;
create trigger audit_purchase_deduction_types after insert or update or delete on public.purchase_deduction_types
  for each row execute function public.audit_purchase_deduction_types();

-- ---------------------------------------------------------------------------
-- Slips
-- ---------------------------------------------------------------------------
create sequence if not exists public.purchase_slip_seq start 1;

create table if not exists public.purchase_slips (
  id uuid primary key default gen_random_uuid(),
  slip_no text not null unique default ('PS-' || lpad(nextval('public.purchase_slip_seq')::text, 5, '0')),
  plant_id uuid not null references public.plants (id),
  qc_id uuid not null references public.qc_inbound (id),
  ticket_id uuid not null references public.weighbridge_tickets (id),
  slip_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  rst integer not null,
  vehicle_no text not null,
  vehicle_type text,
  party_id uuid references public.parties (id),
  broker_id uuid references public.brokers (id),
  location_id uuid references public.locations (id),
  variety text,
  bags_total integer not null default 0,
  bags_rejected integer not null default 0,
  bag_status text check (bag_status in ('received', 'returned')),
  moisture_pct numeric(5, 2),
  ticket_net_kg numeric(14, 2) not null,
  -- Weight paid for: ticket net less the share of rejected bags (they go back to the seller).
  net_kg numeric(14, 2) not null check (net_kg >= 0),
  rate_per_qtl numeric(12, 2) check (rate_per_qtl >= 0),
  early_payment boolean not null default false,
  claim_details text,
  amount numeric(14, 2) not null default 0,
  total_deductions numeric(14, 2) not null default 0,
  net_payable numeric(14, 2) not null default 0,
  -- Parameters in force when the slip was built (so later setting changes never alter it).
  params jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'final', 'paid', 'cancelled')),
  revision integer not null default 0,
  finalized_by uuid,
  finalized_at timestamptz,
  payment_id uuid references public.payments (id),
  cancel_reason text,
  share_token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists purchase_slips_one_per_qc on public.purchase_slips (qc_id) where status <> 'cancelled';
create index if not exists purchase_slips_date_idx on public.purchase_slips (slip_date desc);
create index if not exists purchase_slips_rst_idx on public.purchase_slips (rst);

create table if not exists public.purchase_slip_lines (
  id uuid primary key default gen_random_uuid(),
  slip_id uuid not null references public.purchase_slips (id) on delete cascade,
  code text,
  label text not null,
  basis text not null check (basis in ('percent', 'per_qtl', 'flat', 'moisture', 'dhalta', 'manual', 'brokerage')),
  rate numeric(12, 3) check (rate is null or rate >= 0),
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  -- true = the amount was typed in, not calculated from the rate.
  manual_amount boolean not null default false,
  pending boolean not null default false,
  note text,
  sort_order integer not null default 100,
  entered_by uuid,
  entered_at timestamptz
);
create index if not exists purchase_slip_lines_slip_idx on public.purchase_slip_lines (slip_id, sort_order);

create table if not exists public.purchase_slip_sends (
  id uuid primary key default gen_random_uuid(),
  slip_id uuid not null references public.purchase_slips (id),
  channel text not null check (channel in ('whatsapp_manual', 'whatsapp_auto')),
  to_phone text,
  status text not null check (status in ('opened', 'sent', 'failed', 'not_configured')),
  detail text,
  sent_by uuid default auth.uid(),
  sent_at timestamptz not null default now()
);
create index if not exists purchase_slip_sends_slip_idx on public.purchase_slip_sends (slip_id, sent_at desc);

create trigger purchase_slips_touch before update on public.purchase_slips
  for each row execute function public.touch_updated_at();
create trigger audit_purchase_slips after insert or update or delete on public.purchase_slips
  for each row execute function public.audit_trigger();
create trigger audit_purchase_slip_lines after insert or update or delete on public.purchase_slip_lines
  for each row execute function public.audit_trigger();

-- Slips change only through the functions below.
create or replace function public.purchase_slip_guard()
returns trigger language plpgsql as $$
begin
  if current_setting('app.via_rpc', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'Purchase slips change only through the slip actions.' using errcode = '42501';
end;
$$;
create trigger purchase_slips_guard before insert or update or delete on public.purchase_slips
  for each row execute function public.purchase_slip_guard();
create trigger purchase_slip_lines_guard before insert or update or delete on public.purchase_slip_lines
  for each row execute function public.purchase_slip_guard();
create trigger purchase_slip_sends_no_delete before delete on public.purchase_slip_sends
  for each row execute function public.accounts_no_delete();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Roles named on a later-entry deduction (e.g. who fills in Khad) may open slips to fill it in.
create or replace function public.can_enter_slip_deductions()
returns boolean language sql stable security definer set search_path = public
as $$
  select public.can_edit_accounts() or exists (
    select 1 from public.purchase_deduction_types d
    where d.active and d.entered_later and public.current_app_role() = any (d.entry_roles));
$$;

create or replace function public.can_view_slips()
returns boolean language sql stable security definer set search_path = public
as $$ select public.can_view_accounts() or public.has_role('qc_head') or public.can_enter_slip_deductions(); $$;

alter table public.moisture_slabs enable row level security;
alter table public.purchase_deduction_types enable row level security;
alter table public.purchase_slips enable row level security;
alter table public.purchase_slip_lines enable row level security;
alter table public.purchase_slip_sends enable row level security;

create policy moisture_slabs_read on public.moisture_slabs for select to authenticated using (public.is_active_user());
create policy moisture_slabs_admin on public.moisture_slabs for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy deduction_types_read on public.purchase_deduction_types for select to authenticated using (public.is_active_user());
create policy deduction_types_admin on public.purchase_deduction_types for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));
create policy purchase_slips_read on public.purchase_slips for select to authenticated using (public.can_view_slips());
create policy purchase_slip_lines_read on public.purchase_slip_lines for select to authenticated using (public.can_view_slips());
create policy purchase_slip_sends_read on public.purchase_slip_sends for select to authenticated using (public.can_view_slips());

-- ---------------------------------------------------------------------------
-- Calculation
-- ---------------------------------------------------------------------------
-- Moisture deduction % for a reading, from a bands snapshot {pass, progressive, slabs:[{upto, per_point}]}.
create or replace function public.slip_moisture_pct(p_moisture numeric, p_params jsonb)
returns numeric language plpgsql immutable as $$
declare
  v_pass numeric := coalesce((p_params ->> 'moisture_pass_pct')::numeric, 16);
  v_prog boolean := coalesce((p_params ->> 'moisture_progressive')::numeric, 1) = 1;
  v_lower numeric;
  v_upper numeric;
  v_pct numeric := 0;
  s jsonb;
begin
  if p_moisture is null or p_moisture <= v_pass then return 0; end if;
  v_lower := v_pass;
  for s in
    select x from jsonb_array_elements(coalesce(p_params -> 'moisture_slabs', '[]')) x
    order by (x ->> 'upto')::numeric nulls last
  loop
    v_upper := (s ->> 'upto')::numeric;
    if v_upper is not null and v_upper <= v_pass then continue; end if;
    if v_prog then
      v_pct := v_pct + greatest(0, least(p_moisture, coalesce(v_upper, p_moisture)) - v_lower) * (s ->> 'per_point')::numeric;
    elsif v_upper is null or p_moisture <= v_upper then
      return round((p_moisture - v_pass) * (s ->> 'per_point')::numeric, 3);
    end if;
    exit when v_upper is null or p_moisture <= v_upper;
    v_lower := v_upper;
  end loop;
  return round(v_pct, 3);
end;
$$;

-- Current parameters as a snapshot.
create or replace function public.slip_params_now()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'moisture_pass_pct', public.calc_setting('slip_moisture_pass_pct', 16),
    'moisture_progressive', public.calc_setting('slip_moisture_progressive', 1),
    'moisture_slabs', coalesce((select jsonb_agg(jsonb_build_object('upto', upto_pct, 'per_point', per_point) order by upto_pct nulls last)
                                from public.moisture_slabs), '[]'),
    'types', coalesce((select jsonb_object_agg(code, jsonb_build_object('value', value, 'alt_value', alt_value))
                       from public.purchase_deduction_types), '{}'));
$$;

-- Rate of a line from the slip's own snapshot and header (moisture %, bag status, early payment).
create or replace function public.slip_line_rate(s public.purchase_slips, p_code text, p_basis text, p_current numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  t jsonb := s.params -> 'types' -> p_code;
begin
  if p_basis = 'moisture' then
    return public.slip_moisture_pct(s.moisture_pct, s.params);
  elsif p_basis = 'dhalta' then
    if s.bag_status is null then return null; end if;
    return case when s.bag_status = 'returned' then (t ->> 'alt_value')::numeric else (t ->> 'value')::numeric end;
  elsif p_code = 'cash_discount' and t is not null then
    return case when s.early_payment and t ->> 'alt_value' is not null then (t ->> 'alt_value')::numeric else (t ->> 'value')::numeric end;
  end if;
  return p_current;
end;
$$;

-- Recompute amounts and totals of a slip (internal).
create or replace function public.slip_recalc(p_slip uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
  v_amount numeric;
  v_q numeric;
  v_prev text := coalesce(current_setting('app.via_rpc', true), 'off');
begin
  select * into s from public.purchase_slips where id = p_slip for update;
  v_q := s.net_kg / 100;
  v_amount := round(v_q * coalesce(s.rate_per_qtl, 0));
  perform set_config('app.via_rpc', 'on', true);
  update public.purchase_slip_lines l
  set amount = case
      when l.manual_amount or l.basis = 'manual' then l.amount
      when l.rate is null then 0
      when l.basis in ('percent', 'moisture', 'dhalta') then round(v_amount * l.rate / 100)
      when l.basis in ('per_qtl', 'brokerage') then round(v_q * l.rate)
      when l.basis = 'flat' then round(l.rate)
      else 0 end
  where l.slip_id = p_slip;
  update public.purchase_slips
  set amount = v_amount,
      total_deductions = coalesce((select sum(amount) from public.purchase_slip_lines where slip_id = p_slip), 0),
      net_payable = v_amount - coalesce((select sum(amount) from public.purchase_slip_lines where slip_id = p_slip), 0)
  where id = p_slip;
  perform set_config('app.via_rpc', v_prev, true);
end;
$$;

-- Build the slip for a posted unloading QC (runs automatically on posting).
create or replace function public.create_purchase_slip(p_qc uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  q public.qc_inbound;
  t public.weighbridge_tickets;
  s public.purchase_slips;
  v_id uuid;
  v_params jsonb := public.slip_params_now();
  v_broker_rate numeric;
  d record;
  v_rate numeric;
  v_prev text := coalesce(current_setting('app.via_rpc', true), 'off');
begin
  select id into v_id from public.purchase_slips where qc_id = p_qc and status <> 'cancelled';
  if v_id is not null then return v_id; end if;
  select * into q from public.qc_inbound where id = p_qc;
  if not found or q.status <> 'posted' then raise exception 'Only posted unloading QC gets a purchase slip.'; end if;
  select * into t from public.weighbridge_tickets where id = q.ticket_id;

  perform set_config('app.via_rpc', 'on', true);
  insert into public.purchase_slips (plant_id, qc_id, ticket_id, slip_date, rst, vehicle_no, vehicle_type, party_id, broker_id, location_id,
                                     variety, bags_total, bags_rejected, bag_status, moisture_pct, ticket_net_kg, net_kg, rate_per_qtl,
                                     claim_details, params)
  select q.plant_id, q.id, t.id, (coalesce(q.posted_at, now()) at time zone 'Asia/Kolkata')::date, t.rst, t.vehicle_no, t.vehicle_type,
         coalesce(q.supplier_id, (select po.supplier_id from public.qc_inbound_lines l join public.po_lines pl on pl.id = l.po_line_id
                                  join public.purchase_orders po on po.id = pl.po_id where l.qc_id = q.id order by l.line_no limit 1)),
         coalesce(q.broker_id, (select po.broker_id from public.qc_inbound_lines l join public.po_lines pl on pl.id = l.po_line_id
                                join public.purchase_orders po on po.id = pl.po_id where l.qc_id = q.id order by l.line_no limit 1)),
         q.location_id,
         (select string_agg(distinct v.name, ', ') from public.qc_inbound_lines l join public.varieties v on v.id = l.variety_id where l.qc_id = q.id),
         coalesce((select sum(sacks_received) from public.qc_inbound_lines where qc_id = q.id), 0),
         coalesce((select sum(rejected_bags + returned_sacks) from public.qc_inbound_lines where qc_id = q.id), 0),
         q.bag_status,
         -- Weighted by sacks when a truck carries more than one variety.
         (select round(sum(moisture_pct * sacks_received) / nullif(sum(sacks_received), 0), 2) from public.qc_inbound_lines where qc_id = q.id),
         t.net_kg,
         coalesce((select sum(coalesce(line_net_kg, 0) - coalesce(rejected_kg, 0)) from public.qc_inbound_lines where qc_id = q.id), t.net_kg),
         (select round(sum((l.line_net_kg - coalesce(l.rejected_kg, 0)) * pl.rate_per_qtl) / nullif(sum(l.line_net_kg - coalesce(l.rejected_kg, 0)), 0), 2)
          from public.qc_inbound_lines l join public.po_lines pl on pl.id = l.po_line_id
          where l.qc_id = q.id and pl.rate_per_qtl is not null),
         nullif(btrim(q.claim_details), ''),
         v_params
  returning * into s;

  select nullif(commission_per_qtl, 0) into v_broker_rate from public.brokers where id = s.broker_id;

  for d in select * from public.purchase_deduction_types where active order by sort_order, code loop
    -- Brokerage only applies when the truck came through a broker.
    continue when d.basis = 'brokerage' and s.broker_id is null;
    v_rate := case
      when d.basis = 'brokerage' then coalesce(v_broker_rate, d.value)
      when d.basis = 'manual' then null
      else public.slip_line_rate(s, d.code, d.basis, d.value) end;
    insert into public.purchase_slip_lines (slip_id, code, label, basis, rate, amount, manual_amount, pending, note, sort_order)
    values (s.id, d.code, d.label, d.basis, case when d.entered_later then null else v_rate end,
            case when d.code = 'claim' then coalesce(q.claim_amount, 0) else 0 end,
            d.basis = 'manual', d.entered_later or (d.basis = 'dhalta' and s.bag_status is null),
            case when d.code = 'claim' then nullif(btrim(q.claim_details), '') end, d.sort_order);
  end loop;

  perform public.slip_recalc(s.id);
  perform set_config('app.via_rpc', v_prev, true);
  return s.id;
end;
$$;
revoke execute on function public.create_purchase_slip(uuid) from public, anon, authenticated;
revoke execute on function public.slip_recalc(uuid) from public, anon, authenticated;

-- Posting a QC builds its slip; reversing the QC cancels it.
create or replace function public.qc_inbound_slip_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'posted' and old.status is distinct from 'posted' then
    -- A problem building the slip must never stop the QC from posting; the accountant can rebuild it.
    begin
      perform public.create_purchase_slip(new.id);
    exception when others then
      raise warning 'Purchase slip not built for QC %: %', new.pid, sqlerrm;
    end;
  elsif new.status = 'reversed' and old.status = 'posted' then
    perform set_config('app.via_rpc', 'on', true);
    update public.purchase_slips
    set status = 'cancelled', cancel_reason = 'QC reversed: ' || coalesce(new.reversal_reason, '')
    where qc_id = new.id and status <> 'cancelled';
  end if;
  return new;
end;
$$;
drop trigger if exists qc_inbound_slip on public.qc_inbound;
create trigger qc_inbound_slip after update of status on public.qc_inbound
  for each row execute function public.qc_inbound_slip_trigger();

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------
create or replace function public.require_slip_editor()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: only the administrator or accountant can change purchase slips' using errcode = '42501';
  end if;
end;
$$;

-- Edit a slip. p_header keys (all optional): rate_per_qtl, net_kg, moisture_pct, bag_status, early_payment,
-- party_id, broker_id, location_id, claim_details.
-- p_lines: [{id?, label?, basis?, rate?, amount?, note?, remove?}] — an entry without id adds a deduction.
-- After the slip is final a reason is required and the revision number goes up.
create or replace function public.update_purchase_slip(p_slip uuid, p_header jsonb, p_lines jsonb, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
  e jsonb;
  l public.purchase_slip_lines;
  v_basis text;
begin
  perform public.require_slip_editor();
  select * into s from public.purchase_slips where id = p_slip for update;
  if not found then raise exception 'Slip not found'; end if;
  if s.status = 'cancelled' then raise exception '% is cancelled and cannot be edited.', s.slip_no; end if;
  if s.status = 'paid' then
    raise exception '% is paid. Cancel its payment first, then edit the slip and pay again.', s.slip_no;
  end if;
  if s.status <> 'draft' and nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for changing % (it is already %).', s.slip_no, s.status;
  end if;
  p_header := coalesce(p_header, '{}');
  if p_header ? 'bag_status' and p_header ->> 'bag_status' not in ('received', 'returned') then
    raise exception 'Bag status must be received or returned.';
  end if;
  if p_header ? 'net_kg' and coalesce((p_header ->> 'net_kg')::numeric, -1) < 0 then raise exception 'Net weight cannot be negative.'; end if;
  if p_header ? 'rate_per_qtl' and coalesce((p_header ->> 'rate_per_qtl')::numeric, -1) < 0 then raise exception 'Enter the rate per quintal.'; end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', coalesce(nullif(btrim(p_reason), ''), 'Slip edited'), true);
  update public.purchase_slips set
    rate_per_qtl = case when p_header ? 'rate_per_qtl' then (p_header ->> 'rate_per_qtl')::numeric else rate_per_qtl end,
    net_kg = case when p_header ? 'net_kg' then (p_header ->> 'net_kg')::numeric else net_kg end,
    moisture_pct = case when p_header ? 'moisture_pct' then nullif(p_header ->> 'moisture_pct', '')::numeric else moisture_pct end,
    bag_status = case when p_header ? 'bag_status' then p_header ->> 'bag_status' else bag_status end,
    early_payment = case when p_header ? 'early_payment' then (p_header ->> 'early_payment')::boolean else early_payment end,
    party_id = case when p_header ? 'party_id' then nullif(p_header ->> 'party_id', '')::uuid else party_id end,
    broker_id = case when p_header ? 'broker_id' then nullif(p_header ->> 'broker_id', '')::uuid else broker_id end,
    location_id = case when p_header ? 'location_id' then nullif(p_header ->> 'location_id', '')::uuid else location_id end,
    claim_details = case when p_header ? 'claim_details' then nullif(btrim(p_header ->> 'claim_details'), '') else claim_details end,
    revision = case when status = 'draft' then revision else revision + 1 end
  where id = p_slip
  returning * into s;

  -- Moisture, dhalta and cash discount follow the header unless the line itself is being changed.
  update public.purchase_slip_lines x
  set rate = public.slip_line_rate(s, x.code, x.basis, x.rate),
      pending = case when x.basis = 'dhalta' then s.bag_status is null else x.pending end
  where x.slip_id = p_slip and not x.manual_amount
    and (x.basis in ('moisture', 'dhalta') or x.code = 'cash_discount')
    and not exists (select 1 from jsonb_array_elements(coalesce(p_lines, '[]')) j
                    where j ->> 'id' = x.id::text and j ? 'rate');

  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if e ->> 'id' is null then
      v_basis := coalesce(e ->> 'basis', 'manual');
      if v_basis not in ('percent', 'per_qtl', 'flat', 'manual') then raise exception 'Unknown deduction basis %', v_basis; end if;
      if nullif(btrim(e ->> 'label'), '') is null then raise exception 'Name the new deduction.'; end if;
      insert into public.purchase_slip_lines (slip_id, label, basis, rate, amount, manual_amount, note, sort_order, entered_by, entered_at)
      values (p_slip, btrim(e ->> 'label'), v_basis, nullif(e ->> 'rate', '')::numeric,
              coalesce(nullif(e ->> 'amount', '')::numeric, 0), v_basis = 'manual', nullif(btrim(e ->> 'note'), ''),
              coalesce((select max(sort_order) from public.purchase_slip_lines where slip_id = p_slip), 0) + 10, auth.uid(), now());
      continue;
    end if;
    select * into l from public.purchase_slip_lines where id = (e ->> 'id')::uuid and slip_id = p_slip;
    if not found then raise exception 'Deduction line not found on this slip.'; end if;
    if coalesce((e ->> 'remove')::boolean, false) then
      delete from public.purchase_slip_lines where id = l.id;
      continue;
    end if;
    update public.purchase_slip_lines set
      rate = case when e ? 'rate' then nullif(e ->> 'rate', '')::numeric else rate end,
      amount = case when e ? 'amount' and nullif(e ->> 'amount', '') is not null then (e ->> 'amount')::numeric else amount end,
      manual_amount = case when basis = 'manual' then true
                           when e ? 'amount' then nullif(e ->> 'amount', '') is not null else manual_amount end,
      pending = case when (e ? 'rate' and nullif(e ->> 'rate', '') is not null) or (e ? 'amount' and nullif(e ->> 'amount', '') is not null)
                     then false else pending end,
      note = case when e ? 'note' then nullif(btrim(e ->> 'note'), '') else note end,
      entered_by = auth.uid(), entered_at = now()
    where id = l.id;
  end loop;

  perform public.slip_recalc(p_slip);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Fill in a deduction that comes later (e.g. Khad, next day). Allowed for the roles named on the
-- deduction type, and for the admin / accountant.
create or replace function public.enter_slip_deduction(p_line uuid, p_rate numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  l public.purchase_slip_lines;
  s public.purchase_slips;
  d public.purchase_deduction_types;
begin
  select * into l from public.purchase_slip_lines where id = p_line;
  if not found then raise exception 'Deduction line not found'; end if;
  select * into s from public.purchase_slips where id = l.slip_id for update;
  select * into d from public.purchase_deduction_types where code = l.code;
  if not (public.can_edit_accounts() or coalesce(d.entered_later and public.current_app_role() = any (d.entry_roles), false)) then
    raise exception 'PERMISSION_DENIED: your role cannot enter %', l.label using errcode = '42501';
  end if;
  if s.status = 'cancelled' then raise exception '% is cancelled.', s.slip_no; end if;
  if s.status = 'paid' then raise exception '% is paid. Cancel its payment first.', s.slip_no; end if;
  if s.status <> 'draft' and not public.can_edit_accounts() then
    raise exception '% is already %. Ask the accountant to change it.', s.slip_no, s.status;
  end if;
  if p_rate is null or p_rate < 0 then raise exception 'Enter the % value (0 if none).', l.label; end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', l.label || ' entered', true);
  update public.purchase_slip_lines
  set rate = p_rate, pending = false, note = coalesce(nullif(btrim(p_note), ''), note), entered_by = auth.uid(), entered_at = now()
  where id = p_line;
  if s.status <> 'draft' then
    update public.purchase_slips set revision = revision + 1 where id = s.id;
  end if;
  perform public.slip_recalc(s.id);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.finalize_purchase_slip(p_slip uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
  v_pending text;
begin
  perform public.require_slip_editor();
  select * into s from public.purchase_slips where id = p_slip for update;
  if not found then raise exception 'Slip not found'; end if;
  if s.status <> 'draft' then raise exception '% is already %.', s.slip_no, s.status; end if;
  if s.rate_per_qtl is null then raise exception 'Enter the rate per quintal before finalising %.', s.slip_no; end if;
  if s.party_id is null then raise exception 'Choose the party before finalising %.', s.slip_no; end if;
  select string_agg(label, ', ' order by sort_order) into v_pending from public.purchase_slip_lines where slip_id = p_slip and pending;
  if v_pending is not null then raise exception 'Still waiting for: %. Enter them (0 if none) before finalising.', v_pending; end if;
  if s.net_payable <= 0 then raise exception 'Net payable must be more than zero.'; end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.purchase_slips set status = 'final', finalized_by = auth.uid(), finalized_at = now() where id = p_slip;
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Record the payment for a final slip (net payable to the party) and mark it paid.
create or replace function public.pay_purchase_slip(p_slip uuid, p_bank uuid, p_mode text, p_reference text,
                                                    p_paid_on date, p_request uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
  v_pay uuid;
begin
  perform public.require_slip_editor();
  select * into s from public.purchase_slips where id = p_slip for update;
  if not found then raise exception 'Slip not found'; end if;
  if s.status = 'paid' then return s.payment_id; end if;
  if s.status <> 'final' then raise exception 'Finalise % before recording its payment.', s.slip_no; end if;
  v_pay := public.record_payment('payment', s.party_id, null, p_bank, s.net_payable, p_paid_on, p_mode, p_reference,
                                 'Purchase slip ' || s.slip_no || ' · RST ' || s.rst || ' · ' || s.vehicle_no, p_request);
  perform set_config('app.via_rpc', 'on', true);
  update public.purchase_slips set status = 'paid', payment_id = v_pay where id = p_slip;
  perform set_config('app.via_rpc', 'off', true);
  return v_pay;
end;
$$;

create or replace function public.cancel_purchase_slip(p_slip uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
begin
  perform public.require_slip_editor();
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to cancel a slip.'; end if;
  select * into s from public.purchase_slips where id = p_slip for update;
  if not found then raise exception 'Slip not found'; end if;
  if s.status = 'cancelled' then raise exception '% is already cancelled.', s.slip_no; end if;
  if s.status = 'paid' then raise exception '% is paid. Cancel its payment (%) first.', s.slip_no,
    (select voucher_no from public.payments where id = s.payment_id); end if;
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', btrim(p_reason), true);
  update public.purchase_slips set status = 'cancelled', cancel_reason = btrim(p_reason) where id = p_slip;
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Build a fresh slip again from the QC (after a cancelled one), using today's parameters.
create or replace function public.rebuild_purchase_slip(p_qc uuid)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform public.require_slip_editor();
  return public.create_purchase_slip(p_qc);
end;
$$;

-- A cancelled payment re-opens its slip (back to final) so it can be paid again.
create or replace function public.payment_cancel_reopens_slip()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    perform set_config('app.via_rpc', 'on', true);
    update public.purchase_slips set status = 'final', payment_id = null where payment_id = new.id and status = 'paid';
    perform set_config('app.via_rpc', 'off', true);
  end if;
  return new;
end;
$$;
drop trigger if exists payments_reopen_slip on public.payments;
create trigger payments_reopen_slip after update of status on public.payments
  for each row execute function public.payment_cancel_reopens_slip();

create or replace function public.log_slip_send(p_slip uuid, p_channel text, p_phone text, p_status text, p_detail text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not (public.can_edit_accounts() or public.has_role('management')) then
    raise exception 'PERMISSION_DENIED: your role cannot send slips' using errcode = '42501';
  end if;
  if not exists (select 1 from public.purchase_slips where id = p_slip) then raise exception 'Slip not found'; end if;
  insert into public.purchase_slip_sends (slip_id, channel, to_phone, status, detail)
  values (p_slip, p_channel, nullif(btrim(p_phone), ''), p_status, left(p_detail, 500))
  returning id into v_id;
  return v_id;
end;
$$;

-- Broker phone (for WhatsApp) and commission, kept next to the slip settings.
create or replace function public.set_broker_contact(p_broker uuid, p_phone text, p_commission numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin', 'accountant', 'management') then
    raise exception 'PERMISSION_DENIED: your role cannot change brokers' using errcode = '42501';
  end if;
  if p_phone is not null and btrim(p_phone) <> '' and regexp_replace(p_phone, '[^0-9]', '', 'g') !~ '^(91)?[6-9][0-9]{9}$' then
    raise exception 'Enter a 10-digit Indian mobile number for WhatsApp (e.g. 98765 43210).';
  end if;
  if p_commission is not null and p_commission < 0 then raise exception 'Commission cannot be negative.'; end if;
  update public.brokers set phone = nullif(btrim(p_phone), ''), commission_per_qtl = coalesce(p_commission, commission_per_qtl)
  where id = p_broker;
  if not found then raise exception 'Broker not found'; end if;
end;
$$;

-- Trucks the purchaser can pick on the phone: search by RST, vehicle or sauda (purchase order) number.
create or replace function public.purchase_qc_search(p_query text)
returns table (ticket_id uuid, rst integer, vehicle_no text, vehicle_type text, gross_kg numeric, tare_kg numeric, net_kg numeric,
               weighed_at timestamptz, ticket_status text, qc_id uuid, qc_status text, po_no text, party text)
language sql stable security definer set search_path = public as $$
  with q as (select upper(regexp_replace(coalesce(p_query, ''), '\s', '', 'g')) as k)
  select t.id, t.rst, t.vehicle_no, t.vehicle_type, t.gross_kg, t.tare_kg, t.net_kg, t.weighed_at, t.status::text,
         qi.id, qi.status::text,
         (select po.po_no from public.qc_inbound_lines l join public.po_lines pl on pl.id = l.po_line_id
          join public.purchase_orders po on po.id = pl.po_id where l.qc_id = qi.id order by l.line_no limit 1),
         (select p.name from public.parties p where p.id = qi.supplier_id)
  from public.weighbridge_tickets t
  cross join q
  left join public.qc_inbound qi on qi.ticket_id = t.id and qi.status in ('draft', 'submitted', 'posted')
  where public.has_role('admin', 'qc_unloading', 'qc_head')
    and t.direction = 'inbound'
    and t.status in ('awaiting_qc', 'qc_in_progress', 'submitted', 'posted')
    and t.weighed_at > now() - interval '45 days'
    and (q.k = ''
         or t.rst::text = q.k
         or t.vehicle_key like '%' || q.k || '%'
         or (t.status in ('awaiting_qc', 'qc_in_progress')
             and exists (select 1 from public.purchase_orders po where po.status = 'open' and (upper(po.po_no) = q.k or upper(po.po_no) = 'PO-' || q.k))))
  order by (t.status in ('awaiting_qc', 'qc_in_progress')) desc, t.weighed_at desc
  limit 30;
$$;

revoke execute on function public.update_purchase_slip(uuid, jsonb, jsonb, text) from anon;
revoke execute on function public.enter_slip_deduction(uuid, numeric, text) from anon;
revoke execute on function public.finalize_purchase_slip(uuid) from anon;
revoke execute on function public.pay_purchase_slip(uuid, uuid, text, text, date, uuid) from anon;
revoke execute on function public.cancel_purchase_slip(uuid, text) from anon;
revoke execute on function public.rebuild_purchase_slip(uuid) from anon;
revoke execute on function public.log_slip_send(uuid, text, text, text, text) from anon;
revoke execute on function public.set_broker_contact(uuid, text, numeric) from anon;
revoke execute on function public.purchase_qc_search(text) from anon;

-- The link sent to the broker: shows one slip (read-only) to anyone holding its 64-character token.
create or replace function public.purchase_slip_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'slip', to_jsonb(s) - 'params' - 'share_token' - 'payment_id' - 'qc_id' - 'ticket_id'
            || jsonb_build_object('share_token', '', 'parties', jsonb_build_object('name', p.name),
                                  'brokers', jsonb_build_object('name', b.name, 'phone', null),
                                  'locations', jsonb_build_object('name', l.name)),
    'lines', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order) from public.purchase_slip_lines x where x.slip_id = s.id), '[]'))
  from public.purchase_slips s
  left join public.parties p on p.id = s.party_id
  left join public.brokers b on b.id = s.broker_id
  left join public.locations l on l.id = s.location_id
  where length(p_token) = 64 and s.share_token = p_token;
$$;
grant execute on function public.purchase_slip_by_token(text) to anon, authenticated;
