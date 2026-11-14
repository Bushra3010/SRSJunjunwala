-- Weighing leftovers: quintal entries round to whole kg, so a batch can be left with a few
-- hundred grams (e.g. 0.15 kg of a 93,153.15 kg truck). Less than 1 kg left now counts as
-- fully used, and equipment holding less than 1 kg counts as empty, so a rounding remainder
-- can no longer keep a tank or dryer "full" or a truck "waiting".

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
  if v_left < 1 and b.status = 'completed' then
    update public.production_batches set status = 'consumed' where id = p_id;
    perform public.prod_event(p_id, 'fully_consumed', b.output_kg);
  elsif v_left >= 1 and b.status = 'consumed' then
    update public.production_batches set status = 'completed' where id = p_id;
    perform public.prod_event(p_id, 'material_released', v_left);
  end if;
end;
$$;

create or replace function public.equipment_busy_batch(p_equipment uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select b.batch_no from public.production_batches b
  where b.equipment_id = p_equipment
    and (b.status = 'running' or (b.status = 'completed' and public.batch_available_kg(b.id) >= 1))
  order by b.created_at desc limit 1;
$$;

-- Settle batches that are already complete with only a rounding remainder left.
do $$
declare b record;
begin
  perform set_config('app.via_rpc', 'on', true);
  for b in select id from public.production_batches where status = 'completed' and stage <> 'output' loop
    perform public.refresh_batch_status(b.id);
  end loop;
  perform set_config('app.via_rpc', 'off', true);
end;
$$;
