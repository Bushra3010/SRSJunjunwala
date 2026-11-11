"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Option, Variety } from "@/lib/types";

export type PoLineOption = {
  id: string;
  po_no: string;
  supplier_id: string;
  variety_id: string;
  line_no: number;
  remaining_kg: number;
};

type Line = {
  variety_id: string;
  po_line_id: string;
  moisture_pct: string;
  sacks_received: string;
  returned_sacks: string;
  rejected_bags: string;
};

const blank = (): Line => ({ variety_id: "", po_line_id: "", moisture_pct: "", sacks_received: "", returned_sacks: "0", rejected_bags: "0" });

export function InboundForm({
  id,
  header,
  initialLines,
  suppliers,
  brokers,
  locations,
  varieties,
  poLines,
  netKg,
  moistureBase,
  action,
  submitAction,
}: {
  id: string;
  header: { supplier_id: string | null; broker_id: string | null; location_id: string | null; notes: string | null };
  initialLines: Line[];
  suppliers: Option[];
  brokers: Option[];
  locations: Option[];
  varieties: Variety[];
  poLines: PoLineOption[];
  netKg: number | null;
  moistureBase: number;
  action: (fd: FormData) => Promise<void>;
  submitAction: (fd: FormData) => Promise<void>;
}) {
  const [supplier, setSupplier] = useState(header.supplier_id ?? "");
  const [lines, setLines] = useState<Line[]>(initialLines.length ? initialLines : [blank()]);

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const totalSacks = lines.reduce((s, l) => s + (Number(l.sacks_received) || 0), 0);
  const preview = useMemo(
    () =>
      lines.map((l) => {
        const sacks = Number(l.sacks_received) || 0;
        if (!netKg || !totalSacks || !sacks) return null;
        const net = (netKg * sacks) / totalSacks;
        const rej = (net * ((Number(l.rejected_bags) || 0) + (Number(l.returned_sacks) || 0))) / sacks;
        const ded = ((net - rej) * Math.max(0, (Number(l.moisture_pct) || 0) - moistureBase)) / 100;
        return net - rej - ded;
      }),
    [lines, netKg, totalSacks, moistureBase],
  );

  const payload = JSON.stringify(
    lines.map((l) => ({
      variety_id: l.variety_id,
      po_line_id: l.po_line_id || null,
      moisture_pct: l.moisture_pct,
      sacks_received: l.sacks_received,
      returned_sacks: l.returned_sacks || 0,
      rejected_bags: l.rejected_bags || 0,
    })),
  );

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="lines_json" value={payload} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="supplier_id">Supplier (party) *</label>
          <select id="supplier_id" name="supplier_id" className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">Select supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="broker_id">Broker</label>
          <select id="broker_id" name="broker_id" className="input" defaultValue={header.broker_id ?? ""}>
            <option value="">No broker</option>
            {brokers.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="location_id">Unloading location *</label>
          <select id="location_id" name="location_id" className="input" defaultValue={header.location_id ?? ""}>
            <option value="">Select location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Variety-wise QC</h3>
          <button type="button" className="btn-secondary py-1" onClick={() => setLines((ls) => [...ls, blank()])}>
            <Plus className="size-4" /> Add variety
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Variety *</th>
                <th>Purchase order line</th>
                <th>Moisture % *</th>
                <th>Sacks received *</th>
                <th>Returned</th>
                <th>Rejected</th>
                <th className="num">Est. accepted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const options = poLines.filter((p) => (!supplier || p.supplier_id === supplier) && (!l.variety_id || p.variety_id === l.variety_id));
                return (
                  <tr key={i}>
                    <td className="text-slate-500">{i + 1}</td>
                    <td className="min-w-36">
                      <select
                        className="input"
                        aria-label={`Variety line ${i + 1}`}
                        value={l.variety_id}
                        onChange={(e) => update(i, { variety_id: e.target.value, po_line_id: "" })}
                      >
                        <option value="">Select</option>
                        {varieties.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="min-w-48">
                      <select className="input" aria-label={`PO line ${i + 1}`} value={l.po_line_id} onChange={(e) => update(i, { po_line_id: e.target.value })}>
                        <option value="">Not linked</option>
                        {options.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.po_no} / L{p.line_no} — {Number(p.remaining_kg).toLocaleString("en-IN")} kg left
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="w-24">
                      <input className="input" aria-label={`Moisture line ${i + 1}`} type="number" step="0.1" min="0" max="60" value={l.moisture_pct} onChange={(e) => update(i, { moisture_pct: e.target.value })} />
                    </td>
                    <td className="w-28">
                      <input className="input" aria-label={`Sacks line ${i + 1}`} type="number" min="1" step="1" inputMode="numeric" value={l.sacks_received} onChange={(e) => update(i, { sacks_received: e.target.value })} />
                    </td>
                    <td className="w-24">
                      <input className="input" aria-label={`Returned line ${i + 1}`} type="number" min="0" step="1" inputMode="numeric" value={l.returned_sacks} onChange={(e) => update(i, { returned_sacks: e.target.value })} />
                    </td>
                    <td className="w-24">
                      <input className="input" aria-label={`Rejected line ${i + 1}`} type="number" min="0" step="1" inputMode="numeric" value={l.rejected_bags} onChange={(e) => update(i, { rejected_bags: e.target.value })} />
                    </td>
                    <td className="num text-slate-600">{preview[i] != null ? `${preview[i]!.toLocaleString("en-IN", { maximumFractionDigits: 0 })} kg` : "—"}</td>
                    <td>
                      {lines.length > 1 && (
                        <button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50 font-semibold">
                <td colSpan={4}>Total</td>
                <td>{totalSacks}</td>
                <td>{lines.reduce((s, l) => s + (Number(l.returned_sacks) || 0), 0)}</td>
                <td>{lines.reduce((s, l) => s + (Number(l.rejected_bags) || 0), 0)}</td>
                <td className="num">
                  {preview.every((p) => p != null)
                    ? `${preview.reduce((s, p) => s + (p ?? 0), 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} kg`
                    : "—"}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {netKg
            ? `Estimate splits the net weight (${netKg.toLocaleString("en-IN")} kg) by sacks, less rejected/returned sacks and moisture above ${moistureBase}%. Final figures are calculated when the QC head posts.`
            : "Net weight is not known yet (tare pending). Accepted weight is calculated when the QC head posts."}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="notes">Notes</label>
        <textarea id="notes" name="notes" rows={2} className="input" defaultValue={header.notes ?? ""} />
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
        <button className="btn-secondary">
          Save draft
        </button>
        <button formAction={submitAction} className="btn-primary">
          Submit for review
        </button>
      </div>
    </form>
  );
}
