import { randomUUID } from "node:crypto";
import Image from "next/image";
import Link from "next/link";
import {
  AirVent,
  ArrowUpFromLine,
  Ban,
  CircuitBoard,
  Cog,
  Factory,
  Filter,
  History,
  House,
  Layers,
  PanelTop,
  Play,
  ScanLine,
  Send,
  Sparkles,
  Split,
  Square,
  TriangleAlert,
  Warehouse,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Flash } from "@/components/ui";
import { LiveRefresh } from "@/components/live-refresh";
import { requireModule } from "@/lib/auth";
import { FAULT_REPORTERS, STAGE_OPERATORS } from "@/lib/roles";
import { loadMasters, type Batch } from "@/lib/production";
import { Clock, OnlineStatus, PressButton } from "../floor/floor-client";
import { millFault, millStart, millStop } from "./actions";
import { OpenFaults } from "../floor/open-faults";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mill Section · SRS Factory" };

type SP = { error?: string; notice?: string };

/** Mill machinery for fault reports (Hindi / English). */
const MACHINES: { hi: string; en: string; icon: LucideIcon }[] = [
  { hi: "हस्कर", en: "Husker", icon: Cog },
  { hi: "डेस्टोनर", en: "Destoner", icon: Filter },
  { hi: "सेपरेटर", en: "Separator", icon: Split },
  { hi: "व्हाइटनर", en: "Whitener", icon: Sparkles },
  { hi: "सिल्की", en: "Silky", icon: Wind },
  { hi: "सॉर्टेक्स", en: "Sortex", icon: ScanLine },
  { hi: "ग्रेडर", en: "Grader", icon: Layers },
  { hi: "एलेवेटर", en: "Elevator", icon: ArrowUpFromLine },
  { hi: "कंप्रेसर", en: "Compressor", icon: AirVent },
  { hi: "एमटीआर", en: "MTR", icon: Zap },
  { hi: "इलेक्ट्रिसिटी पैनल", en: "Electricity Panel", icon: CircuitBoard },
  { hi: "पैनल", en: "Panel", icon: PanelTop },
  { hi: "मिल में जगह नहीं है", en: "No Space in Mill", icon: Ban },
];

const TZ = "Asia/Kolkata";
const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" }).replace(/\//g, "-");
const qtl = (kg: number | string | null | undefined) => (Number(kg ?? 0) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
function span(fromIso: string | null | undefined, toIso?: string | null) {
  if (!fromIso) return "";
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  const min = Math.max(0, Math.round((end - new Date(fromIso).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Two-line label: Hindi above, English below. */
function Bi({ hi, en, className = "" }: { hi: string; en: string; className?: string }) {
  return (
    <span className={`flex flex-col leading-tight ${className}`}>
      <span>{hi}</span>
      <span>{en}</span>
    </span>
  );
}

/** Phone / tablet screen for the rice mill: start and stop milling per feed tank, report machine faults. */
export default async function MillPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { profile } = await requireModule("processing");
  const canMill = STAGE_OPERATORS.milling.includes(profile.role);
  const canFault = FAULT_REPORTERS.includes(profile.role);

  const m = await loadMasters();
  const feedTanks = m.equipment.filter((e) => e.kind === "mill_feed_tank").sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const line = m.equipment.find((e) => e.kind === "mill_line");
  const millIds = [line?.id, ...feedTanks.map((t) => t.id)].filter(Boolean) as string[];

  const [waitingRes, runningRes, faultsRes, openRes] = await Promise.all([
    m.supabase.rpc("feed_tanks_waiting"),
    m.supabase.from("production_batches").select("id, batch_no, input_kg, started_at, variety_id").eq("stage", "milling").eq("status", "running").order("started_at"),
    m.supabase
      .from("production_faults")
      .select("id, equipment_id, description, started_at, ended_at")
      .in("equipment_id", millIds.length ? millIds : ["00000000-0000-0000-0000-000000000000"])
      .order("started_at", { ascending: false })
      .limit(10),
    m.supabase
      .from("production_faults")
      .select("id, equipment_id, description, started_at")
      .is("ended_at", null)
      .in("equipment_id", millIds.length ? millIds : ["00000000-0000-0000-0000-000000000000"])
      .order("started_at"),
  ]);
  const waiting = new Map(((waitingRes.data ?? []) as { dryer_no: number; waiting_kg: number; since: string }[]).map((w) => [w.dryer_no, w]));
  const running = (runningRes.data ?? []) as Pick<Batch, "id" | "batch_no" | "input_kg" | "started_at" | "variety_id">[];

  // Which feed tank each running milling batch draws from.
  const tankOfBatch = new Map<string, number>();
  if (running.length) {
    const { data: edges } = await m.supabase.from("batch_inputs").select("child_id, parent_id").in("child_id", running.map((r) => r.id));
    const parentIds = [...new Set((edges ?? []).map((e) => e.parent_id))];
    const { data: parents } = parentIds.length
      ? await m.supabase.from("production_batches").select("id, equipment_id").in("id", parentIds)
      : { data: [] as { id: string; equipment_id: string | null }[] };
    for (const e of edges ?? []) {
      const p = (parents ?? []).find((x) => x.id === e.parent_id);
      const n = p?.equipment_id ? m.equipmentById.get(p.equipment_id)?.number : undefined;
      if (n && !tankOfBatch.has(e.child_id)) tankOfBatch.set(e.child_id, n);
    }
  }
  const runningFor = (n: number) => running.find((r) => tankOfBatch.get(r.id) === n);
  // Expected rice output from the variety's standard recovery (null when no standard applies).
  const estimate = new Map<string, number | null>();
  await Promise.all(
    running.map(async (r) => {
      const { data, error } = await m.supabase.rpc("milling_standard_output_kg", { p_id: r.id });
      estimate.set(r.id, error || data === null ? null : Number(data));
    }),
  );
  const millBusy = running.length > 0;
  const faults = (faultsRes.data ?? []) as { id: string; equipment_id: string | null; description: string; started_at: string; ended_at: string | null }[];
  const back = "/mill";

  return (
    <div className="min-h-dvh bg-[#f3f1ea] pb-10 text-[#0f1f3d]">
      {/* Keeps the screen updated when data changes; the badge itself is not shown here. */}
      <div className="hidden">
        <LiveRefresh />
      </div>
      <header className="sticky top-0 z-20 border-b-2 border-[#d9b44a] bg-[#fbfaf6]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5">
          <Link href="/production" className="flex min-w-0 items-center gap-2" aria-label="ERP होम / ERP home">
            <Image src="/logo-transparent.png" alt="" width={48} height={48} className="size-10 shrink-0 object-contain sm:size-12" />
            <span className="hidden min-w-0 leading-tight md:block">
              <span className="block font-serif text-[20px] font-bold">Shree Rani Sati</span>
              <span className="block font-serif text-[15px] font-semibold text-[#334155]">Overseas Pvt. Ltd.</span>
            </span>
          </Link>
          <h1 className="flex items-center gap-2 rounded-xl bg-[#13284b] px-3 py-1.5 text-white sm:px-5">
            <Factory className="hidden size-7 text-[#c9d6ee] sm:block" />
            <Bi hi="राइस मिल के अंदर" en="Inside the Rice Mill" className="text-[14px] font-extrabold sm:text-[19px]" />
          </h1>
          <div className="ml-auto flex items-center gap-3">
            <Clock hindi />
            <OnlineStatus hindi />
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-4 pt-4">
        <Flash error={sp.error} notice={sp.notice} />

        <OpenFaults
          hindi
          back={back}
          canFix={canFault}
          faults={((openRes.data ?? []) as { id: string; equipment_id: string | null; description: string; started_at: string }[]).map((f) => {
            const cut = f.description.indexOf(" — ");
            return {
              id: f.id,
              machine: cut > 0 ? f.description.slice(0, cut) : (f.equipment_id ? (m.equipmentById.get(f.equipment_id)?.name ?? "—") : "—"),
              details: cut > 0 ? f.description.slice(cut + 3) : f.description,
              started_at: f.started_at,
            };
          })}
        />

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Feed tank selection */}
          <section className="overflow-hidden rounded-2xl border border-[#d7dde8] bg-white shadow-sm">
            <h2 className="flex items-center justify-center gap-3 bg-[#13284b] py-3 text-white">
              <Warehouse className="size-7 text-[#c9d6ee]" />
              <Bi hi="फीड टैंक चयन" en="Feed Tank Selection" className="text-[17px] font-extrabold" />
            </h2>
            <ul className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3">
              {feedTanks.map((t) => {
                const n = t.number ?? 0;
                const run = runningFor(n);
                const w = waiting.get(n);
                const ready = !run && !!w;
                return (
                  <li key={t.id} className="flex flex-col gap-2 rounded-2xl border border-[#e2e7ef] p-3 text-center">
                    <Bi hi={`फीड टैंक ${n}`} en={`Feed Tank ${n}`} className="text-[16px] font-extrabold" />
                    <span
                      className={`mx-auto inline-flex items-center gap-2 rounded-xl px-3 py-1 text-[13px] font-bold ${
                        run ? "bg-[#dce8fb] text-[#1d4f9a]" : ready ? "bg-[#dcf3e3] text-[#14632f]" : "bg-[#e8ecf3] text-[#475569]"
                      }`}
                    >
                      <span className={`size-2.5 rounded-full ${run ? "bg-[#2563eb]" : ready ? "bg-[#0a8f44]" : "bg-[#94a3b8]"}`} />
                      {run ? <Bi hi="मिलिंग चालू" en="Milling" /> : ready ? <Bi hi="तैयार" en="Ready" /> : <Bi hi="खाली" en="Empty" />}
                    </span>
                    <div className="min-h-10 text-[12px] leading-snug text-[#475569]">
                      {run ? (
                        <>
                          {run.batch_no} · {qtl(run.input_kg)} क्विंटल / q
                          <br />
                          {time(run.started_at)} से / since · {span(run.started_at)}
                        </>
                      ) : w ? (
                        <>
                          {qtl(w.waiting_kg)} क्विंटल / q
                          <br />
                          ड्रायर {n} से / from Dryer {n}
                        </>
                      ) : (
                        <>
                          धान नहीं है
                          <br />
                          No paddy
                        </>
                      )}
                    </div>

                    <form action={millStart}>
                      <input type="hidden" name="tank_no" value={n} />
                      <input type="hidden" name="line_id" value={line?.id ?? ""} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="request_id" value={randomUUID()} />
                      <PressButton tone="start" disabled={!canMill || !ready || millBusy || !line} pendingText="रुकिए… / Saving…">
                        <Play className="size-5 fill-white" />
                        <Bi hi="शुरू करें" en="Start" className="text-left" />
                      </PressButton>
                    </form>

                    <form action={millStop} className="grid gap-2">
                      <input type="hidden" name="id" value={run?.id ?? ""} />
                      <input type="hidden" name="batch_no" value={run?.batch_no ?? ""} />
                      <input type="hidden" name="back" value={back} />
                      {run && (
                        <p className={`rounded-lg px-2 py-1.5 text-[12px] font-bold ${estimate.get(run.id) ? "bg-[#f3f6fb] text-[#334155]" : "bg-[#fdecec] text-[#a11a1a]"}`}>
                          {estimate.get(run.id) ? (
                            <>
                              अनुमानित चावल ~{qtl(estimate.get(run.id))} क्विंटल (मानक से)
                              <br />
                              Est. rice output ~{qtl(estimate.get(run.id))} q (from standard)
                            </>
                          ) : (
                            <>
                              इस किस्म का मानक सेट नहीं है — मैनेजर से सेट करवाएँ
                              <br />
                              No standard set for this variety — ask the manager
                            </>
                          )}
                        </p>
                      )}
                      <PressButton tone="stop" disabled={!canMill || !run || !estimate.get(run.id)} pendingText="रुकिए… / Saving…">
                        <Square className="size-5 fill-white" />
                        <Bi hi="बंद करें" en="Stop" className="text-left" />
                      </PressButton>
                    </form>
                  </li>
                );
              })}
            </ul>
            {millBusy && (
              <p className="border-t border-[#e5e9f0] bg-[#f6f8fb] px-4 py-2.5 text-[12px] text-[#475569]">
                मिल चालू है — दूसरा फीड टैंक शुरू करने से पहले इसे बंद करें।
                <br />
                The mill is running — stop it before starting another feed tank.
              </p>
            )}
            {!canMill && (
              <p className="px-4 pb-3 text-[12px] text-[#64748b]">
                केवल देखने के लिए: आपकी भूमिका मिलिंग शुरू या बंद नहीं कर सकती।
                <br />
                View only: your role can&apos;t start or stop milling.
              </p>
            )}
          </section>

          {/* Fault report */}
          <section className="overflow-hidden rounded-2xl border border-[#d7dde8] bg-white shadow-sm">
            <h2 className="flex items-center justify-center gap-3 bg-[#13284b] py-3 text-white">
              <TriangleAlert className="size-7 fill-[#f5b82e] text-[#13284b]" />
              <Bi hi="फॉल्ट रिपोर्ट" en="Fault Report" className="text-[17px] font-extrabold" />
            </h2>
            {canFault ? (
              <form action={millFault} className="grid gap-3 p-3">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="equipment_id" value={line?.id ?? ""} />
                <input type="hidden" name="batch_id" value={running[0]?.id ?? ""} />
                <fieldset>
                  <legend className="mb-2 text-[14px] font-extrabold">मशीनरी चयन करें / Select Machinery:</legend>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {MACHINES.map((mc, i) => (
                      <label
                        key={mc.en}
                        className={`flex min-h-14 cursor-pointer items-center gap-2 rounded-xl border-2 border-[#d7dde8] bg-[#f3f6fb] px-2.5 py-1.5 text-[13px] font-bold has-[:checked]:border-[#c62f37] has-[:checked]:bg-[#fdecec] has-[:checked]:text-[#a11a1a] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#13284b] ${
                          i === MACHINES.length - 1 ? "col-span-2 sm:col-span-3 sm:mx-auto sm:w-2/3" : ""
                        }`}
                      >
                        <input type="radio" name="machine" value={`${mc.hi} / ${mc.en}`} required className="sr-only" />
                        <mc.icon className="size-6 shrink-0 text-[#13284b]" />
                        <Bi hi={mc.hi} en={mc.en} />
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="grid gap-1 text-[14px] font-extrabold">
                  फॉल्ट की जानकारी / Fault Details:
                  <span className="flex flex-col gap-2 sm:flex-row">
                    <textarea
                      name="details"
                      required
                      rows={2}
                      className="input min-h-12 flex-1 text-[15px] font-normal"
                      placeholder="यहाँ फॉल्ट की जानकारी लिखें / Enter fault details…"
                    />
                    <span className="sm:w-40">
                      <PressButton tone="navy" pendingText="भेज रहे… / Sending…" className="h-full min-h-14">
                        <Send className="size-5" />
                        <Bi hi="रिपोर्ट करें" en="Submit" className="text-left" />
                      </PressButton>
                    </span>
                  </span>
                </label>
              </form>
            ) : (
              <p className="p-4 text-[13px] text-[#64748b]">
                आपकी भूमिका फॉल्ट रिपोर्ट नहीं कर सकती।
                <br />
                Your role can&apos;t report faults.
              </p>
            )}
          </section>
        </div>

        <div className="grid gap-5 lg:grid-cols-[1fr_auto]">
          {/* Recent fault reports */}
          <section className="min-w-0 overflow-hidden rounded-2xl border border-[#d7dde8] bg-white shadow-sm">
            <h2 className="flex items-center gap-2 bg-[#13284b] px-4 py-2.5 text-[15px] font-extrabold text-white">
              <History className="size-5" /> हाल के फॉल्ट रिपोर्ट्स / Recent Fault Reports
            </h2>
            {faults.length === 0 ? (
              <p className="p-4 text-[13px] text-[#64748b]">
                अभी कोई फॉल्ट नहीं है।
                <br />
                No faults reported yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="bg-[#f3f6fb] text-[12px] font-extrabold">
                    <tr>
                      <th className="px-3 py-2">तारीख / Date</th>
                      <th className="px-3 py-2">समय / Time</th>
                      <th className="px-3 py-2">मशीनरी / Machinery</th>
                      <th className="px-3 py-2">विवरण / Details</th>
                      <th className="px-3 py-2">डाउनटाइम / Downtime</th>
                      <th className="px-3 py-2">स्थिति / Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {faults.map((f) => {
                      const cut = f.description.indexOf(" — ");
                      const machine = cut > 0 ? f.description.slice(0, cut) : (f.equipment_id ? m.equipmentById.get(f.equipment_id)?.name : "") || "—";
                      const details = cut > 0 ? f.description.slice(cut + 3) : f.description;
                      return (
                        <tr key={f.id} className="border-t border-[#e5e9f0] align-top">
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">{day(f.started_at)}</td>
                          <td className="px-3 py-2 tabular-nums">{time(f.started_at)}</td>
                          <td className="px-3 py-2 font-bold">{machine}</td>
                          <td className="px-3 py-2">{details}</td>
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                            {span(f.started_at, f.ended_at)}
                            {!f.ended_at && <span className="block text-[11px] text-[#8a5a00]">चल रहा / running</span>}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-block rounded-lg px-2.5 py-1 text-[12px] font-extrabold whitespace-nowrap ${
                                f.ended_at ? "bg-[#dcf3e3] text-[#14632f]" : "bg-[#f8c94a] text-[#4a3500]"
                              }`}
                            >
                              {f.ended_at ? "ठीक हुआ / Resolved" : "लंबित / Pending"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <Link
            href="/production"
            className="flex min-h-20 items-center justify-center gap-3 self-start rounded-2xl border border-[#d7dde8] bg-[#e6ebf5] px-8 text-[#13284b] shadow-sm hover:bg-[#dbe2f0]"
          >
            <House className="size-8 fill-[#13284b]" />
            <Bi hi="होम" en="Home" className="text-[18px] font-extrabold" />
          </Link>
        </div>
      </main>
    </div>
  );
}
