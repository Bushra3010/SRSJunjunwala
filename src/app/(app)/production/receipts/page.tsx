import Link from "next/link";
import { Card, Empty, Flash, PageHeader, StatusBadge } from "@/components/ui";
import { BatchFilters, BatchLink, ProductionNav, Qty, UnloadedSummary, type UnloadedRow } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { STAGE_OPERATORS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import { loadMasters, stageHistory, type StageSP } from "@/lib/production";

export const metadata = { title: "Trucks · Production" };

type Line = {
  qc_line_id: string;
  qc_pid: string;
  posted_at: string;
  rst: number;
  rst_cycle: string | null;
  vehicle_no: string;
  net_kg: number;
  supplier: string | null;
  variety: string | null;
  lot_no: string;
  moisture_pct: number;
  accepted_kg: number;
  location: string | null;
};

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<StageSP> }) {
  const sp = await searchParams;
  const { profile, supabase } = await requireModule("processing");
  const canLoad = STAGE_OPERATORS.soaking.includes(profile.role);
  const [{ data: lines, error }, history, m, unloadedRes] = await Promise.all([
    supabase.rpc("production_receivable_lines"),
    stageHistory("receipt", sp),
    loadMasters(),
    supabase.rpc("unloaded_paddy_summary"),
  ]);
  const waiting = (lines ?? []) as Line[];

  return (
    <>
      <PageHeader
        title="Trucks"
        description="Posted unloading QC adds to the unloaded paddy total. When a tank starts soaking, the trucks it drew from get a permanent receipt ID (RCV). The RST is kept for reference only, because it resets every few months."
        crumbs={[{ label: "Production", href: "/production" }]}
      />
      <ProductionNav active="receipts" />
      <Flash error={sp.error} notice={sp.notice} />

      <Card
        tone="#1f6b32"
        title="Unloaded paddy total"
        className="mb-6"
        actions={canLoad ? <Link href="/production/soaking" className="btn-primary py-1">Start soaking a tank</Link> : undefined}
      >
        <UnloadedSummary rows={(unloadedRes.data ?? []) as UnloadedRow[]} />
        <p className="border-t border-line px-5 py-3 text-[12px] text-muted">
          No manual transfer is needed: each tank started on the Soaking page takes the variety&apos;s standard weight from this total, oldest trucks first.
        </p>
      </Card>

      <Card
        tone="#4b5563"
        title={`Unloaded trucks not yet in a tank (${waiting.length})`}
        className="mb-6"
      >
        {error ? (
          <div className="p-4 text-[13px] text-muted">Your role cannot see unloading QC. Ask a production manager or QC head to create receipts.</div>
        ) : waiting.length === 0 ? (
          <Empty>No unloaded truck is waiting. Post the unloading QC in Quality Control first.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>RST</th>
                  <th>Vehicle</th>
                  <th>Supplier</th>
                  <th>Variety</th>
                  <th>Lot</th>
                  <th className="text-right">Net weight</th>
                  <th className="text-right">Accepted</th>
                  <th>Moisture</th>
                  <th>QC posted</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((l) => (
                  <tr key={l.qc_line_id}>
                    <td className="font-bold text-ink">
                      {l.rst} <span className="text-[11px] font-normal text-muted">{l.rst_cycle}</span>
                    </td>
                    <td className="whitespace-nowrap">{l.vehicle_no}</td>
                    <td>{l.supplier ?? "—"}</td>
                    <td>{l.variety ?? "—"}</td>
                    <td className="font-mono text-xs">{l.lot_no}</td>
                    <td className="text-right">
                      <Qty kg={l.net_kg} />
                    </td>
                    <td className="text-right">
                      <Qty kg={l.accepted_kg} />
                    </td>
                    <td>{l.moisture_pct}%</td>
                    <td className="text-xs whitespace-nowrap">
                      {dateTime(l.posted_at)}
                      <div className="text-muted">{l.qc_pid}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card tone="#1f6b32" title="Trucks in production">
        <BatchFilters action="/production/receipts" sp={sp} />
        {history.batches.length === 0 ? (
          <Empty>No truck has been loaded into a tank yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Receipt ID</th>
                  <th>RST</th>
                  <th>Vehicle</th>
                  <th>Supplier</th>
                  <th>Broker</th>
                  <th>Variety</th>
                  <th className="text-right">Gross / Tare / Net</th>
                  <th className="text-right">Received</th>
                  <th>Weighed</th>
                  <th>QC by</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.batches.map((b) => {
                  const s = b.source_snapshot ?? {};
                  return (
                    <tr key={b.id} className={b.status === "cancelled" ? "opacity-60" : undefined}>
                      <td>
                        <BatchLink no={b.batch_no} />
                      </td>
                      <td className="font-bold text-ink">
                        {s.rst} <span className="text-[11px] font-normal text-muted">{s.rst_cycle}</span>
                      </td>
                      <td className="whitespace-nowrap">{s.vehicle_no}</td>
                      <td>{s.supplier ?? "—"}</td>
                      <td>{s.broker ?? "—"}</td>
                      <td>{s.variety}</td>
                      <td className="text-right text-xs whitespace-nowrap tabular-nums">
                        {Number(s.gross_kg).toLocaleString("en-IN")} / {Number(s.tare_kg).toLocaleString("en-IN")} / {Number(s.net_kg).toLocaleString("en-IN")} kg
                      </td>
                      <td className="text-right">
                        <Qty kg={b.output_kg} />
                      </td>
                      <td className="text-xs whitespace-nowrap">{dateTime(String(s.weighed_at ?? ""))}</td>
                      <td className="text-xs">{s.qc_user ?? "—"}</td>
                      <td>
                        <StatusBadge status={b.status} />
                        <div className="mt-0.5 text-[11px] text-muted">{m.userName(b.operator_id)}</div>
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
