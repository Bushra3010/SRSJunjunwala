-- Truck receipt: start = weighing time, end = QC posting time. A ticket whose recorded
-- weighing time is later than its QC posting (clock or back-entry differences) would
-- violate the ended_at >= started_at check, so the start is capped at the posting time.
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
     'approved', l.moisture_pct, least(t.weighed_at, coalesce(q.posted_at, now())), coalesce(q.posted_at, now()), l.id, v_snapshot, q.location_id, p_request, p_remarks)
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
