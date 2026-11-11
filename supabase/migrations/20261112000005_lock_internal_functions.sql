-- Supabase grants EXECUTE on public functions to anon/authenticated by default.
-- Internal helpers must only be reachable through the guarded RPCs that call them.

revoke execute on function public.set_ticket_status(uuid, public.ticket_status) from public, anon, authenticated;
revoke execute on function public.next_pid() from anon;
revoke execute on function public.next_lot_no() from public, anon, authenticated;
revoke execute on function public.audit_trigger() from public, anon, authenticated;
revoke execute on function public.audit_calc_settings() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Nothing in the ERP is readable or callable without signing in.
revoke execute on all functions in schema public from anon;
