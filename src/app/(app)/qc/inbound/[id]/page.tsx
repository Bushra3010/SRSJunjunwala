import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasRole, requireModule } from "@/lib/auth";
import { Card, Field, Flash, Note, PageHeader, StatusBadge } from "@/components/ui";
import { dateTime, kg, num } from "@/lib/format";
import type { QcStatus, Ticket, Variety } from "@/lib/types";
import { InboundForm, type PoLineOption } from "../../inbound-form";
import { ReviewPanel } from "../../review-panel";
import { saveInboundDraft, submitInbound } from "../../actions";

type Line = {
  id: string;
  line_no: number;
  variety_id: string;
  po_line_id: string | null;
  moisture_pct: number;
  sacks_received: number;
  returned_sacks: number;
  rejected_bags: number;
  line_net_kg: number | null;
  rejected_kg: number | null;
  moisture_deduction_kg: number | null;
  accepted_kg: number | null;
  lot_no: string | null;
  varieties: { name: string } | null;
  po_lines: { line_no: number; purchase_orders: { po_no: string } | null } | null;
};

export default async function InboundQcPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("qc");

  const { data: qc } = await supabase
    .from("qc_inbound")
    .select("*, weighbridge_tickets(*, rst_cycles(label)), parties(name), brokers(name), locations(name)")
    .eq("id", id)
    .maybeSingle();
  if (!qc) notFound();
  const ticket = qc.weighbridge_tickets as Ticket;
  const status = qc.status as QcStatus;

  const { data: lineData } = await supabase
    .from("qc_inbound_lines")
    .select("*, varieties(name), po_lines(line_no, purchase_orders(po_no))")
    .eq("qc_id", id)
    .order("line_no");
  const lines = (lineData ?? []) as unknown as Line[];

  const isOwner = qc.qc_user === profile.id;
  const editable = status === "draft" && (isOwner || hasRole(profile, ["admin", "qc_head"]));

  let formProps: Omit<React.ComponentProps<typeof InboundForm>, "id" | "action" | "submitAction" | "header" | "initialLines" | "netKg"> | null = null;
  if (editable) {
    const [suppliers, brokers, locations, varieties, openPos, base] = await Promise.all([
      supabase.from("parties").select("id, name").in("kind", ["supplier", "both"]).eq("active", true).order("name"),
      supabase.from("brokers").select("id, name").eq("active", true).order("name"),
      supabase.from("locations").select("id, name").eq("active", true).order("name"),
      supabase.from("varieties").select("*").eq("active", true).order("name"),
      supabase.from("purchase_orders").select("id, po_no, supplier_id").eq("status", "open"),
      supabase.from("calc_settings").select("value").eq("key", "moisture_base_pct").maybeSingle(),
    ]);
    const pos = openPos.data ?? [];
    const { data: balances } = pos.length
      ? await supabase.from("po_line_balances").select("po_line_id, po_id, line_no, variety_id, remaining_kg").in("po_id", pos.map((p) => p.id))
      : { data: [] };
    formProps = {
      suppliers: suppliers.data ?? [],
      brokers: brokers.data ?? [],
      locations: locations.data ?? [],
      varieties: (varieties.data ?? []) as Variety[],
      poLines: (balances ?? []).map((b) => {
        const po = pos.find((p) => p.id === b.po_id)!;
        return {
          id: b.po_line_id,
          line_no: b.line_no,
          variety_id: b.variety_id,
          remaining_kg: Number(b.remaining_kg),
          po_no: po.po_no,
          supplier_id: po.supplier_id,
        } satisfies PoLineOption;
      }),
      moistureBase: Number(base.data?.value ?? 14),
    };
  }

  return (
    <>
      <Link href="/qc?tab=inbound" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> QC queue
      </Link>
      <PageHeader
        title={`Inbound QC — RST ${ticket.rst}`}
        description={`QC record ${qc.pid} · ticket ${ticket.pid}${qc.amends_id ? " · correction of a reversed record" : ""}`}
        actions={<StatusBadge status={status} />}
      />
      <Flash error={sp.error} notice={sp.notice} />

      <div className="grid gap-6 xl:grid-cols-[300px_1fr]">
        <Card tone="#3e6fc0" title="Weighbridge ticket">
          <dl className="grid grid-cols-2 gap-4 p-4">
            <Field label="RST / cycle">
              {ticket.rst} · {ticket.rst_cycles?.label}
            </Field>
            <Field label="Vehicle">{ticket.vehicle_no}</Field>
            <Field label="Gross">{kg(ticket.gross_kg)}</Field>
            <Field label="Tare">{kg(ticket.tare_kg)}</Field>
            <Field label="Net">{kg(ticket.net_kg)}</Field>
            <Field label="Weighed">{dateTime(ticket.weighed_at)}</Field>
          </dl>
          {ticket.net_kg === null && (
            <div className="px-4 pb-4">
              <Note>Tare weight is pending. QC can be submitted now, but posting waits until the weighbridge records it.</Note>
            </div>
          )}
        </Card>

        <Card title={editable ? "Inbound QC workbench" : "QC details"}>
          <div className="space-y-6 p-4">
            {editable && formProps ? (
              <InboundForm
                id={id}
                action={saveInboundDraft}
                submitAction={submitInbound}
                header={{ supplier_id: qc.supplier_id, broker_id: qc.broker_id, location_id: qc.location_id, notes: qc.notes }}
                initialLines={lines.map((l) => ({
                  variety_id: l.variety_id,
                  po_line_id: l.po_line_id ?? "",
                  moisture_pct: String(l.moisture_pct),
                  sacks_received: String(l.sacks_received),
                  returned_sacks: String(l.returned_sacks),
                  rejected_bags: String(l.rejected_bags),
                }))}
                netKg={ticket.net_kg === null ? null : Number(ticket.net_kg)}
                {...formProps}
              />
            ) : (
              <ReadOnly qc={qc} lines={lines} />
            )}
            <ReviewPanel id={id} direction="inbound" status={status} profile={profile} isOwner={isOwner} />
          </div>
        </Card>
      </div>
    </>
  );
}

function ReadOnly({ qc, lines }: { qc: Record<string, unknown> & { parties?: { name: string } | null; brokers?: { name: string } | null; locations?: { name: string } | null }; lines: Line[] }) {
  const posted = qc.status === "posted" || qc.status === "reversed";
  const total = (k: keyof Line) => lines.reduce((s, l) => s + Number(l[k] ?? 0), 0);
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Field label="Supplier">{qc.parties?.name ?? "—"}</Field>
        <Field label="Broker">{qc.brokers?.name ?? "—"}</Field>
        <Field label="Location">{qc.locations?.name ?? "—"}</Field>
        <Field label="Submitted">{dateTime(qc.submitted_at as string)}</Field>
        <Field label="Posted">{dateTime(qc.posted_at as string)}</Field>
        {!!qc.reversal_reason && <Field label="Reversed — reason">{String(qc.reversal_reason)}</Field>}
      </dl>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Variety</th>
              <th>PO</th>
              <th className="num">Moisture %</th>
              <th className="num">Sacks</th>
              <th className="num">Returned</th>
              <th className="num">Rejected</th>
              {posted && (
                <>
                  <th className="num">Net share</th>
                  <th className="num">Rejected kg</th>
                  <th className="num">Moisture ded.</th>
                  <th className="num">Accepted</th>
                  <th>Lot</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.line_no}</td>
                <td>{l.varieties?.name}</td>
                <td className="text-xs">{l.po_lines ? `${l.po_lines.purchase_orders?.po_no} / L${l.po_lines.line_no}` : "—"}</td>
                <td className="num">{num(l.moisture_pct)}</td>
                <td className="num">{l.sacks_received}</td>
                <td className="num">{l.returned_sacks}</td>
                <td className="num">{l.rejected_bags}</td>
                {posted && (
                  <>
                    <td className="num">{num(l.line_net_kg)}</td>
                    <td className="num">{num(l.rejected_kg)}</td>
                    <td className="num">{num(l.moisture_deduction_kg)}</td>
                    <td className="num font-semibold">{num(l.accepted_kg)}</td>
                    <td className="font-mono text-xs">{l.lot_no}</td>
                  </>
                )}
              </tr>
            ))}
            <tr className="bg-slate-50 font-semibold">
              <td colSpan={4}>Total</td>
              <td className="num">{total("sacks_received")}</td>
              <td className="num">{total("returned_sacks")}</td>
              <td className="num">{total("rejected_bags")}</td>
              {posted && (
                <>
                  <td className="num">{num(total("line_net_kg"))}</td>
                  <td className="num">{num(total("rejected_kg"))}</td>
                  <td className="num">{num(total("moisture_deduction_kg"))}</td>
                  <td className="num">{num(total("accepted_kg"))}</td>
                  <td />
                </>
              )}
            </tr>
          </tbody>
        </table>
      </div>
      {!!qc.notes && <p className="text-sm whitespace-pre-line text-slate-600">{String(qc.notes)}</p>}
    </div>
  );
}
