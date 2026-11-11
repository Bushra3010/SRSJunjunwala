// Applies all Supabase migrations + seed to an in-memory Postgres (PGlite) with a
// minimal Supabase auth stub, then runs the PRD §14 acceptance scenarios that live
// in the database layer. Usage: npm run db:verify
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const db = new PGlite();

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, last_sign_in_at timestamptz, banned_until timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
`;

const GRANTS = `
  grant usage on schema public to authenticated, anon;
  grant all on all tables in schema public to authenticated;
  grant all on all sequences in schema public to authenticated;
  grant execute on all functions in schema public to authenticated;
  revoke execute on function public.set_ticket_status(uuid, public.ticket_status) from authenticated;
`;

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

async function as(userId, fn) {
  return db.transaction(async (tx) => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return fn(tx);
  });
}

async function expectError(name, userId, fn, pattern) {
  try {
    await as(userId, fn);
    check(name, false, "(expected an error, got success)");
  } catch (e) {
    const ok = pattern ? pattern.test(e.message) : true;
    check(name, ok, ok ? "" : `(got: ${e.message})`);
  }
}

const one = async (tx, sql, params = []) => (await tx.query(sql, params)).rows[0];
const all = async (tx, sql, params = []) => (await tx.query(sql, params)).rows;

async function main() {
  await db.exec(SUPABASE_STUB);
  const dir = join(root, "supabase/migrations");
  for (const f of readdirSync(dir).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
    console.log(`applied ${f}`);
  }
  await db.exec(readFileSync(join(root, "supabase/seed.sql"), "utf8"));
  await db.exec(GRANTS);
  // Test-only fixtures (never loaded into a real database).
  await db.exec(`
    insert into public.locations (plant_id, code, name, kind) values
      ('00000000-0000-0000-0000-000000000001', 'YARD-A', 'Yard A', 'yard'),
      ('00000000-0000-0000-0000-000000000001', 'RAW-B', 'Raw Store B', 'raw_store'),
      ('00000000-0000-0000-0000-000000000001', 'FG-1', 'Finished Goods Store', 'finished_store');
    insert into public.varieties (code, name) values ('PB1121', 'PB 1121'), ('IR64', 'IR 64');
    insert into public.parties (name, kind) values ('Green Leaf Traders', 'supplier'), ('Kaveri Agro', 'supplier'), ('Sunrise Exports', 'customer');
    insert into public.rst_cycles (plant_id, label, starts_on) values ('00000000-0000-0000-0000-000000000001', 'C2026-2', '2026-09-01');
  `);
  console.log("applied seed.sql + test fixtures\n");

  const PLANT = "00000000-0000-0000-0000-000000000001";
  const users = {};
  for (const role of ["admin", "weighbridge_operator", "qc_unloading", "qc_loading", "qc_head", "commercial", "foreman"]) {
    const id = randomUUID();
    users[role] = id;
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${role}@test.local`]);
    await db.query("update public.profiles set role = $2, plant_id = $3 where id = $1", [id, role, PLANT]);
  }
  const ids = {};
  for (const r of (await db.query("select id, code from public.varieties")).rows) ids[r.code] = r.id;
  const loc = (await db.query("select id, code from public.locations")).rows.reduce((a, r) => ({ ...a, [r.code]: r.id }), {});
  const party = (await db.query("select id, name from public.parties")).rows.reduce((a, r) => ({ ...a, [r.name]: r.id }), {});

  console.log("Access control");
  await expectError("unassigned user cannot read varieties", randomUUID(), async (tx) => {
    const rows = await all(tx, "select * from public.varieties");
    if (rows.length === 0) throw new Error("no rows");
  }, /no rows/);
  await as(users.weighbridge_operator, async (tx) => {
    check("weighbridge operator sees no purchase orders", (await all(tx, "select * from public.purchase_orders")).length === 0);
    check("weighbridge operator sees no QC records (party/broker)", (await all(tx, "select * from public.qc_inbound")).length === 0);
  });

  console.log("\nT-01 RST reuse across cycles");
  const t1 = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
             values ($1, 101, 'KA 51 AB 7831', 'inbound', 28540, '2026-10-05 10:00+05:30') returning *`, [PLANT]));
  await as(users.admin, (tx) => tx.query("select public.start_rst_cycle($1, 'C2027-1', '2027-01-15', 'reset')", [PLANT]));
  const t2 = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, tare_kg, weighed_at)
             values ($1, 101, 'TN 37 CZ 4489', 'inbound', 30000, 12000, '2027-01-20 09:00+05:30') returning *`, [PLANT]));
  check("both tickets awaiting QC", t1.status === "awaiting_qc" && t2.status === "awaiting_qc", `${t1.status}/${t2.status}`);
  check("different permanent IDs", t1.pid !== t2.pid);
  check("different RST cycles", t1.cycle_id !== t2.cycle_id);

  console.log("\nT-02 duplicate ticket");
  const dup = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
             values ($1, 101, 'ka51ab7831', 'inbound', 28540, '2026-10-05 10:01+05:30') returning *`, [PLANT]));
  check("flagged as duplicate", dup.status === "duplicate" && dup.duplicate_of === t1.id, dup.status);

  console.log("\nT-03 ambiguous RST in same cycle");
  const amb = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
             values ($1, 101, 'AP 39 DX 1177', 'inbound', 29110, '2026-10-06 10:00+05:30') returning *`, [PLANT]));
  check("routed to exception", amb.status === "exception", amb.status);
  const upd = await as(users.admin, (tx) => tx.query("update public.weighbridge_tickets set rst = 999 where id = $1", [t1.id]));
  check("tickets cannot be edited directly (RLS: 0 rows)", upd.affectedRows === 0, upd.affectedRows);
  await expectError("ticket guard trigger blocks edits even with table access", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("update public.weighbridge_tickets set rst = 999 where id = $1", [t1.id]);
  }, /cannot be edited/);

  console.log("\nInbound QC → PO → stock");
  const po = await as(users.commercial, async (tx) => {
    const p = await one(tx, "insert into public.purchase_orders (plant_id, supplier_id) values ($1, $2) returning *", [PLANT, party["Green Leaf Traders"]]);
    await tx.query("insert into public.po_lines (po_id, line_no, variety_id, ordered_kg) values ($1, 1, $2, 20000), ($1, 2, $3, 10000)", [p.id, ids.PB1121, ids.IR64]);
    return p;
  });
  const poLines = await as(users.commercial, (tx) => all(tx, "select * from public.po_lines where po_id = $1 order by line_no", [po.id]));
  const qcId = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [t1.id]))).id;
  await as(users.qc_unloading, async (tx) => {
    await tx.query("update public.qc_inbound set supplier_id = $2, location_id = $3 where id = $1", [qcId, party["Green Leaf Traders"], loc["YARD-A"]]);
    await tx.query(`insert into public.qc_inbound_lines (qc_id, line_no, variety_id, po_line_id, moisture_pct, sacks_received, rejected_bags)
                    values ($1, 1, $2, $3, 15, 200, 2), ($1, 2, $4, $5, 12, 100, 0)`,
      [qcId, ids.PB1121, poLines[0].id, ids.IR64, poLines[1].id]);
    await tx.query("select public.submit_qc_inbound($1)", [qcId]);
  });
  await expectError("QC operator cannot post", users.qc_unloading, (tx) => tx.query("select public.post_qc_inbound($1)", [qcId]), /PERMISSION_DENIED/);
  await expectError("posting blocked until tare is recorded", users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qcId]), /Weighing is incomplete/);
  await as(users.weighbridge_operator, (tx) => tx.query("select public.complete_weighing($1, null, 12480)", [t1.id]));
  await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qcId]));
  const lines = await as(users.qc_head, (tx) => all(tx, "select * from public.qc_inbound_lines where qc_id = $1 order by line_no", [qcId]));
  // net 16060; line1 = 16060*200/300 = 10706.67; rejected = 107.07; moisture (15-14)% of 10599.60 = 106.00; accepted 10493.60
  check("line 1 accepted kg computed", Number(lines[0].accepted_kg) === 10493.6, lines[0].accepted_kg);
  check("line 2 no moisture deduction", Number(lines[1].moisture_deduction_kg) === 0 && Number(lines[1].accepted_kg) === 5353.33, lines[1].accepted_kg);
  const bal = await as(users.commercial, (tx) => all(tx, "select * from public.po_line_balances where po_id = $1 order by line_no", [po.id]));
  check("PO balance reduced", Number(bal[0].remaining_kg) === 20000 - 10493.6, bal[0].remaining_kg);
  const stock = await as(users.qc_head, (tx) => one(tx, "select sum(on_hand_kg) as kg from public.stock_balances"));
  check("stock receipt posted", Number(stock.kg) === 10493.6 + 5353.33, stock.kg);
  await expectError("posted lines are locked", users.admin,
    (tx) => tx.query("update public.qc_inbound_lines set moisture_pct = 10 where qc_id = $1", [qcId]), /only be changed while/);
  const del = await as(users.admin, (tx) => tx.query("delete from public.stock_movements"));
  check("stock ledger delete blocked by RLS (0 rows)", del.affectedRows === 0, del.affectedRows);
  await expectError("stock ledger trigger blocks delete even with table access", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("delete from public.stock_movements");
  }, /append-only/);

  console.log("\nT-06 correction via reversal");
  await expectError("reversal requires a reason", users.qc_head, (tx) => tx.query("select public.reverse_qc_inbound($1, '')", [qcId]), /reason/);
  await as(users.qc_head, (tx) => tx.query("select public.reverse_qc_inbound($1, 'Wrong moisture reading')", [qcId]));
  const after = await as(users.qc_head, (tx) => one(tx, "select coalesce(sum(on_hand_kg),0) as kg from public.stock_balances"));
  check("stock back to zero", Number(after.kg) === 0, after.kg);
  const orig = await as(users.qc_head, (tx) => one(tx, "select status, reversal_reason from public.qc_inbound where id = $1", [qcId]));
  check("original kept as reversed with reason", orig.status === "reversed" && orig.reversal_reason === "Wrong moisture reading");
  const qc2 = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [t1.id]))).id;
  const copy = await as(users.qc_unloading, (tx) => one(tx, "select amends_id, (select count(*) from public.qc_inbound_lines where qc_id = $1) as n from public.qc_inbound where id = $1", [qc2]));
  check("correction draft links to original and copies lines", copy.amends_id === qcId && Number(copy.n) === 2);
  const audit = await as(users.admin, (tx) => one(tx, "select count(*) as n from public.audit_log where reason = 'Wrong moisture reading'"));
  check("audit log records reason", Number(audit.n) > 0);

  console.log("\nT-04/T-07 multi-variety outbound + over-allocation");
  const so = await as(users.commercial, async (tx) => {
    const s = await one(tx, "insert into public.sales_orders (plant_id, customer_id) values ($1, $2) returning *", [PLANT, party["Sunrise Exports"]]);
    await tx.query("insert into public.so_lines (so_id, line_no, variety_id, ordered_kg) values ($1, 1, $2, 1000), ($1, 2, $3, 5000)", [s.id, ids.PB1121, ids.IR64]);
    return s;
  });
  const soLines = await as(users.commercial, (tx) => all(tx, "select * from public.so_lines where so_id = $1 order by line_no", [so.id]));
  const out = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, tare_kg, weighed_at)
             values ($1, 102, 'HR 38 AE 5567', 'outbound', 12000, '2026-10-07 10:00+05:30') returning *`, [PLANT]));
  const oq = (await as(users.qc_loading, (tx) => one(tx, "select public.start_qc_outbound($1) as id", [out.id]))).id;
  await as(users.qc_loading, async (tx) => {
    await tx.query("update public.qc_outbound set location_id = $2, driver_phone = '9800000000' where id = $1", [oq, loc["FG-1"]]);
    await tx.query(`insert into public.qc_outbound_lines (qc_id, line_no, variety_id, so_line_id, bags, bag_weight_kg)
                    values ($1, 1, $2, $3, 25, 50), ($1, 2, $4, $5, 40, 50)`, [oq, ids.PB1121, soLines[0].id, ids.IR64, soLines[1].id]);
    await tx.query("select public.submit_qc_outbound($1)", [oq]);
  });
  await expectError("over-allocation blocked without approval", users.qc_head, (tx) => tx.query("select public.post_qc_outbound($1)", [oq]), /OVER_ALLOCATION/);
  await as(users.qc_head, (tx) => tx.query("select public.post_qc_outbound($1, 'Customer agreed to extra 250 kg')", [oq]));
  const sob = await as(users.commercial, (tx) => all(tx, "select * from public.so_line_balances where so_id = $1 order by line_no", [so.id]));
  check("SO line 1 dispatched 1250 (approved over)", Number(sob[0].dispatched_kg) === 1250, sob[0].dispatched_kg);
  check("SO line 2 remaining 3000", Number(sob[1].remaining_kg) === 3000, sob[1].remaining_kg);
  const issued = await as(users.qc_head, (tx) => one(tx, "select sum(qty_kg) as kg, count(*) filter (where lot_no is null) as nolot from public.stock_movements where reference_id = $1", [oq]));
  check("dispatch issued 3250 kg from stock ledger", Number(issued.kg) === -3250, issued.kg);

  // Stock shortfall alone (within SO balance) is blocked without approval.
  const out2 = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, tare_kg, weighed_at)
             values ($1, 103, 'KA 01 ZZ 1111', 'outbound', 11000, '2026-10-08 10:00+05:30') returning *`, [PLANT]));
  const oq2 = (await as(users.qc_loading, (tx) => one(tx, "select public.start_qc_outbound($1) as id", [out2.id]))).id;
  await as(users.qc_loading, async (tx) => {
    await tx.query("update public.qc_outbound set location_id = $2, driver_phone = '9800000001' where id = $1", [oq2, loc["RAW-B"]]);
    await tx.query("insert into public.qc_outbound_lines (qc_id, line_no, variety_id, so_line_id, bags, bag_weight_kg) values ($1, 1, $2, $3, 10, 50)", [oq2, ids.IR64, soLines[1].id]);
    await tx.query("select public.submit_qc_outbound($1)", [oq2]);
  });
  await expectError("dispatch beyond confirmed stock blocked without approval", users.qc_head, (tx) => tx.query("select public.post_qc_outbound($1)", [oq2]), /INSUFFICIENT_STOCK/);

  const disp = await as(users.qc_head, (tx) => one(tx, "select dispatch_no, over_allocation_reason from public.qc_outbound where id = $1", [oq]));
  check("dispatch number assigned and approval stored", /^DSP-/.test(disp.dispatch_no) && !!disp.over_allocation_reason);

  console.log("\nT-10 role isolation");
  await as(users.qc_unloading, async (tx) => {
    check("QC operator cannot read stock", (await all(tx, "select * from public.stock_movements")).length === 0);
    check("unloading QC cannot read sales orders", (await all(tx, "select * from public.sales_orders")).length === 0);
    check("unloading QC cannot read outbound QC", (await all(tx, "select * from public.qc_outbound")).length === 0);
  });
  await expectError("QC operator cannot create a PO", users.qc_unloading,
    (tx) => tx.query("insert into public.purchase_orders (plant_id, supplier_id) values ($1, $2)", [PLANT, party["Kaveri Agro"]]), /row-level security/);
  await as(users.foreman, async (tx) => {
    check("foreman cannot read tickets", (await all(tx, "select * from public.weighbridge_tickets")).length === 0);
  });

  console.log("\nAdmin dashboard (live figures)");
  const dash = await as(users.admin, (tx) => one(tx, "select public.admin_dashboard() as d"));
  check("admin dashboard returns figures", dash.d && typeof dash.d.trucks_month === "number" && Array.isArray(dash.d.dispatch_months) && dash.d.dispatch_months.length === 12, JSON.stringify(dash.d).slice(0, 120));
  check("dispatch value counts posted dispatch", Number(dash.d.dispatch_value_year) >= 0);
  await expectError("QC operator cannot read admin dashboard", users.qc_unloading, (tx) => tx.query("select public.admin_dashboard()"), /PERMISSION_DENIED/);

  console.log("\nUser management");
  const list = await as(users.admin, (tx) => all(tx, "select * from public.admin_list_users()"));
  check("admin can list users with sign-in info", list.length >= 7 && "last_sign_in_at" in list[0]);
  await expectError("QC operator cannot list users", users.qc_unloading, (tx) => tx.query("select * from public.admin_list_users()"), /PERMISSION_DENIED/);
  await expectError("last active admin cannot be demoted", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("update public.profiles set role = 'qc_head' where id = $1", [users.admin]);
  }, /active administrator/);
  await as(users.admin, (tx) => tx.query("select public.record_user_event($1, 'password_reset', 'test')", [users.qc_unloading]));
  const ev = await as(users.admin, (tx) => one(tx, "select count(*) as n from public.audit_log where action = 'password_reset'"));
  check("password reset is audited", Number(ev.n) === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message, e.where ?? "");
  process.exit(1);
});
