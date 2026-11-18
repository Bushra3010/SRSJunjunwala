import Link from "next/link";
import { redirect } from "next/navigation";
import { requireModule, hasRole } from "@/lib/auth";
import { TICKET_CAPTURERS } from "@/lib/roles";
import { Card, Flash, Note, PageHeader } from "@/components/ui";
import { captureTicket } from "../actions";

export default async function CaptureTicketPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { profile } = await requireModule("weighbridge");
  if (!hasRole(profile, TICKET_CAPTURERS)) redirect("/weighbridge");
  const { error } = await searchParams;

  return (
    <>
      <PageHeader title="Capture ticket" description="Enter the weighbridge slip exactly as printed. Party and broker are added later at QC." />
      <Flash error={error} />
      <Card className="max-w-2xl">
        <form action={captureTicket} className="grid gap-4 p-5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="rst">RST number *</label>
            <input id="rst" name="rst" type="number" min="1" step="1" inputMode="numeric" className="input" required autoFocus />
          </div>
          <div>
            <label className="label" htmlFor="vehicle_no">Vehicle number *</label>
            <input id="vehicle_no" name="vehicle_no" className="input uppercase" placeholder="KA 51 AB 7831" required />
          </div>
          <div>
            <label className="label" htmlFor="direction">Movement *</label>
            <select id="direction" name="direction" className="input" required defaultValue="inbound">
              <option value="inbound">Inbound (purchase / unloading)</option>
              <option value="outbound">Outbound (sales / loading)</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="weighed_at">Weighed at</label>
            <input id="weighed_at" name="weighed_at" type="datetime-local" className="input" />
            <p className="mt-1 text-xs text-slate-500">Leave empty for now.</p>
          </div>
          <div>
            <label className="label" htmlFor="gross_kg">Gross weight (kg)</label>
            <input id="gross_kg" name="gross_kg" type="number" min="0" step="0.01" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="tare_kg">Tare weight (kg)</label>
            <input id="tare_kg" name="tare_kg" type="number" min="0" step="0.01" className="input" />
          </div>
          <div className="sm:col-span-2">
            <Note>
              Inbound trucks are usually weighed gross first; outbound trucks tare first. Enter what is on the slip — the second weight
              can be added from the ticket later.
            </Note>
          </div>
          <div>
            <label className="label" htmlFor="ticket_ref">Original ticket reference</label>
            <input id="ticket_ref" name="ticket_ref" className="input" placeholder="As printed on the slip" />
          </div>
          <div>
            <label className="label" htmlFor="vehicle_type">Vehicle type</label>
            <input id="vehicle_type" name="vehicle_type" className="input" list="vehicle-types" placeholder="Truck, tractor trolley…" />
            <datalist id="vehicle-types">
              {["Truck", "Tractor trolley", "DCM / Canter", "Pickup", "Trailer"].map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="source_payload">SMS text / remarks</label>
            <textarea id="source_payload" name="source_payload" rows={2} className="input" placeholder="Paste the weighbridge SMS if available" />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <button className="btn-primary">Save ticket</button>
            <Link href="/weighbridge" className="btn-secondary">
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
