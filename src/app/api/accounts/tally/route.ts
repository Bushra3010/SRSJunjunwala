import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ACCOUNT_EDITORS, canAccess } from "@/lib/roles";
import { errorMessage } from "@/lib/format";
import { ledgerMasters, loadTallySettings, loadVouchers, toTallyVouchers, validDate } from "@/lib/accounts";
import { mastersXml, vouchersXml } from "@/lib/tally";

function xmlFile(xml: string, name: string) {
  return new NextResponse(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
  });
}

function backTo(req: Request, from: string | null, to: string | null, flash: { error?: string; notice?: string }) {
  const u = new URL("/accounts/tally", req.url);
  if (from) u.searchParams.set("from", from);
  if (to) u.searchParams.set("to", to);
  if (flash.error) u.searchParams.set("error", flash.error);
  if (flash.notice) u.searchParams.set("notice", flash.notice);
  return NextResponse.redirect(u, 303);
}

/**
 * POST /api/accounts/tally — export the ticked ready entries: records them as sent (never twice)
 * and downloads the TallyPrime vouchers file.
 */
export async function POST(req: Request) {
  const session = await getSession();
  const role = session?.profile?.active ? session.profile.role : null;
  if (!role || !ACCOUNT_EDITORS.includes(role)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  const fd = await req.formData();
  const keys = fd.getAll("key").map(String).filter(Boolean);
  const from = validDate(String(fd.get("from") ?? ""));
  const to = validDate(String(fd.get("to") ?? ""));
  if (!keys.length) return backTo(req, from, to, { error: "Tick at least one entry to export" });
  const { supabase } = session!;
  const { data: exportId, error } = await supabase.rpc("mark_tally_exported", { p_keys: keys, p_from: from, p_to: to });
  if (error) return backTo(req, from, to, { error: errorMessage(error) });
  return exportFile(exportId as string);
}

async function exportFile(exportId: string) {
  const session = await getSession();
  const { supabase } = session!;
  const [{ data: ex }, { data: keyRows }] = await Promise.all([
    supabase.from("tally_exports").select("export_no").eq("id", exportId).single(),
    supabase.from("tally_exported").select("voucher_key").eq("export_id", exportId),
  ]);
  const keys = new Set((keyRows ?? []).map((k) => k.voucher_key));
  const { rows } = await loadVouchers(null, null);
  const chosen = rows.filter((r) => keys.has(r.voucher_key));
  const settings = await loadTallySettings();
  const xml = vouchersXml(await toTallyVouchers(chosen), settings);
  return xmlFile(xml, `SRS-Tally-${ex?.export_no ?? "export"}.xml`);
}

/**
 * GET /api/accounts/tally?export=<id> — download a past export again (nothing new is marked).
 * GET /api/accounts/tally?masters=1&from=&to= — ledgers (masters) file for the entries in those dates.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.profile?.active || !canAccess(session.profile.role, "accounts")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const url = new URL(req.url);
  const exportId = url.searchParams.get("export");
  if (exportId) {
    if (!/^[0-9a-f-]{36}$/i.test(exportId)) return NextResponse.json({ error: "Unknown export" }, { status: 404 });
    return exportFile(exportId);
  }
  if (url.searchParams.get("masters")) {
    const from = validDate(url.searchParams.get("from"));
    const to = validDate(url.searchParams.get("to"));
    const { rows } = await loadVouchers(from, to);
    const settings = await loadTallySettings();
    const xml = mastersXml(await ledgerMasters(rows, settings), settings);
    return xmlFile(xml, `SRS-Tally-ledgers-${from ?? "all"}-to-${to ?? "all"}.xml`);
  }
  return NextResponse.json({ error: "Nothing requested" }, { status: 400 });
}
