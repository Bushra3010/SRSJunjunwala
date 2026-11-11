-- Purchase orders, sales orders and the append-only stock ledger.
-- PRD refs: §7.4 PO-*, §7.5 SO-*, REC-01..04, §7.7 INV-*.

create sequence public.po_no_seq start 1001;
create sequence public.so_no_seq start 2001;
create sequence public.lot_seq start 1;

create type public.order_status as enum ('draft', 'open', 'closed', 'cancelled');

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  po_no text not null unique default ('PO-' || nextval('public.po_no_seq')),
  plant_id uuid not null references public.plants (id),
  supplier_id uuid not null references public.parties (id),
  broker_id uuid references public.brokers (id),
  order_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  expected_by date,
  status public.order_status not null default 'open',
  notes text,
  status_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  line_no integer not null,
  variety_id uuid not null references public.varieties (id),
  ordered_kg numeric(14, 2) not null check (ordered_kg > 0),
  rate_per_qtl numeric(12, 2) check (rate_per_qtl >= 0),
  unique (po_id, line_no)
);

create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  so_no text not null unique default ('SO-' || nextval('public.so_no_seq')),
  plant_id uuid not null references public.plants (id),
  customer_id uuid not null references public.parties (id),
  order_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
  required_by date,
  status public.order_status not null default 'open',
  notes text,
  status_reason text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.so_lines (
  id uuid primary key default gen_random_uuid(),
  so_id uuid not null references public.sales_orders (id) on delete cascade,
  line_no integer not null,
  variety_id uuid not null references public.varieties (id),
  ordered_kg numeric(14, 2) not null check (ordered_kg > 0),
  rate_per_qtl numeric(12, 2) check (rate_per_qtl >= 0),
  unique (so_id, line_no)
);

create trigger purchase_orders_touch before update on public.purchase_orders
  for each row execute function public.touch_updated_at();
create trigger sales_orders_touch before update on public.sales_orders
  for each row execute function public.touch_updated_at();

create trigger audit_purchase_orders after insert or update or delete on public.purchase_orders
  for each row execute function public.audit_trigger();
create trigger audit_po_lines after insert or update or delete on public.po_lines
  for each row execute function public.audit_trigger();
create trigger audit_sales_orders after insert or update or delete on public.sales_orders
  for each row execute function public.audit_trigger();
create trigger audit_so_lines after insert or update or delete on public.so_lines
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Stock ledger: append-only. Corrections are new 'reversal'/'adjustment' rows.
-- ---------------------------------------------------------------------------
create type public.stock_movement_type as enum (
  'receipt',
  'sales_issue',
  'production_issue',
  'production_receipt',
  'transfer',
  'adjustment',
  'return',
  'reversal'
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  pid text not null unique default public.next_pid(),
  plant_id uuid not null references public.plants (id),
  movement_type public.stock_movement_type not null,
  variety_id uuid not null references public.varieties (id),
  location_id uuid not null references public.locations (id),
  lot_no text,
  qty_kg numeric(14, 2) not null check (qty_kg <> 0),
  -- Estimated production never counts as on-hand stock (INV-06).
  is_estimate boolean not null default false,
  reference_type text,
  reference_id uuid,
  reference_no text,
  reverses_id uuid references public.stock_movements (id),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index stock_movements_balance_idx on public.stock_movements (variety_id, location_id, lot_no);
create index stock_movements_created_idx on public.stock_movements (created_at desc);
create index stock_movements_reference_idx on public.stock_movements (reference_id);

create or replace function public.stock_movements_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'Stock movements are append-only. Post a reversal or adjustment instead.'
    using errcode = '42501';
end;
$$;

create trigger stock_movements_append_only before update or delete on public.stock_movements
  for each row execute function public.stock_movements_append_only();

create trigger audit_stock_movements after insert on public.stock_movements
  for each row execute function public.audit_trigger();

create view public.stock_balances with (security_invoker = true) as
select
  m.plant_id,
  m.variety_id,
  m.location_id,
  m.lot_no,
  sum(m.qty_kg) filter (where not m.is_estimate) as on_hand_kg,
  sum(m.qty_kg) filter (where m.is_estimate) as estimated_kg,
  max(m.created_at) as last_movement_at
from public.stock_movements m
group by m.plant_id, m.variety_id, m.location_id, m.lot_no;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.purchase_orders enable row level security;
alter table public.po_lines enable row level security;
alter table public.sales_orders enable row level security;
alter table public.so_lines enable row level security;
alter table public.stock_movements enable row level security;

create policy po_read on public.purchase_orders for select to authenticated
  using (public.has_role('admin', 'management', 'commercial', 'qc_head', 'qc_unloading'));
create policy po_write on public.purchase_orders for insert to authenticated
  with check (public.has_role('admin', 'management', 'commercial'));
create policy po_update on public.purchase_orders for update to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

create policy po_lines_read on public.po_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders p where p.id = po_id));
create policy po_lines_write on public.po_lines for all to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

create policy so_read on public.sales_orders for select to authenticated
  using (public.has_role('admin', 'management', 'commercial', 'qc_head', 'qc_loading'));
create policy so_write on public.sales_orders for insert to authenticated
  with check (public.has_role('admin', 'management', 'commercial'));
create policy so_update on public.sales_orders for update to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

create policy so_lines_read on public.so_lines for select to authenticated
  using (exists (select 1 from public.sales_orders s where s.id = so_id));
create policy so_lines_write on public.so_lines for all to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

-- Stock visibility: QC head and management only (INV-08). No direct insert policy:
-- movements are created by posting functions.
create policy stock_read on public.stock_movements for select to authenticated
  using (public.has_role('admin', 'management', 'qc_head'));
