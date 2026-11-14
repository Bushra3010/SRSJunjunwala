import Link from "next/link";
import { randomUUID } from "node:crypto";
import clsx from "clsx";
import { Badge, Empty, StatusBadge } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { STAGE_META, hours, q, type Batch, type Equipment, type Stage } from "@/lib/production";
import { cancelBatch, completeBatch, finishSteaming, startBatch, startSoaking, startSoakingStandard } from "@/app/(app)/production/actions";

export const PROD_TABS = [
  { key: "overview", label: "Overview", href: "/production" },
  { key: "receipts", label: "Trucks", href: "/production/receipts" },
  { key: "soaking", label: "Soaking tanks", href: "/production/soaking" },
  { key: "drying", label: "Dryers", href: "/production/drying" },
  { key: "milling", label: "Milling", href: "/production/milling" },
  { key: "outputs", label: "Outputs", href: "/production/outputs" },
  { key: "standards", label: "Recovery standards", href: "/production/standards" },
  { key: "trace", label: "Traceability", href: "/production/trace" },
  { key: "timeline", label: "Timeline", href: "/production/timeline" },
  { key: "faults", label: "Faults", href: "/production/faults" },
  { key: "reports", label: "Reports", href: "/production/reports" },
];

/** Horizontal, scrollable sub-navigation for the production module. */
export function ProductionNav({ active }: { active: string }) {
  return (
    <nav aria-label="Production" className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1.5">
        {PROD_TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === active ? "page" : undefined}
            className={clsx(
              "rounded-md border px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap",
              t.key === active ? "border-[#1f6b32] bg-[#1f6b32] text-white" : "border-line bg-white text-ink hover:border-[#c08a24] hover:text-[#7b5e2a]",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function BatchLink({ no, className }: { no: string; className?: string }) {
  return (
    <Link href={`/production/batches/${no}`} className={clsx("font-mono text-[13px] font-bold text-[#1f6b32] hover:underline", className)}>
      {no}
    </Link>
  );
}

export function StageChip({ stage }: { stage: Stage }) {
  const m = STAGE_META[stage];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-bold text-ink">
      <span className="size-2 rounded-full" style={{ background: m.color }} aria-hidden />
      {m.label}
    </span>
  );
}

/** Quantity in quintals with kg underneath and its trust level. */
export function Qty({ kg, status }: { kg: number | null | undefined; status?: string | null }) {
  if (kg === null || kg === undefined) return <span className="text-muted">—</span>;
  return (
    <span className="inline-flex flex-col">
      <span className="font-bold whitespace-nowrap text-ink tabular-nums">{q(kg)}</span>
      <span className="text-[11px] whitespace-nowrap text-muted tabular-nums">
        {Number(kg).toLocaleString("en-IN")} kg{status === "estimated" ? " · estimate" : ""}
      </span>
    </span>
  );
}

export function elapsedMinutes(b: Pick<Batch, "started_at" | "ended_at">) {
  if (!b.started_at) return null;
  const end = b.ended_at ? new Date(b.ended_at).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(b.started_at).getTime()) / 60000));
}

/** Equipment status tile for the floor boards. */
export function EquipmentTile({
  eq,
  batch,
  available,
  sub,
  children,
}: {
  eq: Equipment;
  batch?: Batch | null;
  available?: number;
  sub?: React.ReactNode;
  /** Extra controls shown at the bottom of the tile (e.g. Start soaking). */
  children?: React.ReactNode;
}) {
  const running = batch?.status === "running";
  const holding = batch && batch.status === "completed" && (available ?? 0) > 0;
  const mins = batch ? elapsedMinutes({ started_at: batch.started_at, ended_at: running ? null : batch.ended_at }) : null;
  const overdue = running && eq.expected_hours_max && mins !== null && mins > eq.expected_hours_max * 60;
  const pct = running && eq.expected_hours_max && mins !== null ? Math.min(100, (mins / (eq.expected_hours_max * 60)) * 100) : null;
  const state = running ? (overdue ? "Overdue" : "Running") : holding ? "Done · waiting" : "Free";
  const color = running ? (overdue ? "#d10b0b" : "#3e6fc0") : holding ? "#c08a24" : "#0a8f44";
  return (
    <div className="card flex min-w-0 flex-col gap-2 p-4" style={{ borderTop: `3px solid ${color}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold text-ink">{eq.name}</div>
          {sub && <div className="text-[11px] text-muted">{sub}</div>}
        </div>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap text-white" style={{ background: color }}>
          {state}
        </span>
      </div>
      {batch && (running || holding) ? (
        <div className="space-y-1.5 text-[12px]">
          <BatchLink no={batch.batch_no} />
          <div className="flex justify-between gap-2 text-muted">
            <span>{running ? "In" : "Out"}</span>
            <span className="font-bold text-ink tabular-nums">{q(running ? batch.input_kg : available)}</span>
          </div>
          <div className="flex justify-between gap-2 text-muted">
            <span>{running ? "Elapsed" : "Finished"}</span>
            <span className="font-bold text-ink">{running ? hours(mins) : dateTime(batch.ended_at)}</span>
          </div>
          {pct !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-[#e9edf4]" title={`Expected ${eq.expected_hours_min}–${eq.expected_hours_max} h`}>
              <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
            </div>
          )}
        </div>
      ) : (
        <div className="text-[12px] text-muted">Empty — ready to load</div>
      )}
      {children}
    </div>
  );
}

export type Candidate = { batch: Batch; available: number; label?: React.ReactNode };

/**
 * Start a batch from one or more completed parent batches. Quantities are in quintals.
 * Steaming and drying always take the whole parent, so they hide the quantity boxes.
 */
export function StartForm({
  stage,
  equipment,
  candidates,
  back,
  canAuthorize,
  wholeBatch = false,
  title,
  submitLabel = "Start batch",
  defaultEquipment,
}: {
  stage: Stage;
  equipment: Equipment[];
  candidates: Candidate[];
  back: string;
  canAuthorize: boolean;
  wholeBatch?: boolean;
  title?: string;
  submitLabel?: string;
  defaultEquipment?: string;
}) {
  return (
    <form action={startBatch} className="space-y-4 p-4">
      <input type="hidden" name="stage" value={stage} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="request_id" value={randomUUID()} />
      {title && <p className="text-[13px] text-muted">{title}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`eq-${stage}`}>
            {STAGE_META[stage].label === "Mill feed" ? "Destination tank" : "Equipment"}
          </label>
          <select id={`eq-${stage}`} name="equipment_id" className="input" required={stage !== "precleaning"} defaultValue={defaultEquipment ?? ""}>
            <option value="">{stage === "precleaning" ? "Not recorded" : "Select…"}</option>
            {equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor={`st-${stage}`}>Start time (blank = now)</label>
          <input id={`st-${stage}`} type="datetime-local" name="started_at" className="input" />
        </div>
      </div>
      <fieldset>
        <legend className="label">Input batches {wholeBatch ? "(whole batch is transferred)" : "(quantity in quintals)"}</legend>
        {candidates.length === 0 ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">
            Nothing is ready from {STAGE_META[STAGE_META[stage].parent!].label.toLowerCase()} yet.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {candidates.map(({ batch: b, available, label }) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <label className="flex min-w-0 flex-1 items-center gap-2.5">
                  <input type="checkbox" name="pick" value={b.id} className="size-4 accent-[#1f6b32]" defaultChecked={candidates.length === 1} />
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] font-bold text-ink">{b.batch_no}</span>
                    <span className="block text-[11px] text-muted">
                      {label ?? null} {q(available)} available{b.output_qty_status === "estimated" ? " (estimate)" : ""}
                    </span>
                  </span>
                </label>
                {!wholeBatch && (
                  <span className="flex items-center gap-1">
                    <input
                      name={`qty_${b.id}`}
                      type="number"
                      step="any"
                      min="0.01"
                      defaultValue={available / 100}
                      className="input w-28 text-right"
                      aria-label={`Quantity from ${b.batch_no} in quintals`}
                    />
                    <span className="text-xs text-muted">q</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`rm-${stage}`}>Remarks</label>
          <input id={`rm-${stage}`} name="remarks" className="input" placeholder="Optional" />
        </div>
        {canAuthorize && (
          <div>
            <label className="label" htmlFor={`au-${stage}`}>Manager authorisation (only if over quantity / combining lots)</label>
            <input id={`au-${stage}`} name="authorization" className="input" placeholder="Reason, recorded in history" />
          </div>
        )}
      </div>
      <button className="btn-primary" disabled={candidates.length === 0}>
        {submitLabel}
      </button>
    </form>
  );
}

/** Inline "complete" form for a running batch. */
export function CompleteForm({ batch, back, needsOutput, moisture = false }: { batch: Batch; back: string; needsOutput: boolean; moisture?: boolean }) {
  return (
    <details className="group">
      <summary className="btn-primary cursor-pointer list-none py-1">Complete…</summary>
      <form action={completeBatch} className="mt-3 grid gap-3 rounded-md border border-line bg-[#fbf8ef] p-3 sm:grid-cols-2">
        <input type="hidden" name="id" value={batch.id} />
        <input type="hidden" name="batch_no" value={batch.batch_no} />
        <input type="hidden" name="back" value={back} />
        <div>
          <label className="label">Output (q){needsOutput ? "" : " — blank = estimate"}</label>
          <input name="output_q" type="number" step="0.01" min="0.01" className="input" required={needsOutput} placeholder={needsOutput ? "" : (Number(batch.input_kg) / 100).toFixed(2)} />
        </div>
        <div>
          <label className="label">Rejected (q)</label>
          <input name="rejected_q" type="number" step="0.01" min="0" className="input" defaultValue="0" />
        </div>
        {moisture && (
          <div>
            <label className="label">Moisture %</label>
            <input name="moisture_pct" type="number" step="0.1" min="0" max="60" className="input" />
          </div>
        )}
        <div>
          <label className="label">End time (blank = now)</label>
          <input name="ended_at" type="datetime-local" className="input" />
        </div>
        <div className="sm:col-span-2">
          <label className="label">Remarks</label>
          <input name="remarks" className="input" />
        </div>
        <button className="btn-primary sm:col-span-2">Complete {batch.batch_no}</button>
      </form>
    </details>
  );
}

export function CancelForm({ batch, back }: { batch: Pick<Batch, "id" | "batch_no">; back: string }) {
  return (
    <details>
      <summary className="btn-danger cursor-pointer list-none py-1">Cancel…</summary>
      <form action={cancelBatch} className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-red-200 bg-red-50 p-3">
        <input type="hidden" name="id" value={batch.id} />
        <input type="hidden" name="batch_no" value={batch.batch_no} />
        <input type="hidden" name="back" value={back} />
        <div className="min-w-48 flex-1">
          <label className="label">Reason (kept on record)</label>
          <input name="reason" className="input" required />
        </div>
        <button className="btn-danger">Cancel batch</button>
      </form>
    </details>
  );
}

/** History table used by every stage page. */
export function BatchTable({
  batches,
  equipmentById,
  userName,
  extra,
  showStage = false,
}: {
  batches: Batch[];
  equipmentById: Map<string, Equipment>;
  userName: (id: string | null) => string;
  extra?: { head: string; cell: (b: Batch) => React.ReactNode };
  showStage?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Batch</th>
            {showStage && <th>Stage</th>}
            <th>Equipment</th>
            <th>Status</th>
            <th className="text-right">Input</th>
            <th className="text-right">Output</th>
            <th className="text-right">Loss</th>
            <th>Started</th>
            <th>Ended</th>
            <th>Duration</th>
            <th>Operator</th>
            {extra && <th>{extra.head}</th>}
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id} className={b.status === "cancelled" ? "opacity-60" : undefined}>
              <td>
                <BatchLink no={b.batch_no} />
              </td>
              {showStage && (
                <td>
                  <StageChip stage={b.stage} />
                </td>
              )}
              <td className="whitespace-nowrap">{b.equipment_id ? equipmentById.get(b.equipment_id)?.name : "—"}</td>
              <td>
                <StatusBadge status={b.status} />
              </td>
              <td className="text-right">
                <Qty kg={b.input_kg} />
              </td>
              <td className="text-right">
                <Qty kg={b.output_kg} status={b.output_qty_status} />
              </td>
              <td className="text-right whitespace-nowrap tabular-nums">{b.loss_kg === null ? "—" : q(b.loss_kg)}</td>
              <td className="text-xs whitespace-nowrap">{dateTime(b.started_at)}</td>
              <td className="text-xs whitespace-nowrap">{dateTime(b.ended_at)}</td>
              <td className="text-xs whitespace-nowrap">{hours(b.duration_minutes ?? (b.status === "running" ? elapsedMinutes(b) : null))}</td>
              <td className="text-xs whitespace-nowrap">{userName(b.operator_id)}</td>
              {extra && <td>{extra.cell(b)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Search + status + date filters (GET form) shared by stage pages. */
export function BatchFilters({ action, sp }: { action: string; sp: { q?: string; status?: string; from?: string; to?: string } }) {
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-3">
      <div className="min-w-40 flex-1">
        <label className="label" htmlFor="f-q">Batch ID</label>
        <input id="f-q" name="q" defaultValue={sp.q} placeholder="e.g. SOAK-2026-00012" className="input" />
      </div>
      <div>
        <label className="label" htmlFor="f-s">Status</label>
        <select id="f-s" name="status" defaultValue={sp.status ?? ""} className="input w-auto">
          <option value="">All</option>
          <option value="running">Running</option>
          <option value="completed">Ready for next stage</option>
          <option value="consumed">Moved on</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <div>
        <label className="label" htmlFor="f-from">From</label>
        <input id="f-from" type="date" name="from" defaultValue={sp.from} className="input w-auto" />
      </div>
      <div>
        <label className="label" htmlFor="f-to">To</label>
        <input id="f-to" type="date" name="to" defaultValue={sp.to} className="input w-auto" />
      </div>
      <button className="btn-secondary">Filter</button>
    </form>
  );
}

export function QtyStatusBadge({ status }: { status: string | null }) {
  return status ? <StatusBadge status={status} /> : <Badge>—</Badge>;
}

export type WaitingTruck = {
  qc_line_id: string;
  std_tank_kg: number | null;
  rst: number;
  rst_cycle: string | null;
  vehicle_no: string;
  supplier: string | null;
  variety: string | null;
  accepted_kg: number;
};

/** Load one soaking tank straight from posted trucks (and trucks already partly loaded). Quantities in quintals. */
export function SoakingStartForm({
  tanks,
  trucks,
  receipts,
  back,
  canAuthorize,
}: {
  tanks: Equipment[];
  trucks: WaitingTruck[];
  receipts: Candidate[];
  back: string;
  canAuthorize: boolean;
}) {
  const none = trucks.length === 0 && receipts.length === 0;
  return (
    <form action={startSoaking} className="space-y-4 p-4">
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="request_id" value={randomUUID()} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="soak-tank">Tank</label>
          <select id="soak-tank" name="equipment_id" className="input" required defaultValue="">
            <option value="" disabled>
              {tanks.length ? "Select an empty tank…" : "All tanks are in use"}
            </option>
            {tanks.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="soak-start">Soaking start (blank = now)</label>
          <input id="soak-start" type="datetime-local" name="started_at" className="input" />
        </div>
      </div>
      <fieldset>
        <legend className="label">Trucks (quantity into this tank, in quintals — defaults to the variety&apos;s standard tank weight)</legend>
        {none ? (
          <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">
            No unloaded truck is waiting. Post the unloading QC first.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {trucks.map((t) => (
              <li key={t.qc_line_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <label className="flex min-w-0 flex-1 items-center gap-2.5">
                  <input type="checkbox" name="pick" value={`qc:${t.qc_line_id}`} className="size-4 accent-[#1f6b32]" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-bold text-ink">
                      RST {t.rst} · {t.vehicle_no}
                    </span>
                    <span className="block text-[11px] text-muted">
                      {t.supplier ?? "—"} · {t.variety ?? "—"} · {q(t.accepted_kg)} unloaded
                      {t.std_tank_kg ? ` · standard ${q(t.std_tank_kg)} per tank` : " · no standard tank weight set"}
                    </span>
                  </span>
                </label>
                <QtyBox name={`qty_qc:${t.qc_line_id}`} kg={t.std_tank_kg ? Math.min(Number(t.std_tank_kg), Number(t.accepted_kg)) : t.accepted_kg} label={`RST ${t.rst}`} />
              </li>
            ))}
            {receipts.map(({ batch: b, available, label }) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <label className="flex min-w-0 flex-1 items-center gap-2.5">
                  <input type="checkbox" name="pick" value={`b:${b.id}`} className="size-4 accent-[#1f6b32]" />
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] font-bold text-ink">{b.batch_no}</span>
                    <span className="block text-[11px] text-muted">
                      {label} {q(available)} left on this truck
                    </span>
                  </span>
                </label>
                <QtyBox name={`qty_b:${b.id}`} kg={available} label={b.batch_no} />
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="soak-remarks">Remarks</label>
          <input id="soak-remarks" name="remarks" className="input" placeholder="Optional" />
        </div>
        {canAuthorize && (
          <div>
            <label className="label" htmlFor="soak-auth">Manager authorisation (only if over quantity)</label>
            <input id="soak-auth" name="authorization" className="input" placeholder="Reason, recorded in history" />
          </div>
        )}
      </div>
      <button className="btn-primary" disabled={none || tanks.length === 0}>
        Start soaking
      </button>
    </form>
  );
}

function QtyBox({ name, kg, label }: { name: string; kg: number; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <input name={name} type="number" step="any" min="0.01" defaultValue={Number(kg) / 100} className="input w-28 text-right" aria-label={`Quantity from ${label} in quintals`} />
      <span className="text-xs text-muted">q</span>
    </span>
  );
}

/** Steaming finished: close the lot and load the dryer chosen when it started. */
export function FinishSteamingForm({ batch, back, dryer }: { batch: Batch; back: string; dryer: string }) {
  return (
    <form action={finishSteaming} className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-[#fbf8ef] p-3">
      <input type="hidden" name="id" value={batch.id} />
      <input type="hidden" name="batch_no" value={batch.batch_no} />
      <input type="hidden" name="back" value={back} />
      <div>
        <label className="label">Steaming finished at (blank = now)</label>
        <input name="ended_at" type="datetime-local" className="input w-auto" />
      </div>
      <button className="btn-primary">Steaming done → load {dryer}</button>
    </form>
  );
}

export type UnloadedRow = { variety_id: string; variety: string; std_tank_kg: number | null; waiting_kg: number; trucks: number; oldest_at: string };

/** Unloaded paddy waiting for a soaking tank, per variety. */
export function UnloadedSummary({ rows }: { rows: UnloadedRow[] }) {
  if (!rows.length) return <Empty>No unloaded paddy is waiting. It appears here when the unloading QC is posted.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Variety</th>
            <th className="text-right">Waiting</th>
            <th className="text-right">Per tank</th>
            <th className="text-right">≈ Tanks</th>
            <th>Trucks</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.variety_id}>
              <td className="font-bold text-ink">{r.variety}</td>
              <td className="text-right">
                <Qty kg={r.waiting_kg} />
              </td>
              <td className="text-right whitespace-nowrap">{r.std_tank_kg ? q(r.std_tank_kg) : <span className="text-[#b5532f]">not set</span>}</td>
              <td className="text-right font-bold text-ink tabular-nums">{r.std_tank_kg ? (Number(r.waiting_kg) / Number(r.std_tank_kg)).toFixed(1) : "—"}</td>
              <td className="tabular-nums">{r.trucks}</td>
              <td className="text-xs whitespace-nowrap">{dateTime(r.oldest_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One click: fill this tank with the variety's standard weight from the unloaded total. */
export function SoakingStartButton({ tank, rows, back }: { tank: Equipment; rows: UnloadedRow[]; back: string }) {
  const usable = rows.filter((r) => r.std_tank_kg);
  if (!rows.length) return <p className="text-[11px] text-muted">Nothing unloaded to soak.</p>;
  if (!usable.length) return <p className="text-[11px] text-[#b5532f]">Set the standard weight per tank in Admin → Masters.</p>;
  return (
    <form action={startSoakingStandard} className="flex flex-col gap-1.5 border-t border-line pt-2">
      <input type="hidden" name="tank_id" value={tank.id} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="request_id" value={randomUUID()} />
      {usable.length === 1 ? (
        <input type="hidden" name="variety_id" value={usable[0].variety_id} />
      ) : (
        <select name="variety_id" className="input py-1 text-[12px]" aria-label={`Variety for ${tank.name}`} defaultValue={usable[0].variety_id}>
          {usable.map((r) => (
            <option key={r.variety_id} value={r.variety_id}>
              {r.variety} — {q(r.std_tank_kg)} per tank
            </option>
          ))}
        </select>
      )}
      <button className="btn-primary py-1 text-[12px]">
        Start soaking{usable.length === 1 ? ` · ${usable[0].variety} ${q(Math.min(Number(usable[0].std_tank_kg), Number(usable[0].waiting_kg)))}` : ""}
      </button>
    </form>
  );
}

/** Tanks soaking right now, with start, expected finish and elapsed time. */
export function SoakingNow({ batches, equipmentById, varietyName, userName }: {
  batches: Batch[];
  equipmentById: Map<string, Equipment>;
  varietyName: (id: string | null) => string;
  userName: (id: string | null) => string;
}) {
  const running = batches.filter((b) => b.stage === "soaking" && b.status === "running");
  if (!running.length) return <Empty>No tank is soaking right now.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Tank</th>
            <th>Batch</th>
            <th>Variety</th>
            <th className="text-right">Paddy</th>
            <th>Started</th>
            <th>Expected end</th>
            <th>Soaking for</th>
            <th>Started by</th>
          </tr>
        </thead>
        <tbody>
          {running.map((b) => {
            const eq = b.equipment_id ? equipmentById.get(b.equipment_id) : undefined;
            const hoursExp = eq?.expected_hours_max ?? 12;
            const end = b.started_at ? new Date(new Date(b.started_at).getTime() + hoursExp * 3600000).toISOString() : null;
            const mins = elapsedMinutes(b);
            const overdue = mins !== null && mins > hoursExp * 60;
            return (
              <tr key={b.id}>
                <td className="font-bold whitespace-nowrap text-ink">{eq?.name.replace("Soaking ", "") ?? "—"}</td>
                <td>
                  <BatchLink no={b.batch_no} />
                </td>
                <td>{varietyName(b.variety_id)}</td>
                <td className="text-right">
                  <Qty kg={b.input_kg} />
                </td>
                <td className="text-xs whitespace-nowrap">{dateTime(b.started_at)}</td>
                <td className="text-xs whitespace-nowrap">{dateTime(end)}</td>
                <td className={`text-xs font-bold whitespace-nowrap ${overdue ? "text-[#d10b0b]" : "text-ink"}`}>
                  {hours(mins)}
                  {overdue ? " · overdue" : ""}
                </td>
                <td className="text-xs whitespace-nowrap">{userName(b.operator_id)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
