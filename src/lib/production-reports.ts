import "server-only";
import { createClient } from "@/lib/supabase/server";
import { BATCH_COLUMNS, STAGES, STAGE_META, loadMasters, type Batch } from "@/lib/production";

export const REPORTS = [
  { key: "daily", label: "Daily production" },
  { key: "soaking", label: "Tank-wise soaking" },
  { key: "steaming", label: "Steaming lots" },
  { key: "dryer", label: "Dryer-wise production" },
  { key: "milling", label: "Milling input / output" },
  { key: "grade", label: "Grade-wise production" },
  { key: "loss", label: "Quantity loss & reconciliation" },
  { key: "operator", label: "Operator activity" },
  { key: "genealogy", label: "Batch genealogy" },
  { key: "truck", label: "Truck-to-rice traceability" },
] as const;

export type ReportKey = (typeof REPORTS)[number]["key"];
export type Report = { title: string; columns: string[]; rows: (string | number | null)[][]; note?: string };

const qtl = (kg: number | null | undefined) => (kg === null || kg === undefined ? null : Math.round(Number(kg)) / 100);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null);
const istDay = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso)) : "");
const istTime = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "";
const sum = (bs: Batch[], f: (b: Batch) => number | null) => bs.reduce((a, b) => a + Number(f(b) ?? 0), 0);

export async function buildReport(key: ReportKey, from: string, to: string): Promise<Report> {
  const supabase = await createClient();
  const m = await loadMasters();
  const fromIso = new Date(`${from}T00:00:00+05:30`).toISOString();
  const toIso = new Date(`${to}T23:59:59+05:30`).toISOString();
  const { data } = await supabase
    .from("production_batches")
    .select(BATCH_COLUMNS)
    .gte("started_at", fromIso)
    .lte("started_at", toIso)
    .order("started_at")
    .limit(5000);
  const all = (data ?? []) as Batch[];
  const live = all.filter((b) => b.status !== "cancelled");
  const st = (s: Batch["stage"]) => live.filter((b) => b.stage === s);
  const eqName = (b: Batch) => (b.equipment_id ? (m.equipmentById.get(b.equipment_id)?.name ?? "") : "");

  switch (key) {
    case "daily": {
      const days = [...new Set(live.map((b) => istDay(b.started_at)))].sort();
      return {
        title: "Daily production (quintals)",
        columns: ["Date", "Paddy received", "Soaked (in)", "Steamed (in)", "Dried (out)", "Milled (in)", "Rice output", "Batches cancelled"],
        rows: days.map((d) => {
          const day = (s: Batch["stage"]) => st(s).filter((b) => istDay(b.started_at) === d);
          return [
            d,
            qtl(sum(day("receipt"), (b) => b.output_kg)),
            qtl(sum(day("soaking"), (b) => b.input_kg)),
            qtl(sum(day("steaming"), (b) => b.input_kg)),
            qtl(sum(day("drying"), (b) => b.output_kg)),
            qtl(sum(day("milling"), (b) => b.input_kg)),
            qtl(sum(day("output"), (b) => b.output_kg)),
            all.filter((b) => b.status === "cancelled" && istDay(b.started_at) === d).length,
          ];
        }),
      };
    }
    case "soaking": {
      const tanks = m.equipment.filter((e) => e.kind === "soaking_tank");
      return {
        title: "Tank-wise soaking",
        note: "Tanks are not weighed. Quantities come from the variety's standard weight per tank unless an actual weight was entered.",
        columns: ["Tank", "Batches", "Input (q)", "Output (q)", "Estimated outputs", "Avg soak (h)", "Last batch"],
        rows: tanks.map((t) => {
          const bs = st("soaking").filter((b) => b.equipment_id === t.id);
          return [
            t.name, bs.length,
            qtl(sum(bs, (b) => b.input_kg)), qtl(sum(bs, (b) => b.output_kg)),
            bs.filter((b) => b.output_qty_status === "estimated").length,
            avg(bs.filter((b) => b.duration_minutes).map((b) => Number(b.duration_minutes) / 60)),
            bs.at(-1)?.batch_no ?? "",
          ];
        }),
      };
    }
    case "steaming": {
      const lots = st("steaming");
      const ids = lots.map((b) => b.id);
      const { data: edges } = ids.length
        ? await supabase.from("batch_inputs").select("child_id, parent:production_batches!batch_inputs_parent_id_fkey(equipment_id)").in("child_id", ids)
        : { data: [] };
      const tanksOf = (id: string) =>
        (edges ?? [])
          .filter((e) => e.child_id === id)
          .map((e) => m.equipmentById.get((e.parent as unknown as { equipment_id: string }).equipment_id)?.number)
          .sort()
          .join(" + ");
      return {
        title: "Steaming lots",
        columns: ["Lot", "Tanks", "Into dryer", "Started", "Ended", "Steaming (h)", "Input (q)", "Status"],
        rows: lots.map((b) => [
          b.batch_no, tanksOf(b.id), b.target_dryer_id ? (m.equipmentById.get(b.target_dryer_id)?.name ?? "") : "",
          istTime(b.started_at), istTime(b.ended_at), b.duration_minutes ? Math.round(Number(b.duration_minutes) / 6) / 10 : null,
          qtl(b.input_kg), b.status,
        ]),
      };
    }
    case "dryer": {
      const dryers = m.equipment.filter((e) => e.kind === "dryer");
      return {
        title: "Dryer-wise production",
        columns: ["Dryer", "Batches", "Input (q)", "Output (q)", "Drying loss (q)", "Loss %", "Avg moisture %", "Avg drying (h)"],
        rows: dryers.map((d) => {
          const bs = st("drying").filter((b) => b.equipment_id === d.id);
          const done = bs.filter((b) => b.output_kg !== null);
          const inKg = sum(done, (b) => b.input_kg);
          const loss = sum(done, (b) => b.loss_kg);
          return [
            d.name, bs.length, qtl(sum(bs, (b) => b.input_kg)), qtl(sum(done, (b) => b.output_kg)), qtl(loss), pct(loss, inKg),
            avg(bs.filter((b) => b.moisture_pct !== null).map((b) => Number(b.moisture_pct))),
            avg(bs.filter((b) => b.duration_minutes).map((b) => Number(b.duration_minutes) / 60)),
          ];
        }),
      };
    }
    case "milling": {
      const mills = st("milling");
      const ids = mills.map((b) => b.id);
      const [{ data: faults }, { data: kids }] = await Promise.all([
        ids.length ? supabase.from("production_faults").select("batch_id, downtime_minutes").in("batch_id", ids) : Promise.resolve({ data: [] }),
        ids.length ? supabase.from("batch_inputs").select("parent_id, qty_kg, child:production_batches!batch_inputs_child_id_fkey(status)").in("parent_id", ids) : Promise.resolve({ data: [] }),
      ]);
      return {
        title: "Milling input / output",
        columns: ["Milling batch", "Line", "Started", "Ended", "Duration (h)", "Paddy in (q)", "Rice out (q)", "Recovery %", "Graded (q)", "Downtime (min)", "Status"],
        rows: mills.map((b) => {
          const graded = (kids ?? []).filter((k) => k.parent_id === b.id && (k.child as unknown as { status: string })?.status !== "cancelled").reduce((a, k) => a + Number(k.qty_kg), 0);
          const down = (faults ?? []).filter((f) => f.batch_id === b.id).reduce((a, f) => a + Number(f.downtime_minutes ?? 0), 0);
          return [
            b.batch_no, eqName(b), istTime(b.started_at), istTime(b.ended_at), b.duration_minutes ? Math.round(Number(b.duration_minutes) / 6) / 10 : null,
            qtl(b.input_kg), qtl(b.output_kg), b.output_kg ? pct(Number(b.output_kg), Number(b.input_kg)) : null, qtl(graded), down, b.status,
          ];
        }),
      };
    }
    case "grade": {
      const milledIn = sum(st("milling"), (b) => b.input_kg);
      const outs = st("output");
      return {
        title: "Grade-wise production",
        note: "Actual % is against paddy milled in the same period. Reference % is from the process diagram, for comparison only.",
        columns: ["Grade", "Records", "Quantity (q)", "Confirmed in stock (q)", "Actual %", "Reference %"],
        rows: m.grades.map((g) => {
          const bs = outs.filter((b) => b.grade_id === g.id);
          return [
            g.name, bs.length, qtl(sum(bs, (b) => b.output_kg)), qtl(sum(bs.filter((b) => b.output_qty_status === "confirmed"), (b) => b.output_kg)),
            pct(sum(bs, (b) => b.output_kg), milledIn), g.reference_pct,
          ];
        }),
      };
    }
    case "loss":
      return {
        title: "Quantity loss & reconciliation by stage",
        note: "Loss = input − output − rejected. Soaking/steaming can gain weight (water). Estimated outputs were not weighed.",
        columns: ["Stage", "Completed batches", "Input (q)", "Output (q)", "Rejected (q)", "Loss (q)", "Loss %", "Estimated", "Entered", "Approved", "Confirmed"],
        rows: STAGES.filter((s) => s !== "receipt" && s !== "output" && (s !== "precleaning" || st(s).length > 0)).map((s) => {
          const bs = st(s).filter((b) => b.output_kg !== null);
          const inKg = sum(bs, (b) => b.input_kg);
          const loss = sum(bs, (b) => b.loss_kg);
          const c = (q: string) => bs.filter((b) => b.output_qty_status === q).length;
          return [STAGE_META[s].label, bs.length, qtl(inKg), qtl(sum(bs, (b) => b.output_kg)), qtl(sum(bs, (b) => b.rejected_kg)), qtl(loss), pct(loss, inKg), c("estimated"), c("entered"), c("approved"), c("confirmed")];
        }),
      };
    case "operator": {
      const { data: ev } = await supabase.from("batch_events").select("user_id, event_type, qty_kg").gte("at", fromIso).lte("at", toIso).limit(10000);
      const users = [...new Set((ev ?? []).map((e) => e.user_id))];
      return {
        title: "Operator activity",
        columns: ["User", "Actions", "Batches started", "Batches completed", "Outputs recorded", "Corrections", "Cancellations", "Quantity handled (q)"],
        rows: users.map((u) => {
          const es = (ev ?? []).filter((e) => e.user_id === u);
          const n = (t: string) => es.filter((e) => e.event_type === t).length;
          return [
            m.userName(u), es.length, n("started") + n("received"), n("completed"), n("output_recorded"), n("corrected"), n("cancelled"),
            qtl(es.filter((e) => ["started", "received"].includes(e.event_type)).reduce((a, e) => a + Number(e.qty_kg ?? 0), 0)),
          ];
        }),
      };
    }
    case "genealogy": {
      const ids = all.map((b) => b.id);
      const { data: edges } = ids.length ? await supabase.from("batch_inputs").select("child_id, parent_id, qty_kg").in("child_id", ids) : { data: [] };
      const pIds = [...new Set((edges ?? []).map((e) => e.parent_id))];
      const { data: parents } = pIds.length ? await supabase.from("production_batches").select("id, batch_no").in("id", pIds) : { data: [] };
      const pNo = new Map((parents ?? []).map((p) => [p.id, p.batch_no]));
      return {
        title: "Batch genealogy",
        columns: ["Batch", "Stage", "Equipment / grade", "Status", "Started", "Ended", "Input (q)", "Output (q)", "Came from (batch: q)"],
        rows: all.map((b) => [
          b.batch_no, STAGE_META[b.stage].label, b.grade_id ? (m.gradeById.get(b.grade_id)?.name ?? "") : eqName(b), b.status, istTime(b.started_at), istTime(b.ended_at),
          qtl(b.input_kg), qtl(b.output_kg),
          (edges ?? []).filter((e) => e.child_id === b.id).map((e) => `${pNo.get(e.parent_id)}: ${qtl(e.qty_kg)}`).join("; "),
        ]),
      };
    }
    case "truck": {
      const receipts = all.filter((b) => b.stage === "receipt").slice(0, 150);
      const rows: Report["rows"] = [];
      for (const r of receipts) {
        const { data: desc } = await supabase.rpc("trace_descendants", { p_id: r.id });
        const ids = [...new Set((desc ?? []).map((d: { batch_id: string }) => d.batch_id))];
        const { data: kids } = ids.length ? await supabase.from("production_batches").select(BATCH_COLUMNS).in("id", ids) : { data: [] };
        const ks = ((kids ?? []) as Batch[]).filter((k) => k.status !== "cancelled");
        const tanks = ks.filter((k) => k.stage === "soaking").map((k) => m.equipmentById.get(k.equipment_id!)?.number).sort().join("+");
        const dryers = ks.filter((k) => k.stage === "drying").map((k) => m.equipmentById.get(k.equipment_id!)?.number).join("+");
        const outs = ks.filter((k) => k.stage === "output");
        const s = r.source_snapshot ?? {};
        rows.push([
          r.batch_no, s.rst as number, String(s.rst_cycle ?? ""), String(s.vehicle_no ?? ""), String(s.supplier ?? ""), String(s.variety ?? ""), istTime(String(s.weighed_at ?? "")),
          qtl(r.output_kg), tanks, dryers,
          ks.filter((k) => k.stage === "milling").map((k) => k.batch_no).join(" "),
          qtl(sum(outs, (b) => b.output_kg)),
          m.grades.map((g) => { const kg = sum(outs.filter((o) => o.grade_id === g.id), (b) => b.output_kg); return kg ? `${g.name} ${qtl(kg)}` : ""; }).filter(Boolean).join("; "),
          r.status === "cancelled" ? "cancelled" : outs.length ? "rice produced" : "in process",
        ]);
      }
      return {
        title: "Truck-to-rice traceability",
        note: "Rice totals include every output that drew from the truck. When trucks are mixed in one tank, shared batches appear under each truck.",
        columns: ["Receipt", "RST", "RST cycle", "Vehicle", "Supplier", "Variety", "Weighed", "Received (q)", "Soaking tanks", "Dryers", "Milling batches", "Rice traced (q)", "By grade (q)", "Status"],
        rows,
      };
    }
  }
}

export function toCsv(r: Report) {
  const cell = (v: string | number | null) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 correctly.
  return "﻿" + [r.columns, ...r.rows].map((row) => row.map(cell).join(",")).join("\r\n");
}
