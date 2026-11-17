-- Accounts module (client, 17 Nov 2026): party ledgers, payments/receipts, broker commission,
-- and an export file for TallyPrime (the books stay in Tally; the ERP sends entries to it).
--
--  * Purchases come from posted unloading QC: accepted qty x PO rate (or a rate the accountant fills in).
--  * Sales come from posted dispatches: qty x sales order rate, per customer.
--  * Broker commission: accepted qty x the broker's commission per quintal (Journal).
--  * Payments and receipts are recorded here (bank or cash) and also go to Tally.
--  * Every exported entry is logged so nothing is sent to Tally twice.

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
create or replace function public.can_view_accounts()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role('admin', 'management', 'accountant', 'commercial'); $$;

create or replace function public.can_edit_accounts()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_role('admin', 'accountant'); $$;

-- ---------------------------------------------------------------------------
-- Tally names and broker commission on the masters
-- ---------------------------------------------------------------------------
alter table public.parties add column if not exists tally_ledger text;
alter table public.brokers add column if not exists tally_ledger text;
alter table public.brokers add column if not exists commission_per_qtl numeric(10, 2) not null default 0
  check (commission_per_qtl >= 0);

-- Tally company and ledger / voucher-type names (must match Tally exactly).
create table if not exists public.tally_settings (
  key text primary key,
  value text not null,
  label text not null,
  sort_order integer not null default 0,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);
insert into public.tally_settings (key, value, label, sort_order) values
  ('company', '', 'Tally company name (blank = the company open in Tally)', 1),
  ('purchase_ledger', 'Paddy Purchase', 'Purchase ledger', 2),
  ('sales_ledger', 'Rice Sales', 'Sales ledger', 3),
  ('brokerage_ledger', 'Brokerage', 'Brokerage (commission) expense ledger', 4),
  ('cash_ledger', 'Cash', 'Cash ledger', 5),
  ('supplier_group', 'Sundry Creditors', 'Group for supplier and broker ledgers', 6),
  ('customer_group', 'Sundry Debtors', 'Group for customer ledgers', 7),
  ('purchase_vch', 'Purchase', 'Purchase voucher type', 8),
  ('sales_vch', 'Sales', 'Sales voucher type', 9),
  ('payment_vch', 'Payment', 'Payment voucher type', 10),
  ('receipt_vch', 'Receipt', 'Receipt voucher type', 11),
  ('journal_vch', 'Journal', 'Journal voucher type (brokerage)', 12)
on conflict (key) do nothing;

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  tally_ledger text,
  account_last4 text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Payments and receipts
-- ---------------------------------------------------------------------------
create sequence if not exists public.payment_no_seq start 1;
create sequence if not exists public.receipt_no_seq start 1;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  voucher_no text not null unique,
  plant_id uuid references public.plants (id),
  kind text not null check (kind in ('payment', 'receipt')),
  party_id uuid references public.parties (id),
  broker_id uuid references public.brokers (id),
  bank_account_id uuid references public.bank_accounts (id),
  amount numeric(14, 2) not null check (amount > 0),
  paid_on date not null,
  mode text not null check (mode in ('NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Cash', 'Other')),
  reference text,
  narration text,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  cancel_reason text,
  cancelled_by uuid,
  cancelled_at timestamptz,
  request_id uuid unique,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  check ((party_id is null) <> (broker_id is null)),
  check (kind = 'payment' or broker_id is null),
  check ((mode = 'Cash') = (bank_account_id is null))
);
create index if not exists payments_party_idx on public.payments (party_id);
create index if not exists payments_broker_idx on public.payments (broker_id);

-- Rate / customer filled in by the accountant for a QC line that has no order line.
create table if not exists public.voucher_overrides (
  source_line_id uuid primary key,
  kind text not null check (kind in ('purchase', 'sales')),
  party_id uuid references public.parties (id),
  rate_per_qtl numeric(12, 2) check (rate_per_qtl >= 0),
  set_by uuid default auth.uid(),
  set_at timestamptz not null default now()
);

-- Tally export history: what was sent, when, by whom.
create sequence if not exists public.tally_export_seq start 1;
create table if not exists public.tally_exports (
  id uuid primary key default gen_random_uuid(),
  export_no text not null unique,
  from_date date,
  to_date date,
  voucher_count integer not null,
  total_amount numeric(16, 2) not null default 0,
  exported_by uuid default auth.uid(),
  exported_at timestamptz not null default now()
);
create table if not exists public.tally_exported (
  voucher_key text primary key,
  export_id uuid not null references public.tally_exports (id),
  vtype text not null,
  amount numeric(14, 2) not null,
  exported_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security: read for account viewers; writes only through the functions below
-- (settings and banks may also be edited directly by admin / accountant).
-- ---------------------------------------------------------------------------
alter table public.tally_settings enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.payments enable row level security;
alter table public.voucher_overrides enable row level security;
alter table public.tally_exports enable row level security;
alter table public.tally_exported enable row level security;

drop policy if exists tally_settings_read on public.tally_settings;
create policy tally_settings_read on public.tally_settings for select to authenticated using (public.can_view_accounts());
drop policy if exists tally_settings_write on public.tally_settings;
create policy tally_settings_write on public.tally_settings for update to authenticated
  using (public.can_edit_accounts()) with check (public.can_edit_accounts());
drop policy if exists bank_accounts_read on public.bank_accounts;
create policy bank_accounts_read on public.bank_accounts for select to authenticated using (public.can_view_accounts());
drop policy if exists bank_accounts_write on public.bank_accounts;
create policy bank_accounts_write on public.bank_accounts for all to authenticated
  using (public.can_edit_accounts()) with check (public.can_edit_accounts());
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using (public.can_view_accounts());
drop policy if exists voucher_overrides_read on public.voucher_overrides;
create policy voucher_overrides_read on public.voucher_overrides for select to authenticated using (public.can_view_accounts());
drop policy if exists tally_exports_read on public.tally_exports;
create policy tally_exports_read on public.tally_exports for select to authenticated using (public.can_view_accounts());
drop policy if exists tally_exported_read on public.tally_exported;
create policy tally_exported_read on public.tally_exported for select to authenticated using (public.can_view_accounts());

drop trigger if exists audit_tally_settings on public.tally_settings;
create trigger audit_tally_settings after insert or update or delete on public.tally_settings
  for each row execute function public.audit_trigger();
drop trigger if exists audit_bank_accounts on public.bank_accounts;
create trigger audit_bank_accounts after insert or update or delete on public.bank_accounts
  for each row execute function public.audit_trigger();
drop trigger if exists audit_payments on public.payments;
create trigger audit_payments after insert or update or delete on public.payments
  for each row execute function public.audit_trigger();
drop trigger if exists audit_voucher_overrides on public.voucher_overrides;
create trigger audit_voucher_overrides after insert or update or delete on public.voucher_overrides
  for each row execute function public.audit_trigger();
drop trigger if exists audit_tally_exports on public.tally_exports;
create trigger audit_tally_exports after insert on public.tally_exports
  for each row execute function public.audit_trigger();

-- Payments and the export log are never deleted.
create or replace function public.accounts_no_delete()
returns trigger language plpgsql as $$
begin
  raise exception '% records cannot be deleted. Cancel them instead.', tg_table_name using errcode = '42501';
end;
$$;
drop trigger if exists payments_no_delete on public.payments;
create trigger payments_no_delete before delete on public.payments
  for each row execute function public.accounts_no_delete();
drop trigger if exists tally_exported_no_delete on public.tally_exported;
create trigger tally_exported_no_delete before delete on public.tally_exported
  for each row execute function public.accounts_no_delete();
drop trigger if exists tally_exports_no_delete on public.tally_exports;
create trigger tally_exports_no_delete before delete on public.tally_exports
  for each row execute function public.accounts_no_delete();

-- ---------------------------------------------------------------------------
-- Vouchers: everything that goes to Tally, built from the operational records
-- ---------------------------------------------------------------------------
create or replace function public.accounting_vouchers(p_from date default null, p_to date default null)
returns table (
  voucher_key text, vtype text, vdate date, ref text,
  party_id uuid, broker_id uuid, party_name text, ledger_name text,
  amount numeric, qty_kg numeric, narration text, problem text,
  source_status text, export_no text, exported_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with ins as (
    select q.id as qc_id, q.posted_at, q.status::text as status, q.supplier_id, q.broker_id, t.rst, t.vehicle_no,
           l.id as line_id, l.accepted_kg, v.name as variety, coalesce(o.rate_per_qtl, pl.rate_per_qtl) as rate
    from public.qc_inbound q
    join public.weighbridge_tickets t on t.id = q.ticket_id
    join public.qc_inbound_lines l on l.qc_id = q.id
    join public.varieties v on v.id = l.variety_id
    left join public.po_lines pl on pl.id = l.po_line_id
    left join public.voucher_overrides o on o.source_line_id = l.id
    where q.status in ('posted', 'reversed') and q.posted_at is not null and coalesce(l.accepted_kg, 0) > 0
  ),
  outs as (
    select q.id as qc_id, q.posted_at, q.status::text as status, q.dispatch_no, t.vehicle_no,
           l.id as line_id, l.qty_kg, v.name as variety,
           coalesce(o.party_id, so.customer_id) as customer_id, coalesce(o.rate_per_qtl, sl.rate_per_qtl) as rate
    from public.qc_outbound q
    join public.weighbridge_tickets t on t.id = q.ticket_id
    join public.qc_outbound_lines l on l.qc_id = q.id
    join public.varieties v on v.id = l.variety_id
    left join public.so_lines sl on sl.id = l.so_line_id
    left join public.sales_orders so on so.id = sl.so_id
    left join public.voucher_overrides o on o.source_line_id = l.id
    where q.status in ('posted', 'reversed') and q.posted_at is not null
  ),
  v as (
    -- Purchase: one voucher per truck.
    select 'PUR:' || qc_id as voucher_key, 'Purchase' as vtype, (min(posted_at) at time zone 'Asia/Kolkata')::date as vdate,
           'RST ' || min(rst) || ' · ' || min(vehicle_no) as ref, min(supplier_id::text)::uuid as party_id, null::uuid as broker_id,
           round(sum(accepted_kg / 100 * rate), 2) as amount, sum(accepted_kg) as qty_kg,
           string_agg(variety || ' ' || round(accepted_kg / 100, 2) || ' q @ Rs ' || coalesce(rate::text, '?') || '/q', '; ' order by line_id) as narration,
           case when bool_and(supplier_id is null) then 'Supplier missing' when bool_or(rate is null) then 'Rate missing' end as problem,
           min(status) as source_status
    from ins group by qc_id
    union all
    -- Broker commission: Journal per truck that came through a broker with a commission rate.
    select 'BRK:' || i.qc_id, 'Journal', (min(i.posted_at) at time zone 'Asia/Kolkata')::date,
           'RST ' || min(i.rst) || ' · ' || min(i.vehicle_no), null, min(i.broker_id::text)::uuid,
           round(sum(i.accepted_kg) / 100 * min(b.commission_per_qtl), 2), sum(i.accepted_kg),
           'Brokerage ' || round(sum(i.accepted_kg) / 100, 2) || ' q @ Rs ' || min(b.commission_per_qtl) || '/q',
           null, min(i.status)
    from ins i join public.brokers b on b.id = i.broker_id
    where b.commission_per_qtl > 0
    group by i.qc_id
    union all
    -- Sales: one voucher per dispatch and customer.
    select 'SAL:' || qc_id || ':' || coalesce(customer_id::text, 'none'), 'Sales', (min(posted_at) at time zone 'Asia/Kolkata')::date,
           coalesce(min(dispatch_no), 'Dispatch') || ' · ' || min(vehicle_no), customer_id, null,
           round(sum(qty_kg / 100 * rate), 2), sum(qty_kg),
           string_agg(variety || ' ' || round(qty_kg / 100, 2) || ' q @ Rs ' || coalesce(rate::text, '?') || '/q', '; ' order by line_id),
           case when customer_id is null then 'Customer missing' when bool_or(rate is null) then 'Rate missing' end,
           min(status)
    from outs group by qc_id, customer_id
    union all
    -- Payments and receipts.
    select (case p.kind when 'payment' then 'PAY:' else 'RCT:' end) || p.id,
           case p.kind when 'payment' then 'Payment' else 'Receipt' end, p.paid_on,
           p.voucher_no || ' · ' || p.mode || coalesce(' ' || nullif(p.reference, ''), ''), p.party_id, p.broker_id,
           p.amount, null,
           coalesce(nullif(p.narration, ''), initcap(p.kind) || ' by ' || p.mode || coalesce(' ' || nullif(p.reference, ''), '')),
           null, p.status
    from public.payments p
  )
  select v.voucher_key, v.vtype, v.vdate, v.ref, v.party_id, v.broker_id,
         coalesce(pa.name, br.name, '—'),
         coalesce(nullif(btrim(pa.tally_ledger), ''), pa.name, nullif(btrim(br.tally_ledger), ''), br.name),
         v.amount, v.qty_kg, v.narration, v.problem, v.source_status, x.export_no, e.exported_at
  from v
  left join public.parties pa on pa.id = v.party_id
  left join public.brokers br on br.id = v.broker_id
  left join public.tally_exported e on e.voucher_key = v.voucher_key
  left join public.tally_exports x on x.id = e.export_id
  where public.can_view_accounts()
    -- Reversed / cancelled entries only matter if they already went to Tally.
    and (v.source_status = 'posted' or e.voucher_key is not null)
    and (p_from is null or v.vdate >= p_from)
    and (p_to is null or v.vdate <= p_to)
  order by v.vdate, v.voucher_key;
$$;

-- Ledger of one party or broker, with running balance (positive = they owe us / Dr, negative = we owe / Cr).
create or replace function public.party_ledger(p_party uuid default null, p_broker uuid default null)
returns table (vdate date, vtype text, ref text, narration text, debit numeric, credit numeric, balance numeric, voucher_key text)
language sql stable security definer set search_path = public
as $$
  with e as (
    select a.vdate, a.vtype, a.ref, a.narration, a.voucher_key,
           case when a.vtype in ('Sales', 'Payment') then a.amount else 0 end as debit,
           case when a.vtype in ('Purchase', 'Receipt', 'Journal') then a.amount else 0 end as credit
    from public.accounting_vouchers(null, null) a
    where a.problem is null and a.source_status = 'posted'
      and ((p_party is not null and a.party_id = p_party) or (p_broker is not null and a.broker_id = p_broker))
  )
  select vdate, vtype, ref, narration, debit, credit,
         sum(debit - credit) over (order by vdate, voucher_key rows unbounded preceding), voucher_key
  from e order by vdate, voucher_key;
$$;

-- Outstanding per party / broker.
create or replace function public.party_balances()
returns table (party_id uuid, broker_id uuid, name text, kind text, debit numeric, credit numeric, balance numeric, last_date date)
language sql stable security definer set search_path = public
as $$
  select a.party_id, a.broker_id, min(a.party_name),
         case when a.broker_id is not null then 'broker' else coalesce((select p.kind::text from public.parties p where p.id = a.party_id), 'party') end,
         sum(case when a.vtype in ('Sales', 'Payment') then a.amount else 0 end),
         sum(case when a.vtype in ('Purchase', 'Receipt', 'Journal') then a.amount else 0 end),
         sum(case when a.vtype in ('Sales', 'Payment') then a.amount else -a.amount end),
         max(a.vdate)
  from public.accounting_vouchers(null, null) a
  where a.problem is null and a.source_status = 'posted'
  group by a.party_id, a.broker_id
  order by 3;
$$;

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------
create or replace function public.record_payment(
  p_kind text, p_party uuid, p_broker uuid, p_bank uuid, p_amount numeric, p_paid_on date,
  p_mode text, p_reference text default null, p_narration text default null, p_request uuid default null)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  if p_request is not null then
    select id into v_id from public.payments where request_id = p_request;
    if found then return v_id; end if;
  end if;
  if p_kind not in ('payment', 'receipt') then raise exception 'Choose payment or receipt.'; end if;
  if (p_party is null) = (p_broker is null) then raise exception 'Choose the party (or broker) for this entry.'; end if;
  if p_kind = 'receipt' and p_broker is not null then raise exception 'Receipts are from parties (customers), not brokers.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than zero.'; end if;
  if p_paid_on is null or p_paid_on > (now() at time zone 'Asia/Kolkata')::date then raise exception 'Date cannot be in the future.'; end if;
  if p_mode = 'Cash' and p_bank is not null then raise exception 'Cash entries do not use a bank account.'; end if;
  if p_mode <> 'Cash' and p_bank is null then raise exception 'Choose the bank account for % entries.', p_mode; end if;
  if p_mode in ('NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque') and nullif(btrim(p_reference), '') is null then
    raise exception 'Enter the % reference (UTR or cheque number).', p_mode;
  end if;
  insert into public.payments (voucher_no, plant_id, kind, party_id, broker_id, bank_account_id, amount, paid_on, mode, reference, narration, request_id)
  values (
    case p_kind when 'payment' then 'PAY-' || lpad(nextval('public.payment_no_seq')::text, 5, '0')
                else 'RCT-' || lpad(nextval('public.receipt_no_seq')::text, 5, '0') end,
    coalesce((select plant_id from public.profiles where id = auth.uid()), (select id from public.plants order by created_at limit 1)),
    p_kind, p_party, p_broker, p_bank, round(p_amount, 2), p_paid_on, p_mode,
    nullif(btrim(p_reference), ''), nullif(btrim(p_narration), ''), p_request)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.cancel_payment(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  p public.payments;
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to cancel an entry.'; end if;
  select * into p from public.payments where id = p_id for update;
  if not found then raise exception 'Entry not found'; end if;
  if p.status = 'cancelled' then raise exception '% is already cancelled.', p.voucher_no; end if;
  update public.payments set status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_id;
end;
$$;

-- Fill in a missing rate (and for dispatches, the customer) on a QC line before export.
create or replace function public.set_voucher_override(p_kind text, p_line uuid, p_party uuid, p_rate numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_qc uuid;
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  if p_rate is not null and p_rate < 0 then raise exception 'Rate cannot be negative.'; end if;
  if p_kind = 'purchase' then
    select qc_id into v_qc from public.qc_inbound_lines where id = p_line;
    if v_qc is null then raise exception 'QC line not found'; end if;
    if exists (select 1 from public.tally_exported where voucher_key = 'PUR:' || v_qc) then
      raise exception 'ALREADY_EXPORTED: this truck is already in Tally. Change it in Tally instead.';
    end if;
  elsif p_kind = 'sales' then
    select qc_id into v_qc from public.qc_outbound_lines where id = p_line;
    if v_qc is null then raise exception 'Dispatch line not found'; end if;
    if exists (select 1 from public.tally_exported where voucher_key like 'SAL:' || v_qc || ':%') then
      raise exception 'ALREADY_EXPORTED: this dispatch is already in Tally. Change it in Tally instead.';
    end if;
  else
    raise exception 'Unknown entry type';
  end if;
  insert into public.voucher_overrides (source_line_id, kind, party_id, rate_per_qtl)
  values (p_line, p_kind, p_party, p_rate)
  on conflict (source_line_id) do update
    set party_id = coalesce(excluded.party_id, voucher_overrides.party_id),
        rate_per_qtl = coalesce(excluded.rate_per_qtl, voucher_overrides.rate_per_qtl),
        set_by = auth.uid(), set_at = now();
end;
$$;

-- Lines needing a rate or customer (for the export screen).
create or replace function public.voucher_lines(p_key text)
returns table (line_id uuid, kind text, variety text, qty_kg numeric, rate numeric, party_id uuid)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_qc uuid;
begin
  if not public.can_view_accounts() then return; end if;
  if p_key like 'PUR:%' then
    v_qc := substr(p_key, 5)::uuid;
    return query
      select l.id, 'purchase'::text, v.name, l.accepted_kg, coalesce(o.rate_per_qtl, pl.rate_per_qtl), null::uuid
      from public.qc_inbound_lines l join public.varieties v on v.id = l.variety_id
      left join public.po_lines pl on pl.id = l.po_line_id
      left join public.voucher_overrides o on o.source_line_id = l.id
      where l.qc_id = v_qc and coalesce(l.accepted_kg, 0) > 0 order by l.line_no;
  elsif p_key like 'SAL:%' then
    v_qc := split_part(p_key, ':', 2)::uuid;
    return query
      select l.id, 'sales'::text, v.name, l.qty_kg, coalesce(o.rate_per_qtl, sl.rate_per_qtl), coalesce(o.party_id, so.customer_id)
      from public.qc_outbound_lines l join public.varieties v on v.id = l.variety_id
      left join public.so_lines sl on sl.id = l.so_line_id
      left join public.sales_orders so on so.id = sl.so_id
      left join public.voucher_overrides o on o.source_line_id = l.id
      where l.qc_id = v_qc order by l.line_no;
  end if;
end;
$$;

-- Record that a set of vouchers went to Tally. Only ready entries that were never exported are taken.
create or replace function public.mark_tally_exported(p_keys text[], p_from date, p_to date)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_count integer;
  v_total numeric;
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  -- Serialise exports so the same entry can never be logged twice.
  perform pg_advisory_xact_lock(hashtext('tally_export'));
  select count(*), coalesce(sum(a.amount), 0) into v_count, v_total
  from public.accounting_vouchers(null, null) a
  where a.voucher_key = any (p_keys) and a.problem is null and a.source_status = 'posted' and a.exported_at is null;
  if v_count = 0 then raise exception 'NOTHING_TO_EXPORT: no ready entries were selected (they may already be in Tally).'; end if;
  insert into public.tally_exports (export_no, from_date, to_date, voucher_count, total_amount)
  values ('TLY-' || lpad(nextval('public.tally_export_seq')::text, 5, '0'), p_from, p_to, v_count, v_total)
  returning id into v_id;
  insert into public.tally_exported (voucher_key, export_id, vtype, amount)
    select a.voucher_key, v_id, a.vtype, a.amount
    from public.accounting_vouchers(null, null) a
    where a.voucher_key = any (p_keys) and a.problem is null and a.source_status = 'posted' and a.exported_at is null;
  return v_id;
end;
$$;

-- Tally names for parties and brokers, and broker commission (accountant may set these).
create or replace function public.set_tally_ledger(p_party uuid, p_broker uuid, p_ledger text, p_commission numeric default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.can_edit_accounts() then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action' using errcode = '42501';
  end if;
  if p_party is not null then
    update public.parties set tally_ledger = nullif(btrim(p_ledger), '') where id = p_party;
  elsif p_broker is not null then
    if p_commission is not null and p_commission < 0 then raise exception 'Commission cannot be negative.'; end if;
    update public.brokers set tally_ledger = nullif(btrim(p_ledger), ''),
      commission_per_qtl = coalesce(p_commission, commission_per_qtl) where id = p_broker;
  end if;
end;
$$;

revoke execute on function public.accounting_vouchers(date, date) from public, anon;
revoke execute on function public.party_ledger(uuid, uuid) from public, anon;
revoke execute on function public.party_balances() from public, anon;
revoke execute on function public.record_payment(text, uuid, uuid, uuid, numeric, date, text, text, text, uuid) from public, anon;
revoke execute on function public.cancel_payment(uuid, text) from public, anon;
revoke execute on function public.set_voucher_override(text, uuid, uuid, numeric) from public, anon;
revoke execute on function public.voucher_lines(text) from public, anon;
revoke execute on function public.mark_tally_exported(text[], date, date) from public, anon;
revoke execute on function public.set_tally_ledger(uuid, uuid, text, numeric) from public, anon;
revoke execute on function public.can_view_accounts() from public, anon;
revoke execute on function public.can_edit_accounts() from public, anon;
grant execute on function public.accounting_vouchers(date, date) to authenticated;
grant execute on function public.party_ledger(uuid, uuid) to authenticated;
grant execute on function public.party_balances() to authenticated;
grant execute on function public.record_payment(text, uuid, uuid, uuid, numeric, date, text, text, text, uuid) to authenticated;
grant execute on function public.cancel_payment(uuid, text) to authenticated;
grant execute on function public.set_voucher_override(text, uuid, uuid, numeric) to authenticated;
grant execute on function public.voucher_lines(text) to authenticated;
grant execute on function public.mark_tally_exported(text[], date, date) to authenticated;
grant execute on function public.set_tally_ledger(uuid, uuid, text, numeric) to authenticated;
grant execute on function public.can_view_accounts() to authenticated;
grant execute on function public.can_edit_accounts() to authenticated;
grant select, update on public.tally_settings to authenticated;
grant select, insert, update on public.bank_accounts to authenticated;
grant select on public.payments, public.voucher_overrides, public.tally_exports, public.tally_exported to authenticated;
