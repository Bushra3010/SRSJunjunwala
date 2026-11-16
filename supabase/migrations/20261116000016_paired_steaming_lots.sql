-- Client decision (16 Nov 2026): two soaking tanks (a pair) share one steaming lot number.
--  * Stopping a tank into a dryer joins the lot of the previous tank stopped into that same
--    dryer when that lot has only one tank, holds the same variety, and the dryer has not
--    started drying it yet. Otherwise the tank starts a new lot.
--  * So stopping Tank 1 then Tank 2 into Dryer 1 gives one lot (pair 1); a third tank into the
--    same dryer starts the next lot.
--  * Traceability is unchanged: the lot keeps both tanks as inputs.

create or replace function public.stop_soaking_to_dryer(p_soaking uuid, p_dryer uuid, p_ended_at timestamptz default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  s public.production_batches;
  d public.production_equipment;
  lot public.production_batches;
  v_lot uuid;
  v_busy text;
  v_steamer uuid;
  v_qty numeric;
  v_tanks integer[];
  v_pair integer;
  v_tank_name text;
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
  -- Lock the dryer so two tanks stopped at the same moment pair up correctly.
  perform 1 from public.production_equipment where id = d.id for update;
  -- The dryer must be empty or still filling: not drying, and not holding dried paddy.
  v_busy := public.equipment_busy_batch(d.id);
  if v_busy is not null then
    raise exception 'DRYER_BUSY: % is drying or still holds dried paddy (%). Choose another dryer.', d.name, v_busy;
  end if;

  -- A lot waiting in this dryer with a single tank of the same variety takes this tank as its pair.
  select l.* into lot
  from public.production_batches l
  where l.stage = 'steaming' and l.status = 'completed' and l.target_dryer_id = d.id
    and l.variety_id is not null and l.variety_id = s.variety_id
    and public.batch_consumed_kg(l.id) = 0
    and (select count(*) from public.batch_inputs i where i.child_id = l.id) = 1
  order by l.ended_at desc, l.created_at desc
  limit 1
  for update;

  perform public.complete_production_batch(p_soaking, null, 0, null, v_at, p_remarks);

  if lot.id is not null then
    v_qty := public.batch_available_kg(p_soaking);
    select array_agg(eq.number order by eq.number), min(eq.pair_no) into v_tanks, v_pair
    from public.production_batches b join public.production_equipment eq on eq.id = b.equipment_id
    where b.id = p_soaking or b.id in (select i.parent_id from public.batch_inputs i where i.child_id = lot.id);
    if v_tanks is null or array_length(v_tanks, 1) <> 2 or v_tanks[1] <> 2 * v_pair - 1 or v_tanks[2] <> 2 * v_pair then
      v_pair := null;
    end if;
    select name into v_tank_name from public.production_equipment where id = s.equipment_id;

    perform set_config('app.via_rpc', 'on', true);
    insert into public.batch_inputs (child_id, parent_id, qty_kg) values (lot.id, p_soaking, v_qty);
    perform public.prod_ledger(p_soaking, 'consumed', -v_qty, null, lot.id);
    perform public.prod_ledger(lot.id, 'input', v_qty, 'entered', p_soaking);
    perform public.prod_ledger(lot.id, 'output', v_qty, coalesce(lot.output_qty_status, 'estimated'), p_soaking,
      'Second tank of the pair, steamed straight after the first');
    perform public.prod_event(p_soaking, 'transferred_out', v_qty, lot.id, null, v_at);
    update public.production_batches
    set input_kg = coalesce(input_kg, 0) + v_qty, output_kg = coalesce(output_kg, 0) + v_qty,
        ended_at = greatest(ended_at, v_at), pair_no = v_pair
    where id = lot.id;
    perform public.prod_event(lot.id, 'tank_added', v_qty, p_soaking,
      coalesce(v_tank_name, 'Tank') || ' joined this lot — steamed after the first tank into ' || d.name, v_at);
    perform public.refresh_batch_status(p_soaking);
    perform set_config('app.via_rpc', 'off', true);
    return lot.id;
  end if;

  -- First tank of a new lot.
  select id into v_steamer from public.production_equipment where plant_id = d.plant_id and kind = 'steamer' and active limit 1;
  v_lot := public.start_production_batch('steaming', v_steamer, jsonb_build_array(jsonb_build_object('batch_id', p_soaking)), v_at, null, null, null);
  perform public.complete_production_batch(v_lot, null, 0, null, v_at, 'Steamed on the way to ' || d.name);
  perform set_config('app.via_rpc', 'on', true);
  update public.production_batches set target_dryer_id = d.id where id = v_lot;
  perform public.prod_event(v_lot, 'dryer_assigned', null, null, d.name, v_at);
  perform set_config('app.via_rpc', 'off', true);
  return v_lot;
end;
$$;

-- Dryer filling status now also counts tanks (a lot holds one or two tanks).
drop function if exists public.dryer_filling();
create function public.dryer_filling()
returns table (dryer_id uuid, lots bigint, filling_kg numeric, first_at timestamptz, last_at timestamptz, tanks bigint)
language sql stable security definer set search_path = public
as $$
  select l.target_dryer_id, count(*), round(sum(public.batch_available_kg(l.id)), 2), min(l.started_at), max(l.ended_at),
         sum((select count(*) from public.batch_inputs i where i.child_id = l.id))
  from public.production_batches l
  where l.stage = 'steaming' and l.status = 'completed' and l.target_dryer_id is not null
    and public.can_view_production() and public.batch_available_kg(l.id) >= 1
  group by l.target_dryer_id;
$$;

revoke execute on function public.stop_soaking_to_dryer(uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function public.dryer_filling() from public, anon;
grant execute on function public.stop_soaking_to_dryer(uuid, uuid, timestamptz, text) to authenticated;
grant execute on function public.dryer_filling() to authenticated;
