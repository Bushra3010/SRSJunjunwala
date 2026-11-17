import { Card, Empty, Flash, Note, PageHeader } from "@/components/ui";
import { AccountsNav } from "@/components/accounts";
import { requireModule } from "@/lib/auth";
import { ACCOUNT_EDITORS } from "@/lib/roles";
import { addBank, saveTallySettings, setTallyLedger, updateBank } from "../actions";

export const metadata = { title: "Tally settings · Accounts" };

export default async function TallySettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("accounts");
  const canEdit = ACCOUNT_EDITORS.includes(profile.role);
  const [{ data: settings }, { data: banks }, { data: parties }, { data: brokers }] = await Promise.all([
    supabase.from("tally_settings").select("key, value, label").order("sort_order"),
    supabase.from("bank_accounts").select("id, name, tally_ledger, account_last4, active").order("name"),
    supabase.from("parties").select("id, name, kind, tally_ledger, active").order("name"),
    supabase.from("brokers").select("id, name, tally_ledger, commission_per_qtl, active").order("name"),
  ]);

  return (
    <>
      <PageHeader
        title="Tally settings"
        description="Names must match your Tally company exactly (ledger names, voucher types). Set them once; every export uses them."
        crumbs={[{ label: "Accounts", href: "/accounts" }]}
      />
      <AccountsNav active="settings" />
      <Flash error={sp.error} notice={sp.notice} />
      {!canEdit && (
        <div className="mb-5">
          <Note>Only the accountant or administrator can change these settings.</Note>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#1f6b32" title="Tally company, ledgers and voucher types">
          <form action={saveTallySettings} className="grid gap-3 p-4">
            {(settings ?? []).map((s) => (
              <div key={s.key} className="grid gap-1 sm:grid-cols-[1fr_220px] sm:items-center">
                <label className="text-[13px] font-semibold text-ink" htmlFor={`s-${s.key}`}>
                  {s.label}
                </label>
                <input id={`s-${s.key}`} name={`s_${s.key}`} defaultValue={s.value} className="input" disabled={!canEdit} />
              </div>
            ))}
            {canEdit && <button className="btn-primary w-fit">Save settings</button>}
          </form>
        </Card>

        <Card tone="#3e6fc0" title="Bank accounts">
          {(banks ?? []).length === 0 ? (
            <Empty>No bank accounts yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {(banks ?? []).map((b) => (
                <li key={b.id} className={`flex flex-wrap items-center gap-2 px-4 py-2.5 ${b.active ? "" : "opacity-60"}`}>
                  <span className="min-w-40 flex-1">
                    <b>{b.name}</b>
                    {b.account_last4 ? <span className="text-[12px] text-muted"> ··{b.account_last4}</span> : null}
                  </span>
                  {canEdit ? (
                    <>
                      <form action={updateBank} className="flex gap-1.5">
                        <input type="hidden" name="id" value={b.id} />
                        <input name="tally_ledger" defaultValue={b.tally_ledger ?? ""} placeholder="Tally ledger (blank = same name)" className="input w-56 py-1 text-[13px]" aria-label={`Tally ledger for ${b.name}`} />
                        <button className="btn-secondary py-1 text-xs">Save</button>
                      </form>
                      <form action={updateBank}>
                        <input type="hidden" name="id" value={b.id} />
                        <input type="hidden" name="active" value={b.active ? "false" : "true"} />
                        <button className="btn-secondary py-1 text-xs">{b.active ? "Hide" : "Show"}</button>
                      </form>
                    </>
                  ) : (
                    <span className="text-[12px] text-muted">Tally: {b.tally_ledger || b.name}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && (
            <form action={addBank} className="grid gap-2 border-t border-line p-4 sm:grid-cols-[1fr_1fr_110px_auto] sm:items-end">
              <div>
                <label className="label" htmlFor="bank-name">Bank account</label>
                <input id="bank-name" name="name" className="input" placeholder="e.g. HDFC Current A/c" required />
              </div>
              <div>
                <label className="label" htmlFor="bank-tally">Tally ledger name</label>
                <input id="bank-tally" name="tally_ledger" className="input" placeholder="blank = same" />
              </div>
              <div>
                <label className="label" htmlFor="bank-last4">Last 4 digits</label>
                <input id="bank-last4" name="last4" className="input" inputMode="numeric" maxLength={4} placeholder="1234" />
              </div>
              <button className="btn-primary">Add</button>
            </form>
          )}
        </Card>

        <Card tone="#c08a24" title="Party ledger names in Tally" className="xl:col-span-2">
          <p className="px-4 pt-3 text-[12px] text-muted">Leave blank if the Tally ledger has the same name as in the ERP.</p>
          <ul className="divide-y divide-line">
            {(parties ?? []).map((p) => (
              <li key={p.id} className={`flex flex-wrap items-center gap-2 px-4 py-2 ${p.active ? "" : "opacity-60"}`}>
                <span className="min-w-56 flex-1">
                  <b>{p.name}</b> <span className="text-[12px] text-muted capitalize">{p.kind}</span>
                </span>
                {canEdit ? (
                  <form action={setTallyLedger} className="flex gap-1.5">
                    <input type="hidden" name="party_id" value={p.id} />
                    <input type="hidden" name="back" value="/accounts/settings" />
                    <input name="tally_ledger" defaultValue={p.tally_ledger ?? ""} placeholder={p.name} className="input w-64 py-1 text-[13px]" aria-label={`Tally ledger for ${p.name}`} />
                    <button className="btn-secondary py-1 text-xs">Save</button>
                  </form>
                ) : (
                  <span className="text-[12px] text-muted">Tally: {p.tally_ledger || p.name}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card tone="#7b4f8e" title="Brokers: Tally ledger and commission" className="xl:col-span-2">
          {(brokers ?? []).length === 0 ? (
            <Empty>No brokers in Admin → Masters yet.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {(brokers ?? []).map((b) => (
                <li key={b.id} className={`flex flex-wrap items-center gap-2 px-4 py-2 ${b.active ? "" : "opacity-60"}`}>
                  <span className="min-w-56 flex-1">
                    <b>{b.name}</b>
                  </span>
                  {canEdit ? (
                    <form action={setTallyLedger} className="flex flex-wrap gap-1.5">
                      <input type="hidden" name="broker_id" value={b.id} />
                      <input type="hidden" name="back" value="/accounts/settings" />
                      <input name="tally_ledger" defaultValue={b.tally_ledger ?? ""} placeholder={b.name} className="input w-56 py-1 text-[13px]" aria-label={`Tally ledger for ${b.name}`} />
                      <label className="flex items-center gap-1 text-[12px]">
                        ₹
                        <input name="commission" defaultValue={Number(b.commission_per_qtl) || ""} inputMode="decimal" placeholder="0" className="input w-20 py-1 text-[13px]" aria-label={`Commission per quintal for ${b.name}`} />
                        per q
                      </label>
                      <button className="btn-secondary py-1 text-xs">Save</button>
                    </form>
                  ) : (
                    <span className="text-[12px] text-muted">
                      Tally: {b.tally_ledger || b.name} · ₹{Number(b.commission_per_qtl)} per q
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
