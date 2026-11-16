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
  revoke execute on function public.next_batch_no(public.production_stage) from authenticated;
  revoke execute on function public.refresh_batch_status(uuid) from authenticated;
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

  // =========================================================================
  console.log("\nProduction traceability — factory scenarios");
  for (const role of ["production_manager", "soaking_operator", "steaming_operator", "drying_operator", "milling_operator", "management"]) {
    const id = randomUUID();
    users[role] = id;
    await db.query("insert into auth.users (id, email) values ($1, $2)", [id, `${role}@test.local`]);
    await db.query("update public.profiles set role = $2, plant_id = $3 where id = $1", [id, role, PLANT]);
  }
  const eq = (await db.query("select id, code from public.production_equipment")).rows.reduce((a, r) => ({ ...a, [r.code]: r.id }), {});
  const grade = (await db.query("select id, code from public.rice_grades")).rows.reduce((a, r) => ({ ...a, [r.code]: r.id }), {});
  check("equipment seeded: 6 tanks, steamer, 3 dryers, mill line", ["TANK-1", "TANK-6", "STEAMER", "DRYER-3", "MILL-1"].every((c) => eq[c]));
  check("7 reference grades seeded", ["WAND1", "WAND2", "TIBAAR", "DUBAAR", "BROKEN", "REJECTION", "RESORT"].every((c) => grade[c]));
  const start = (who, stage, equip, inputs, extra = {}) =>
    as(users[who], (tx) => one(tx, "select public.start_production_batch($1, $2, $3::jsonb, $4, $5, $6, $7) as id",
      [stage, equip ?? null, JSON.stringify(inputs), extra.at ?? null, extra.request ?? null, null, extra.auth ?? null])).then((r) => r.id);
  const batch = (id) => one(db, "select * from public.production_batches where id = $1", [id]);

  // Scenario 1: one truck with 160 quintals.
  const truck = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
             values ($1, 201, 'PB 10 GH 2020', 'inbound', 28000, '2026-10-10 08:00+05:30') returning *`, [PLANT]));
  await as(users.weighbridge_operator, (tx) => tx.query("select public.complete_weighing($1, null, 12000)", [truck.id]));
  const tq = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [truck.id]))).id;
  await as(users.qc_unloading, async (tx) => {
    await tx.query("update public.qc_inbound set supplier_id = $2, location_id = $3 where id = $1", [tq, party["Green Leaf Traders"], loc["YARD-A"]]);
    await tx.query(`insert into public.qc_inbound_lines (qc_id, line_no, variety_id, moisture_pct, sacks_received) values ($1, 1, $2, 14, 320)`, [tq, ids.PB1121]);
    await tx.query("select public.submit_qc_inbound($1)", [tq]);
  });
  await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [tq]));
  const qline = await one(db, "select * from public.qc_inbound_lines where qc_id = $1", [tq]);
  await expectError("milling operator cannot create a truck receipt", users.milling_operator,
    (tx) => tx.query("select public.create_receipt_batch($1)", [qline.id]), /PERMISSION_DENIED/);
  const reqR = randomUUID();
  const rcv = (await as(users.qc_head, (tx) => one(tx, "select public.create_receipt_batch($1, $2) as id", [qline.id, reqR]))).id;
  const rcvRetry = (await as(users.qc_head, (tx) => one(tx, "select public.create_receipt_batch($1, $2) as id", [qline.id, reqR]))).id;
  const R = await batch(rcv);
  const yr = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 4);
  check("S1 truck receipt RCV ID generated", R.batch_no === `RCV-${yr}-00001`, R.batch_no);
  check("S1 receipt = 160 q with RST, vehicle and supplier frozen", Number(R.input_kg) === 16000 && R.source_snapshot.rst === 201 && R.source_snapshot.vehicle_no === "PB 10 GH 2020" && R.source_snapshot.supplier === "Green Leaf Traders", JSON.stringify(R.source_snapshot).slice(0, 90));
  check("retry with same request ID returns the same batch (safe retry)", rcvRetry === rcv);
  await expectError("same truck cannot be received twice", users.qc_head,
    (tx) => tx.query("select public.create_receipt_batch($1)", [qline.id]), /DUPLICATE_CONSUMPTION/);
  await expectError("QC in production cannot be reversed", users.qc_head,
    (tx) => tx.query("select public.reverse_qc_inbound($1, 'test')", [tq]), /in production/);
  const recv = await as(users.production_manager, (tx) => all(tx, "select * from public.production_receivable_lines()"));
  check("received truck no longer listed as waiting for production", !recv.some((r) => r.qc_line_id === qline.id));
  const yardLot = await one(db, "select sum(qty_kg) as kg from public.stock_movements where lot_no = $1", [qline.lot_no]);
  check("paddy issued from yard stock into production", Number(yardLot.kg) === 0, yardLot.kg);

  // Pre-cleaning
  const pc = await start("soaking_operator", "precleaning", eq["PRECLEAN-1"], [{ batch_id: rcv, qty_kg: 16000 }], { at: "2026-10-10 09:00+05:30" });
  await expectError("pre-cleaning output is mandatory", users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1)", [pc]), /output quantity/);
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, 15900, 50, null, '2026-10-10 10:00+05:30')", [pc]));
  const PC = await batch(pc);
  check("pre-cleaning loss computed (15900 out, 50 rejected, 50 loss)", Number(PC.loss_kg) === 50 && PC.batch_no.startsWith("PC-"), PC.loss_kg);

  // Scenario 2: 80 q into Tank 1 and 80 q (79.5) into Tank 2.
  const s1 = await start("soaking_operator", "soaking", eq["TANK-1"], [{ batch_id: pc, qty_kg: 7950 }], { at: "2026-10-10 10:30+05:30" });
  await expectError("a loaded tank cannot take another batch", users.soaking_operator,
    (tx) => tx.query("select public.start_production_batch('soaking', $1, $2::jsonb)", [eq["TANK-1"], JSON.stringify([{ batch_id: pc, qty_kg: 10 }])]), /EQUIPMENT_BUSY/);
  await expectError("allocation beyond available quantity is blocked", users.soaking_operator,
    (tx) => tx.query("select public.start_production_batch('soaking', $1, $2::jsonb)", [eq["TANK-2"], JSON.stringify([{ batch_id: pc, qty_kg: 8000 }])]), /OVER_ALLOCATION/);
  const reqS = randomUUID();
  const s2 = await start("soaking_operator", "soaking", eq["TANK-2"], [{ batch_id: pc, qty_kg: 7950 }], { at: "2026-10-10 10:40+05:30", request: reqS });
  const s2retry = await start("soaking_operator", "soaking", eq["TANK-2"], [{ batch_id: pc, qty_kg: 7950 }], { request: reqS });
  check("S2 one truck split across Tank 1 and Tank 2", (await batch(s1)).pair_no === 1 && Number((await batch(s2)).input_kg) === 7950);
  check("retried tank allocation is not doubled", s2retry === s2 && (await batch(pc)).status === "consumed");
  await expectError("fully used batch cannot be consumed again", users.soaking_operator,
    (tx) => tx.query("select public.start_production_batch('soaking', $1, $2::jsonb)", [eq["TANK-3"], JSON.stringify([{ batch_id: pc, qty_kg: 1 }])]), /DUPLICATE_CONSUMPTION/);

  // Scenario 3: soaking completes.
  await expectError("steaming blocked until both tanks finish soaking", users.steaming_operator,
    (tx) => tx.query("select public.start_production_batch('steaming', $1, $2::jsonb)", [eq.STEAMER, JSON.stringify([{ batch_id: s1 }, { batch_id: s2 }])]), /INCOMPLETE_BATCH/);
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-10 22:30+05:30')", [s1]));
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, 8100, 0, null, '2026-10-10 22:40+05:30')", [s2]));
  const S1 = await batch(s1);
  check("S3 unweighed soaking output carried as ESTIMATE, weighed one as ENTERED", S1.output_qty_status === "estimated" && (await batch(s2)).output_qty_status === "entered");
  check("soaking duration recorded (12 h)", Number(S1.duration_minutes) === 720, S1.duration_minutes);

  // Scenario 4: pair steaming.
  await expectError("drying operator cannot run the steamer", users.drying_operator,
    (tx) => tx.query("select public.start_production_batch('steaming', $1, $2::jsonb)", [eq.STEAMER, JSON.stringify([{ batch_id: s1 }, { batch_id: s2 }])]), /PERMISSION_DENIED/);
  const stm = await start("steaming_operator", "steaming", eq.STEAMER, [{ batch_id: s1 }, { batch_id: s2 }], { at: "2026-10-10 23:00+05:30" });
  const STM = await batch(stm);
  check("S4 steaming lot combines Tank 1 + Tank 2 (7950 + 8100 kg)", STM.pair_no === 1 && Number(STM.input_kg) === 16050 && STM.batch_no.startsWith("LOT-"), STM.input_kg);
  await expectError("common steamer runs one batch at a time", users.steaming_operator,
    (tx) => tx.query("select public.start_production_batch('steaming', $1, $2::jsonb)", [eq.STEAMER, JSON.stringify([{ batch_id: s1 }, { batch_id: s2 }])]), /BUSY/);
  await as(users.steaming_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-11 00:00+05:30')", [stm]));

  // Scenario 5: dryer 1 only.
  const dry = await start("drying_operator", "drying", eq["DRYER-1"], [{ batch_id: stm }], { at: "2026-10-11 00:15+05:30" });
  await as(users.drying_operator, (tx) => tx.query("select public.complete_production_batch($1, 14000, 0, 13.5, '2026-10-11 13:15+05:30')", [dry]));
  const DRY = await batch(dry);
  check("S5 Dryer 1 batch: 16050 in, 14000 out, moisture 13.5%, 13 h", Number(DRY.loss_kg) === 2050 && Number(DRY.moisture_pct) === 13.5 && Number(DRY.duration_minutes) === 780);

  // Mill feed (two partial transfers).
  const mf1 = await start("drying_operator", "mill_feed", eq["MFT-1"], [{ batch_id: dry, qty_kg: 9000 }], { at: "2026-10-11 13:30+05:30" });
  await expectError("partial transfer cannot exceed what is left", users.drying_operator,
    (tx) => tx.query("select public.start_production_batch('mill_feed', $1, $2::jsonb)", [eq["MFT-2"], JSON.stringify([{ batch_id: dry, qty_kg: 5001 }])]), /OVER_ALLOCATION/);
  const mf2 = await start("drying_operator", "mill_feed", eq["MFT-2"], [{ batch_id: dry, qty_kg: 5000 }], { at: "2026-10-11 13:40+05:30" });
  check("partial mill-feed transfers keep lineage; dryer emptied", (await batch(dry)).status === "consumed" && (await batch(mf1)).status === "completed");

  // Scenario 6: milling.
  await expectError("milling two feed lots needs authorisation", users.milling_operator,
    (tx) => tx.query("select public.start_production_batch('milling', $1, $2::jsonb)", [eq["MILL-1"], JSON.stringify([{ batch_id: mf1, qty_kg: 9000 }, { batch_id: mf2, qty_kg: 5000 }])]), /MULTI_INPUT/);
  await expectError("operator cannot self-authorise", users.milling_operator,
    (tx) => tx.query("select public.start_production_batch('milling', $1, $2::jsonb, null, null, null, 'same lot')", [eq["MILL-1"], JSON.stringify([{ batch_id: mf1, qty_kg: 9000 }, { batch_id: mf2, qty_kg: 5000 }])]), /MULTI_INPUT/);
  const mil = await start("production_manager", "milling", eq["MILL-1"], [{ batch_id: mf1, qty_kg: 9000 }, { batch_id: mf2, qty_kg: 5000 }],
    { at: "2026-10-11 14:00+05:30", auth: "Both feeds are from Dryer 1 batch" });
  await expectError("milling steps must run in order", users.milling_operator,
    (tx) => tx.query("select public.record_milling_step($1, 'dehusking', 'start', '2026-10-11 14:10+05:30')", [mil]), /previous step/);
  let t = Date.parse("2026-10-11T14:00:00+05:30");
  for (const step of ["cleaning", "dehusking", "whitener", "silky", "sortex", "grading"]) {
    await as(users.milling_operator, (tx) => tx.query("select public.record_milling_step($1, $2, 'start', $3)", [mil, step, new Date((t += 5 * 60000)).toISOString()]));
    await as(users.milling_operator, (tx) => tx.query("select public.record_milling_step($1, $2, 'end', $3)", [mil, step, new Date((t += 40 * 60000)).toISOString()]));
  }
  await expectError("outputs blocked until milling is complete", users.milling_operator,
    (tx) => tx.query("select public.record_production_output($1, $2, 100)", [mil, grade.WAND1]), /INCOMPLETE_BATCH/);
  await as(users.milling_operator, (tx) => tx.query("select public.complete_production_batch($1, 9500, 0, null, '2026-10-11 19:00+05:30')", [mil]));
  const steps = await one(db, "select count(*) filter (where ended_at is not null) as n from public.milling_stage_events where batch_id = $1", [mil]);
  check("S6 milling: 6 timed steps, 14000 in, 9500 out", Number(steps.n) === 6 && Number((await batch(mil)).loss_kg) === 4500);

  // Scenario 7: several grades.
  const outs = {};
  for (const [g, kg] of [["WAND1", 4200], ["WAND2", 1400], ["TIBAAR", 1120], ["DUBAAR", 280], ["BROKEN", 1400], ["REJECTION", 560], ["RESORT", 140]]) {
    outs[g] = (await as(users.milling_operator, (tx) => one(tx, "select public.record_production_output($1, $2, $3, '2026-10-11 19:30+05:30') as id", [mil, grade[g], kg]))).id;
  }
  const O = await batch(outs.WAND1);
  check("S7 seven grade outputs with own OUT IDs", Object.keys(outs).length === 7 && O.batch_no.startsWith("OUT-") && O.output_qty_status === "entered");
  await expectError("outputs cannot exceed milling output", users.milling_operator,
    (tx) => tx.query("select public.record_production_output($1, $2, 401)", [mil, grade.BROKEN]), /OVER_ALLOCATION/);

  // Scenario 8: trace back from a final output.
  const anc = await as(users.management, (tx) => all(tx,
    `select b.batch_no, b.stage, eq.number as unit, b.started_at, b.ended_at, a.qty_kg, b.source_snapshot
       from public.trace_ancestors($1) a join public.production_batches b on b.id = a.batch_id
       left join public.production_equipment eq on eq.id = b.equipment_id`, [outs.WAND1]));
  const st = (s) => [...new Map(anc.filter((a) => a.stage === s).map((a) => [a.batch_no, a])).values()];
  const rec = st("receipt")[0];
  check("S8 output → original truck, RST and vehicle", rec?.batch_no === R.batch_no && rec.source_snapshot.rst === 201 && rec.source_snapshot.vehicle_no === "PB 10 GH 2020");
  check("S8 output → both soaking tanks (1 and 2) with times", st("soaking").map((a) => a.unit).sort().join() === "1,2" && st("soaking").every((a) => a.started_at && a.ended_at));
  check("S8 output → steaming, dryer, mill feeds, milling, pre-cleaning", st("steaming").length === 1 && st("drying")[0]?.unit === 1 && st("mill_feed").length === 2 && st("milling").length === 1 && st("precleaning").length === 1);
  const desc = await as(users.management, (tx) => all(tx, "select distinct b.id, b.stage from public.trace_descendants($1) d join public.production_batches b on b.id = d.batch_id", [rcv]));
  check("forward trace: truck → 7 rice outputs", desc.filter((d) => d.stage === "output").length === 7);
  const tl = await as(users.management, (tx) => all(tx, "select * from public.trace_timeline($1)", [outs.WAND1]));
  const types = tl.map((e) => `${e.stage}:${e.event_type}`);
  const sorted = tl.every((e, i) => i === 0 || new Date(tl[i - 1].at) <= new Date(e.at));
  check("timeline is chronological with user and quantity", sorted && tl.length > 30 && tl.some((e) => e.user_name) && ["receipt:received", "soaking:started", "steaming:completed", "drying:completed", "milling:grading_completed", "output:output_recorded"].every((x) => types.includes(x)));
  const found = await as(users.management, (tx) => all(tx, "select batch_no from public.find_production_batches('201')"));
  check("search by RST finds the truck receipt", found.some((f) => f.batch_no === R.batch_no));
  const foundV = await as(users.management, (tx) => all(tx, "select batch_no from public.find_production_batches('pb10gh2020')"));
  check("search by vehicle number (any spacing) finds the receipt", foundV.length === 1);

  // Edge cases
  await expectError("management is read-only", users.management,
    (tx) => tx.query("select public.start_production_batch('soaking', $1, $2::jsonb)", [eq["TANK-3"], JSON.stringify([{ batch_id: pc, qty_kg: 1 }])]), /PERMISSION_DENIED/);
  await as(users.commercial, async (tx) => check("commercial cannot see production", (await all(tx, "select * from public.production_batches")).length === 0));
  await expectError("production rows cannot be edited directly", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("update public.production_batches set output_kg = 1 where id = $1", [dry]);
  }, /production actions/);
  await expectError("production rows cannot be deleted", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("delete from public.production_batches where id = $1", [outs.RESORT]);
  }, /cannot be deleted/);
  await expectError("cannot cancel a batch whose material moved on", users.production_manager,
    (tx) => tx.query("select public.cancel_production_batch($1, 'test')", [pc]), /next-stage batch/);
  await expectError("operator cannot cancel", users.milling_operator,
    (tx) => tx.query("select public.cancel_production_batch($1, 'test')", [outs.RESORT]), /PERMISSION_DENIED/);
  await as(users.production_manager, (tx) => tx.query("select public.cancel_production_batch($1, 'Weighed twice')", [outs.RESORT]));
  const resortNo = (await batch(outs.RESORT)).batch_no;
  const cancelled = await as(users.management, (tx) => all(tx, "select status from public.find_production_batches($1)", [resortNo]));
  check("cancelled output stays searchable; milling quantity released", cancelled[0]?.status === "cancelled" && Number((await one(db, "select public.batch_available_kg($1) as kg", [mil])).kg) === 540);
  await expectError("correction cannot go below quantity already used", users.production_manager,
    (tx) => tx.query("select public.correct_batch_quantity($1, 'output_kg', 13000, 'recount')", [dry]), /already passed/);
  await expectError("correction needs a reason", users.production_manager,
    (tx) => tx.query("select public.correct_batch_quantity($1, 'output_kg', 9600, '')", [mil]), /reason/);
  await as(users.production_manager, (tx) => tx.query("select public.correct_batch_quantity($1, 'output_kg', 9600, 'Scale recalibrated')", [mil]));
  const corr = await one(db, "select data from public.batch_events where batch_id = $1 and event_type = 'corrected'", [mil]);
  const aud = await one(db, "select count(*) as n from public.audit_log where table_name = 'production_batches' and reason = 'Scale recalibrated'");
  check("authorised correction keeps the original value and audit", Number(corr.data.old) === 9500 && Number(corr.data.new) === 9600 && Number(aud.n) === 1);
  await as(users.qc_head, (tx) => tx.query("select public.set_batch_quality($1, null, 'passed', 'Visual OK')", [outs.WAND1]));
  await as(users.production_manager, (tx) => tx.query("select public.confirm_production_output($1, $2)", [outs.WAND1, loc["FG-1"]]));
  const fg = await one(db, "select sum(qty_kg) as kg from public.stock_movements where lot_no = $1 and movement_type = 'production_receipt'", [O.batch_no]);
  check("confirmed output enters finished-goods stock under its OUT ID", Number(fg.kg) === 4200 && (await batch(outs.WAND1)).output_qty_status === "confirmed");
  const fault = (await as(users.milling_operator, (tx) => one(tx, "select public.report_production_fault($1, $2, 'high', 'Sortex ejector jammed', '2026-10-11 16:00+05:30') as id", [eq["MILL-1"], mil]))).id;
  await as(users.milling_operator, (tx) => tx.query("select public.resolve_production_fault($1, 'Cleaned ejector', '2026-10-11 16:25+05:30')", [fault]));
  const f = await one(db, "select downtime_minutes from public.production_faults where id = $1", [fault]);
  check("fault downtime recorded (25 min)", Number(f.downtime_minutes) === 25);
  // ID generation: 200 IDs across stages are unique and well-formed.
  const gen = await all(db, "select public.next_batch_no('drying') as n from generate_series(1, 200)");
  check("batch IDs unique, sequential and formatted", new Set(gen.map((g) => g.n)).size === 200 && gen.every((g) => /^DRY-\d{4}-\d{5}$/.test(g.n)));
  const ledger = await one(db, "select count(*) as n from public.batch_quantity_ledger");
  await expectError("quantity ledger is append-only", null, async (tx) => {
    await tx.query("reset role");
    await tx.query("delete from public.batch_quantity_ledger");
  }, /append-only/);
  check("quantity ledger has entries for every movement", Number(ledger.n) > 30);


  // ---- Client flow (14 Nov): truck straight into tanks, pair lot steams into its dryer ----
  console.log("\nClient flow: trucks to tanks, pair lots, 3 feed tanks");
  check("three mill feed tanks", !!eq["MFT-3"] || !!(await one(db, "select id from public.production_equipment where code = 'MFT-3'")));
  const newTruck = async (rst, vehicle, variety = ids.IR64) => {
    const tk = await as(users.weighbridge_operator, (tx) =>
      one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
               values ($1, $2, $3, 'inbound', 28000, '2026-10-12 08:00+05:30') returning *`, [PLANT, rst, vehicle]));
    await as(users.weighbridge_operator, (tx) => tx.query("select public.complete_weighing($1, null, 12000)", [tk.id]));
    const qid = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [tk.id]))).id;
    await as(users.qc_unloading, async (tx) => {
      await tx.query("update public.qc_inbound set supplier_id = $2, location_id = $3 where id = $1", [qid, party["Kaveri Agro"], loc["YARD-A"]]);
      await tx.query("insert into public.qc_inbound_lines (qc_id, line_no, variety_id, moisture_pct, sacks_received) values ($1, 1, $2, 14, 320)", [qid, variety]);
      await tx.query("select public.submit_qc_inbound($1)", [qid]);
    });
    await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qid]));
    return (await one(db, "select id from public.qc_inbound_lines where qc_id = $1", [qid])).id;
  };
  const line2 = await newTruck(301, "HR 55 AA 3010");
  const waiting = await as(users.soaking_operator, (tx) => all(tx, "select qc_line_id from public.production_receivable_lines()"));
  check("soaking operator sees trucks waiting for a tank", waiting.some((w) => w.qc_line_id === line2));
  const soakFromTruck = (tank, lineId, kg, at, req = null) =>
    as(users.soaking_operator, (tx) => one(tx, "select public.start_soaking_from_trucks($1, $2::jsonb, $3, $4) as id",
      [eq[tank], JSON.stringify([{ qc_line_id: lineId, qty_kg: kg }]), at, req])).then((r) => r.id);
  const reqT = randomUUID();
  const t3 = await soakFromTruck("TANK-3", line2, 8000, "2026-10-12 09:00+05:30", reqT);
  const t3retry = await soakFromTruck("TANK-3", line2, 8000, "2026-10-12 09:00+05:30", reqT);
  const t4 = await soakFromTruck("TANK-4", line2, 8000, "2026-10-12 09:10+05:30");
  const rcv2 = await one(db, "select b.id, b.batch_no, b.status from public.production_batches b where b.source_qc_line_id = $1", [line2]);
  check("truck loaded straight into Tanks 3 and 4 (receipt created automatically, once)", !!rcv2 && rcv2.status === "consumed" && t3retry === t3
    && Number((await one(db, "select count(*) as n from public.production_batches where source_qc_line_id = $1", [line2])).n) === 1);
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-12 21:00+05:30')", [t3]));
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-12 21:10+05:30')", [t4]));
  const lot = await start("steaming_operator", "steaming", eq.STEAMER, [{ batch_id: t3 }, { batch_id: t4 }], { at: "2026-10-12 21:30+05:30" });
  const LOT = await batch(lot);
  check("tank pair 3+4 becomes one LOT", /^LOT-\d{4}-\d{5}$/.test(LOT.batch_no) && LOT.pair_no === 2, LOT.batch_no);
  const d2 = (await as(users.steaming_operator, (tx) => one(tx, "select public.finish_steaming_to_dryer($1, '2026-10-12 23:30+05:30') as id", [lot]))).id;
  const d2retry = (await as(users.steaming_operator, (tx) => one(tx, "select public.finish_steaming_to_dryer($1) as id", [lot]))).id;
  const D2 = await batch(d2);
  check("finishing steaming loads Dryer 2 in the same step (safe to retry)", D2.stage === "drying" && D2.equipment_id === eq["DRYER-2"] && D2.status === "running" && d2retry === d2 && (await batch(lot)).status === "consumed");
  const line3 = await newTruck(302, "HR 55 AA 3020");
  const t3b = await soakFromTruck("TANK-3", line3, 8000, "2026-10-13 09:00+05:30");
  const t4b = await soakFromTruck("TANK-4", line3, 8000, "2026-10-13 09:10+05:30");
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-13 21:00+05:30')", [t3b]));
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-13 21:10+05:30')", [t4b]));
  await expectError("next lot cannot steam into a dryer that is still full", users.steaming_operator,
    (tx) => tx.query("select public.start_steaming_lot($1::uuid[], $2)", [[t3b, t4b], eq["DRYER-2"]]), /DRYER_BUSY/);
  const anc2 = await as(users.management, (tx) => all(tx, "select distinct b.stage, b.batch_no from public.trace_ancestors($1) a join public.production_batches b on b.id = a.batch_id", [d2]));
  check("dryer batch still traces to its truck without pre-cleaning", anc2.some((a) => a.batch_no === rcv2.batch_no) && !anc2.some((a) => a.stage === "precleaning") && anc2.filter((a) => a.stage === "soaking").length === 2);


  // Rounding leftovers (< 1 kg) count as used up.
  const line4 = await newTruck(303, "HR 55 AA 3030");
  const t5 = await as(users.soaking_operator, (tx) => one(tx, "select public.start_soaking_from_trucks($1, $2::jsonb, '2026-10-14 09:00+05:30') as id",
    [eq["TANK-5"], JSON.stringify([{ qc_line_id: line4, qty_kg: 15999.85 }])])).then((r) => r.id);
  const r4 = await one(db, "select status from public.production_batches where source_qc_line_id = $1", [line4]);
  check("a truck with only grams left counts as fully loaded", r4.status === "consumed" && !!t5, r4.status);


  // Flexible dryers (client, 14 Nov): any tanks, any free dryer.
  await as(users.soaking_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-14 21:00+05:30')", [t5]));
  const lone = (await as(users.steaming_operator, (tx) => one(tx, "select public.start_steaming_lot($1::uuid[], $2, '2026-10-14 21:30+05:30') as id", [[t5], eq["DRYER-1"]]))).id;
  const LONE = await batch(lone);
  check("a single tank (Tank 5) can be steamed as its own lot", LONE.batch_no.startsWith("LOT-") && LONE.pair_no === null && LONE.target_dryer_id === eq["DRYER-1"]);
  await expectError("a dryer promised to a steaming lot can't be given to another", users.steaming_operator,
    (tx) => tx.query("select public.start_steaming_lot($1::uuid[], $2)", [[t3b, t4b], eq["DRYER-1"]]), /DRYER_BUSY|BUSY/);
  const d1 = (await as(users.steaming_operator, (tx) => one(tx, "select public.finish_steaming_to_dryer($1, '2026-10-14 22:30+05:30') as id", [lone]))).id;
  check("Tank 5 lot goes into Dryer 1 (no fixed pairing)", (await batch(d1)).equipment_id === eq["DRYER-1"]);
  const mixLot = (await as(users.steaming_operator, (tx) => one(tx, "select public.start_steaming_lot($1::uuid[], $2, '2026-10-14 22:45+05:30') as id", [[t3b, t4b], eq["DRYER-3"]]))).id;
  check("Tanks 3 + 4 can go to Dryer 3 when Dryer 2 is full", (await batch(mixLot)).target_dryer_id === eq["DRYER-3"]);
  const dryerNames = await all(db, "select name from public.production_equipment where kind = 'dryer' order by number");
  check("dryers are named without fixed tanks", dryerNames.map((d) => d.name).join() === "Dryer 1,Dryer 2,Dryer 3");
  await db.query("update public.varieties set std_tank_kg = 16500 where code = 'IR64'");
  const line5 = await newTruck(304, "HR 55 AA 3040");
  const std = await as(users.soaking_operator, (tx) => one(tx, "select std_tank_kg from public.production_receivable_lines() where qc_line_id = $1", [line5]));
  check("standard weight per tank comes with the waiting truck", Number(std.std_tank_kg) === 16500);


  // One-click soaking from the unloaded total (client, 14 Nov, third round).
  console.log("\nSoaking from the unloaded total (standard weight per tank)");
  const waitingKg = async (code) => {
    const rows = await as(users.soaking_operator, (tx) => all(tx, "select s.waiting_kg from public.unloaded_paddy_summary() s join public.varieties v on v.id = s.variety_id where v.code = $1", [code]));
    return Number(rows[0]?.waiting_kg ?? 0);
  };
  const w0 = await waitingKg("IR64");
  const soakStd = (tank, code, at) => as(users.soaking_operator, async (tx) => {
    const vId = (await one(tx, "select id from public.varieties where code = $1", [code])).id;
    return (await one(tx, "select public.start_soaking_standard($1, $2, $3) as id", [eq[tank], vId, at])).id;
  });
  const tPart = await soakStd("TANK-6", "IR64", "2026-10-15 09:00+05:30");
  const PART = await batch(tPart);
  check("unloaded total shown per variety", w0 >= 16000, w0);
  check("start soaking takes what is waiting when less than a full tank (part tank noted)", Number(PART.input_kg) === w0 && /Part tank/.test(PART.remarks ?? ""), `${PART.input_kg} ${PART.remarks}`);
  check("unloaded total goes down to zero", (await waitingKg("IR64")) === 0);
  const lineA = await newTruck(305, "HR 55 AA 3050");
  const lineB = await newTruck(306, "HR 55 AA 3060");
  check("two more trucks add to the total", (await waitingKg("IR64")) === 32000);
  const tFull = await soakStd("TANK-1", "IR64", "2026-10-15 10:00+05:30");
  const FULL = await batch(tFull);
  const fromTrucks = await all(db, "select p.source_qc_line_id, i.qty_kg from public.batch_inputs i join public.production_batches p on p.id = i.parent_id where i.child_id = $1 order by i.qty_kg desc", [tFull]);
  check("one click fills a tank with the standard 165 q, oldest truck first", Number(FULL.input_kg) === 16500 && fromTrucks.length === 2
    && fromTrucks[0].source_qc_line_id === lineA && Number(fromTrucks[0].qty_kg) === 16000 && Number(fromTrucks[1].qty_kg) === 500, JSON.stringify(fromTrucks));
  check("unloaded total is reduced by exactly one tank (320 q - 165 q = 155 q)", (await waitingKg("IR64")) === 15500);
  const tRest = await soakStd("TANK-2", "IR64", "2026-10-15 10:30+05:30");
  check("next tank continues from the part-used truck", Number((await batch(tRest)).input_kg) === 15500 && (await waitingKg("IR64")) === 0 && !!lineB);
  await expectError("no standard weight set: clear message", users.soaking_operator, async (tx) => {
    const vId = (await one(tx, "select id from public.varieties where code = 'PB1121'")).id;
    await tx.query("select public.start_soaking_standard($1, $2)", [eq["TANK-6"], vId]);
  }, /NO_STANDARD_WEIGHT/);
  await db.query("update public.varieties set std_tank_kg = 16000 where code = 'PB1121'");
  await expectError("nothing unloaded for that variety: clear message", users.soaking_operator, async (tx) => {
    const vId = (await one(tx, "select id from public.varieties where code = 'PB1121'")).id;
    await tx.query("select public.start_soaking_standard($1, $2)", [eq["TANK-4"], vId]);
  }, /NOTHING_UNLOADED|EQUIPMENT_BUSY/);
  await expectError("milling operator cannot start soaking", users.milling_operator, async (tx) => {
    const vId = (await one(tx, "select id from public.varieties where code = 'IR64'")).id;
    await tx.query("select public.start_soaking_standard($1, $2)", [eq["TANK-4"], vId]);
  }, /PERMISSION_DENIED/);


  // Soaking stop -> dryer filling -> dryer start/stop -> own feed tank -> milling by dryer (client, 4th round).
  console.log("\nSoaking stop, dryer start/stop, feed tanks, milling by dryer");
  const stopDryer = (id, moist, at) => as(users.drying_operator, (tx) => one(tx, "select public.stop_dryer($1, $2, null, $3) as id", [id, moist, at])).then((r) => r.id);
  await expectError("dryer stop needs the unload moisture", users.drying_operator, (tx) => tx.query("select public.stop_dryer($1, null)", [d1]), /moisture/);
  const feed1 = await stopDryer(d1, 13.2, "2026-10-15 11:00+05:30");
  const FEED1 = await batch(feed1);
  check("dryer stop records moisture and unloads into its own feed tank (Dryer 1 -> Feed tank 1)",
    FEED1.stage === "mill_feed" && FEED1.equipment_id === eq["MFT-1"] && Number((await batch(d1)).moisture_pct) === 13.2 && (await batch(d1)).status === "consumed");
  const stopSoak = (id, dryer, at) => as(users.soaking_operator, (tx) => one(tx, "select public.stop_soaking_to_dryer($1, $2, $3) as id", [id, eq[dryer], at])).then((r) => r.id);
  // Finish the lot still steaming from the old flow (it goes into Dryer 3).
  await as(users.steaming_operator, (tx) => tx.query("select public.finish_steaming_to_dryer($1, '2026-10-15 20:00+05:30')", [mixLot]));
  const lotA = await stopSoak(tPart, "DRYER-1", "2026-10-15 21:00+05:30");
  const lotB = await stopSoak(tFull, "DRYER-1", "2026-10-15 22:00+05:30");
  const lotARetry = await stopSoak(tPart, "DRYER-1", "2026-10-15 21:00+05:30");
  const LOTA = await batch(lotA);
  check("soaking stop goes through steaming (LOT) into the chosen dryer", LOTA.stage === "steaming" && LOTA.status === "completed" && LOTA.target_dryer_id === eq["DRYER-1"]
    && (await batch(tPart)).status === "consumed" && lotARetry === lotA);
  const filling = await as(users.management, (tx) => all(tx, "select * from public.dryer_filling() where dryer_id = $1", [eq["DRYER-1"]]));
  check("second tank into the same dryer joins the first tank's lot", lotB === lotA, `${lotA} ${lotB}`);
  check("Dryer 1 shows as filling with two tanks in one lot", Number(filling[0]?.lots) === 1 && Number(filling[0]?.tanks) === 2 && Number(filling[0]?.filling_kg) === Number(PART.input_kg) + 16500, JSON.stringify(filling));
  const dStart = (await as(users.drying_operator, (tx) => one(tx, "select public.start_dryer($1, '2026-10-15 22:30+05:30') as id", [eq["DRYER-1"]]))).id;
  const DS = await batch(dStart);
  check("dryer start takes everything filled into it", DS.stage === "drying" && DS.status === "running" && Number(DS.input_kg) === Number(PART.input_kg) + 16500);
  await expectError("a drying dryer cannot take another tank", users.soaking_operator,
    (tx) => tx.query("select public.stop_soaking_to_dryer($1, $2)", [tRest, eq["DRYER-1"]]), /DRYER_BUSY/);
  await expectError("dryer start with nothing loaded: clear message", users.drying_operator,
    (tx) => tx.query("select public.start_dryer($1)", [eq["DRYER-1"]]), /NOTHING_IN_DRYER|EQUIPMENT_BUSY/);
  await stopDryer(dStart, 12.8, "2026-10-16 11:00+05:30");
  const waitingFeed = await as(users.milling_operator, (tx) => all(tx, "select * from public.feed_tanks_waiting() where dryer_no = 1"));
  check("feed tank 1 holds both dryer loads for the mill", Number(waitingFeed[0]?.lots) === 2, JSON.stringify(waitingFeed));
  const mill2 = (await as(users.milling_operator, (tx) => one(tx, "select public.start_milling_from_dryer(1, $1, '2026-10-16 12:00+05:30') as id", [eq["MILL-1"]]))).id;
  const M2 = await batch(mill2);
  const m2in = await all(db, "select count(*) as n from public.batch_inputs where child_id = $1", [mill2]);
  check("milling operator starts milling with the 'Dryer 1' button (no authorisation needed)", M2.stage === "milling" && Number(m2in[0].n) === 2 && !M2.authorization_reason);
  await expectError("milling from an empty feed tank: clear message", users.milling_operator,
    (tx) => tx.query("select public.start_milling_from_dryer(3, $1)", [eq["MILL-1"]]), /NOTHING_IN_FEED_TANK/);
  const anc3 = await as(users.management, (tx) => all(tx, "select distinct b.stage from public.trace_ancestors($1) a join public.production_batches b on b.id = a.batch_id", [mill2]));
  check("milling still traces back to the trucks", ["receipt", "soaking", "steaming", "drying", "mill_feed"].every((st) => anc3.some((a) => a.stage === st)));

  // Tank pairs share one steaming lot number (client decision, 16 Nov).
  console.log("\nTank pairs share one lot number");
  await newTruck(401, "HR 55 AB 4010");
  await newTruck(402, "HR 55 AB 4020");
  await newTruck(403, "HR 55 AB 4030");
  await db.query("update public.varieties set std_tank_kg = 15000 where code = 'PB1121'");
  await newTruck(404, "HR 55 AB 4040", ids.PB1121);
  const p3 = await soakStd("TANK-3", "IR64", "2026-10-17 08:00+05:30");
  const p4 = await soakStd("TANK-4", "IR64", "2026-10-17 08:10+05:30");
  const p5 = await soakStd("TANK-5", "IR64", "2026-10-17 08:20+05:30");
  const p6 = await soakStd("TANK-6", "PB1121", "2026-10-17 08:30+05:30");
  const lotX = await stopSoak(p3, "DRYER-1", "2026-10-17 20:00+05:30");
  const lotX2 = await stopSoak(p4, "DRYER-1", "2026-10-17 20:40+05:30");
  const lotY = await stopSoak(p5, "DRYER-1", "2026-10-17 21:20+05:30");
  const lotZ = await stopSoak(p6, "DRYER-1", "2026-10-17 22:00+05:30");
  const lotX2retry = await stopSoak(p4, "DRYER-1", "2026-10-17 20:40+05:30");
  const X = await batch(lotX);
  const xIn = await all(db, "select parent_id, qty_kg from public.batch_inputs where child_id = $1", [lotX]);
  const want = Number((await batch(p3)).input_kg) + Number((await batch(p4)).input_kg);
  check("Tank 3 + Tank 4 into Dryer 1 share one LOT number (pair 2)", lotX2 === lotX && X.pair_no === 2 && xIn.length === 2 && /^LOT-/.test(X.batch_no), `${X.batch_no} pair ${X.pair_no}`);
  check("pair lot quantity is both tanks together", Number(X.input_kg) === want && Number(X.output_kg) === want && Number(await one(db, "select public.batch_available_kg($1) as a", [lotX]).then((r) => r.a)) === want, `${X.input_kg} ${want}`);
  const xOut = await one(db, "select sum(qty_kg) as s from public.batch_quantity_ledger where batch_id = $1 and entry = 'output'", [lotX]);
  check("ledger records the second tank's steamed output", Number(xOut.s) === want, xOut.s);
  check("a third tank starts the next lot", lotY !== lotX && (await batch(lotY)).pair_no === null);
  check("a different variety never joins another variety's lot", lotZ !== lotY && lotZ !== lotX);
  check("stopping the same tank again is safe (returns its lot)", lotX2retry === lotX);
  check("each tank is fully moved into its lot", (await batch(p3)).status === "consumed" && (await batch(p4)).status === "consumed");
  const xEvents = await all(db, "select event_type from public.batch_events where batch_id = $1", [lotX]);
  check("lot timeline shows the second tank joining", xEvents.some((e) => e.event_type === "tank_added"));
  const fill2 = await as(users.management, (tx) => one(tx, "select * from public.dryer_filling() where dryer_id = $1", [eq["DRYER-1"]]));
  check("Dryer 1 filling: 3 lots holding 4 tanks", Number(fill2.lots) === 3 && Number(fill2.tanks) === 4, JSON.stringify(fill2));
  const dPair = (await as(users.drying_operator, (tx) => one(tx, "select public.start_dryer($1, '2026-10-17 22:30+05:30') as id", [eq["DRYER-1"]]))).id;
  check("dryer start takes all three lots", Number((await batch(dPair)).input_kg) === Number(fill2.filling_kg));
  const p4desc = await as(users.management, (tx) => all(tx, "select batch_id from public.trace_descendants($1)", [p4]));
  check("second tank traces forward through the shared lot to the dryer", p4desc.some((r) => r.batch_id === lotX) && p4desc.some((r) => r.batch_id === dPair));

  // Standard recovery per variety (rice grades and by-products).
  check("by-products include Polish, Broken, Rejection", (await all(db, "select code from public.rice_grades where kind = 'by_product'")).map((r) => r.code).sort().join() === "BROKEN,POLISH,REJECTION,RESORT");
  await as(users.production_manager, (tx) => tx.query(
    "insert into public.variety_output_standards (variety_id, grade_id, std_pct, min_pct, max_pct) values ($1, $2, 30, 28, 32)", [ids.IR64, grade.WAND1]));
  await as(users.production_manager, (tx) => tx.query("update public.variety_output_standards set std_pct = 31, max_pct = 33 where variety_id = $1 and grade_id = $2", [ids.IR64, grade.WAND1]));
  const stdRow = await one(db, "select std_pct, max_pct from public.variety_output_standards where variety_id = $1 and grade_id = $2", [ids.IR64, grade.WAND1]);
  check("production manager sets and edits a variety's standard recovery", Number(stdRow.std_pct) === 31 && Number(stdRow.max_pct) === 33);
  await expectError("milling operator cannot change standards", users.milling_operator, (tx) => tx.query(
    "insert into public.variety_output_standards (variety_id, grade_id, std_pct) values ($1, $2, 10)", [ids.IR64, grade.BROKEN]), /row-level security/);
  await expectError("range must contain the standard", users.production_manager, (tx) => tx.query(
    "insert into public.variety_output_standards (variety_id, grade_id, std_pct, min_pct) values ($1, $2, 10, 12)", [ids.IR64, grade.BROKEN]), /check constraint/);
  const stdAudit = await one(db, "select count(*) as n from public.audit_log where table_name = 'variety_output_standards'");
  check("standard changes are audited", Number(stdAudit.n) >= 2);

  // Milling output from the standard recovery (client, 16 Nov): the operator does not enter it.
  console.log("\nMilling output from the standard recovery");
  const M2in = Number((await batch(mill2)).input_kg);
  const est1 = await as(users.milling_operator, (tx) => one(tx, "select public.milling_standard_output_kg($1) as kg", [mill2]));
  check("standard output = input x the variety's rice-grade standards (31%)", Number(est1.kg) === Math.round(M2in * 31) / 100, `${est1.kg} vs ${M2in}`);
  await as(users.production_manager, (tx) => tx.query("delete from public.variety_output_standards where variety_id = $1", [ids.IR64]));
  const yieldPct = Number((await one(db, "select est_yield_pct from public.varieties where id = $1", [ids.IR64])).est_yield_pct);
  const est2 = await as(users.milling_operator, (tx) => one(tx, "select public.milling_standard_output_kg($1) as kg", [mill2]));
  check("no standard set: falls back to the variety's estimated yield %", Number(est2.kg) === Math.round(M2in * yieldPct) / 100, `${est2.kg} ${yieldPct}%`);
  await as(users.production_manager, (tx) => tx.query(
    "insert into public.variety_output_standards (variety_id, grade_id, std_pct) values ($1, $2, 31)", [ids.IR64, grade.WAND1]));
  await as(users.milling_operator, (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-16 17:00+05:30')", [mill2]));
  const M2done = await batch(mill2);
  check("milling stops without an output: calculated from the standard and marked as an estimate",
    M2done.status === "completed" && Number(M2done.output_kg) === Number(est1.kg) && M2done.output_qty_status === "estimated", `${M2done.output_kg} ${M2done.output_qty_status}`);
  const m2ev = await one(db, "select note from public.batch_events where batch_id = $1 and event_type = 'completed'", [mill2]);
  check("timeline says the rice output came from the standard", /standard recovery/.test(m2ev.note ?? ""), m2ev.note);
  await stopDryer(dPair, 13, "2026-10-18 10:00+05:30");
  const mill3 = (await as(users.milling_operator, (tx) => one(tx, "select public.start_milling_from_dryer(1, $1, '2026-10-18 11:00+05:30') as id", [eq["MILL-1"]]))).id;
  await expectError("mixed-variety batch with no clear variety: asks for the output instead of guessing", users.milling_operator,
    (tx) => tx.query("select public.complete_production_batch($1, null, 0, null, '2026-10-18 15:00+05:30')", [mill3]), /NO_RECOVERY_STANDARD/);
  await as(users.milling_operator, (tx) => tx.query("select public.complete_production_batch($1, 20000, 0, null, '2026-10-18 15:00+05:30')", [mill3]));
  const M3 = await batch(mill3);
  check("an entered output is still accepted and marked as entered", Number(M3.output_kg) === 20000 && M3.output_qty_status === "entered", M3.output_qty_status);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message, e.where ?? "");
  process.exit(1);
});
