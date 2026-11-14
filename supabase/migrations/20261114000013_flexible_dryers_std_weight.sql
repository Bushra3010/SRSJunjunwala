-- Client feedback (14 Nov 2026), second round:
--  * Flexible dryers: a steaming lot may be any one or more finished soaking tanks and may go to
--    ANY free dryer (e.g. Tank 5 into Dryer 1 when a tank is faulty). The usual pairing
--    (1+2 -> Dryer 1, 3+4 -> Dryer 2, 5+6 -> Dryer 3) is only a suggestion now.
--    The dryer is chosen when the lot starts steaming (steaming passes straight into it) and
--    stored on the lot as target_dryer_id.
--  * Tanks can't be weighed: each variety gets a standard weight per tank (std_tank_kg), set
--    in Admin -> Masters. Loading a tank defaults to it, and recovery is worked out from it.

alter table public.production_batches add column if not exists target_dryer_id uuid references public.production_equipment (id);
alter table public.varieties add column if not exists std_tank_kg numeric(14, 2) check (std_tank_kg > 0);
comment on column public.varieties.std_tank_kg is 'Standard paddy weight in one soaking tank for this variety (kg). Tanks are not weighed.';

update public.production_equipment set name = 'Dryer ' || number where kind = 'dryer' and name like 'Dryer % (Tanks %';
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
    (p_plant, 'dryer', 'DRYER-1', 'Dryer 1', 1, 1, 27000, 34000, 12, 14),
    (p_plant, 'dryer', 'DRYER-2', 'Dryer 2', 2, 2, 27000, 34000, 12, 14),
    (p_plant, 'dryer', 'DRYER-3', 'Dryer 3', 3, 3, 27000, 34000, 12, 14),
    (p_plant, 'mill_feed_tank', 'MFT-1', 'Mill Feed Tank 1', 1, null, null, null, null, null),
    (p_plant, 'mill_feed_tank', 'MFT-2', 'Mill Feed Tank 2', 2, null, null, null, null, null),
    (p_plant, 'mill_feed_tank', 'MFT-3', 'Mill Feed Tank 3', 3, null, null, null, null, null),
    (p_plant, 'mill_line', 'MILL-1', 'Milling Line 1', 1, null, null, null, 4, 6)
  on conflict (plant_id, code) do nothing;
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
    if array_length(v_parents, 1) <> 1 then raise exception 'A dryer takes exactly one steaming lot.'; end if;
    select pair_no into v_pair from public.production_batches where id = v_parents[1];
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

drop function if exists public.production_receivable_lines();
create or replace function public.production_receivable_lines()
returns table (qc_line_id uuid, qc_pid text, posted_at timestamptz, rst integer, rst_cycle text, vehicle_no text,
               net_kg numeric, supplier text, variety text, lot_no text, variety_id uuid, std_tank_kg numeric, moisture_pct numeric, accepted_kg numeric, location text)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_role('admin', 'production_manager', 'qc_head', 'management', 'soaking_operator', 'foreman');
  return query
  select l.id, q.pid, q.posted_at, t.rst, c.label, t.vehicle_no, t.net_kg, pa.name, v.name, l.lot_no, v.id, v.std_tank_kg, l.moisture_pct, l.accepted_kg, lo.name
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

-- Start a steaming lot from any finished soaking tanks, into a chosen dryer.
create or replace function public.start_steaming_lot(
  p_soaking uuid[], p_dryer uuid, p_started_at timestamptz default null, p_request uuid default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_steamer uuid;
  d public.production_equipment;
  v_busy text;
  v_inputs jsonb;
begin
  perform public.require_stage_role('steaming');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  if p_soaking is null or cardinality(p_soaking) = 0 then raise exception 'Select at least one soaking tank.'; end if;
  select * into d from public.production_equipment where id = p_dryer and kind = 'dryer' and active;
  if not found then raise exception 'Choose the dryer this lot goes into.'; end if;
  -- Steaming passes straight into the dryer, so it must be empty and not promised to another lot.
  perform 1 from public.production_equipment where id = d.id for update;
  v_busy := public.equipment_busy_batch(d.id);
  if v_busy is null then
    select batch_no into v_busy from public.production_batches
    where stage = 'steaming' and status = 'running' and target_dryer_id = d.id limit 1;
  end if;
  if v_busy is not null then
    raise exception 'DRYER_BUSY: % still holds lot %. Move it to the mill feed tanks first, or choose another dryer.', d.name, v_busy;
  end if;
  select id into v_steamer from public.production_equipment where plant_id = d.plant_id and kind = 'steamer' and active limit 1;
  select jsonb_agg(jsonb_build_object('batch_id', x)) into v_inputs from unnest(p_soaking) x;
  v_id := public.start_production_batch('steaming', v_steamer, v_inputs, p_started_at, p_request, p_remarks, null);
  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches set target_dryer_id = d.id where id = v_id;
  perform public.prod_event(v_id, 'dryer_assigned', null, null, d.name);
  perform set_config('app.via_rpc', 'off', true);
  return v_id;
end;
$$;

-- Steaming finished: close the lot and load it into its dryer (the one chosen at start, or p_dryer).
drop function if exists public.finish_steaming_to_dryer(uuid, timestamptz, text);
create or replace function public.finish_steaming_to_dryer(
  p_lot uuid, p_ended_at timestamptz default null, p_remarks text default null, p_dryer uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  l public.production_batches;
  v_dryer uuid;
  v_id uuid;
begin
  select * into l from public.production_batches where id = p_lot;
  if not found or l.stage <> 'steaming' then raise exception 'Lot not found'; end if;
  perform public.require_stage_role('steaming');
  select i.child_id into v_id from public.batch_inputs i join public.production_batches c on c.id = i.child_id
  where i.parent_id = p_lot and c.stage = 'drying' and c.status <> 'cancelled' limit 1;
  if v_id is not null then return v_id; end if;
  v_dryer := coalesce(p_dryer, l.target_dryer_id,
    (select id from public.production_equipment where plant_id = l.plant_id and kind = 'dryer' and pair_no = l.pair_no and active limit 1));
  if v_dryer is null then raise exception 'Choose the dryer for lot %.', l.batch_no; end if;
  if l.status = 'running' then
    perform public.complete_production_batch(p_lot, null, 0, null, p_ended_at, p_remarks);
  end if;
  return public.start_production_batch('drying', v_dryer, jsonb_build_array(jsonb_build_object('batch_id', p_lot)),
    coalesce(p_ended_at, now()), null, null, null);
end;
$$;

revoke execute on function public.start_steaming_lot(uuid[], uuid, timestamptz, uuid, text) from public, anon;
revoke execute on function public.finish_steaming_to_dryer(uuid, timestamptz, text, uuid) from public, anon;
revoke execute on function public.production_receivable_lines() from public, anon;
grant execute on function public.start_steaming_lot(uuid[], uuid, timestamptz, uuid, text) to authenticated;
grant execute on function public.finish_steaming_to_dryer(uuid, timestamptz, text, uuid) to authenticated;
grant execute on function public.production_receivable_lines() to authenticated;
revoke execute on function public.seed_production_equipment(uuid) from public, anon, authenticated;
