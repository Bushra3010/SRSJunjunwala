import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { SlipDocument } from "@/components/slip-document";
import type { Slip, SlipLine } from "@/lib/slips";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchase slip", robots: { index: false, follow: false } };

/** The slip link sent to the broker on WhatsApp. Opens without signing in; read-only. */
export default async function PublicSlipPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[0-9a-f]{64}$/.test(token)) notFound();
  const supabase = await createClient();
  const { data } = await supabase.rpc("purchase_slip_by_token", { p_token: token });
  if (!data) notFound();
  const { slip, lines } = data as { slip: Slip; lines: SlipLine[] };
  return (
    <main className="min-h-dvh bg-[#eef1f6] px-3 py-6">
      <div className="mx-auto max-w-[720px] space-y-3">
        <div className="no-print flex justify-end">
          <PrintButton className="btn-primary" label="Print / save as PDF" />
        </div>
        <div className="card overflow-hidden">
          <SlipDocument slip={slip} lines={lines} />
        </div>
      </div>
    </main>
  );
}
