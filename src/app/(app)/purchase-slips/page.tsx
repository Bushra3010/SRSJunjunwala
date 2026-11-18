import Link from "next/link";
import { Card, Empty, Flash, PageHeader, Tabs } from "@/components/ui";
import { requireModule } from "@/lib/auth";
import { ACCOUNT_EDITORS } from "@/lib/roles";
import { STATUS_TONE, qtl, rs, slipDate, type Slip } from "@/lib/slips";
import { buildSlip, enterDeduction } from "./actions";

export const metadata = { title: "Purchase slips · SRS Factory" };

type SP = { tab?: string; q?: string; error?: string; notice?: string };
type Row = Slip & { purchase_slip_lines: { id: string; label: string; pending: boolean; code: string | null; basis: string }[] };

export default async function SlipsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("purchase-slips");
  const tab = ["pending", "draft", "final", "paid", "cancelled"].includes(sp.tab ?? "") ? sp.tab! : "all";
  const canEdit = ACCOUNT_EDITORS.includes(profile.role);

  let query = supabase
    .from("purchase_slips")
    .select("*, parties(name), brokers(name, phone), locations(name), purchase_slip_lines(id, label, pending, code, basis)")
    .order("slip_date", { ascending: false })
    .order("rst", { ascending: false })
    .limit(200);
  if (tab !== "all" && tab !== "pending") query = query.eq("status", tab);
  if (tab === "pending") query = query.eq("status", "draft");
  const q = (sp.q ?? "").trim();
  if (/^\d+$/.test(q)) query = query.eq("rst", Number(q));
  else if (q) query = query.or(`vehicle_no.ilike.%${q.replace(/[%,()]/g, "")}%,slip_no.ilike.%${q.replace(/[%,()]/g, "")}%`);
  const { data } = await query;
  let rows = (data ?? []) as unknown as Row[];
  if (tab === "pending") rows = rows.filter((r) => r.purchase_slip_lines.some((l) => l.pending));
  const { data: types } = await supabase.from("purchase_deduction_types").select("code, entry_roles, entered_later");
  const mayEnter = (code: string | null) => {
    const t = (types ?? []).find((x) => x.code === code);
    return canEdit || (!!t?.entered_later && (t.entry_roles as string[]).includes(profile.role));
  };
  // Posted unloading QC with no live slip (posted before slips existed, or the build failed).
  let missing: { id: string; pid: string; posted_at: string; weighbridge_tickets: { rst: number; vehicle_no: string } | null }[] = [];
  if (canEdit && tab === "all" && !q) {
    const since = new Date(Date.now() - 60 * 86400_000).toISOString();
    const [{ data: posted }, { data: live }] = await Promise.all([
      supabase.from("qc_inbound").select("id, pid, posted_at, weighbridge_tickets(rst, vehicle_no)").eq("status", "posted").gte("posted_at", since).order("posted_at", { ascending: false }).limit(300),
      supabase.from("purchase_slips").select("qc_id").neq("status", "cancelled").gte("created_at", since),
    ]);
    const have = new Set((live ?? []).map((x) => x.qc_id));
    missing = ((posted ?? []) as unknown as typeof missing).filter((x) => !have.has(x.id)).slice(0, 30);
  }
  const href = (t: string) => `/purchase-slips?tab=${t}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <>
      <PageHeader
        title="Purchase slips"
        description="One slip per purchase truck, made automatically when its unloading QC is posted. Khad and other later deductions are filled in here; the accountant finalises, pays and sends the slip to the broker."
        actions={
          <Link href="/purchase-slips/settings" className="btn-secondary">
            Slip parameters
          </Link>
        }
      />
      <Flash error={sp.error} notice={sp.notice} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          active={tab}
          tabs={[
            { key: "all", label: "All", href: href("all") },
            { key: "pending", label: "Khad pending", href: href("pending") },
            { key: "draft", label: "Draft", href: href("draft") },
            { key: "final", label: "Final (to pay)", href: href("final") },
            { key: "paid", label: "Paid", href: href("paid") },
            { key: "cancelled", label: "Cancelled", href: href("cancelled") },
          ]}
        />
        <form className="flex gap-2">
          <input type="hidden" name="tab" value={tab} />
          <input name="q" defaultValue={q} className="input w-56" placeholder="RST, vehicle or slip no." aria-label="Search slips" />
          <button className="btn-secondary">Search</button>
        </form>
      </div>
      {missing.length > 0 && (
        <Card title={`Posted trucks without a slip (${missing.length})`} className="mb-5">
          <ul className="divide-y divide-line">
            {missing.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
                <span>
                  RST {m.weighbridge_tickets?.rst} · {m.weighbridge_tickets?.vehicle_no} · QC {m.pid}
                </span>
                <form action={buildSlip}>
                  <input type="hidden" name="qc_id" value={m.id} />
                  <button className="btn-secondary py-1">Build slip</button>
                </form>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        {rows.length === 0 ? (
          <Empty>No slips here yet. Slips appear when an unloading QC is posted.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Slip</th>
                  <th>Date</th>
                  <th className="num">RST</th>
                  <th>Vehicle</th>
                  <th>Party / broker</th>
                  <th className="num">Net q</th>
                  <th className="num">Amount</th>
                  <th className="num">Deductions</th>
                  <th className="num">Payable</th>
                  <th>Status</th>
                  {tab === "pending" && <th>Fill in</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pending = r.purchase_slip_lines.filter((l) => l.pending);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/purchase-slips/${r.id}`} className="font-semibold text-accent hover:underline">
                          {r.slip_no}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap">{slipDate(r.slip_date)}</td>
                      <td className="num">{r.rst}</td>
                      <td className="whitespace-nowrap">{r.vehicle_no}</td>
                      <td>
                        <span className="block text-ink">{r.parties?.name ?? "—"}</span>
                        <span className="text-xs">{r.brokers?.name ?? ""}</span>
                      </td>
                      <td className="num">{qtl(r.net_kg)}</td>
                      <td className="num">{rs(r.amount)}</td>
                      <td className="num">{rs(r.total_deductions)}</td>
                      <td className="num font-semibold text-ink">
                        {r.rate_per_qtl == null ? <span className="text-[12px] font-bold text-danger">Rate missing</span> : rs(r.net_payable)}
                      </td>
                      <td>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold capitalize ${STATUS_TONE[r.status]}`}>{r.status}</span>
                        {pending.length > 0 && (
                          <span className="ml-1 rounded-full bg-[#fdecec] px-2 py-0.5 text-[11px] font-bold text-[#a11a1a]">{pending.map((l) => l.label).join(", ")} pending</span>
                        )}
                      </td>
                      {tab === "pending" && (
                        <td className="min-w-56">
                          {pending
                            .filter((l) => mayEnter(l.code))
                            .map((l) => (
                              <form key={l.id} action={enterDeduction} className="flex items-center gap-1.5">
                                <input type="hidden" name="id" value={r.id} />
                                <input type="hidden" name="line_id" value={l.id} />
                                <input type="hidden" name="back" value={href("pending")} />
                                <input name="rate" type="number" min="0" step="0.001" required className="input w-24" placeholder={`${l.label} ${l.basis === "percent" ? "%" : ""}`} aria-label={`${l.label} for ${r.slip_no}`} />
                                <button className="btn-accent py-1.5">Save</button>
                              </form>
                            ))}
                        </td>
                      )}
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
