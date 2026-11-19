"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { back, str } from "@/lib/actions";

// Permanent deletes for the administrator. The database checks the role, refuses entries used in
// production or exported to Tally, and keeps a full copy of what was deleted in the audit log.

function confirmFields(fd: FormData) {
  const back_ = str(fd, "back") || "/";
  if (str(fd, "confirm").toUpperCase() !== "DELETE") back(str(fd, "here") || back_, { error: "Type DELETE to confirm" });
  if (!str(fd, "reason")) back(str(fd, "here") || back_, { error: "Give a reason for deleting" });
  return { back: back_, here: str(fd, "here") || back_, reason: str(fd, "reason") };
}

function refresh() {
  for (const p of ["/", "/weighbridge", "/qc", "/purchase-slips", "/accounts", "/accounts/payments", "/inventory"]) revalidatePath(p);
}

export async function deleteTruck(fd: FormData) {
  const c = confirmFields(fd);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_delete_truck", { p_ticket: str(fd, "id"), p_reason: c.reason });
  if (error) back(c.here, { error });
  refresh();
  const r = data as { rst: number; vehicle_no: string; qc: number; stock_rows: number; slips: number; payments: number };
  back(c.back, {
    notice: `Deleted RST ${r.rst} (${r.vehicle_no}) with ${r.qc} QC record(s), ${r.stock_rows} stock row(s), ${r.slips} slip(s) and ${r.payments} payment(s)`,
  });
}

export async function deleteSlip(fd: FormData) {
  const c = confirmFields(fd);
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_slip", { p_slip: str(fd, "id"), p_reason: c.reason });
  if (error) back(c.here, { error });
  refresh();
  back(c.back, { notice: `Slip ${str(fd, "label")} deleted` });
}

export async function deletePayment(fd: FormData) {
  const c = confirmFields(fd);
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_delete_payment", { p_payment: str(fd, "id"), p_reason: c.reason });
  if (error) back(c.here, { error });
  refresh();
  back(c.back, { notice: `${str(fd, "label")} deleted` });
}
