-- Admin delete (client, 19 Nov 2026): the administrator can permanently delete past entries
-- (test trucks, wrong entries) instead of only cancelling / reversing them.
--
--  * admin_delete_truck   — a weighbridge ticket with its QC, stock rows, purchase slip and slip payment
--  * admin_delete_slip    — a purchase slip (and its payment); it can then be built again from the QC
--  * admin_delete_payment — a payment or receipt (a paid slip goes back to "final")
--
-- Safety: admin only, a reason is required, and a full copy of what was deleted is kept in the
-- audit log (action 'admin_delete'). Refused when the truck was used in a production batch
-- (production history is never deleted) or when an entry was already exported to Tally
-- (Tally would then disagree with the ERP).

-- The append-only guards let a delete through only inside these functions.
create or replace function public.stock_movements_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('app.admin_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'Stock movements are append-only. Post a reversal or adjustment instead.'
    using errcode = '42501';
end;
$$;

create or replace function public.accounts_no_delete()
returns trigger language plpgsql as $$
begin
  if current_setting('app.admin_delete', true) = 'on' then
    return old;
  end if;
  raise exception '% records cannot be deleted. Cancel them instead.', tg_table_name using errcode = '42501';
end;
$$;

-- Payments deleted with a slip or on their own must not be in a Tally export.
create or replace function public.admin_delete_check(p_reason text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then
    raise exception 'PERMISSION_DENIED: only the administrator can delete entries' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'Give a reason for deleting.';
  end if;
end;
$$;

create or replace function public.admin_delete_log(p_table text, p_id uuid, p_pid text, p_snapshot jsonb, p_reason text)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (table_name, record_id, pid, action, old_data, new_data, reason)
  values (p_table, p_id, p_pid, 'admin_delete', p_snapshot, null, 'Deleted by admin: ' || btrim(p_reason));
$$;
revoke execute on function public.admin_delete_log(text, uuid, text, jsonb, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Payment
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_payment(p_payment uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.payments;
begin
  perform public.admin_delete_check(p_reason);
  select * into p from public.payments where id = p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  if exists (select 1 from public.tally_exported where voucher_key in ('PAY:' || p.id, 'RCT:' || p.id)) then
    raise exception '% was already exported to Tally. Cancel it instead, so Tally can be corrected.', p.voucher_no;
  end if;
  perform public.admin_delete_log('payments', p.id, p.voucher_no, to_jsonb(p), p_reason);
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.admin_delete', 'on', true);
  perform set_config('app.reason', 'Deleted by admin: ' || btrim(p_reason), true);
  update public.purchase_slips set status = 'final', payment_id = null where payment_id = p.id;
  delete from public.payments where id = p.id;
  perform set_config('app.admin_delete', 'off', true);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase slip
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_slip(p_slip uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  s public.purchase_slips;
begin
  perform public.admin_delete_check(p_reason);
  select * into s from public.purchase_slips where id = p_slip for update;
  if not found then raise exception 'Slip not found'; end if;
  if s.payment_id is not null and exists (select 1 from public.tally_exported where voucher_key = 'PAY:' || s.payment_id) then
    raise exception 'The payment of % was already exported to Tally. Cancel the payment instead.', s.slip_no;
  end if;
  perform public.admin_delete_log('purchase_slips', s.id, s.slip_no,
    to_jsonb(s) || jsonb_build_object(
      'lines', (select jsonb_agg(to_jsonb(l)) from public.purchase_slip_lines l where l.slip_id = s.id),
      'payment', (select to_jsonb(p) from public.payments p where p.id = s.payment_id)),
    p_reason);
  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.admin_delete', 'on', true);
  perform set_config('app.reason', 'Deleted by admin: ' || btrim(p_reason), true);
  delete from public.purchase_slip_sends where slip_id = s.id;
  delete from public.purchase_slips where id = s.id;  -- lines go with it
  if s.payment_id is not null then
    delete from public.payments where id = s.payment_id;
  end if;
  perform set_config('app.admin_delete', 'off', true);
  perform set_config('app.via_rpc', 'off', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Truck (weighbridge ticket and everything recorded against it)
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_truck(p_ticket uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.weighbridge_tickets;
  v_in uuid[];
  v_out uuid[];
  v_lines uuid[];
  v_slips uuid[];
  v_pays uuid[];
  v_batch text;
  v_exported text;
  v_counts jsonb;
begin
  perform public.admin_delete_check(p_reason);
  select * into t from public.weighbridge_tickets where id = p_ticket for update;
  if not found then raise exception 'Truck entry not found'; end if;

  select coalesce(array_agg(id), '{}') into v_in from public.qc_inbound where ticket_id = t.id;
  select coalesce(array_agg(id), '{}') into v_out from public.qc_outbound where ticket_id = t.id;
  select coalesce(array_agg(id), '{}') into v_lines from public.qc_inbound_lines where qc_id = any (v_in);
  select coalesce(array_agg(id), '{}') into v_slips from public.purchase_slips where ticket_id = t.id;
  select coalesce(array_agg(payment_id), '{}') into v_pays from public.purchase_slips where ticket_id = t.id and payment_id is not null;

  select string_agg(b.batch_no, ', ') into v_batch from public.production_batches b where b.source_qc_line_id = any (v_lines);
  if v_batch is not null then
    raise exception 'RST % went into production (batch %). Production history cannot be deleted; reverse the QC instead.', t.rst, v_batch;
  end if;
  select string_agg(x.voucher_key, ', ') into v_exported from public.tally_exported x
  where x.voucher_key in (select 'PUR:' || q from unnest(v_in) q union all select 'BRK:' || q from unnest(v_in) q
                          union all select 'PAY:' || p from unnest(v_pays) p)
     or exists (select 1 from unnest(v_out) o where x.voucher_key like 'SAL:' || o || ':%');
  if v_exported is not null then
    raise exception 'RST % is already in a Tally export. Reverse the QC instead, so Tally can be corrected.', t.rst;
  end if;

  v_counts := jsonb_build_object(
    'qc', cardinality(v_in) + cardinality(v_out),
    'stock_rows', (select count(*) from public.stock_movements where reference_id = any (v_in || v_out)),
    'slips', cardinality(v_slips),
    'payments', cardinality(v_pays));

  perform public.admin_delete_log('weighbridge_tickets', t.id, t.pid,
    to_jsonb(t) || jsonb_build_object(
      'qc_inbound', (select jsonb_agg(to_jsonb(q) || jsonb_build_object('lines',
                       (select jsonb_agg(to_jsonb(l)) from public.qc_inbound_lines l where l.qc_id = q.id)))
                     from public.qc_inbound q where q.id = any (v_in)),
      'qc_outbound', (select jsonb_agg(to_jsonb(q) || jsonb_build_object('lines',
                       (select jsonb_agg(to_jsonb(l)) from public.qc_outbound_lines l where l.qc_id = q.id)))
                      from public.qc_outbound q where q.id = any (v_out)),
      'stock_movements', (select jsonb_agg(to_jsonb(m)) from public.stock_movements m where m.reference_id = any (v_in || v_out)),
      'purchase_slips', (select jsonb_agg(to_jsonb(s)) from public.purchase_slips s where s.id = any (v_slips)),
      'payments', (select jsonb_agg(to_jsonb(p)) from public.payments p where p.id = any (v_pays))),
    p_reason);

  perform set_config('app.via_rpc', 'on', true);
  perform set_config('app.admin_delete', 'on', true);
  perform set_config('app.reason', 'Deleted by admin: ' || btrim(p_reason), true);

  delete from public.purchase_slip_sends where slip_id = any (v_slips);
  delete from public.purchase_slips where id = any (v_slips);
  delete from public.payments where id = any (v_pays);
  delete from public.voucher_overrides
  where source_line_id = any (v_lines)
     or source_line_id in (select id from public.qc_outbound_lines where qc_id = any (v_out));
  -- Reversal rows point at the rows they reverse, so they go first.
  delete from public.stock_movements where reference_id = any (v_in || v_out) and reverses_id is not null;
  delete from public.stock_movements where reference_id = any (v_in || v_out);
  update public.qc_inbound set amends_id = null where id = any (v_in);
  update public.qc_outbound set amends_id = null where id = any (v_out);
  delete from public.qc_inbound where id = any (v_in);    -- lines go with it
  delete from public.qc_outbound where id = any (v_out);  -- lines go with it
  update public.weighbridge_tickets set duplicate_of = null where duplicate_of = t.id;
  delete from public.weighbridge_tickets where id = t.id;

  perform set_config('app.admin_delete', 'off', true);
  perform set_config('app.via_rpc', 'off', true);
  return v_counts || jsonb_build_object('rst', t.rst, 'vehicle_no', t.vehicle_no);
end;
$$;

-- Functions are executable by PUBLIC by default; only signed-in users may call these (the admin check is inside).
revoke execute on function public.admin_delete_truck(uuid, text) from public, anon;
revoke execute on function public.admin_delete_slip(uuid, text) from public, anon;
revoke execute on function public.admin_delete_payment(uuid, text) from public, anon;
grant execute on function public.admin_delete_truck(uuid, text) to authenticated;
grant execute on function public.admin_delete_slip(uuid, text) to authenticated;
grant execute on function public.admin_delete_payment(uuid, text) to authenticated;
