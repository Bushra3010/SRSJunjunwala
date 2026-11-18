"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { moistureDeductionPct, type MoistureParams } from "@/lib/slips";

export type Sauda = {
  po_line_id: string;
  label: string;
  supplier_id: string;
  broker_id: string | null;
  variety_id: string;
  rate: number | null;
};
type Opt = { id: string; name: string };

export type PurchaseInitial = {
  supplier_id: string;
  broker_id: string;
  location_id: string;
  variety_id: string;
  po_line_id: string;
  moisture_pct: string;
  bag_status: "received" | "returned";
  passed: string;
  rejected: string;
  claim_details: string;
  claim_amount: string;
  notes: string;
};

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-[16px] font-extrabold text-[#0f1f3d]">
        <span className="mr-1.5 text-[#c08a24]">{n}.</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function SaveButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="grid grid-cols-[1fr_2fr] gap-2">
      <button name="intent" value="draft" disabled={pending} className="min-h-12 rounded-xl border-2 border-[#d7dde8] bg-white text-[15px] font-bold text-[#13284b] disabled:opacity-50">
        Save draft
      </button>
      <button name="intent" value="submit" disabled={pending} className="min-h-12 rounded-xl bg-[#22813d] text-[16px] font-extrabold text-white shadow-sm disabled:bg-[#cbd2dc]">
        {pending ? "Saving…" : "Save QC entry"}
      </button>
    </div>
  );
}

const big = "input min-h-12 text-[16px]";

export function PurchaseForm({
  id,
  initial,
  saudas,
  parties,
  brokers,
  locations,
  varieties,
  moisture,
  action,
}: {
  id: string;
  initial: PurchaseInitial;
  saudas: Sauda[];
  parties: Opt[];
  brokers: Opt[];
  locations: Opt[];
  varieties: Opt[];
  moisture: MoistureParams;
  action: (fd: FormData) => Promise<void>;
}) {
  const [f, setF] = useState(initial);
  const set = (patch: Partial<PurchaseInitial>) => setF((x) => ({ ...x, ...patch }));
  const sauda = saudas.find((s) => s.po_line_id === f.po_line_id);
  const ded = useMemo(() => moistureDeductionPct(f.moisture_pct === "" ? null : Number(f.moisture_pct), moisture), [f.moisture_pct, moisture]);
  const total = (Number(f.passed) || 0) + (Number(f.rejected) || 0);

  const pickSauda = (lineId: string) => {
    const s = saudas.find((x) => x.po_line_id === lineId);
    set(s ? { po_line_id: lineId, supplier_id: s.supplier_id, broker_id: s.broker_id ?? "", variety_id: s.variety_id } : { po_line_id: "" });
  };

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="bag_status" value={f.bag_status} />

      <Section n="01" title="Sauda and party">
        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <label className="block text-[13px] font-bold">
            Sauda (purchase order)
            <select name="po_line_id" className={`${big} mt-1`} value={f.po_line_id} onChange={(e) => pickSauda(e.target.value)}>
              <option value="">No sauda / choose below</option>
              {saudas.map((s) => (
                <option key={s.po_line_id} value={s.po_line_id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {sauda?.rate != null && <p className="text-[13px] text-[#475569]">Rate on the sauda: ₹{sauda.rate} per quintal</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-[13px] font-bold">
              Party *
              <select name="supplier_id" className={`${big} mt-1`} value={f.supplier_id} onChange={(e) => set({ supplier_id: e.target.value })}>
                <option value="">Choose party</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-bold">
              Broker
              <select name="broker_id" className={`${big} mt-1`} value={f.broker_id} onChange={(e) => set({ broker_id: e.target.value })}>
                <option value="">No broker</option>
                {brokers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] font-bold">
              Variety *
              <select name="variety_id" className={`${big} mt-1`} value={f.variety_id} onChange={(e) => set({ variety_id: e.target.value })}>
                <option value="">Choose variety</option>
                {varieties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </Section>

      <Section n="02" title="Moisture">
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <label className="block text-[13px] font-bold" htmlFor="moisture_pct">
            Moisture percentage *
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="moisture_pct"
              name="moisture_pct"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              max="60"
              placeholder="00.0"
              className={`${big} text-[22px] font-bold tabular-nums`}
              value={f.moisture_pct}
              onChange={(e) => set({ moisture_pct: e.target.value })}
            />
            <span className="text-[22px] font-bold text-[#475569]">%</span>
          </div>
          <p className={`mt-2 text-[14px] font-semibold ${ded > 0 ? "text-[#a11a1a]" : "text-[#14632f]"}`}>
            {f.moisture_pct === "" ? `Pass up to ${moisture.passPct}%` : ded > 0 ? `Deduction ${ded}% of amount` : "Pass — no deduction"}
          </p>
        </div>
      </Section>

      <Section n="03" title="Bags">
        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <p className="text-[12px] font-bold tracking-wide text-[#475569] uppercase">Bag status</p>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#eef1f6] p-1" role="radiogroup" aria-label="Bag status">
            {(["received", "returned"] as const).map((b) => (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={f.bag_status === b}
                onClick={() => set({ bag_status: b })}
                className={`min-h-12 rounded-lg text-[15px] font-extrabold capitalize ${f.bag_status === b ? "bg-[#13284b] text-white shadow" : "text-[#13284b]"}`}
              >
                {b}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block rounded-xl border-2 border-[#bfe3cb] p-3 text-[13px] font-bold text-[#14632f]">
              Passed bags
              <input name="passed" type="number" inputMode="numeric" min="0" step="1" className={`${big} mt-1 font-bold`} value={f.passed} onChange={(e) => set({ passed: e.target.value })} />
            </label>
            <label className="block rounded-xl border-2 border-[#f3b4b7] p-3 text-[13px] font-bold text-[#a11a1a]">
              Rejected bags
              <input name="rejected" type="number" inputMode="numeric" min="0" step="1" className={`${big} mt-1 font-bold`} value={f.rejected} onChange={(e) => set({ rejected: e.target.value })} />
            </label>
          </div>
        </div>
      </Section>

      <Section n="04" title="Additional claim">
        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <textarea
            name="claim_details"
            rows={3}
            className="input text-[15px]"
            placeholder="Claim details, e.g. 20q × 30 paper & palledari"
            value={f.claim_details}
            onChange={(e) => set({ claim_details: e.target.value })}
          />
          <label className="block text-[13px] font-bold">
            Claim amount (₹)
            <input name="claim_amount" type="number" inputMode="decimal" min="0" step="1" className={`${big} mt-1`} value={f.claim_amount} onChange={(e) => set({ claim_amount: e.target.value })} />
          </label>
        </div>
      </Section>

      <Section n="05" title="Location">
        <div className="space-y-3 rounded-2xl bg-white p-4 shadow-sm">
          <label className="block text-[13px] font-bold">
            Unloading location (godown) *
            <select name="location_id" className={`${big} mt-1`} value={f.location_id} onChange={(e) => set({ location_id: e.target.value })}>
              <option value="">Choose location</option>
              {locations.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[13px] font-bold">
            Remarks
            <input name="notes" className={`${big} mt-1`} placeholder="Optional" value={f.notes} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      </Section>

      <div className="rounded-2xl bg-[#13284b] p-4 text-white shadow-sm">
        <p className="mb-2 text-[12px] font-bold tracking-wide text-[#b9c6dc] uppercase">Entry summary</p>
        <dl className="grid grid-cols-2 gap-y-1.5 text-[14px]">
          <dt className="text-[#b9c6dc]">Bag status</dt>
          <dd className="text-right font-bold capitalize">{f.bag_status}</dd>
          <dt className="text-[#b9c6dc]">Total bags checked</dt>
          <dd className="text-right font-bold tabular-nums">{total}</dd>
          <dt className="text-[#b9c6dc]">Moisture</dt>
          <dd className="text-right font-bold tabular-nums">{f.moisture_pct === "" ? "—" : `${f.moisture_pct}%`}</dd>
          {Number(f.claim_amount) > 0 && (
            <>
              <dt className="text-[#b9c6dc]">Claim</dt>
              <dd className="text-right font-bold tabular-nums">₹{Number(f.claim_amount).toLocaleString("en-IN")}</dd>
            </>
          )}
        </dl>
      </div>

      <SaveButtons />
    </form>
  );
}
