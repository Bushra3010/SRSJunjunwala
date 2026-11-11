-- Live figures for the Admin dashboard, computed in one round trip (all times in IST).
-- Restricted to admin / management.

create or replace function public.admin_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  tz constant text := 'Asia/Kolkata';
  v_local timestamp := now() at time zone tz;
  m_this timestamp := date_trunc('month', v_local);
  m0 timestamptz := date_trunc('month', v_local) at time zone tz;
  m_prev timestamptz := (date_trunc('month', v_local) - interval '1 month') at time zone tz;
  d0 timestamptz := date_trunc('day', v_local) at time zone tz;
  y0 timestamptz := date_trunc('year', v_local) at time zone tz;
  w0 timestamptz := now() - interval '7 days';
  w_prev timestamptz := now() - interval '14 days';
  r jsonb;
begin
  perform public.require_role('admin', 'management');

  with
  outl as (
    select q.posted_at, ol.qty_kg, coalesce(sl.rate_per_qtl, 0) as rate, so.order_date
    from public.qc_outbound q
    join public.qc_outbound_lines ol on ol.qc_id = q.id
    left join public.so_lines sl on sl.id = ol.so_line_id
    left join public.sales_orders so on so.id = sl.so_id
    where q.status = 'posted'
  ),
  inl as (
    select q.posted_at, q.supplier_id, ql.variety_id, coalesce(ql.accepted_kg, 0) as accepted_kg,
           coalesce(ql.rejected_kg, 0) as rejected_kg, ql.returned_sacks, coalesce(pl.rate_per_qtl, 0) as rate
    from public.qc_inbound q
    join public.qc_inbound_lines ql on ql.qc_id = q.id
    left join public.po_lines pl on pl.id = ql.po_line_id
    where q.status = 'posted'
  ),
  months12 as (
    select generate_series(m_this - interval '11 months', m_this, interval '1 month') as m
  )
  select jsonb_build_object(
    'trucks_month', (select count(*) from public.weighbridge_tickets where weighed_at >= m0 and status not in ('duplicate', 'cancelled')),
    'trucks_prev_month', (select count(*) from public.weighbridge_tickets where weighed_at >= m_prev and weighed_at < m0 and status not in ('duplicate', 'cancelled')),
    'qc_posted_month', (select count(*) from public.qc_inbound where status = 'posted' and posted_at >= m0)
                     + (select count(*) from public.qc_outbound where status = 'posted' and posted_at >= m0),
    'qc_total_month', (select count(*) from public.qc_inbound where created_at >= m0 and status <> 'cancelled')
                    + (select count(*) from public.qc_outbound where created_at >= m0 and status <> 'cancelled'),
    'pending_approvals', (select count(*) from public.qc_inbound where status = 'submitted')
                       + (select count(*) from public.qc_outbound where status = 'submitted'),
    'open_exceptions', (select count(*) from public.weighbridge_tickets where status in ('exception', 'duplicate')),
    'po_open', (select count(*) from public.purchase_orders where status = 'open'),
    'po_total', (select count(*) from public.purchase_orders where status <> 'cancelled'),
    'so_open', (select count(*) from public.sales_orders where status = 'open'),
    'so_total', (select count(*) from public.sales_orders where status <> 'cancelled'),
    'dispatch_value_week', (select coalesce(sum(qty_kg * rate / 100), 0) from outl where posted_at >= w0),
    'dispatch_value_prev_week', (select coalesce(sum(qty_kg * rate / 100), 0) from outl where posted_at >= w_prev and posted_at < w0),
    'receipts_week_kg', (select coalesce(sum(accepted_kg), 0) from inl where posted_at >= w0),
    'receipts_prev_week_kg', (select coalesce(sum(accepted_kg), 0) from inl where posted_at >= w_prev and posted_at < w0),
    'suppliers_active', (select count(*) from public.parties where active and kind in ('supplier', 'both')),
    'users_active', (select count(*) from public.profiles where active and role is not null),
    'users_total', (select count(*) from public.profiles),
    'users_new_month', (select count(*) from public.profiles where created_at >= m0),
    'dispatch_value_year', (select coalesce(sum(qty_kg * rate / 100), 0) from outl where posted_at >= y0),
    'rejected_kg_year', (select coalesce(sum(rejected_kg), 0) from inl where posted_at >= y0),
    'purchase_value_year', (select coalesce(sum(accepted_kg * rate / 100), 0) from inl where posted_at >= y0),
    'returned_sacks_year', (select coalesce(sum(returned_sacks), 0) from inl where posted_at >= y0),
    'intake_by_supplier', (
      select coalesce(jsonb_agg(x order by x.kg desc), '[]'::jsonb) from (
        select pa.name, sum(inl.accepted_kg) as kg
        from inl join public.parties pa on pa.id = inl.supplier_id
        where inl.posted_at >= w0
        group by pa.name order by 2 desc limit 6
      ) x),
    'intake_by_variety', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select to_char(date_trunc('month', inl.posted_at at time zone tz), 'YYYY-MM') as month, v.name as variety, sum(inl.accepted_kg) as kg
        from inl join public.varieties v on v.id = inl.variety_id
        where inl.posted_at >= (m_this - interval '6 months') at time zone tz
        group by 1, 2
      ) x),
    'queue_by_wait', (
      select jsonb_build_object(
        'over60', count(*) filter (where now() - weighed_at > interval '60 minutes'),
        'mid', count(*) filter (where now() - weighed_at between interval '30 minutes' and interval '60 minutes'),
        'under30', count(*) filter (where now() - weighed_at < interval '30 minutes'))
      from public.weighbridge_tickets where status in ('awaiting_qc', 'qc_in_progress')),
    'dispatch_months', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(mm.m, 'YYYY-MM'),
        'value', coalesce((select sum(o.qty_kg * o.rate / 100) from outl o where date_trunc('month', o.posted_at at time zone tz) = mm.m), 0)
      ) order by mm.m) from months12 mm),
    'fulfilment', (
      select jsonb_agg(x order by x.month desc) from (
        select to_char(mm.m, 'YYYY-MM') as month,
          (select coalesce(sum(sl.ordered_kg), 0) from public.so_lines sl join public.sales_orders so on so.id = sl.so_id
             where so.status <> 'cancelled' and date_trunc('month', so.order_date) = mm.m) as ordered_kg,
          (select coalesce(sum(o.qty_kg), 0) from outl o where date_trunc('month', o.order_date) = mm.m) as dispatched_kg,
          (select coalesce(sum(o.qty_kg * o.rate / 100), 0) from outl o where date_trunc('month', o.order_date) = mm.m) as value
        from months12 mm where mm.m >= m_this - interval '3 months'
      ) x),
    'team', (
      select coalesce(jsonb_agg(x order by x.actions desc, x.name), '[]'::jsonb) from (
        select coalesce(nullif(p.full_name, ''), p.email) as name, p.role,
          (select count(*) from public.audit_log a where a.user_id = p.id and a.at >= d0) as actions,
          (select max(a.at) from public.audit_log a where a.user_id = p.id) as last_at
        from public.profiles p where p.active and p.role is not null
        order by 3 desc limit 6
      ) x),
    'recent_dispatches', (
      select coalesce(jsonb_agg(x order by x.at desc), '[]'::jsonb) from (
        select coalesce(q.dispatch_no, q.pid) as no, q.status, coalesce(q.posted_at, q.submitted_at, q.created_at) as at,
          t.rst, t.vehicle_no,
          (select string_agg(distinct pa.name, ', ') from public.qc_outbound_lines ol
             join public.so_lines sl on sl.id = ol.so_line_id join public.sales_orders so on so.id = sl.so_id
             join public.parties pa on pa.id = so.customer_id where ol.qc_id = q.id) as customer,
          (select string_agg(distinct v.name, ', ') from public.qc_outbound_lines ol join public.varieties v on v.id = ol.variety_id where ol.qc_id = q.id) as varieties,
          (select coalesce(sum(ol.qty_kg), 0) from public.qc_outbound_lines ol where ol.qc_id = q.id) as qty_kg
        from public.qc_outbound q join public.weighbridge_tickets t on t.id = q.ticket_id
        where q.status in ('posted', 'submitted', 'reversed')
        order by 3 desc limit 5
      ) x)
  ) into r;

  return r;
end;
$$;

revoke execute on function public.admin_dashboard() from public, anon;
grant execute on function public.admin_dashboard() to authenticated;

-- Live updates: let the app subscribe to changes on the operational tables (RLS still applies).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['weighbridge_tickets', 'qc_inbound', 'qc_outbound', 'purchase_orders', 'sales_orders', 'stock_movements'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
