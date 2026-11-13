import { Card, Empty, Flash, PageHeader } from "@/components/ui";
import { ProductionNav } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { FAULT_REPORTERS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import { hours, loadMasters } from "@/lib/production";
import { reportFault, resolveFault } from "../actions";

export const metadata = { title: "Faults & downtime · Production" };

export default async function FaultsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { profile, supabase } = await requireModule("processing");
  const canReport = FAULT_REPORTERS.includes(profile.role);
  const m = await loadMasters();
  const { data } = await supabase
    .from("production_faults")
    .select("*, batch:production_batches(batch_no)")
    .order("started_at", { ascending: false })
    .limit(200);
  const open = (data ?? []).filter((f) => !f.ended_at);
  const closed = (data ?? []).filter((f) => f.ended_at);
  const downtime = closed.reduce((a, f) => a + Number(f.downtime_minutes ?? 0), 0);

  return (
    <>
      <PageHeader title="Faults & downtime" description="Report breakdowns against equipment or a batch; resolving one records the downtime." crumbs={[{ label: "Production", href: "/production" }]} />
      <ProductionNav active="faults" />
      <Flash error={sp.error} notice={sp.notice} />
      <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_1.4fr]">
        {canReport && (
          <Card tone="#b5532f" title="Report a fault">
            <form action={reportFault} className="grid gap-3 p-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="fe">Equipment</label>
                <select id="fe" name="equipment_id" className="input" required defaultValue="">
                  <option value="" disabled>
                    Select…
                  </option>
                  {m.equipment.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="fs">Severity</label>
                <select id="fs" name="severity" className="input" defaultValue="medium">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="fd">What happened</label>
                <input id="fd" name="description" className="input" required />
              </div>
              <div>
                <label className="label" htmlFor="ft">Started (blank = now)</label>
                <input id="ft" name="started_at" type="datetime-local" className="input" />
              </div>
              <button className="btn-primary self-end">Report fault</button>
            </form>
          </Card>
        )}
        <Card tone="#d10b0b" title={`Open faults (${open.length})`}>
          {open.length === 0 ? (
            <Empty>No open faults.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {open.map((f) => (
                <li key={f.id} className="space-y-2 px-4 py-3">
                  <div className="text-[13px]">
                    <b className="capitalize">{f.severity}</b> · {f.equipment_id ? m.equipmentById.get(f.equipment_id)?.name : "—"}
                    {f.batch && ` · ${(f.batch as { batch_no: string }).batch_no}`} · {f.description}
                    <div className="text-[12px] text-muted">
                      Since {dateTime(f.started_at)} · reported by {m.userName(f.reported_by)}
                    </div>
                  </div>
                  {canReport && (
                    <form action={resolveFault} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={f.id} />
                      <input name="resolution" className="input min-w-40 flex-1" placeholder="Fix applied" />
                      <input name="ended_at" type="datetime-local" className="input w-auto" aria-label="Resolved at (blank = now)" />
                      <button className="btn-primary">Resolve</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card tone="#4b5563" title={`Resolved (${closed.length}) · ${hours(downtime)} total downtime`}>
        {closed.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Equipment</th>
                  <th>Batch</th>
                  <th>Severity</th>
                  <th>Fault</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Downtime</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((f) => (
                  <tr key={f.id}>
                    <td className="whitespace-nowrap">{f.equipment_id ? m.equipmentById.get(f.equipment_id)?.name : "—"}</td>
                    <td className="font-mono text-xs">{f.batch ? (f.batch as { batch_no: string }).batch_no : "—"}</td>
                    <td className="capitalize">{f.severity}</td>
                    <td>{f.description}</td>
                    <td className="text-xs whitespace-nowrap">{dateTime(f.started_at)}</td>
                    <td className="text-xs whitespace-nowrap">{dateTime(f.ended_at)}</td>
                    <td className="whitespace-nowrap">{hours(f.downtime_minutes)}</td>
                    <td className="text-xs">{f.resolution ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
