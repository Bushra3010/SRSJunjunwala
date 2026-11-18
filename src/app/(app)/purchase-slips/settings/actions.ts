"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { back, optNum, optStr, str } from "@/lib/actions";
import { ROLES } from "@/lib/roles";

const PATH = "/purchase-slips/settings";

function num(fd: FormData, key: string, label: string) {
  const v = optNum(fd, key);
  if (v === null || Number.isNaN(v) || v < 0) back(PATH, { error: `${label}: enter a number (0 or more)` });
  return v;
}

export async function saveMoisture(fd: FormData) {
  const supabase = await createClient();
  const pass = num(fd, "pass_pct", "Pass up to");
  const progressive = str(fd, "progressive") === "1" ? 1 : 0;
  for (const [key, value] of [
    ["slip_moisture_pass_pct", pass],
    ["slip_moisture_progressive", progressive],
  ] as const) {
    const { data, error } = await supabase.from("calc_settings").update({ value }).eq("key", key).select("key");
    if (error) back(PATH, { error });
    if (!data?.length) back(PATH, { error: "Only the administrator can change slip parameters" });
  }
  // Bands: rows slab_<id>_upto / slab_<id>_per; "new" row adds one; blank upto = "and above".
  const ids = [...new Set([...fd.keys()].filter((k) => k.startsWith("slab_")).map((k) => k.split("_")[1]))];
  for (const id of ids) {
    const uptoRaw = str(fd, `slab_${id}_upto`);
    const perRaw = str(fd, `slab_${id}_per`);
    const remove = str(fd, `slab_${id}_remove`) === "1";
    if (id === "new") {
      if (perRaw === "") continue;
      const { error } = await supabase.from("moisture_slabs").insert({ upto_pct: uptoRaw === "" ? null : Number(uptoRaw), per_point: Number(perRaw) });
      if (error) back(PATH, { error: error.message.includes("moisture_slabs_one_open") ? "Only one band can be open-ended (blank 'up to')." : error });
      continue;
    }
    if (remove) {
      const { error } = await supabase.from("moisture_slabs").delete().eq("id", id);
      if (error) back(PATH, { error });
      continue;
    }
    const { error } = await supabase
      .from("moisture_slabs")
      .update({ upto_pct: uptoRaw === "" ? null : Number(uptoRaw), per_point: Number(perRaw) })
      .eq("id", id);
    if (error) back(PATH, { error: error.message.includes("moisture_slabs_one_open") ? "Only one band can be open-ended (blank 'up to')." : error });
  }
  revalidatePath(PATH);
  back(PATH, { notice: "Moisture rules saved. New slips use them; existing slips keep their own." });
}

export async function saveDeductionType(fd: FormData) {
  const supabase = await createClient();
  const code = str(fd, "code");
  const roles = ROLES.filter((r) => fd.get(`role_${r}`) === "on");
  const row = {
    label: str(fd, "label"),
    value: optNum(fd, "value"),
    alt_value: optNum(fd, "alt_value"),
    entered_later: fd.get("entered_later") === "on",
    entry_roles: roles,
    sort_order: Number(str(fd, "sort_order") || 100),
    active: fd.get("active") === "on",
  };
  if (!row.label) back(PATH, { error: "Name is required" });
  if (Number.isNaN(row.value) || Number.isNaN(row.alt_value)) back(PATH, { error: "Values must be numbers" });
  const { data, error } = await supabase.from("purchase_deduction_types").update(row).eq("code", code).select("code");
  if (error) back(PATH, { error });
  if (!data?.length) back(PATH, { error: "Only the administrator can change slip parameters" });
  revalidatePath(PATH);
  back(PATH, { notice: `${row.label} saved` });
}

export async function addDeductionType(fd: FormData) {
  const supabase = await createClient();
  const label = str(fd, "label");
  const code =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "d$1")
      .slice(0, 30) || "";
  const basis = str(fd, "basis");
  if (!label || code.length < 2) back(PATH, { error: "Give the deduction a name" });
  if (!["percent", "per_qtl", "flat", "manual"].includes(basis)) back(PATH, { error: "Choose how it is calculated" });
  const value = optNum(fd, "value");
  if (Number.isNaN(value)) back(PATH, { error: "Value must be a number" });
  const { error } = await supabase.from("purchase_deduction_types").insert({
    code,
    label,
    basis,
    value,
    entered_later: fd.get("entered_later") === "on",
    sort_order: Number(str(fd, "sort_order") || 95),
  });
  if (error) back(PATH, { error: error.code === "23505" ? "A deduction with that name already exists" : error });
  revalidatePath(PATH);
  back(PATH, { notice: `${label} added. It applies to slips made from now on.` });
}

export async function saveWhatsAppSetting(fd: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("calc_settings")
    .update({ value: fd.get("auto") === "on" ? 1 : 0 })
    .eq("key", "slip_auto_whatsapp")
    .select("key");
  if (error) back(PATH, { error });
  if (!data?.length) back(PATH, { error: "Only the administrator can change this" });
  revalidatePath(PATH);
  back(PATH, { notice: "WhatsApp setting saved" });
}

export async function saveBroker(fd: FormData) {
  const supabase = await createClient();
  const commission = optNum(fd, "commission");
  if (Number.isNaN(commission)) back(`${PATH}#brokers`, { error: "Commission must be a number" });
  const { error } = await supabase.rpc("set_broker_contact", {
    p_broker: str(fd, "id"),
    p_phone: optStr(fd, "phone"),
    p_commission: commission,
  });
  if (error) back(`${PATH}#brokers`, { error });
  revalidatePath(PATH);
  back(`${PATH}#brokers`, { notice: "Broker saved" });
}
