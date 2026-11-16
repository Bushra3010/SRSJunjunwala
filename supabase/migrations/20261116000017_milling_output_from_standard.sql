-- Client decision (16 Nov 2026): the milling operator does not enter the rice output.
-- When milling stops without an output, the rice output is calculated from the variety's
-- standard recovery (sum of its rice-grade standards in Production -> Recovery standards),
-- falling back to the variety's estimated yield %. It is marked as an estimate; the actual
-- grade-wise outputs are still recorded on the Outputs page and compared with the standard.

-- Rice output (kg) a milling batch should give by the standard; null when no standard applies.
create or replace function public.milling_standard_output_kg(p_id uuid)
returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  b public.production_batches;
  v_variety uuid;
  v_pct numeric;
begin
  select * into b from public.production_batches where id = p_id;
  if not found or b.stage <> 'milling' then return null; end if;
  v_variety := b.variety_id;
  -- A batch from one feed tank normally has one variety; for older mixed batches use the main input's.
  if v_variety is null then
    select p.variety_id into v_variety
    from public.batch_inputs i join public.production_batches p on p.id = i.parent_id
    where i.child_id = p_id and p.variety_id is not null
    order by i.qty_kg desc limit 1;
  end if;
  if v_variety is null then return null; end if;
  select sum(s.std_pct) into v_pct
  from public.variety_output_standards s join public.rice_grades g on g.id = s.grade_id
  where s.variety_id = v_variety and g.kind = 'rice' and g.active;
  if coalesce(v_pct, 0) <= 0 then
    select est_yield_pct into v_pct from public.varieties where id = v_variety;
  end if;
  if coalesce(v_pct, 0) <= 0 then return null; end if;
  return round(b.input_kg * v_pct / 100, 2);
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
    -- Dryers are not weighed: drying output may be left as an estimate.
    -- Milling operators do not know the output either: it comes from the variety's standard recovery.
    if b.stage = 'precleaning' then
      raise exception 'Enter the output quantity for %.', b.batch_no;
    end if;
    if b.stage = 'milling' then
      v_out := public.milling_standard_output_kg(p_id);
      if v_out is null then
        raise exception 'NO_RECOVERY_STANDARD: set the standard recovery for this variety in Production → Recovery standards, or enter the output for %.', b.batch_no;
      end if;
    else
      v_out := b.input_kg - coalesce(p_rejected_kg, 0);
    end if;
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
    case when v_status = 'estimated' and b.stage = 'milling' then 'Rice output calculated from the standard recovery' when v_status = 'estimated' then 'Output not weighed — carried forward as an estimate' end, v_end,
    jsonb_build_object('rejected_kg', coalesce(p_rejected_kg, 0), 'moisture_pct', p_moisture_pct, 'qty_status', v_status));
  perform set_config('app.via_rpc', 'off', true);
end;
$$;


revoke execute on function public.milling_standard_output_kg(uuid) from public, anon;
grant execute on function public.milling_standard_output_kg(uuid) to authenticated;
