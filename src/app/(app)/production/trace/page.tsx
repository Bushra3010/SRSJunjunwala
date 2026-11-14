import Link from "next/link";
import { Search, Truck } from "lucide-react";
import { Card, Empty, Flash, Note, PageHeader, StatusBadge } from "@/components/ui";
import { BatchLink, ProductionNav, Qty, StageChip } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { STAGES, STAGE_META, eventLabel, findBatch, hours, loadMasters, q, traceBatch, type Batch } from "@/lib/production";

export const metadata = { title: "Batch traceability · Production" };

export default async function TracePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("processing");
  const query = (sp.q ?? "").trim();
  let matches: Batch[] = [];
  let batch: Batch | null = null;
  if (query) {
    batch = await findBatch(query);
    if (!batch) {
      const { data } = await supabase.rpc("find_production_batches", { p_query: query });
      matches = (data ?? []) as Batch[];
      if (matches.length === 1) batch = matches[0];
    }
  }
  const m = await loadMasters();
  const t = batch ? await traceBatch(batch.id) : null;

  const unit = (b: Batch) => {
    const e = b.equipment_id ? m.equipmentById.get(b.equipment_id) : null;
    if (b.stage === "output") return m.gradeById.get(b.grade_id!)?.name;
    if (b.stage === "receipt") return `RST ${b.source_snapshot?.rst} · ${b.source_snapshot?.vehicle_no}`;
    return e?.name;
  };
  const family = t ? [...t.batches.values()] : [];
  const upIds = new Set(t?.ancestors.map((a) => a.batch_id));
  const downIds = new Set(t?.descendants.map((d) => d.batch_id));
  const origins = family.filter((b) => b.stage === "receipt" && (upIds.has(b.id) || b.id === batch?.id));

  return (
    <>
      <PageHeader
        title="Batch traceability"
        description="Search any batch ID, RST, vehicle number, QC/ticket ID or stock lot. See where the material came from, where it went and everything that happened to it."
        crumbs={[{ label: "Production", href: "/production" }]}
      />
      <ProductionNav active="trace" />

      <form action="/production/trace" className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-60 flex-1">
          <label className="label" htmlFor="tq">Batch ID, RST, vehicle or lot</label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-gray-400" />
            <input id="tq" name="q" defaultValue={query} placeholder="OUT-2026-00001, RST 201, PB10GH2020…" className="input pl-8" autoFocus />
          </div>
        </div>
        <button className="btn-primary">Trace</button>
      </form>

      {query && !batch && (
        matches.length === 0 ? (
          <Flash error={`Nothing found for "${query}".`} />
        ) : (
          <Card tone="#4b5563" title={`${matches.length} matches — pick one`} className="mb-6">
            <ul className="divide-y divide-line">
              {matches.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Link href={`/production/trace?q=${b.batch_no}`} className="font-mono text-[13px] font-bold text-[#1f6b32] hover:underline">
                    {b.batch_no}
                  </Link>
                  <StageChip stage={b.stage} />
                  <span className="text-[12px] text-muted">{unit(b)} · {dateTime(b.started_at)}</span>
                  <StatusBadge status={b.status} />
                </li>
              ))}
            </ul>
          </Card>
        )
      )}

      {batch && t && (
        <>
          {t.error && <Flash error={t.error.message} />}
          <Card tone="#1f6b32" title={<>Original truck{origins.length > 1 ? "s" : ""} for <span className="font-mono">{batch.batch_no}</span></>} className="mb-6">
            {origins.length === 0 ? (
              <Empty>No truck receipt upstream (or it is not visible to your role).</Empty>
            ) : (
              <div className="grid gap-4 p-4 md:grid-cols-2">
                {origins.map((r) => {
                  const s = r.source_snapshot ?? {};
                  return (
                    <div key={r.id} className="rounded-md border border-line p-4">
                      <div className="mb-2 flex items-center gap-2">
                        <Truck className="size-5 text-[#1f6b32]" />
                        <BatchLink no={r.batch_no} />
                        {r.status === "cancelled" && <StatusBadge status="cancelled" />}
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                        <dt className="text-muted">RST</dt>
                        <dd className="font-bold text-ink">{s.rst} <span className="font-normal text-muted">({s.rst_cycle ?? "—"})</span></dd>
                        <dt className="text-muted">Vehicle</dt>
                        <dd className="font-bold text-ink">{s.vehicle_no}</dd>
                        <dt className="text-muted">Ticket / QC</dt>
                        <dd className="font-bold text-ink">{s.ticket_pid} / {s.qc_pid}</dd>
                        <dt className="text-muted">Supplier · broker</dt>
                        <dd className="font-bold text-ink">{s.supplier ?? "—"} · {s.broker ?? "—"}</dd>
                        <dt className="text-muted">Variety</dt>
                        <dd className="font-bold text-ink">{s.variety}</dd>
                        <dt className="text-muted">Gross / tare / net</dt>
                        <dd className="font-bold text-ink">{Number(s.gross_kg).toLocaleString("en-IN")} / {Number(s.tare_kg).toLocaleString("en-IN")} / {Number(s.net_kg).toLocaleString("en-IN")} kg</dd>
                        <dt className="text-muted">Received into production</dt>
                        <dd className="font-bold text-ink">{q(r.output_kg)}</dd>
                        <dt className="text-muted">Weighed</dt>
                        <dd className="font-bold text-ink">{dateTime(String(s.weighed_at ?? ""))}</dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card tone="#3e6fc0" title="Genealogy by stage" className="mb-6">
            <div className="overflow-x-auto p-4">
              <div className="flex min-w-max gap-3">
                {STAGES.filter((stage) => stage !== "precleaning" || family.some((b) => b.stage === "precleaning")).map((stage) => {
                  const items = family.filter((b) => b.stage === stage).sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
                  return (
                    <div key={stage} className="w-52 shrink-0">
                      <div className="mb-2 flex items-center justify-between">
                        <StageChip stage={stage} />
                        <span className="text-[11px] text-muted">{items.length}</span>
                      </div>
                      <div className="space-y-2">
                        {items.length === 0 && <div className="rounded-md border border-dashed border-line p-3 text-[11px] text-muted">—</div>}
                        {items.map((b) => {
                          const self = b.id === batch.id;
                          const dir = self ? "Searched" : upIds.has(b.id) ? "Upstream" : downIds.has(b.id) ? "Downstream" : "";
                          return (
                            <div
                              key={b.id}
                              className={`rounded-md border p-2.5 text-[11px] ${self ? "border-[#c08a24] bg-[#fbf3df] ring-2 ring-[#d8a242]" : "border-line bg-white"} ${b.status === "cancelled" ? "opacity-60" : ""}`}
                            >
                              <div className="flex items-center justify-between gap-1">
                                <BatchLink no={b.batch_no} className="text-[12px]" />
                                <span className="text-muted">{dir}</span>
                              </div>
                              <div className="mt-0.5 truncate font-semibold text-ink">{unit(b) ?? "—"}</div>
                              <div className="text-muted">
                                {b.input_kg !== null ? `${q(b.input_kg)} → ` : ""}
                                {q(b.output_kg)}
                                {b.output_qty_status === "estimated" ? " (est.)" : ""}
                              </div>
                              <div className="text-muted">{dateTime(b.started_at)}</div>
                              {b.ended_at && b.stage !== "output" && <div className="text-muted">→ {dateTime(b.ended_at)} · {hours(b.duration_minutes)}</div>}
                              {b.status === "cancelled" && <div className="font-bold text-[#d10b0b]">Cancelled</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>

          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <Card tone="#b5532f" title={`Backward trace (${upIds.size} batches)`}>
              {t.ancestors.length === 0 ? (
                <Empty>This is the start of the chain.</Empty>
              ) : (
                <EdgeTable edges={t.ancestors.map((a) => ({ from: a.batch_id, to: a.child_id!, qty: a.qty_kg, depth: a.depth }))} batches={t.batches} unit={unit} sortDesc={false} />
              )}
            </Card>
            <Card tone="#7b4f8e" title={`Forward trace (${downIds.size} batches)`}>
              {t.descendants.length === 0 ? (
                <Empty>Nothing downstream yet.</Empty>
              ) : (
                <EdgeTable edges={t.descendants.map((d) => ({ from: d.parent_id!, to: d.batch_id, qty: d.qty_kg, depth: d.depth }))} batches={t.batches} unit={unit} sortDesc />
              )}
            </Card>
          </div>

          <Card tone="#c08a24" title={`Complete timeline (${t.timeline.length} events)`}>
            <Note>All events of this batch and every batch linked to it, oldest first. API: <code>/api/production/trace/{batch.batch_no}/timeline</code></Note>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Stage</th>
                    <th>Batch</th>
                    <th>Event</th>
                    <th className="text-right">Quantity</th>
                    <th>User</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {t.timeline.map((e) => (
                    <tr key={e.event_id} className={e.batch_id === batch.id ? "bg-[#fbf3df]" : undefined}>
                      <td className="text-xs whitespace-nowrap">{dateTime(e.at)}</td>
                      <td>
                        <StageChip stage={e.stage} />
                      </td>
                      <td>
                        <BatchLink no={e.batch_no} />
                      </td>
                      <td className="font-semibold text-ink">
                        {eventLabel(e.event_type)}
                        {e.related_batch_no && <span className="font-normal text-muted"> · {e.related_batch_no}</span>}
                      </td>
                      <td className="text-right">{e.qty_kg !== null ? <Qty kg={e.qty_kg} /> : "—"}</td>
                      <td className="text-xs whitespace-nowrap">{e.user_name ?? "—"}</td>
                      <td className="text-xs">{e.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {!query && (
        <Card tone="#4b5563" title="How tracing works">
          <div className="space-y-2 p-5 text-[13px] text-muted">
            <p>Every stage gets a permanent ID: RCV (truck) → SOAK (tank) → LOT (steaming lot) → DRY (dryer) → MFD (mill feed) → MIL (milling) → OUT (rice grade).</p>
            <p>Each move records which batch fed which, and how much. Searching an OUT ID walks back to the truck; searching an RCV or RST walks forward to every rice grade it produced.</p>
          </div>
        </Card>
      )}
    </>
  );
}

function EdgeTable({
  edges,
  batches,
  unit,
  sortDesc,
}: {
  edges: { from: string; to: string; qty: number; depth: number }[];
  batches: Map<string, Batch>;
  unit: (b: Batch) => string | undefined;
  sortDesc: boolean;
}) {
  const order = (id: string) => STAGES.indexOf(batches.get(id)?.stage ?? "receipt");
  const rows = [...edges].sort((a, b) => (sortDesc ? order(a.to) - order(b.to) : order(b.from) - order(a.from)));
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>From</th>
            <th>To</th>
            <th className="text-right">Moved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const f = batches.get(e.from);
            const to = batches.get(e.to);
            return (
              <tr key={`${e.from}-${e.to}`}>
                <td>
                  {f ? <BatchLink no={f.batch_no} /> : "—"}
                  <div className="text-[11px] text-muted">{f && `${STAGE_META[f.stage].label} · ${unit(f) ?? ""}`}</div>
                </td>
                <td>
                  {to ? <BatchLink no={to.batch_no} /> : "—"}
                  <div className="text-[11px] text-muted">{to && `${STAGE_META[to.stage].label} · ${unit(to) ?? ""}`}</div>
                </td>
                <td className="text-right">
                  <Qty kg={e.qty} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
