import { NextResponse } from "next/server";
import { apiTrace } from "@/lib/api/production";

/** GET /api/production/trace/:id/timeline — chronological events of the batch and its whole lineage. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await apiTrace((await params).id);
  return "response" in r ? r.response : NextResponse.json({ batch: r.batch, timeline: r.timeline });
}
