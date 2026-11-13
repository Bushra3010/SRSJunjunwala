-- Paddy-to-rice production batch traceability.
--
-- Design: every production stage is a row in ONE table (production_batches) with a
-- permanent readable ID (RCV-/PC-/SOAK-/STM-/DRY-/MFD-/MIL-/OUT-YYYY-00001).
-- Parent -> child material flow is stored as edges with quantities (batch_inputs),
-- so backward and forward traceability is a single recursive walk at any depth.
-- Stage-specific "tables" from the requirement (soaking_batches, tank_allocations, ...)
-- are views over this core.
--
-- Flow: receipt -> precleaning -> soaking (6 tanks) -> steaming (1 common tank, fixed
-- pairs 1+2 / 3+4 / 5+6) -> drying (dryer n = pair n) -> mill_feed -> milling -> output.
--
-- Writes go only through the SECURITY DEFINER functions below (role-checked, row-locked,
-- idempotent via request_id). Rows are never deleted; cancelled batches stay searchable.
-- Quantities are stored in kg (1 quintal = 100 kg), like the rest of the ERP.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.production_stage as enum
  ('receipt', 'precleaning', 'soaking', 'steaming', 'drying', 'mill_feed', 'milling', 'output');
create type public.batch_status as enum ('running', 'completed', 'consumed', 'cancelled');
-- How trustworthy a quantity is (requirement 7).
create type public.qty_status as enum ('estimated', 'entered', 'approved', 'confirmed');
create type public.equipment_kind as enum
  ('precleaner', 'soaking_tank', 'steamer', 'dryer', 'mill_feed_tank', 'mill_line');

-- ---------------------------------------------------------------------------
-- Masters: equipment and rice grades
-- ---------------------------------------------------------------------------
create table public.production_equipment (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants (id),
  kind public.equipment_kind not null,
  code text not null,
  name text not null,
  number integer,
  -- Soaking tanks 1..6 belong to pairs 1..3; dryer n serves pair n.
  pair_no integer check (pair_no between 1 and 3),
  capacity_min_kg numeric(14, 2),
  capacity_max_kg numeric(14, 2),
  expected_hours_min numeric(6, 2),
  expected_hours_max numeric(6, 2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (plant_id, code)
);

create table public.rice_grades (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  -- Reference recovery from the process diagram. Never used as an actual quantity.
  reference_pct numeric(5, 2),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.rice_grades (code, name, reference_pct, sort_order) values
  ('WAND1', '1st Wand', 30, 1),
  ('WAND2', '2nd Wand', 10, 2),
  ('TIBAAR', 'Tibaar', 8, 3),
  ('DUBAAR', 'Dubaar', 2, 4),
  ('BROKEN', 'Broken', 10, 5),
  ('REJECTION', 'Rejection', 4, 6),
  ('RESORT', 'Resort', 1, 7)
on conflict (code) do nothing;

-- Factory layout from the process diagram. Re-run safely; the seed file does the same
-- for brand-new databases where the plant row does not exist yet.
create or replace function public.seed_production_equipment(p_plant uuid)
returns void
language sql security definer set search_path = public
as $$
  insert into public.production_equipment
    (plant_id, kind, code, name, number, pair_no, capacity_min_kg, capacity_max_kg, expected_hours_min, expected_hours_max)
  values
    (p_plant, 'precleaner', 'PRECLEAN-1', 'Pre-cleaner', 1, null, null, null, null, null),
    (p_plant, 'soaking_tank', 'TANK-1', 'Soaking Tank 1', 1, 1, 15000, 18000, 12, 12),
    (p_plant, 'soaking_tank', 'TANK-2', 'Soaking Tank 2', 2, 1, 15000, 18000, 12, 12),
    (p_plant, 'soaking_tank', 'TANK-3', 'Soaking Tank 3', 3, 2, 15000, 18000, 12, 12),
    (p_plant, 'soaking_tank', 'TANK-4', 'Soaking Tank 4', 4, 2, 15000, 18000, 12, 12),
    (p_plant, 'soaking_tank', 'TANK-5', 'Soaking Tank 5', 5, 3, 15000, 18000, 12, 12),
    (p_plant, 'soaking_tank', 'TANK-6', 'Soaking Tank 6', 6, 3, 15000, 18000, 12, 12),
    (p_plant, 'steamer', 'STEAMER', 'Common Steaming Tank', 1, null, null, null, null, null),
    (p_plant, 'dryer', 'DRYER-1', 'Dryer 1 (Tanks 1 & 2)', 1, 1, 27000, 34000, 12, 14),
    (p_plant, 'dryer', 'DRYER-2', 'Dryer 2 (Tanks 3 & 4)', 2, 2, 27000, 34000, 12, 14),
    (p_plant, 'dryer', 'DRYER-3', 'Dryer 3 (Tanks 5 & 6)', 3, 3, 27000, 34000, 12, 14),
    (p_plant, 'mill_feed_tank', 'MFT-1', 'Mill Feed Tank 1', 1, null, null, null, null, null),
    (p_plant, 'mill_feed_tank', 'MFT-2', 'Mill Feed Tank 2', 2, null, null, null, null, null),
    (p_plant, 'mill_line', 'MILL-1', 'Milling Line 1', 1, null, null, null, 4, 6)
  on conflict (plant_id, code) do nothing;
$$;

select public.seed_production_equipment(id) from public.plants;

-- ---------------------------------------------------------------------------
-- Readable IDs: one counter row per prefix and year, incremented under a row lock.
-- A rolled-back transaction rolls the counter back too, so committed IDs are gap-free,
-- unique, never reused (cancelled batches keep theirs) and never changed.
-- ---------------------------------------------------------------------------
create table public.batch_counters (
  prefix text not null,
  year integer not null,
  last_no integer not null,
  primary key (prefix, year)
);

create or replace function public.stage_prefix(p_stage public.production_stage)
returns text
language sql immutable
as $$
  select case p_stage
    when 'receipt' then 'RCV' when 'precleaning' then 'PC' when 'soaking' then 'SOAK'
    when 'steaming' then 'STM' when 'drying' then 'DRY' when 'mill_feed' then 'MFD'
    when 'milling' then 'MIL' when 'output' then 'OUT' end;
$$;

create or replace function public.next_batch_no(p_stage public.production_stage)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_prefix text := public.stage_prefix(p_stage);
  v_year integer := extract(year from (now() at time zone 'Asia/Kolkata'))::integer;
  v_no integer;
begin
  insert into public.batch_counters (prefix, year, last_no) values (v_prefix, v_year, 1)
  on conflict (prefix, year) do update set last_no = public.batch_counters.last_no + 1
  returning last_no into v_no;
  return v_prefix || '-' || v_year || '-' || lpad(v_no::text, 5, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Core tables
-- ---------------------------------------------------------------------------
create table public.production_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique,
  stage public.production_stage not null,
  plant_id uuid not null references public.plants (id),
  status public.batch_status not null default 'running',
  equipment_id uuid references public.production_equipment (id),
  pair_no integer check (pair_no between 1 and 3),
  -- Set when every input shares one variety; null means mixed.
  variety_id uuid references public.varieties (id),
  grade_id uuid references public.rice_grades (id),
  input_kg numeric(14, 2) check (input_kg >= 0),
  output_kg numeric(14, 2) check (output_kg >= 0),
  rejected_kg numeric(14, 2) not null default 0 check (rejected_kg >= 0),
  loss_kg numeric(14, 2) generated always as (
    case when input_kg is not null and output_kg is not null then input_kg - output_kg - rejected_kg end
  ) stored,
  output_qty_status public.qty_status,
  moisture_pct numeric(5, 2) check (moisture_pct between 0 and 60),
  quality_status text check (quality_status in ('pending', 'passed', 'hold', 'rejected')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_minutes numeric(10, 1) generated always as (
    round((extract(epoch from (ended_at - started_at)) / 60)::numeric, 1)
  ) stored,
  operator_id uuid default auth.uid(),
  completed_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  confirmed_by uuid,
  confirmed_at timestamptz,
  -- Receipt only: the posted unloading-QC line this truck receipt came from.
  source_qc_line_id uuid unique references public.qc_inbound_lines (id),
  -- Receipt only: frozen copy of truck, RST, weights, party and QC data (RST numbers reset).
  source_snapshot jsonb,
  -- Stock location: where a receipt was issued from / where an output was received into.
  stock_location_id uuid references public.locations (id),
  authorization_reason text,
  authorized_by uuid,
  cancel_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  request_id uuid unique,
  remarks text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or started_at is null or ended_at >= started_at),
  check ((stage = 'output') = (grade_id is not null))
);

create index production_batches_stage_idx on public.production_batches (stage, status, created_at desc);
create index production_batches_equipment_idx on public.production_batches (equipment_id, status);
create index production_batches_started_idx on public.production_batches (started_at desc);
-- The common steaming tank runs one batch at a time.
create unique index production_one_running_steam on public.production_batches (plant_id)
  where stage = 'steaming' and status = 'running';

-- Genealogy edges: material moved from parent into child.
create table public.batch_inputs (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.production_batches (id),
  parent_id uuid not null references public.production_batches (id),
  qty_kg numeric(14, 2) not null check (qty_kg > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (child_id, parent_id),
  check (child_id <> parent_id)
);
create index batch_inputs_parent_idx on public.batch_inputs (parent_id);

-- Timeline: every start/stop/transfer/correction with user, time, quantity and stage.
create table public.batch_events (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.production_batches (id),
  stage public.production_stage not null,
  event_type text not null,
  at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  qty_kg numeric(14, 2),
  related_batch_id uuid references public.production_batches (id),
  note text,
  data jsonb
);
create index batch_events_batch_idx on public.batch_events (batch_id, at);
create index batch_events_at_idx on public.batch_events (at desc);

-- Append-only quantity journal used for reconciliation.
create table public.batch_quantity_ledger (
  id bigint generated always as identity primary key,
  batch_id uuid not null references public.production_batches (id),
  entry text not null check (entry in
    ('input', 'output', 'rejected', 'consumed', 'released', 'correction', 'stock_issue', 'stock_receipt', 'stock_reversal')),
  qty_kg numeric(14, 2) not null,
  qty_status public.qty_status,
  related_batch_id uuid references public.production_batches (id),
  at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  note text
);
create index batch_quantity_ledger_batch_idx on public.batch_quantity_ledger (batch_id);

create table public.milling_stage_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.production_batches (id),
  step text not null check (step in ('cleaning', 'dehusking', 'whitener', 'silky', 'sortex', 'grading')),
  step_no integer not null check (step_no between 1 and 6),
  started_at timestamptz,
  ended_at timestamptz,
  started_by uuid,
  ended_by uuid,
  note text,
  unique (batch_id, step),
  check (ended_at is null or (started_at is not null and ended_at >= started_at))
);

create table public.production_faults (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants (id),
  equipment_id uuid references public.production_equipment (id),
  batch_id uuid references public.production_batches (id),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  description text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  downtime_minutes numeric(10, 1) generated always as (
    round((extract(epoch from (ended_at - started_at)) / 60)::numeric, 1)
  ) stored,
  resolution text,
  reported_by uuid default auth.uid(),
  resolved_by uuid,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index production_faults_open_idx on public.production_faults (plant_id) where ended_at is null;

create trigger production_batches_touch before update on public.production_batches
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Integrity guards: no deletes ever; edits only through the functions below.
-- ---------------------------------------------------------------------------
create or replace function public.production_write_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Production records cannot be deleted. Cancel the batch instead (it stays searchable).'
      using errcode = '42501';
  end if;
  if current_setting('app.via_rpc', true) = 'on' then
    return new;
  end if;
  raise exception 'Production records change only through production actions.' using errcode = '42501';
end;
$$;

create trigger production_batches_guard before insert or update or delete on public.production_batches
  for each row execute function public.production_write_guard();
create trigger batch_inputs_guard before insert or update or delete on public.batch_inputs
  for each row execute function public.production_write_guard();
create trigger milling_stage_events_guard before insert or update or delete on public.milling_stage_events
  for each row execute function public.production_write_guard();
create trigger production_faults_guard before insert or update or delete on public.production_faults
  for each row execute function public.production_write_guard();

create or replace function public.production_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only.', tg_table_name using errcode = '42501';
end;
$$;
create trigger batch_events_append_only before update or delete on public.batch_events
  for each row execute function public.production_append_only();
create trigger batch_quantity_ledger_append_only before update or delete on public.batch_quantity_ledger
  for each row execute function public.production_append_only();

create trigger audit_production_batches after insert or update on public.production_batches
  for each row execute function public.audit_trigger();
create trigger audit_batch_inputs after insert on public.batch_inputs
  for each row execute function public.audit_trigger();
create trigger audit_milling_stage_events after insert or update on public.milling_stage_events
  for each row execute function public.audit_trigger();
create trigger audit_production_faults after insert or update on public.production_faults
  for each row execute function public.audit_trigger();
create trigger audit_production_equipment after insert or update or delete on public.production_equipment
  for each row execute function public.audit_trigger();
create trigger audit_rice_grades after insert or update or delete on public.rice_grades
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Balances
-- ---------------------------------------------------------------------------
-- Quantity already allocated from a batch to live (non-cancelled) children.
create or replace function public.batch_consumed_kg(p_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(i.qty_kg), 0)
  from public.batch_inputs i
  join public.production_batches c on c.id = i.child_id
  where i.parent_id = p_id and c.status <> 'cancelled';
$$;

create or replace function public.batch_available_kg(p_id uuid)
returns numeric
language sql stable security definer set search_path = public
as $$
  select case when b.status in ('completed', 'consumed') then coalesce(b.output_kg, 0) - public.batch_consumed_kg(b.id) else 0 end
  from public.production_batches b where b.id = p_id;
$$;

create view public.production_batch_balances with (security_invoker = true) as
select b.id, b.batch_no, b.stage, b.status, b.output_kg,
       public.batch_consumed_kg(b.id) as consumed_kg,
       case when b.status in ('completed', 'consumed') then coalesce(b.output_kg, 0) - public.batch_consumed_kg(b.id) else 0 end as available_kg
from public.production_batches b;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------
create or replace function public.prod_event(
  p_batch uuid, p_type text, p_qty numeric default null, p_related uuid default null,
  p_note text default null, p_at timestamptz default null, p_data jsonb default null)
returns void
language sql security definer set search_path = public
as $$
  insert into public.batch_events (batch_id, stage, event_type, at, qty_kg, related_batch_id, note, data)
  select p_batch, b.stage, p_type, coalesce(p_at, now()), p_qty, p_related, p_note, p_data
  from public.production_batches b where b.id = p_batch;
$$;

create or replace function public.prod_ledger(
  p_batch uuid, p_entry text, p_qty numeric, p_status public.qty_status default null,
  p_related uuid default null, p_note text default null)
returns void
language sql security definer set search_path = public
as $$
  insert into public.batch_quantity_ledger (batch_id, entry, qty_kg, qty_status, related_batch_id, note)
  values (p_batch, p_entry, p_qty, p_status, p_related, p_note);
$$;

-- Who may operate each stage (requirement 10). Management is read-only everywhere.
create or replace function public.require_stage_role(p_stage public.production_stage)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  case p_stage
    when 'receipt' then perform public.require_role('admin', 'production_manager', 'qc_head');
    when 'precleaning' then perform public.require_role('admin', 'production_manager', 'soaking_operator', 'foreman');
    when 'soaking' then perform public.require_role('admin', 'production_manager', 'soaking_operator', 'foreman');
    when 'steaming' then perform public.require_role('admin', 'production_manager', 'steaming_operator', 'foreman');
    when 'drying' then perform public.require_role('admin', 'production_manager', 'drying_operator', 'foreman');
    when 'mill_feed' then perform public.require_role('admin', 'production_manager', 'drying_operator', 'milling_operator', 'foreman');
    when 'milling', 'output' then perform public.require_role('admin', 'production_manager', 'milling_operator');
  end case;
end;
$$;

-- Marks a parent consumed when nothing is left, or completed again when material is released.
create or replace function public.refresh_batch_status(p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_left numeric;
begin
  select * into b from public.production_batches where id = p_id;
  if b.status not in ('completed', 'consumed') or b.stage = 'output' then return; end if;
  v_left := coalesce(b.output_kg, 0) - public.batch_consumed_kg(p_id);
  if v_left <= 0 and b.status = 'completed' then
    update public.production_batches set status = 'consumed' where id = p_id;
    perform public.prod_event(p_id, 'fully_consumed', b.output_kg);
  elsif v_left > 0 and b.status = 'consumed' then
    update public.production_batches set status = 'completed' where id = p_id;
    perform public.prod_event(p_id, 'material_released', v_left);
  end if;
end;
$$;

-- Equipment that physically holds material until the next stage takes it.
create or replace function public.equipment_busy_batch(p_equipment uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select b.batch_no from public.production_batches b
  where b.equipment_id = p_equipment
    and (b.status = 'running' or (b.status = 'completed' and public.batch_available_kg(b.id) > 0))
  order by b.created_at desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Stage 1: truck receipt (from a posted unloading-QC line)
-- ---------------------------------------------------------------------------
create or replace function public.create_receipt_batch(p_qc_line uuid, p_request uuid default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  l public.qc_inbound_lines;
  q public.qc_inbound;
  t public.weighbridge_tickets;
  v_id uuid;
  v_stock numeric;
  v_snapshot jsonb;
begin
  perform public.require_stage_role('receipt');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;

  select * into l from public.qc_inbound_lines where id = p_qc_line for update;
  if not found then raise exception 'QC line not found'; end if;
  select * into q from public.qc_inbound where id = l.qc_id;
  if q.status <> 'posted' then
    raise exception 'Only posted unloading QC can start production (this one is %).', q.status;
  end if;
  select id into v_id from public.production_batches where source_qc_line_id = p_qc_line;
  if found then
    raise exception 'DUPLICATE_CONSUMPTION: this receipt already has production batch %',
      (select batch_no from public.production_batches where id = v_id);
  end if;
  if coalesce(l.accepted_kg, 0) <= 0 then raise exception 'Nothing accepted on this QC line.'; end if;

  select coalesce(sum(qty_kg) filter (where not is_estimate), 0) into v_stock
  from public.stock_movements where lot_no = l.lot_no and location_id = q.location_id;
  if v_stock < l.accepted_kg then
    raise exception 'INSUFFICIENT_STOCK: lot % has % kg in stock, receipt needs % kg.', l.lot_no, v_stock, l.accepted_kg;
  end if;

  select * into t from public.weighbridge_tickets where id = q.ticket_id;
  v_snapshot := jsonb_build_object(
    'ticket_pid', t.pid, 'rst', t.rst,
    'rst_cycle', (select label from public.rst_cycles where id = t.cycle_id),
    'vehicle_no', t.vehicle_no, 'gross_kg', t.gross_kg, 'tare_kg', t.tare_kg, 'net_kg', t.net_kg,
    'weighed_at', t.weighed_at,
    'qc_pid', q.pid, 'qc_posted_at', q.posted_at,
    'qc_user', (select full_name from public.profiles where id = q.qc_user),
    'supplier', (select name from public.parties where id = q.supplier_id),
    'broker', (select name from public.brokers where id = q.broker_id),
    'variety', (select name from public.varieties where id = l.variety_id),
    'variety_code', (select code from public.varieties where id = l.variety_id),
    'lot_no', l.lot_no, 'moisture_pct', l.moisture_pct, 'sacks_received', l.sacks_received,
    'rejected_bags', l.rejected_bags, 'line_net_kg', l.line_net_kg, 'rejected_kg', l.rejected_kg,
    'moisture_deduction_kg', l.moisture_deduction_kg, 'accepted_kg', l.accepted_kg);

  perform set_config('app.via_rpc', 'on', true);
  insert into public.production_batches
    (batch_no, stage, plant_id, status, variety_id, input_kg, output_kg, output_qty_status, moisture_pct,
     started_at, ended_at, source_qc_line_id, source_snapshot, stock_location_id, request_id, remarks)
  values
    (public.next_batch_no('receipt'), 'receipt', q.plant_id, 'completed', l.variety_id, l.accepted_kg, l.accepted_kg,
     'approved', l.moisture_pct, t.weighed_at, coalesce(q.posted_at, now()), l.id, v_snapshot, q.location_id, p_request, p_remarks)
  returning id into v_id;

  -- Paddy leaves the yard/godown stock and enters production.
  insert into public.stock_movements
    (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
  values
    (q.plant_id, 'production_issue', l.variety_id, q.location_id, l.lot_no, -l.accepted_kg, 'production_batch', v_id,
     (select batch_no from public.production_batches where id = v_id), 'Issued to production');

  perform public.prod_event(v_id, 'received', l.accepted_kg, null,
    'RST ' || t.rst || ' · ' || t.vehicle_no, t.weighed_at);
  perform public.prod_event(v_id, 'created', l.accepted_kg);
  perform public.prod_ledger(v_id, 'input', l.accepted_kg, 'approved');
  perform public.prod_ledger(v_id, 'output', l.accepted_kg, 'approved');
  perform public.prod_ledger(v_id, 'stock_issue', -l.accepted_kg, 'approved', null, 'Lot ' || l.lot_no);
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

-- Posted unloading-QC lines whose paddy has not entered production yet.
create or replace function public.production_receivable_lines()
returns table (qc_line_id uuid, qc_pid text, posted_at timestamptz, rst integer, rst_cycle text, vehicle_no text,
               net_kg numeric, supplier text, variety text, lot_no text, moisture_pct numeric, accepted_kg numeric, location text)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_role('admin', 'production_manager', 'qc_head', 'management');
  return query
  select l.id, q.pid, q.posted_at, t.rst, c.label, t.vehicle_no, t.net_kg, pa.name, v.name, l.lot_no, l.moisture_pct, l.accepted_kg, lo.name
  from public.qc_inbound_lines l
  join public.qc_inbound q on q.id = l.qc_id and q.status = 'posted'
  join public.weighbridge_tickets t on t.id = q.ticket_id
  left join public.rst_cycles c on c.id = t.cycle_id
  left join public.parties pa on pa.id = q.supplier_id
  left join public.varieties v on v.id = l.variety_id
  left join public.locations lo on lo.id = q.location_id
  where coalesce(l.accepted_kg, 0) > 0
    and not exists (select 1 from public.production_batches b where b.source_qc_line_id = l.id)
  order by q.posted_at;
end;
$$;

-- An unloading QC whose paddy is in production cannot be reversed underneath it.
create or replace function public.qc_inbound_production_guard()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_no text;
begin
  if new.status = 'reversed' and old.status = 'posted' then
    select b.batch_no into v_no from public.production_batches b
    join public.qc_inbound_lines l on l.id = b.source_qc_line_id
    where l.qc_id = new.id and b.status <> 'cancelled' limit 1;
    if v_no is not null then
      raise exception 'This QC is in production as %. Cancel the production batches first.', v_no using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger qc_inbound_production_guard before update on public.qc_inbound
  for each row execute function public.qc_inbound_production_guard();

-- ---------------------------------------------------------------------------
-- Stages 2-7: start a batch from parent batches (validated per stage)
-- p_inputs: [{"batch_id": "...", "qty_kg": 8000}, ...]
-- ---------------------------------------------------------------------------
create or replace function public.start_production_batch(
  p_stage public.production_stage,
  p_equipment uuid,
  p_inputs jsonb,
  p_started_at timestamptz default null,
  p_request uuid default null,
  p_remarks text default null,
  p_authorization text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_parent_stage public.production_stage;
  e public.production_equipment;
  p public.production_batches;
  inp jsonb;
  v_id uuid;
  v_qty numeric;
  v_avail numeric;
  v_total numeric := 0;
  v_parents uuid[] := '{}';
  v_qtys numeric[] := '{}';
  v_pair integer;
  v_variety uuid;
  v_mixed boolean := false;
  v_plant uuid;
  v_authorized boolean := false;
  v_busy text;
  v_tanks integer[];
  i integer;
begin
  perform public.require_stage_role(p_stage);
  if p_stage in ('receipt', 'output') then
    raise exception 'Use the receipt / output actions for this stage.';
  end if;
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  if p_inputs is null or jsonb_typeof(p_inputs) <> 'array' or jsonb_array_length(p_inputs) = 0 then
    raise exception 'Select at least one input batch.';
  end if;
  if p_started_at is not null and p_started_at > now() + interval '5 minutes' then
    raise exception 'Start time cannot be in the future.';
  end if;

  v_parent_stage := case p_stage
    when 'precleaning' then 'receipt' when 'soaking' then 'precleaning' when 'steaming' then 'soaking'
    when 'drying' then 'steaming' when 'mill_feed' then 'drying' when 'milling' then 'mill_feed' end;

  -- Equipment must match the stage.
  if p_equipment is not null then
    select * into e from public.production_equipment where id = p_equipment and active;
    if not found then raise exception 'Equipment not found or inactive.'; end if;
  end if;
  if (p_stage = 'soaking' and coalesce(e.kind::text, '') <> 'soaking_tank')
     or (p_stage = 'steaming' and coalesce(e.kind::text, '') <> 'steamer')
     or (p_stage = 'drying' and coalesce(e.kind::text, '') <> 'dryer')
     or (p_stage = 'mill_feed' and coalesce(e.kind::text, '') <> 'mill_feed_tank')
     or (p_stage = 'milling' and coalesce(e.kind::text, '') <> 'mill_line')
     or (p_stage = 'precleaning' and e.id is not null and e.kind <> 'precleaner') then
    raise exception 'WRONG_EQUIPMENT: % needs a %.', p_stage,
      case p_stage when 'soaking' then 'soaking tank' when 'steaming' then 'steaming tank' when 'drying' then 'dryer'
        when 'mill_feed' then 'mill feed tank' when 'milling' then 'milling line' else 'pre-cleaner' end;
  end if;

  -- Tanks, the steamer and dryers hold material until the next stage takes it.
  if e.kind in ('soaking_tank', 'steamer', 'dryer', 'precleaner') then
    -- Lock the equipment row so two operators cannot load it at the same moment.
    perform 1 from public.production_equipment where id = e.id for update;
    if e.kind = 'precleaner' then
      select batch_no into v_busy from public.production_batches where equipment_id = e.id and status = 'running' limit 1;
    else
      v_busy := public.equipment_busy_batch(e.id);
    end if;
    if v_busy is not null then
      raise exception 'EQUIPMENT_BUSY: % still holds batch %.', e.name, v_busy;
    end if;
  end if;
  if p_stage = 'steaming' and exists (
      select 1 from public.production_batches where stage = 'steaming' and status = 'running' and plant_id = e.plant_id) then
    raise exception 'STEAMER_BUSY: only one steaming batch can run at a time.';
  end if;

  -- Lock and check every parent (consistent order prevents deadlocks).
  for inp in select value from jsonb_array_elements(p_inputs) order by value ->> 'batch_id' loop
    select * into p from public.production_batches where id = (inp ->> 'batch_id')::uuid for update;
    if not found then raise exception 'Input batch not found.'; end if;
    if p.id = any (v_parents) then raise exception 'Batch % is listed twice.', p.batch_no; end if;
    if p.stage <> v_parent_stage then
      raise exception 'WRONG_SOURCE: % takes % batches, not % (%).', p_stage, v_parent_stage, p.stage, p.batch_no;
    end if;
    if p.status = 'running' then
      raise exception 'INCOMPLETE_BATCH: % is still running. Complete it first.', p.batch_no;
    end if;
    if p.status = 'cancelled' then raise exception '% is cancelled.', p.batch_no; end if;
    if p.status = 'consumed' then
      raise exception 'DUPLICATE_CONSUMPTION: % has already been fully used.', p.batch_no;
    end if;
    v_avail := public.batch_available_kg(p.id);
    -- Steaming and drying take the whole batch; other stages may take part of it.
    if p_stage in ('steaming', 'drying') then
      v_qty := v_avail;
    else
      v_qty := nullif(inp ->> 'qty_kg', '')::numeric;
      if v_qty is null or v_qty <= 0 then raise exception 'Enter a quantity for %.', p.batch_no; end if;
    end if;
    if v_qty > v_avail then
      if nullif(btrim(p_authorization), '') is null or not public.has_role('admin', 'production_manager') then
        raise exception 'OVER_ALLOCATION: % has % kg available, % kg requested. A production manager must authorise with a reason.',
          p.batch_no, v_avail, v_qty;
      end if;
      v_authorized := true;
    end if;
    v_plant := p.plant_id;
    if cardinality(v_parents) = 0 then v_variety := p.variety_id;
    elsif p.variety_id is distinct from v_variety then v_mixed := true;
    end if;
    if p.variety_id is null then v_mixed := true; end if;
    v_parents := v_parents || p.id;
    v_qtys := v_qtys || v_qty;
    v_total := v_total + v_qty;
  end loop;
  if v_mixed then v_variety := null; end if;

  -- Fixed pairing rules.
  if p_stage = 'steaming' then
    select array_agg(eq.number order by eq.number), min(eq.pair_no) into v_tanks, v_pair
    from public.production_batches b join public.production_equipment eq on eq.id = b.equipment_id
    where b.id = any (v_parents);
    if array_length(v_parents, 1) <> 2 or v_tanks is null or array_length(v_tanks, 1) <> 2
       or v_tanks[1] <> 2 * v_pair - 1 or v_tanks[2] <> 2 * v_pair then
      raise exception 'WRONG_PAIR: steaming takes exactly one fixed pair — Tank 1+2, Tank 3+4 or Tank 5+6.';
    end if;
  elsif p_stage = 'drying' then
    if array_length(v_parents, 1) <> 1 then raise exception 'A dryer takes exactly one steaming batch.'; end if;
    select pair_no into v_pair from public.production_batches where id = v_parents[1];
    if e.pair_no is distinct from v_pair then
      raise exception 'WRONG_DRYER: steaming pair % (Tanks % & %) must go to Dryer %, not %.',
        v_pair, 2 * v_pair - 1, 2 * v_pair, v_pair, e.name;
    end if;
  elsif p_stage = 'soaking' then
    v_pair := e.pair_no;
  elsif p_stage = 'milling' and array_length(v_parents, 1) > 1 then
    if nullif(btrim(p_authorization), '') is null or not public.has_role('admin', 'production_manager') then
      raise exception 'MULTI_INPUT: milling more than one mill-feed lot together needs a production manager''s authorisation and reason.';
    end if;
    v_authorized := true;
  end if;

  perform set_config('app.via_rpc', 'on', true);
  insert into public.production_batches
    (batch_no, stage, plant_id, status, equipment_id, pair_no, variety_id, input_kg, started_at,
     authorization_reason, authorized_by, request_id, remarks)
  values
    (public.next_batch_no(p_stage), p_stage, v_plant, 'running', e.id, v_pair, v_variety, v_total, coalesce(p_started_at, now()),
     case when v_authorized then btrim(p_authorization) end, case when v_authorized then auth.uid() end, p_request, p_remarks)
  returning id into v_id;

  for i in 1 .. array_length(v_parents, 1) loop
    insert into public.batch_inputs (child_id, parent_id, qty_kg) values (v_id, v_parents[i], v_qtys[i]);
    perform public.prod_ledger(v_parents[i], 'consumed', -v_qtys[i], null, v_id);
    perform public.prod_ledger(v_id, 'input', v_qtys[i], 'entered', v_parents[i]);
    perform public.prod_event(v_parents[i], 'transferred_out', v_qtys[i], v_id, null, coalesce(p_started_at, now()));
    perform public.refresh_batch_status(v_parents[i]);
  end loop;
  perform public.prod_event(v_id, 'started', v_total, null,
    case when v_authorized then 'Authorised: ' || btrim(p_authorization) end, coalesce(p_started_at, now()),
    jsonb_build_object('equipment', e.name));

  -- A mill feed transfer is instantaneous: it is complete as soon as it is recorded.
  if p_stage = 'mill_feed' then
    update public.production_batches
    set status = 'completed', ended_at = started_at, output_kg = v_total, output_qty_status = 'entered', completed_by = auth.uid()
    where id = v_id;
    perform public.prod_ledger(v_id, 'output', v_total, 'entered');
    perform public.prod_event(v_id, 'completed', v_total, null, null, coalesce(p_started_at, now()));
  end if;
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Complete a running batch. Output must be entered for pre-cleaning, drying and milling;
-- for soaking and steaming it may be left blank and is then carried as an ESTIMATE.
-- ---------------------------------------------------------------------------
create or replace function public.complete_production_batch(
  p_id uuid,
  p_output_kg numeric default null,
  p_rejected_kg numeric default 0,
  p_moisture_pct numeric default null,
  p_ended_at timestamptz default null,
  p_remarks text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_out numeric;
  v_status public.qty_status;
  v_end timestamptz := coalesce(p_ended_at, now());
begin
  select * into b from public.production_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  perform public.require_stage_role(b.stage);
  if b.status <> 'running' then
    raise exception '% is % — only running batches can be completed.', b.batch_no, b.status;
  end if;
  if v_end < b.started_at then raise exception 'End time is before the start time.'; end if;
  if v_end > now() + interval '5 minutes' then raise exception 'End time cannot be in the future.'; end if;
  if coalesce(p_rejected_kg, 0) < 0 then raise exception 'Rejected quantity cannot be negative.'; end if;

  if p_output_kg is null then
    if b.stage in ('precleaning', 'drying', 'milling') then
      raise exception 'Enter the output quantity for %.', b.batch_no;
    end if;
    v_out := b.input_kg - coalesce(p_rejected_kg, 0);
    v_status := 'estimated';
  else
    if p_output_kg <= 0 then raise exception 'Output must be greater than zero.'; end if;
    -- Soaking and steaming add water, so their weight may rise. Other stages cannot gain weight.
    if b.stage not in ('soaking', 'steaming') and p_output_kg + coalesce(p_rejected_kg, 0) > b.input_kg then
      raise exception 'Output plus rejection (% kg) cannot exceed the input (% kg).', p_output_kg + coalesce(p_rejected_kg, 0), b.input_kg;
    end if;
    v_out := p_output_kg;
    v_status := 'entered';
  end if;

  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches
  set status = 'completed', ended_at = v_end, output_kg = v_out, rejected_kg = coalesce(p_rejected_kg, 0),
      output_qty_status = v_status, moisture_pct = coalesce(p_moisture_pct, moisture_pct), completed_by = auth.uid(),
      remarks = coalesce(nullif(btrim(p_remarks), ''), remarks)
  where id = p_id;
  perform public.prod_ledger(p_id, 'output', v_out, v_status);
  if coalesce(p_rejected_kg, 0) > 0 then perform public.prod_ledger(p_id, 'rejected', p_rejected_kg, v_status); end if;
  perform public.prod_event(p_id, 'completed', v_out, null,
    case when v_status = 'estimated' then 'Output not weighed — carried forward as an estimate' end, v_end,
    jsonb_build_object('rejected_kg', coalesce(p_rejected_kg, 0), 'moisture_pct', p_moisture_pct, 'qty_status', v_status));
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Milling steps: cleaning -> dehusking -> whitener -> silky -> sortex -> grading
-- ---------------------------------------------------------------------------
create or replace function public.record_milling_step(p_batch uuid, p_step text, p_action text, p_at timestamptz default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_no integer;
  v_at timestamptz := coalesce(p_at, now());
  s public.milling_stage_events;
begin
  select * into b from public.production_batches where id = p_batch for update;
  if not found or b.stage <> 'milling' then raise exception 'Milling batch not found'; end if;
  perform public.require_stage_role('milling');
  if b.status <> 'running' then raise exception '% is %; steps can only be recorded while milling runs.', b.batch_no, b.status; end if;
  v_no := array_position(array['cleaning', 'dehusking', 'whitener', 'silky', 'sortex', 'grading'], p_step);
  if v_no is null then raise exception 'Unknown milling step %', p_step; end if;
  if v_at < b.started_at then raise exception 'Step time is before the milling batch started.'; end if;

  perform set_config('app.via_rpc', 'on', true);
  if p_action = 'start' then
    if v_no > 1 and not exists (select 1 from public.milling_stage_events where batch_id = p_batch and step_no = v_no - 1 and started_at is not null) then
      raise exception 'Start the previous step first.';
    end if;
    if exists (select 1 from public.milling_stage_events where batch_id = p_batch and step = p_step) then
      raise exception '% already started.', initcap(p_step);
    end if;
    insert into public.milling_stage_events (batch_id, step, step_no, started_at, started_by, note)
    values (p_batch, p_step, v_no, v_at, auth.uid(), p_note);
  elsif p_action = 'end' then
    select * into s from public.milling_stage_events where batch_id = p_batch and step = p_step for update;
    if not found then raise exception 'Start % first.', p_step; end if;
    if s.ended_at is not null then raise exception '% already ended.', initcap(p_step); end if;
    if v_at < s.started_at then raise exception 'End time is before the step started.'; end if;
    update public.milling_stage_events set ended_at = v_at, ended_by = auth.uid(), note = coalesce(p_note, note) where id = s.id;
  else
    raise exception 'Action must be start or end.';
  end if;
  perform public.prod_event(p_batch, p_step || '_' || case when p_action = 'start' then 'started' else 'completed' end, null, null, p_note, v_at);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stage 8: final output by grade (several per milling batch)
-- ---------------------------------------------------------------------------
create or replace function public.record_production_output(
  p_milling uuid, p_grade uuid, p_qty_kg numeric, p_produced_at timestamptz default null,
  p_request uuid default null, p_remarks text default null, p_authorization text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  m public.production_batches;
  v_id uuid;
  v_avail numeric;
  v_auth boolean := false;
  v_at timestamptz;
begin
  perform public.require_stage_role('output');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  select * into m from public.production_batches where id = p_milling for update;
  if not found or m.stage <> 'milling' then raise exception 'Milling batch not found'; end if;
  if m.status = 'running' then raise exception 'INCOMPLETE_BATCH: complete milling batch % before recording outputs.', m.batch_no; end if;
  if m.status = 'cancelled' then raise exception '% is cancelled.', m.batch_no; end if;
  if not exists (select 1 from public.rice_grades where id = p_grade and active) then raise exception 'Choose a rice grade.'; end if;
  if coalesce(p_qty_kg, 0) <= 0 then raise exception 'Enter the output quantity.'; end if;
  v_avail := coalesce(m.output_kg, 0) - public.batch_consumed_kg(m.id);
  if p_qty_kg > v_avail then
    if nullif(btrim(p_authorization), '') is null or not public.has_role('admin', 'production_manager') then
      raise exception 'OVER_ALLOCATION: milling batch % has % kg not yet assigned to a grade; % kg entered.', m.batch_no, v_avail, p_qty_kg;
    end if;
    v_auth := true;
  end if;
  v_at := coalesce(p_produced_at, m.ended_at, now());

  perform set_config('app.via_rpc', 'on', true);
  insert into public.production_batches
    (batch_no, stage, plant_id, status, variety_id, grade_id, output_kg, output_qty_status, quality_status,
     started_at, ended_at, authorization_reason, authorized_by, request_id, remarks, completed_by)
  values
    (public.next_batch_no('output'), 'output', m.plant_id, 'completed', m.variety_id, p_grade, p_qty_kg, 'entered', 'pending',
     v_at, v_at, case when v_auth then btrim(p_authorization) end, case when v_auth then auth.uid() end, p_request, p_remarks, auth.uid())
  returning id into v_id;
  insert into public.batch_inputs (child_id, parent_id, qty_kg) values (v_id, m.id, p_qty_kg);
  perform public.prod_ledger(m.id, 'consumed', -p_qty_kg, null, v_id);
  perform public.prod_ledger(v_id, 'output', p_qty_kg, 'entered', m.id);
  perform public.prod_event(m.id, 'output_recorded', p_qty_kg, v_id, (select name from public.rice_grades where id = p_grade), v_at);
  perform public.prod_event(v_id, 'output_recorded', p_qty_kg, m.id, (select name from public.rice_grades where id = p_grade), v_at);
  perform public.refresh_batch_status(m.id);
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Approvals, physical confirmation, quality, corrections, cancellation
-- ---------------------------------------------------------------------------
create or replace function public.approve_batch_quantity(p_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare b public.production_batches;
begin
  perform public.require_role('admin', 'production_manager');
  select * into b from public.production_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status not in ('completed', 'consumed') then raise exception 'Only completed batches can be approved.'; end if;
  if b.output_qty_status in ('approved', 'confirmed') then raise exception '% is already %.', b.batch_no, b.output_qty_status; end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches set output_qty_status = 'approved', approved_by = auth.uid(), approved_at = now() where id = p_id;
  perform public.prod_ledger(p_id, 'output', 0, 'approved', null, 'Quantity approved');
  perform public.prod_event(p_id, 'quantity_approved', b.output_kg, null, p_note);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Physically weighed/counted final output goes into finished-goods stock.
create or replace function public.confirm_production_output(p_id uuid, p_location uuid, p_qty_kg numeric default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_qty numeric;
  v_var uuid;
begin
  perform public.require_role('admin', 'production_manager');
  select * into b from public.production_batches where id = p_id for update;
  if not found or b.stage <> 'output' then raise exception 'Output not found'; end if;
  if b.status = 'cancelled' then raise exception '% is cancelled.', b.batch_no; end if;
  if b.output_qty_status = 'confirmed' then raise exception '% is already confirmed.', b.batch_no; end if;
  if not exists (select 1 from public.locations where id = p_location and active) then raise exception 'Choose a store location.'; end if;
  v_qty := coalesce(p_qty_kg, b.output_kg);
  if v_qty <= 0 then raise exception 'Confirmed quantity must be greater than zero.'; end if;
  v_var := b.variety_id;
  if v_var is null then
    raise exception 'MIXED_VARIETY: % came from more than one paddy variety; it cannot be stocked under one variety.', b.batch_no;
  end if;

  perform set_config('app.via_rpc', 'on', true);
  if v_qty <> b.output_kg then
    perform public.prod_event(p_id, 'corrected', v_qty, null, 'Physical count differs from entered quantity',
      null, jsonb_build_object('field', 'output_kg', 'old', b.output_kg, 'new', v_qty));
    perform public.prod_ledger(p_id, 'correction', v_qty - b.output_kg, 'confirmed', null, 'Physical count');
  end if;
  update public.production_batches
  set output_kg = v_qty, output_qty_status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now(), stock_location_id = p_location,
      approved_by = coalesce(approved_by, auth.uid()), approved_at = coalesce(approved_at, now())
  where id = p_id;
  insert into public.stock_movements
    (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
  values
    (b.plant_id, 'production_receipt', v_var, p_location, b.batch_no, v_qty, 'production_batch', b.id, b.batch_no,
     (select name from public.rice_grades where id = b.grade_id));
  perform public.prod_ledger(p_id, 'stock_receipt', v_qty, 'confirmed');
  perform public.prod_event(p_id, 'quantity_confirmed', v_qty, null, p_note);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.set_batch_quality(p_id uuid, p_moisture_pct numeric default null, p_quality text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare b public.production_batches;
begin
  perform public.require_role('admin', 'production_manager', 'qc_head');
  select * into b from public.production_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status = 'cancelled' then raise exception '% is cancelled.', b.batch_no; end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches
  set moisture_pct = coalesce(p_moisture_pct, moisture_pct), quality_status = coalesce(p_quality, quality_status)
  where id = p_id;
  perform public.prod_event(p_id, 'quality_recorded', null, null, p_note, null,
    jsonb_build_object('moisture_pct', p_moisture_pct, 'quality_status', p_quality,
      'old_moisture_pct', b.moisture_pct, 'old_quality_status', b.quality_status));
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- Authorised correction: original values stay in the event, ledger and audit log.
create or replace function public.correct_batch_quantity(p_id uuid, p_field text, p_new numeric, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_old numeric;
  v_used numeric;
begin
  perform public.require_role('admin', 'production_manager');
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required for corrections.'; end if;
  select * into b from public.production_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status in ('running', 'cancelled') then raise exception 'Only completed batches can be corrected (this one is %).', b.status; end if;
  if b.output_qty_status = 'confirmed' and b.stage = 'output' then
    raise exception '% is already in stock. Post a stock adjustment instead.', b.batch_no;
  end if;
  if p_new is null or p_new < 0 then raise exception 'Enter a valid quantity.'; end if;
  v_used := public.batch_consumed_kg(p_id);

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', btrim(p_reason), true);
  if p_field = 'output_kg' then
    v_old := b.output_kg;
    if p_new < v_used then
      raise exception 'Output cannot be below the % kg already passed to the next stage.', v_used;
    end if;
    if b.stage not in ('soaking', 'steaming') and b.input_kg is not null and p_new + b.rejected_kg > b.input_kg then
      raise exception 'Output plus rejection cannot exceed the input (% kg).', b.input_kg;
    end if;
    update public.production_batches set output_kg = p_new, output_qty_status = 'entered' where id = p_id;
  elsif p_field = 'rejected_kg' then
    v_old := b.rejected_kg;
    if b.input_kg is not null and coalesce(b.output_kg, 0) + p_new > b.input_kg and b.stage not in ('soaking', 'steaming') then
      raise exception 'Output plus rejection cannot exceed the input (% kg).', b.input_kg;
    end if;
    update public.production_batches set rejected_kg = p_new where id = p_id;
  else
    raise exception 'Only output_kg or rejected_kg can be corrected. Cancel and redo the batch to change inputs.';
  end if;
  perform public.prod_ledger(p_id, 'correction', p_new - v_old, 'entered', null, p_field || ': ' || btrim(p_reason));
  perform public.prod_event(p_id, 'corrected', p_new, null, btrim(p_reason), null,
    jsonb_build_object('field', p_field, 'old', v_old, 'new', p_new));
  perform public.refresh_batch_status(p_id);
  perform set_config('app.reason', '', true);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

create or replace function public.cancel_production_batch(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  r record;
  v_child text;
begin
  perform public.require_role('admin', 'production_manager');
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to cancel a batch.'; end if;
  select * into b from public.production_batches where id = p_id for update;
  if not found then raise exception 'Batch not found'; end if;
  if b.status = 'cancelled' then raise exception '% is already cancelled.', b.batch_no; end if;
  select c.batch_no into v_child from public.batch_inputs i join public.production_batches c on c.id = i.child_id
  where i.parent_id = p_id and c.status <> 'cancelled' limit 1;
  if v_child is not null then
    raise exception 'Cancel the next-stage batch % first — material from % has moved on.', v_child, b.batch_no;
  end if;
  if b.stage = 'output' and b.output_qty_status = 'confirmed' then
    raise exception '% is already in stock. Post a stock adjustment instead.', b.batch_no;
  end if;

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.reason', btrim(p_reason), true);
  update public.production_batches
  set status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_id;
  perform public.prod_event(p_id, 'cancelled', null, null, btrim(p_reason));

  -- Give the material back to the parent batches.
  for r in select parent_id, qty_kg from public.batch_inputs where child_id = p_id loop
    perform public.prod_ledger(r.parent_id, 'released', r.qty_kg, null, p_id, 'Child cancelled');
    perform public.prod_event(r.parent_id, 'material_returned', r.qty_kg, p_id, btrim(p_reason));
    perform public.refresh_batch_status(r.parent_id);
  end loop;

  -- A cancelled truck receipt goes back into yard stock.
  if b.stage = 'receipt' then
    insert into public.stock_movements
      (plant_id, movement_type, variety_id, location_id, lot_no, qty_kg, reference_type, reference_id, reference_no, note)
    values
      (b.plant_id, 'reversal', b.variety_id, b.stock_location_id, b.source_snapshot ->> 'lot_no', b.output_kg,
       'production_batch', b.id, b.batch_no, 'Receipt batch cancelled: ' || btrim(p_reason));
    perform public.prod_ledger(p_id, 'stock_reversal', b.output_kg, null, null, btrim(p_reason));
  end if;
  perform set_config('app.reason', '', true);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Downtime and faults
-- ---------------------------------------------------------------------------
create or replace function public.report_production_fault(
  p_equipment uuid, p_batch uuid, p_severity text, p_description text, p_started_at timestamptz default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_plant uuid;
begin
  perform public.require_role('admin', 'production_manager', 'soaking_operator', 'steaming_operator',
    'drying_operator', 'milling_operator', 'foreman');
  if nullif(btrim(p_description), '') is null then raise exception 'Describe the fault.'; end if;
  select plant_id into v_plant from public.production_equipment where id = p_equipment;
  if v_plant is null then
    select plant_id into v_plant from public.production_batches where id = p_batch;
  end if;
  if v_plant is null then raise exception 'Choose the equipment or batch.'; end if;
  perform set_config('app.via_rpc', 'on', true);
  insert into public.production_faults (plant_id, equipment_id, batch_id, severity, description, started_at)
  values (v_plant, p_equipment, p_batch, p_severity, btrim(p_description), coalesce(p_started_at, now()))
  returning id into v_id;
  if p_batch is not null then
    perform public.prod_event(p_batch, 'fault_reported', null, null, p_severity || ': ' || btrim(p_description), coalesce(p_started_at, now()));
  end if;
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

create or replace function public.resolve_production_fault(p_id uuid, p_resolution text, p_ended_at timestamptz default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare f public.production_faults;
begin
  perform public.require_role('admin', 'production_manager', 'soaking_operator', 'steaming_operator',
    'drying_operator', 'milling_operator', 'foreman');
  select * into f from public.production_faults where id = p_id for update;
  if not found then raise exception 'Fault not found'; end if;
  if f.ended_at is not null then raise exception 'Fault already resolved.'; end if;
  if coalesce(p_ended_at, now()) < f.started_at then raise exception 'End time is before the fault started.'; end if;
  perform set_config('app.via_rpc', 'on', true);
  update public.production_faults
  set ended_at = coalesce(p_ended_at, now()), resolution = nullif(btrim(p_resolution), ''), resolved_by = auth.uid()
  where id = p_id;
  if f.batch_id is not null then
    perform public.prod_event(f.batch_id, 'fault_resolved', null, null, p_resolution, coalesce(p_ended_at, now()));
  end if;
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Traceability engine (security invoker: RLS decides what the caller may see)
-- ---------------------------------------------------------------------------
-- Every batch upstream of p_id: one row per genealogy edge (parent, the child it fed, qty).
-- UNION de-duplicates edges reached through several paths (e.g. two mill-feed transfers
-- of one dryer batch), which also makes the walk terminate. depth = shortest distance.
create or replace function public.trace_ancestors(p_id uuid)
returns table (batch_id uuid, child_id uuid, qty_kg numeric, depth integer)
language sql stable
as $$
  with recursive edges as (
    select i.parent_id as batch_id, i.child_id, i.qty_kg from public.batch_inputs i where i.child_id = p_id
    union
    select i.parent_id, i.child_id, i.qty_kg from public.batch_inputs i join edges e on i.child_id = e.batch_id
  ), dist as (
    select p_id as id, 0 as d
    union
    select e.batch_id, dist.d + 1 from edges e join dist on e.child_id = dist.id where dist.d < 20
  )
  select e.batch_id, e.child_id, e.qty_kg, (select min(d) from dist where dist.id = e.batch_id)::integer
  from edges e;
$$;

-- Every batch downstream of p_id: one row per genealogy edge (child, the parent it came from, qty).
create or replace function public.trace_descendants(p_id uuid)
returns table (batch_id uuid, parent_id uuid, qty_kg numeric, depth integer)
language sql stable
as $$
  with recursive edges as (
    select i.child_id as batch_id, i.parent_id, i.qty_kg from public.batch_inputs i where i.parent_id = p_id
    union
    select i.child_id, i.parent_id, i.qty_kg from public.batch_inputs i join edges e on i.parent_id = e.batch_id
  ), dist as (
    select p_id as id, 0 as d
    union
    select e.batch_id, dist.d + 1 from edges e join dist on e.parent_id = dist.id where dist.d < 20
  )
  select e.batch_id, e.parent_id, e.qty_kg, (select min(d) from dist where dist.id = e.batch_id)::integer
  from edges e;
$$;

-- Chronological history of the batch and its whole lineage (both directions).
create or replace function public.trace_timeline(p_id uuid)
returns table (event_id bigint, at timestamptz, batch_id uuid, batch_no text, stage public.production_stage,
               event_type text, qty_kg numeric, user_name text, note text, related_batch_no text)
language sql stable
as $$
  with family as (
    select p_id as id
    union select batch_id from public.trace_ancestors(p_id)
    union select batch_id from public.trace_descendants(p_id)
  )
  select e.id, e.at, e.batch_id, b.batch_no, e.stage, e.event_type, e.qty_kg,
         coalesce(nullif(pr.full_name, ''), pr.email), e.note, rb.batch_no
  from public.batch_events e
  join family f on f.id = e.batch_id
  join public.production_batches b on b.id = e.batch_id
  left join public.profiles pr on pr.id = e.user_id
  left join public.production_batches rb on rb.id = e.related_batch_id
  order by e.at, e.id;
$$;

-- Find a batch by readable ID, RST, vehicle number, QC/ticket PID or stock lot.
create or replace function public.find_production_batches(p_query text)
returns setof public.production_batches
language sql stable
as $$
  select b.* from public.production_batches b
  where upper(b.batch_no) = upper(btrim(p_query))
     or (b.stage = 'receipt' and (
          b.source_snapshot ->> 'rst' = btrim(p_query)
          or regexp_replace(upper(b.source_snapshot ->> 'vehicle_no'), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(p_query), '[^A-Z0-9]', '', 'g')
          or upper(b.source_snapshot ->> 'ticket_pid') = upper(btrim(p_query))
          or upper(b.source_snapshot ->> 'qc_pid') = upper(btrim(p_query))
          or upper(b.source_snapshot ->> 'lot_no') = upper(btrim(p_query))))
     or (length(btrim(p_query)) >= 4 and b.batch_no ilike '%' || btrim(p_query) || '%')
  order by b.created_at desc
  limit 50;
$$;

-- ---------------------------------------------------------------------------
-- Named views for each logical entity in the requirement
-- ---------------------------------------------------------------------------
create view public.truck_receipts with (security_invoker = true) as
  select * from public.production_batches where stage = 'receipt';
create view public.precleaning_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'precleaning';
create view public.soaking_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'soaking';
create view public.steaming_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'steaming';
create view public.drying_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'drying';
create view public.mill_feed_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'mill_feed';
create view public.milling_batches with (security_invoker = true) as
  select * from public.production_batches where stage = 'milling';
create view public.production_outputs with (security_invoker = true) as
  select * from public.production_batches where stage = 'output';

-- Pre-cleaned paddy allocated into soaking tanks (one truck may feed several tanks).
create view public.tank_allocations with (security_invoker = true) as
  select i.*, c.batch_no as soaking_batch_no, eq.number as tank_no, p.batch_no as source_batch_no
  from public.batch_inputs i
  join public.production_batches c on c.id = i.child_id and c.stage = 'soaking'
  join public.production_batches p on p.id = i.parent_id
  left join public.production_equipment eq on eq.id = c.equipment_id;
create view public.steaming_batch_inputs with (security_invoker = true) as
  select i.*, c.batch_no as steaming_batch_no, p.batch_no as soaking_batch_no, eq.number as tank_no
  from public.batch_inputs i
  join public.production_batches c on c.id = i.child_id and c.stage = 'steaming'
  join public.production_batches p on p.id = i.parent_id
  left join public.production_equipment eq on eq.id = p.equipment_id;
create view public.drying_batch_inputs with (security_invoker = true) as
  select i.*, c.batch_no as drying_batch_no, p.batch_no as steaming_batch_no, p.pair_no
  from public.batch_inputs i
  join public.production_batches c on c.id = i.child_id and c.stage = 'drying'
  join public.production_batches p on p.id = i.parent_id;
create view public.production_audit_logs with (security_invoker = true) as
  select * from public.audit_log
  where table_name in ('production_batches', 'batch_inputs', 'milling_stage_events', 'production_faults',
                       'production_equipment', 'rice_grades');

-- ---------------------------------------------------------------------------
-- Row level security: read for production and oversight roles; no direct writes.
-- ---------------------------------------------------------------------------
create or replace function public.can_view_production()
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.has_role('admin', 'management', 'production_manager', 'soaking_operator', 'steaming_operator',
    'drying_operator', 'milling_operator', 'foreman', 'qc_head');
$$;

alter table public.production_equipment enable row level security;
alter table public.rice_grades enable row level security;
alter table public.batch_counters enable row level security;
alter table public.production_batches enable row level security;
alter table public.batch_inputs enable row level security;
alter table public.batch_events enable row level security;
alter table public.batch_quantity_ledger enable row level security;
alter table public.milling_stage_events enable row level security;
alter table public.production_faults enable row level security;

create policy production_equipment_read on public.production_equipment for select to authenticated using (public.is_active_user());
create policy production_equipment_write on public.production_equipment for all to authenticated
  using (public.has_role('admin', 'production_manager')) with check (public.has_role('admin', 'production_manager'));
create policy rice_grades_read on public.rice_grades for select to authenticated using (public.is_active_user());
create policy rice_grades_write on public.rice_grades for all to authenticated
  using (public.has_role('admin', 'production_manager')) with check (public.has_role('admin', 'production_manager'));
create policy production_batches_read on public.production_batches for select to authenticated using (public.can_view_production());
create policy batch_inputs_read on public.batch_inputs for select to authenticated using (public.can_view_production());
create policy batch_events_read on public.batch_events for select to authenticated using (public.can_view_production());
create policy batch_quantity_ledger_read on public.batch_quantity_ledger for select to authenticated using (public.can_view_production());
create policy milling_stage_events_read on public.milling_stage_events for select to authenticated using (public.can_view_production());
create policy production_faults_read on public.production_faults for select to authenticated using (public.can_view_production());
-- Production managers also see the production audit trail.
create policy audit_read_production on public.audit_log for select to authenticated
  using (public.has_role('production_manager') and table_name in
    ('production_batches', 'batch_inputs', 'milling_stage_events', 'production_faults', 'production_equipment', 'rice_grades'));

-- Live updates on the production screens.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['production_batches', 'batch_events', 'production_faults', 'milling_stage_events'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function permissions
-- ---------------------------------------------------------------------------
revoke execute on function public.next_batch_no(public.production_stage) from public, anon, authenticated;
revoke execute on function public.seed_production_equipment(uuid) from public, anon, authenticated;
revoke execute on function public.prod_event(uuid, text, numeric, uuid, text, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.prod_ledger(uuid, text, numeric, public.qty_status, uuid, text) from public, anon, authenticated;
revoke execute on function public.refresh_batch_status(uuid) from public, anon, authenticated;
revoke execute on function public.production_write_guard() from public, anon, authenticated;
revoke execute on function public.production_append_only() from public, anon, authenticated;
revoke execute on function public.qc_inbound_production_guard() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
