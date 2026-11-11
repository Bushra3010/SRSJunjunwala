import { requireModule } from "@/lib/auth";
import { Planned } from "@/components/planned";

export default async function ProcessingPage() {
  await requireModule("processing");
  return (
    <Planned
      title="Processing"
      phase="Phase 3"
      items={[
        "Plant floor status for boiler, soaking, drying and milling with equipment, lot and last update",
        "Report fault with severity, photo and notifications",
        "Lot details: linked receipt, processing history, estimated vs confirmed output",
        "Sensor readings (boiler pressure, dryer temperature) if feasible, labelled with data freshness",
      ]}
    />
  );
}
