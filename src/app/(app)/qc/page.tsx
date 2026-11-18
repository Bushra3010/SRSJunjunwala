import Link from "next/link";
import { Search } from "lucide-react";
import { requireModule } from "@/lib/auth";
import type { Role } from "@/lib/roles";
import { Card, Empty, Flash, Note, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { dateTime, minutesSince, num } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { rot } from "@/lib/palette";
import { openQc } from "./actions";

type SP = { tab?: string; q?: string; error?: string; notice?: string };

function allowedDirections(role: Role) {
  if (role === "qc_unloading") return ["inbound"];
  if (role === "qc_loading") return ["outbound"];
  return ["inbound", "outbound"];
}

export default async function QcPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("qc");
  const dirs = allowedDirections(profile.role);
  const tab = dirs.includes(sp.tab ?? "") ? sp.tab! : dirs[0]!;
  const q = sp.q?.trim();

  const { data: openCycle } = await supabase.from("rst_cycles").select("id, label").is("ends_on", null).maybeSingle();

  // RST lookup: show every plausible match (all cycles) so the user picks — never auto-pick (RST-04).
  let matches: Ticket[] = [];
  if (q) {
    let mq = supabase
      .from("weighbridge_tickets")
      .select("*, rst_cycles(label)")
      .eq("direction", tab)
      .order("weighed_at", { ascending: false })
      .limit(20);
    if (/^\d+$/.test(q)) mq = mq.eq("rst", Number(q));
    else if (/^pid-/i.test(q)) mq = mq.ilike("pid", `%${q}%`);
    else mq = mq.ilike("vehicle_key", `%${q.replace(/[^a-z0-9]/gi, "").toUpperCase()}%`);
    matches = ((await mq).data ?? []) as Ticket[];
  }

  const { data: queueData } = await supabase
    .from("weighbridge_tickets")
    .select("*, rst_cycles(label)")
    .eq("direction", tab)
    .in("status", ["awaiting_qc", "qc_in_progress", "submitted"])
    .order("weighed_at", { ascending: true })
    .limit(100);
  const queue = (queueData ?? []) as Ticket[];

  const groups: { title: string; status: string; hint: string }[] = [
    { title: "Awaiting QC", status: "awaiting_qc", hint: "Trucks at the point, QC not started" },
    { title: "In progress", status: "qc_in_progress", hint: "Draft QC saved" },
    { title: "Submitted for review", status: "submitted", hint: "Waiting for QC head to post" },
  ];

  return (
    <>
      <PageHeader
        title="Quality Control"
        description="Find the truck by RST, confirm it, and record QC at the unloading or loading point."
        actions={
          <Link href="/purchase-qc" className="btn-primary">
            Purchase QC (phone)
          </Link>
        }
      />
      <Flash error={sp.error} notice={sp.notice} />
      <Tabs
        active={tab}
        tabs={dirs.map((d) => ({
          key: d,
          label: d === "inbound" ? "Inbound QC (unloading)" : "Outbound QC (loading – multiple varieties)",
          href: `/qc?tab=${d}`,
        }))}
      />

      <Card tone="#1f6b32" className="mb-6" title="Find vehicle">
        <form className="flex flex-wrap items-center gap-2 p-4" action="/qc">
          <input type="hidden" name="tab" value={tab} />
          <div className="relative">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" />
            <input name="q" defaultValue={q} placeholder="Enter RST, vehicle no. or PID" className="input w-72 pl-8" autoFocus inputMode="search" />
          </div>
          <button className="btn-primary">Look up</button>
          <span className="text-xs text-slate-500">Current RST cycle: {openCycle?.label ?? "none"}</span>
        </form>
        {q && (
          <div className="border-t border-slate-100">
            {matches.length === 0 ? (
              <Empty>No {tab} ticket found for “{q}”. Check the RST on the slip or ask the weighbridge.</Empty>
            ) : (
              <>
                {matches.length > 1 && (
                  <div className="p-4 pb-0">
                    <Note>
                      {matches.length} tickets match. Compare the cycle, vehicle and time with the slip, then pick the right one.
                    </Note>
                  </div>
                )}
                <TicketTable tickets={matches} direction={tab} />
              </>
            )}
          </div>
        )}
      </Card>

      <div className="space-y-6">
        {groups.map((g, gi) => {
          const rows = queue.filter((t) => t.status === g.status);
          return (
            <Card key={g.status} tone={rot(gi, 1)} title={`${g.title} (${rows.length})`} actions={<span className="text-xs text-slate-500">{g.hint}</span>}>
              {rows.length ? <TicketTable tickets={rows} direction={tab} showWait /> : <Empty>Nothing here.</Empty>}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function TicketTable({ tickets, direction, showWait }: { tickets: Ticket[]; direction: string; showWait?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>RST</th>
            <th>Cycle</th>
            <th>Vehicle</th>
            <th className="num">Gross</th>
            <th className="num">Tare</th>
            <th className="num">Net</th>
            <th>Weighed</th>
            {showWait && <th className="num">Waiting</th>}
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const canOpen = ["awaiting_qc", "qc_in_progress", "submitted", "posted"].includes(t.status);
            const wait = minutesSince(t.weighed_at);
            return (
              <tr key={t.id}>
                <td className="font-semibold">RST {t.rst}</td>
                <td className="text-xs whitespace-nowrap text-slate-500">{t.rst_cycles?.label}</td>
                <td className="whitespace-nowrap">{t.vehicle_no}</td>
                <td className="num">{num(t.gross_kg)}</td>
                <td className="num">{num(t.tare_kg)}</td>
                <td className="num">{num(t.net_kg)}</td>
                <td className="text-xs whitespace-nowrap text-slate-500">{dateTime(t.weighed_at)}</td>
                {showWait && <td className={`num text-xs ${wait > 30 ? "font-semibold text-red-700" : ""}`}>{wait} min</td>}
                <td>
                  <StatusBadge status={t.status} />
                </td>
                <td className="text-right">
                  {canOpen ? (
                    <form action={openQc}>
                      <input type="hidden" name="ticket_id" value={t.id} />
                      <input type="hidden" name="direction" value={direction} />
                      <button className={t.status === "awaiting_qc" ? "btn-primary py-1" : "btn-secondary py-1"}>
                        {t.status === "awaiting_qc" ? "Start QC" : "Open"}
                      </button>
                    </form>
                  ) : (
                    <Link href={`/weighbridge?id=${t.id}`} className="text-xs text-slate-500 underline">
                      View ticket
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
