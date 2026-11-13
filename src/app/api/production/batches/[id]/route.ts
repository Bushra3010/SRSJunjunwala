import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { apiBatch } from "@/lib/api/production";

/** GET /api/production/batches/:id — one batch with inputs, outputs, milling steps, faults, events and quantity ledger. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const r = await apiBatch((await params).id);
  if ("response" in r) return r.response;
  const supabase = await createClient();
  const id = r.batch.id;
  const [inputs, outputs, steps, faults, events, ledger, balance] = await Promise.all([
    supabase.from("batch_inputs").select("parent_id, qty_kg, created_at, parent:production_batches!batch_inputs_parent_id_fkey(batch_no, stage)").eq("child_id", id),
    supabase.from("batch_inputs").select("child_id, qty_kg, created_at, child:production_batches!batch_inputs_child_id_fkey(batch_no, stage, status)").eq("parent_id", id),
    supabase.from("milling_stage_events").select("step, step_no, started_at, ended_at").eq("batch_id", id).order("step_no"),
    supabase.from("production_faults").select("*").eq("batch_id", id),
    supabase.from("batch_events").select("*").eq("batch_id", id).order("at"),
    supabase.from("batch_quantity_ledger").select("*").eq("batch_id", id).order("id"),
    supabase.from("production_batch_balances").select("consumed_kg, available_kg").eq("id", id).single(),
  ]);
  return NextResponse.json({
    batch: r.batch,
    balance: balance.data,
    inputs: inputs.data,
    outputs: outputs.data,
    milling_steps: steps.data,
    faults: faults.data,
    events: events.data,
    quantity_ledger: ledger.data,
  });
}
