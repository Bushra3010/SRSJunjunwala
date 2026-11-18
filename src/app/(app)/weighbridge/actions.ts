"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPlantId } from "@/lib/auth";
import { back, optNum, optStr, str } from "@/lib/actions";

export async function captureTicket(fd: FormData) {
  const rst = Number(str(fd, "rst"));
  const vehicle = str(fd, "vehicle_no");
  const direction = str(fd, "direction");
  const gross = optNum(fd, "gross_kg");
  const tare = optNum(fd, "tare_kg");
  const weighedAt = str(fd, "weighed_at");

  if (!Number.isInteger(rst) || rst <= 0) back("/weighbridge/capture", { error: "RST must be a positive whole number" });
  if (!vehicle) back("/weighbridge/capture", { error: "Vehicle number is required" });
  if (direction !== "inbound" && direction !== "outbound") back("/weighbridge/capture", { error: "Choose inbound or outbound" });
  if (Number.isNaN(gross) || Number.isNaN(tare)) back("/weighbridge/capture", { error: "Weights must be numbers" });
  if (gross === null && tare === null) back("/weighbridge/capture", { error: "Enter at least the first weight" });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("weighbridge_tickets")
    .insert({
      plant_id: await getPlantId(),
      rst,
      vehicle_no: vehicle,
      vehicle_type: optStr(fd, "vehicle_type"),
      direction,
      gross_kg: gross,
      tare_kg: tare,
      ticket_ref: optStr(fd, "ticket_ref"),
      weighed_at: weighedAt ? new Date(`${weighedAt}:00+05:30`).toISOString() : new Date().toISOString(),
      capture_method: "manual",
      source_payload: optStr(fd, "source_payload"),
    })
    .select("id, pid, status, exception_reason")
    .single();

  if (error) back("/weighbridge/capture", { error });
  revalidatePath("/weighbridge");
  revalidatePath("/");
  const notice =
    data.status === "awaiting_qc"
      ? `Ticket ${data.pid} captured — awaiting QC`
      : `Ticket ${data.pid} saved as ${data.status}: ${data.exception_reason}`;
  redirect(`/weighbridge?id=${data.id}&notice=${encodeURIComponent(notice)}`);
}

export async function completeWeighing(fd: FormData) {
  const id = str(fd, "id");
  const gross = optNum(fd, "gross_kg");
  const tare = optNum(fd, "tare_kg");
  const path = `/weighbridge?id=${id}`;
  if (Number.isNaN(gross) || Number.isNaN(tare) || (gross === null && tare === null)) back(path, { error: "Enter the missing weight" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_weighing", { p_ticket: id, p_gross: gross, p_tare: tare });
  if (error) back(path, { error });
  revalidatePath("/weighbridge");
  back(path, { notice: "Second weighing recorded" });
}

export async function acceptTicket(fd: FormData) {
  return resolveTicket(fd, "accept");
}

export async function cancelTicket(fd: FormData) {
  return resolveTicket(fd, "cancel");
}

async function resolveTicket(fd: FormData, action: "accept" | "cancel") {
  const id = str(fd, "id");
  const note = str(fd, "note");
  const path = `/weighbridge?id=${id}`;
  if (!note) back(path, { error: "A resolution note is required" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_ticket", { p_ticket: id, p_action: action, p_note: note });
  if (error) back(path, { error });
  revalidatePath("/weighbridge");
  back(path, { notice: action === "cancel" ? "Ticket cancelled" : "Ticket accepted and released to QC" });
}

export async function startCycle(fd: FormData) {
  const label = str(fd, "label");
  const startsOn = str(fd, "starts_on");
  const path = "/weighbridge?tab=cycles";
  if (!label || !startsOn) back(path, { error: "Label and start date are required" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("start_rst_cycle", {
    p_plant: await getPlantId(),
    p_label: label,
    p_starts_on: startsOn,
    p_notes: optStr(fd, "notes"),
  });
  if (error) back(path, { error });
  revalidatePath("/weighbridge");
  back(path, { notice: `RST cycle ${label} started` });
}
