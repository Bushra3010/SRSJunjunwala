"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { optStr, str } from "@/lib/actions";
import { errorMessage } from "@/lib/format";

/** Bilingual (Hindi / English) messages for the mill floor screen. */
const HINDI_ERRORS: [RegExp, string][] = [
  [/NOTHING_IN_FEED_TANK/, "इस फीड टैंक में धान नहीं है"],
  [/PERMISSION_DENIED|not allowed/i, "आपकी भूमिका को यह कार्य करने की अनुमति नहीं है"],
  [/Enter the output/i, "चावल का आउटपुट (क्विंटल) भरें"],
  [/Output must be greater/i, "आउटपुट शून्य से अधिक होना चाहिए"],
  [/cannot exceed the input/i, "आउटपुट इनपुट से अधिक नहीं हो सकता"],
  [/only running batches/i, "यह बैच पहले ही बंद हो चुका है"],
  [/Select the machinery/i, "मशीनरी चुनें"],
  [/Enter the fault details/i, "फॉल्ट की जानकारी लिखें"],
  [/rice output in quintals/i, "चावल का आउटपुट (क्विंटल) भरें"],
  [/before the fault started/i, "ठीक होने का समय फॉल्ट से पहले नहीं हो सकता"],
  [/already resolved/i, "यह फॉल्ट पहले ही ठीक हो चुका है"],
  [/in the future/i, "समय भविष्य का नहीं हो सकता"],
  [/MULTI_INPUT/, "एक से अधिक फीड टैंक मिलाने के लिए प्रोडक्शन मैनेजर की अनुमति चाहिए"],
];

function backPath(fd: FormData) {
  const p = str(fd, "back");
  return p.startsWith("/mill") || p.startsWith("/floor") ? p : "/mill";
}

function go(path: string, flash: { error?: string; notice?: string }): never {
  const url = new URL(path, "http://x");
  url.searchParams.delete("error");
  url.searchParams.delete("notice");
  if (flash.error) url.searchParams.set("error", flash.error);
  if (flash.notice) url.searchParams.set("notice", flash.notice);
  revalidatePath("/production", "layout");
  revalidatePath("/mill");
  redirect(url.pathname + url.search);
}

function fail(path: string, err: { message?: string } | string): never {
  const en = typeof err === "string" ? err : errorMessage(err);
  const raw = typeof err === "string" ? err : (err.message ?? "");
  if (path.startsWith("/floor")) go(path, { error: en });
  const hi = HINDI_ERRORS.find(([re]) => re.test(raw) || re.test(en))?.[1] ?? "कार्य पूरा नहीं हुआ";
  go(path, { error: `${hi} / ${en}` });
}

/** Start milling with all the paddy waiting in one feed tank. */
export async function millStart(fd: FormData) {
  const path = backPath(fd);
  const n = str(fd, "tank_no");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_milling_from_dryer", {
    p_dryer_no: Number(n),
    p_line: str(fd, "line_id"),
    p_started_at: null,
    p_request: optStr(fd, "request_id"),
    p_remarks: null,
  });
  if (error) fail(path, error);
  const { data: b } = await supabase.from("production_batches").select("batch_no").eq("id", data).single();
  go(path, { notice: `फीड टैंक ${n} से मिलिंग शुरू (${b?.batch_no}) / Milling started from Feed Tank ${n} (${b?.batch_no})` });
}

/** Stop milling: the rice output (quintals) is required. */
export async function millStop(fd: FormData) {
  const path = backPath(fd);
  const raw = str(fd, "output_q");
  const q = Number(raw);
  if (!raw || !Number.isFinite(q) || q <= 0) fail(path, "Enter the rice output in quintals");
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_production_batch", {
    p_id: str(fd, "id"),
    p_output_kg: Math.round(q * 100 * 100) / 100,
    p_rejected_kg: 0,
    p_moisture_pct: null,
    p_ended_at: null,
    p_remarks: null,
  });
  if (error) fail(path, error);
  go(path, { notice: `${str(fd, "batch_no")} मिलिंग बंद, आउटपुट ${q} क्विंटल / Milling stopped, output ${q} q` });
}

/** Fault report for a mill machine. The machine is kept at the start of the description. */
export async function millFault(fd: FormData) {
  const path = backPath(fd);
  const machine = str(fd, "machine");
  const details = str(fd, "details");
  if (!machine) fail(path, "Select the machinery");
  if (!details) fail(path, "Enter the fault details");
  const supabase = await createClient();
  const { error } = await supabase.rpc("report_production_fault", {
    p_equipment: optStr(fd, "equipment_id"),
    p_batch: optStr(fd, "batch_id"),
    p_severity: "medium",
    p_description: `${machine} — ${details}`,
    p_started_at: null,
  });
  if (error) fail(path, error);
  go(path, { notice: `फॉल्ट रिपोर्ट हो गया / Fault reported: ${machine}` });
}

/** "HH:MM" today in India; if that is still ahead of now, the repair was yesterday (after midnight). */
function repairedAt(hhmm: string): string | null {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  let t = new Date(`${today}T${hhmm}:00+05:30`);
  if (t.getTime() > Date.now() + 60_000) t = new Date(t.getTime() - 86_400_000);
  return t.toISOString();
}

/** Operator marks a fault fixed from the floor; downtime stops at the repair time (or now). */
export async function fixFault(fd: FormData) {
  const path = backPath(fd);
  const hindi = path.startsWith("/mill");
  const at = str(fd, "fixed_at");
  const endedAt = at ? repairedAt(at) : null;
  if (at && !endedAt) fail(path, "Enter the repair time as HH:MM");
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_production_fault", {
    p_id: str(fd, "id"),
    p_resolution: optStr(fd, "resolution") ?? (hindi ? "ठीक हो गया / Fixed" : "Fixed"),
    p_ended_at: endedAt,
  });
  if (error) fail(path, error);
  const what = str(fd, "machine");
  go(path, { notice: hindi ? `फॉल्ट ठीक हो गया, डाउनटाइम दर्ज / Fault fixed, downtime recorded: ${what}` : `Fault fixed — downtime recorded for ${what}` });
}
