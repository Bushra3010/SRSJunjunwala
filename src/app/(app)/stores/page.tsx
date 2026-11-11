import { requireModule } from "@/lib/auth";
import { Planned } from "@/components/planned";

export default async function StoresPage() {
  await requireModule("stores");
  return (
    <Planned
      title="Stores & Repairs"
      phase="Phase 3"
      items={[
        "Consumables register with reorder levels and low-stock flags",
        "Receipts and issues recorded by the store room custodian",
        "Send items for repair, track mechanic, expected return, cost and overdue reminders",
      ]}
    />
  );
}
