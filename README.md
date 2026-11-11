# SRS Overseas Factory ERP

Next.js 15 (App Router) + Supabase (Postgres, Auth, RLS). Built from `../PRD_SRS_Overseas_Factory_ERP.md`.

## What's built (PRD Phase 2 core + parts of Phase 3)

| Module | Status | Notes |
|---|---|---|
| Auth & roles | ✅ | Email/password, 9 roles, role-filtered menu, **RLS enforced in the database** |
| Weighbridge | ✅ | Ticket capture (manual), permanent IDs, RST cycles, duplicate/ambiguous detection, exceptions queue, second weighing |
| Quality Control | ✅ | Inbound (multi-variety, moisture, sacks) and outbound (multi-variety loading), draft → submit → post, return, reverse-and-correct |
| Purchase / Sales orders | ✅ | Create, balances from posted QC, pending vs posted receipts/dispatches, close/cancel with reason |
| Inventory | ✅ | Append-only stock ledger, balances by variety/location/lot, estimated milling output kept separate |
| Overview | ✅ | KPIs, vehicle queue, needs-attention list |
| Admin dashboard | ✅ | Live figures from `admin_dashboard()` (admin/management only) |
| Real-time | ✅ | Pages refresh automatically via Supabase Realtime when tickets, QC, orders or stock change |
| Admin | ✅ | Users & roles, masters, calculation settings, audit trail |
| Processing, Stores & Repairs, Reports, Notifications, SMS ingest | ⏳ | Phase 3–4 placeholders |

### Integrity rules (PRD §2.2, §9)
- RST is never a key. Every record has a permanent `PID-xxxxxx`; tickets belong to an **RST cycle**.
- Same RST + cycle + vehicle → `duplicate`. Same RST + cycle, different vehicle → `exception` (a person decides).
- Posting is one database transaction (`post_qc_inbound` / `post_qc_outbound`): QC, order balance and stock move together.
- Posted records can't be edited. Corrections = **reverse** (reason required, reversing stock rows) + a new draft linked by `amends_id`.
- Stock movements are append-only. Every change lands in `audit_log` with user, old/new values and reason.
- Over-allocation against a sales order is blocked unless a QC head/admin gives an approval reason.

### Placeholder calculations — confirm with the client (PRD D-03, D-04)
- **Inbound:** line net = ticket net × line sacks ÷ total sacks; rejected = net × (rejected + returned) ÷ sacks; moisture deduction = (net − rejected) × max(0, moisture − base%) ÷ 100. Base% is in Admin → Calculation settings.
- **Outbound:** quantity = bags × bag weight.

## Run locally

```bash
cp .env.example .env.local   # fill in Supabase URL + keys (or `vercel env pull .env.local`)
npm run dev
```

Without Supabase settings, the app shows a setup screen.

### Database
Migrations are in `supabase/migrations`, and starter masters are in `supabase/seed.sql`. Apply them in order to the Supabase project, either with the SQL editor or with `npx supabase db push --db-url "$POSTGRES_URL_NON_POOLING"` followed by running `seed.sql`.

Test the database logic without Supabase (in-memory Postgres via PGlite):

```bash
npm run db:verify
```

This runs the PRD §14 scenarios: RST reuse across cycles, duplicate SMS, ambiguous RST, multi-variety posting, reversal, over-allocation and role isolation.

### First admin

```bash
npm run user:create -- you@company.com admin "Your Name"
```

After that, an admin can add users from **Admin → Users & roles**. That needs `SUPABASE_SERVICE_ROLE_KEY` on the server.

## Roles

`admin`, `management`, `weighbridge_operator`, `qc_unloading`, `qc_loading`, `qc_head`, `foreman`, `store_custodian`, `commercial`. See `src/lib/roles.ts` for the menu and the RLS policies in the migrations for data access.

## Starting from an empty database

`supabase/seed.sql` only creates the plant and calculation settings. Before capturing the first ticket, an admin should:

1. **Weighbridge → RST cycles**: start the current RST cycle.
2. **Admin → Masters**: add varieties, suppliers/customers, brokers and locations.
3. **Admin → Users & roles**: add staff accounts.
