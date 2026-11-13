import Link from "next/link";
import { AlertTriangle, ArrowDown, Factory, Gauge, PackageCheck, Truck, Wrench } from "lucide-react";
import { Card, Empty, Flash, PageHeader, StatCard } from "@/components/ui";
import { BatchLink, EquipmentTile, ProductionNav, Qty, StageChip, elapsedMinutes } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { C } from "@/lib/palette";
import { dateTime, startOfTodayIST } from "@/lib/format";
import { BATCH_COLUMNS, equipmentState, eventLabel, hours, loadMasters, q, type Batch, type Equipment } from "@/lib/production";

export const metadata = { title: "Production overview" };

export default async function ProductionOverview({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("processing");
  const m = await loadMasters();
  const today = startOfTodayIST();
  const [state, running, todayRows, events, faults, unconfirmed] = await Promise.all([
    equipmentState(m.equipment.map((e) => e.id)),
    supabase.from("production_batches").select(BATCH_COLUMNS).eq("status", "running").order("started_at"),
    supabase.from("production_batches").select("stage, output_kg, grade_id, status").gte("ended_at", today).neq("status", "cancelled"),
    supabase.from("batch_events").select("id, at, stage, event_type, qty_kg, user_id, note, batch:production_batches!batch_events_batch_id_fkey(batch_no)").order("at", { ascending: false }).limit(15),
    supabase.from("production_faults").select("id, severity, description, started_at, equipment_id").is("ended_at", null).order("started_at"),
    supabase.from("production_batches").select("id, batch_no, stage, output_kg, output_qty_status").in("output_qty_status", ["estimated", "entered"]).neq("status", "cancelled").in("stage", ["soaking", "steaming", "output"]).order("created_at").limit(10),
  ]);
  const runningRows = (running.data ?? []) as Batch[];
  const t = todayRows.data ?? [];
  const sum = (stage: string) => t.filter((r) => r.stage === stage).reduce((a, r) => a + Number(r.output_kg ?? 0), 0);
  const overdue = runningRows.filter((b) => {
    const e = b.equipment_id ? m.equipmentById.get(b.equipment_id) : null;
    const mins = elapsedMinutes(b);
    return e?.expected_hours_max && mins !== null && mins > e.expected_hours_max * 60;
  });
  const by = (kind: Equipment["kind"]) => m.equipment.filter((e) => e.kind === kind);
  const tile = (e: Equipment, sub?: string) => {
    const s = state.get(e.id);
    return <EquipmentTile key={e.id} eq={e} batch={s?.batch} available={s?.available} sub={sub} />;
  };
  const arrow = (
    <div className="flex justify-center py-1 text-[#c9b98d]" aria-hidden>
      <ArrowDown className="size-5" />
    </div>
  );
  const row = (title: string, href: string, children: React.ReactNode, cols = "sm:grid-cols-2 lg:grid-cols-3") => (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-ink">{title}</h3>
        <Link href={href} className="text-xs font-bold text-[#1f6b32] hover:underline">
          Open →
        </Link>
      </div>
      <div className={`grid gap-3 ${cols}`}>{children}</div>
    </section>
  );

  return (
    <>
      <PageHeader title="Production" description="Paddy-to-rice floor status, live." crumbs={[]} />
      <ProductionNav active="overview" />
      <Flash error={sp.error} notice={sp.notice} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Factory} color={C.blue} label="Batches running" value={runningRows.length} />
        <StatCard icon={Truck} color={C.gold} label="Paddy received today" value={q(sum("receipt"), 1)} />
        <StatCard icon={PackageCheck} color={C.green} label="Rice output today" value={q(sum("output"), 1)} />
        <StatCard icon={Wrench} color={C.terracotta} label="Open faults" value={(faults.data ?? []).length} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card tone={C.green} title="Plant floor">
          <div className="space-y-1 p-4">
            {row("Pre-cleaning", "/production/precleaning", by("precleaner").map((e) => tile(e)), "sm:grid-cols-2")}
            {arrow}
            {row("Soaking (kachi) · 12 h", "/production/soaking", by("soaking_tank").map((e) => tile(e, `Pair ${e.pair_no}`)))}
            {arrow}
            {row("Steaming (pakki) · one pair at a time", "/production/steaming", by("steamer").map((e) => tile(e)), "sm:grid-cols-2")}
            {arrow}
            {row("Drying · 12–14 h", "/production/drying", by("dryer").map((e) => tile(e)))}
            {arrow}
            {row("Mill feed tanks", "/production/mill-feed", by("mill_feed_tank").map((e) => tile(e)), "sm:grid-cols-2")}
            {arrow}
            {row("Milling · 4–6 h", "/production/milling", by("mill_line").map((e) => tile(e)), "sm:grid-cols-2")}
          </div>
        </Card>

        <div className="space-y-6">
          <Card tone={C.terracotta} title="Needs attention">
            {overdue.length + (faults.data ?? []).length + (unconfirmed.data ?? []).length === 0 ? (
              <Empty>All clear.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {overdue.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <AlertTriangle className="size-4 shrink-0 text-[#d10b0b]" />
                    <span className="flex-1">
                      <BatchLink no={b.batch_no} /> running {hours(elapsedMinutes(b))} — past the expected time
                    </span>
                  </li>
                ))}
                {(faults.data ?? []).map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <Wrench className="size-4 shrink-0 text-[#b5532f]" />
                    <span className="flex-1">
                      <b className="capitalize">{f.severity}</b> · {f.equipment_id ? m.equipmentById.get(f.equipment_id)?.name : ""} · {f.description}
                    </span>
                    <Link href="/production/faults" className="text-xs font-bold text-[#1f6b32]">
                      Resolve
                    </Link>
                  </li>
                ))}
                {(unconfirmed.data ?? []).map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <Gauge className="size-4 shrink-0 text-[#c08a24]" />
                    <span className="flex-1">
                      <BatchLink no={b.batch_no} /> {q(b.output_kg)} is {b.output_qty_status === "estimated" ? "an estimate" : "not yet approved"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card tone={C.plum} title="Today's output by grade">
            {m.grades.every((g) => !t.some((r) => r.grade_id === g.id)) ? (
              <Empty>No rice recorded today.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {m.grades.map((g) => {
                  const kg = t.filter((r) => r.grade_id === g.id).reduce((a, r) => a + Number(r.output_kg ?? 0), 0);
                  return (
                    <li key={g.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                      <span className="font-semibold text-ink">{g.name}</span>
                      <Qty kg={kg} />
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card tone={C.blue} title="Latest activity" actions={<Link href="/production/timeline" className="text-xs font-bold text-[#1f6b32] hover:underline">All →</Link>}>
            {(events.data ?? []).length === 0 ? (
              <Empty>No production activity yet. Start from Receipts.</Empty>
            ) : (
              <ol className="divide-y divide-line">
                {(events.data ?? []).map((e) => (
                  <li key={e.id} className="px-4 py-2 text-[12px]">
                    <div className="flex items-center justify-between gap-2">
                      <StageChip stage={e.stage} />
                      <span className="text-muted">{dateTime(e.at)}</span>
                    </div>
                    <div className="mt-0.5">
                      <BatchLink no={(e.batch as unknown as { batch_no: string }).batch_no} /> · {eventLabel(e.event_type)}
                      {e.qty_kg !== null ? ` · ${q(e.qty_kg)}` : ""} · <span className="text-muted">{m.userName(e.user_id)}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
