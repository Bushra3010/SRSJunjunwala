import { StageScreen } from "@/components/production-stage";
import type { StageSP } from "@/lib/production";

export const metadata = { title: "Pre-cleaning · Production" };

export default async function Page({ searchParams }: { searchParams: Promise<StageSP> }) {
  return <StageScreen stage="precleaning" sp={await searchParams} />;
}
