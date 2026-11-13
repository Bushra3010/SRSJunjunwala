import { randomUUID } from "node:crypto";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { BatchFilters, BatchLink, CancelForm, ProductionNav, Qty } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { PRODUCTION_APPROVERS, PRODUCTION_QUALITY, STAGE_OPERATORS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import { loadMasters, q, readyBatches, stageHistory, type StageSP } from "@/lib/production";
import { approveQuantity, confirmOutput, recordOutput, setQuality } from "../actions";

export const metadata = { title: "Final output · Production" };

export default async function OutputsPage({ searchParams }: { searchParams: Promise<StageSP> }) {
  const sp = await searchParams;
  const { profile, supabase } = await requireModule("processing");
  const canRecord = STAGE_OPERATORS.output.includes(profile.role);
  const canApprove = PRODUCTION_APPROVERS.includes(profile.role);
  const canQuality = PRODUCTION_QUALITY.includes(profile.role);
  const [m, ready, history, locs] = await Promise.all([
    loadMasters(),
    readyBatches("milling"),
    stageHistory("output", sp, 300),
    supabase.from("locations").select("id, name, kind").eq("active", true).order("kind").order("name"),
  ]);
  const stores = (locs.data ?? []).filter((l) => l.kind === "finished_store" || l.kind === "other");

  // Parent milling batch of each output (one edge each).
  const outIds = history.batches.map((b) => b.id);
  const { data: edges } = outIds.length ? await supabase.from("batch_inputs").select("child_id, parent_id").in("child_id", outIds) : { data: [] };
  const parentOf = new Map((edges ?? []).map((e) => [e.child_id, e.parent_id]));
  const millIds = [...new Set([...parentOf.values(), ...ready.map((r) => r.batch.id)])];
  const { data: mills } = millIds.length ? await supabase.from("production_batches").select("id, batch_no, input_kg, output_kg").in("id", millIds) : { data: [] };
  const millById = new Map((mills ?? []).map((x) => [x.id, x]));
  // Recorded outputs per milling batch for the actual-vs-reference comparison.
  const { data: siblings } = millIds.length
    ? await supabase.from("batch_inputs").select("parent_id, qty_kg, child:production_batches!batch_inputs_child_id_fkey(grade_id, status)").in("parent_id", millIds)
    : { data: [] };

  return (
    <>
      <PageHeader
        title="Final rice output"
        description="Record each grade separately. Reference recoveries come from the process diagram and are shown for comparison only — enter what was actually produced."
        crumbs={[{ label: "Production", href: "/production" }]}
      />
      <ProductionNav active="outputs" />
      <Flash error={sp.error} notice={sp.notice} />

      {canRecord && (
        <Card tone="#1f6b32" title={`Milling batches with output to record (${ready.length})`} className="mb-6">
          {ready.length === 0 ? (
            <Empty>No completed milling batch has unassigned output.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {ready.map(({ batch: mb, available }) => {
                const recorded = (siblings ?? []).filter((s) => s.parent_id === mb.id && (s.child as unknown as { status: string })?.status !== "cancelled");
                return (
                  <li key={mb.id} className="grid gap-4 p-4 lg:grid-cols-[1fr_1.2fr]">
                    <div>
                      <BatchLink no={mb.batch_no} />
                      <div className="mt-1 text-[12px] text-muted">
                        Paddy in {q(mb.input_kg)} · rice out {q(mb.output_kg)} · <b className="text-ink">{q(available)} not yet graded</b>
                      </div>
                      <table className="mt-3 w-full text-[12px]">
                        <thead>
                          <tr className="text-left text-muted">
                            <th className="py-1 font-semibold">Grade</th>
                            <th className="py-1 text-right font-semibold">Reference</th>
                            <th className="py-1 text-right font-semibold">Actual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.grades.map((g) => {
                            const actual = recorded
                              .filter((s) => (s.child as unknown as { grade_id: string })?.grade_id === g.id)
                              .reduce((a, s) => a + Number(s.qty_kg), 0);
                            return (
                              <tr key={g.id} className="border-t border-line">
                                <td className="py-1 font-semibold text-ink">{g.name}</td>
                                <td className="py-1 text-right text-muted tabular-nums">
                                  {g.reference_pct}% ≈ {q(((g.reference_pct ?? 0) / 100) * Number(mb.input_kg))}
                                </td>
                                <td className="py-1 text-right font-bold text-ink tabular-nums">
                                  {actual ? `${q(actual)} · ${((actual / Number(mb.input_kg)) * 100).toFixed(1)}%` : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <form action={recordOutput} className="grid content-start gap-3 rounded-md border border-line bg-[#fbf8ef] p-3 sm:grid-cols-2">
                      <input type="hidden" name="milling_id" value={mb.id} />
                      <input type="hidden" name="request_id" value={randomUUID()} />
                      <div>
                        <label className="label">Grade</label>
                        <select name="grade_id" className="input" required defaultValue="">
                          <option value="" disabled>
                            Select grade
                          </option>
                          {m.grades.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label">Quantity (q)</label>
                        <input name="qty_q" type="number" step="0.01" min="0.01" className="input" required />
                      </div>
                      <div>
                        <label className="label">Produced at (blank = milling end)</label>
                        <input name="produced_at" type="datetime-local" className="input" />
                      </div>
                      <div>
                        <label className="label">Remarks</label>
                        <input name="remarks" className="input" />
                      </div>
                      {canApprove && (
                        <div className="sm:col-span-2">
                          <label className="label">Authorisation (only if exceeding milling output)</label>
                          <input name="authorization" className="input" />
                        </div>
                      )}
                      <button className="btn-primary sm:col-span-2">Record output</button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Card tone="#c08a24" title="Output records">
        <BatchFilters action="/production/outputs" sp={sp} />
        {history.batches.length === 0 ? (
          <Empty>No outputs recorded.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Output ID</th>
                  <th>Grade</th>
                  <th className="text-right">Quantity</th>
                  <th>Quantity status</th>
                  <th>Quality</th>
                  <th>Milling batch</th>
                  <th>Produced</th>
                  <th>Recorded by</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {history.batches.map((b) => {
                  const mill = millById.get(parentOf.get(b.id) ?? "");
                  const live = b.status !== "cancelled";
                  return (
                    <tr key={b.id} className={live ? undefined : "opacity-60"}>
                      <td>
                        <BatchLink no={b.batch_no} />
                        {!live && <div className="text-[11px] text-muted">Cancelled: {b.cancel_reason}</div>}
                      </td>
                      <td className="font-bold text-ink">{m.gradeById.get(b.grade_id!)?.name}</td>
                      <td className="text-right">
                        <Qty kg={b.output_kg} />
                      </td>
                      <td>
                        <StatusBadge status={b.output_qty_status ?? "entered"} />
                      </td>
                      <td>
                        <StatusBadge status={b.quality_status ?? "pending"} />
                      </td>
                      <td>{mill ? <BatchLink no={mill.batch_no} /> : "—"}</td>
                      <td className="text-xs whitespace-nowrap">{dateTime(b.ended_at)}</td>
                      <td className="text-xs whitespace-nowrap">{m.userName(b.operator_id)}</td>
                      <td>
                        {live && (
                          <div className="flex flex-wrap gap-1.5">
                            {canQuality && b.output_qty_status !== "confirmed" && (
                              <details>
                                <summary className="btn-secondary cursor-pointer list-none py-1">Quality</summary>
                                <form action={setQuality} className="mt-2 flex flex-wrap items-end gap-2 rounded-md border border-line p-2">
                                  <input type="hidden" name="id" value={b.id} />
                                  <input type="hidden" name="batch_no" value={b.batch_no} />
                                  <input type="hidden" name="back" value="/production/outputs" />
                                  <select name="quality_status" className="input w-auto" defaultValue={b.quality_status ?? "pending"}>
                                    <option value="pending">Pending</option>
                                    <option value="passed">Passed</option>
                                    <option value="hold">On hold</option>
                                    <option value="rejected">Rejected</option>
                                  </select>
                                  <input name="note" className="input w-40" placeholder="Note" />
                                  <button className="btn-primary py-1">Save</button>
                                </form>
                              </details>
                            )}
                            {canApprove && b.output_qty_status === "entered" && (
                              <form action={approveQuantity}>
                                <input type="hidden" name="id" value={b.id} />
                                <input type="hidden" name="batch_no" value={b.batch_no} />
                                <input type="hidden" name="back" value="/production/outputs" />
                                <button className="btn-secondary py-1">Approve</button>
                              </form>
                            )}
                            {canApprove && b.output_qty_status !== "confirmed" && (
                              <details>
                                <summary className="btn-primary cursor-pointer list-none py-1">To stock…</summary>
                                <form action={confirmOutput} className="mt-2 grid gap-2 rounded-md border border-line p-2">
                                  <input type="hidden" name="id" value={b.id} />
                                  <input type="hidden" name="batch_no" value={b.batch_no} />
                                  <select name="location_id" className="input" required defaultValue="">
                                    <option value="" disabled>
                                      Store location
                                    </option>
                                    {stores.map((l) => (
                                      <option key={l.id} value={l.id}>
                                        {l.name}
                                      </option>
                                    ))}
                                  </select>
                                  <input name="qty_q" type="number" step="0.01" className="input" placeholder={`Physical count (q), blank = ${(Number(b.output_kg) / 100).toFixed(2)}`} />
                                  <button className="btn-primary py-1">Confirm physical quantity</button>
                                </form>
                              </details>
                            )}
                            {canApprove && b.output_qty_status !== "confirmed" && <CancelForm batch={b} back="/production/outputs" />}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
