import Link from "next/link";
import {
  ArrowUpRight,
  Ban,
  Banknote,
  ClipboardList,
  Download,
  FlaskConical,
  IndianRupee,
  Package,
  Plus,
  RotateCcw,
  ShoppingCart,
  Truck,
  UserPlus,
  Users,
  Wheat,
} from "lucide-react";
import { requireModule } from "@/lib/auth";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { C } from "@/lib/palette";
import { dateTime, num } from "@/lib/format";
import { Badge, Card, Empty, Flash, KpiCard, PageHeader, RangeChip, StatCard, StatusBadge, WelcomeBanner } from "@/components/ui";
import { GroupedBars, HatchedArea, Legend, RingDonut } from "@/components/panel-charts";

type Dashboard = {
  trucks_month: number;
  trucks_prev_month: number;
  qc_posted_month: number;
  qc_total_month: number;
  pending_approvals: number;
  open_exceptions: number;
  po_open: number;
  po_total: number;
  so_open: number;
  so_total: number;
  dispatch_value_week: number;
  dispatch_value_prev_week: number;
  receipts_week_kg: number;
  receipts_prev_week_kg: number;
  suppliers_active: number;
  users_active: number;
  users_total: number;
  users_new_month: number;
  dispatch_value_year: number;
  rejected_kg_year: number;
  purchase_value_year: number;
  returned_sacks_year: number;
  intake_by_supplier: { name: string; kg: number }[];
  intake_by_variety: { month: string; variety: string; kg: number }[];
  queue_by_wait: { over60: number; mid: number; under30: number };
  dispatch_months: { month: string; value: number }[];
  fulfilment: { month: string; ordered_kg: number; dispatched_kg: number; value: number }[];
  team: { name: string; role: Role; actions: number; last_at: string | null }[];
  recent_dispatches: { no: string; status: string; at: string; rst: number; vehicle_no: string; customer: string | null; varieties: string | null; qty_kg: number }[];
};

/** Chart series colours (validated: all checks pass on white). */
const SERIES = ["#2f7d4a", "#c08a24", "#3e6fc0"] as const;

const rupees = (n: number) => {
  if (n >= 1e7) return `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
};
const tonnes = (kg: number) => `${(kg / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} t`;
const monthLabel = (ym: string) => new Date(`${ym}-01T00:00:00+05:30`).toLocaleDateString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });

function delta(now: number, prev: number) {
  if (!prev) return undefined;
  const pct = ((now - prev) / prev) * 100;
  return { text: `${Math.abs(pct).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`, up: pct >= 0 };
}

export default async function AdminDashboardPage() {
  const { supabase, profile } = await requireModule("admin");
  const { data, error } = await supabase.rpc("admin_dashboard");
  const d = data as Dashboard | null;

  const firstName = (profile.full_name || profile.email || "").split(/[\s@]/)[0];
  const initials = (profile.full_name || profile.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
  const year = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }).format(new Date());

  if (!d) {
    return (
      <>
        <PageHeader title="Admin Dashboard" crumbs={[{ label: "Dashboard", href: "/" }]} />
        <Flash error={error?.message ?? "Could not load dashboard figures."} />
      </>
    );
  }

  // Intake by variety: top three varieties over the last 7 months.
  const months7 = d.dispatch_months.slice(-7).map((m) => m.month);
  const varietyTotals = new Map<string, number>();
  d.intake_by_variety.forEach((r) => varietyTotals.set(r.variety, (varietyTotals.get(r.variety) ?? 0) + Number(r.kg)));
  const topVarieties = [...varietyTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v);
  const intakeSeries = topVarieties.map((v, i) => ({ key: `v${i}`, label: v, color: SERIES[i]! }));
  const intakeRows = months7.map((m) => {
    const row: Record<string, string | number> = { month: monthLabel(m) };
    topVarieties.forEach((v, i) => {
      row[`v${i}`] = Math.round(d.intake_by_variety.filter((r) => r.month === m && r.variety === v).reduce((s, r) => s + Number(r.kg), 0) / 1000);
    });
    return row;
  });

  const wait = [
    { label: "Over 60 min", value: d.queue_by_wait.over60, color: SERIES[0] as string },
    { label: "30–60 min", value: d.queue_by_wait.mid, color: SERIES[1] as string },
    { label: "Under 30 min", value: d.queue_by_wait.under30, color: SERIES[2] as string },
  ];
  const waitTotal = wait.reduce((s, w) => s + w.value, 0);

  const dispatchPoints = d.dispatch_months.map((m) => ({ month: monthLabel(m.month), value: Math.round((Number(m.value) / 1e5) * 100) / 100 }));
  const dispatchYearTotal = Number(d.dispatch_value_year);
  const supplierMax = Math.max(1, ...d.intake_by_supplier.map((s) => Number(s.kg)));
  const weekDelta = delta(Number(d.dispatch_value_week), Number(d.dispatch_value_prev_week));

  const kpis = [
    { icon: Truck, color: C.gold, label: "Trucks weighed this month", value: num(d.trucks_month), delta: delta(d.trucks_month, d.trucks_prev_month), href: "/weighbridge" },
    { icon: FlaskConical, color: C.blue, label: "QC posted / recorded", value: `${d.qc_posted_month}/${d.qc_total_month}`, href: "/qc" },
    { icon: ClipboardList, color: C.terracotta, label: "Open purchase orders", value: `${d.po_open}/${d.po_total}`, href: "/purchase-orders" },
    { icon: ShoppingCart, color: C.teal, label: "Open sales orders", value: `${d.so_open}/${d.so_total}`, href: "/sales-orders" },
    { icon: IndianRupee, color: C.plum, label: "Dispatch value · 7 days", value: rupees(Number(d.dispatch_value_week)), delta: weekDelta, href: "/sales-orders" },
    {
      icon: Wheat,
      color: C.olive,
      label: "Paddy received · 7 days",
      value: tonnes(Number(d.receipts_week_kg)),
      delta: delta(Number(d.receipts_week_kg), Number(d.receipts_prev_week_kg)),
      href: "/inventory",
    },
    { icon: Users, color: C.slate, label: "Active suppliers", value: num(d.suppliers_active), href: "/admin?tab=masters" },
    { icon: UserPlus, color: C.green, label: "Active users", value: `${d.users_active}/${d.users_total}`, href: "/admin?tab=users" },
  ];

  const stats = [
    { icon: Banknote, color: C.gold, label: `Dispatched value · ${year}`, value: rupees(dispatchYearTotal) },
    { icon: Ban, color: C.teal, label: `Rejected at QC · ${year}`, value: tonnes(Number(d.rejected_kg_year)) },
    { icon: Package, color: C.terracotta, label: `Paddy purchased · ${year}`, value: rupees(Number(d.purchase_value_year)) },
    { icon: RotateCcw, color: C.olive, label: `Returned sacks · ${year}`, value: num(d.returned_sacks_year) },
  ];

  return (
    <>
      <PageHeader
        title="Admin Dashboard"
        crumbs={[{ label: "Dashboard", href: "/" }]}
        actions={
          <>
            <Link href="/reports" className="btn-secondary">
              <Download className="size-4" /> Export
            </Link>
            <RangeChip>{year}</RangeChip>
          </>
        }
      />

      <WelcomeBanner
        initials={initials}
        title={`Welcome back, ${firstName}`}
        actions={
          <>
            <Link href="/admin?tab=users" className="btn-dark">
              <UserPlus className="size-4" /> Add user
            </Link>
            <Link href="/weighbridge/capture" className="btn-primary">
              <Plus className="size-4" /> Add ticket
            </Link>
          </>
        }
      >
        You have <b className="text-accent">{d.pending_approvals}</b> QC record{d.pending_approvals === 1 ? "" : "s"} waiting for approval &amp;{" "}
        <b className="text-accent">{d.open_exceptions}</b> open ticket exception{d.open_exceptions === 1 ? "" : "s"}.
      </WelcomeBanner>

      <div className="mb-6 grid gap-5 xl:grid-cols-12">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:col-span-8">
          {kpis.map((k) => (
            <KpiCard key={k.label} icon={k.icon} color={k.color} label={k.label} value={k.value} delta={k.delta} href={k.href} linkLabel="View all" />
          ))}
        </div>

        <Card tone={C.blue} title="Intake by supplier" actions={<RangeChip>Last 7 days</RangeChip>} className="xl:col-span-4">
          <div className="p-5">
            {d.intake_by_supplier.length === 0 ? (
              <Empty>No posted receipts in the last 7 days.</Empty>
            ) : (
              <ul className="space-y-3">
                {d.intake_by_supplier.map((b) => (
                  <li key={b.name} className="grid grid-cols-[120px_1fr] items-center gap-3" title={`${b.name}: ${num(b.kg)} kg`}>
                    <span className="truncate text-right text-xs font-semibold text-muted">{b.name}</span>
                    <span className="flex items-center gap-2">
                      <span className="h-3 rounded-full bg-accent" style={{ width: `${Math.max(2, (Number(b.kg) / supplierMax) * 80)}%` }} />
                      <span className="text-[11px] font-bold text-ink tabular-nums">{tonnes(Number(b.kg))}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} icon={s.icon} color={s.color} label={s.label} value={s.value} />
        ))}
      </div>

      <div className="mb-6 grid gap-5 xl:grid-cols-12">
        <Card tone={C.blue} title="Paddy intake by variety (t)" actions={<RangeChip>Last 7 months</RangeChip>} className="xl:col-span-7">
          <div className="p-5">
            {intakeSeries.length === 0 ? (
              <Empty>No posted receipts in the last 7 months.</Empty>
            ) : (
              <>
                <div className="mb-3">
                  <Legend items={intakeSeries.map((s) => ({ label: s.label, color: s.color }))} />
                </div>
                <GroupedBars rows={intakeRows} series={intakeSeries} unit="t" label="Paddy intake by variety, tonnes per month" />
              </>
            )}
          </div>
        </Card>

        <Card tone={C.plum} title="QC queue by wait" actions={<RangeChip>Now</RangeChip>} className="xl:col-span-5">
          <div className="p-5">
            {waitTotal === 0 ? (
              <Empty>No trucks waiting for QC.</Empty>
            ) : (
              <>
                <Legend items={wait.map((w) => ({ label: w.label, color: w.color, extra: `${w.value}` }))} />
                <div className="mt-5">
                  <RingDonut segments={wait} total={waitTotal} totalLabel="Open trucks" />
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="mb-6 grid gap-5 xl:grid-cols-12">
        <Card tone={C.green} title="Dispatch value (₹ lakh)" actions={<RangeChip>Last 12 months</RangeChip>} className="xl:col-span-8">
          <div className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="text-xs font-semibold text-muted uppercase">Total {year}</span>
              <span className="text-[22px] font-bold text-ink tabular-nums">{rupees(dispatchYearTotal)}</span>
              {weekDelta && (
                <span className={`inline-flex items-center gap-0.5 rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold text-white ${weekDelta.up ? "bg-[#0a8f44]" : "bg-[#d10b0b]"}`}>
                  <ArrowUpRight className={`size-3 ${weekDelta.up ? "" : "rotate-90"}`} /> {weekDelta.text} vs last week
                </span>
              )}
            </div>
            {dispatchPoints.every((p) => p.value === 0) ? (
              <Empty>No dispatches posted in the last 12 months.</Empty>
            ) : (
              <HatchedArea
                points={dispatchPoints}
                color={SERIES[2]}
                highlight={SERIES[1]}
                prefix="₹"
                suffix=" L"
                label="Dispatch value per month, rupees lakh"
                defaultIndex={dispatchPoints.length - 1}
              />
            )}
          </div>
        </Card>

        <Card tone={C.gold} title="Order fulfilment" actions={<RangeChip>By order month</RangeChip>} className="xl:col-span-4">
          <div className="p-5">
            <ul className="space-y-3.5">
              {d.fulfilment.map((m) => {
                const pct = Number(m.ordered_kg) ? Math.min(100, (Number(m.dispatched_kg) / Number(m.ordered_kg)) * 100) : 0;
                return (
                  <li key={m.month} title={`${monthLabel(m.month)}: ${num(m.dispatched_kg)} of ${num(m.ordered_kg)} kg dispatched`}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="font-bold text-ink">{monthLabel(m.month)}</span>
                      <span className="font-semibold text-muted tabular-nums">
                        {rupees(Number(m.value))} · {Number(m.ordered_kg) ? `${pct.toFixed(1)}%` : "no orders"}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-[#eef1f6]">
                      <div className="h-2 rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
            <Link href="/sales-orders" className="btn-dark mt-5 w-full">
              View sales orders
            </Link>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card tone={C.terracotta} title="Team activity" actions={<RangeChip>Today</RangeChip>}>
          {d.team.length === 0 ? (
            <Empty>No active users.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {d.team.map((m) => (
                <li key={m.name} className="flex items-center gap-3 px-5 py-3">
                  <span className="grid size-9 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent">
                    {m.name
                      .split(/[\s.@]+/)
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((s) => s[0]!.toUpperCase())
                      .join("")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-ink">{m.name}</span>
                    <span className="block text-xs text-muted">
                      {ROLE_LABELS[m.role] ?? m.role} · last activity {m.last_at ? dateTime(m.last_at) : "—"}
                    </span>
                  </span>
                  <Badge tone={m.actions > 0 ? "green" : "slate"}>{m.actions > 0 ? `${m.actions} actions today` : "No activity today"}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line p-3">
            <Link href="/admin?tab=users" className="btn-secondary w-full">
              Manage users
            </Link>
          </div>
        </Card>

        <Card tone={C.teal} title="Recent dispatches">
          {d.recent_dispatches.length === 0 ? (
            <Empty>No dispatches yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {d.recent_dispatches.map((r) => (
                <li key={r.no} className="flex items-center gap-3 px-5 py-3">
                  <span className="grid size-10 place-items-center rounded-md border border-line bg-[#f8f9fa] text-muted">
                    <Truck className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-bold text-ink">
                      {r.no} · {r.customer ?? "—"}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      RST {r.rst} · {r.vehicle_no} · {r.varieties ?? "—"} · {num(r.qty_kg)} kg · {dateTime(r.at)}
                    </span>
                  </span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line p-3">
            <Link href="/sales-orders" className="btn-secondary w-full">
              View all dispatches
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
