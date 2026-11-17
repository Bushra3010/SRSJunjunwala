import { randomUUID } from "node:crypto";
import { Card, Empty, Flash, Note, PageHeader } from "@/components/ui";
import { AccountsNav } from "@/components/accounts";
import { requireModule } from "@/lib/auth";
import { ACCOUNT_EDITORS } from "@/lib/roles";
import { rupees } from "@/lib/tally";
import { date, todayIST } from "@/lib/format";
import { cancelPayment, recordPayment } from "../actions";

export const metadata = { title: "Payments & receipts · Accounts" };

const MODES = ["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash", "Other"];

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string; kind?: string }> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("accounts");
  const canEdit = ACCOUNT_EDITORS.includes(profile.role);
  const kind = sp.kind === "receipt" ? "receipt" : "payment";
  const [{ data: parties }, { data: brokers }, { data: banks }, { data: list }, { data: exported }] = await Promise.all([
    supabase.from("parties").select("id, name, kind").eq("active", true).order("name"),
    supabase.from("brokers").select("id, name").eq("active", true).order("name"),
    supabase.from("bank_accounts").select("id, name, account_last4").eq("active", true).order("name"),
    supabase
      .from("payments")
      .select("id, voucher_no, kind, party_id, broker_id, bank_account_id, amount, paid_on, mode, reference, narration, status, cancel_reason")
      .order("created_at", { ascending: false })
      .limit(100),
    supabase.from("tally_exported").select("voucher_key"),
  ]);
  const exportedKeys = new Set((exported ?? []).map((e) => e.voucher_key));
  const nameOf = (p: { party_id: string | null; broker_id: string | null }) =>
    p.party_id ? ((parties ?? []).find((x) => x.id === p.party_id)?.name ?? "—") : ((brokers ?? []).find((x) => x.id === p.broker_id)?.name ?? "—") + " (broker)";
  const bankOf = (id: string | null) => (id ? (banks ?? []).find((b) => b.id === id)?.name ?? "Bank" : "Cash");
  const partyChoices = (parties ?? []).filter((p) => (kind === "payment" ? p.kind !== "customer" : p.kind !== "supplier"));

  return (
    <>
      <PageHeader
        title="Payments & receipts"
        description="Money paid to suppliers and brokers, and money received from customers. Each entry reduces the party's balance and goes to Tally as a Payment or Receipt voucher."
        crumbs={[{ label: "Accounts", href: "/accounts" }]}
      />
      <AccountsNav active="payments" />
      <Flash error={sp.error} notice={sp.notice} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_1fr]">
        {canEdit ? (
          <Card tone="#1f6b32" title={kind === "payment" ? "Record a payment (money out)" : "Record a receipt (money in)"}>
            <div className="flex gap-1.5 px-4 pt-4">
              <a href="/accounts/payments" className={kind === "payment" ? "btn-primary py-1" : "btn-secondary py-1"}>
                Payment
              </a>
              <a href="/accounts/payments?kind=receipt" className={kind === "receipt" ? "btn-primary py-1" : "btn-secondary py-1"}>
                Receipt
              </a>
            </div>
            <form action={recordPayment} className="grid gap-3 p-4">
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="request_id" value={randomUUID()} />
              <input type="hidden" name="back" value={kind === "receipt" ? "/accounts/payments?kind=receipt" : "/accounts/payments"} />
              <div>
                <label className="label" htmlFor="pay-who">{kind === "payment" ? "Paid to" : "Received from"}</label>
                <select id="pay-who" name="who" className="input" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  <optgroup label={kind === "payment" ? "Suppliers" : "Customers"}>
                    {partyChoices.map((p) => (
                      <option key={p.id} value={`p:${p.id}`}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                  {kind === "payment" && (brokers ?? []).length > 0 && (
                    <optgroup label="Brokers">
                      {(brokers ?? []).map((b) => (
                        <option key={b.id} value={`b:${b.id}`}>
                          {b.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="pay-amt">Amount (₹)</label>
                  <input id="pay-amt" name="amount" inputMode="decimal" className="input" required placeholder="e.g. 250000" />
                </div>
                <div>
                  <label className="label" htmlFor="pay-date">Date</label>
                  <input id="pay-date" name="paid_on" type="date" className="input" required defaultValue={todayIST()} max={todayIST()} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="pay-mode">Mode</label>
                  <select id="pay-mode" name="mode" className="input" defaultValue="NEFT">
                    {MODES.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="pay-bank">Bank account</label>
                  <select id="pay-bank" name="bank_id" className="input" defaultValue={(banks ?? [])[0]?.id ?? ""}>
                    <option value="">Cash (no bank)</option>
                    {(banks ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.account_last4 ? ` ··${b.account_last4}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="label" htmlFor="pay-ref">UTR / cheque number</label>
                <input id="pay-ref" name="reference" className="input" placeholder="Required for bank transfers and cheques" />
              </div>
              <div>
                <label className="label" htmlFor="pay-note">Narration (optional)</label>
                <input id="pay-note" name="narration" className="input" placeholder="e.g. Against RST 201–215" />
              </div>
              {(banks ?? []).length === 0 && <Note>Add your bank accounts on the Tally settings page first (cash entries work without one).</Note>}
              <button className="btn-primary">{kind === "payment" ? "Save payment" : "Save receipt"}</button>
            </form>
          </Card>
        ) : (
          <Note>Payments are recorded by the accountant or administrator. You can view them here.</Note>
        )}

        <Card tone="#4b5563" title="Recent payments and receipts">
          {(list ?? []).length === 0 ? (
            <Empty>No payments or receipts yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>No.</th>
                    <th>Date</th>
                    <th>Party</th>
                    <th className="text-right">Amount</th>
                    <th>Mode</th>
                    <th>Status</th>
                    {canEdit && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {(list ?? []).map((p) => {
                    const key = (p.kind === "payment" ? "PAY:" : "RCT:") + p.id;
                    const inTally = exportedKeys.has(key);
                    return (
                      <tr key={p.id} className={p.status === "cancelled" ? "opacity-60" : ""}>
                        <td className="font-mono text-xs whitespace-nowrap">{p.voucher_no}</td>
                        <td className="whitespace-nowrap">{date(p.paid_on)}</td>
                        <td>
                          {nameOf(p)}
                          {p.narration && <div className="text-[11px] text-muted">{p.narration}</div>}
                        </td>
                        <td className={`text-right font-bold tabular-nums ${p.kind === "payment" ? "text-[#a11a1a]" : "text-[#14632f]"}`}>
                          {p.kind === "payment" ? "−" : "+"}
                          {rupees(p.amount)}
                        </td>
                        <td className="text-xs">
                          {p.mode} · {bankOf(p.bank_account_id)}
                          {p.reference && <div className="font-mono text-[11px]">{p.reference}</div>}
                        </td>
                        <td className="text-xs">
                          {p.status === "cancelled" ? `Cancelled: ${p.cancel_reason}` : inTally ? "In Tally" : "Not yet in Tally"}
                        </td>
                        {canEdit && (
                          <td>
                            {p.status === "posted" && (
                              <details>
                                <summary className="btn-danger cursor-pointer list-none py-1 text-xs">Cancel…</summary>
                                <form action={cancelPayment} className="mt-2 flex gap-1.5">
                                  <input type="hidden" name="id" value={p.id} />
                                  <input type="hidden" name="voucher_no" value={p.voucher_no} />
                                  <input type="hidden" name="back" value="/accounts/payments" />
                                  {inTally && <input type="hidden" name="exported" value="1" />}
                                  <input name="reason" className="input py-1 text-xs" placeholder="Reason" required aria-label={`Reason to cancel ${p.voucher_no}`} />
                                  <button className="btn-danger py-1 text-xs">Cancel</button>
                                </form>
                              </details>
                            )}
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
      </div>
    </>
  );
}
