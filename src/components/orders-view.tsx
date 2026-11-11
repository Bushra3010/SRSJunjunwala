import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { hasRole, requireModule } from "@/lib/auth";
import { ORDER_EDITORS } from "@/lib/roles";
import { setOrderStatus } from "@/lib/order-actions";
import { Card, Empty, Field, Flash, Note, PageHeader, Progress, Stat, StatusBadge } from "@/components/ui";
import { date, dateTime, kg, num } from "@/lib/format";

type Kind = "purchase" | "sales";
type SP = { id?: string; q?: string; status?: string; error?: string; notice?: string };

const CFG = {
  purchase: {
    module: "purchase-orders" as const,
    base: "/purchase-orders",
    title: "Purchase Orders",
    table: "purchase_orders",
    lines: "po_lines",
    balances: "po_line_balances",
    orderFk: "po_id",
    lineFk: "po_line_id",
    noCol: "po_no",
    partyCol: "supplier_id",
    partyLabel: "Supplier",
    doneCol: "accepted_kg",
    doneLabel: "Accepted",
    dueCol: "expected_by",
    dueLabel: "Expected by",
  },
  sales: {
    module: "sales-orders" as const,
    base: "/sales-orders",
    title: "Sales Orders",
    table: "sales_orders",
    lines: "so_lines",
    balances: "so_line_balances",
    orderFk: "so_id",
    lineFk: "so_line_id",
    noCol: "so_no",
    partyCol: "customer_id",
    partyLabel: "Customer",
    doneCol: "dispatched_kg",
    doneLabel: "Dispatched",
    dueCol: "required_by",
    dueLabel: "Required by",
  },
};

type Balance = Record<string, number | string> & { ordered_kg: number; remaining_kg: number };

function fulfillment(ordered: number, done: number) {
  if (done <= 0) return "not_started";
  return done >= ordered ? "fulfilled" : "partial";
}

export async function OrdersView({ kind, sp }: { kind: Kind; sp: SP }) {
  const c = CFG[kind];
  const { supabase, profile } = await requireModule(c.module);
  const canEdit = hasRole(profile, ORDER_EDITORS);

  let query = supabase
    .from(c.table)
    .select(`id, pid, ${c.noCol}, status, order_date, ${c.dueCol}, parties(name)`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (sp.status) query = query.eq("status", sp.status);
  const { data: ordersRaw } = await query;
  type OrderRow = { id: string; pid: string; status: string; order_date: string; parties: { name: string } | null } & Record<string, unknown>;
  let orders = (ordersRaw ?? []) as unknown as OrderRow[];
  const q = sp.q?.trim().toLowerCase();
  if (q) orders = orders.filter((o) => String(o[c.noCol]).toLowerCase().includes(q) || o.parties?.name.toLowerCase().includes(q));

  const { data: balRaw } = orders.length
    ? await supabase.from(c.balances).select("*").in(c.orderFk, orders.map((o) => o.id))
    : { data: [] };
  const balances = (balRaw ?? []) as Balance[];
  const totals = (orderId: string) => {
    const ls = balances.filter((b) => b[c.orderFk] === orderId);
    const ordered = ls.reduce((s, b) => s + Number(b.ordered_kg), 0);
    const done = ls.reduce((s, b) => s + Number(b[c.doneCol]), 0);
    return { ordered, done };
  };

  const selected = sp.id ? orders.find((o) => o.id === sp.id) ?? null : orders[0] ?? null;

  return (
    <>
      <PageHeader
        title={c.title}
        actions={
          canEdit && (
            <Link href={`${c.base}/new`} className="btn-primary">
              <Plus className="size-4" /> New {kind === "purchase" ? "purchase" : "sales"} order
            </Link>
          )
        }
      />
      <Flash error={sp.error} notice={sp.notice} />
      <div className="grid gap-6 2xl:grid-cols-[380px_1fr]">
        <Card>
          <form className="flex flex-wrap gap-2 border-b border-slate-100 p-3" action={c.base}>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-slate-400" />
              <input name="q" defaultValue={sp.q} placeholder={`Order no. or ${c.partyLabel.toLowerCase()}`} className="input pl-8" />
            </div>
            <select name="status" defaultValue={sp.status ?? ""} className="input w-auto">
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button className="btn-secondary">Go</button>
          </form>
          {orders.length === 0 ? (
            <Empty>No orders yet.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>{c.partyLabel}</th>
                  <th className="num">Ordered</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const t = totals(o.id);
                  return (
                    <tr key={o.id} className={selected?.id === o.id ? "bg-brand-50/60" : "hover:bg-slate-50"}>
                      <td className="font-semibold">
                        <Link href={`${c.base}?id=${o.id}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}${sp.status ? `&status=${sp.status}` : ""}`} className="text-brand-700 hover:underline">
                          {String(o[c.noCol])}
                        </Link>
                      </td>
                      <td>{o.parties?.name}</td>
                      <td className="num">{num(t.ordered)}</td>
                      <td>
                        <StatusBadge status={o.status === "open" ? fulfillment(t.ordered, t.done) : o.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {selected ? <OrderDetail kind={kind} id={selected.id} canEdit={canEdit} /> : <Note>Create the first order to get started.</Note>}
      </div>
    </>
  );
}

async function OrderDetail({ kind, id, canEdit }: { kind: Kind; id: string; canEdit: boolean }) {
  const c = CFG[kind];
  const { supabase } = await requireModule(c.module);
  const { data: o } = await supabase.from(c.table).select("*, parties(name)").eq("id", id).single();
  const { data: balRaw } = await supabase.from(c.balances).select("*").eq(c.orderFk, id).order("line_no");
  const lines = (balRaw ?? []) as Balance[];
  const { data: varieties } = await supabase.from("varieties").select("id, name");
  const vName = (vid: unknown) => varieties?.find((v) => v.id === vid)?.name ?? "—";

  const ordered = lines.reduce((s, l) => s + Number(l.ordered_kg), 0);
  const done = lines.reduce((s, l) => s + Number(l[c.doneCol]), 0);
  const pct = ordered ? (done / ordered) * 100 : 0;
  const lineIds = lines.map((l) => String(l[c.lineFk]));

  let movements: { pid: string; status: string; at: string | null; rst: number; vehicle: string; href: string; variety: string; qty: number | null; extra?: string }[] = [];
  if (lineIds.length) {
    if (kind === "purchase") {
      const { data } = await supabase
        .from("qc_inbound_lines")
        .select("qc_id, variety_id, accepted_kg, rejected_kg, sacks_received, qc_inbound(id, pid, status, submitted_at, posted_at, weighbridge_tickets(rst, vehicle_no))")
        .in("po_line_id", lineIds);
      movements = (data ?? []).map((m) => {
        const q = m.qc_inbound as unknown as { id: string; pid: string; status: string; submitted_at: string | null; posted_at: string | null; weighbridge_tickets: { rst: number; vehicle_no: string } };
        return {
          pid: q.pid,
          status: q.status,
          at: q.posted_at ?? q.submitted_at,
          rst: q.weighbridge_tickets.rst,
          vehicle: q.weighbridge_tickets.vehicle_no,
          href: `/qc/inbound/${q.id}`,
          variety: vName(m.variety_id),
          qty: m.accepted_kg,
          extra: m.rejected_kg != null ? `${num(m.rejected_kg)} kg rejected` : `${m.sacks_received} sacks`,
        };
      });
    } else {
      const { data } = await supabase
        .from("qc_outbound_lines")
        .select("qc_id, variety_id, qty_kg, bags, qc_outbound(id, pid, dispatch_no, status, submitted_at, posted_at, weighbridge_tickets(rst, vehicle_no))")
        .in("so_line_id", lineIds);
      movements = (data ?? []).map((m) => {
        const q = m.qc_outbound as unknown as { id: string; pid: string; dispatch_no: string | null; status: string; submitted_at: string | null; posted_at: string | null; weighbridge_tickets: { rst: number; vehicle_no: string } };
        return {
          pid: q.dispatch_no ?? q.pid,
          status: q.status,
          at: q.posted_at ?? q.submitted_at,
          rst: q.weighbridge_tickets.rst,
          vehicle: q.weighbridge_tickets.vehicle_no,
          href: `/qc/outbound/${q.id}`,
          variety: vName(m.variety_id),
          qty: m.qty_kg,
          extra: `${m.bags} bags`,
        };
      });
    }
  }
  movements.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const pending = movements.filter((m) => m.status === "submitted" || m.status === "draft");
  const posted = movements.filter((m) => m.status === "posted" || m.status === "reversed");

  return (
    <div className="min-w-0 space-y-6">
      <Card
        tone="#c08a24"
        title={
          <span className="flex items-center gap-3">
            {String(o[c.noCol])} <StatusBadge status={o.status === "open" ? fulfillment(ordered, done) : o.status} />
          </span>
        }
        actions={<span className="font-mono text-xs text-slate-500">{o.pid}</span>}
      >
        <dl className="grid gap-4 p-4 sm:grid-cols-4">
          <Field label={c.partyLabel}>{(o.parties as { name: string } | null)?.name}</Field>
          <Field label="Order date">{date(o.order_date)}</Field>
          <Field label={c.dueLabel}>{date(o[c.dueCol])}</Field>
          <Field label="Order value">
            ₹ {lines.reduce((s, l) => s + (Number(l.ordered_kg) / 100) * Number(l.rate_per_qtl ?? 0), 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
          </Field>
        </dl>
        <div className="grid grid-cols-2 border-t border-slate-100 sm:grid-cols-4">
          <Stat label="Ordered" value={kg(ordered)} />
          <Stat label={c.doneLabel} value={kg(done)} />
          <Stat label="Remaining" value={kg(ordered - done)} />
          <div className="px-4 py-3">
            <div className="text-xs text-slate-500">Fulfillment</div>
            <div className="mt-1 text-xl font-semibold">{pct.toFixed(0)}%</div>
            <Progress pct={pct} />
          </div>
        </div>
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Variety</th>
                <th className="num">Ordered</th>
                <th className="num">{c.doneLabel}</th>
                {kind === "purchase" && <th className="num">Rejected</th>}
                {kind === "purchase" && <th className="num">Moisture ded.</th>}
                <th className="num">Remaining</th>
                <th>Fulfillment</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const p = Number(l.ordered_kg) ? (Number(l[c.doneCol]) / Number(l.ordered_kg)) * 100 : 0;
                return (
                  <tr key={String(l[c.lineFk])}>
                    <td>{l.line_no}</td>
                    <td>{vName(l.variety_id)}</td>
                    <td className="num">{num(l.ordered_kg)}</td>
                    <td className="num">{num(l[c.doneCol])}</td>
                    {kind === "purchase" && <td className="num">{num(l.rejected_kg)}</td>}
                    {kind === "purchase" && <td className="num">{num(l.moisture_deduction_kg)}</td>}
                    <td className={`num ${Number(l.remaining_kg) < 0 ? "font-semibold text-amber-700" : ""}`}>{num(l.remaining_kg)}</td>
                    <td className="w-40">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-9">{p.toFixed(0)}%</span>
                        <Progress pct={p} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {o.notes && <p className="border-t border-slate-100 p-4 text-sm whitespace-pre-line text-slate-600">{o.notes}</p>}
      </Card>

      <MovementTable tone="#3e6fc0" title={kind === "purchase" ? "Pending approval (receipts)" : "Pending approval (dispatches)"} rows={pending} />
      <MovementTable tone="#b5532f" title={kind === "purchase" ? "Posted receipts" : "Dispatch history"} rows={posted} />

      {canEdit && (
        <Card tone="#1f7f86" title="Order status">
          <form action={setOrderStatus} className="flex flex-wrap items-end gap-2 p-4">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="id" value={id} />
            <div>
              <label className="label" htmlFor="status">Status</label>
              <select id="status" name="status" className="input" defaultValue={o.status}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div className="min-w-64 flex-1">
              <label className="label" htmlFor="reason">Reason (required to close or cancel)</label>
              <input id="reason" name="reason" className="input" defaultValue={o.status_reason ?? ""} />
            </div>
            <button className="btn-secondary">Update</button>
          </form>
        </Card>
      )}
    </div>
  );
}

function MovementTable({
  title,
  rows,
  tone,
}: {
  tone: string;
  title: string;
  rows: { pid: string; status: string; at: string | null; rst: number; vehicle: string; href: string; variety: string; qty: number | null; extra?: string }[];
}) {
  return (
    <Card tone={tone} title={`${title} (${rows.length})`}>
      {rows.length === 0 ? (
        <Empty>None yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Record</th>
                <th>RST</th>
                <th>Vehicle</th>
                <th>Date</th>
                <th>Variety</th>
                <th className="num">Quantity</th>
                <th>Details</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <Link href={r.href} className="font-medium text-brand-700 hover:underline">
                      {r.pid}
                    </Link>
                  </td>
                  <td>{r.rst}</td>
                  <td className="whitespace-nowrap">{r.vehicle}</td>
                  <td className="text-xs whitespace-nowrap text-slate-500">{dateTime(r.at)}</td>
                  <td>{r.variety}</td>
                  <td className="num">{r.qty != null ? num(r.qty) : "—"}</td>
                  <td className="text-xs text-slate-500">{r.extra}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
