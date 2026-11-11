import { requireModule } from "@/lib/auth";
import { Planned } from "@/components/planned";

export default async function ReportsPage() {
  await requireModule("reports");
  return (
    <Planned
      title="Reports"
      phase="Phase 4"
      items={[
        "Weighbridge / RST register, inbound QC, outbound dispatch",
        "PO and SO fulfillment, stock position and movements",
        "Processing, repairs, store ledger, audit and exceptions",
        "Excel / CSV / PDF export with totals that reconcile to source transactions",
      ]}
    />
  );
}
