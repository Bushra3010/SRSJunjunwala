import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canAccess } from "@/lib/roles";

const uuid = (v: string | null) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET /api/accounts/ledger?party=<id> | ?broker=<id> — party ledger as CSV (opens in Excel). */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.profile?.active || !canAccess(session.profile.role, "accounts")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }
  const url = new URL(req.url);
  const party = uuid(url.searchParams.get("party"));
  const broker = party ? null : uuid(url.searchParams.get("broker"));
  if (!party && !broker) return NextResponse.json({ error: "Choose a party or broker" }, { status: 400 });
  const { supabase } = session;
  const [{ data }, { data: who }] = await Promise.all([
    supabase.rpc("party_ledger", { p_party: party, p_broker: broker }),
    party ? supabase.from("parties").select("name").eq("id", party).single() : supabase.from("brokers").select("name").eq("id", broker!).single(),
  ]);
  const rows = (data ?? []) as { vdate: string; vtype: string; ref: string; narration: string; debit: number; credit: number; balance: number }[];
  const lines = [
    ["Date", "Type", "Reference", "Details", "Debit (Rs)", "Credit (Rs)", "Balance (Rs)", "Dr/Cr"].join(","),
    ...rows.map((r) =>
      [r.vdate, r.vtype === "Journal" ? "Brokerage" : r.vtype, r.ref, r.narration, Number(r.debit) || "", Number(r.credit) || "", Math.abs(Number(r.balance)).toFixed(2), Number(r.balance) >= 0 ? "Dr" : "Cr"]
        .map(cell)
        .join(","),
    ),
  ];
  const name = (who?.name ?? "ledger").replace(/[^A-Za-z0-9]+/g, "-");
  return new NextResponse("﻿" + lines.join("\n") + "\n", {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="Ledger-${name}.csv"` },
  });
}
