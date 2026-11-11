-- Weighbridge tickets and RST cycles.
-- PRD refs: §7.2 WB-01..WB-12, RST-01..RST-07.
-- RST is a human-facing number that resets every ~4–5 months. It is NEVER a key:
-- every ticket has a permanent PID and belongs to an RST cycle.

create table public.rst_cycles (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants (id),
  label text not null,
  starts_on date not null,
  ends_on date,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (plant_id, label),
  check (ends_on is null or ends_on >= starts_on)
);

create unique index rst_cycles_one_open_per_plant on public.rst_cycles (plant_id) where ends_on is null;

create type public.movement_direction as enum ('inbound', 'outbound');

create type public.ticket_status as enum (
  'awaiting_qc',
  'qc_in_progress',
  'submitted',
  'posted',
  'duplicate',
  'exception',
  'cancelled'
);

create type public.capture_method as enum ('sms', 'manual', 'import');

create table public.weighbridge_tickets (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  plant_id uuid not null references public.plants (id),
  cycle_id uuid references public.rst_cycles (id),
  rst integer not null check (rst > 0),
  vehicle_no text not null,
  vehicle_key text generated always as (regexp_replace(upper(vehicle_no), '[^A-Z0-9]', '', 'g')) stored,
  direction public.movement_direction not null,
  -- Inbound trucks are weighed gross first (tare after unloading); outbound trucks tare first.
  -- Either weight may be missing until the second weighing is recorded.
  gross_kg numeric(12, 2) check (gross_kg >= 0),
  tare_kg numeric(12, 2) check (tare_kg >= 0),
  net_kg numeric(12, 2) generated always as (
    case when gross_kg is not null and tare_kg is not null then gross_kg - tare_kg end
  ) stored,
  ticket_ref text,
  weighed_at timestamptz not null default now(),
  capture_method public.capture_method not null default 'manual',
  source_payload text,
  status public.ticket_status not null default 'awaiting_qc',
  exception_reason text,
  duplicate_of uuid references public.weighbridge_tickets (id),
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index weighbridge_tickets_rst_idx on public.weighbridge_tickets (plant_id, cycle_id, rst);
create index weighbridge_tickets_vehicle_idx on public.weighbridge_tickets (vehicle_key);
create index weighbridge_tickets_weighed_idx on public.weighbridge_tickets (weighed_at desc);
create index weighbridge_tickets_status_idx on public.weighbridge_tickets (status);

create trigger weighbridge_tickets_touch before update on public.weighbridge_tickets
  for each row execute function public.touch_updated_at();

create trigger audit_weighbridge_tickets after insert or update or delete on public.weighbridge_tickets
  for each row execute function public.audit_trigger();

create trigger audit_rst_cycles after insert or update or delete on public.rst_cycles
  for each row execute function public.audit_trigger();

-- Classify every new ticket: assign cycle, detect malformed data, duplicates and
-- ambiguous RST reuse. Nothing is silently dropped or merged (WB-06, WB-07, RST-03/04).
create or replace function public.wb_ticket_before_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_local_date date;
  v_key text;
  v_dup uuid;
  v_conflict uuid;
begin
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.vehicle_no := upper(btrim(coalesce(new.vehicle_no, '')));
  v_key := regexp_replace(new.vehicle_no, '[^A-Z0-9]', '', 'g');
  new.status := 'awaiting_qc';
  new.exception_reason := null;
  new.duplicate_of := null;

  v_local_date := (new.weighed_at at time zone 'Asia/Kolkata')::date;

  if new.cycle_id is null then
    select c.id into new.cycle_id
    from public.rst_cycles c
    where c.plant_id = new.plant_id
      and c.starts_on <= v_local_date
      and (c.ends_on is null or c.ends_on >= v_local_date)
    order by c.starts_on desc
    limit 1;
  end if;

  if new.cycle_id is null then
    new.status := 'exception';
    new.exception_reason := 'No RST cycle covers the ticket date. Create or adjust an RST cycle, then resolve.';
    return new;
  end if;

  if v_key = '' or (new.gross_kg is null and new.tare_kg is null) then
    new.status := 'exception';
    new.exception_reason := 'Incomplete ticket: vehicle number and at least one weight are required.';
    return new;
  end if;

  if new.gross_kg is not null and new.tare_kg is not null and new.gross_kg <= new.tare_kg then
    new.status := 'exception';
    new.exception_reason := 'Invalid weights: gross must be greater than tare.';
    return new;
  end if;

  -- Same RST + cycle + vehicle already captured => duplicate message/ticket.
  select t.id into v_dup
  from public.weighbridge_tickets t
  where t.plant_id = new.plant_id
    and t.cycle_id = new.cycle_id
    and t.rst = new.rst
    and t.vehicle_key = v_key
    and t.status not in ('cancelled', 'duplicate')
  order by t.created_at
  limit 1;

  if v_dup is not null then
    new.status := 'duplicate';
    new.duplicate_of := v_dup;
    new.exception_reason := 'Same RST, cycle and vehicle already captured.';
    return new;
  end if;

  -- Same RST in the same cycle but a different vehicle => ambiguous, needs a person.
  select t.id into v_conflict
  from public.weighbridge_tickets t
  where t.plant_id = new.plant_id
    and t.cycle_id = new.cycle_id
    and t.rst = new.rst
    and t.status not in ('cancelled', 'duplicate')
  limit 1;

  if v_conflict is not null then
    new.status := 'exception';
    new.duplicate_of := v_conflict;
    new.exception_reason := 'RST already used in this cycle by a different vehicle. Confirm which record is correct.';
  end if;

  return new;
end;
$$;

create trigger wb_ticket_classify before insert on public.weighbridge_tickets
  for each row execute function public.wb_ticket_before_insert();

-- Direct updates are blocked; changes go through the functions below (RST-07).
create or replace function public.wb_ticket_guard()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.via_rpc', true) = 'on' then
    return coalesce(new, old);
  end if;
  raise exception 'Weighbridge tickets cannot be edited or deleted directly. Use the ticket actions.'
    using errcode = '42501';
end;
$$;

create trigger wb_ticket_guard before update or delete on public.weighbridge_tickets
  for each row execute function public.wb_ticket_guard();

-- Record the second weighing (fills only the missing weight).
create or replace function public.complete_weighing(p_ticket uuid, p_gross numeric, p_tare numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t public.weighbridge_tickets;
begin
  perform public.require_role('weighbridge_operator', 'admin', 'management');
  select * into t from public.weighbridge_tickets where id = p_ticket for update;
  if not found then
    raise exception 'Ticket not found';
  end if;
  if t.status in ('cancelled', 'duplicate') then
    raise exception 'Cannot record weights on a % ticket', t.status;
  end if;
  if t.gross_kg is not null and p_gross is not null and p_gross <> t.gross_kg then
    raise exception 'Gross weight is already recorded (% kg). Use an amendment to change it.', t.gross_kg;
  end if;
  if t.tare_kg is not null and p_tare is not null and p_tare <> t.tare_kg then
    raise exception 'Tare weight is already recorded (% kg). Use an amendment to change it.', t.tare_kg;
  end if;
  if coalesce(p_gross, t.gross_kg) is not null and coalesce(p_tare, t.tare_kg) is not null
     and coalesce(p_gross, t.gross_kg) <= coalesce(p_tare, t.tare_kg) then
    raise exception 'Gross weight must be greater than tare weight';
  end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', 'Second weighing recorded', true);
  update public.weighbridge_tickets
  set gross_kg = coalesce(t.gross_kg, p_gross),
      tare_kg = coalesce(t.tare_kg, p_tare)
  where id = p_ticket;
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Resolve an exception or duplicate: accept as valid, or cancel (WB-07).
create or replace function public.resolve_ticket(p_ticket uuid, p_action text, p_note text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  t public.weighbridge_tickets;
  v_cycle uuid;
begin
  perform public.require_role('admin', 'management', 'qc_head');
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A resolution note is required';
  end if;
  select * into t from public.weighbridge_tickets where id = p_ticket for update;
  if not found then
    raise exception 'Ticket not found';
  end if;
  if t.status not in ('exception', 'duplicate', 'awaiting_qc') then
    raise exception 'Only exception, duplicate or awaiting-QC tickets can be resolved (current: %)', t.status;
  end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', p_note, true);

  if p_action = 'cancel' then
    update public.weighbridge_tickets
    set status = 'cancelled', resolution_note = p_note, resolved_by = auth.uid(), resolved_at = now()
    where id = p_ticket;
  elsif p_action = 'accept' then
    if t.gross_kg is null and t.tare_kg is null then
      raise exception 'Ticket has no weights; it cannot be accepted';
    end if;
    v_cycle := t.cycle_id;
    if v_cycle is null then
      select c.id into v_cycle from public.rst_cycles c
      where c.plant_id = t.plant_id
        and c.starts_on <= (t.weighed_at at time zone 'Asia/Kolkata')::date
        and (c.ends_on is null or c.ends_on >= (t.weighed_at at time zone 'Asia/Kolkata')::date)
      order by c.starts_on desc limit 1;
      if v_cycle is null then
        raise exception 'Still no RST cycle covers this ticket date';
      end if;
    end if;
    update public.weighbridge_tickets
    set status = 'awaiting_qc', cycle_id = v_cycle, resolution_note = p_note,
        resolved_by = auth.uid(), resolved_at = now()
    where id = p_ticket;
  else
    raise exception 'Unknown action %', p_action;
  end if;

  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Start a new RST cycle: closes the open one the day before (RST-02).
create or replace function public.start_rst_cycle(p_plant uuid, p_label text, p_starts_on date, p_notes text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_open public.rst_cycles;
  v_id uuid;
begin
  perform public.require_role('admin', 'management');
  select * into v_open from public.rst_cycles where plant_id = p_plant and ends_on is null for update;
  if found then
    if p_starts_on <= v_open.starts_on then
      raise exception 'New cycle must start after the current cycle (started %)', v_open.starts_on;
    end if;
    update public.rst_cycles set ends_on = p_starts_on - 1 where id = v_open.id;
  end if;
  insert into public.rst_cycles (plant_id, label, starts_on, notes)
  values (p_plant, p_label, p_starts_on, p_notes)
  returning id into v_id;
  return v_id;
end;
$$;

alter table public.rst_cycles enable row level security;
alter table public.weighbridge_tickets enable row level security;

create policy rst_cycles_read on public.rst_cycles for select to authenticated using (public.is_active_user());

create policy tickets_read on public.weighbridge_tickets for select to authenticated
  using (public.has_role('admin', 'management', 'weighbridge_operator', 'qc_unloading', 'qc_loading', 'qc_head', 'commercial'));

create policy tickets_insert on public.weighbridge_tickets for insert to authenticated
  with check (public.has_role('admin', 'management', 'weighbridge_operator'));
