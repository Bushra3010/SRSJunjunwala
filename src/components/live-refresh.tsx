"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

/** Tables published to Supabase Realtime (see migrations 20261112000006 and 20261114000009). */
const TABLES = ["weighbridge_tickets", "qc_inbound", "qc_outbound", "purchase_orders", "sales_orders", "stock_movements", "production_batches", "batch_events", "production_faults", "milling_stage_events"];

/**
 * Subscribes to database changes the signed-in user is allowed to see (RLS applies)
 * and re-renders the current page shortly after something changes.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [status, setStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) return;
    const supabase = createBrowserClient(url, key);

    const refresh = () => {
      if (timer.current) clearTimeout(timer.current);
      // Batch bursts (a posting touches several tables) into one refresh.
      timer.current = setTimeout(() => router.refresh(), 700);
    };

    let channel = supabase.channel("erp-live");
    for (const table of TABLES) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table }, refresh);
    }

    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) supabase.realtime.setAuth(data.session.access_token);
      channel.subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") setStatus("offline");
      });
    });

    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
      supabase.removeChannel(channel);
    };
  }, [router]);

  const label = status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
  return (
    <span
      className="hidden items-center gap-1.5 rounded-md border border-[#e3d3a8] bg-white/70 px-2 py-1 text-[11px] font-bold text-[#14532d] sm:inline-flex"
      title={status === "live" ? "Updates appear automatically when data changes." : "Live updates unavailable — refresh to see changes."}
    >
      <span className={`relative flex size-2`}>
        {status === "live" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#0a8f44] opacity-60" />}
        <span className={`relative inline-flex size-2 rounded-full ${status === "live" ? "bg-[#0a8f44]" : status === "connecting" ? "bg-[#c08a24]" : "bg-gray-400"}`} />
      </span>
      {label}
    </span>
  );
}
