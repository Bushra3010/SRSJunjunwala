"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { back, optNum, optStr, str } from "@/lib/actions";
import { SLIP_SELECT, slipMessage, waPhone, type Slip, type SlipLine } from "@/lib/slips";
import { slipLink } from "@/lib/slips-server";
import { sendSlipTemplate } from "@/lib/whatsapp";

const page = (id: string) => `/purchase-slips/${id}`;

async function loadSlip(id: string) {
  const supabase = await createClient();
  const [{ data: slip }, { data: lines }] = await Promise.all([
    supabase.from("purchase_slips").select(SLIP_SELECT).eq("id", id).single(),
    supabase.from("purchase_slip_lines").select("*").eq("slip_id", id).order("sort_order"),
  ]);
  return { supabase, slip: slip as Slip | null, lines: (lines ?? []) as SlipLine[] };
}

/** Edit the header and deduction lines (admin / accountant). */
export async function saveSlip(fd: FormData) {
  const id = str(fd, "id");
  let header: Record<string, unknown> = {};
  let lines: unknown[] = [];
  try {
    header = JSON.parse(str(fd, "header_json") || "{}");
    lines = JSON.parse(str(fd, "lines_json") || "[]");
  } catch {
    back(page(id), { error: "Could not read the changes" });
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_purchase_slip", {
    p_slip: id,
    p_header: header,
    p_lines: lines,
    p_reason: optStr(fd, "reason"),
  });
  if (error) back(`${page(id)}?edit=1`, { error });
  revalidatePath(page(id));
  revalidatePath("/purchase-slips");
  back(page(id), { notice: "Slip updated" });
}

/** Fill in a deduction that comes after unloading (Khad). */
export async function enterDeduction(fd: FormData) {
  const id = str(fd, "id");
  const rate = optNum(fd, "rate");
  if (rate === null || Number.isNaN(rate)) back(page(id), { error: "Enter the value (0 if none)" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("enter_slip_deduction", { p_line: str(fd, "line_id"), p_rate: rate, p_note: optStr(fd, "note") });
  if (error) back(page(id), { error });
  revalidatePath(page(id));
  revalidatePath("/purchase-slips");
  back(str(fd, "back") || page(id), { notice: "Saved" });
}

export async function finalizeSlip(fd: FormData) {
  const id = str(fd, "id");
  const supabase = await createClient();
  const { error } = await supabase.rpc("finalize_purchase_slip", { p_slip: id });
  if (error) back(page(id), { error });
  revalidatePath(page(id));
  revalidatePath("/purchase-slips");
  back(page(id), { notice: "Slip is final" });
}

export async function cancelSlip(fd: FormData) {
  const id = str(fd, "id");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_purchase_slip", { p_slip: id, p_reason: str(fd, "reason") });
  if (error) back(page(id), { error });
  revalidatePath("/purchase-slips");
  back(page(id), { notice: "Slip cancelled" });
}

export async function rebuildSlip(fd: FormData) {
  const id = str(fd, "id");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("rebuild_purchase_slip", { p_qc: str(fd, "qc_id") });
  if (error) back(page(id), { error });
  revalidatePath("/purchase-slips");
  back(page(data as string), { notice: "New slip built from the QC with today's parameters" });
}

async function autoSend(id: string, channelNote: string) {
  const { supabase, slip } = await loadSlip(id);
  if (!slip) return { status: "failed", detail: "Slip not found" };
  const to = waPhone(slip.brokers?.phone);
  if (!slip.broker_id) return { status: "skipped", detail: "No broker on this slip" };
  if (!to) {
    await supabase.rpc("log_slip_send", { p_slip: id, p_channel: "whatsapp_auto", p_phone: slip.brokers?.phone ?? null, p_status: "failed", p_detail: "Broker has no valid mobile number" });
    return { status: "failed", detail: "Broker has no valid mobile number" };
  }
  const r = await sendSlipTemplate(to, slip, await slipLink(slip.share_token));
  await supabase.rpc("log_slip_send", { p_slip: id, p_channel: "whatsapp_auto", p_phone: to, p_status: r.status, p_detail: `${channelNote}: ${r.detail}` });
  return r;
}

/** Record the payment of the net payable; then send to the broker automatically if that is switched on. */
export async function paySlip(fd: FormData) {
  const id = str(fd, "id");
  const mode = str(fd, "mode");
  const supabase = await createClient();
  const { error } = await supabase.rpc("pay_purchase_slip", {
    p_slip: id,
    p_bank: mode === "Cash" ? null : optStr(fd, "bank_account_id"),
    p_mode: mode,
    p_reference: optStr(fd, "reference"),
    p_paid_on: str(fd, "paid_on"),
    p_request: str(fd, "request_id") || randomUUID(),
  });
  if (error) back(page(id), { error });
  revalidatePath("/purchase-slips");
  revalidatePath("/accounts");
  const { data: auto } = await supabase.from("calc_settings").select("value").eq("key", "slip_auto_whatsapp").maybeSingle();
  let notice = "Payment recorded";
  if (Number(auto?.value) === 1) {
    const r = await autoSend(id, "After payment");
    notice +=
      r.status === "sent" ? " and slip sent to the broker on WhatsApp" : r.status === "skipped" ? "" : ` — WhatsApp not sent: ${r.detail}`;
  }
  back(page(id), { notice });
}

/** Send now through the WhatsApp Business API. */
export async function sendSlipAuto(fd: FormData) {
  const id = str(fd, "id");
  const r = await autoSend(id, "Sent by hand");
  revalidatePath(page(id));
  if (r.status === "sent") back(page(id), { notice: "Sent to the broker on WhatsApp" });
  back(page(id), { error: `Not sent: ${r.detail}` });
}

/** Open WhatsApp with the slip text ready for the broker (the person presses Send in WhatsApp). */
export async function openWhatsApp(fd: FormData) {
  const id = str(fd, "id");
  const { supabase, slip, lines } = await loadSlip(id);
  if (!slip) back(page(id), { error: "Slip not found" });
  const to = waPhone(str(fd, "phone") || slip.brokers?.phone);
  const text = slipMessage(slip, lines, await slipLink(slip.share_token));
  const { error } = await supabase.rpc("log_slip_send", {
    p_slip: id,
    p_channel: "whatsapp_manual",
    p_phone: to,
    p_status: "opened",
    p_detail: to ? "WhatsApp opened with the slip" : "WhatsApp opened without a number",
  });
  if (error) back(page(id), { error });
  redirect(`https://wa.me/${to ?? ""}?text=${encodeURIComponent(text)}`);
}

/** Build the slip for a posted QC that has none (posted before slips existed, or the build failed). */
export async function buildSlip(fd: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("rebuild_purchase_slip", { p_qc: str(fd, "qc_id") });
  if (error) back("/purchase-slips", { error });
  revalidatePath("/purchase-slips");
  back(page(data as string), { notice: "Slip built from the posted QC" });
}
