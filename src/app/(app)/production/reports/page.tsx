import { Download } from "lucide-react";
import { Card, Empty, Note, PageHeader, Tabs } from "@/components/ui";
import { ProductionNav } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { todayIST } from "@/lib/format";
import { REPORTS, buildReport, type ReportKey } from "@/lib/production-reports";

export const metadata = { title: "Production reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ r?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  await requireModule("processing");
  const key = (REPORTS.some((r) => r.key === sp.r) ? sp.r : "daily") as ReportKey;
  const to = sp.to || todayIST();
  const from = sp.from || new Date(new Date(`${to}T00:00:00+05:30`).getTime() - 6 * 864e5).toISOString().slice(0, 10);
  const report = await buildReport(key, from, to);
  const qs = (k: string) => `/production/reports?r=${k}&from=${from}&to=${to}`;

  return (
    <>
      <PageHeader title="Production reports" description="Every report can be downloaded as CSV, which opens directly in Excel." crumbs={[{ label: "Production", href: "/production" }]} />
      <ProductionNav active="reports" />
      <Tabs tabs={REPORTS.map((r) => ({ key: r.key, label: r.label, href: qs(r.key) }))} active={key} />
      <Card
        tone="#1f6b32"
        title={report.title}
        actions={
          <a href={`/api/production/reports/${key}?from=${from}&to=${to}`} className="btn-secondary py-1">
            <Download className="size-4" /> Download CSV / Excel
          </a>
        }
      >
        <form action="/production/reports" className="flex flex-wrap items-end gap-2 border-b border-line px-5 py-3">
          <input type="hidden" name="r" value={key} />
          <div>
            <label className="label" htmlFor="rf">From</label>
            <input id="rf" type="date" name="from" defaultValue={from} className="input w-auto" />
          </div>
          <div>
            <label className="label" htmlFor="rt">To</label>
            <input id="rt" type="date" name="to" defaultValue={to} className="input w-auto" />
          </div>
          <button className="btn-secondary">Apply</button>
          <span className="pb-2 text-xs text-muted">Batches are included by their start date (IST).</span>
        </form>
        {report.note && (
          <div className="px-5 pt-4">
            <Note>{report.note}</Note>
          </div>
        )}
        {report.rows.length === 0 ? (
          <Empty>No production in this period.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  {report.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j} className={typeof v === "number" ? "text-right tabular-nums" : j === 0 ? "font-bold text-ink" : undefined}>
                        {v === null || v === "" ? "—" : typeof v === "number" ? v.toLocaleString("en-IN") : v}
                      </td>
                    ))}
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
