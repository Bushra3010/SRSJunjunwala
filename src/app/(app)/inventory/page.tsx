import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, Boxes, TrendingUp } from "lucide-react";
import { requireModule } from "@/lib/auth";
import { Badge, Card, Empty, Note, PageHeader, RangeChip, StatCard } from "@/components/ui";
import { dateTime, num } from "@/lib/format";

type SP = { variety?: string; location?: string; type?: string };

const TYPE_LABEL: Record<string, string> = {
  receipt: "Receipt (purchase)",
  sales_issue: "Sales issue",
  production_issue: "Production issue",
  production_receipt: "Production receipt",
  transfer: "Transfer",
  adjustment: "Adjustment",
  return: "Return",
  reversal: "Reversal",
};

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("inventory");

  const [{ data: varieties }, { data: locations }] = await Promise.all([
    supabase.from("varieties").select("id, name, est_yield_pct").order("name"),
    supabase.from("locations").select("id, name").order("name"),
  ]);
  const vName = (id: string) => varieties?.find((v) => v.id === id)?.name ?? "—";
  const lName = (id: string) => locations?.find((l) => l.id === id)?.name ?? "—";

  let bq = supabase.from("stock_balances").select("*");
  if (sp.variety) bq = bq.eq("variety_id", sp.variety);
  if (sp.location) bq = bq.eq("location_id", sp.location);
  const { data: balRaw } = await bq;
  const balances = (balRaw ?? [])
    .filter((b) => Number(b.on_hand_kg ?? 0) !== 0 || Number(b.estimated_kg ?? 0) !== 0)
    .sort((a, b) => vName(a.variety_id).localeCompare(vName(b.variety_id)) || String(a.lot_no).localeCompare(String(b.lot_no)));

  // Open sales demand by variety, shown as "reserved" until reservations are configured (PRD SO-07).
  const { data: soOpen } = await supabase.from("sales_orders").select("id").eq("status", "open");
  const { data: soBal } = soOpen?.length
    ? await supabase.from("so_line_balances").select("variety_id, remaining_kg").in("so_id", soOpen.map((s) => s.id))
    : { data: [] };
  const demand = new Map<string, number>();
  (soBal ?? []).forEach((b) => demand.set(b.variety_id, (demand.get(b.variety_id) ?? 0) + Math.max(0, Number(b.remaining_kg))));

  const byVariety = new Map<string, number>();
  balances.forEach((b) => byVariety.set(b.variety_id, (byVariety.get(b.variety_id) ?? 0) + Number(b.on_hand_kg ?? 0)));
  const totalOnHand = [...byVariety.values()].reduce((s, v) => s + v, 0);

  let mq = supabase.from("stock_movements").select("*").order("created_at", { ascending: false }).limit(100);
  if (sp.variety) mq = mq.eq("variety_id", sp.variety);
  if (sp.location) mq = mq.eq("location_id", sp.location);
  if (sp.type) mq = mq.eq("movement_type", sp.type);
  const { data: movements } = await mq;

  // Header tiles
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: weekRaw } = await supabase.from("stock_movements").select("movement_type, qty_kg").gte("created_at", weekAgo);
  const week = (weekRaw ?? []) as { movement_type: string; qty_kg: number }[];
  const weekIn = week.filter((m) => Number(m.qty_kg) > 0 && m.movement_type !== "reversal").reduce((a, m) => a + Number(m.qty_kg), 0);
  const weekOut = -week.filter((m) => m.movement_type === "sales_issue").reduce((a, m) => a + Number(m.qty_kg), 0);
  const totalDemand = [...demand.values()].reduce((a, v) => a + v, 0);
  const countType = (...t: string[]) => week.filter((m) => t.includes(m.movement_type)).length;

  const ranked = [...byVariety.entries()].filter(([, kgv]) => kgv > 0).sort((a, b) => b[1] - a[1]);

  const pressure = [...byVariety.entries()]
    .map(([vid, onHand]) => ({ vid, onHand, demand: demand.get(vid) ?? 0 }))
    .sort((a, b) => b.demand - Math.max(0, b.onHand) - (a.demand - Math.max(0, a.onHand)))[0];
  const pressureYield = Number(varieties?.find((v) => v.id === pressure?.vid)?.est_yield_pct ?? 0);

  return (
    <>
      <PageHeader title="Inventory" crumbs={[{ label: "Plant" }]} description="Stock by variety, location and lot. Confirmed stock comes only from posted transactions; estimates are shown separately." />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard vivid icon={Boxes} color="#1f6b32" label="Confirmed stock on hand" value={`${(totalOnHand / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} t`} />
        <StatCard vivid icon={ArrowDownToLine} color="#c08a24" label="Received · 7 days" value={`${num(Math.round(weekIn))} kg`} chip={`${countType("receipt", "production_receipt")} entries`} />
        <StatCard vivid icon={ArrowUpFromLine} color="#3e6fc0" label="Dispatched · 7 days" value={`${num(Math.round(weekOut))} kg`} chip={`${countType("sales_issue")} entries`} />
        <StatCard vivid icon={TrendingUp} color="#b5532f" label="Open sales demand" value={`${num(Math.round(totalDemand))} kg`} />
      </div>

      <div className="mb-6 grid gap-5 xl:grid-cols-12">
        <Card vivid tone="#1f7f86" title="Stock by variety" actions={<RangeChip>Now</RangeChip>} className="xl:col-span-7">
          <div className="p-5">
            {ranked.length === 0 ? (
              <p className="text-[13px] text-muted">No stock yet.</p>
            ) : (
              <ul className="space-y-3">
                {ranked.map(([vid, kgv]) => (
                  <li key={vid} className="grid grid-cols-[110px_1fr] items-center gap-3" title={`${vName(vid)}: ${num(kgv)} kg`}>
                    <span className="truncate text-right text-xs font-semibold text-muted">{vName(vid)}</span>
                    <span className="flex items-center gap-2">
                      <span className="h-3 rounded-full bg-accent" style={{ width: `${(kgv / ranked[0]![1]) * 85}%` }} />
                      <span className="text-[11px] font-bold text-ink tabular-nums">{num(Math.round(kgv))} kg</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card vivid tone="#7b4f8e" title="Demand watch" actions={<Link href="/sales-orders" className="text-xs font-bold text-accent hover:underline">View orders</Link>} className="xl:col-span-5">
          <div className="p-5">
            {pressure ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[18px] font-bold text-ink">{vName(pressure.vid)}</span>
                  {pressure.demand > pressure.onHand && <Badge tone="red">Short by {num(Math.round(pressure.demand - Math.max(0, pressure.onHand)))} kg</Badge>}
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
                  {[
                    ["Open demand", `${num(pressure.demand)} kg`],
                    ["On hand", `${num(Math.round(pressure.onHand))} kg`],
                    ["Est. output", `${num(Math.round((pressure.onHand * pressureYield) / 100))} kg`],
                  ].map(([l, v]) => (
                    <div key={l} className="rounded-md border border-line p-3">
                      <dt className="text-xs font-semibold text-muted">{l}</dt>
                      <dd className="mt-1 text-[15px] font-bold text-ink tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <p className="text-[13px] text-muted">No stock yet.</p>
            )}
          </div>
        </Card>
      </div>

      <form className="mb-4 flex flex-wrap gap-2" action="/inventory">
        <select name="variety" defaultValue={sp.variety ?? ""} className="input w-auto">
          <option value="">All varieties</option>
          {varieties?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <select name="location" defaultValue={sp.location ?? ""} className="input w-auto">
          <option value="">All locations</option>
          {locations?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select name="type" defaultValue={sp.type ?? ""} className="input w-auto">
          <option value="">All movements</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button className="btn-secondary">Apply</button>
        {(sp.variety || sp.location || sp.type) && (
          <Link href="/inventory" className="btn-secondary">
            Clear
          </Link>
        )}
      </form>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card vivid tone="#3e6fc0" title="Stock by variety, location and lot">
          {balances.length === 0 ? (
            <Empty>No stock yet. Stock appears when inbound QC is posted.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Variety</th>
                    <th>Location</th>
                    <th>Lot</th>
                    <th className="num">On hand (kg)</th>
                    <th className="num">Estimated (kg)</th>
                    <th>Last movement</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b, i) => (
                    <tr key={i}>
                      <td>{vName(b.variety_id)}</td>
                      <td>{lName(b.location_id)}</td>
                      <td className="font-mono text-xs">{b.lot_no ?? "—"}</td>
                      <td className={`num font-medium ${Number(b.on_hand_kg) < 0 ? "text-red-700" : ""}`}>{num(b.on_hand_kg ?? 0)}</td>
                      <td className="num text-slate-500">{b.estimated_kg ? num(b.estimated_kg) : "—"}</td>
                      <td className="text-xs text-slate-500">{dateTime(b.last_movement_at)}</td>
                    </tr>
                  ))}
                  <tr className="bg-slate-50 font-semibold">
                    <td colSpan={3}>Total</td>
                    <td className="num">{num(totalOnHand)}</td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card vivid tone="#c08a24"
          title={
            <span className="flex items-center gap-2">
              Estimated milling output <Badge tone="amber">Estimate</Badge>
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Variety</th>
                  <th className="num">On hand</th>
                  <th className="num">Open SO demand</th>
                  <th className="num">Est. recovery</th>
                  <th className="num">Est. output</th>
                </tr>
              </thead>
              <tbody>
                {[...byVariety.entries()].map(([vid, onHand]) => {
                  const y = Number(varieties?.find((v) => v.id === vid)?.est_yield_pct ?? 0);
                  return (
                    <tr key={vid}>
                      <td>{vName(vid)}</td>
                      <td className="num">{num(onHand)}</td>
                      <td className="num">{num(demand.get(vid) ?? 0)}</td>
                      <td className="num">{y.toFixed(1)}%</td>
                      <td className="num">{num(Math.round((onHand * y) / 100))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="p-4">
            <Note>Yield % per variety is set in Admin → Masters. Estimates never change on-hand stock (PRD INV-06).</Note>
          </div>
        </Card>
      </div>

      <Card vivid tone="#b5532f" className="mt-6" title="Stock movement history (latest 100)">
        {!movements?.length ? (
          <Empty>No movements.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date & time</th>
                  <th>Movement</th>
                  <th>Variety</th>
                  <th>Location</th>
                  <th>Lot</th>
                  <th className="num">Quantity (kg)</th>
                  <th>Reference</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td className="text-xs whitespace-nowrap text-slate-500">{dateTime(m.created_at)}</td>
                    <td>
                      <Badge tone={m.movement_type === "reversal" ? "red" : Number(m.qty_kg) > 0 ? "green" : "blue"}>{TYPE_LABEL[m.movement_type] ?? m.movement_type}</Badge>
                    </td>
                    <td>{vName(m.variety_id)}</td>
                    <td>{lName(m.location_id)}</td>
                    <td className="font-mono text-xs">{m.lot_no ?? "—"}</td>
                    <td className={`num font-medium ${Number(m.qty_kg) < 0 ? "text-red-700" : "text-emerald-700"}`}>
                      {Number(m.qty_kg) > 0 ? "+" : ""}
                      {num(m.qty_kg)}
                    </td>
                    <td className="text-xs">
                      {m.reference_type === "qc_inbound" || m.reference_type === "qc_outbound" ? (
                        <Link className="text-brand-700 hover:underline" href={`/qc/${m.reference_type === "qc_inbound" ? "inbound" : "outbound"}/${m.reference_id}`}>
                          {m.reference_no}
                        </Link>
                      ) : (
                        m.reference_no ?? "—"
                      )}
                    </td>
                    <td className="text-xs text-slate-500">{m.note}</td>
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
