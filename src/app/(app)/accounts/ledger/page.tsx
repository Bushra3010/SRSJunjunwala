import { Card, Empty, Flash, PageHeader } from "@/components/ui";
import { AccountsNav, DrCr, VTYPE_LABEL } from "@/components/accounts";
import { requireModule } from "@/lib/auth";
import { rupees } from "@/lib/tally";
import { date } from "@/lib/format";

export const metadata = { title: "Party ledgers · Accounts" };

type Row = { vdate: string; vtype: string; ref: string; narration: string; debit: number; credit: number; balance: number; voucher_key: string };

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ party?: string; broker?: string; error?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireModule("accounts");
  const [{ data: parties }, { data: brokers }] = await Promise.all([
    supabase.from("parties").select("id, name, kind").order("name"),
    supabase.from("brokers").select("id, name").order("name"),
  ]);
  const party = sp.party ? (parties ?? []).find((p) => p.id === sp.party) : undefined;
  const broker = !party && sp.broker ? (brokers ?? []).find((b) => b.id === sp.broker) : undefined;
  const { data, error } =
    party || broker ? await supabase.rpc("party_ledger", { p_party: party?.id ?? null, p_broker: broker?.id ?? null }) : { data: [], error: null };
  const rows = (data ?? []) as Row[];
  const name = party?.name ?? broker?.name;
  const dr = rows.reduce((a, r) => a + Number(r.debit), 0);
  const cr = rows.reduce((a, r) => a + Number(r.credit), 0);
  const csv = party ? `/api/accounts/ledger?party=${party.id}` : broker ? `/api/accounts/ledger?broker=${broker.id}` : null;

  return (
    <>
      <PageHeader title="Party ledgers" description="Every entry for one supplier, customer or broker, with the running balance." crumbs={[{ label: "Accounts", href: "/accounts" }]} />
      <AccountsNav active="ledger" />
      <Flash error={sp.error ?? (error ? error.message : undefined)} />
      <form className="mb-5 flex flex-wrap items-end gap-2" action="/accounts/ledger">
        <div>
          <label className="label" htmlFor="ledger-who">Party or broker</label>
          <select
            id="ledger-who"
            name={broker ? "broker" : "party"}
            className="input w-auto min-w-64"
            defaultValue={party?.id ?? broker?.id ?? ""}
          >
            <option value="" disabled>
              Choose…
            </option>
            <optgroup label="Parties">
              {(parties ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kind})
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <button className="btn-primary">Show ledger</button>
        {(brokers ?? []).length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
            Brokers:
            {(brokers ?? []).map((b) => (
              <a key={b.id} href={`/accounts/ledger?broker=${b.id}`} className="rounded-md border border-line bg-white px-2 py-1 font-semibold text-ink hover:border-[#c08a24]">
                {b.name}
              </a>
            ))}
          </span>
        )}
      </form>

      {!name ? (
        <Empty>Choose a party or broker to see their ledger.</Empty>
      ) : (
        <Card
          tone="#1f6b32"
          title={`${name} — ledger`}
          actions={
            csv ? (
              <a href={csv} className="btn-secondary py-1">
                Download Excel (CSV)
              </a>
            ) : null
          }
        >
          {rows.length === 0 ? (
            <Empty>No entries yet. Trucks need a rate before they show here.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th>Details</th>
                    <th className="text-right">Debit</th>
                    <th className="text-right">Credit</th>
                    <th className="text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.voucher_key}>
                      <td className="whitespace-nowrap">{date(r.vdate)}</td>
                      <td>{VTYPE_LABEL[r.vtype] ?? r.vtype}</td>
                      <td className="text-xs whitespace-nowrap">{r.ref}</td>
                      <td className="text-xs">{r.narration}</td>
                      <td className="text-right tabular-nums">{Number(r.debit) ? rupees(r.debit) : ""}</td>
                      <td className="text-right tabular-nums">{Number(r.credit) ? rupees(r.credit) : ""}</td>
                      <td className="text-right whitespace-nowrap">
                        <DrCr value={r.balance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold">
                    <td colSpan={4}>Total</td>
                    <td className="text-right tabular-nums">{rupees(dr)}</td>
                    <td className="text-right tabular-nums">{rupees(cr)}</td>
                    <td className="text-right">
                      <DrCr value={dr - cr} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
