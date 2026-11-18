import "server-only";
import { headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MoistureParams } from "@/lib/slips";

/** Current moisture parameters (for previews on the phone form and the settings page). */
export async function loadMoistureParams(supabase: SupabaseClient): Promise<MoistureParams> {
  const [{ data: settings }, { data: slabs }] = await Promise.all([
    supabase.from("calc_settings").select("key, value").in("key", ["slip_moisture_pass_pct", "slip_moisture_progressive"]),
    supabase.from("moisture_slabs").select("upto_pct, per_point").order("upto_pct", { nullsFirst: false }),
  ]);
  const get = (k: string, d: number) => Number(settings?.find((s) => s.key === k)?.value ?? d);
  return {
    passPct: get("slip_moisture_pass_pct", 16),
    progressive: get("slip_moisture_progressive", 1) === 1,
    slabs: (slabs ?? []).map((s) => ({ upto: s.upto_pct === null ? null : Number(s.upto_pct), perPoint: Number(s.per_point) })),
  };
}

/** Public link to a slip (opens without signing in; the token is long and random). */
export async function slipLink(token: string) {
  const base = process.env.NEXT_PUBLIC_SITE_URL;
  if (base) return `${base.replace(/\/$/, "")}/slip/${token}`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/slip/${token}`;
}
