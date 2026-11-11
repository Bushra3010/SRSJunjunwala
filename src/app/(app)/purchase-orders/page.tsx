import { OrdersView } from "@/components/orders-view";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <OrdersView kind="purchase" sp={await searchParams} />;
}
