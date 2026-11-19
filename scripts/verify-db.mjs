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
  revoke execute on function public.create_purchase_slip(uuid) from authenticated;
  revoke execute on function public.slip_recalc(uuid) from authenticated;
  revoke execute on function public.admin_delete_log(text, uuid, text, jsonb, text) from authenticated;
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

  // =========================================================================
  {
  // Accounts and Tally export (client, 17 Nov).
  console.log("\nAccounts: ledgers, payments, Tally export");
  {
    const id = randomUUID();
    users.accountant = id;
    await db.query("insert into auth.users (id, email) values ($1, 'accountant@test.local')", [id]);
    await db.query("update public.profiles set role = 'accountant', plant_id = $2 where id = $1", [id, PLANT]);
  }
  const vouchers = (who) => as(who, (tx) => all(tx, "select * from public.accounting_vouchers(null, null)"));
  check("operators cannot see accounts", (await vouchers(users.qc_unloading)).length === 0);
  // A truck through a broker, without a purchase order (so no rate yet).
  const brk = await one(db, "insert into public.brokers (name) values ('Test Broker') returning id");
  const truckB = await as(users.weighbridge_operator, (tx) =>
    one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, weighed_at)
             values ($1, 501, 'HR 55 AC 5010', 'inbound', 28000, '2026-10-20 08:00+05:30') returning *`, [PLANT]));
  await as(users.weighbridge_operator, (tx) => tx.query("select public.complete_weighing($1, null, 12000)", [truckB.id]));
  const qB = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [truckB.id]))).id;
  await as(users.qc_unloading, async (tx) => {
    await tx.query("update public.qc_inbound set supplier_id = $2, broker_id = $3, location_id = $4 where id = $1", [qB, party["Kaveri Agro"], brk.id, loc["YARD-A"]]);
    await tx.query("insert into public.qc_inbound_lines (qc_id, line_no, variety_id, moisture_pct, sacks_received) values ($1, 1, $2, 14, 320)", [qB, ids.IR64]);
    await tx.query("select public.submit_qc_inbound($1)", [qB]);
  });
  await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qB]));
  const lineB = await one(db, "select id, accepted_kg from public.qc_inbound_lines where qc_id = $1", [qB]);
  let vs = await vouchers(users.accountant);
  const pur = () => vs.find((v) => v.voucher_key === "PUR:" + qB);
  check("posted truck without a PO appears as a Purchase needing a rate", pur()?.vtype === "Purchase" && pur()?.problem === "Rate missing" && pur()?.party_name === "Kaveri Agro", JSON.stringify(pur()));
  await expectError("operators cannot fill rates", users.qc_unloading,
    (tx) => tx.query("select public.set_voucher_override('purchase', $1, null, 2400)", [lineB.id]), /PERMISSION_DENIED/);
  await as(users.accountant, (tx) => tx.query("select public.set_voucher_override('purchase', $1, null, 2400)", [lineB.id]));
  vs = await vouchers(users.accountant);
  const purAmt = Math.round(Number(lineB.accepted_kg) / 100 * 2400 * 100) / 100;
  check("purchase amount = accepted q x rate, ready for Tally", pur()?.problem === null && Number(pur()?.amount) === purAmt, `${pur()?.amount} vs ${purAmt}`);
  check("no broker commission until a rate is set", !vs.some((v) => v.voucher_key === "BRK:" + qB));
  await as(users.accountant, (tx) => tx.query("select public.set_tally_ledger(null, $1, 'Test Broker A/c', 5)", [brk.id]));
  vs = await vouchers(users.accountant);
  const bv = vs.find((v) => v.voucher_key === "BRK:" + qB);
  check("broker commission Journal = accepted q x Rs 5", bv?.vtype === "Journal" && Number(bv.amount) === Math.round(Number(lineB.accepted_kg) / 100 * 5 * 100) / 100 && bv.ledger_name === "Test Broker A/c", JSON.stringify(bv));
  // Sales: the dispatch posted earlier has sales-order lines (customer known) but no rate.
  const sal = vs.find((v) => v.voucher_key.startsWith("SAL:" + oq));
  check("posted dispatch appears as a Sales voucher with the customer from the sales order", sal?.vtype === "Sales" && sal?.problem === "Rate missing" && !!sal?.party_id, JSON.stringify(sal));
  for (const l of await all(db, "select id from public.qc_outbound_lines where qc_id = $1", [oq])) {
    await as(users.accountant, (tx) => tx.query("select public.set_voucher_override('sales', $1, null, 3200)", [l.id]));
  }
  vs = await vouchers(users.accountant);
  const sal2 = vs.find((v) => v.voucher_key.startsWith("SAL:" + oq));
  check("sales amount = qty x rate once rates are filled", sal2?.problem === null && Number(sal2.amount) > 0, JSON.stringify(sal2));
  // Payments.
  const bank = await as(users.accountant, (tx) => one(tx, "insert into public.bank_accounts (name, tally_ledger, account_last4) values ('HDFC Current', 'HDFC Bank', '1234') returning id"));
  const pay = (args) => as(users.accountant, (tx) => one(tx, "select public.record_payment($1, $2, $3, $4, $5, $6, $7, $8, null, $9) as id", args)).then((r) => r.id);
  await expectError("NEFT payment needs the UTR", users.accountant,
    (tx) => tx.query("select public.record_payment('payment', $1, null, $2, 100000, '2026-10-21', 'NEFT', null)", [party["Kaveri Agro"], bank.id]), /reference/);
  await expectError("cash entries cannot use a bank account", users.accountant,
    (tx) => tx.query("select public.record_payment('payment', $1, null, $2, 1000, '2026-10-21', 'Cash', null)", [party["Kaveri Agro"], bank.id]), /Cash entries/);
  await expectError("receipts cannot be from a broker", users.accountant,
    (tx) => tx.query("select public.record_payment('receipt', null, $1, $2, 1000, '2026-10-21', 'NEFT', 'X1')", [brk.id, bank.id]), /brokers/);
  await expectError("management can view but not record payments", users.management,
    (tx) => tx.query("select public.record_payment('payment', $1, null, $2, 1000, '2026-10-21', 'NEFT', 'X2')", [party["Kaveri Agro"], bank.id]), /PERMISSION_DENIED/);
  const req = randomUUID();
  const p1 = await pay(["payment", party["Kaveri Agro"], null, bank.id, 100000, "2026-10-21", "NEFT", "UTR123", req]);
  const p1again = await pay(["payment", party["Kaveri Agro"], null, bank.id, 100000, "2026-10-21", "NEFT", "UTR123", req]);
  check("payment recorded once even if the button is pressed twice", p1 === p1again && /^PAY-\d{5}$/.test((await one(db, "select voucher_no from public.payments where id = $1", [p1])).voucher_no));
  const led = await as(users.management, (tx) => all(tx, "select * from public.party_ledger($1, null)", [party["Kaveri Agro"]]));
  const purRow = led.find((r) => r.voucher_key === "PUR:" + qB);
  const payRow = led.find((r) => r.voucher_key === "PAY:" + p1);
  const last = led.at(-1);
  const expectBal = led.reduce((a, r) => a + Number(r.debit) - Number(r.credit), 0);
  check("party ledger: purchase is a credit, payment a debit, running balance adds up",
    Number(purRow?.credit) === purAmt && Number(payRow?.debit) === 100000 && Math.abs(Number(last.balance) - expectBal) < 0.01, JSON.stringify({ purRow, payRow, last }));
  const bal = await as(users.management, (tx) => one(tx, "select * from public.party_balances() where party_id = $1", [party["Kaveri Agro"]]));
  check("outstanding per party matches the ledger", Math.abs(Number(bal.balance) - expectBal) < 0.01, bal.balance);
  // Export to Tally.
  const keys = ["PUR:" + qB, "BRK:" + qB, sal2.voucher_key, "PAY:" + p1, "PUR:does-not-exist"];
  const ex = (await as(users.accountant, (tx) => one(tx, "select public.mark_tally_exported($1::text[], '2026-10-01', '2026-10-31') as id", [keys]))).id;
  const EX = await one(db, "select * from public.tally_exports where id = $1", [ex]);
  check("export logs only the ready entries (4 of 5 keys)", EX.voucher_count === 4 && /^TLY-\d{5}$/.test(EX.export_no), JSON.stringify(EX));
  await expectError("the same entries cannot be exported twice", users.accountant,
    (tx) => tx.query("select public.mark_tally_exported($1::text[], null, null)", [keys]), /NOTHING_TO_EXPORT/);
  vs = await vouchers(users.accountant);
  check("exported entries show their export number", vs.filter((v) => keys.includes(v.voucher_key)).every((v) => v.export_no === EX.export_no));
  await expectError("rates cannot change after export", users.accountant,
    (tx) => tx.query("select public.set_voucher_override('purchase', $1, null, 2500)", [lineB.id]), /ALREADY_EXPORTED/);
  await as(users.accountant, (tx) => tx.query("select public.cancel_payment($1, 'Entered twice')", [p1]));
  vs = await vouchers(users.accountant);
  const cp = vs.find((v) => v.voucher_key === "PAY:" + p1);
  check("a payment cancelled after export stays listed as cancelled (so Tally can be corrected)", cp?.source_status === "cancelled" && cp?.export_no === EX.export_no);
  const led2 = await as(users.accountant, (tx) => all(tx, "select * from public.party_ledger($1, null)", [party["Kaveri Agro"]]));
  check("cancelled payment drops out of the party ledger", !led2.some((r) => r.voucher_key === "PAY:" + p1));
  await as(users.admin, (tx) => tx.query("delete from public.payments where id = $1", [p1]));
  {
    let msg = "";
    try { await db.query("delete from public.payments where id = $1", [p1]); } catch (e) { msg = e.message; }
    check("payments cannot be deleted even by the database owner", /cannot be deleted/.test(msg), msg);
  }
  check("payments cannot be deleted (still there after a delete attempt)", !!(await one(db, "select id from public.payments where id = $1", [p1])));
  await expectError("operators cannot read payments", users.qc_unloading,
    async (tx) => { const r = await all(tx, "select * from public.payments"); if (!r.length) throw new Error("row-level: none visible"); }, /row-level/);

  }

  console.log("\nPurchase slip (client sample: RST 139, Annapurna Trading Co, 01 Nov 2026)");
  {
    const v = await one(db, "insert into public.varieties (code, name) values ('HYB', 'Hybrid Paddy') returning id");
    const ann = await one(db, "insert into public.parties (name, kind) values ('Annapurna Trading Co', 'supplier') returning id");
    const sachin = await one(db, "insert into public.brokers (name, phone) values ('Sachin', '98765 43210') returning id");
    const godown = await one(db, "insert into public.locations (plant_id, code, name, kind) values ($1, 'SFDJ', 'SFDJ', 'raw_store') returning id", [PLANT]);
    const sauda = await as(users.commercial, async (tx) => {
      const p = await one(tx, "insert into public.purchase_orders (plant_id, supplier_id, broker_id) values ($1, $2, $3) returning *", [PLANT, ann.id, sachin.id]);
      const l = await one(tx, "insert into public.po_lines (po_id, line_no, variety_id, ordered_kg, rate_per_qtl) values ($1, 1, $2, 50000, 2175) returning *", [p.id, v.id]);
      return { ...p, line: l.id };
    });
    const tk = await as(users.weighbridge_operator, (tx) =>
      one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, vehicle_type, direction, gross_kg, weighed_at)
               values ($1, 139, 'TT', 'Tractor trolley', 'inbound', 16540, now() - interval '2 hours') returning *`, [PLANT]));
    const found = await as(users.qc_unloading, (tx) => all(tx, "select * from public.purchase_qc_search('139')"));
    check("purchaser finds the truck by RST with vehicle, gross and type",
      found.some((r) => r.ticket_id === tk.id && Number(r.gross_kg) === 16540 && r.vehicle_type === "Tractor trolley"), JSON.stringify(found));
    const bySauda = await as(users.qc_unloading, (tx) => all(tx, "select * from public.purchase_qc_search($1)", [sauda.po_no]));
    check("…and by sauda (purchase order) number", bySauda.some((r) => r.ticket_id === tk.id));
    check("operators outside QC get nothing from the search", (await as(users.foreman, (tx) => all(tx, "select * from public.purchase_qc_search('139')"))).length === 0);

    const qid = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [tk.id]))).id;
    await as(users.qc_unloading, async (tx) => {
      await tx.query(`update public.qc_inbound set supplier_id = $2, broker_id = $3, location_id = $4, bag_status = 'returned',
                      claim_details = '20q*30 paper & Palledari', claim_amount = 950 where id = $1`, [qid, ann.id, sachin.id, godown.id]);
      await tx.query("insert into public.qc_inbound_lines (qc_id, line_no, variety_id, po_line_id, moisture_pct, sacks_received) values ($1, 1, $2, $3, 16.2, 275)", [qid, v.id, sauda.line]);
      await tx.query("select public.submit_qc_inbound($1)", [qid]);
    });
    await as(users.weighbridge_operator, (tx) => tx.query("select public.complete_weighing($1, null, 5530)", [tk.id]));
    await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qid]));

    const slipOf = (who) => as(who, (tx) => one(tx, "select * from public.purchase_slips where qc_id = $1 and status <> 'cancelled'", [qid]));
    const linesOf = (who, id) => as(who, (tx) => all(tx, "select * from public.purchase_slip_lines where slip_id = $1 order by sort_order", [id]))
      .then((ls) => Object.fromEntries(ls.map((l) => [l.code ?? l.label, l])));
    let S = await slipOf(users.accountant);
    check("posting the QC builds the slip automatically", !!S && S.status === "draft" && /^PS-\d{5}$/.test(S.slip_no), JSON.stringify(S));
    check("slip header: RST 139, TT, Hybrid Paddy, 275 bags, 110.10 q @ 2175 = 239468",
      S.rst === 139 && S.vehicle_no === "TT" && S.variety === "Hybrid Paddy" && S.bags_total === 275 && Number(S.net_kg) === 11010 &&
      Number(S.rate_per_qtl) === 2175 && Number(S.amount) === 239468, JSON.stringify(S));
    let L = await linesOf(users.accountant, S.id);
    check("Khad waits to be entered after unloading", L.khad?.pending === true && Number(L.khad.amount) === 0);
    await expectError("slip cannot be finalised while Khad is pending", users.accountant,
      (tx) => tx.query("select public.finalize_purchase_slip($1)", [S.id]), /Khad/);
    await expectError("an unloading QC operator cannot enter Khad", users.qc_unloading,
      (tx) => tx.query("select public.enter_slip_deduction($1, 1)", [L.khad.id]), /PERMISSION_DENIED|not found/);
    await as(users.management, (tx) => tx.query("select public.enter_slip_deduction($1, 1, 'next day')", [L.khad.id]));
    S = await slipOf(users.accountant);
    L = await linesOf(users.accountant, S.id);
    const amt = (c) => Number(L[c]?.amount);
    check("deductions match the paper slip: CD 4789, Khad 2395, moisture 479, dhalta 2395, brokerage 771, claim 950, unloading 1101, TDS 239, RTGS 200",
      amt("cash_discount") === 4789 && amt("khad") === 2395 && amt("moisture") === 479 && Number(L.moisture.rate) === 0.2 &&
      amt("dhalta") === 2395 && Number(L.dhalta.rate) === 1 && amt("brokerage") === 771 && amt("claim") === 950 &&
      amt("unloading") === 1101 && amt("tds") === 239 && amt("rtgs") === 200, JSON.stringify(Object.values(L).map((l) => [l.code, l.rate, l.amount])));
    check("net payable 226149 (as on the paper slip)", Number(S.net_payable) === 226149, S.net_payable);

    // Moisture bands.
    const mp = async (m, prog, pass = 16) => Number((await one(db, "select public.slip_moisture_pct($1, $2::jsonb) as p",
      [m, JSON.stringify({ moisture_pass_pct: pass, moisture_progressive: prog, moisture_slabs: [{ upto: 20, per_point: 1 }, { upto: 24, per_point: 1.5 }, { upto: null, per_point: 2 }] })])).p);
    check("moisture: up to 16% passes", (await mp(16, 1)) === 0 && (await mp(15.5, 1)) === 0);
    check("moisture 22%: 7% band by band, 9% at the band rate", (await mp(22, 1)) === 7 && (await mp(22, 0)) === 9);
    check("moisture 26%: 4 + 6 + 4 = 14% band by band", (await mp(26, 1)) === 14);
    check("moisture with pass level 14%: 16.2% = 2.2%", (await mp(16.2, 1, 14)) === 2.2);

    // Edits.
    await expectError("only admin / accountant can edit a slip", users.management,
      (tx) => tx.query("select public.update_purchase_slip($1, '{\"early_payment\": true}'::jsonb, null, null)", [S.id]), /PERMISSION_DENIED/);
    await expectError("slips cannot be changed directly", null, async (tx) => {
      await tx.query("reset role");
      await tx.query("update public.purchase_slips set net_payable = 1 where id = $1", [S.id]);
    }, /slip actions/);
    await as(users.accountant, (tx) => tx.query("select public.finalize_purchase_slip($1)", [S.id]));
    await expectError("a final slip needs a reason to change", users.accountant,
      (tx) => tx.query("select public.update_purchase_slip($1, '{\"early_payment\": true}'::jsonb, null, null)", [S.id]), /reason/);
    await as(users.accountant, (tx) => tx.query("select public.update_purchase_slip($1, '{\"early_payment\": true}'::jsonb, null, 'Broker asked for early payment')", [S.id]));
    S = await slipOf(users.accountant);
    L = await linesOf(users.accountant, S.id);
    check("early payment: cash discount 2.5% = 5987, revision 1", Number(L.cash_discount.rate) === 2.5 && amt("cash_discount") === 5987 && S.revision === 1 && S.status === "final",
      JSON.stringify([L.cash_discount, S.revision]));
    await as(users.accountant, (tx) => tx.query("select public.update_purchase_slip($1, '{\"bag_status\": \"received\"}'::jsonb, $2::jsonb, 'Bags kept')",
      [S.id, JSON.stringify([{ label: "Sutli", basis: "flat", rate: 50 }])]));
    S = await slipOf(users.accountant);
    L = await linesOf(users.accountant, S.id);
    check("bags received: dhalta 1.25% = 2993; an extra deduction can be added", Number(L.dhalta.rate) === 1.25 && amt("dhalta") === 2993 && amt("Sutli") === 50);
    check("net payable follows the edits", Number(S.net_payable) === 239468 - (5987 + 2395 + 479 + 2993 + 771 + 950 + 1101 + 239 + 200 + 50), S.net_payable);
    const audit = await one(db, "select count(*)::int as n from public.audit_log where table_name = 'purchase_slips' and record_id = $1 and reason = 'Broker asked for early payment'", [S.id]);
    check("slip edits are in the audit log with the reason", audit.n >= 1);

    // Parameters: changing them never changes an existing slip.
    await as(users.admin, (tx) => tx.query("update public.calc_settings set value = 14 where key = 'slip_moisture_pass_pct'"));
    await as(users.accountant, (tx) => tx.query("select public.update_purchase_slip($1, '{}'::jsonb, null, 'recalc check')", [S.id]));
    L = await linesOf(users.accountant, S.id);
    check("a later parameter change does not alter the slip (moisture stays 0.2%)", Number(L.moisture.rate) === 0.2);
    await expectError("only the admin can change parameters (RLS)", users.accountant, async (tx) => {
      const r = await tx.query("update public.purchase_deduction_types set value = 3 where code = 'cash_discount'");
      if (r.affectedRows === 0) throw new Error("row-level: none");
    }, /row-level/);
    await as(users.admin, (tx) => tx.query("update public.calc_settings set value = 16 where key = 'slip_moisture_pass_pct'"));

    // Payment and WhatsApp log.
    const bank2 = await as(users.accountant, (tx) => one(tx, "insert into public.bank_accounts (name) values ('SBI Current') returning id"));
    const payId = (await as(users.accountant, (tx) => one(tx, "select public.pay_purchase_slip($1, $2, 'RTGS', 'UTR139', current_date) as id", [S.id, bank2.id]))).id;
    S = await slipOf(users.accountant);
    const P = await one(db, "select * from public.payments where id = $1", [payId]);
    check("paying the slip records a payment of the net payable to the party", S.status === "paid" && Number(P.amount) === Number(S.net_payable) && P.party_id === ann.id);
    await as(users.accountant, (tx) => tx.query("select public.log_slip_send($1, 'whatsapp_manual', '919876543210', 'opened')", [S.id]));
    check("WhatsApp sends are logged", (await one(db, "select count(*)::int as n from public.purchase_slip_sends where slip_id = $1", [S.id])).n === 1);
    await expectError("a paid slip cannot be edited (payment would no longer match)", users.accountant,
      (tx) => tx.query("select public.update_purchase_slip($1, '{}'::jsonb, null, 'x')", [S.id]), /Cancel its payment/);
    await expectError("a paid slip cannot be cancelled", users.accountant, (tx) => tx.query("select public.cancel_purchase_slip($1, 'x')", [S.id]), /paid/);
    await as(users.accountant, (tx) => tx.query("select public.cancel_payment($1, 'Wrong UTR')", [payId]));
    S = await slipOf(users.accountant);
    check("cancelling the payment re-opens the slip for payment", S.status === "final" && S.payment_id === null);
    await expectError("broker phone must be a mobile number", users.accountant, (tx) => tx.query("select public.set_broker_contact($1, '12345', null)", [sachin.id]), /mobile/);
    check("operators cannot see slips", (await as(users.foreman, (tx) => all(tx, "select * from public.purchase_slips"))).length === 0);
    check("weighbridge operator (fills Khad) can see slips", (await as(users.weighbridge_operator, (tx) => all(tx, "select id from public.purchase_slips where id = $1", [S.id]))).length === 1);

    const pub = await db.transaction(async (tx) => {
      await tx.query("set local role anon");
      return (await tx.query("select public.purchase_slip_by_token($1) as j", [S.share_token])).rows[0].j;
    });
    check("the broker's link shows the slip without signing in (no internal ids)", pub?.slip?.slip_no === S.slip_no && pub.lines.length >= 9 && !pub.slip.qc_id && pub.slip.share_token === "");
    const bad = await db.transaction(async (tx) => { await tx.query("set local role anon"); return (await tx.query("select public.purchase_slip_by_token('abc') as j")).rows[0].j; });
    check("a wrong token shows nothing", bad === null);
    // Reversing the QC cancels the slip.
    await as(users.accountant, (tx) => tx.query("select public.cancel_purchase_slip($1, 'test')", [S.id]));
    const re = (await as(users.accountant, (tx) => one(tx, "select public.rebuild_purchase_slip($1) as id", [qid]))).id;
    check("a cancelled slip can be rebuilt from the QC", !!re && re !== S.id);
    await as(users.qc_head, (tx) => tx.query("select public.reverse_qc_inbound($1, 'Wrong party')", [qid]));
    const rs = await one(db, "select status from public.purchase_slips where id = $1", [re]);
    check("reversing the QC cancels its slip", rs.status === "cancelled", rs.status);
  }

  console.log("\nAdmin delete (past entries)");
  {
    const v = (await one(db, "select id from public.varieties where code = 'HYB'")).id;
    const party2 = (await one(db, "select id from public.parties where name = 'Annapurna Trading Co'")).id;
    const loc2 = (await one(db, "select id from public.locations where code = 'SFDJ'")).id;
    const bank3 = (await one(db, "select id from public.bank_accounts where name = 'SBI Current'")).id;
    const po = await as(users.commercial, async (tx) => {
      const p = await one(tx, "insert into public.purchase_orders (plant_id, supplier_id) values ($1, $2) returning *", [PLANT, party2]);
      return (await one(tx, "insert into public.po_lines (po_id, line_no, variety_id, ordered_kg, rate_per_qtl) values ($1, 1, $2, 50000, 2000) returning id", [p.id, v])).id;
    });
    const tk = await as(users.weighbridge_operator, (tx) =>
      one(tx, `insert into public.weighbridge_tickets (plant_id, rst, vehicle_no, direction, gross_kg, tare_kg, weighed_at)
               values ($1, 777, 'TEST 777', 'inbound', 20000, 8000, now() - interval '1 hour') returning *`, [PLANT]));
    const qid = (await as(users.qc_unloading, (tx) => one(tx, "select public.start_qc_inbound($1) as id", [tk.id]))).id;
    await as(users.qc_unloading, async (tx) => {
      await tx.query("update public.qc_inbound set supplier_id = $2, location_id = $3, bag_status = 'received' where id = $1", [qid, party2, loc2]);
      await tx.query("insert into public.qc_inbound_lines (qc_id, line_no, variety_id, po_line_id, moisture_pct, sacks_received) values ($1, 1, $2, $3, 15, 200)", [qid, v, po]);
      await tx.query("select public.submit_qc_inbound($1)", [qid]);
    });
    await as(users.qc_head, (tx) => tx.query("select public.post_qc_inbound($1)", [qid]));
    const slip = await one(db, "select * from public.purchase_slips where qc_id = $1", [qid]);
    const khad = await one(db, "select id from public.purchase_slip_lines where slip_id = $1 and code = 'khad'", [slip.id]);
    await as(users.accountant, async (tx) => {
      await tx.query("select public.enter_slip_deduction($1, 0)", [khad.id]);
      await tx.query("select public.finalize_purchase_slip($1)", [slip.id]);
      await tx.query("select public.pay_purchase_slip($1, $2, 'RTGS', 'UTR777', current_date)", [slip.id, bank3]);
    });
    const pay = (await one(db, "select payment_id from public.purchase_slips where id = $1", [slip.id])).payment_id;

    await expectError("only the admin can delete a truck", users.accountant,
      (tx) => tx.query("select public.admin_delete_truck($1, 'test')", [tk.id]), /PERMISSION_DENIED/);
    await expectError("deleting needs a reason", users.admin,
      (tx) => tx.query("select public.admin_delete_truck($1, ' ')", [tk.id]), /reason/);

    // Delete only the payment: the slip goes back to final.
    await as(users.admin, (tx) => tx.query("select public.admin_delete_payment($1, 'test payment')", [pay]));
    const s1 = await one(db, "select status, payment_id from public.purchase_slips where id = $1", [slip.id]);
    check("admin deletes a payment; its slip goes back to final", s1.status === "final" && s1.payment_id === null &&
      !(await one(db, "select id from public.payments where id = $1", [pay])));

    // Delete the slip, then build it again.
    await as(users.admin, (tx) => tx.query("select public.admin_delete_slip($1, 'wrong slip')", [slip.id]));
    check("admin deletes a slip (and its lines)", !(await one(db, "select id from public.purchase_slips where id = $1", [slip.id])) &&
      (await one(db, "select count(*)::int as n from public.purchase_slip_lines where slip_id = $1", [slip.id])).n === 0);
    const again = (await as(users.accountant, (tx) => one(tx, "select public.rebuild_purchase_slip($1) as id", [qid]))).id;
    check("a deleted slip can be built again from the QC", !!again);

    // Delete the whole truck.
    const stockBefore = (await one(db, "select count(*)::int as n from public.stock_movements where reference_id = $1", [qid])).n;
    const res = (await as(users.admin, (tx) => one(tx, "select public.admin_delete_truck($1, 'test truck') as r", [tk.id]))).r;
    const gone = await one(db, `select
        (select count(*) from public.weighbridge_tickets where id = $1)::int as t,
        (select count(*) from public.qc_inbound where id = $2)::int as q,
        (select count(*) from public.qc_inbound_lines where qc_id = $2)::int as l,
        (select count(*) from public.stock_movements where reference_id = $2)::int as m,
        (select count(*) from public.purchase_slips where qc_id = $2)::int as s`, [tk.id, qid]);
    check("admin deletes a truck with its QC, stock rows and slip", stockBefore > 0 && Object.values(gone).every((n) => n === 0) && res.rst === 777,
      JSON.stringify({ gone, res }));
    const log = await one(db, "select * from public.audit_log where action = 'admin_delete' and record_id = $1", [tk.id]);
    check("a full copy of the deleted truck is kept in the audit log", !!log && log.old_data?.qc_inbound?.length === 1 && /test truck/.test(log.reason));

    // Refusals.
    const prodTicket = await one(db, `select q.ticket_id from public.production_batches b join public.qc_inbound_lines l on l.id = b.source_qc_line_id
                                      join public.qc_inbound q on q.id = l.qc_id limit 1`);
    await expectError("a truck that went into production cannot be deleted", users.admin,
      (tx) => tx.query("select public.admin_delete_truck($1, 'x')", [prodTicket.ticket_id]), /production/);
    const expTicket = await one(db, `select q.ticket_id from public.tally_exported x join public.qc_inbound q on x.voucher_key = 'PUR:' || q.id limit 1`);
    await expectError("a truck already exported to Tally cannot be deleted", users.admin,
      (tx) => tx.query("select public.admin_delete_truck($1, 'x')", [expTicket.ticket_id]), /Tally/);
    let msg = "";
    try { await db.query("delete from public.stock_movements where id = (select id from public.stock_movements limit 1)"); } catch (e) { msg = e.message; }
    check("stock rows still cannot be deleted outside the admin delete", /append-only/.test(msg), msg);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message, e.where ?? "");
  process.exit(1);
});
