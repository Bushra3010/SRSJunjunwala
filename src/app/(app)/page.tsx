import Link from "next/link";
import { AlertTriangle, ClipboardCheck, FlaskConical, Plus, Scale, Timer, Truck, TruckIcon } from "lucide-react";
import { requireModule } from "@/lib/auth";
import { canAccess, type Role } from "@/lib/roles";
import { Card, Empty, Flash, IconDot, KpiCard, Note, PageHeader, RangeChip, StatusBadge, Tabs, WelcomeBanner } from "@/components/ui";
import { Gauge, StackedBar } from "@/components/panel-charts";
import { dateTime, minutesSince, num, startOfTodayIST } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { C } from "@/lib/palette";

type SP = { view?: string; denied?: string };

// Logo-matched palette (validated: all checks pass on white).
const STAGE = {
  waiting: "#c08a24", // wheat gold
  inQc: "#3e6fc0", // blue
  approve: "#2f7d4a", // forest green
};

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("overview");
  const role = profile.role as Role;
  const seesTickets = canAccess(role, "weighbridge") || canAccess(role, "qc");
  const firstName = (profile.full_name || profile.email || "").split(/[\s@]/)[0];
  const initials = (profile.full_name || profile.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");

  if (!seesTickets) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Flash error={sp.denied ? "You don't have access to that module." : undefined} />
        <WelcomeBanner initials={initials} title={`Welcome back, ${firstName}`}>
          Your modules are in the menu.
        </WelcomeBanner>
        <Note>Processing and Stores & Repairs dashboards arrive in Phase 3.</Note>
      </>
    );
  }

  const today = startOfTodayIST();
  const view = sp.view ?? "all";
  // QC operators only see their own direction (PRD §4: assigned work only).
  const dirs = role === "qc_unloading" ? ["inbound"] : role === "qc_loading" ? ["outbound"] : ["inbound", "outbound"];

  const [{ data: active }, { data: todayRows }, { count: exceptionCount }, { data: waitSetting }] = await Promise.all([
    supabase
      .from("weighbridge_tickets")
      .select("*")
      .in("status", ["awaiting_qc", "qc_in_progress", "submitted"])
      .in("direction", dirs)
      .order("weighed_at", { ascending: true })
      .limit(200),
    supabase.from("weighbridge_tickets").select("status, net_kg").gte("weighed_at", today).in("direction", dirs),
    supabase.from("weighbridge_tickets").select("id", { count: "exact", head: true }).in("status", ["exception", "duplicate"]).in("direction", dirs),
    supabase.from("calc_settings").select("value").eq("key", "truck_wait_alert_minutes").maybeSingle(),
  ]);
  const tickets = (active ?? []) as Ticket[];
  const waitLimit = Number(waitSetting?.value ?? 30);
  const todayList = (todayRows ?? []) as { status: string; net_kg: number | null }[];
  const countToday = (...st: string[]) => todayList.filter((r) => st.includes(r.status)).length;
  const netToday = todayList.reduce((s, r) => s + Number(r.net_kg ?? 0), 0);

  const notStarted = tickets.filter((t) => t.status === "awaiting_qc");
  const inProgress = tickets.filter((t) => t.status === "qc_in_progress");
  const awaitingQc = [...notStarted, ...inProgress];
  const awaitingReview = tickets.filter((t) => t.status === "submitted");
  const longWait = awaitingQc.filter((t) => minutesSince(t.weighed_at) > waitLimit);
  const missingWeight = tickets.filter((t) => t.net_kg === null);
  const queue = view === "qc" ? awaitingQc : view === "review" ? awaitingReview : tickets;

  const stages = [
    { label: "Waiting for QC", value: notStarted.length, color: STAGE.waiting },
    { label: "QC in progress", value: inProgress.length, color: STAGE.inQc },
    { label: "Awaiting approval", value: awaitingReview.length, color: STAGE.approve },
  ];
  const stageTotal = tickets.length;

  // Status breakdown for today (status colours, always labelled).
  const gauge = [
    { label: "Posted", value: countToday("posted"), color: "#0a8f44" },
    { label: "In QC", value: countToday("qc_in_progress", "submitted"), color: "#3e6fc0" },
    { label: "Awaiting QC", value: countToday("awaiting_qc"), color: "#ffc107" },
    { label: "Exceptions", value: countToday("exception", "duplicate"), color: "#d10b0b" },
  ];

  const attention = [
    ...longWait.slice(0, 4).map((t, i) => ({
      key: t.id,
      icon: TruckIcon,
      color: [C.terracotta, C.gold, C.blue, C.teal][i % 4]!,
      title: `RST ${t.rst} · ${t.vehicle_no}`,
      sub: t.direction === "inbound" ? "Inbound · waiting for QC" : "Outbound · waiting for QC",
      chip: `${minutesSince(t.weighed_at)} min`,
      chipTone: "bg-[#d10b0b]",
      href: "/qc",
    })),
    ...(exceptionCount
      ? [{ key: "exc", icon: AlertTriangle, color: "#d10b0b", title: `${exceptionCount} weighbridge exception${exceptionCount > 1 ? "s" : ""}`, sub: "Duplicate or ambiguous RST", chip: "Resolve", chipTone: "bg-[#1f6b32]", href: "/weighbridge?tab=exceptions" }]
      : []),
    ...(missingWeight.length
      ? [{ key: "wt", icon: Scale, color: C.plum, title: `${missingWeight.length} awaiting second weighing`, sub: "Net weight not final yet", chip: "Weighbridge", chipTone: "bg-[#14532d]", href: "/weighbridge" }]
      : []),
  ];

  return (
    <>
      <PageHeader title="Operations Dashboard" crumbs={[{ label: "Dashboard" }]} actions={<RangeChip>Today</RangeChip>} />
      <Flash error={sp.denied ? "You don't have access to that module." : undefined} />

      <WelcomeBanner
        vivid
        initials={initials}
        title={`Welcome back, ${firstName}`}
        actions={
          <>
            {canAccess(role, "weighbridge") && role !== "qc_head" && (
              <Link href="/weighbridge/capture" className="btn-dark">
                <Plus className="size-4" /> Capture ticket
              </Link>
            )}
            <Link href="/qc" className="btn-primary">
              <FlaskConical className="size-4" /> Open QC queue
            </Link>
          </>
        }
      >
        You have <b className="text-accent">{awaitingReview.length}</b> QC records waiting for approval &amp; <b className="text-accent">{exceptionCount ?? 0}</b> ticket
        exceptions.
      </WelcomeBanner>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard vivid icon={Truck} color="#c08a24" label="Trucks weighed today" value={todayList.length} href="/weighbridge?range=today" />
        <KpiCard vivid
          icon={Timer}
          color="#3e6fc0"
          label="Awaiting QC"
          value={`${awaitingQc.length}/${tickets.length}`}
          delta={longWait.length ? { text: `${longWait.length} late`, up: false } : undefined}
          href="/qc"
          linkLabel="View queue"
        />
        <KpiCard vivid icon={ClipboardCheck} color="#b5532f" label="Awaiting approval" value={awaitingReview.length} href="/qc" linkLabel="Review" />
        <KpiCard vivid
          icon={Scale}
          color="#1f7f86"
          label="Net weighed today"
          value={`${(netToday / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} t`}
          href="/weighbridge?range=today"
          linkLabel="View tickets"
        />
      </div>

      <div className="mb-6 grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        <Card vivid tone="#1f6b32" title="Trucks by stage" actions={<RangeChip>Now</RangeChip>}>
          <div className="p-5">
            <div className="mb-2 flex items-center justify-between text-[13px]">
              <span className="text-muted">Open trucks</span>
              <span className="font-bold text-ink">{stageTotal}</span>
            </div>
            <StackedBar segments={stages} />
            <div className="mt-5 grid grid-cols-2 overflow-hidden rounded-md border border-line">
              {stages.map((s, i) => (
                <div key={s.label} className={`p-3 ${i % 2 ? "border-l border-line" : ""} ${i > 1 ? "border-t border-line" : ""}`}>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted">
                    <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
                    {s.label} ({stageTotal ? Math.round((s.value / stageTotal) * 100) : 0}%)
                  </div>
                  <div className="mt-1 text-[24px] font-bold text-ink tabular-nums">{s.value}</div>
                </div>
              ))}
              <div className="border-t border-l border-line p-3">
                <div className="text-xs font-semibold text-muted">Exceptions</div>
                <div className="mt-1 text-[24px] font-bold text-[#d10b0b] tabular-nums">{exceptionCount ?? 0}</div>
              </div>
            </div>
          </div>
        </Card>

        <Card vivid tone="#7b4f8e" title="Today's tickets" actions={<RangeChip>Today</RangeChip>}>
          <div className="p-5">
            <Gauge segments={gauge} total={todayList.length} totalLabel="Tickets today" />
            <div className="mt-4 text-[13px] font-bold text-ink">Status</div>
            <ul className="mt-2 space-y-2 text-[13px]">
              {gauge.map((g) => (
                <li key={g.label} className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full" style={{ background: g.color }} />
                  <span className="flex-1 text-muted">{g.label}</span>
                  <span className="font-bold text-ink tabular-nums">{g.value}</span>
                  <span className="w-10 text-right text-xs text-muted tabular-nums">{todayList.length ? Math.round((g.value / todayList.length) * 100) : 0}%</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card
          vivid
          tone="#d10b0b"
          title="Needs attention"
          actions={
            <Link href="/qc" className="text-xs font-bold text-accent hover:underline">
              View all
            </Link>
          }
        >
          {attention.length === 0 ? (
            <Empty>All clear.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {attention.map((a) => (
                <li key={a.key}>
                  <Link href={a.href} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                    <IconDot icon={a.icon} color={a.color} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold text-ink">{a.title}</span>
                      <span className="block truncate text-xs text-muted">{a.sub}</span>
                    </span>
                    <span className={`rounded-[5px] px-2 py-0.5 text-[11px] font-bold text-white ${a.chipTone}`}>{a.chip}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card vivid tone="#3e6fc0" title="Vehicle queue">
        <div className="px-5 pt-4">
          <Tabs
            active={view}
            tabs={[
              { key: "all", label: `All open (${tickets.length})`, href: "/?view=all" },
              { key: "qc", label: `Awaiting QC (${awaitingQc.length})`, href: "/?view=qc" },
              { key: "review", label: `To approve (${awaitingReview.length})`, href: "/?view=review" },
            ]}
          />
        </div>
        {queue.length === 0 ? (
          <Empty>No trucks in this queue.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>RST</th>
                  <th>Vehicle</th>
                  <th>Direction</th>
                  <th className="num">Net weight</th>
                  <th>Weighed</th>
                  <th className="num">Waiting</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.slice(0, 25).map((t) => {
                  const wait = minutesSince(t.weighed_at);
                  const late = wait > waitLimit && t.status !== "submitted";
                  return (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="font-bold text-ink">
                        {canAccess(role, "weighbridge") ? (
                          <Link href={`/weighbridge?id=${t.id}`} className="hover:text-accent">
                            RST {t.rst}
                          </Link>
                        ) : (
                          `RST ${t.rst}`
                        )}
                      </td>
                      <td className="whitespace-nowrap">{t.vehicle_no}</td>
                      <td className="whitespace-nowrap">{t.direction === "inbound" ? "Inbound · Purchase" : "Outbound · Dispatch"}</td>
                      <td className="num">{t.net_kg === null ? "—" : `${num(t.net_kg)} kg`}</td>
                      <td className="text-xs whitespace-nowrap">{dateTime(t.weighed_at)}</td>
                      <td className="num">
                        {late ? <span className="rounded-[5px] bg-[#d10b0b] px-2 py-0.5 text-[11px] font-bold text-white">{wait} min</span> : <span className="text-xs">{wait} min</span>}
                      </td>
                      <td>
                        <StatusBadge status={t.status} />
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
