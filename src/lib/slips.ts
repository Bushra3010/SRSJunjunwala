// Purchase slip helpers shared by the server pages and the phone form.
// The database (slip_recalc / slip_moisture_pct) is the source of truth; the functions here only
// mirror it for live previews and for the WhatsApp message.

export type MoistureParams = {
  passPct: number;
  progressive: boolean;
  slabs: { upto: number | null; perPoint: number }[];
};

/** Moisture deduction % for a reading. Mirrors public.slip_moisture_pct(). */
export function moistureDeductionPct(moisture: number | null | undefined, p: MoistureParams): number {
  if (moisture == null || !Number.isFinite(moisture) || moisture <= p.passPct) return 0;
  const slabs = [...p.slabs].sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity));
  let lower = p.passPct;
  let pct = 0;
  for (const s of slabs) {
    if (s.upto != null && s.upto <= p.passPct) continue;
    if (p.progressive) {
      pct += Math.max(0, Math.min(moisture, s.upto ?? moisture) - lower) * s.perPoint;
    } else if (s.upto == null || moisture <= s.upto) {
      return round3((moisture - p.passPct) * s.perPoint);
    }
    if (s.upto == null || moisture <= s.upto) break;
    lower = s.upto;
  }
  return round3(pct);
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function bandsText(p: MoistureParams): string[] {
  const out = [`Up to ${p.passPct}%: no deduction`];
  let lower = p.passPct;
  for (const s of [...p.slabs].sort((a, b) => (a.upto ?? Infinity) - (b.upto ?? Infinity))) {
    if (s.upto != null && s.upto <= p.passPct) continue;
    out.push(`${s.upto == null ? `Above ${lower}%` : `${lower}–${s.upto}%`}: ${s.perPoint}% per point`);
    if (s.upto == null) break;
    lower = s.upto;
  }
  return out;
}

export type SlipStatus = "draft" | "final" | "paid" | "cancelled";

export type Slip = {
  id: string;
  slip_no: string;
  slip_date: string;
  rst: number;
  vehicle_no: string;
  vehicle_type: string | null;
  party_id: string | null;
  broker_id: string | null;
  location_id: string | null;
  qc_id: string;
  variety: string | null;
  bags_total: number;
  bags_rejected: number;
  bag_status: "received" | "returned" | null;
  moisture_pct: number | null;
  ticket_net_kg: number;
  net_kg: number;
  rate_per_qtl: number | null;
  early_payment: boolean;
  claim_details: string | null;
  amount: number;
  total_deductions: number;
  net_payable: number;
  status: SlipStatus;
  revision: number;
  finalized_at: string | null;
  payment_id: string | null;
  cancel_reason: string | null;
  share_token: string;
  created_at: string;
  updated_at: string;
  parties?: { name: string } | null;
  brokers?: { name: string; phone: string | null } | null;
  locations?: { name: string } | null;
};

export type SlipLine = {
  id: string;
  slip_id: string;
  code: string | null;
  label: string;
  basis: "percent" | "per_qtl" | "flat" | "moisture" | "dhalta" | "manual" | "brokerage";
  rate: number | null;
  amount: number;
  manual_amount: boolean;
  pending: boolean;
  note: string | null;
  sort_order: number;
};

export const SLIP_SELECT = "*, parties(name), brokers(name, phone), locations(name)";

/** The figure printed in the middle column of the slip (2.0, 0.2, 7, "20q*30 paper"…). */
export function lineRateText(l: SlipLine): string {
  if (l.pending) return "pending";
  if (l.basis === "manual") return l.note ?? "";
  if (l.rate == null) return "";
  if (l.basis === "flat") return "";
  const r = Number(l.rate);
  return l.basis === "per_qtl" || l.basis === "brokerage" ? String(r) : r.toFixed(r * 10 === Math.round(r * 10) ? 1 : 2);
}

export const BASIS_LABEL: Record<SlipLine["basis"], string> = {
  percent: "% of amount",
  per_qtl: "Rs per quintal",
  flat: "Rs (fixed)",
  moisture: "% from moisture bands",
  dhalta: "% by bag status",
  manual: "amount typed in",
  brokerage: "Rs per quintal (broker's own rate first)",
};

export const STATUS_TONE: Record<SlipStatus, string> = {
  draft: "bg-[#fbf3e2] text-[#7a5408]",
  final: "bg-[#e5eefb] text-[#1d4f9a]",
  paid: "bg-[#dcf3e3] text-[#14632f]",
  cancelled: "bg-[#f1f2f4] text-[#6b7280]",
};

export const rs = (n: number | string | null | undefined) =>
  Math.round(Number(n ?? 0)).toLocaleString("en-IN", { maximumFractionDigits: 0 });

export const qtl = (kg: number | string | null | undefined) => (Number(kg ?? 0) / 100).toFixed(2);

export function slipDate(d: string) {
  return new Date(`${d}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

/** Indian mobile number in WhatsApp form (91XXXXXXXXXX), or null. */
export function waPhone(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(d)) return "91" + d;
  if (/^91[6-9]\d{9}$/.test(d)) return d;
  if (/^0[6-9]\d{9}$/.test(d)) return "91" + d.slice(1);
  return null;
}

/** Text sent to the broker (manual wa.me link and the automatic message both use it). */
export function slipMessage(s: Slip, lines: SlipLine[], link: string) {
  const ded = lines
    .filter((l) => Number(l.amount) > 0)
    .map((l) => `• ${l.label}${lineRateText(l) && l.basis !== "manual" ? ` ${lineRateText(l)}` : ""}: ₹${rs(l.amount)}`)
    .join("\n");
  return [
    `*Purchase slip ${s.slip_no}* · ${slipDate(s.slip_date)}`,
    `Party: ${s.parties?.name ?? "—"}`,
    `RST ${s.rst} · Vehicle ${s.vehicle_no}`,
    `${s.variety ?? "Paddy"} · ${s.bags_total} bags`,
    `Net ${qtl(s.net_kg)} q × ₹${Number(s.rate_per_qtl ?? 0)} = ₹${rs(s.amount)}`,
    ded ? `Deductions:\n${ded}` : "",
    `*Total payable: ₹${rs(s.net_payable)}*`,
    s.status === "paid" ? "Payment done." : "",
    `Slip: ${link}`,
  ]
    .filter(Boolean)
    .join("\n");
}
