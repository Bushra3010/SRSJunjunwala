import { NextResponse } from "next/server";
import { apiTrace } from "@/lib/api/production";

/** GET /api/production/trace/:id — full genealogy (backward + forward + timeline). :id is a uuid or batch number. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await apiTrace((await params).id);
  return "response" in r ? r.response : NextResponse.json(r);
}
