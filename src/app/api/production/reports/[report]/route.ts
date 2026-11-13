import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canAccess } from "@/lib/roles";
import { todayIST } from "@/lib/format";
import { REPORTS, buildReport, toCsv, type ReportKey } from "@/lib/production-reports";

/** GET /api/production/reports/:report?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=json] — CSV (Excel) by default. */
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const session = await getSession();
  if (!session?.profile?.active || !canAccess(session.profile.role, "processing")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const key = (await params).report as ReportKey;
  if (!REPORTS.some((r) => r.key === key)) return NextResponse.json({ error: "Unknown report" }, { status: 404 });
  const url = new URL(req.url);
  const valid = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  const to = valid(url.searchParams.get("to")) ?? todayIST();
  const from = valid(url.searchParams.get("from")) ?? to;
  const report = await buildReport(key, from, to);
  if (url.searchParams.get("format") === "json") return NextResponse.json({ from, to, ...report });
  return new NextResponse(toCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="srs-${key}-${from}-to-${to}.csv"`,
    },
  });
}
