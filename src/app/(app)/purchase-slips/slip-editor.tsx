"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { moistureDeductionPct, rs, type Slip, type SlipLine } from "@/lib/slips";

type Opt = { id: string; name: string };
type Params = {
  moisture_pass_pct?: number;
  moisture_progressive?: number;
  moisture_slabs?: { upto: number | null; per_point: number }[];
  types?: Record<string, { value: number | null; alt_value: number | null }>;
};
type Row = { id?: string; label: string; basis: SlipLine["basis"]; code: string | null; rate: string; amount: string; note: string; remove: boolean; rateDirty: boolean; amountDirty: boolean; manual: boolean };

const n = (v: string) => (v.trim() === "" ? null : Number(v));

export function SlipEditor({
  slip,
  lines,
  parties,
  brokers,
  locations,
  action,
}: {
  slip: Slip & { params: Params };
  lines: SlipLine[];
  parties: Opt[];
  brokers: Opt[];
  locations: Opt[];
  action: (fd: FormData) => Promise<void>;
}) {
  const [h, setH] = useState({
    rate_per_qtl: slip.rate_per_qtl == null ? "" : String(slip.rate_per_qtl),
    net_q: (Number(slip.net_kg) / 100).toFixed(2),
    moisture_pct: slip.moisture_pct == null ? "" : String(slip.moisture_pct),
    bag_status: slip.bag_status ?? "received",
    early_payment: slip.early_payment,
    party_id: slip.party_id ?? "",
    broker_id: slip.broker_id ?? "",
    location_id: slip.location_id ?? "",
    claim_details: slip.claim_details ?? "",
  });
  const [rows, setRows] = useState<Row[]>(
    lines.map((l) => ({
      id: l.id,
      label: l.label,
      basis: l.basis,
      code: l.code,
      rate: l.rate == null ? "" : String(Number(l.rate)),
      amount: l.manual_amount || l.basis === "manual" ? String(Number(l.amount)) : "",
      note: l.note ?? "",
      remove: false,
      rateDirty: false,
      amountDirty: false,
      manual: l.manual_amount,
    })),
  );
  const [reason, setReason] = useState("");
  const upd = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const p = slip.params ?? {};
  const types = p.types ?? {};
  const moisture = {
    passPct: Number(p.moisture_pass_pct ?? 16),
    progressive: Number(p.moisture_progressive ?? 1) === 1,
    slabs: (p.moisture_slabs ?? []).map((s) => ({ upto: s.upto == null ? null : Number(s.upto), perPoint: Number(s.per_point) })),
  };

  // Mirrors slip_line_rate() / slip_recalc() so the totals show before saving.
  const preview = useMemo(() => {
    const q = Number(h.net_q) || 0;
    const amount = Math.round(q * (Number(h.rate_per_qtl) || 0));
    const out = rows.map((r) => {
      if (r.remove) return { rate: null as number | null, amt: 0 };
      let rate = n(r.rate);
      if (!r.rateDirty && !r.manual) {
        if (r.basis === "moisture") rate = moistureDeductionPct(n(h.moisture_pct), moisture);
        else if (r.basis === "dhalta" && r.code && types[r.code]) rate = Number(h.bag_status === "returned" ? types[r.code].alt_value : types[r.code].value);
        else if (r.code === "cash_discount" && types.cash_discount)
          rate = Number(h.early_payment && types.cash_discount.alt_value != null ? types.cash_discount.alt_value : types.cash_discount.value);
      }
      let amt = 0;
      if (r.basis === "manual" || (r.amount.trim() !== "" && (r.amountDirty || r.manual))) amt = Number(r.amount) || 0;
      else if (rate == null) amt = 0;
      else if (["percent", "moisture", "dhalta"].includes(r.basis)) amt = Math.round((amount * rate) / 100);
      else if (["per_qtl", "brokerage"].includes(r.basis)) amt = Math.round(q * rate);
      else if (r.basis === "flat") amt = Math.round(rate);
      return { rate, amt };
    });
    const ded = out.reduce((s, o) => s + o.amt, 0);
    return { amount, out, ded, net: amount - ded };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, rows]);

  const header = {
    rate_per_qtl: h.rate_per_qtl,
    net_kg: Math.round((Number(h.net_q) || 0) * 10000) / 100,
    moisture_pct: h.moisture_pct,
    bag_status: h.bag_status,
    early_payment: h.early_payment,
    party_id: h.party_id,
    broker_id: h.broker_id,
    location_id: h.location_id,
    claim_details: h.claim_details,
  };
  const linesJson = rows
    .filter((r) => r.id || (!r.remove && r.label.trim()))
    .map((r) => {
      if (!r.id) return { label: r.label, basis: r.basis, rate: r.rate, amount: r.amount, note: r.note };
      if (r.remove) return { id: r.id, remove: true };
      const e: Record<string, unknown> = { id: r.id, note: r.note };
      if (r.rateDirty) e.rate = r.rate;
      if (r.amountDirty || r.basis === "manual") e.amount = r.amount;
      return e;
    });
  const needsReason = slip.status !== "draft";

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="id" value={slip.id} />
      <input type="hidden" name="header_json" value={JSON.stringify(header)} />
      <input type="hidden" name="lines_json" value={JSON.stringify(linesJson)} />

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="label">
          Rate (₹ per quintal)
          <input className="input mt-1" type="number" min="0" step="0.01" value={h.rate_per_qtl} onChange={(e) => setH({ ...h, rate_per_qtl: e.target.value })} />
        </label>
        <label className="label">
          Net weight (quintal)
          <input className="input mt-1" type="number" min="0" step="0.01" value={h.net_q} onChange={(e) => setH({ ...h, net_q: e.target.value })} />
        </label>
        <label className="label">
          Moisture %
          <input className="input mt-1" type="number" min="0" max="60" step="0.1" value={h.moisture_pct} onChange={(e) => setH({ ...h, moisture_pct: e.target.value })} />
        </label>
        <label className="label">
          Bags
          <select className="input mt-1" value={h.bag_status} onChange={(e) => setH({ ...h, bag_status: e.target.value as "received" | "returned" })}>
            <option value="received">Received (dhalta {types.dhalta?.value ?? ""}%)</option>
            <option value="returned">Returned (dhalta {types.dhalta?.alt_value ?? ""}%)</option>
          </select>
        </label>
        <label className="label flex items-center gap-2 self-end rounded-md border border-line px-3 py-2">
          <input type="checkbox" checked={h.early_payment} onChange={(e) => setH({ ...h, early_payment: e.target.checked })} />
          Early payment (cash discount {types.cash_discount?.alt_value ?? ""}% instead of {types.cash_discount?.value ?? ""}%)
        </label>
        <span />
        <label className="label">
          Party
          <select className="input mt-1" value={h.party_id} onChange={(e) => setH({ ...h, party_id: e.target.value })}>
            <option value="">—</option>
            {parties.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Broker
          <select className="input mt-1" value={h.broker_id} onChange={(e) => setH({ ...h, broker_id: e.target.value })}>
            <option value="">No broker</option>
            {brokers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Godown
          <select className="input mt-1" value={h.location_id} onChange={(e) => setH({ ...h, location_id: e.target.value })}>
            <option value="">—</option>
            {locations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="table">
          <thead>
            <tr>
              <th>Deduction</th>
              <th>Rate</th>
              <th>Amount (blank = calculated)</th>
              <th>Note</th>
              <th className="num">Will be</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? `new-${i}`} className={r.remove ? "opacity-40" : ""}>
                <td className="min-w-36">
                  {r.id ? (
                    <span className="font-semibold text-ink">{r.label}</span>
                  ) : (
                    <div className="flex gap-1">
                      <input className="input" placeholder="Name" value={r.label} onChange={(e) => upd(i, { label: e.target.value })} aria-label="New deduction name" />
                      <select className="input w-28" value={r.basis} onChange={(e) => upd(i, { basis: e.target.value as Row["basis"] })} aria-label="How it is calculated">
                        <option value="percent">% of amount</option>
                        <option value="per_qtl">₹ per q</option>
                        <option value="flat">₹ fixed</option>
                        <option value="manual">₹ amount</option>
                      </select>
                    </div>
                  )}
                </td>
                <td className="w-28">
                  {r.basis === "manual" ? (
                    <span className="text-xs text-muted">—</span>
                  ) : (
                    <input
                      className="input"
                      type="number"
                      min="0"
                      step="0.001"
                      aria-label={`${r.label} rate`}
                      value={r.rateDirty || r.manual || !["moisture", "dhalta"].includes(r.basis) && r.code !== "cash_discount" ? r.rate : String(preview.out[i]?.rate ?? "")}
                      onChange={(e) => upd(i, { rate: e.target.value, rateDirty: true })}
                    />
                  )}
                </td>
                <td className="w-32">
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="1"
                    aria-label={`${r.label} amount`}
                    value={r.amount}
                    onChange={(e) => upd(i, { amount: e.target.value, amountDirty: true })}
                  />
                </td>
                <td className="min-w-40">
                  <input className="input" value={r.note} onChange={(e) => upd(i, { note: e.target.value })} aria-label={`${r.label} note`} />
                </td>
                <td className="num font-semibold text-ink">₹{rs(preview.out[i]?.amt)}</td>
                <td>
                  <button
                    type="button"
                    className="rounded p-1 text-muted hover:bg-red-50 hover:text-danger"
                    aria-label={r.remove ? `Keep ${r.label}` : `Remove ${r.label}`}
                    onClick={() => (r.id ? upd(i, { remove: !r.remove }) : setRows((x) => x.filter((_, j) => j !== i)))}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setRows((x) => [...x, { label: "", basis: "manual", code: null, rate: "", amount: "", note: "", remove: false, rateDirty: true, amountDirty: true, manual: true }])}
      >
        <Plus className="size-4" /> Add deduction
      </button>

      <label className="label">
        Claim details (printed on the slip)
        <input className="input mt-1" value={h.claim_details} onChange={(e) => setH({ ...h, claim_details: e.target.value })} />
      </label>

      <div className="grid gap-2 rounded-lg bg-canvas p-4 text-[14px] sm:grid-cols-3">
        <p>
          Amount <b className="tabular-nums">₹{rs(preview.amount)}</b>
        </p>
        <p>
          Deductions <b className="tabular-nums">₹{rs(preview.ded)}</b>
        </p>
        <p>
          Net payable <b className="text-[16px] tabular-nums">₹{rs(preview.net)}</b>
        </p>
      </div>

      {needsReason && (
        <label className="label">
          Reason for the change * <span className="font-normal text-muted">(the slip is {slip.status}; this goes in the audit trail)</span>
          <input name="reason" required className="input mt-1" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Broker asked for early payment" />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <a href={`/purchase-slips/${slip.id}`} className="btn-secondary">
          Cancel
        </a>
        <button className="btn-primary">Save slip</button>
      </div>
    </form>
  );
}
