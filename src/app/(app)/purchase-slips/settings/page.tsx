import { Card, Flash, Note, PageHeader } from "@/components/ui";
import { hasRole, requireModule } from "@/lib/auth";
import { ROLE_LABELS, type Role } from "@/lib/roles";
import { BASIS_LABEL, bandsText, waPhone } from "@/lib/slips";
import { loadMoistureParams } from "@/lib/slips-server";
import { whatsappConfigured } from "@/lib/whatsapp";
import { addDeductionType, saveBroker, saveDeductionType, saveMoisture, saveWhatsAppSetting } from "./actions";

export const metadata = { title: "Slip parameters · Purchase slips" };

// Roles that could sensibly fill in a later deduction such as Khad.
const ENTRY_ROLES: Role[] = ["management", "weighbridge_operator", "qc_head", "qc_unloading", "commercial"];

export default async function SlipSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("purchase-slips");
  const isAdmin = hasRole(profile, ["admin"]);
  const canBrokers = hasRole(profile, ["admin", "accountant", "management"]);
  const [moisture, { data: slabs }, { data: types }, { data: auto }, { data: brokers }] = await Promise.all([
    loadMoistureParams(supabase),
    supabase.from("moisture_slabs").select("*").order("upto_pct", { nullsFirst: false }),
    supabase.from("purchase_deduction_types").select("*").order("sort_order"),
    supabase.from("calc_settings").select("value").eq("key", "slip_auto_whatsapp").maybeSingle(),
    supabase.from("brokers").select("id, name, phone, commission_per_qtl, active").order("name"),
  ]);
  const ro = !isAdmin;

  return (
    <>
      <PageHeader
        title="Slip parameters"
        description="Rates used to build each purchase slip. A slip keeps the rates it was made with, so changing them here only affects new slips."
        crumbs={[{ label: "Purchase slips", href: "/purchase-slips" }]}
      />
      <Flash error={sp.error} notice={sp.notice} />
      {ro && (
        <div className="mb-4">
          <Note>Only the administrator can change these parameters.</Note>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#3e6fc0" title="Moisture">
          <form action={saveMoisture} className="space-y-4 p-4">
            <fieldset disabled={ro} className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="label">
                  Pass up to (%)
                  <input name="pass_pct" type="number" step="0.1" min="0" max="60" className="input mt-1" defaultValue={moisture.passPct} />
                </label>
                <label className="label">
                  How the bands add up
                  <select name="progressive" className="input mt-1" defaultValue={moisture.progressive ? "1" : "0"}>
                    <option value="1">Each band at its own rate (22% = 4×1 + 2×1.5 = 7%)</option>
                    <option value="0">All points at the band&apos;s rate (22% = 6×1.5 = 9%)</option>
                  </select>
                </label>
              </div>
              <table className="table rounded-lg border border-line">
                <thead>
                  <tr>
                    <th>Band up to (%)</th>
                    <th>Deduction per point (%)</th>
                    <th>Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {(slabs ?? []).map((s) => (
                    <tr key={s.id}>
                      <td>
                        <input name={`slab_${s.id}_upto`} type="number" step="0.1" min="0" max="60" className="input" defaultValue={s.upto_pct ?? ""} placeholder="and above" aria-label="Band up to" />
                      </td>
                      <td>
                        <input name={`slab_${s.id}_per`} type="number" step="0.001" min="0" className="input" defaultValue={s.per_point} required aria-label="Deduction per point" />
                      </td>
                      <td>
                        <input name={`slab_${s.id}_remove`} type="checkbox" value="1" aria-label="Remove band" />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <input name="slab_new_upto" type="number" step="0.1" min="0" max="60" className="input" placeholder="New band up to" aria-label="New band up to" />
                    </td>
                    <td>
                      <input name="slab_new_per" type="number" step="0.001" min="0" className="input" placeholder="% per point" aria-label="New band deduction per point" />
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
              <ul className="text-[13px] text-muted">
                {bandsText(moisture).map((t) => (
                  <li key={t}>• {t}</li>
                ))}
              </ul>
              {isAdmin && <button className="btn-primary">Save moisture rules</button>}
            </fieldset>
          </form>
        </Card>

        <Card tone="#1f6b32" title="WhatsApp to brokers">
          <div className="space-y-3 p-4 text-[13px]">
            <p>
              <b>Manual:</b> on every slip, the WhatsApp button opens WhatsApp with the slip text and link ready for the broker&apos;s number. Works on any
              phone or computer with WhatsApp.
            </p>
            <p>
              <b>Automatic:</b> when the accountant records the payment, the slip goes to the broker by itself through the WhatsApp Business API.{" "}
              {whatsappConfigured() ? (
                <span className="font-semibold text-[#14632f]">API connected.</span>
              ) : (
                <span className="font-semibold text-danger">API not connected yet.</span>
              )}
            </p>
            <form action={saveWhatsAppSetting} className="flex items-center gap-3">
              <label className="flex items-center gap-2 font-semibold">
                <input type="checkbox" name="auto" defaultChecked={Number(auto?.value) === 1} disabled={ro} /> Send automatically after payment
              </label>
              {isAdmin && <button className="btn-secondary py-1">Save</button>}
            </form>
            {!whatsappConfigured() && (
              <Note>
                To connect: create a WhatsApp Business account in Meta Business Manager, get an approved template named <code>purchase_slip</code> with 5 values
                (slip no, party, RST · vehicle · date, total payable, link), then set <code>WHATSAPP_TOKEN</code> and <code>WHATSAPP_PHONE_NUMBER_ID</code> on
                the server. Until then, automatic sends are logged as &quot;not set up&quot; and the manual button still works.
              </Note>
            )}
          </div>
        </Card>
      </div>

      <Card title="Deductions on the slip" className="mt-6">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Name</th>
                <th>Calculated as</th>
                <th>Value</th>
                <th>Second value</th>
                <th>Filled in later by</th>
                <th>On</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(types ?? []).map((t) => {
                const formId = `type-${t.code}`;
                return (
                  <tr key={t.code}>
                    <td className="w-20">
                      <input form={formId} name="sort_order" type="number" className="input" defaultValue={t.sort_order} disabled={ro} aria-label={`${t.label} order`} />
                    </td>
                    <td className="min-w-36">
                      <input form={formId} name="label" className="input" defaultValue={t.label} disabled={ro} aria-label={`${t.code} name`} />
                    </td>
                    <td className="text-xs">{BASIS_LABEL[t.basis as keyof typeof BASIS_LABEL]}</td>
                    <td className="w-28">
                      {["moisture", "manual"].includes(t.basis) ? (
                        <span className="text-xs text-muted">{t.basis === "moisture" ? "from bands" : "typed on the slip"}</span>
                      ) : (
                        <input form={formId} name="value" type="number" step="0.001" min="0" className="input" defaultValue={t.value ?? ""} disabled={ro} aria-label={`${t.label} value`} />
                      )}
                    </td>
                    <td className="w-40">
                      {t.alt_label ? (
                        <label className="text-xs">
                          {t.alt_label}
                          <input form={formId} name="alt_value" type="number" step="0.001" min="0" className="input mt-0.5" defaultValue={t.alt_value ?? ""} disabled={ro} />
                        </label>
                      ) : (
                        <input form={formId} name="alt_value" type="hidden" value="" />
                      )}
                    </td>
                    <td className="min-w-56">
                      <label className="flex items-center gap-1.5 text-xs font-semibold">
                        <input form={formId} type="checkbox" name="entered_later" defaultChecked={t.entered_later} disabled={ro} /> Entered after unloading
                      </label>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        {ENTRY_ROLES.map((r) => (
                          <label key={r} className="flex items-center gap-1 text-xs">
                            <input form={formId} type="checkbox" name={`role_${r}`} defaultChecked={(t.entry_roles as string[]).includes(r)} disabled={ro} />
                            {ROLE_LABELS[r]}
                          </label>
                        ))}
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted">Admin and accountant can always.</p>
                    </td>
                    <td>
                      <input form={formId} type="checkbox" name="active" defaultChecked={t.active} disabled={ro} aria-label={`${t.label} in use`} />
                    </td>
                    <td>
                      {isAdmin && (
                        <form id={formId} action={saveDeductionType}>
                          <input type="hidden" name="code" value={t.code} />
                          <button className="btn-secondary py-1">Save</button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line p-4 text-[12px] text-muted">
          All percentages are of the amount (net weight × rate per quintal). Brokerage uses the broker&apos;s own rate below when it is set, otherwise the
          value here. Cash discount&apos;s second value is used when &quot;early payment&quot; is ticked on a slip; dhalta&apos;s when bags are returned.
        </div>
        {isAdmin && (
          <form action={addDeductionType} className="flex flex-wrap items-end gap-3 border-t border-line p-4">
            <label className="label">
              New deduction
              <input name="label" required className="input mt-1 w-48" placeholder="e.g. Sutli" />
            </label>
            <label className="label">
              Calculated as
              <select name="basis" className="input mt-1">
                <option value="percent">% of amount</option>
                <option value="per_qtl">Rs per quintal</option>
                <option value="flat">Rs fixed</option>
                <option value="manual">Amount typed on each slip</option>
              </select>
            </label>
            <label className="label">
              Value
              <input name="value" type="number" step="0.001" min="0" className="input mt-1 w-28" />
            </label>
            <label className="label">
              Order
              <input name="sort_order" type="number" className="input mt-1 w-20" defaultValue={95} />
            </label>
            <label className="flex items-center gap-1.5 pb-2 text-[13px] font-semibold">
              <input type="checkbox" name="entered_later" /> Entered after unloading
            </label>
            <button className="btn-primary">Add</button>
          </form>
        )}
      </Card>

      <Card title="Brokers — WhatsApp number and brokerage" className="mt-6">
        <div id="brokers" className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Broker</th>
                <th>WhatsApp mobile</th>
                <th>Brokerage ₹ per q (0 = default)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(brokers ?? []).map((b) => (
                <tr key={b.id} className={b.active ? "" : "opacity-50"}>
                  <td className="font-semibold text-ink">{b.name}</td>
                  <td>
                    <input form={`b-${b.id}`} name="phone" className="input w-44" inputMode="tel" defaultValue={b.phone ?? ""} disabled={!canBrokers} aria-label={`${b.name} mobile`} />
                    {b.phone && !waPhone(b.phone) && <span className="ml-2 text-xs text-danger">not a mobile number</span>}
                  </td>
                  <td>
                    <input form={`b-${b.id}`} name="commission" type="number" step="0.01" min="0" className="input w-28" defaultValue={b.commission_per_qtl} disabled={!canBrokers} aria-label={`${b.name} brokerage`} />
                  </td>
                  <td>
                    {canBrokers && (
                      <form id={`b-${b.id}`} action={saveBroker}>
                        <input type="hidden" name="id" value={b.id} />
                        <button className="btn-secondary py-1">Save</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
