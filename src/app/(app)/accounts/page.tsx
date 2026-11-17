import Link from "next/link";
import { Card, Empty, Flash, Note, PageHeader } from "@/components/ui";
import { AccountsNav, DrCr } from "@/components/accounts";
import { requireModule } from "@/lib/auth";
import { loadVouchers } from "@/lib/accounts";
import { rupees } from "@/lib/tally";
import { date } from "@/lib/format";

export const metadata = { title: "Outstanding · Accounts" };

type Bal = { party_id: string | null; broker_id: string | null; name: string; kind: string; debit: number; credit: number; balance: number; last_date: string };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("accounts");
  const [{ data, error }, { rows }] = await Promise.all([supabase.rpc("party_balances"), loadVouchers(null, null)]);
  const bals = (data ?? []) as Bal[];
  const payable = bals.filter((b) => Number(b.balance) < -0.005);
  const receivable = bals.filter((b) => Number(b.balance) > 0.005);
  const sum = (xs: Bal[]) => xs.reduce((a, b) => a + Math.abs(Number(b.balance)), 0);
  const needs = rows.filter((r) => r.problem && r.source_status === "posted").length;
  const pending = rows.filter((r) => !r.problem && r.source_status === "posted" && !r.export_no).length;
  const href = (b: Bal) => `/accounts/ledger?${b.party_id ? `party=${b.party_id}` : `broker=${b.broker_id}`}`;

  const table = (list: Bal[]) =>
    list.length === 0 ? (
      <Empty>Nothing here.</Empty>
    ) : (
      <div className="overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Party</th>
              <th className="text-right">Debits</th>
              <th className="text-right">Credits</th>
              <th className="text-right">Balance</th>
              <th>Last entry</th>
            </tr>
          </thead>
          <tbody>
            {list.map((b) => (
              <tr key={(b.party_id ?? "") + (b.broker_id ?? "")}>
                <td>
                  <Link href={href(b)} className="font-bold text-ink hover:text-accent">
                    {b.name}
                  </Link>{" "}
                  <span className="text-[11px] text-muted capitalize">{b.kind}</span>
                </td>
                <td className="text-right tabular-nums">{rupees(b.debit)}</td>
                <td className="text-right tabular-nums">{rupees(b.credit)}</td>
                <td className="text-right">
                  <DrCr value={b.balance} />
                </td>
                <td className="text-xs whitespace-nowrap">{date(b.last_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Party balances from trucks (purchases), dispatches (sales), broker commission, payments and receipts. The books are kept in Tally; this module sends entries to it."
      />
      <AccountsNav active="outstanding" />
      <Flash error={sp.error ?? (error ? error.message : undefined)} notice={sp.notice} />
      {(needs > 0 || pending > 0) && (
        <div className="mb-5">
          <Note>
            {needs > 0 && (
              <>
                <b>{needs}</b> entr{needs === 1 ? "y needs a rate or customer before it" : "ies need a rate or customer before they"} can go to Tally.{" "}
              </>
            )}
            {pending > 0 && (
              <>
                <b>{pending}</b> entr{pending === 1 ? "y is" : "ies are"} ready and not yet in Tally.{" "}
              </>
            )}
            <Link href="/accounts/tally" className="font-bold underline">
              Open Tally export
            </Link>
          </Note>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#a11a1a" title={`We have to pay · ${rupees(sum(payable))}`}>
          {table(payable)}
        </Card>
        <Card tone="#1d4f9a" title={`We have to receive · ${rupees(sum(receivable))}`}>
          {table(receivable)}
        </Card>
      </div>
      <p className="mt-4 text-[12px] text-muted">
        Dr = the party owes us. Cr = we owe the party. Only entries with a rate are counted; fill missing rates on the Tally export page.
      </p>
    </>
  );
}
