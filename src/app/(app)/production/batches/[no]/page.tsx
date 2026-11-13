import Link from "next/link";
import { notFound } from "next/navigation";
import { GitBranch } from "lucide-react";
import { Card, Empty, Field, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { BatchLink, CancelForm, CompleteForm, ProductionNav, Qty, StageChip, elapsedMinutes } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { FAULT_REPORTERS, PRODUCTION_APPROVERS, PRODUCTION_QUALITY, STAGE_OPERATORS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import { MILL_STEPS, STAGE_META, eventLabel, findBatch, hours, loadMasters, q, type Batch } from "@/lib/production";
import { approveQuantity, correctQuantity, reportFault, setQuality } from "../../actions";

export const metadata = { title: "Batch · Production" };

export default async function BatchPage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { no } = await params;
  const sp = await searchParams;
  const { profile, supabase } = await requireModule("processing");
  const b = await findBatch(decodeURIComponent(no));
  if (!b) notFound();
  const m = await loadMasters();
  const here = `/production/batches/${b.batch_no}`;
  const [inputs, outputs, steps, faults, events, ledger, bal] = await Promise.all([
    supabase.from("batch_inputs").select("qty_kg, created_at, parent:production_batches!batch_inputs_parent_id_fkey(id, batch_no, stage, status, equipment_id)").eq("child_id", b.id),
    supabase.from("batch_inputs").select("qty_kg, created_at, child:production_batches!batch_inputs_child_id_fkey(id, batch_no, stage, status, equipment_id, grade_id)").eq("parent_id", b.id),
    supabase.from("milling_stage_events").select("*").eq("batch_id", b.id).order("step_no"),
    supabase.from("production_faults").select("*").eq("batch_id", b.id).order("started_at"),
    supabase.from("batch_events").select("*").eq("batch_id", b.id).order("at").order("id"),
    supabase.from("batch_quantity_ledger").select("*").eq("batch_id", b.id).order("id"),
    supabase.from("production_batch_balances").select("consumed_kg, available_kg").eq("id", b.id).single(),
  ]);
  type Rel = { id: string; batch_no: string; stage: Batch["stage"]; status: string; equipment_id: string | null; grade_id?: string | null };
  const eq = b.equipment_id ? m.equipmentById.get(b.equipment_id) : null;
  const snap = b.source_snapshot;
  const role = profile.role;
  const isOperator = STAGE_OPERATORS[b.stage].includes(role);
  const isManager = PRODUCTION_APPROVERS.includes(role);
  const live = b.status !== "cancelled";
  const meta = STAGE_META[b.stage];

  return (
    <>
      <PageHeader
        title={b.batch_no}
        description={`${meta.label}${eq ? ` · ${eq.name}` : ""}${b.grade_id ? ` · ${m.gradeById.get(b.grade_id)?.name}` : ""}`}
        crumbs={[{ label: "Production", href: "/production" }, { label: meta.label, href: meta.href }]}
        actions={
          <Link href={`/production/trace?q=${b.batch_no}`} className="btn-primary">
            <GitBranch className="size-4" /> Full traceability
          </Link>
        }
      />
      <ProductionNav active="" />
      <Flash error={sp.error} notice={sp.notice} />

      <div className="mb-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card tone={meta.color} title="Batch details">
          <dl className="grid gap-4 p-5 sm:grid-cols-3">
            <Field label="Stage">
              <StageChip stage={b.stage} />
            </Field>
            <Field label="Status">
              <StatusBadge status={b.status} />
            </Field>
            <Field label="Equipment">{eq?.name ?? "—"}</Field>
            {b.pair_no && <Field label="Tank pair">{`Tanks ${b.pair_no * 2 - 1} & ${b.pair_no * 2} → Dryer ${b.pair_no}`}</Field>}
            <Field label="Variety">{b.variety_id ? m.varietyById.get(b.variety_id)?.name : "Mixed / not set"}</Field>
            {b.grade_id && <Field label="Grade">{m.gradeById.get(b.grade_id)?.name}</Field>}
            <Field label="Input">
              <Qty kg={b.input_kg} />
            </Field>
            <Field label="Output">
              <Qty kg={b.output_kg} status={b.output_qty_status} />
            </Field>
            <Field label="Rejected / loss">
              {q(b.rejected_kg)} / {b.loss_kg === null ? "—" : q(b.loss_kg)}
            </Field>
            <Field label="Passed to next stage">{q(bal.data?.consumed_kg)}</Field>
            <Field label="Remaining">{q(bal.data?.available_kg)}</Field>
            <Field label="Quantity status">{b.output_qty_status ? <StatusBadge status={b.output_qty_status} /> : "—"}</Field>
            <Field label="Started">{dateTime(b.started_at)}</Field>
            <Field label="Ended">{dateTime(b.ended_at)}</Field>
            <Field label="Duration">{hours(b.duration_minutes ?? (b.status === "running" ? elapsedMinutes(b) : null))}</Field>
            <Field label="Operator">{m.userName(b.operator_id)}</Field>
            <Field label="Completed by">{m.userName(b.completed_by)}</Field>
            {b.moisture_pct !== null && <Field label="Moisture">{b.moisture_pct}%</Field>}
            {b.quality_status && (
              <Field label="Quality">
                <StatusBadge status={b.quality_status} />
              </Field>
            )}
            {b.authorization_reason && <Field label="Authorisation">{b.authorization_reason}</Field>}
            {b.remarks && <Field label="Remarks">{b.remarks}</Field>}
            {b.cancel_reason && <Field label="Cancelled">{`${dateTime(b.cancelled_at)} — ${b.cancel_reason}`}</Field>}
          </dl>
          {snap && (
            <div className="border-t border-line p-5">
              <h3 className="mb-3 text-[13px] font-bold text-ink">Original truck (frozen at receipt)</h3>
              <dl className="grid gap-4 sm:grid-cols-3">
                <Field label="RST">{`${snap.rst} (${snap.rst_cycle ?? "no cycle"})`}</Field>
                <Field label="Vehicle">{snap.vehicle_no}</Field>
                <Field label="Weighbridge ticket">{snap.ticket_pid}</Field>
                <Field label="Gross / tare / net">{`${Number(snap.gross_kg).toLocaleString("en-IN")} / ${Number(snap.tare_kg).toLocaleString("en-IN")} / ${Number(snap.net_kg).toLocaleString("en-IN")} kg`}</Field>
                <Field label="Weighed">{dateTime(String(snap.weighed_at))}</Field>
                <Field label="Supplier / broker">{`${snap.supplier ?? "—"} / ${snap.broker ?? "—"}`}</Field>
                <Field label="Variety">{snap.variety}</Field>
                <Field label="Lot">{snap.lot_no}</Field>
                <Field label="QC">{`${snap.qc_pid} · ${snap.qc_user ?? ""} · ${snap.moisture_pct}% moisture`}</Field>
                <Field label="Sacks / rejected bags">{`${snap.sacks_received} / ${snap.rejected_bags}`}</Field>
                <Field label="Accepted">{`${Number(snap.accepted_kg).toLocaleString("en-IN")} kg`}</Field>
              </dl>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          {live && (
            <Card tone="#1f6b32" title="Actions">
              <div className="space-y-3 p-4">
                {b.status === "running" && isOperator && (
                  <CompleteForm batch={b} back={here} needsOutput={["precleaning", "drying", "milling"].includes(b.stage)} moisture={b.stage === "drying"} />
                )}
                {isManager && b.status !== "running" && ["estimated", "entered"].includes(b.output_qty_status ?? "") && (
                  <form action={approveQuantity} className="flex gap-2">
                    <input type="hidden" name="id" value={b.id} />
                    <input type="hidden" name="batch_no" value={b.batch_no} />
                    <input type="hidden" name="back" value={here} />
                    <input name="note" className="input" placeholder="Approval note (optional)" />
                    <button className="btn-secondary whitespace-nowrap">Approve quantity</button>
                  </form>
                )}
                {PRODUCTION_QUALITY.includes(role) && (
                  <details>
                    <summary className="btn-secondary cursor-pointer list-none">Record quality / moisture…</summary>
                    <form action={setQuality} className="mt-2 grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2">
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="batch_no" value={b.batch_no} />
                      <input type="hidden" name="back" value={here} />
                      <input name="moisture_pct" type="number" step="0.1" min="0" max="60" className="input" placeholder="Moisture %" />
                      <select name="quality_status" className="input" defaultValue="">
                        <option value="">Quality unchanged</option>
                        <option value="pending">Pending</option>
                        <option value="passed">Passed</option>
                        <option value="hold">On hold</option>
                        <option value="rejected">Rejected</option>
                      </select>
                      <input name="note" className="input sm:col-span-2" placeholder="Note" />
                      <button className="btn-primary sm:col-span-2">Save</button>
                    </form>
                  </details>
                )}
                {isManager && b.status !== "running" && !(b.stage === "output" && b.output_qty_status === "confirmed") && (
                  <details>
                    <summary className="btn-secondary cursor-pointer list-none">Authorised correction…</summary>
                    <form action={correctQuantity} className="mt-2 grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2">
                      <input type="hidden" name="id" value={b.id} />
                      <input type="hidden" name="batch_no" value={b.batch_no} />
                      <input type="hidden" name="back" value={here} />
                      <select name="field" className="input">
                        <option value="output_kg">Output quantity</option>
                        <option value="rejected_kg">Rejected quantity</option>
                      </select>
                      <input name="new_q" type="number" step="0.01" min="0" className="input" placeholder="Corrected value (q)" required />
                      <input name="reason" className="input sm:col-span-2" placeholder="Reason (required, kept on record)" required />
                      <button className="btn-primary sm:col-span-2">Save correction</button>
                    </form>
                  </details>
                )}
                {FAULT_REPORTERS.includes(role) && (
                  <details>
                    <summary className="btn-secondary cursor-pointer list-none">Report fault / downtime…</summary>
                    <form action={reportFault} className="mt-2 grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2">
                      <input type="hidden" name="batch_id" value={b.id} />
                      <input type="hidden" name="equipment_id" value={b.equipment_id ?? ""} />
                      <input type="hidden" name="back" value={here} />
                      <select name="severity" className="input" defaultValue="medium">
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="critical">Critical</option>
                      </select>
                      <input name="started_at" type="datetime-local" className="input" aria-label="Fault start (blank = now)" />
                      <input name="description" className="input sm:col-span-2" placeholder="What happened?" required />
                      <button className="btn-primary sm:col-span-2">Report</button>
                    </form>
                  </details>
                )}
                {isManager && <CancelForm batch={b} back={here} />}
                {!isOperator && !isManager && !PRODUCTION_QUALITY.includes(role) && <p className="text-[13px] text-muted">Read-only for your role.</p>}
              </div>
            </Card>
          )}

          <Card tone="#3e6fc0" title="Came from">
            {(inputs.data ?? []).length === 0 ? (
              <Empty>{b.stage === "receipt" ? "Truck receipt — start of the chain." : "No inputs."}</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {(inputs.data ?? []).map((i) => {
                  const p = i.parent as unknown as Rel;
                  return (
                    <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span>
                        <BatchLink no={p.batch_no} /> <span className="text-[12px] text-muted">{STAGE_META[p.stage].label}{p.equipment_id ? ` · ${m.equipmentById.get(p.equipment_id)?.name}` : ""}</span>
                      </span>
                      <Qty kg={i.qty_kg} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card tone="#7b4f8e" title="Went to">
            {(outputs.data ?? []).length === 0 ? (
              <Empty>Not passed on yet.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {(outputs.data ?? []).map((i) => {
                  const c = i.child as unknown as Rel;
                  return (
                    <li key={c.id} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${c.status === "cancelled" ? "opacity-60" : ""}`}>
                      <span>
                        <BatchLink no={c.batch_no} />{" "}
                        <span className="text-[12px] text-muted">
                          {c.grade_id ? m.gradeById.get(c.grade_id)?.name : STAGE_META[c.stage].label}
                          {c.equipment_id ? ` · ${m.equipmentById.get(c.equipment_id)?.name}` : ""}
                          {c.status === "cancelled" ? " · cancelled" : ""}
                        </span>
                      </span>
                      <Qty kg={i.qty_kg} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {b.stage === "milling" && (
        <Card tone="#3e6fc0" title="Milling steps" className="mb-6">
          <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
            {MILL_STEPS.map((s, i) => {
              const r = (steps.data ?? []).find((x) => x.step === s);
              return (
                <div key={s} className="rounded-md border border-line p-3">
                  <div className="text-[13px] font-bold capitalize text-ink">
                    {i + 1}. {s}
                  </div>
                  <div className="mt-1 text-[11px] text-muted">Start: {dateTime(r?.started_at)}</div>
                  <div className="text-[11px] text-muted">End: {dateTime(r?.ended_at)}</div>
                  {r?.started_at && r?.ended_at && <div className="mt-1 text-[12px] font-bold text-ink">{hours((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 60000)}</div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {(faults.data ?? []).length > 0 && (
        <Card tone="#d10b0b" title="Faults and downtime" className="mb-6">
          <ul className="divide-y divide-line">
            {(faults.data ?? []).map((f) => (
              <li key={f.id} className="px-4 py-2.5 text-[13px]">
                <b className="capitalize">{f.severity}</b> · {f.description} · {dateTime(f.started_at)} → {f.ended_at ? `${dateTime(f.ended_at)} (${hours(f.downtime_minutes)})` : "open"}
                {f.resolution && <span className="text-muted"> · {f.resolution}</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#c08a24" title="Batch history">
          <ol className="divide-y divide-line">
            {(events.data ?? []).map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div>
                  <div className="text-[13px] font-bold text-ink">{eventLabel(e.event_type)}</div>
                  <div className="text-[12px] text-muted">
                    {dateTime(e.at)} · {m.userName(e.user_id)}
                    {e.note ? ` · ${e.note}` : ""}
                    {e.data?.field ? ` · ${e.data.field}: ${q(e.data.old)} → ${q(e.data.new)}` : ""}
                  </div>
                </div>
                {e.qty_kg !== null && <Qty kg={e.qty_kg} />}
              </li>
            ))}
          </ol>
        </Card>
        <Card tone="#4b5563" title="Quantity ledger">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Entry</th>
                  <th className="text-right">kg</th>
                  <th>Status</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {(ledger.data ?? []).map((l) => (
                  <tr key={l.id}>
                    <td className="text-xs whitespace-nowrap">{dateTime(l.at)}</td>
                    <td className="capitalize">{l.entry.replace(/_/g, " ")}</td>
                    <td className="text-right tabular-nums">{Number(l.qty_kg).toLocaleString("en-IN")}</td>
                    <td>{l.qty_status ? <StatusBadge status={l.qty_status} /> : "—"}</td>
                    <td className="text-xs">{l.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
