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
  // Recent milling batches whose outputs are compared with the variety's standards.
  const { data: recentMills } = await supabase
    .from("production_batches")
    .select("id")
    .eq("stage", "milling")
    .in("status", ["completed", "consumed"])
    .order("ended_at", { ascending: false })
    .limit(8);
  const millIds = [...new Set([...parentOf.values(), ...ready.map((r) => r.batch.id), ...(recentMills ?? []).map((r) => r.id)])];
  const { data: mills } = millIds.length
    ? await supabase.from("production_batches").select("id, batch_no, input_kg, output_kg, variety_id, ended_at, status").in("id", millIds)
    : { data: [] };
  const varietyIds = [...new Set((mills ?? []).map((x) => x.variety_id).filter(Boolean))] as string[];
  const { data: stdRows } = varietyIds.length
    ? await supabase.from("variety_output_standards").select("variety_id, grade_id, std_pct, min_pct, max_pct").in("variety_id", varietyIds)
    : { data: [] };
  const stdOf = (varietyId: string | null, gradeId: string) => (stdRows ?? []).find((r) => r.variety_id === varietyId && r.grade_id === gradeId);
  const millById = new Map((mills ?? []).map((x) => [x.id, x]));
  // Recorded outputs per milling batch for the actual-vs-reference comparison.
  const { data: siblings } = millIds.length
    ? await supabase.from("batch_inputs").select("parent_id, qty_kg, child:production_batches!batch_inputs_child_id_fkey(grade_id, status)").in("parent_id", millIds)
    : { data: [] };

  return (
    <>
      <PageHeader
        title="Final rice output"
        description="Record each rice grade and by-product separately. Actual recovery is compared with the variety's standards (Production → Recovery standards) and flagged when it is outside the allowed range."
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
                      <RecoveryTable mill={mb} recorded={recorded} grades={m.grades} stdOf={stdOf} />
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

      {(recentMills ?? []).length > 0 && (
        <Card tone="#3e6fc0" title="Recovery vs standard — recent milling batches" className="mb-6">
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            {(recentMills ?? []).map((r) => {
              const mb = millById.get(r.id);
              if (!mb) return null;
              const recorded = (siblings ?? []).filter((x) => x.parent_id === mb.id && (x.child as unknown as { status: string })?.status !== "cancelled");
              return (
                <div key={mb.id} className="rounded-md border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <BatchLink no={mb.batch_no} />
                    <span className="text-[12px] text-muted">
                      {mb.variety_id ? m.varietyById.get(mb.variety_id)?.name : "Mixed variety"} · {q(mb.input_kg)} paddy · {dateTime(mb.ended_at)}
                    </span>
                  </div>
                  <RecoveryTable mill={mb} recorded={recorded} grades={m.grades} stdOf={stdOf} />
                </div>
              );
            })}
          </div>
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

type Rec = { qty_kg: number; child: unknown };
type StdRow = { std_pct: number; min_pct: number | null; max_pct: number | null } | undefined;

/** Actual output per grade / by-product as % of paddy milled, against the variety's standard range. */
function RecoveryTable({
  mill,
  recorded,
  grades,
  stdOf,
}: {
  mill: { input_kg: number | null; variety_id: string | null };
  recorded: Rec[];
  grades: { id: string; name: string; kind: string; reference_pct: number | null }[];
  stdOf: (varietyId: string | null, gradeId: string) => StdRow;
}) {
  const paddy = Number(mill.input_kg) || 0;
  return (
    <table className="mt-3 w-full text-[12px]">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-semibold">Output</th>
          <th className="py-1 text-right font-semibold">Standard</th>
          <th className="py-1 text-right font-semibold">Actual</th>
          <th className="py-1 text-right font-semibold">Check</th>
        </tr>
      </thead>
      <tbody>
        {grades.map((g) => {
          const actualKg = recorded.filter((x) => (x.child as { grade_id: string })?.grade_id === g.id).reduce((a, x) => a + Number(x.qty_kg), 0);
          const pct = paddy ? (actualKg / paddy) * 100 : 0;
          const st = stdOf(mill.variety_id, g.id);
          const lo = st ? (st.min_pct ?? st.std_pct) : null;
          const hi = st ? (st.max_pct ?? st.std_pct) : null;
          const flag = !st || !actualKg ? null : pct < Number(lo) - 0.005 ? "Below" : pct > Number(hi) + 0.005 ? "Above" : "OK";
          return (
            <tr key={g.id} className="border-t border-line">
              <td className="py-1 font-semibold text-ink">
                {g.name}
                {g.kind === "by_product" && <span className="font-normal text-muted"> · by-product</span>}
              </td>
              <td className="py-1 text-right text-muted tabular-nums">
                {st ? `${Number(st.std_pct)}%${st.min_pct !== null || st.max_pct !== null ? ` (${st.min_pct ?? st.std_pct}–${st.max_pct ?? st.std_pct})` : ""}` : "not set"}
              </td>
              <td className="py-1 text-right font-bold text-ink tabular-nums">{actualKg ? `${q(actualKg)} · ${pct.toFixed(1)}%` : "—"}</td>
              <td className="py-1 text-right">
                {flag && (
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold text-white ${flag === "OK" ? "bg-[#0a8f44]" : flag === "Below" ? "bg-[#c08a24]" : "bg-[#d10b0b]"}`}>
                    {flag}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
