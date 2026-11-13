-- Production roles for the paddy-to-rice batch traceability module.
-- Kept in its own migration: new enum values cannot be used in the transaction that adds them.
alter type public.app_role add value if not exists 'production_manager';
alter type public.app_role add value if not exists 'soaking_operator';
alter type public.app_role add value if not exists 'steaming_operator';
alter type public.app_role add value if not exists 'drying_operator';
alter type public.app_role add value if not exists 'milling_operator';
