import { redirect } from "next/navigation";
import { hasRole, requireModule } from "@/lib/auth";
import { ORDER_EDITORS } from "@/lib/roles";
import { Card, Flash, PageHeader } from "@/components/ui";
import { OrderForm } from "@/components/order-form";
import { createPurchaseOrder } from "@/lib/order-actions";
import type { Variety } from "@/lib/types";

export default async function NewPurchaseOrderPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { supabase, profile } = await requireModule("purchase-orders");
  if (!hasRole(profile, ORDER_EDITORS)) redirect("/purchase-orders");
  const { error } = await searchParams;
  const [parties, brokers, varieties] = await Promise.all([
    supabase.from("parties").select("id, name").in("kind", ["supplier", "both"]).eq("active", true).order("name"),
    supabase.from("brokers").select("id, name").eq("active", true).order("name"),
    supabase.from("varieties").select("*").eq("active", true).order("name"),
  ]);
  return (
    <>
      <PageHeader title="New purchase order" description="Purchase calculation rules (deductions, tolerance) are applied at QC posting." />
      <Flash error={error} />
      <Card className="max-w-4xl">
        <OrderForm kind="purchase" parties={parties.data ?? []} brokers={brokers.data ?? []} varieties={(varieties.data ?? []) as Variety[]} action={createPurchaseOrder} />
      </Card>
    </>
  );
}
