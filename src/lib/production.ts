import "server-only";
import { createClient } from "@/lib/supabase/server";

export type Stage = "receipt" | "precleaning" | "soaking" | "steaming" | "drying" | "mill_feed" | "milling" | "output";
export type BatchStatus = "running" | "completed" | "consumed" | "cancelled";
export type QtyStatus = "estimated" | "entered" | "approved" | "confirmed";

export const STAGES: Stage[] = ["receipt", "precleaning", "soaking", "steaming", "drying", "mill_feed", "milling", "output"];

export const STAGE_META: Record<Stage, { label: string; local?: string; prefix: string; href: string; color: string; parent?: Stage }> = {
  receipt: { label: "Truck receipt", local: "Houdi", prefix: "RCV", href: "/production/receipts", color: "#4b5563" },
  precleaning: { label: "Pre-cleaning", prefix: "PC", href: "/production/precleaning", color: "#6f7d1e", parent: "receipt" },
  soaking: { label: "Soaking", local: "Kachi", prefix: "SOAK", href: "/production/soaking", color: "#1f7f86", parent: "precleaning" },
  steaming: { label: "Steaming", local: "Pakki", prefix: "STM", href: "/production/steaming", color: "#b5532f", parent: "soaking" },
  drying: { label: "Drying", prefix: "DRY", href: "/production/drying", color: "#c08a24", parent: "steaming" },
  mill_feed: { label: "Mill feed", prefix: "MFD", href: "/production/mill-feed", color: "#7b4f8e", parent: "drying" },
  milling: { label: "Milling", prefix: "MIL", href: "/production/milling", color: "#3e6fc0", parent: "mill_feed" },
  output: { label: "Final output", prefix: "OUT", href: "/production/outputs", color: "#1f6b32", parent: "milling" },
};

export const MILL_STEPS = ["cleaning", "dehusking", "whitener", "silky", "sortex", "grading"] as const;

export type Batch = {
  id: string;
  batch_no: string;
  stage: Stage;
  status: BatchStatus;
  equipment_id: string | null;
  pair_no: number | null;
  variety_id: string | null;
  grade_id: string | null;
  input_kg: number | null;
  output_kg: number | null;
  rejected_kg: number;
  loss_kg: number | null;
  output_qty_status: QtyStatus | null;
  moisture_pct: number | null;
  quality_status: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  operator_id: string | null;
  completed_by: string | null;
  approved_at: string | null;
  confirmed_at: string | null;
  source_snapshot: Record<string, string | number | null> | null;
  stock_location_id: string | null;
  authorization_reason: string | null;
  cancel_reason: string | null;
  cancelled_at: string | null;
  remarks: string | null;
  created_at: string;
};

export type Equipment = {
  id: string;
  kind: "precleaner" | "soaking_tank" | "steamer" | "dryer" | "mill_feed_tank" | "mill_line";
  code: string;
  name: string;
  number: number | null;
  pair_no: number | null;
  capacity_min_kg: number | null;
  capacity_max_kg: number | null;
  expected_hours_min: number | null;
  expected_hours_max: number | null;
};

export type TimelineEvent = {
  event_id: number;
  at: string;
  batch_id: string;
  batch_no: string;
  stage: Stage;
  event_type: string;
  qty_kg: number | null;
  user_name: string | null;
  note: string | null;
  related_batch_no: string | null;
};

export const BATCH_COLUMNS =
  "id, batch_no, stage, status, equipment_id, pair_no, variety_id, grade_id, input_kg, output_kg, rejected_kg, loss_kg, output_qty_status, moisture_pct, quality_status, started_at, ended_at, duration_minutes, operator_id, completed_by, approved_at, confirmed_at, source_snapshot, stock_location_id, authorization_reason, cancel_reason, cancelled_at, remarks, created_at";

/** Quintals, the unit the plant floor talks in (1 q = 100 kg). */
export function q(kg: number | string | null | undefined, digits = 2) {
  if (kg === null || kg === undefined || kg === "") return "—";
  return `${(Number(kg) / 100).toLocaleString("en-IN", { maximumFractionDigits: digits })} q`;
}

export function hours(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m ? `${m} min` : ""}`.trim() : `${m} min`;
}

export function eventLabel(type: string) {
  const map: Record<string, string> = {
    received: "Truck received",
    created: "Batch created",
    started: "Started",
    completed: "Completed",
    transferred_out: "Material transferred out",
    fully_consumed: "Fully moved to next stage",
    material_released: "Material released back",
    material_returned: "Material returned (child cancelled)",
    output_recorded: "Final output recorded",
    quantity_approved: "Quantity approved",
    quantity_confirmed: "Quantity physically confirmed",
    quality_recorded: "Quality recorded",
    corrected: "Authorised correction",
    cancelled: "Cancelled",
    fault_reported: "Fault reported",
    fault_resolved: "Fault resolved",
  };
  if (map[type]) return map[type];
  const m = type.match(/^(\w+)_(started|completed)$/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
  return type.replace(/_/g, " ");
}

/** Parse a datetime-local value as IST. Empty → null (the database uses now()). */
export function istInput(value: string | null | undefined) {
  if (!value) return null;
  return new Date(`${value}:00+05:30`).toISOString();
}

/** Current IST time formatted for <input type="datetime-local">. */
export function nowLocalInput() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" }).format(new Date()).replace(" ", "T");
}

export async function loadMasters() {
  const supabase = await createClient();
  const [eq, grades, varieties, profiles] = await Promise.all([
    supabase.from("production_equipment").select("*").eq("active", true).order("kind").order("number"),
    supabase.from("rice_grades").select("id, code, name, reference_pct, sort_order").eq("active", true).order("sort_order"),
    supabase.from("varieties").select("id, code, name"),
    supabase.from("profiles").select("id, full_name, email"),
  ]);
  const equipment = (eq.data ?? []) as Equipment[];
  return {
    supabase,
    equipment,
    equipmentById: new Map(equipment.map((e) => [e.id, e])),
    grades: (grades.data ?? []) as { id: string; code: string; name: string; reference_pct: number | null; sort_order: number }[],
    gradeById: new Map((grades.data ?? []).map((g) => [g.id, g])),
    varietyById: new Map((varieties.data ?? []).map((v) => [v.id, v])),
    userName: (id: string | null | undefined) => {
      if (!id) return "—";
      const p = (profiles.data ?? []).find((x) => x.id === id);
      return p ? p.full_name || p.email || "—" : "—";
    },
  };
}

/** Available (not yet passed on) quantity for each batch id. */
export async function availability(ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const supabase = await createClient();
  const { data } = await supabase.from("production_batch_balances").select("id, available_kg").in("id", ids);
  return new Map((data ?? []).map((r) => [r.id as string, Number(r.available_kg)]));
}

/** Resolve a batch by uuid or readable batch number. */
export async function findBatch(idOrNo: string) {
  const supabase = await createClient();
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrNo);
  const { data } = await supabase
    .from("production_batches")
    .select(BATCH_COLUMNS)
    .eq(isUuid ? "id" : "batch_no", isUuid ? idOrNo : idOrNo.toUpperCase())
    .maybeSingle<Batch>();
  return data;
}

export type TraceEdge = { batch_id: string; child_id?: string; parent_id?: string; qty_kg: number; depth: number };

/** Full genealogy of a batch: ancestors, descendants (edges + batches) and timeline. */
export async function traceBatch(batchId: string) {
  const supabase = await createClient();
  const [a, d, t] = await Promise.all([
    supabase.rpc("trace_ancestors", { p_id: batchId }),
    supabase.rpc("trace_descendants", { p_id: batchId }),
    supabase.rpc("trace_timeline", { p_id: batchId }),
  ]);
  const ancestors = (a.data ?? []) as TraceEdge[];
  const descendants = (d.data ?? []) as TraceEdge[];
  const ids = [...new Set([batchId, ...ancestors.map((e) => e.batch_id), ...descendants.map((e) => e.batch_id)])];
  const { data: rows } = await supabase.from("production_batches").select(BATCH_COLUMNS).in("id", ids);
  const batches = new Map(((rows ?? []) as Batch[]).map((b) => [b.id, b]));
  return {
    ancestors,
    descendants,
    batches,
    timeline: (t.data ?? []) as TimelineEvent[],
    error: a.error ?? d.error ?? t.error ?? null,
  };
}

export type StageSP = { q?: string; status?: string; from?: string; to?: string; error?: string; notice?: string };

/** History list for one stage with the shared filters. */
export async function stageHistory(stage: Stage, sp: StageSP, limit = 150) {
  const supabase = await createClient();
  let query = supabase.from("production_batches").select(BATCH_COLUMNS).eq("stage", stage).order("created_at", { ascending: false }).limit(limit);
  if (sp.q) query = query.ilike("batch_no", `%${sp.q.trim()}%`);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.from) query = query.gte("started_at", new Date(`${sp.from}T00:00:00+05:30`).toISOString());
  if (sp.to) query = query.lte("started_at", new Date(`${sp.to}T23:59:59+05:30`).toISOString());
  const { data, error } = await query;
  return { batches: (data ?? []) as Batch[], error };
}

/** Batches of a stage that are finished and still have material for the next stage. */
export async function readyBatches(stage: Stage) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("production_batches")
    .select(BATCH_COLUMNS)
    .eq("stage", stage)
    .eq("status", "completed")
    .order("ended_at", { ascending: true })
    .limit(200);
  const rows = (data ?? []) as Batch[];
  const avail = await availability(rows.map((r) => r.id));
  return rows.map((b) => ({ batch: b, available: avail.get(b.id) ?? 0 })).filter((c) => c.available > 0);
}

/** Running / holding batch per piece of equipment, plus its available quantity. */
export async function equipmentState(equipmentIds: string[]) {
  if (!equipmentIds.length) return new Map<string, { batch: Batch; available: number }>();
  const supabase = await createClient();
  const { data } = await supabase
    .from("production_batches")
    .select(BATCH_COLUMNS)
    .in("equipment_id", equipmentIds)
    .in("status", ["running", "completed"])
    .order("created_at", { ascending: false });
  const rows = (data ?? []) as Batch[];
  const avail = await availability(rows.map((r) => r.id));
  const out = new Map<string, { batch: Batch; available: number }>();
  for (const b of rows) {
    const a = avail.get(b.id) ?? 0;
    if (b.status === "completed" && a <= 0) continue;
    if (!out.has(b.equipment_id!)) out.set(b.equipment_id!, { batch: b, available: a });
  }
  return out;
}
