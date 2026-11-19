import Link from "next/link";
import { Plus, Search, X } from "lucide-react";
import { requireModule, hasRole } from "@/lib/auth";
import { TICKET_CAPTURERS, TICKET_RESOLVERS } from "@/lib/roles";
import { AdminDelete } from "@/components/admin-delete";
import { deleteTruck } from "@/lib/admin-delete-actions";
import { Badge, Card, Empty, Field, Flash, Note, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { date, dateTime, kg, num, startOfTodayIST } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { acceptTicket, cancelTicket, completeWeighing, startCycle } from "./actions";

type SP = {
  tab?: string;
  q?: string;
  status?: string;
  dir?: string;
  range?: string;
  cycles?: string;
  page?: string;
  id?: string;
  error?: string;
  notice?: string;
};

const PAGE_SIZE = 25;

export default async function WeighbridgePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("weighbridge");
  const tab = sp.tab ?? "register";

  const { data: cycles } = await supabase.from("rst_cycles").select("*").order("starts_on", { ascending: false });
  const openCycle = cycles?.find((c) => !c.ends_on);

  const { count: exceptionCount } = await supabase
    .from("weighbridge_tickets")
    .select("id", { count: "exact", head: true })
    .in("status", ["exception", "duplicate"]);

  const qs = (patch: Partial<SP>) => {
    const p = new URLSearchParams();
    const merged = { ...sp, ...patch, error: undefined, notice: undefined };
    Object.entries(merged).forEach(([k, v]) => v && p.set(k, v));
    return `/weighbridge?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Weighbridge"
        description="Capture, verify and manage weighbridge tickets for inward and outward movements."
        actions={
          hasRole(profile, TICKET_CAPTURERS) && (
            <Link href="/weighbridge/capture" className="btn-primary">
              <Plus className="size-4" /> Capture ticket
            </Link>
          )
        }
      />
      <Flash error={sp.error} notice={sp.notice} />
      <Tabs
        active={tab}
        tabs={[
          { key: "register", label: "Ticket register", href: "/weighbridge" },
          {
            key: "exceptions",
            label: (
              <span className="flex items-center gap-2">
                Exceptions {!!exceptionCount && <Badge tone="red">{exceptionCount}</Badge>}
              </span>
            ),
            href: "/weighbridge?tab=exceptions",
          },
          { key: "cycles", label: "RST cycles", href: "/weighbridge?tab=cycles" },
        ]}
      />

      {tab === "cycles" ? (
        <CyclesTab cycles={cycles ?? []} canManage={hasRole(profile, ["admin", "management"])} />
      ) : (
        <div className={sp.id ? "grid gap-6 xl:grid-cols-[1fr_400px]" : ""}>
          <Register sp={sp} tab={tab} openCycleId={openCycle?.id} qs={qs} />
          {sp.id && <TicketDetail id={sp.id} closeHref={qs({ id: undefined })} />}
        </div>
      )}
    </>
  );
}

async function Register({ sp, tab, openCycleId, qs }: { sp: SP; tab: string; openCycleId?: string; qs: (p: Partial<SP>) => string }) {
  const { supabase } = await requireModule("weighbridge");
  const page = Math.max(1, Number(sp.page ?? 1));
  let query = supabase
    .from("weighbridge_tickets")
    .select("id, pid, rst, vehicle_no, direction, gross_kg, tare_kg, net_kg, status, weighed_at, rst_cycles(label)", { count: "exact" })
    .order("weighed_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (tab === "exceptions") {
    query = query.in("status", ["exception", "duplicate"]);
  } else {
    if (sp.status) query = query.eq("status", sp.status);
    if (sp.dir) query = query.eq("direction", sp.dir);
    if (sp.range === "today") query = query.gte("weighed_at", startOfTodayIST());
    if (sp.range === "7d") query = query.gte("weighed_at", new Date(Date.now() - 7 * 864e5).toISOString());
  }
  const q = sp.q?.trim();
  if (q) {
    if (/^\d+$/.test(q)) {
      query = query.eq("rst", Number(q));
      if (sp.cycles !== "all" && openCycleId) query = query.eq("cycle_id", openCycleId);
    } else if (/^pid-/i.test(q)) {
      query = query.ilike("pid", `%${q}%`);
    } else {
      query = query.ilike("vehicle_key", `%${q.replace(/[^a-z0-9]/gi, "").toUpperCase()}%`);
    }
  }

  const { data, count, error } = await query;
  const tickets = (data ?? []) as unknown as Ticket[];
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  return (
    <Card
      title={tab === "exceptions" ? "Exceptions & duplicates" : "Ticket register"}
      actions={
        tab !== "exceptions" && (
          <form className="flex flex-wrap items-center gap-2" action="/weighbridge">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" />
              <input name="q" defaultValue={sp.q} placeholder="RST, vehicle or PID" className="input w-48 pl-8" />
            </div>
            <select name="range" defaultValue={sp.range ?? ""} className="input w-auto">
              <option value="">All dates</option>
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
            </select>
            <select name="dir" defaultValue={sp.dir ?? ""} className="input w-auto">
              <option value="">In & out</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
            <select name="status" defaultValue={sp.status ?? ""} className="input w-auto">
              <option value="">All statuses</option>
              {["awaiting_qc", "qc_in_progress", "submitted", "posted", "duplicate", "exception", "cancelled"].map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="checkbox" name="cycles" value="all" defaultChecked={sp.cycles === "all"} /> All RST cycles
            </label>
            <button className="btn-secondary">Filter</button>
          </form>
        )
      }
    >
      {error && <Flash error={error.message} />}
      {tickets.length === 0 ? (
        <Empty>{tab === "exceptions" ? "No exceptions — every ticket is matched." : "No tickets match these filters."}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>RST</th>
                <th>Cycle</th>
                <th>Permanent ID</th>
                <th>Vehicle</th>
                <th>Dir.</th>
                <th className="num">Gross (kg)</th>
                <th className="num">Tare (kg)</th>
                <th className="num">Net (kg)</th>
                <th>Weighed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} className={sp.id === t.id ? "bg-brand-50/60" : "hover:bg-slate-50"}>
                  <td className="font-semibold">
                    <Link href={qs({ id: t.id })} className="hover:underline">
                      RST {t.rst}
                    </Link>
                  </td>
                  <td className="text-xs whitespace-nowrap text-slate-500">{t.rst_cycles?.label ?? "—"}</td>
                  <td className="font-mono text-xs">{t.pid}</td>
                  <td className="whitespace-nowrap">{t.vehicle_no}</td>
                  <td>{t.direction === "inbound" ? "In" : "Out"}</td>
                  <td className="num">{num(t.gross_kg)}</td>
                  <td className="num">{num(t.tare_kg)}</td>
                  <td className="num font-medium">{num(t.net_kg)}</td>
                  <td className="whitespace-nowrap text-xs text-slate-500">{dateTime(t.weighed_at)}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
        <span>
          {count ?? 0} ticket{count === 1 ? "" : "s"}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Link className="btn-secondary py-1" href={qs({ page: String(page - 1) })}>
              Previous
            </Link>
          )}
          <span className="py-1">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link className="btn-secondary py-1" href={qs({ page: String(page + 1) })}>
              Next
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

async function TicketDetail({ id, closeHref }: { id: string; closeHref: string }) {
  const { supabase, profile } = await requireModule("weighbridge");
  const { data } = await supabase.from("weighbridge_tickets").select("*, rst_cycles(label)").eq("id", id).maybeSingle();
  if (!data) return <Card title="Ticket not found">{null}</Card>;
  const t = data as Ticket;

  const [{ data: related }, { data: audit }] = await Promise.all([
    t.duplicate_of
      ? supabase.from("weighbridge_tickets").select("id, pid, rst, vehicle_no, status, weighed_at").eq("id", t.duplicate_of).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("audit_log").select("at, action, reason").eq("record_id", id).order("at", { ascending: false }).limit(10),
  ]);

  const canCapture = hasRole(profile, TICKET_CAPTURERS);
  const canResolve = hasRole(profile, TICKET_RESOLVERS);
  const needsSecondWeight = (t.gross_kg === null || t.tare_kg === null) && !["cancelled", "duplicate"].includes(t.status);

  return (
    <Card
      tone="#c08a24"
      title={
        <span className="flex items-center gap-2">
          RST {t.rst} <StatusBadge status={t.status} />
        </span>
      }
      actions={
        <Link href={closeHref} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Close">
          <X className="size-4" />
        </Link>
      }
    >
      <div className="space-y-5 p-4">
        <p className="-mt-2 text-sm text-slate-500">
          {t.direction === "inbound" ? "Purchase · Inward" : "Sales · Outward"} · cycle {t.rst_cycles?.label ?? "unassigned"}
        </p>

        {(t.status === "exception" || t.status === "duplicate") && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <b>{t.status === "duplicate" ? "Possible duplicate" : "Needs review"}:</b> {t.exception_reason}
            {related && (
              <div className="mt-1">
                Matches{" "}
                <Link className="underline" href={`/weighbridge?id=${related.id}`}>
                  {related.pid} (RST {related.rst}, {related.vehicle_no}, {dateTime(related.weighed_at)})
                </Link>
              </div>
            )}
          </div>
        )}
        {t.status !== "exception" && t.status !== "duplicate" && !t.duplicate_of && (
          <Badge tone="green">No duplicate found</Badge>
        )}

        <dl className="grid grid-cols-2 gap-4">
          <Field label="Permanent ID">
            <span className="font-mono">{t.pid}</span>
          </Field>
          <Field label="Original ticket ref.">{t.ticket_ref ?? "—"}</Field>
          <Field label="Vehicle">{t.vehicle_no}</Field>
          <Field label="Weighed at">{dateTime(t.weighed_at)}</Field>
          <Field label="Captured via">{t.capture_method}</Field>
          <Field label="Captured at">{dateTime(t.created_at)}</Field>
        </dl>

        <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-lg bg-slate-50 text-center">
          <div className="p-3">
            <div className="text-xs text-slate-500">Gross</div>
            <div className="font-semibold">{kg(t.gross_kg)}</div>
          </div>
          <div className="p-3">
            <div className="text-xs text-slate-500">Tare</div>
            <div className="font-semibold">{kg(t.tare_kg)}</div>
          </div>
          <div className="p-3">
            <div className="text-xs text-slate-500">Net</div>
            <div className="font-semibold">{kg(t.net_kg)}</div>
          </div>
        </div>

        {needsSecondWeight && canCapture && (
          <form action={completeWeighing} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <input type="hidden" name="id" value={t.id} />
            <div className="text-sm font-medium">Record second weighing</div>
            <div className="flex gap-2">
              {t.gross_kg === null && <input name="gross_kg" type="number" step="0.01" min="0" placeholder="Gross kg" className="input" required />}
              {t.tare_kg === null && <input name="tare_kg" type="number" step="0.01" min="0" placeholder="Tare kg" className="input" required />}
              <button className="btn-primary">Save</button>
            </div>
          </form>
        )}

        {canResolve && ["exception", "duplicate"].includes(t.status) && (
          <form action={acceptTicket} className="space-y-2 rounded-lg border border-slate-200 p-3">
            <input type="hidden" name="id" value={t.id} />
            <div className="text-sm font-medium">Resolve</div>
            <textarea name="note" required placeholder="What did you check? (required)" className="input" rows={2} />
            <div className="flex gap-2">
              <button formAction={acceptTicket} className="btn-primary">
                Accept as valid
              </button>
              <button formAction={cancelTicket} className="btn-danger">
                Cancel ticket
              </button>
            </div>
          </form>
        )}

        {t.source_payload && (
          <div>
            <div className="mb-1 text-xs text-slate-500">Original message / payload</div>
            <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap">{t.source_payload}</pre>
          </div>
        )}
        {t.resolution_note && (
          <div className="text-sm">
            <span className="text-slate-500">Resolution:</span> {t.resolution_note} ({dateTime(t.resolved_at)})
          </div>
        )}

        {hasRole(profile, ["admin"]) && (
          <AdminDelete
            action={deleteTruck}
            id={t.id}
            label={`RST ${t.rst}`}
            what="this truck entry with its QC, stock entries, purchase slip and slip payment"
            back="/weighbridge"
            here={`/weighbridge?id=${t.id}`}
          />
        )}

        {!!audit?.length && (
          <div>
            <div className="mb-1 text-xs font-medium text-slate-500">History</div>
            <ul className="space-y-1 text-xs text-slate-600">
              {audit.map((a, i) => (
                <li key={i}>
                  {dateTime(a.at)} · {a.action}
                  {a.reason ? ` · ${a.reason}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function CyclesTab({
  cycles,
  canManage,
}: {
  cycles: { id: string; label: string; starts_on: string; ends_on: string | null; notes: string | null }[];
  canManage: boolean;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card title="RST cycles">
        <table className="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Starts</th>
              <th>Ends</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">
                  {c.label} {!c.ends_on && <Badge tone="green">Current</Badge>}
                </td>
                <td>{date(c.starts_on)}</td>
                <td>{c.ends_on ? date(c.ends_on) : "—"}</td>
                <td className="text-slate-500">{c.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canManage && (
        <Card tone="#c08a24" title="Start new cycle">
          <form action={startCycle} className="space-y-3 p-4">
            <Note>Start a new cycle when the weighbridge RST counter resets. Earlier tickets keep their cycle and are never changed.</Note>
            <div>
              <label className="label" htmlFor="label">Cycle label</label>
              <input id="label" name="label" className="input" placeholder="e.g. C2027-1" required />
            </div>
            <div>
              <label className="label" htmlFor="starts_on">Starts on</label>
              <input id="starts_on" name="starts_on" type="date" className="input" required />
            </div>
            <div>
              <label className="label" htmlFor="notes">Notes</label>
              <input id="notes" name="notes" className="input" />
            </div>
            <button className="btn-primary">Start cycle</button>
          </form>
        </Card>
      )}
    </div>
  );
}
