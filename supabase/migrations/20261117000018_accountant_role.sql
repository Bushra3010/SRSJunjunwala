-- Accounts module (17 Nov 2026): an Accountant role that records payments and exports to Tally.
-- Kept in its own migration: a new enum value cannot be used in the transaction that adds it.
alter type public.app_role add value if not exists 'accountant';
