import { redirect } from "next/navigation";
import { hasRole, requireModule } from "@/lib/auth";
import { ORDER_EDITORS } from "@/lib/roles";
import { Card, Flash, PageHeader } from "@/components/ui";
import { OrderForm } from "@/components/order-form";
import { createSalesOrder } from "@/lib/order-actions";
import type { Variety } from "@/lib/types";

export default async function NewSalesOrderPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { supabase, profile } = await requireModule("sales-orders");
  if (!hasRole(profile, ORDER_EDITORS)) redirect("/sales-orders");
  const { error } = await searchParams;
  const [parties, varieties] = await Promise.all([
    supabase.from("parties").select("id, name").in("kind", ["customer", "both"]).eq("active", true).order("name"),
    supabase.from("varieties").select("*").eq("active", true).order("name"),
  ]);
  return (
    <>
      <PageHeader title="New sales order" />
      <Flash error={error} />
      <Card className="max-w-4xl">
        <OrderForm kind="sales" parties={parties.data ?? []} varieties={(varieties.data ?? []) as Variety[]} action={createSalesOrder} />
      </Card>
    </>
  );
}
