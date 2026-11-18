"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { back, optStr, str } from "@/lib/actions";

export async function openPurchaseQc(fd: FormData) {
  const ticket = str(fd, "ticket_id");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_qc_inbound", { p_ticket: ticket });
  if (error) back(`/purchase-qc?q=${encodeURIComponent(str(fd, "q"))}`, { error });
  redirect(`/purchase-qc?qc=${data}`);
}

const Entry = z.object({
  variety_id: z.guid({ message: "Choose the variety" }),
  po_line_id: z
    .string()
    .optional()
    .transform((v) => v || null)
    .pipe(z.guid().nullable()),
  moisture_pct: z.coerce.number({ message: "Enter the moisture %" }).min(0).max(60, "Moisture must be 0–60%"),
  bag_status: z.enum(["received", "returned"], { message: "Choose Received or Returned" }),
  passed: z.coerce.number().int().min(0, "Passed bags cannot be negative"),
  rejected: z.coerce.number().int().min(0, "Rejected bags cannot be negative"),
  claim_amount: z.coerce.number().min(0, "Claim amount cannot be negative"),
});

export async function savePurchaseQc(fd: FormData) {
  const id = str(fd, "id");
  const path = `/purchase-qc?qc=${id}`;
  const intent = str(fd, "intent") === "draft" ? "draft" : "submit";
  const parsed = Entry.safeParse({
    variety_id: str(fd, "variety_id"),
    po_line_id: str(fd, "po_line_id"),
    moisture_pct: str(fd, "moisture_pct") === "" ? undefined : str(fd, "moisture_pct"),
    bag_status: str(fd, "bag_status") || undefined,
    passed: str(fd, "passed") || 0,
    rejected: str(fd, "rejected") || 0,
    claim_amount: str(fd, "claim_amount") || 0,
  });
  if (!parsed.success) back(path, { error: parsed.error.issues[0]?.message ?? "Check the entry" });
  const e = parsed.data;
  if (e.passed + e.rejected <= 0) back(path, { error: "Enter the number of bags (passed and rejected)" });
  if (intent === "submit" && !optStr(fd, "supplier_id")) back(path, { error: "Choose the party (or the sauda)" });
  if (intent === "submit" && !optStr(fd, "location_id")) back(path, { error: "Choose the unloading location" });

  const supabase = await createClient();
  const { error: hErr } = await supabase
    .from("qc_inbound")
    .update({
      supplier_id: optStr(fd, "supplier_id"),
      broker_id: optStr(fd, "broker_id"),
      location_id: optStr(fd, "location_id"),
      bag_status: e.bag_status,
      claim_details: optStr(fd, "claim_details"),
      claim_amount: e.claim_amount,
      notes: optStr(fd, "notes"),
    })
    .eq("id", id);
  if (hErr) back(path, { error: hErr });

  const { error: dErr } = await supabase.from("qc_inbound_lines").delete().eq("qc_id", id);
  if (dErr) back(path, { error: dErr });
  const { error: iErr } = await supabase.from("qc_inbound_lines").insert({
    qc_id: id,
    line_no: 1,
    variety_id: e.variety_id,
    po_line_id: e.po_line_id,
    moisture_pct: e.moisture_pct,
    sacks_received: e.passed + e.rejected,
    rejected_bags: e.rejected,
    returned_sacks: 0,
  });
  if (iErr) back(path, { error: iErr });

  if (intent === "submit") {
    const { error } = await supabase.rpc("submit_qc_inbound", { p_id: id });
    if (error) back(path, { error });
  }
  revalidatePath("/qc");
  revalidatePath("/purchase-qc");
  back(path, { notice: intent === "submit" ? "QC entry saved and sent for posting. The purchase slip is made when it is posted." : "Draft saved" });
}
