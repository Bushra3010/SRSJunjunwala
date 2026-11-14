"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { back, optStr, str } from "@/lib/actions";
import { istInput } from "@/lib/production";

/** Floor quantities are entered in quintals; the database stores kg. */
function qtl(fd: FormData, key: string): number | null {
  const v = str(fd, key);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100 * 100) / 100 : NaN;
}

function backPath(fd: FormData, fallback: string) {
  const p = str(fd, "back");
  return p.startsWith("/production") ? p : fallback;
}

function done(path: string, notice: string): never {
  revalidatePath("/production", "layout");
  back(path, { notice });
}

export async function createReceipt(fd: FormData) {
  const path = backPath(fd, "/production/receipts");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_receipt_batch", {
    p_qc_line: str(fd, "qc_line_id"),
    p_request: optStr(fd, "request_id"),
    p_remarks: optStr(fd, "remarks"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `Truck receipt ${b?.batch_no} created and paddy issued to production`);
}

export async function startBatch(fd: FormData) {
  const stage = str(fd, "stage");
  const path = backPath(fd, `/production`);
  const picked = fd.getAll("pick").map(String);
  if (!picked.length) back(path, { error: "Select at least one input batch" });
  const inputs = picked.map((id) => {
    const qty = qtl(fd, `qty_${id}`);
    return { batch_id: id, qty_kg: qty };
  });
  if (inputs.some((i) => Number.isNaN(i.qty_kg))) back(path, { error: "Quantities must be numbers" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_production_batch", {
    p_stage: stage,
    p_equipment: optStr(fd, "equipment_id"),
    p_inputs: inputs,
    p_started_at: istInput(str(fd, "started_at")),
    p_request: optStr(fd, "request_id"),
    p_remarks: optStr(fd, "remarks"),
    p_authorization: optStr(fd, "authorization"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `${b?.batch_no} started`);
}

export async function completeBatch(fd: FormData) {
  const path = backPath(fd, "/production");
  const out = qtl(fd, "output_q");
  const rej = qtl(fd, "rejected_q") ?? 0;
  const moisture = str(fd, "moisture_pct");
  if (Number.isNaN(out) || Number.isNaN(rej) || (moisture && !Number.isFinite(Number(moisture)))) back(path, { error: "Quantities must be numbers" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_production_batch", {
    p_id: str(fd, "id"),
    p_output_kg: out,
    p_rejected_kg: rej,
    p_moisture_pct: moisture ? Number(moisture) : null,
    p_ended_at: istInput(str(fd, "ended_at")),
    p_remarks: optStr(fd, "remarks"),
  });
  if (error) back(path, { error });
  done(path, `${str(fd, "batch_no")} completed${out === null ? " — output carried as an estimate" : ""}`);
}

export async function millingStep(fd: FormData) {
  const path = backPath(fd, "/production/milling");
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_milling_step", {
    p_batch: str(fd, "id"),
    p_step: str(fd, "step"),
    p_action: str(fd, "action_type"),
    p_at: istInput(str(fd, "at")),
    p_note: optStr(fd, "note"),
  });
  if (error) back(path, { error });
  done(path, `${str(fd, "step")} ${str(fd, "action_type") === "start" ? "started" : "ended"}`);
}

export async function recordOutput(fd: FormData) {
  const path = backPath(fd, "/production/outputs");
  const qty = qtl(fd, "qty_q");
  if (qty === null || Number.isNaN(qty)) back(path, { error: "Enter the output quantity in quintals" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_production_output", {
    p_milling: str(fd, "milling_id"),
    p_grade: str(fd, "grade_id"),
    p_qty_kg: qty,
    p_produced_at: istInput(str(fd, "produced_at")),
    p_request: optStr(fd, "request_id"),
    p_remarks: optStr(fd, "remarks"),
    p_authorization: optStr(fd, "authorization"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `Output ${b?.batch_no} recorded`);
}

export async function approveQuantity(fd: FormData) {
  const path = backPath(fd, "/production");
  const supabase = await createClient();
  const { error } = await supabase.rpc("approve_batch_quantity", { p_id: str(fd, "id"), p_note: optStr(fd, "note") });
  if (error) back(path, { error });
  done(path, `${str(fd, "batch_no")} quantity approved`);
}

export async function confirmOutput(fd: FormData) {
  const path = backPath(fd, "/production/outputs");
  const qty = qtl(fd, "qty_q");
  if (Number.isNaN(qty)) back(path, { error: "Quantity must be a number" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_production_output", {
    p_id: str(fd, "id"),
    p_location: str(fd, "location_id"),
    p_qty_kg: qty,
    p_note: optStr(fd, "note"),
  });
  if (error) back(path, { error });
  done(path, `${str(fd, "batch_no")} confirmed and received into stock`);
}

export async function setQuality(fd: FormData) {
  const path = backPath(fd, "/production");
  const moisture = str(fd, "moisture_pct");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_batch_quality", {
    p_id: str(fd, "id"),
    p_moisture_pct: moisture ? Number(moisture) : null,
    p_quality: optStr(fd, "quality_status"),
    p_note: optStr(fd, "note"),
  });
  if (error) back(path, { error });
  done(path, `Quality recorded for ${str(fd, "batch_no")}`);
}

export async function correctQuantity(fd: FormData) {
  const path = backPath(fd, "/production");
  const v = qtl(fd, "new_q");
  if (v === null || Number.isNaN(v)) back(path, { error: "Enter the corrected quantity in quintals" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_batch_quantity", {
    p_id: str(fd, "id"),
    p_field: str(fd, "field"),
    p_new: v,
    p_reason: str(fd, "reason"),
  });
  if (error) back(path, { error });
  done(path, `${str(fd, "batch_no")} corrected; the original value is kept in the history`);
}

export async function cancelBatch(fd: FormData) {
  const path = backPath(fd, "/production");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_production_batch", { p_id: str(fd, "id"), p_reason: str(fd, "reason") });
  if (error) back(path, { error });
  done(path, `${str(fd, "batch_no")} cancelled; it stays searchable`);
}

export async function reportFault(fd: FormData) {
  const path = backPath(fd, "/production/faults");
  const supabase = await createClient();
  const { error } = await supabase.rpc("report_production_fault", {
    p_equipment: optStr(fd, "equipment_id"),
    p_batch: optStr(fd, "batch_id"),
    p_severity: str(fd, "severity") || "medium",
    p_description: str(fd, "description"),
    p_started_at: istInput(str(fd, "started_at")),
  });
  if (error) back(path, { error });
  done(path, "Fault reported");
}

export async function resolveFault(fd: FormData) {
  const path = backPath(fd, "/production/faults");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_production_fault", {
    p_id: str(fd, "id"),
    p_resolution: str(fd, "resolution"),
    p_ended_at: istInput(str(fd, "ended_at")),
  });
  if (error) back(path, { error });
  done(path, "Fault resolved");
}

/** Load a soaking tank straight from trucks. Picks are "qc:<qc line id>" (truck not yet in production) or "b:<receipt batch id>". */
export async function startSoaking(fd: FormData) {
  const path = backPath(fd, "/production/soaking");
  const picked = fd.getAll("pick").map(String);
  if (!picked.length) back(path, { error: "Select at least one truck" });
  const inputs = picked.map((p) => {
    const [kind, id] = p.split(":");
    const qty = qtl(fd, `qty_${p}`);
    return kind === "qc" ? { qc_line_id: id, qty_kg: qty } : { batch_id: id, qty_kg: qty };
  });
  if (inputs.some((i) => i.qty_kg === null || Number.isNaN(i.qty_kg))) back(path, { error: "Enter the quantity for each truck in quintals" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_soaking_from_trucks", {
    p_tank: str(fd, "equipment_id"),
    p_inputs: inputs,
    p_started_at: istInput(str(fd, "started_at")),
    p_request: optStr(fd, "request_id"),
    p_remarks: optStr(fd, "remarks"),
    p_authorization: optStr(fd, "authorization"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `${b?.batch_no} soaking started`);
}

/** Steaming done: the lot goes straight into the dryer chosen when it started. */
export async function finishSteaming(fd: FormData) {
  const path = backPath(fd, "/production/steaming");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finish_steaming_to_dryer", {
    p_lot: str(fd, "id"),
    p_ended_at: istInput(str(fd, "ended_at")),
    p_remarks: optStr(fd, "remarks"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `${str(fd, "batch_no")} steamed and loaded into the dryer as ${b?.batch_no}`);
}

/** Start a steaming lot from any finished soaking tanks into a chosen free dryer. */
export async function startSteamingLot(fd: FormData) {
  const path = backPath(fd, "/production/steaming");
  const tanks = fd.getAll("pick").map(String).filter(Boolean);
  if (!tanks.length) back(path, { error: "Tick at least one finished soaking tank" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_steaming_lot", {
    p_soaking: tanks,
    p_dryer: str(fd, "dryer_id"),
    p_started_at: istInput(str(fd, "started_at")),
    p_request: optStr(fd, "request_id"),
    p_remarks: optStr(fd, "remarks"),
  });
  if (error) back(path, { error });
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  done(path, `Lot ${b?.batch_no} steaming started`);
}
