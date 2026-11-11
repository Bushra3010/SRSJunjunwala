"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { back, optStr, str } from "@/lib/actions";

const uuid = z.string().uuid();
const optUuid = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .pipe(uuid.nullable());

const InboundLine = z.object({
  variety_id: uuid,
  po_line_id: optUuid,
  moisture_pct: z.coerce.number().min(0).max(60),
  sacks_received: z.coerce.number().int().positive(),
  returned_sacks: z.coerce.number().int().min(0),
  rejected_bags: z.coerce.number().int().min(0),
});

const OutboundLine = z.object({
  variety_id: uuid,
  so_line_id: optUuid,
  bags: z.coerce.number().int().positive(),
  bag_weight_kg: z.coerce.number().positive(),
  lot_no: z
    .string()
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
});

function parseLines<T>(raw: string, schema: z.ZodType<T>): { lines?: T[]; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw || "[]");
  } catch {
    return { error: "Could not read the variety lines" };
  }
  const result = z.array(schema).safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { error: `Line ${Number(issue?.path[0] ?? 0) + 1}: ${issue?.path.slice(1).join(".")} ${issue?.message}` };
  }
  return { lines: result.data };
}

export async function openQc(fd: FormData) {
  const ticketId = str(fd, "ticket_id");
  const direction = str(fd, "direction") === "outbound" ? "outbound" : "inbound";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(direction === "inbound" ? "start_qc_inbound" : "start_qc_outbound", { p_ticket: ticketId });
  if (error) back(`/qc?tab=${direction}`, { error });
  revalidatePath("/qc");
  redirect(`/qc/${direction}/${data}`);
}

export async function saveInboundDraft(fd: FormData) {
  return saveInbound(fd, "draft");
}

export async function submitInbound(fd: FormData) {
  return saveInbound(fd, "submit");
}

async function saveInbound(fd: FormData, intent: "draft" | "submit") {
  const id = str(fd, "id");
  const path = `/qc/inbound/${id}`;
  const parsed = parseLines(str(fd, "lines_json"), InboundLine);
  if (parsed.error) back(path, { error: parsed.error });
  const lines = parsed.lines!;
  for (const [i, l] of lines.entries()) {
    if (l.returned_sacks + l.rejected_bags > l.sacks_received)
      back(path, { error: `Line ${i + 1}: returned + rejected cannot exceed sacks received` });
  }

  const supabase = await createClient();
  const { error: hErr } = await supabase
    .from("qc_inbound")
    .update({
      supplier_id: optStr(fd, "supplier_id"),
      broker_id: optStr(fd, "broker_id"),
      location_id: optStr(fd, "location_id"),
      notes: optStr(fd, "notes"),
    })
    .eq("id", id);
  if (hErr) back(path, { error: hErr });

  const { error: dErr } = await supabase.from("qc_inbound_lines").delete().eq("qc_id", id);
  if (dErr) back(path, { error: dErr });
  if (lines.length) {
    const { error: iErr } = await supabase
      .from("qc_inbound_lines")
      .insert(lines.map((l, i) => ({ ...l, qc_id: id, line_no: i + 1 })));
    if (iErr) back(path, { error: iErr });
  }

  if (intent === "submit") {
    const { error } = await supabase.rpc("submit_qc_inbound", { p_id: id });
    if (error) back(path, { error });
    revalidatePath("/qc");
    back(path, { notice: "Submitted for review" });
  }
  revalidatePath(path);
  back(path, { notice: "Draft saved" });
}

export async function saveOutboundDraft(fd: FormData) {
  return saveOutbound(fd, "draft");
}

export async function submitOutbound(fd: FormData) {
  return saveOutbound(fd, "submit");
}

async function saveOutbound(fd: FormData, intent: "draft" | "submit") {
  const id = str(fd, "id");
  const path = `/qc/outbound/${id}`;
  const parsed = parseLines(str(fd, "lines_json"), OutboundLine);
  if (parsed.error) back(path, { error: parsed.error });
  const lines = parsed.lines!;

  const supabase = await createClient();
  const { error: hErr } = await supabase
    .from("qc_outbound")
    .update({
      location_id: optStr(fd, "location_id"),
      driver_name: optStr(fd, "driver_name"),
      driver_phone: optStr(fd, "driver_phone"),
      notes: optStr(fd, "notes"),
    })
    .eq("id", id);
  if (hErr) back(path, { error: hErr });

  const { error: dErr } = await supabase.from("qc_outbound_lines").delete().eq("qc_id", id);
  if (dErr) back(path, { error: dErr });
  if (lines.length) {
    const { error: iErr } = await supabase
      .from("qc_outbound_lines")
      .insert(lines.map((l, i) => ({ ...l, qc_id: id, line_no: i + 1 })));
    if (iErr) back(path, { error: iErr });
  }

  if (intent === "submit") {
    const { error } = await supabase.rpc("submit_qc_outbound", { p_id: id });
    if (error) back(path, { error });
    revalidatePath("/qc");
    back(path, { notice: "Submitted for review" });
  }
  revalidatePath(path);
  back(path, { notice: "Draft saved" });
}

/** Reviewer / correction actions shared by inbound and outbound. */
export async function qcAction(fd: FormData) {
  const id = str(fd, "id");
  const direction = str(fd, "direction") === "outbound" ? "outbound" : "inbound";
  const action = str(fd, "op");
  const reason = str(fd, "reason");
  const path = `/qc/${direction}/${id}`;
  const supabase = await createClient();

  let rpc: string;
  let args: Record<string, unknown> = { p_id: id };
  let notice: string;
  switch (action) {
    case "post":
      rpc = `post_qc_${direction}`;
      if (direction === "outbound" && reason) args = { ...args, p_override_reason: reason };
      notice = "Posted — order balance and stock updated";
      break;
    case "return":
      rpc = `return_qc_${direction}`;
      args = { ...args, p_reason: reason };
      notice = "Returned to draft";
      break;
    case "reverse":
      rpc = `reverse_qc_${direction}`;
      args = { ...args, p_reason: reason };
      notice = "Reversed. Stock and order balances restored; start a corrected QC from the queue.";
      break;
    case "cancel":
      rpc = `cancel_qc_${direction}`;
      args = { ...args, p_reason: reason };
      notice = "QC record cancelled; ticket is back in the queue";
      break;
    default:
      back(path, { error: "Unknown action" });
  }
  if (action !== "post" && !reason) back(path, { error: "A reason is required" });

  const { error } = await supabase.rpc(rpc, args);
  if (error) back(path, { error });
  revalidatePath("/qc");
  revalidatePath("/");
  back(path, { notice });
}
