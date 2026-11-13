import { Card, Empty, PageHeader } from "@/components/ui";
import { BatchLink, ProductionNav, Qty, StageChip } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { dateTime, todayIST } from "@/lib/format";
import { STAGES, STAGE_META, eventLabel, loadMasters } from "@/lib/production";

export const metadata = { title: "Production timeline" };

export default async function TimelinePage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; stage?: string; user?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("processing");
  const m = await loadMasters();
  const from = sp.from || todayIST();
  const to = sp.to || from;
  let query = supabase
    .from("batch_events")
    .select("id, at, stage, event_type, qty_kg, user_id, note, batch:production_batches!batch_events_batch_id_fkey(batch_no), related:production_batches!batch_events_related_batch_id_fkey(batch_no)")
    .gte("at", new Date(`${from}T00:00:00+05:30`).toISOString())
    .lte("at", new Date(`${to}T23:59:59+05:30`).toISOString())
    .order("at", { ascending: true })
    .limit(1000);
  if (sp.stage) query = query.eq("stage", sp.stage);
  if (sp.user) query = query.eq("user_id", sp.user);
  const { data } = await query;
  const { data: users } = await supabase.from("profiles").select("id, full_name, email").order("full_name");

  return (
    <>
      <PageHeader title="Production timeline" description="Every start, stop, transfer, output and correction across the plant, in order." crumbs={[{ label: "Production", href: "/production" }]} />
      <ProductionNav active="timeline" />
      <Card tone="#c08a24" title={`${(data ?? []).length} events`}>
        <form action="/production/timeline" className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-3">
          <div>
            <label className="label" htmlFor="tf">From</label>
            <input id="tf" type="date" name="from" defaultValue={from} className="input w-auto" />
          </div>
          <div>
            <label className="label" htmlFor="tt">To</label>
            <input id="tt" type="date" name="to" defaultValue={to} className="input w-auto" />
          </div>
          <div>
            <label className="label" htmlFor="ts">Stage</label>
            <select id="ts" name="stage" defaultValue={sp.stage ?? ""} className="input w-auto">
              <option value="">All stages</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_META[s].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tu">User</label>
            <select id="tu" name="user" defaultValue={sp.user ?? ""} className="input w-auto">
              <option value="">Everyone</option>
              {(users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.email}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-secondary">Show</button>
        </form>
        {(data ?? []).length === 0 ? (
          <Empty>No events in this period.</Empty>
        ) : (
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
                {(data ?? []).map((e) => (
                  <tr key={e.id}>
                    <td className="text-xs whitespace-nowrap">{dateTime(e.at)}</td>
                    <td>
                      <StageChip stage={e.stage} />
                    </td>
                    <td>
                      <BatchLink no={(e.batch as unknown as { batch_no: string }).batch_no} />
                    </td>
                    <td className="font-semibold text-ink">
                      {eventLabel(e.event_type)}
                      {e.related && <span className="font-normal text-muted"> · {(e.related as unknown as { batch_no: string }).batch_no}</span>}
                    </td>
                    <td className="text-right">{e.qty_kg !== null ? <Qty kg={e.qty_kg} /> : "—"}</td>
                    <td className="text-xs whitespace-nowrap">{m.userName(e.user_id)}</td>
                    <td className="text-xs">{e.note ?? ""}</td>
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
