import { StageScreen } from "@/components/production-stage";
import type { StageSP } from "@/lib/production";

export const metadata = { title: "Dryers · Production" };

export default async function Page({ searchParams }: { searchParams: Promise<StageSP> }) {
  return <StageScreen stage="drying" sp={await searchParams} />;
}
