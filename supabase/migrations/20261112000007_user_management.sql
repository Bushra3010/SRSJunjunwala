-- User management: listing with sign-in info, last-admin protection, audited admin events.

-- List users for Admin → Users (profiles joined with auth sign-in data).
create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  full_name text,
  role public.app_role,
  plant_id uuid,
  active boolean,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  banned_until timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public.require_role('admin', 'management');
  return query
  select p.id, coalesce(p.email, u.email::text), p.full_name, p.role, p.plant_id, p.active, p.created_at,
         u.last_sign_in_at, u.banned_until
  from public.profiles p
  left join auth.users u on u.id = p.id
  order by p.active desc, p.created_at;
end;
$$;

-- Never leave the system without an active administrator.
create or replace function public.profiles_keep_one_admin()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if old.role = 'admin' and old.active
     and (new.role is distinct from 'admin' or not new.active)
     and not exists (select 1 from public.profiles p where p.id <> old.id and p.role = 'admin' and p.active) then
    raise exception 'At least one active administrator is required. Make another user an administrator first.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_keep_one_admin on public.profiles;
create trigger profiles_keep_one_admin before update on public.profiles
  for each row execute function public.profiles_keep_one_admin();

-- Record account events done through the auth admin API (password reset, sign-in blocked/allowed).
create or replace function public.record_user_event(p_user uuid, p_action text, p_reason text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  perform public.require_role('admin');
  if p_action not in ('password_reset', 'access_blocked', 'access_restored', 'user_created') then
    raise exception 'Unknown user event %', p_action;
  end if;
  insert into public.audit_log (table_name, record_id, pid, action, reason)
  values ('auth.users', p_user, (select email from public.profiles where id = p_user), p_action, nullif(btrim(p_reason), ''));
end;
$$;

revoke execute on function public.admin_list_users() from public, anon;
revoke execute on function public.record_user_event(uuid, text, text) from public, anon;
revoke execute on function public.profiles_keep_one_admin() from public, anon, authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.record_user_event(uuid, text, text) to authenticated;
