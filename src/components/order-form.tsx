"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Option, Variety } from "@/lib/types";

type Line = { variety_id: string; ordered_kg: string; rate_per_qtl: string };

/** Create form shared by purchase and sales orders. */
export function OrderForm({
  kind,
  parties,
  brokers,
  varieties,
  action,
}: {
  kind: "purchase" | "sales";
  parties: Option[];
  brokers?: Option[];
  varieties: Variety[];
  action: (fd: FormData) => Promise<void>;
}) {
  const [lines, setLines] = useState<Line[]>([{ variety_id: "", ordered_kg: "", rate_per_qtl: "" }]);
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const totalKg = lines.reduce((s, l) => s + (Number(l.ordered_kg) || 0), 0);
  const value = lines.reduce((s, l) => s + ((Number(l.ordered_kg) || 0) / 100) * (Number(l.rate_per_qtl) || 0), 0);

  return (
    <form action={action} className="space-y-6 p-5">
      <input type="hidden" name="lines_json" value={JSON.stringify(lines)} />
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="party_id">{kind === "purchase" ? "Supplier *" : "Customer *"}</label>
          <select id="party_id" name="party_id" className="input" required defaultValue="">
            <option value="" disabled>
              Select
            </option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {kind === "purchase" && brokers && (
          <div>
            <label className="label" htmlFor="broker_id">Broker</label>
            <select id="broker_id" name="broker_id" className="input" defaultValue="">
              <option value="">No broker</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="order_date">Order date</label>
          <input id="order_date" name="order_date" type="date" className="input" />
        </div>
        <div>
          <label className="label" htmlFor="due">{kind === "purchase" ? "Expected by" : "Required by"}</label>
          <input id="due" name="due" type="date" className="input" />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Order lines</h3>
          <button type="button" className="btn-secondary py-1" onClick={() => setLines((ls) => [...ls, { variety_id: "", ordered_kg: "", rate_per_qtl: "" }])}>
            <Plus className="size-4" /> Add line
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Variety *</th>
                <th>Quantity (kg) *</th>
                <th>Rate (₹ / quintal)</th>
                <th className="num">Value (₹)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="text-slate-500">{i + 1}</td>
                  <td>
                    <select className="input" aria-label={`Variety line ${i + 1}`} value={l.variety_id} onChange={(e) => update(i, { variety_id: e.target.value })} required>
                      <option value="">Select</option>
                      {varieties.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input className="input" aria-label={`Quantity line ${i + 1}`} type="number" min="1" step="0.01" value={l.ordered_kg} onChange={(e) => update(i, { ordered_kg: e.target.value })} required />
                  </td>
                  <td>
                    <input className="input" aria-label={`Rate line ${i + 1}`} type="number" min="0" step="0.01" value={l.rate_per_qtl} onChange={(e) => update(i, { rate_per_qtl: e.target.value })} />
                  </td>
                  <td className="num">{(((Number(l.ordered_kg) || 0) / 100) * (Number(l.rate_per_qtl) || 0)).toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td>
                    {lines.length > 1 && (
                      <button type="button" className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50 font-semibold">
                <td colSpan={2}>Total</td>
                <td>{totalKg.toLocaleString("en-IN")} kg</td>
                <td />
                <td className="num">₹ {value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="notes">Notes / terms</label>
        <textarea id="notes" name="notes" rows={2} className="input" />
      </div>
      <div className="flex justify-end">
        <button className="btn-primary">Create {kind === "purchase" ? "purchase" : "sales"} order</button>
      </div>
    </form>
  );
}
