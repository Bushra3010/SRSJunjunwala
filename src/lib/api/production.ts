import "server-only";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findBatch, traceBatch, type Batch } from "@/lib/production";

/** Shared guard for /api/production/*: signed-in, active user who can see production (RLS also applies). */
export async function apiBatch(id: string): Promise<{ batch: Batch } | { response: NextResponse }> {
  const session = await getSession();
  if (!session?.profile?.active) return { response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  const batch = await findBatch(decodeURIComponent(id));
  if (!batch) return { response: NextResponse.json({ error: "Batch not found or not visible to your role" }, { status: 404 }) };
  return { batch };
}

export async function apiTrace(id: string) {
  const r = await apiBatch(id);
  if ("response" in r) return r;
  const t = await traceBatch(r.batch.id);
  if (t.error) return { response: NextResponse.json({ error: t.error.message }, { status: 500 }) };
  const brief = (bid: string) => {
    const b = t.batches.get(bid);
    return b && { id: b.id, batch_no: b.batch_no, stage: b.stage, status: b.status, input_kg: b.input_kg, output_kg: b.output_kg, started_at: b.started_at, ended_at: b.ended_at };
  };
  return {
    batch: r.batch,
    ancestors: t.ancestors.map((e) => ({ ...e, batch: brief(e.batch_id), via: brief(e.child_id!) })),
    descendants: t.descendants.map((e) => ({ ...e, batch: brief(e.batch_id), from: brief(e.parent_id!) })),
    timeline: t.timeline,
    origin: [...t.batches.values()].filter((b) => b.stage === "receipt" && t.ancestors.some((a) => a.batch_id === b.id)).map((b) => ({ batch_no: b.batch_no, ...b.source_snapshot })),
  };
}
