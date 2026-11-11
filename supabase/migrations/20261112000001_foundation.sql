-- SRS Overseas Factory ERP — foundation: roles, profiles, permanent IDs, masters, audit.
-- PRD refs: §4 roles, §9 permissions, §10 data model, AU-01, MD-01, MD-02.

-- gen_random_uuid() is built into Postgres 13+; no extension needed.

-- ---------------------------------------------------------------------------
-- Roles & profiles
-- ---------------------------------------------------------------------------
create type public.app_role as enum (
  'admin',
  'management',
  'weighbridge_operator',
  'qc_unloading',
  'qc_loading',
  'qc_head',
  'foreman',
  'store_custodian',
  'commercial'
);

create table public.plants (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text not null default '',
  -- Role is assigned by an administrator only; never taken from sign-up metadata.
  role public.app_role,
  plant_id uuid references public.plants (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid() and active;
$$;

create or replace function public.has_role(variadic roles public.app_role[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select p.role = any (roles) from public.profiles p where p.id = auth.uid() and p.active),
    false
  );
$$;

create or replace function public.is_active_user()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role is not null);
$$;

create or replace function public.require_role(variadic roles public.app_role[])
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.has_role(variadic roles) then
    raise exception 'PERMISSION_DENIED: your role is not allowed to perform this action'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Permanent IDs (PRD §2.2 — never reused, independent of RST)
-- ---------------------------------------------------------------------------
create sequence public.pid_seq start 1;

create or replace function public.next_pid()
returns text
language sql volatile security definer set search_path = public
as $$
  select 'PID-' || lpad(nextval('public.pid_seq')::text, 6, '0');
$$;

-- ---------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------
create table public.varieties (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  default_bag_weight_kg numeric(8, 2) not null default 50 check (default_bag_weight_kg > 0),
  est_yield_pct numeric(5, 2) not null default 65 check (est_yield_pct between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create type public.party_kind as enum ('supplier', 'customer', 'both');

create table public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind public.party_kind not null,
  phone text,
  gstin text,
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.brokers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create type public.location_kind as enum ('yard', 'raw_store', 'processing', 'finished_store', 'other');

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants (id),
  code text not null,
  name text not null,
  kind public.location_kind not null default 'raw_store',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (plant_id, code)
);

-- Calculation parameters. Posted records store a snapshot of the values used,
-- so changing a setting never recalculates history (PRD MD-02, T-14).
create table public.calc_settings (
  key text primary key,
  value numeric not null,
  description text not null,
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now()
);

create trigger calc_settings_touch before update on public.calc_settings
  for each row execute function public.touch_updated_at();

create or replace function public.calc_setting(p_key text, p_default numeric)
returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce((select value from public.calc_settings where key = p_key), p_default);
$$;

-- ---------------------------------------------------------------------------
-- Audit log (PRD AU-01)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid default auth.uid(),
  table_name text not null,
  record_id uuid,
  pid text,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  reason text
);

create index audit_log_record_idx on public.audit_log (record_id);
create index audit_log_at_idx on public.audit_log (at desc);

create or replace function public.audit_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old := to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := to_jsonb(new);
  end if;
  if tg_op = 'UPDATE' and v_old = v_new then
    return new;
  end if;

  insert into public.audit_log (table_name, record_id, pid, action, old_data, new_data, reason)
  values (
    tg_table_name,
    coalesce((v_new ->> 'id'), (v_old ->> 'id'))::uuid,
    coalesce(v_new ->> 'pid', v_old ->> 'pid'),
    lower(tg_op),
    v_old,
    v_new,
    nullif(current_setting('app.reason', true), '')
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger audit_profiles after insert or update or delete on public.profiles
  for each row execute function public.audit_trigger();
create trigger audit_varieties after insert or update or delete on public.varieties
  for each row execute function public.audit_trigger();
create trigger audit_parties after insert or update or delete on public.parties
  for each row execute function public.audit_trigger();
create trigger audit_brokers after insert or update or delete on public.brokers
  for each row execute function public.audit_trigger();
create trigger audit_locations after insert or update or delete on public.locations
  for each row execute function public.audit_trigger();

-- calc_settings uses a text key, so audit it with its own small trigger.
create or replace function public.audit_calc_settings()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.audit_log (table_name, record_id, pid, action, old_data, new_data, reason)
  values ('calc_settings', null, new.key, lower(tg_op),
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new),
          nullif(current_setting('app.reason', true), ''));
  return new;
end;
$$;

create trigger audit_calc_settings after insert or update on public.calc_settings
  for each row execute function public.audit_calc_settings();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.plants enable row level security;
alter table public.profiles enable row level security;
alter table public.varieties enable row level security;
alter table public.parties enable row level security;
alter table public.brokers enable row level security;
alter table public.locations enable row level security;
alter table public.calc_settings enable row level security;
alter table public.audit_log enable row level security;

create policy plants_read on public.plants for select to authenticated using (public.is_active_user());
create policy plants_admin on public.plants for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('admin', 'management'));
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy varieties_read on public.varieties for select to authenticated using (public.is_active_user());
create policy varieties_write on public.varieties for all to authenticated
  using (public.has_role('admin', 'management')) with check (public.has_role('admin', 'management'));

create policy parties_read on public.parties for select to authenticated using (public.is_active_user());
create policy parties_write on public.parties for all to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

create policy brokers_read on public.brokers for select to authenticated using (public.is_active_user());
create policy brokers_write on public.brokers for all to authenticated
  using (public.has_role('admin', 'management', 'commercial'))
  with check (public.has_role('admin', 'management', 'commercial'));

create policy locations_read on public.locations for select to authenticated using (public.is_active_user());
create policy locations_write on public.locations for all to authenticated
  using (public.has_role('admin', 'management')) with check (public.has_role('admin', 'management'));

create policy calc_settings_read on public.calc_settings for select to authenticated using (public.is_active_user());
create policy calc_settings_write on public.calc_settings for update to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

create policy audit_read on public.audit_log for select to authenticated
  using (public.has_role('admin', 'management'));
