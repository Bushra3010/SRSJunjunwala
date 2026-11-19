import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, MessageCircle, Send } from "lucide-react";
import { Card, Flash, Note, PageHeader } from "@/components/ui";
import { AdminDelete } from "@/components/admin-delete";
import { deleteSlip } from "@/lib/admin-delete-actions";
import { PrintButton } from "@/components/print-button";
import { SlipDocument } from "@/components/slip-document";
import { requireModule } from "@/lib/auth";
import { ACCOUNT_EDITORS, SLIP_SENDERS, canAccess } from "@/lib/roles";
import { dateTime, todayIST } from "@/lib/format";
import { SLIP_SELECT, STATUS_TONE, rs, waPhone, type Slip, type SlipLine } from "@/lib/slips";
import { slipLink } from "@/lib/slips-server";
import { whatsappConfigured } from "@/lib/whatsapp";
import { cancelSlip, enterDeduction, finalizeSlip, openWhatsApp, paySlip, rebuildSlip, saveSlip, sendSlipAuto } from "../actions";
import { SlipEditor } from "../slip-editor";

export const metadata = { title: "Purchase slip · SRS Factory" };

const MODES = ["RTGS", "NEFT", "IMPS", "UPI", "Cheque", "Cash", "Other"];
const SEND_TEXT: Record<string, string> = { opened: "WhatsApp opened", sent: "Sent", failed: "Failed", not_configured: "Not set up" };

export default async function SlipPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; notice?: string; edit?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("purchase-slips");
  const canEdit = ACCOUNT_EDITORS.includes(profile.role);
  const canSend = SLIP_SENDERS.includes(profile.role);

  const [{ data: slipRow }, { data: lineRows }, { data: sends }, { data: types }] = await Promise.all([
    supabase.from("purchase_slips").select(SLIP_SELECT + ", params, qc_id").eq("id", id).maybeSingle(),
    supabase.from("purchase_slip_lines").select("*").eq("slip_id", id).order("sort_order"),
    supabase.from("purchase_slip_sends").select("*").eq("slip_id", id).order("sent_at", { ascending: false }).limit(20),
    supabase.from("purchase_deduction_types").select("code, entered_later, entry_roles"),
  ]);
  if (!slipRow) notFound();
  const slip = slipRow as unknown as Slip & { params: Record<string, never> };
  const lines = (lineRows ?? []) as SlipLine[];
  const link = await slipLink(slip.share_token);
  const brokerPhone = waPhone(slip.brokers?.phone);

  // Later-entry deductions this person may fill in (Khad).
  const canEnter = (l: SlipLine) => {
    const t = (types ?? []).find((x) => x.code === l.code);
    if (slip.status === "cancelled" || slip.status === "paid") return false;
    if (l.basis === "dhalta") return false; // set by choosing received / returned in Edit slip
    if (canEdit) return !!t?.entered_later || l.pending;
    return slip.status === "draft" && !!t?.entered_later && (t.entry_roles as string[]).includes(profile.role);
  };
  const laterLines = lines.filter((l) => canEnter(l));

  if (sp.edit && canEdit && (slip.status === "draft" || slip.status === "final")) {
    const [parties, brokers, locations] = await Promise.all([
      supabase.from("parties").select("id, name").in("kind", ["supplier", "both"]).order("name"),
      supabase.from("brokers").select("id, name").order("name"),
      supabase.from("locations").select("id, name").order("name"),
    ]);
    return (
      <>
        <PageHeader title={`Edit ${slip.slip_no}`} description={`RST ${slip.rst} · ${slip.vehicle_no}`} crumbs={[{ label: "Purchase slips", href: "/purchase-slips" }, { label: slip.slip_no, href: `/purchase-slips/${id}` }]} />
        <Flash error={sp.error} notice={sp.notice} />
        {slip.status !== "draft" && (
          <div className="mb-4">
            <Note>This slip is {slip.status}. Saving makes revision {slip.revision + 1}; the old figures stay in the audit trail.</Note>
          </div>
        )}
        <Card title="Slip figures">
          <div className="p-4">
            <SlipEditor slip={slip} lines={lines} parties={parties.data ?? []} brokers={brokers.data ?? []} locations={locations.data ?? []} action={saveSlip} />
          </div>
        </Card>
      </>
    );
  }

  const banks = canEdit && slip.status === "final" ? ((await supabase.from("bank_accounts").select("id, name").eq("active", true).order("name")).data ?? []) : [];

  return (
    <>
      <PageHeader
        title={`Purchase slip ${slip.slip_no}`}
        description={`RST ${slip.rst} · ${slip.vehicle_no} · ${slip.parties?.name ?? "party not set"}`}
        crumbs={[{ label: "Purchase slips", href: "/purchase-slips" }]}
        actions={
          <>
            <span className={`rounded-full px-3 py-1 text-[12px] font-bold capitalize ${STATUS_TONE[slip.status]}`}>
              {slip.status}
              {slip.revision > 0 ? ` · rev ${slip.revision}` : ""}
            </span>
            <PrintButton />
            {canEdit && (slip.status === "draft" || slip.status === "final") && (
              <Link href={`/purchase-slips/${id}?edit=1`} className="btn-secondary">
                Edit slip
              </Link>
            )}
          </>
        }
      />
      <div className="no-print">
        <Flash error={sp.error} notice={sp.notice} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="card overflow-hidden">
          <SlipDocument slip={slip} lines={lines} />
        </div>

        <div className="no-print space-y-5">
          {laterLines.length > 0 && (
            <Card tone="#c08a24" title="Entered after unloading">
              <div className="space-y-3 p-4">
                {laterLines.map((l) => (
                  <form key={l.id} action={enterDeduction} className="grid grid-cols-[1fr_auto] items-end gap-2">
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="line_id" value={l.id} />
                    <label className="label">
                      {l.label} {l.basis === "percent" ? "%" : l.basis === "flat" ? "₹" : l.basis === "per_qtl" ? "₹ per q" : ""}
                      {l.pending && <span className="ml-1 rounded bg-[#fdecec] px-1.5 text-[11px] text-[#a11a1a]">pending</span>}
                      <input name="rate" type="number" min="0" step="0.001" required className="input mt-1" defaultValue={l.rate ?? ""} placeholder="0 if none" />
                    </label>
                    <button className="btn-accent">Save</button>
                  </form>
                ))}
                <p className="text-xs text-muted">Who may fill these in is set per deduction in Slip parameters.</p>
              </div>
            </Card>
          )}

          {slip.status === "draft" && slip.rate_per_qtl == null && (
            <Note>
              No rate per quintal yet (the truck had no sauda rate).{" "}
              {canEdit ? (
                <Link href={`/purchase-slips/${id}?edit=1`} className="font-semibold underline">
                  Enter the rate
                </Link>
              ) : (
                "The accountant enters it"
              )}
              {slip.bag_status == null ? " and choose whether the bags were received or returned." : "."}
            </Note>
          )}
          {canEdit && slip.status === "draft" && slip.rate_per_qtl != null && (
            <Card title="Finalise">
              <form action={finalizeSlip} className="space-y-3 p-4">
                <input type="hidden" name="id" value={id} />
                <p className="text-[13px] text-muted">Check the figures, then finalise. After that, changes need a reason and are kept as revisions.</p>
                <button className="btn-primary w-full">Finalise slip · ₹{rs(slip.net_payable)}</button>
              </form>
            </Card>
          )}

          {canEdit && slip.status === "paid" && (
            <Note>Paid. To change this slip, cancel its payment under Accounts → Payments first; the slip then opens again.</Note>
          )}
          {canEdit && slip.status === "final" && (
            <Card tone="#1f6b32" title="Record payment">
              <form action={paySlip} className="grid gap-3 p-4">
                <input type="hidden" name="id" value={id} />
                <input type="hidden" name="request_id" value={randomUUID()} />
                <p className="text-[14px]">
                  Pay <b>₹{rs(slip.net_payable)}</b> to <b>{slip.parties?.name}</b>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="label">
                    Mode
                    <select name="mode" className="input mt-1" defaultValue="RTGS">
                      {MODES.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="label">
                    Date
                    <input name="paid_on" type="date" className="input mt-1" defaultValue={todayIST()} max={todayIST()} required />
                  </label>
                </div>
                <label className="label">
                  Bank account
                  <select name="bank_account_id" className="input mt-1">
                    <option value="">— (cash)</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  UTR / cheque no.
                  <input name="reference" className="input mt-1" />
                </label>
                <button className="btn-accent">Record payment</button>
                <p className="text-xs text-muted">The payment also appears under Accounts → Payments and goes to Tally.</p>
              </form>
            </Card>
          )}

          {canSend && slip.status !== "cancelled" && (
            <Card title="Send to broker">
              <div className="space-y-3 p-4">
                <p className="text-[13px]">
                  {slip.brokers ? (
                    <>
                      {slip.brokers.name} · {brokerPhone ? `+${brokerPhone}` : <span className="text-danger">no mobile number</span>}{" "}
                      <Link href="/purchase-slips/settings#brokers" className="text-accent underline">
                        change
                      </Link>
                    </>
                  ) : (
                    "No broker on this slip — type the number."
                  )}
                </p>
                <form action={openWhatsApp} target="_blank" className="flex gap-2">
                  <input type="hidden" name="id" value={id} />
                  <input name="phone" className="input" inputMode="tel" defaultValue={brokerPhone ? brokerPhone.slice(2) : ""} placeholder="Mobile number" aria-label="WhatsApp number" />
                  <button className="btn-accent shrink-0">
                    <MessageCircle className="size-4" /> WhatsApp
                  </button>
                </form>
                <form action={sendSlipAuto}>
                  <input type="hidden" name="id" value={id} />
                  <button className="btn-secondary w-full" disabled={!whatsappConfigured() || !brokerPhone}>
                    <Send className="size-4" /> Send automatically now
                  </button>
                </form>
                {!whatsappConfigured() && <p className="text-xs text-muted">Automatic sending needs the WhatsApp Business API to be connected (see Slip parameters).</p>}
                <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent underline">
                  <ExternalLink className="size-3.5" /> Slip link the broker receives
                </a>
                {(sends ?? []).length > 0 && (
                  <ul className="divide-y divide-line border-t border-line pt-2 text-[12px]">
                    {(sends ?? []).map((s) => (
                      <li key={s.id} className="py-1.5">
                        <b>{s.channel === "whatsapp_auto" ? "Automatic" : "Manual"}</b> · {SEND_TEXT[s.status] ?? s.status}
                        {s.to_phone ? ` · +${s.to_phone}` : ""} · {dateTime(s.sent_at)}
                        {s.detail && <span className="block text-muted">{s.detail}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}

          {canEdit && slip.status !== "cancelled" && slip.status !== "paid" && (
            <details className="card p-4">
              <summary className="cursor-pointer text-[13px] font-semibold text-danger">Cancel this slip</summary>
              <form action={cancelSlip} className="mt-3 space-y-2">
                <input type="hidden" name="id" value={id} />
                <input name="reason" required className="input" placeholder="Reason" />
                <button className="btn-danger">Cancel slip</button>
              </form>
            </details>
          )}
          {profile.role === "admin" && (
            <AdminDelete
              action={deleteSlip}
              id={id}
              label={slip.slip_no}
              what={`this slip${slip.payment_id ? " and its payment" : ""}. The QC and the truck stay, and the slip can be built again from Purchase slips`}
              back="/purchase-slips"
              here={`/purchase-slips/${id}`}
            />
          )}
          {canEdit && slip.status === "cancelled" && (
            <form action={rebuildSlip} className="card space-y-2 p-4">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="qc_id" value={slip.qc_id} />
              <p className="text-[13px] text-muted">Cancelled: {slip.cancel_reason}</p>
              <button className="btn-secondary">Build a new slip from the QC</button>
            </form>
          )}
          <p className="text-xs text-muted">
            {canAccess(profile.role, "qc") && (
              <>
                <Link href={`/qc/inbound/${slip.qc_id}`} className="underline">
                  QC record
                </Link>{" "}
                ·{" "}
              </>
            )}
            made {dateTime(slip.created_at)} · updated {dateTime(slip.updated_at)}
          </p>
        </div>
      </div>
    </>
  );
}
