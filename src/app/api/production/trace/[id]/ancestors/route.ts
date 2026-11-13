import { NextResponse } from "next/server";
import { apiTrace } from "@/lib/api/production";

/** GET /api/production/trace/:id/ancestors — backward trace to the original truck receipt(s). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await apiTrace((await params).id);
  return "response" in r ? r.response : NextResponse.json({ batch: r.batch, origin: r.origin, ancestors: r.ancestors });
}
