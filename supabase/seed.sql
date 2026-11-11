-- Minimum setup for a new SRS Overseas database. Contains no sample business data:
-- add varieties, parties, brokers, locations and the first RST cycle from the app
-- (Admin → Masters and Weighbridge → RST cycles).

insert into public.plants (id, code, name) values
  ('00000000-0000-0000-0000-000000000001', 'MAIN', 'Main Plant')
on conflict (code) do nothing;

insert into public.calc_settings (key, value, description) values
  ('moisture_base_pct', 14, 'Moisture % above which a weight deduction applies (placeholder until purchase method is confirmed, PRD D-03)'),
  ('so_over_delivery_tolerance_pct', 0, 'Allowed % above SO line quantity before approval is required (PRD D-04)'),
  ('dispatch_weight_tolerance_pct', 1, 'Allowed % difference between weighbridge net and loaded bags before a warning (PRD QCO-07)'),
  ('truck_wait_alert_minutes', 30, 'Trucks waiting longer than this appear in Needs attention')
on conflict (key) do nothing;
