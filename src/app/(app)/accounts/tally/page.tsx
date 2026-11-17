import { Card, Empty, Flash, Note, PageHeader } from "@/components/ui";
import { AccountsNav, VTYPE_LABEL } from "@/components/accounts";
import { requireModule } from "@/lib/auth";
import { ACCOUNT_EDITORS } from "@/lib/roles";
import { loadVouchers, monthRange, validDate } from "@/lib/accounts";
import { rupees } from "@/lib/tally";
import { date, dateTime } from "@/lib/format";
import { saveOverrides } from "../actions";

export const metadata = { title: "Tally export · Accounts" };

type SP = { from?: string; to?: string; show?: string; error?: string; notice?: string };
type Line = { line_id: string; kind: string; variety: string; qty_kg: number; rate: number | null; party_id: string | null };

export default async function TallyPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("accounts");
  const canEdit = ACCOUNT_EDITORS.includes(profile.role);
  const def = monthRange();
  const from = validDate(sp.from) ?? def.from;
  const to = validDate(sp.to) ?? def.to;
  const showAll = sp.show === "all";
  const [{ rows, error }, { data: history }, { data: customers }] = await Promise.all([
    loadVouchers(from, to),
    supabase.from("tally_exports").select("id, export_no, from_date, to_date, voucher_count, total_amount, exported_at").order("exported_at", { ascending: false }).limit(20),
    supabase.from("parties").select("id, name, kind").neq("kind", "supplier").eq("active", true).order("name"),
  ]);
  const problems = rows.filter((r) => r.problem && r.source_status === "posted");
  const ready = rows.filter((r) => !r.problem && r.source_status === "posted" && !r.export_no);
  const exported = rows.filter((r) => r.export_no && r.source_status === "posted");
  const undone = rows.filter((r) => r.export_no && r.source_status !== "posted");
  const lines = new Map<string, Line[]>();
  if (canEdit) {
    await Promise.all(
      problems.slice(0, 30).map(async (r) => {
        const { data } = await supabase.rpc("voucher_lines", { p_key: r.voucher_key });
        lines.set(r.voucher_key, (data ?? []) as Line[]);
      }),
    );
  }
  const here = `/accounts/tally?from=${from}&to=${to}${showAll ? "&show=all" : ""}`;
  const total = ready.reduce((a, r) => a + Number(r.amount ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Tally export"
        description="Entries from trucks, dispatches, brokerage and payments, ready to import into TallyPrime. Each entry is sent once; the file is imported in Tally via Gateway of Tally → Import → Transactions."
        crumbs={[{ label: "Accounts", href: "/accounts" }]}
      />
      <AccountsNav active="tally" />
      <Flash error={sp.error ?? (error ? error.message : undefined)} notice={sp.notice} />

      <form className="mb-5 flex flex-wrap items-end gap-2" action="/accounts/tally">
        <div>
          <label className="label" htmlFor="tx-from">From</label>
          <input id="tx-from" type="date" name="from" defaultValue={from} className="input w-auto" />
        </div>
        <div>
          <label className="label" htmlFor="tx-to">To</label>
          <input id="tx-to" type="date" name="to" defaultValue={to} className="input w-auto" />
        </div>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" name="show" value="all" defaultChecked={showAll} className="size-4 accent-[#1f6b32]" /> Also list entries already in Tally
        </label>
        <button className="btn-secondary">Show</button>
      </form>

      {undone.length > 0 && (
        <div className="mb-5">
          <Note>
            <b>Fix in Tally:</b> {undone.length} entr{undone.length === 1 ? "y was" : "ies were"} reversed or cancelled in the ERP after going to Tally:{" "}
            {undone.map((r) => `${VTYPE_LABEL[r.vtype] ?? r.vtype} ${r.ref} (${rupees(r.amount)}, ${r.export_no})`).join("; ")}. Cancel or delete
            {undone.length === 1 ? " it" : " them"} in Tally.
          </Note>
        </div>
      )}

      {problems.length > 0 && (
        <Card tone="#b5532f" title={`Needs a rate or customer (${problems.length})`} className="mb-6">
          <ul className="divide-y divide-line">
            {problems.map((r) => {
              const ls = lines.get(r.voucher_key) ?? [];
              const kind = r.vtype === "Sales" ? "sales" : "purchase";
              return (
                <li key={r.voucher_key} className="grid gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      <b>{VTYPE_LABEL[r.vtype] ?? r.vtype}</b> · {date(r.vdate)} · {r.ref} · {r.party_name}
                    </span>
                    <span className="rounded bg-[#fdf0e6] px-2 py-0.5 text-[12px] font-bold text-[#8a3b12]">{r.problem}</span>
                  </div>
                  {canEdit && ls.length > 0 && (
                    <form action={saveOverrides} className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-[#fbf8ef] p-3">
                      <input type="hidden" name="kind" value={kind} />
                      <input type="hidden" name="back" value={here} />
                      {ls.map((l) => (
                        <div key={l.line_id}>
                          <input type="hidden" name="line_id" value={l.line_id} />
                          <label className="label" htmlFor={`rate-${l.line_id}`}>
                            {l.variety} · {(Number(l.qty_kg) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })} q — ₹ per quintal
                          </label>
                          <input
                            id={`rate-${l.line_id}`}
                            name={`rate_${l.line_id}`}
                            inputMode="decimal"
                            className="input w-36"
                            defaultValue={l.rate ?? ""}
                            placeholder="e.g. 2400"
                          />
                        </div>
                      ))}
                      {kind === "sales" && (
                        <div>
                          <label className="label" htmlFor={`cust-${r.voucher_key}`}>Customer</label>
                          <select id={`cust-${r.voucher_key}`} name="party_id" className="input w-auto" defaultValue={ls[0]?.party_id ?? ""}>
                            <option value="">Choose…</option>
                            {(customers ?? []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <button className="btn-primary">Save</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card tone="#1f6b32" title={`Ready for Tally (${ready.length}) · ${rupees(total)}`} className="mb-6">
        {ready.length === 0 ? (
          <Empty>Nothing new to send to Tally for these dates.</Empty>
        ) : (
          <form action="/api/accounts/tally" method="post">
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="to" value={to} />
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th className="w-8"></th>
                    <th>Date</th>
                    <th>Voucher</th>
                    <th>Ledger in Tally</th>
                    <th>Reference</th>
                    <th>Details</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.map((r) => (
                    <tr key={r.voucher_key}>
                      <td>
                        <input type="checkbox" name="key" value={r.voucher_key} defaultChecked disabled={!canEdit} className="size-4 accent-[#1f6b32]" aria-label={`Include ${r.ref}`} />
                      </td>
                      <td className="whitespace-nowrap">{date(r.vdate)}</td>
                      <td>{VTYPE_LABEL[r.vtype] ?? r.vtype}</td>
                      <td className="font-bold">{r.ledger_name}</td>
                      <td className="text-xs whitespace-nowrap">{r.ref}</td>
                      <td className="text-xs">{r.narration}</td>
                      <td className="text-right font-bold tabular-nums">{rupees(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canEdit ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                <p className="text-[12px] text-muted">
                  Downloads a TallyPrime file and marks the ticked entries as sent, so they are not sent again. First time? Download the ledgers file below and import it
                  first.
                </p>
                <button className="btn-primary">Download Tally file</button>
              </div>
            ) : (
              <p className="border-t border-line px-5 py-3 text-[12px] text-muted">Only the accountant or administrator can export.</p>
            )}
          </form>
        )}
      </Card>

      {showAll && exported.length > 0 && (
        <Card tone="#4b5563" title={`Already in Tally (${exported.length})`} className="mb-6">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Voucher</th>
                  <th>Ledger</th>
                  <th>Reference</th>
                  <th className="text-right">Amount</th>
                  <th>Export</th>
                </tr>
              </thead>
              <tbody>
                {exported.map((r) => (
                  <tr key={r.voucher_key}>
                    <td className="whitespace-nowrap">{date(r.vdate)}</td>
                    <td>{VTYPE_LABEL[r.vtype] ?? r.vtype}</td>
                    <td>{r.ledger_name}</td>
                    <td className="text-xs">{r.ref}</td>
                    <td className="text-right tabular-nums">{rupees(r.amount)}</td>
                    <td className="font-mono text-xs">{r.export_no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#7b4f8e" title="Ledgers file (masters)">
          <div className="grid gap-3 p-4 text-[13px]">
            <p>
              Tally only accepts entries for ledgers that exist. This file creates the party, broker, bank, purchase, sales and brokerage ledgers used in these dates.
              Import it in TallyPrime via <b>Import → Masters</b> before the entries file. Ledgers that already exist are not changed (Tally may count them as errors in its import summary; that is expected).
            </p>
            <a href={`/api/accounts/tally?masters=1&from=${from}&to=${to}`} className="btn-secondary w-fit">
              Download ledgers file
            </a>
          </div>
        </Card>
        <Card tone="#4b5563" title="Export history">
          {(history ?? []).length === 0 ? (
            <Empty>Nothing exported yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {(history ?? []).map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                  <span>
                    <b className="font-mono">{h.export_no}</b> · {dateTime(h.exported_at)} · {h.voucher_count} entries · {rupees(h.total_amount)}
                  </span>
                  <a href={`/api/accounts/tally?export=${h.id}`} className="btn-secondary py-1 text-xs">
                    Download again
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
