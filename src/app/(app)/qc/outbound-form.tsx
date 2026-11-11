"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Option, Variety } from "@/lib/types";

export type SoLineOption = {
  id: string;
  so_no: string;
  customer: string;
  variety_id: string;
  line_no: number;
  remaining_kg: number;
};

type Line = { variety_id: string; so_line_id: string; bags: string; bag_weight_kg: string; lot_no: string };

export function OutboundForm({
  id,
  header,
  initialLines,
  locations,
  varieties,
  soLines,
  netKg,
  tolerancePct,
  action,
  submitAction,
}: {
  id: string;
  header: { location_id: string | null; driver_name: string | null; driver_phone: string | null; notes: string | null };
  initialLines: Line[];
  locations: Option[];
  varieties: Variety[];
  soLines: SoLineOption[];
  netKg: number | null;
  tolerancePct: number;
  action: (fd: FormData) => Promise<void>;
  submitAction: (fd: FormData) => Promise<void>;
}) {
  const blank = (): Line => ({ variety_id: "", so_line_id: "", bags: "", bag_weight_kg: "", lot_no: "" });
  const [lines, setLines] = useState<Line[]>(initialLines.length ? initialLines : [blank()]);
  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const qty = (l: Line) => (Number(l.bags) || 0) * (Number(l.bag_weight_kg) || 0);
  const total = lines.reduce((s, l) => s + qty(l), 0);
  const diffPct = netKg ? ((total - netKg) / netKg) * 100 : null;

  // Quantity this form already assigns to each SO line (for live remaining balance).
  const assigned = (soLineId: string, upto: number) =>
    lines.slice(0, upto + 1).reduce((s, l) => s + (l.so_line_id === soLineId ? qty(l) : 0), 0);

  const payload = JSON.stringify(
    lines.map((l) => ({ variety_id: l.variety_id, so_line_id: l.so_line_id || null, bags: l.bags, bag_weight_kg: l.bag_weight_kg, lot_no: l.lot_no })),
  );

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="lines_json" value={payload} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="location_id">Loading location *</label>
          <select id="location_id" name="location_id" className="input" defaultValue={header.location_id ?? ""}>
            <option value="">Select location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="driver_name">Driver name</label>
          <input id="driver_name" name="driver_name" className="input" defaultValue={header.driver_name ?? ""} />
        </div>
        <div>
          <label className="label" htmlFor="driver_phone">Driver phone *</label>
          <input id="driver_phone" name="driver_phone" type="tel" inputMode="tel" className="input" defaultValue={header.driver_phone ?? ""} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Varieties loaded</h3>
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
                <th>Sales order line *</th>
                <th>Bags *</th>
                <th>Bag wt (kg) *</th>
                <th>Lot</th>
                <th className="num">Qty</th>
                <th className="num">SO left after</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const options = soLines.filter((s) => !l.variety_id || s.variety_id === l.variety_id);
                const so = soLines.find((s) => s.id === l.so_line_id);
                const left = so ? so.remaining_kg - assigned(so.id, i) : null;
                return (
                  <tr key={i}>
                    <td className="text-slate-500">{i + 1}</td>
                    <td className="min-w-36">
                      <select
                        className="input"
                        aria-label={`Variety line ${i + 1}`}
                        value={l.variety_id}
                        onChange={(e) => {
                          const v = varieties.find((x) => x.id === e.target.value);
                          update(i, { variety_id: e.target.value, so_line_id: "", bag_weight_kg: l.bag_weight_kg || String(v?.default_bag_weight_kg ?? "") });
                        }}
                      >
                        <option value="">Select</option>
                        {varieties.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="min-w-56">
                      <select className="input" aria-label={`SO line ${i + 1}`} value={l.so_line_id} onChange={(e) => update(i, { so_line_id: e.target.value })}>
                        <option value="">Select</option>
                        {options.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.so_no} / L{s.line_no} · {s.customer} — {s.remaining_kg.toLocaleString("en-IN")} kg left
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="w-24">
                      <input className="input" aria-label={`Bags line ${i + 1}`} type="number" min="1" step="1" inputMode="numeric" value={l.bags} onChange={(e) => update(i, { bags: e.target.value })} />
                    </td>
                    <td className="w-24">
                      <input className="input" aria-label={`Bag weight line ${i + 1}`} type="number" min="0.01" step="0.01" value={l.bag_weight_kg} onChange={(e) => update(i, { bag_weight_kg: e.target.value })} />
                    </td>
                    <td className="w-32">
                      <input className="input" aria-label={`Lot line ${i + 1}`} value={l.lot_no} onChange={(e) => update(i, { lot_no: e.target.value })} placeholder="Auto (oldest)" />
                    </td>
                    <td className="num">{qty(l) ? qty(l).toLocaleString("en-IN") : "—"}</td>
                    <td className={`num ${left !== null && left < 0 ? "font-semibold text-red-700" : "text-slate-600"}`}>
                      {left === null ? "—" : left.toLocaleString("en-IN")}
                    </td>
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
                <td colSpan={3}>Total</td>
                <td>{lines.reduce((s, l) => s + (Number(l.bags) || 0), 0)}</td>
                <td colSpan={2} />
                <td className="num">{total.toLocaleString("en-IN")} kg</td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="mt-2 text-xs">
          {netKg === null ? (
            <span className="text-slate-500">Gross weight not recorded yet — compare with the weighbridge net after loading.</span>
          ) : diffPct !== null && Math.abs(diffPct) > tolerancePct ? (
            <span className="font-medium text-amber-700">
              Loaded {total.toLocaleString("en-IN")} kg vs weighbridge net {netKg.toLocaleString("en-IN")} kg ({diffPct.toFixed(1)}%) — check bag
              counts or weights.
            </span>
          ) : (
            <span className="text-emerald-700">Matches weighbridge net {netKg.toLocaleString("en-IN")} kg within {tolerancePct}%.</span>
          )}
        </div>
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
