"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { back, optStr, str } from "@/lib/actions";

function path(fd: FormData, fallback: string) {
  const p = str(fd, "back");
  return p.startsWith("/accounts") ? p : fallback;
}

function done(p: string, notice: string): never {
  revalidatePath("/accounts", "layout");
  back(p, { notice });
}

function money(fd: FormData, key: string) {
  const v = str(fd, key).replace(/,/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export async function recordPayment(fd: FormData) {
  const p = path(fd, "/accounts/payments");
  const kind = str(fd, "kind") === "receipt" ? "receipt" : "payment";
  const who = str(fd, "who"); // "p:<party id>" or "b:<broker id>"
  const [t, id] = who.split(":");
  const amount = money(fd, "amount");
  if (!id) back(p, { error: "Choose the party or broker" });
  if (amount === null || Number.isNaN(amount)) back(p, { error: "Enter the amount in rupees" });
  const mode = str(fd, "mode");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_payment", {
    p_kind: kind,
    p_party: t === "p" ? id : null,
    p_broker: t === "b" ? id : null,
    p_bank: mode === "Cash" ? null : optStr(fd, "bank_id"),
    p_amount: amount,
    p_paid_on: str(fd, "paid_on"),
    p_mode: mode,
    p_reference: optStr(fd, "reference"),
    p_narration: optStr(fd, "narration"),
    p_request: optStr(fd, "request_id"),
  });
  if (error) back(p, { error });
  const { data: row } = await supabase.from("payments").select("voucher_no").eq("id", data).single();
  done(p, `${row?.voucher_no} saved — ₹${Number(amount).toLocaleString("en-IN")} ${kind === "payment" ? "paid" : "received"}`);
}

export async function cancelPayment(fd: FormData) {
  const p = path(fd, "/accounts/payments");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_payment", { p_id: str(fd, "id"), p_reason: str(fd, "reason") });
  if (error) back(p, { error });
  done(p, `${str(fd, "voucher_no")} cancelled${str(fd, "exported") ? " — it is already in Tally: delete or cancel it there too" : ""}`);
}

/** Fill a missing rate (and customer) for the lines of one voucher. */
export async function saveOverrides(fd: FormData) {
  const p = path(fd, "/accounts/tally");
  const kind = str(fd, "kind") === "sales" ? "sales" : "purchase";
  const lines = fd.getAll("line_id").map(String);
  const party = optStr(fd, "party_id");
  const supabase = await createClient();
  for (const line of lines) {
    const rate = money(fd, `rate_${line}`);
    if (Number.isNaN(rate)) back(p, { error: "Rates must be numbers (₹ per quintal)" });
    if (rate === null && !party) continue;
    const { error } = await supabase.rpc("set_voucher_override", { p_kind: kind, p_line: line, p_party: party, p_rate: rate });
    if (error) back(p, { error });
  }
  done(p, "Saved — the entry is updated");
}

export async function saveTallySettings(fd: FormData) {
  const p = "/accounts/settings";
  const supabase = await createClient();
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("s_")) continue;
    const { error } = await supabase.from("tally_settings").update({ value: String(v).trim(), updated_at: new Date().toISOString() }).eq("key", k.slice(2));
    if (error) back(p, { error });
  }
  done(p, "Tally settings saved");
}

export async function addBank(fd: FormData) {
  const p = "/accounts/settings";
  const name = str(fd, "name");
  if (!name) back(p, { error: "Enter the bank account name" });
  const last4 = optStr(fd, "last4");
  if (last4 && !/^\d{4}$/.test(last4)) back(p, { error: "Last 4 digits must be 4 numbers" });
  const supabase = await createClient();
  const { error } = await supabase.from("bank_accounts").insert({ name, tally_ledger: optStr(fd, "tally_ledger"), account_last4: last4 });
  if (error) back(p, { error });
  done(p, `${name} added`);
}

export async function updateBank(fd: FormData) {
  const p = "/accounts/settings";
  const supabase = await createClient();
  const patch: Record<string, unknown> = {};
  if (fd.has("tally_ledger")) patch.tally_ledger = optStr(fd, "tally_ledger");
  if (fd.has("active")) patch.active = str(fd, "active") === "true";
  const { error } = await supabase.from("bank_accounts").update(patch).eq("id", str(fd, "id"));
  if (error) back(p, { error });
  done(p, "Bank account updated");
}

export async function setTallyLedger(fd: FormData) {
  const p = path(fd, "/accounts/settings");
  const supabase = await createClient();
  const commission = money(fd, "commission");
  if (Number.isNaN(commission)) back(p, { error: "Commission must be a number (₹ per quintal)" });
  const { error } = await supabase.rpc("set_tally_ledger", {
    p_party: optStr(fd, "party_id"),
    p_broker: optStr(fd, "broker_id"),
    p_ledger: str(fd, "tally_ledger"),
    p_commission: commission,
  });
  if (error) back(p, { error });
  done(p, "Saved");
}
