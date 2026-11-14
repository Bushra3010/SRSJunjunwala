-- Client feedback (14 Nov 2026, third round): no manual truck-to-tank transfer.
--  * The plant keeps one running total of unloaded paddy per variety: posted unloading QC
--    that has not gone into a tank yet.
--  * When the operator clicks "Start soaking" on a tank, the variety's standard weight per
--    tank (varieties.std_tank_kg) is taken from that total, oldest trucks first. If less than
--    a full tank is left, whatever is left goes in.
--  * Traceability is unchanged: the tank batch is still linked to the truck receipt(s) it drew
--    from, which the system picks automatically.

-- Unloaded paddy waiting for a soaking tank, per variety.
create or replace function public.unloaded_paddy_summary()
returns table (variety_id uuid, variety text, std_tank_kg numeric, waiting_kg numeric, trucks bigint, oldest_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.can_view_production() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  return query
  with pool as (
    -- Trucks already received into production with paddy left (e.g. a part-filled tank).
    select b.variety_id, public.batch_available_kg(b.id) as kg, b.started_at as at, b.id::text as truck
    from public.production_batches b
    where b.stage = 'receipt' and b.status = 'completed'
    union all
    -- Posted unloading QC that has not entered production yet.
    select l.variety_id, l.accepted_kg, coalesce(q.posted_at, q.created_at), l.id::text
    from public.qc_inbound_lines l
    join public.qc_inbound q on q.id = l.qc_id and q.status = 'posted'
    where coalesce(l.accepted_kg, 0) > 0
      and not exists (select 1 from public.production_batches pb where pb.source_qc_line_id = l.id)
  )
  select v.id, v.name, v.std_tank_kg, round(sum(p.kg), 2), count(*), min(p.at)
  from pool p join public.varieties v on v.id = p.variety_id
  where p.kg >= 1
  group by v.id, v.name, v.std_tank_kg
  order by min(p.at);
end;
$$;

-- One click: start soaking a tank with the variety's standard weight, taken from the unloaded total.
create or replace function public.start_soaking_standard(
  p_tank uuid, p_variety uuid, p_started_at timestamptz default null, p_request uuid default null, p_remarks text default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v public.varieties;
  v_id uuid;
  v_need numeric;
  v_take numeric;
  v_batch uuid;
  v_inputs jsonb := '[]'::jsonb;
  r record;
begin
  perform public.require_stage_role('soaking');
  if p_request is not null then
    select id into v_id from public.production_batches where request_id = p_request;
    if found then return v_id; end if;
  end if;
  select * into v from public.varieties where id = p_variety;
  if not found then raise exception 'Choose the paddy variety for this tank.'; end if;
  if v.std_tank_kg is null then
    raise exception 'NO_STANDARD_WEIGHT: set the standard paddy weight per tank for % in Admin → Masters → Varieties first.', v.name;
  end if;
  v_need := v.std_tank_kg;

  -- Oldest paddy first: trucks already in production with some left, then posted QC not yet received.
  for r in
    select * from (
      select 'b' as kind, b.id, public.batch_available_kg(b.id) as kg, b.started_at as at
      from public.production_batches b
      where b.stage = 'receipt' and b.status = 'completed' and b.variety_id = p_variety
      union all
      select 'q', l.id, l.accepted_kg, coalesce(q.posted_at, q.created_at)
      from public.qc_inbound_lines l
      join public.qc_inbound q on q.id = l.qc_id and q.status = 'posted'
      where l.variety_id = p_variety and coalesce(l.accepted_kg, 0) > 0
        and not exists (select 1 from public.production_batches pb where pb.source_qc_line_id = l.id)
    ) x
    where x.kg >= 1
    order by x.at, x.kind
  loop
    exit when v_need < 1;
    if r.kind = 'q' then
      v_batch := public.create_receipt_batch(r.id, null, null);
    else
      v_batch := r.id;
    end if;
    v_take := least(r.kg, v_need);
    v_inputs := v_inputs || jsonb_build_array(jsonb_build_object('batch_id', v_batch, 'qty_kg', v_take));
    v_need := v_need - v_take;
  end loop;

  if jsonb_array_length(v_inputs) = 0 then
    raise exception 'NOTHING_UNLOADED: no unloaded % paddy is waiting. Post the unloading QC first.', v.name;
  end if;
  return public.start_production_batch('soaking', p_tank, v_inputs, p_started_at, p_request,
    coalesce(nullif(btrim(p_remarks), ''),
      case when v_need >= 1 then 'Part tank: only ' || round(v.std_tank_kg - v_need) || ' kg of ' || v.name || ' was waiting' end),
    null);
end;
$$;

revoke execute on function public.unloaded_paddy_summary() from public, anon;
revoke execute on function public.start_soaking_standard(uuid, uuid, timestamptz, uuid, text) from public, anon;
grant execute on function public.unloaded_paddy_summary() to authenticated;
grant execute on function public.start_soaking_standard(uuid, uuid, timestamptz, uuid, text) to authenticated;
