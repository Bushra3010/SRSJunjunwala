import { StageScreen } from "@/components/production-stage";
import type { StageSP } from "@/lib/production";

export const metadata = { title: "Mill feed · Production" };

export default async function Page({ searchParams }: { searchParams: Promise<StageSP> }) {
  return <StageScreen stage="mill_feed" sp={await searchParams} />;
}
