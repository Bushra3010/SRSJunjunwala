-- Client feedback (14 Nov 2026, fourth round): simpler floor flow and recovery standards.
--
--  * Soaking stop = the tank's paddy goes through steaming (pass-through, recorded as a LOT)
--    straight into the dryer the operator picks. The dryer FILLS from one or more tanks.
--  * Dryer start (when full) and dryer stop (with unload moisture). Dryers are not weighed, so
--    drying output may stay an estimate.
--  * Dryer stop unloads automatically into its own feed tank: Dryer 1 -> Feed tank 1, 2 -> 2, 3 -> 3.
--    No manual mill-feed step.
--  * Milling starts by choosing which dryer's paddy (feed tank) the mill received.
--  * Standard recovery per variety for every output (rice grades and by-products such as broken,
--    rejection, polish), with an allowed range; editable, and new by-products can be added.

-- ---------------------------------------------------------------------------
-- Outputs: rice grades and by-products
-- ---------------------------------------------------------------------------
alter table public.rice_grades add column if not exists kind text not null default 'rice'
  check (kind in ('rice', 'by_product'));
update public.rice_grades set kind = 'by_product' where code in ('BROKEN', 'REJECTION', 'RESORT');
insert into public.rice_grades (code, name, reference_pct, sort_order, kind) values ('POLISH', 'Polish', null, 8, 'by_product')
on conflict (code) do nothing;

-- Standard recovery per paddy variety and output, as % of paddy milled, with an allowed range.
create table if not exists public.variety_output_standards (
  variety_id uuid not null references public.varieties (id) on delete cascade,
  grade_id uuid not null references public.rice_grades (id) on delete cascade,
  std_pct numeric(5, 2) not null check (std_pct between 0 and 100),
  min_pct numeric(5, 2) check (min_pct between 0 and 100),
  max_pct numeric(5, 2) check (max_pct between 0 and 100),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (variety_id, grade_id),
  check (min_pct is null or min_pct <= std_pct),
  check (max_pct is null or max_pct >= std_pct)
);
alter table public.variety_output_standards enable row level security;
drop policy if exists variety_output_standards_read on public.variety_output_standards;
create policy variety_output_standards_read on public.variety_output_standards for select to authenticated using (public.is_active_user());
drop policy if exists variety_output_standards_write on public.variety_output_standards;
create policy variety_output_standards_write on public.variety_output_standards for all to authenticated
  using (public.has_role('admin', 'production_manager')) with check (public.has_role('admin', 'production_manager'));
drop trigger if exists variety_output_standards_touch on public.variety_output_standards;
create trigger variety_output_standards_touch before update on public.variety_output_standards
  for each row execute function public.touch_updated_at();
create or replace function public.audit_variety_output_standards()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit_log (table_name, record_id, pid, action, old_data, new_data, reason)
  values ('variety_output_standards', coalesce(new.variety_id, old.variety_id), null, lower(tg_op),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end,
          nullif(current_setting('app.reason', true), ''));
  return coalesce(new, old);
end;
$$;
drop trigger if exists audit_variety_output_standards on public.variety_output_standards;
create trigger audit_variety_output_standards after insert or update or delete on public.variety_output_standards
  for each row execute function public.audit_variety_output_standards();

-- ---------------------------------------------------------------------------
-- Updated core functions
-- ---------------------------------------------------------------------------
create or replace function public.require_stage_role(p_stage public.production_stage)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  case p_stage
    when 'receipt' then perform public.require_role('admin', 'production_manager', 'qc_head', 'soaking_operator', 'foreman');
    when 'precleaning' then perform public.require_role('admin', 'production_manager', 'soaking_operator', 'foreman');
    when 'soaking' then perform public.require_role('admin', 'production_manager', 'soaking_operator', 'foreman');
    when 'steaming' then perform public.require_role('admin', 'production_manager', 'steaming_operator', 'soaking_operator', 'foreman');
    when 'drying' then perform public.require_role('admin', 'production_manager', 'drying_operator', 'steaming_operator', 'soaking_operator', 'foreman');
    when 'mill_feed' then perform public.require_role('admin', 'production_manager', 'drying_operator', 'steaming_operator', 'soaking_operator', 'milling_operator', 'foreman');
    when 'milling', 'output' then perform public.require_role('admin', 'production_manager', 'milling_operator');
  end case;
end;
$$;

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
    -- Pre-cleaner and steamer pass material straight through: busy only while running.
    if e.kind in ('precleaner', 'steamer') then
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
    -- Soaking takes trucks directly (no pre-cleaning record) or, for older data, pre-cleaning batches.
    if p.stage <> v_parent_stage and not (p_stage = 'soaking' and p.stage = 'receipt') then
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

  -- Steaming lot: any one or more finished soaking tanks (flexible, so a faulty tank's partner
  -- can be combined with another tank). pair_no is kept only when the lot is a standard pair.
  if p_stage = 'steaming' then
    select array_agg(eq.number order by eq.number), min(eq.pair_no) into v_tanks, v_pair
    from public.production_batches b join public.production_equipment eq on eq.id = b.equipment_id
    where b.id = any (v_parents);
    if v_tanks is null or array_length(v_tanks, 1) <> 2 or v_tanks[1] <> 2 * v_pair - 1 or v_tanks[2] <> 2 * v_pair then
      v_pair := null;
    end if;
  -- Drying: any dryer may take any lot; one lot per dryer load.
  elsif p_stage = 'drying' then
    -- A dryer is filled from one or more steamed tanks before it starts.
    if array_length(v_parents, 1) = 1 then
      select pair_no into v_pair from public.production_batches where id = v_parents[1];
    else
      v_pair := null;
    end if;
  elsif p_stage = 'soaking' then
    v_pair := e.pair_no;
  -- Milling a whole feed tank (one dryer's paddy) is normal; mixing feed tanks needs authorisation.
  elsif p_stage = 'milling' and (select count(distinct equipment_id) from public.production_batches where id = any (v_parents)) > 1 then
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
    -- Dryers are not weighed: drying output may be left as an estimate. Milling output must be entered.
    if b.stage in ('precleaning', 'milling') then
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
-- Soaking stop: through steaming (recorded as a LOT) into the chosen dryer, which starts filling.
-- ---------------------------------------------------------------------------
create or replace function public.stop_soaking_to_dryer(p_soaking uuid, p_dryer uuid, p_ended_at timestamptz default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s public.production_batches;
  d public.production_equipment;
  v_lot uuid;
  v_busy text;
  v_steamer uuid;
  v_at timestamptz := coalesce(p_ended_at, now());
begin
  perform public.require_stage_role('soaking');
  select * into s from public.production_batches where id = p_soaking for update;
  if not found or s.stage <> 'soaking' then raise exception 'Soaking batch not found'; end if;
  -- Safe retry: already stopped into a dryer.
  if s.status <> 'running' then
    select c.id into v_lot from public.batch_inputs i join public.production_batches c on c.id = i.child_id
    where i.parent_id = p_soaking and c.stage = 'steaming' and c.status <> 'cancelled' limit 1;
    if v_lot is not null then return v_lot; end if;
    raise exception '% is not soaking.', s.batch_no;
  end if;
  select * into d from public.production_equipment where id = p_dryer and kind = 'dryer' and active;
  if not found then raise exception 'Choose the dryer this tank goes into.'; end if;
  -- The dryer must be empty or still filling: not drying, and not holding dried paddy.
  v_busy := public.equipment_busy_batch(d.id);
  if v_busy is not null then
    raise exception 'DRYER_BUSY: % is drying or still holds dried paddy (%). Choose another dryer.', d.name, v_busy;
  end if;
  select id into v_steamer from public.production_equipment where plant_id = d.plant_id and kind = 'steamer' and active limit 1;

  perform public.complete_production_batch(p_soaking, null, 0, null, v_at, p_remarks);
  v_lot := public.start_production_batch('steaming', v_steamer, jsonb_build_array(jsonb_build_object('batch_id', p_soaking)), v_at, null, null, null);
  perform public.complete_production_batch(v_lot, null, 0, null, v_at, 'Steamed on the way to ' || d.name);
  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches set target_dryer_id = d.id where id = v_lot;
  perform public.prod_event(v_lot, 'dryer_assigned', null, null, d.name, v_at);
  perform set_config('app.via_rpc', 'off', true);
  return v_lot;
end;
$$;

-- Dryer filling status: steamed paddy assigned to a dryer that has not started drying yet.
create or replace function public.dryer_filling()
returns table (dryer_id uuid, lots bigint, filling_kg numeric, first_at timestamptz, last_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select l.target_dryer_id, count(*), round(sum(public.batch_available_kg(l.id)), 2), min(l.ended_at), max(l.ended_at)
  from public.production_batches l
  where l.stage = 'steaming' and l.status = 'completed' and l.target_dryer_id is not null
    and public.can_view_production() and public.batch_available_kg(l.id) >= 1
  group by l.target_dryer_id;
$$;

-- Dryer start: everything filled into this dryer starts drying together.
create or replace function public.start_dryer(p_dryer uuid, p_started_at timestamptz default null, p_request uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_inputs jsonb;
  v_id uuid;
begin
  perform public.require_stage_role('drying');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  select jsonb_agg(jsonb_build_object('batch_id', l.id) order by l.ended_at) into v_inputs
  from public.production_batches l
  where l.stage = 'steaming' and l.status = 'completed' and l.target_dryer_id = p_dryer and public.batch_available_kg(l.id) >= 1;
  if v_inputs is null then
    raise exception 'NOTHING_IN_DRYER: no steamed paddy has been loaded into this dryer yet. Stop a soaking tank into it first.';
  end if;
  return public.start_production_batch('drying', p_dryer, v_inputs, p_started_at, p_request, null, null);
end;
$$;

-- Dryer stop: record unload moisture, then unload automatically into the dryer's own feed tank.
create or replace function public.stop_dryer(p_drying uuid, p_moisture_pct numeric, p_output_kg numeric default null,
  p_ended_at timestamptz default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  b public.production_batches;
  d public.production_equipment;
  v_tank uuid;
  v_feed uuid;
  v_at timestamptz := coalesce(p_ended_at, now());
begin
  perform public.require_stage_role('drying');
  select * into b from public.production_batches where id = p_drying for update;
  if not found or b.stage <> 'drying' then raise exception 'Drying batch not found'; end if;
  -- Safe retry: already unloaded.
  select c.id into v_feed from public.batch_inputs i join public.production_batches c on c.id = i.child_id
  where i.parent_id = p_drying and c.stage = 'mill_feed' and c.status <> 'cancelled' limit 1;
  if v_feed is not null then return v_feed; end if;
  if p_moisture_pct is null then raise exception 'Enter the unload moisture %%.'; end if;
  select * into d from public.production_equipment where id = b.equipment_id;
  select id into v_tank from public.production_equipment
  where plant_id = d.plant_id and kind = 'mill_feed_tank' and number = d.number and active limit 1;
  if v_tank is null then raise exception 'No feed tank % is set up for %.', d.number, d.name; end if;
  if b.status = 'running' then
    perform public.complete_production_batch(p_drying, p_output_kg, 0, p_moisture_pct, v_at, p_remarks);
  end if;
  return public.start_production_batch('mill_feed', v_tank,
    jsonb_build_array(jsonb_build_object('batch_id', p_drying, 'qty_kg', public.batch_available_kg(p_drying))), v_at, null, null, null);
end;
$$;

-- Milling: start with all the paddy waiting in one dryer's feed tank.
create or replace function public.start_milling_from_dryer(p_dryer_no integer, p_line uuid, p_started_at timestamptz default null,
  p_request uuid default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_inputs jsonb;
  v_id uuid;
  v_plant uuid;
begin
  perform public.require_stage_role('milling');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  select plant_id into v_plant from public.production_equipment where id = p_line;
  select jsonb_agg(jsonb_build_object('batch_id', f.id, 'qty_kg', public.batch_available_kg(f.id)) order by f.started_at) into v_inputs
  from public.production_batches f
  join public.production_equipment t on t.id = f.equipment_id and t.kind = 'mill_feed_tank' and t.number = p_dryer_no and t.plant_id = v_plant
  where f.stage = 'mill_feed' and f.status = 'completed' and public.batch_available_kg(f.id) >= 1;
  if v_inputs is null then
    raise exception 'NOTHING_IN_FEED_TANK: no dried paddy from Dryer % is waiting in its feed tank.', p_dryer_no;
  end if;
  return public.start_production_batch('milling', p_line, v_inputs, p_started_at, p_request, p_remarks, null);
end;
$$;

-- Feed tanks waiting for the mill, per dryer number.
create or replace function public.feed_tanks_waiting()
returns table (dryer_no integer, waiting_kg numeric, lots bigint, since timestamptz)
language sql stable security definer set search_path = public
as $$
  select t.number, round(sum(public.batch_available_kg(f.id)), 2), count(*), min(f.started_at)
  from public.production_batches f join public.production_equipment t on t.id = f.equipment_id and t.kind = 'mill_feed_tank'
  where f.stage = 'mill_feed' and f.status = 'completed' and public.can_view_production() and public.batch_available_kg(f.id) >= 1
  group by t.number;
$$;

revoke execute on function public.stop_soaking_to_dryer(uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function public.dryer_filling() from public, anon;
revoke execute on function public.start_dryer(uuid, timestamptz, uuid) from public, anon;
revoke execute on function public.stop_dryer(uuid, numeric, numeric, timestamptz, text) from public, anon;
revoke execute on function public.start_milling_from_dryer(integer, uuid, timestamptz, uuid, text) from public, anon;
revoke execute on function public.feed_tanks_waiting() from public, anon;
revoke execute on function public.audit_variety_output_standards() from public, anon, authenticated;
grant execute on function public.stop_soaking_to_dryer(uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.dryer_filling() to authenticated;
grant execute on function public.start_dryer(uuid, timestamptz, uuid) to authenticated;
grant execute on function public.stop_dryer(uuid, numeric, numeric, timestamptz, text) to authenticated;
grant execute on function public.start_milling_from_dryer(integer, uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.feed_tanks_waiting() to authenticated;
