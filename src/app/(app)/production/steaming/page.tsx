import { StageScreen } from "@/components/production-stage";
import type { StageSP } from "@/lib/production";

export const metadata = { title: "Steaming lots · Production" };

export default async function Page({ searchParams }: { searchParams: Promise<StageSP> }) {
  return <StageScreen stage="steaming" sp={await searchParams} />;
}
