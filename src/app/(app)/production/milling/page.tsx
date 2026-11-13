import { StageScreen } from "@/components/production-stage";
import type { StageSP } from "@/lib/production";

export const metadata = { title: "Milling · Production" };

export default async function Page({ searchParams }: { searchParams: Promise<StageSP> }) {
  return <StageScreen stage="milling" sp={await searchParams} />;
}
