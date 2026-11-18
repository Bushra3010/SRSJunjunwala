import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, House, Search, Truck } from "lucide-react";
import { Flash } from "@/components/ui";
import { hasRole, requireModule } from "@/lib/auth";
import { loadMoistureParams } from "@/lib/slips-server";
import { Clock, OnlineStatus } from "@/app/floor/floor-client";
import { openPurchaseQc, savePurchaseQc } from "./actions";
import { PurchaseForm, type Sauda } from "./purchase-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase QC · SRS Factory" };

type SP = { q?: string; qc?: string; error?: string; notice?: string };
type Hit = {
  ticket_id: string;
  rst: number;
  vehicle_no: string;
  vehicle_type: string | null;
  gross_kg: number | null;
  tare_kg: number | null;
  net_kg: number | null;
  weighed_at: string;
  ticket_status: string;
  qc_id: string | null;
  qc_status: string | null;
  po_no: string | null;
  party: string | null;
};

const kgText = (v: number | null | undefined) => (v == null ? "—" : `${Number(v).toLocaleString("en-IN")} kg`);
const STATUS_TEXT: Record<string, string> = {
  draft: "QC draft",
  submitted: "Waiting for posting",
  posted: "Posted",
};

/** Phone screen for the purchase QC man: find the truck by RST / sauda, enter moisture, bags, claim, location. */
export default async function PurchaseQcPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("qc");
  const canEnter = hasRole(profile, ["admin", "qc_unloading", "qc_head"]);

  let body: React.ReactNode;
  if (sp.qc) {
    const { data: qc } = await supabase.from("qc_inbound").select("*, weighbridge_tickets(*)").eq("id", sp.qc).maybeSingle();
    if (!qc) {
      body = <p className="rounded-2xl bg-white p-4 text-[15px]">This QC entry was not found.</p>;
    } else {
      const t = qc.weighbridge_tickets as Hit & { id: string; status: string };
      const editable = qc.status === "draft" && (qc.qc_user === profile.id || hasRole(profile, ["admin", "qc_head"]));
      const { data: line } = await supabase.from("qc_inbound_lines").select("*").eq("qc_id", qc.id).order("line_no").limit(1).maybeSingle();
      const { data: slip } = await supabase.from("purchase_slips").select("id, slip_no").eq("qc_id", qc.id).neq("status", "cancelled").maybeSingle();
      let form: React.ReactNode = null;
      if (editable) {
        const [parties, brokers, locations, varieties, pos, moisture] = await Promise.all([
          supabase.from("parties").select("id, name").in("kind", ["supplier", "both"]).eq("active", true).order("name"),
          supabase.from("brokers").select("id, name").eq("active", true).order("name"),
          supabase.from("locations").select("id, name").eq("active", true).order("name"),
          supabase.from("varieties").select("id, name").eq("active", true).order("name"),
          supabase
            .from("purchase_orders")
            .select("po_no, supplier_id, broker_id, parties(name), po_lines(id, line_no, variety_id, rate_per_qtl, varieties(name))")
            .eq("status", "open")
            .order("created_at", { ascending: false })
            .limit(200),
          loadMoistureParams(supabase),
        ]);
        type PoRow = {
          po_no: string;
          supplier_id: string;
          broker_id: string | null;
          parties: { name: string } | null;
          po_lines: { id: string; line_no: number; variety_id: string; rate_per_qtl: number | null; varieties: { name: string } | null }[];
        };
        const saudas: Sauda[] = ((pos.data ?? []) as unknown as PoRow[]).flatMap((p) =>
          p.po_lines.map((l) => ({
            po_line_id: l.id,
            label: `${p.po_no} · ${p.parties?.name ?? ""} · ${l.varieties?.name ?? ""}${l.rate_per_qtl != null ? ` · ₹${l.rate_per_qtl}/q` : ""}`,
            supplier_id: p.supplier_id,
            broker_id: p.broker_id,
            variety_id: l.variety_id,
            rate: l.rate_per_qtl == null ? null : Number(l.rate_per_qtl),
          })),
        );
        form = (
          <PurchaseForm
            id={qc.id}
            action={savePurchaseQc}
            saudas={saudas}
            parties={parties.data ?? []}
            brokers={brokers.data ?? []}
            locations={locations.data ?? []}
            varieties={varieties.data ?? []}
            moisture={moisture}
            initial={{
              supplier_id: qc.supplier_id ?? "",
              broker_id: qc.broker_id ?? "",
              location_id: qc.location_id ?? "",
              variety_id: line?.variety_id ?? "",
              po_line_id: line?.po_line_id ?? "",
              moisture_pct: line ? String(line.moisture_pct) : "",
              bag_status: qc.bag_status === "returned" ? "returned" : "received",
              passed: line ? String(line.sacks_received - line.rejected_bags - line.returned_sacks) : "",
              rejected: line ? String(line.rejected_bags) : "0",
              claim_details: qc.claim_details ?? "",
              claim_amount: Number(qc.claim_amount) ? String(qc.claim_amount) : "",
              notes: qc.notes ?? "",
            }}
          />
        );
      }
      body = (
        <div className="space-y-5">
          <Link href="/purchase-qc" className="inline-flex min-h-10 items-center gap-1 text-[14px] font-bold text-[#334155]">
            <ArrowLeft className="size-4" /> Find another truck
          </Link>
          <section className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[12px] font-bold tracking-wide text-[#475569] uppercase">RST {t.rst}</p>
                <p className="text-[24px] font-extrabold">{t.vehicle_no}</p>
                <p className="text-[14px] text-[#475569]">{t.vehicle_type || "Vehicle type not recorded"}</p>
              </div>
              <span className="rounded-full bg-[#eef1f6] px-3 py-1 text-[12px] font-bold text-[#13284b]">{STATUS_TEXT[qc.status] ?? qc.status}</span>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["Gross", t.gross_kg],
                ["Tare", t.tare_kg],
                ["Net", t.net_kg],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl bg-[#f6f7fa] p-2">
                  <dt className="text-[11px] font-bold text-[#475569] uppercase">{k}</dt>
                  <dd className="text-[15px] font-extrabold tabular-nums">{kgText(v as number | null)}</dd>
                </div>
              ))}
            </dl>
            {slip && (
              <p className="mt-3 text-[14px] font-semibold text-[#14632f]">
                Purchase slip {slip.slip_no} is ready{hasRole(profile, ["admin", "accountant", "management", "qc_head"]) ? " — " : "."}
                {hasRole(profile, ["admin", "accountant", "management", "qc_head"]) && (
                  <Link className="underline" href={`/purchase-slips/${slip.id}`}>
                    open slip
                  </Link>
                )}
              </p>
            )}
          </section>
          {form ?? (
            <p className="rounded-2xl bg-white p-4 text-[15px] text-[#475569] shadow-sm">
              {qc.status === "draft"
                ? "This entry belongs to another QC operator."
                : qc.status === "posted"
                  ? "This entry is posted and can no longer be changed here. If something is wrong, the QC head can reverse it."
                  : "This entry is sent for posting. If something is wrong, the QC head can return it to you."}
            </p>
          )}
        </div>
      );
    }
  } else {
    const { data } = await supabase.rpc("purchase_qc_search", { p_query: sp.q ?? "" });
    const hits = (data ?? []) as Hit[];
    body = (
      <div className="space-y-4">
        <section className="space-y-2">
          <h2 className="text-[16px] font-extrabold">
            <span className="mr-1.5 text-[#c08a24]">01.</span>RST search
          </h2>
          <form className="flex gap-2" role="search">
            <input
              name="q"
              defaultValue={sp.q ?? ""}
              inputMode="search"
              placeholder="Search RST / sauda / vehicle number…"
              className="input min-h-12 rounded-xl text-[16px]"
              aria-label="RST, sauda or vehicle number"
            />
            <button className="flex min-h-12 items-center gap-1 rounded-xl bg-[#13284b] px-4 text-[15px] font-bold text-white">
              <Search className="size-4" /> Find
            </button>
          </form>
          <p className="text-[13px] text-[#475569]">Search and select the purchase truck.</p>
        </section>
        {hits.length === 0 && <p className="rounded-2xl bg-white p-4 text-[15px] text-[#475569]">No trucks found{sp.q ? ` for “${sp.q}”` : " waiting for QC"}.</p>}
        <ul className="space-y-2">
          {hits.map((h) => (
            <li key={h.ticket_id}>
              <form action={openPurchaseQc}>
                <input type="hidden" name="ticket_id" value={h.ticket_id} />
                <input type="hidden" name="q" value={sp.q ?? ""} />
                <button
                  disabled={!canEnter}
                  className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-left shadow-sm ring-[#c08a24] hover:ring-2 disabled:opacity-60"
                >
                  <Truck className="size-8 shrink-0 text-[#13284b]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold text-[#475569]">RST {h.rst}</span>
                    <span className="block text-[18px] font-extrabold">{h.vehicle_no}</span>
                    <span className="block text-[13px] text-[#475569]">
                      {h.vehicle_type || "Type not recorded"} · Gross {kgText(h.gross_kg)}
                      {h.party ? ` · ${h.party}` : ""}
                    </span>
                  </span>
                  <span className="rounded-full bg-[#eef1f6] px-2.5 py-1 text-[11px] font-bold text-[#13284b]">
                    {h.qc_status ? (STATUS_TEXT[h.qc_status] ?? h.qc_status) : "New entry"}
                  </span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#eef1f6] pb-10 text-[#0f1f3d]">
      <header className="sticky top-0 z-20 border-b border-[#d7dde8] bg-[#f8f6f1]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
          <Link href="/qc" className="flex shrink-0 items-center gap-2" aria-label="Back to the ERP">
            <Image src="/logo-transparent.png" alt="" width={44} height={44} className="size-10 shrink-0 object-contain" />
          </Link>
          <div className="min-w-0 leading-tight">
            <h1 className="text-[18px] font-extrabold">Purchase QC</h1>
            <p className="text-[11px] font-bold tracking-wide text-[#475569] uppercase">Quality control · purchase entry</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:block">
              <Clock />
            </span>
            <OnlineStatus />
            <Link href="/qc" className="inline-flex items-center gap-1 rounded-full border border-[#d7dde8] bg-white px-2.5 py-1 text-[12px] font-bold text-[#334155]">
              <House className="size-3.5" /> ERP
            </Link>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pt-4">
        <Flash error={sp.error} notice={sp.notice} />
        {body}
      </main>
    </div>
  );
}
