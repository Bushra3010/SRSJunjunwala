"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getPlantId } from "@/lib/auth";
import { back, optStr, str } from "@/lib/actions";

const Line = z.object({
  variety_id: z.string().uuid({ message: "choose a variety" }),
  ordered_kg: z.coerce.number().positive({ message: "quantity must be more than 0" }),
  rate_per_qtl: z
    .union([z.literal(""), z.coerce.number().min(0)])
    .transform((v) => (v === "" ? null : v)),
});

async function createOrder(kind: "purchase" | "sales", fd: FormData) {
  const base = kind === "purchase" ? "/purchase-orders" : "/sales-orders";
  const partyId = str(fd, "party_id");
  if (!partyId) back(`${base}/new`, { error: kind === "purchase" ? "Choose a supplier" : "Choose a customer" });

  let raw: unknown;
  try {
    raw = JSON.parse(str(fd, "lines_json") || "[]");
  } catch {
    back(`${base}/new`, { error: "Could not read order lines" });
  }
  const parsed = z.array(Line).min(1).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    back(`${base}/new`, { error: `Line ${Number(issue?.path[0] ?? 0) + 1}: ${issue?.message}` });
  }

  const supabase = await createClient();
  const header =
    kind === "purchase"
      ? {
          plant_id: await getPlantId(),
          supplier_id: partyId,
          broker_id: optStr(fd, "broker_id"),
          order_date: optStr(fd, "order_date") ?? undefined,
          expected_by: optStr(fd, "due"),
          notes: optStr(fd, "notes"),
        }
      : {
          plant_id: await getPlantId(),
          customer_id: partyId,
          order_date: optStr(fd, "order_date") ?? undefined,
          required_by: optStr(fd, "due"),
          notes: optStr(fd, "notes"),
        };

  const table = kind === "purchase" ? "purchase_orders" : "sales_orders";
  const { data: order, error } = await supabase.from(table).insert(header).select("id").single();
  if (error) back(`${base}/new`, { error });

  const fk = kind === "purchase" ? "po_id" : "so_id";
  const { error: lErr } = await supabase
    .from(kind === "purchase" ? "po_lines" : "so_lines")
    .insert(parsed.data!.map((l, i) => ({ ...l, [fk]: order.id, line_no: i + 1 })));
  if (lErr) {
    // Header without lines is useless; mark it cancelled so nothing is half-created.
    await supabase.from(table).update({ status: "cancelled", status_reason: "Line save failed" }).eq("id", order.id);
    back(`${base}/new`, { error: lErr });
  }
  revalidatePath(base);
  redirect(`${base}?id=${order.id}&notice=${encodeURIComponent("Order created")}`);
}

export async function createPurchaseOrder(fd: FormData) {
  return createOrder("purchase", fd);
}

export async function createSalesOrder(fd: FormData) {
  return createOrder("sales", fd);
}

export async function setOrderStatus(fd: FormData) {
  const kind = str(fd, "kind") === "sales" ? "sales" : "purchase";
  const id = str(fd, "id");
  const status = str(fd, "status");
  const reason = str(fd, "reason");
  const base = kind === "purchase" ? "/purchase-orders" : "/sales-orders";
  if (!["open", "closed", "cancelled"].includes(status)) back(`${base}?id=${id}`, { error: "Invalid status" });
  if (status !== "open" && !reason) back(`${base}?id=${id}`, { error: "A reason is required" });
  const supabase = await createClient();
  const { error } = await supabase
    .from(kind === "purchase" ? "purchase_orders" : "sales_orders")
    .update({ status, status_reason: reason || null })
    .eq("id", id);
  if (error) back(`${base}?id=${id}`, { error });
  revalidatePath(base);
  back(`${base}?id=${id}`, { notice: `Order ${status === "open" ? "reopened" : status}` });
}
