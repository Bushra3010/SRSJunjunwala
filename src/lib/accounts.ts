import { createClient } from "@/lib/supabase/server";
import type { TallySettings, Voucher } from "@/lib/tally";

export type VoucherRow = {
  voucher_key: string;
  vtype: string;
  vdate: string;
  ref: string;
  party_id: string | null;
  broker_id: string | null;
  party_name: string;
  ledger_name: string;
  amount: number | null;
  qty_kg: number | null;
  narration: string;
  problem: string | null;
  source_status: string;
  export_no: string | null;
  exported_at: string | null;
};

export async function loadVouchers(from: string | null, to: string | null) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accounting_vouchers", { p_from: from, p_to: to });
  return { rows: ((data ?? []) as VoucherRow[]).map((r) => ({ ...r, amount: r.amount === null ? null : Number(r.amount) })), error };
}

export async function loadTallySettings(): Promise<TallySettings> {
  const supabase = await createClient();
  const { data } = await supabase.from("tally_settings").select("key, value");
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

/** Turn ready rows into Tally vouchers, adding the bank ledger for payments and receipts. */
export async function toTallyVouchers(rows: VoucherRow[]): Promise<Voucher[]> {
  const supabase = await createClient();
  const payIds = rows.filter((r) => /^(PAY|RCT):/.test(r.voucher_key)).map((r) => r.voucher_key.slice(4));
  const bankOf = new Map<string, string | null>();
  if (payIds.length) {
    const { data } = await supabase.from("payments").select("id, bank_account_id").in("id", payIds);
    const bankIds = [...new Set((data ?? []).map((p) => p.bank_account_id).filter(Boolean))] as string[];
    const { data: banks } = bankIds.length
      ? await supabase.from("bank_accounts").select("id, name, tally_ledger").in("id", bankIds)
      : { data: [] as { id: string; name: string; tally_ledger: string | null }[] };
    for (const p of data ?? []) {
      const b = (banks ?? []).find((x) => x.id === p.bank_account_id);
      bankOf.set(p.id, b ? b.tally_ledger?.trim() || b.name : null);
    }
  }
  return rows.map((r) => ({
    voucher_key: r.voucher_key,
    vtype: r.vtype,
    vdate: r.vdate,
    ref: r.ref,
    ledger_name: r.ledger_name,
    amount: Number(r.amount ?? 0),
    narration: r.narration,
    bank_ledger: bankOf.get(r.voucher_key.slice(4)) ?? null,
  }));
}

/** Ledgers Tally needs before importing these vouchers. */
export async function ledgerMasters(rows: VoucherRow[], s: TallySettings) {
  const supabase = await createClient();
  const partyIds = [...new Set(rows.map((r) => r.party_id).filter(Boolean))] as string[];
  const { data: parties } = partyIds.length
    ? await supabase.from("parties").select("id, kind").in("id", partyIds)
    : { data: [] as { id: string; kind: string }[] };
  const kindOf = new Map((parties ?? []).map((p) => [p.id, p.kind]));
  const out: { name: string; parent: string }[] = [
    { name: s.purchase_ledger || "Purchase", parent: "Purchase Accounts" },
    { name: s.sales_ledger || "Sales", parent: "Sales Accounts" },
    { name: s.brokerage_ledger || "Brokerage", parent: "Indirect Expenses" },
  ];
  for (const r of rows) {
    if (r.broker_id) out.push({ name: r.ledger_name, parent: s.supplier_group || "Sundry Creditors" });
    else if (r.party_id) {
      const k = kindOf.get(r.party_id);
      const debtor = k === "customer" || (k === "both" && (r.vtype === "Sales" || r.vtype === "Receipt"));
      out.push({ name: r.ledger_name, parent: debtor ? s.customer_group || "Sundry Debtors" : s.supplier_group || "Sundry Creditors" });
    }
  }
  const { data: banks } = await supabase.from("bank_accounts").select("name, tally_ledger").eq("active", true);
  for (const b of banks ?? []) out.push({ name: b.tally_ledger?.trim() || b.name, parent: "Bank Accounts" });
  return out;
}

/** Month-to-date defaults (IST). */
export function monthRange() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return { from: today.slice(0, 8) + "01", to: today };
}

export const validDate = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
