import { NextResponse } from "next/server";
import { apiTrace } from "@/lib/api/production";

/** GET /api/production/trace/:id/descendants — forward trace to every resulting batch and rice grade. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await apiTrace((await params).id);
  return "response" in r ? r.response : NextResponse.json({ batch: r.batch, descendants: r.descendants });
}
