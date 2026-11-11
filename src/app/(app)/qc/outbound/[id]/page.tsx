import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { hasRole, requireModule } from "@/lib/auth";
import { Card, Field, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { dateTime, kg, num } from "@/lib/format";
import type { QcStatus, Ticket, Variety } from "@/lib/types";
import { OutboundForm, type SoLineOption } from "../../outbound-form";
import { ReviewPanel } from "../../review-panel";
import { saveOutboundDraft, submitOutbound } from "../../actions";

type Line = {
  id: string;
  line_no: number;
  variety_id: string;
  so_line_id: string | null;
  bags: number;
  bag_weight_kg: number;
  qty_kg: number;
  lot_no: string | null;
  varieties: { name: string } | null;
  so_lines: { line_no: number; sales_orders: { so_no: string } | null } | null;
};

export default async function OutboundQcPage({
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
    .from("qc_outbound")
    .select("*, weighbridge_tickets(*, rst_cycles(label)), locations(name)")
    .eq("id", id)
    .maybeSingle();
  if (!qc) notFound();
  const ticket = qc.weighbridge_tickets as Ticket;
  const status = qc.status as QcStatus;

  const { data: lineData } = await supabase
    .from("qc_outbound_lines")
    .select("*, varieties(name), so_lines(line_no, sales_orders(so_no))")
    .eq("qc_id", id)
    .order("line_no");
  const lines = (lineData ?? []) as unknown as Line[];

  const isOwner = qc.qc_user === profile.id;
  const editable = status === "draft" && (isOwner || hasRole(profile, ["admin", "qc_head"]));

  let extra: { locations: { id: string; name: string }[]; varieties: Variety[]; soLines: SoLineOption[]; tolerancePct: number } | null = null;
  if (editable) {
    const [locations, varieties, openSos, tol] = await Promise.all([
      supabase.from("locations").select("id, name").eq("active", true).order("name"),
      supabase.from("varieties").select("*").eq("active", true).order("name"),
      supabase.from("sales_orders").select("id, so_no, parties(name)").eq("status", "open"),
      supabase.from("calc_settings").select("value").eq("key", "dispatch_weight_tolerance_pct").maybeSingle(),
    ]);
    const sos = openSos.data ?? [];
    const { data: balances } = sos.length
      ? await supabase.from("so_line_balances").select("so_line_id, so_id, line_no, variety_id, remaining_kg").in("so_id", sos.map((s) => s.id))
      : { data: [] };
    extra = {
      locations: locations.data ?? [],
      varieties: (varieties.data ?? []) as Variety[],
      tolerancePct: Number(tol.data?.value ?? 1),
      soLines: (balances ?? []).map((b) => {
        const so = sos.find((s) => s.id === b.so_id)!;
        return {
          id: b.so_line_id,
          so_no: so.so_no,
          customer: (so.parties as unknown as { name: string } | null)?.name ?? "",
          line_no: b.line_no,
          variety_id: b.variety_id,
          remaining_kg: Number(b.remaining_kg),
        } satisfies SoLineOption;
      }),
    };
  }

  return (
    <>
      <Link href="/qc?tab=outbound" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft className="size-4" /> QC queue
      </Link>
      <PageHeader
        title={`Outbound QC — RST ${ticket.rst}`}
        description={`QC record ${qc.pid}${qc.dispatch_no ? ` · dispatch ${qc.dispatch_no}` : ""} · ticket ${ticket.pid}${qc.amends_id ? " · correction of a reversed record" : ""}`}
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
            <Field label="Tare">{kg(ticket.tare_kg)}</Field>
            <Field label="Gross">{kg(ticket.gross_kg)}</Field>
            <Field label="Net">{kg(ticket.net_kg)}</Field>
            <Field label="Weighed">{dateTime(ticket.weighed_at)}</Field>
          </dl>
        </Card>

        <Card title={editable ? "Loading QC — multiple varieties" : "Dispatch details"}>
          <div className="space-y-6 p-4">
            {editable && extra ? (
              <OutboundForm
                id={id}
                action={saveOutboundDraft}
                submitAction={submitOutbound}
                header={{ location_id: qc.location_id, driver_name: qc.driver_name, driver_phone: qc.driver_phone, notes: qc.notes }}
                initialLines={lines.map((l) => ({
                  variety_id: l.variety_id,
                  so_line_id: l.so_line_id ?? "",
                  bags: String(l.bags),
                  bag_weight_kg: String(l.bag_weight_kg),
                  lot_no: l.lot_no ?? "",
                }))}
                netKg={ticket.net_kg === null ? null : Number(ticket.net_kg)}
                {...extra}
              />
            ) : (
              <div className="space-y-4">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <Field label="Loading location">{(qc.locations as { name: string } | null)?.name ?? "—"}</Field>
                  <Field label="Driver">{qc.driver_name ?? "—"}</Field>
                  <Field label="Driver phone">{qc.driver_phone ?? "—"}</Field>
                  <Field label="Posted">{dateTime(qc.posted_at)}</Field>
                  {qc.over_allocation_reason && <Field label="Approved exception">{qc.over_allocation_reason}</Field>}
                  {qc.reversal_reason && <Field label="Reversed — reason">{qc.reversal_reason}</Field>}
                </dl>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Variety</th>
                        <th>SO line</th>
                        <th className="num">Bags</th>
                        <th className="num">Bag wt</th>
                        <th>Lot</th>
                        <th className="num">Qty (kg)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id}>
                          <td>{l.line_no}</td>
                          <td>{l.varieties?.name}</td>
                          <td className="text-xs">{l.so_lines ? `${l.so_lines.sales_orders?.so_no} / L${l.so_lines.line_no}` : "—"}</td>
                          <td className="num">{l.bags}</td>
                          <td className="num">{num(l.bag_weight_kg)}</td>
                          <td className="font-mono text-xs">{l.lot_no ?? "—"}</td>
                          <td className="num font-semibold">{num(l.qty_kg)}</td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 font-semibold">
                        <td colSpan={3}>Total</td>
                        <td className="num">{lines.reduce((s, l) => s + l.bags, 0)}</td>
                        <td colSpan={2} />
                        <td className="num">{num(lines.reduce((s, l) => s + Number(l.qty_kg), 0))}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <ReviewPanel id={id} direction="outbound" status={status} profile={profile} isOwner={isOwner} />
          </div>
        </Card>
      </div>
    </>
  );
}
