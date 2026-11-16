import { randomUUID } from "node:crypto";
import Image from "next/image";
import Link from "next/link";
import { Droplets, Fan, House, Play, Square, TriangleAlert } from "lucide-react";
import { Flash } from "@/components/ui";
import { LiveRefresh } from "@/components/live-refresh";
import type { UnloadedRow } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { FAULT_REPORTERS, STAGE_OPERATORS } from "@/lib/roles";
import { equipmentState, loadMasters, q, type Batch } from "@/lib/production";
import { reportFault, startDryer, startSoakingStandard, stopDryer, stopSoaking } from "@/app/(app)/production/actions";
import { Clock, OnlineStatus, PressButton } from "./floor-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dryer Section · SRS Factory" };

type SP = { dryer?: string; tab?: string; fault?: string; error?: string; notice?: string };

const TIME = { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false } as const;
const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-IN", TIME) : "—");
function since(iso: string | null | undefined) {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Phone-first operator screen for the soaking tanks and dryers, with a fault button. */
export default async function FloorPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { profile } = await requireModule("processing");
  const canSoak = STAGE_OPERATORS.soaking.includes(profile.role);
  const canDry = STAGE_OPERATORS.drying.includes(profile.role);
  const canFault = FAULT_REPORTERS.includes(profile.role);

  const m = await loadMasters();
  const tanks = m.equipment.filter((e) => e.kind === "soaking_tank");
  const dryers = m.equipment.filter((e) => e.kind === "dryer");
  const [tankState, dryerState, unloadedRes, fillRes, promisedRes, faultsRes] = await Promise.all([
    equipmentState(tanks.map((t) => t.id)),
    equipmentState(dryers.map((d) => d.id)),
    m.supabase.rpc("unloaded_paddy_summary"),
    m.supabase.rpc("dryer_filling"),
    m.supabase.from("production_batches").select("batch_no, target_dryer_id").eq("stage", "steaming").eq("status", "running").not("target_dryer_id", "is", null),
    m.supabase.from("production_faults").select("id, equipment_id, severity, description, started_at").is("ended_at", null).order("started_at", { ascending: false }).limit(20),
  ]);
  const unloaded = ((unloadedRes.data ?? []) as UnloadedRow[]).filter((r) => r.std_tank_kg);
  const filling = new Map(((fillRes.data ?? []) as { dryer_id: string; lots: number; tanks?: number; filling_kg: number; first_at: string }[]).map((f) => [f.dryer_id, f]));
  const faults = (faultsRes.data ?? []) as { id: string; equipment_id: string | null; severity: string; description: string; started_at: string }[];

  const dryerInfo = dryers.map((d) => {
    const s = dryerState.get(d.id);
    const promised = (promisedRes.data ?? []).find((x) => x.target_dryer_id === d.id)?.batch_no;
    const f = filling.get(d.id);
    const drying = s?.batch.status === "running" ? s.batch : undefined;
    return {
      eq: d,
      number: d.number ?? 0,
      drying,
      busy: s?.batch.batch_no ?? promised,
      fillingKg: Number(f?.filling_kg ?? 0),
      fillingLots: Number(f?.tanks ?? f?.lots ?? 0),
        lotCount: Number(f?.lots ?? 0),
      fillingSince: f?.first_at,
      faults: faults.filter((x) => x.equipment_id === d.id).length,
    };
  });
  const picked = dryerInfo.find((d) => String(d.number) === sp.dryer);
  const sel = picked ?? dryerInfo.find((d) => !d.busy && d.fillingLots > 0) ?? dryerInfo.find((d) => !d.busy) ?? dryerInfo[0];
  const tab = sp.tab === "dryers" ? "dryers" : "tanks";
  const link = (p: Partial<{ dryer: number; tab: string; fault: boolean }>) => {
    const u = new URLSearchParams();
    u.set("dryer", String(p.dryer ?? sel?.number ?? 1));
    u.set("tab", p.tab ?? tab);
    if (p.fault) u.set("fault", "1");
    return `/floor?${u}`;
  };
  const back = link({});
  const soakingNow = tanks.filter((t) => tankState.get(t.id)?.batch.status === "running").length;
  const varietyName = (b: Batch) => (b.variety_id ? (m.varietyById.get(b.variety_id)?.name ?? "") : "Mixed");

  return (
    <div className="min-h-dvh bg-[#eef1f6] pb-10 text-[#0f1f3d]">
      <LiveRefresh />
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-[#d7dde8] bg-[#f8f6f1]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
          <Link href="/production" className="flex min-w-0 items-center gap-2" aria-label="Back to the ERP">
            <Image src="/logo-transparent.png" alt="" width={44} height={44} className="size-10 shrink-0 object-contain sm:size-12" />
            <span className="hidden min-w-0 leading-tight sm:block">
              <span className="block font-serif text-[20px] font-bold">Shree Rani Sati</span>
              <span className="block text-[10px] tracking-[0.3em] text-[#475569]">OVERSEAS PVT. LTD.</span>
            </span>
          </Link>
          <h1 className="rounded-xl bg-[#13284b] px-3 py-2 text-[15px] font-extrabold text-white sm:px-5 sm:text-[22px]">Dryer Section</h1>
          <div className="ml-auto flex items-center gap-3">
            <Clock />
            <span className="hidden sm:inline">
              <OnlineStatus />
            </span>
          </div>
        </div>
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-2.5">
          <span className="sm:hidden">
            <OnlineStatus />
          </span>
          <Link href="/production" className="inline-flex items-center gap-1 rounded-full border border-[#d7dde8] bg-white px-2.5 py-1 text-[12px] font-bold text-[#334155]">
            <House className="size-3.5" /> ERP
          </Link>
          {canFault && (
            <Link
              href={sp.fault ? back : link({ fault: true })}
              className="ml-auto inline-flex min-h-10 items-center gap-1.5 rounded-xl border-2 border-[#d32f37] bg-white px-3 text-[14px] font-extrabold text-[#c0262e]"
            >
              <TriangleAlert className="size-4" /> {sp.fault ? "Close" : "Report fault"}
              {faults.length > 0 && <span className="rounded-full bg-[#d32f37] px-1.5 text-[11px] text-white">{faults.length}</span>}
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-4">
        <Flash error={sp.error} notice={sp.notice} />

        {sp.fault && canFault && (
          <section id="fault" className="mb-5 rounded-2xl border-2 border-[#f3b4b7] bg-white p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-[18px] font-extrabold text-[#a11a1a]">
              <TriangleAlert className="size-5" /> Report a fault
            </h2>
            <form action={reportFault} className="grid gap-3">
              <input type="hidden" name="back" value={back} />
              <label className="text-[13px] font-bold">
                Machine
                <select name="equipment_id" defaultValue={sel?.eq.id} className="input mt-1 min-h-12 text-[15px]">
                  {m.equipment
                    .filter((e) => ["soaking_tank", "steamer", "dryer", "mill_feed_tank"].includes(e.kind))
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                      </option>
                    ))}
                </select>
              </label>
              <fieldset>
                <legend className="text-[13px] font-bold">How serious?</legend>
                <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(["low", "medium", "high", "critical"] as const).map((s) => (
                    <label key={s} className="flex min-h-12 cursor-pointer items-center justify-center rounded-xl border-2 border-[#d7dde8] text-[14px] font-bold capitalize has-[:checked]:border-[#d32f37] has-[:checked]:bg-[#fdecec] has-[:checked]:text-[#a11a1a]">
                      <input type="radio" name="severity" value={s} defaultChecked={s === "medium"} className="sr-only" />
                      {s}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="text-[13px] font-bold">
                What happened?
                <textarea name="description" required rows={3} className="input mt-1 text-[15px]" placeholder="e.g. Burner not starting, motor noise, belt broken" />
              </label>
              <PressButton tone="stop">
                <TriangleAlert className="size-5" /> Send fault report
              </PressButton>
            </form>
            {faults.length > 0 && (
              <div className="mt-4 border-t border-[#f1d5d6] pt-3">
                <h3 className="mb-2 text-[13px] font-extrabold text-[#475569]">Open faults ({faults.length})</h3>
                <ul className="space-y-2">
                  {faults.map((f) => (
                    <li key={f.id} className="rounded-xl bg-[#fdf3f3] px-3 py-2 text-[13px]">
                      <b>{f.equipment_id ? m.equipmentById.get(f.equipment_id)?.name : "General"}</b> · <span className="capitalize">{f.severity}</span> · since {clock(f.started_at)}
                      <div className="text-[#475569]">{f.description}</div>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-[#64748b]">The production manager closes faults on the Production → Faults page.</p>
              </div>
            )}
          </section>
        )}

        {/* Phone: switch between the two panels. Wide screens show both side by side. */}
        <nav className="mb-4 grid grid-cols-2 gap-1 rounded-2xl bg-white p-1 shadow-sm lg:hidden" aria-label="Section">
          {[
            { key: "tanks", label: `Soaking tanks (${soakingNow})`, icon: Droplets },
            { key: "dryers", label: `Dryers · Dryer ${sel?.number ?? ""}`, icon: Fan },
          ].map((t) => (
            <Link
              key={t.key}
              href={link({ tab: t.key })}
              aria-current={tab === t.key ? "page" : undefined}
              className={`flex min-h-12 items-center justify-center gap-2 rounded-xl text-[14px] font-extrabold ${tab === t.key ? "bg-[#13284b] text-white" : "text-[#13284b]"}`}
            >
              <t.icon className="size-4" /> {t.label}
            </Link>
          ))}
        </nav>

        <div className="grid gap-5 lg:grid-cols-2">
          {/* Soaking tanks */}
          <section className={`${tab === "tanks" ? "block" : "hidden"} overflow-hidden rounded-2xl border border-[#d7dde8] bg-white shadow-sm lg:block`}>
            <h2 className="flex items-center justify-center gap-2 bg-[#13284b] py-3 text-[19px] font-extrabold text-white">
              <Droplets className="size-5 text-[#9cc3f5]" /> Soaking Tanks
            </h2>
            <div className="border-b border-[#e5e9f0] bg-[#f6f8fb] px-4 py-2.5 text-[12px] text-[#475569]">
              {unloaded.length ? (
                <>Waiting in unloading bay: {unloaded.map((u) => `${u.variety} ${q(u.waiting_kg)}`).join(" · ")}</>
              ) : (
                <>No unloaded paddy waiting (or no standard tank weight set).</>
              )}
              <br />
              Stop sends the tank through steaming into <b>Dryer {sel?.number}</b>
              {sel?.busy ? <b className="text-[#c0262e]"> — drying now, choose another dryer</b> : null}.
              <br />
              Two tanks stopped one after the other into the same dryer share one lot number.
            </div>
            <ul className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
              {tanks.map((t) => {
                const s = tankState.get(t.id);
                const b = s?.batch;
                const soaking = b?.status === "running";
                const hasFault = faults.some((f) => f.equipment_id === t.id);
                return (
                  <li key={t.id} className="flex flex-col gap-2 rounded-2xl border border-[#e2e7ef] p-3 shadow-[0_1px_2px_rgba(15,31,61,0.06)]">
                    <div className="text-center text-[18px] font-extrabold">Tank {t.number}</div>
                    <span
                      className={`mx-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-bold ${
                        soaking ? "bg-[#dcf3e3] text-[#14632f]" : b ? "bg-[#fff1d6] text-[#8a5a00]" : "bg-[#e8ecf3] text-[#334155]"
                      }`}
                    >
                      <span className={`size-2 rounded-full ${soaking ? "bg-[#0a8f44]" : b ? "bg-[#c08a24]" : "bg-[#13284b]"}`} />
                      {soaking ? "Soaking" : b ? "Waiting" : "Idle"}
                    </span>
                    {hasFault && <span className="text-center text-[11px] font-bold text-[#c0262e]">⚠ Fault open</span>}
                    <div className="min-h-9 text-center text-[11px] leading-snug text-[#64748b]">
                      {b ? (
                        <>
                          {varietyName(b)} · {q(b.input_kg, 0)}
                          <br />
                          from {clock(b.started_at)} · {since(b.started_at)}
                        </>
                      ) : (
                        "Empty"
                      )}
                    </div>

                    <form action={stopSoaking}>
                      <input type="hidden" name="id" value={b?.id ?? ""} />
                      <input type="hidden" name="batch_no" value={b?.batch_no ?? ""} />
                      <input type="hidden" name="dryer_id" value={sel?.eq.id ?? ""} />
                      <input type="hidden" name="dryer_name" value={sel ? `Dryer ${sel.number}` : ""} />
                      <input type="hidden" name="back" value={back} />
                      <PressButton tone="stop" disabled={!canSoak || !soaking || !sel || !!sel.busy}>
                        <Square className="size-4 fill-white" /> Stop
                      </PressButton>
                    </form>

                    <form action={startSoakingStandard} className="flex flex-col gap-1.5">
                      <input type="hidden" name="tank_id" value={t.id} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="request_id" value={randomUUID()} />
                      {unloaded.length > 1 && !b ? (
                        <select name="variety_id" className="input min-h-10 px-2 text-[12px]" aria-label={`Variety for Tank ${t.number}`} defaultValue={unloaded[0].variety_id}>
                          {unloaded.map((u) => (
                            <option key={u.variety_id} value={u.variety_id}>
                              {u.variety}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input type="hidden" name="variety_id" value={unloaded[0]?.variety_id ?? ""} />
                      )}
                      <PressButton tone="start" disabled={!canSoak || !!b || unloaded.length === 0}>
                        <Play className="size-4 fill-white" /> Start
                      </PressButton>
                    </form>
                  </li>
                );
              })}
            </ul>
            {!canSoak && <p className="px-4 pb-3 text-[12px] text-[#64748b]">View only: your role can&apos;t start or stop soaking.</p>}
          </section>

          {/* Dryers */}
          <section className={`${tab === "dryers" ? "block" : "hidden"} overflow-hidden rounded-2xl border border-[#d7dde8] bg-white shadow-sm lg:block`}>
            <h2 className="flex items-center justify-center gap-2 bg-[#e6ebf5] py-3 text-[19px] font-extrabold text-[#13284b]">
              <Fan className="size-5" /> Dryers
            </h2>
            <div className="space-y-4 p-4">
              <div>
                <div className="mb-2 text-[14px] font-extrabold">Select dryer:</div>
                <div className="grid grid-cols-3 gap-2">
                  {dryerInfo.map((d) => {
                    const on = d.number === sel?.number;
                    return (
                      <Link
                        key={d.eq.id}
                        href={link({ dryer: d.number })}
                        aria-current={on ? "true" : undefined}
                        className={`flex min-h-14 flex-col items-center justify-center rounded-xl border-2 text-[15px] font-extrabold ${on ? "border-[#13284b] bg-[#13284b] text-white" : "border-[#d7dde8] bg-[#f3f6fb] text-[#13284b]"}`}
                      >
                        Dryer {d.number}
                        <span className={`text-[10px] font-bold ${on ? "text-[#c9d6ee]" : "text-[#64748b]"}`}>
                          {d.drying ? "Drying" : d.busy ? "Busy" : d.fillingLots ? "Filling" : "Empty"}
                          {d.faults ? " · ⚠" : ""}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>

              {sel && (
                <>
                  <div className="rounded-2xl border border-[#e2e7ef] bg-[#f6f8fb] p-4">
                    <h3 className="mb-1 text-[15px] font-extrabold">Loading status</h3>
                    {sel.drying ? (
                      <p className="text-[14px]">
                        <b className="text-[#14632f]">Drying</b> {sel.drying.batch_no} · {q(sel.drying.input_kg, 0)}
                        <br />
                        <span className="text-[#475569]">
                          started {clock(sel.drying.started_at)} · running {since(sel.drying.started_at)}
                        </span>
                      </p>
                    ) : sel.busy ? (
                      <p className="text-[14px] text-[#8a5a00]">Holding {sel.busy} — finish it on the Dryers page.</p>
                    ) : sel.fillingLots ? (
                      <p className="text-[14px]">
                        <b className="text-[#8a5a00]">Filling:</b> {q(sel.fillingKg, 0)} from {sel.fillingLots} tank{sel.fillingLots > 1 ? "s" : ""}{sel.lotCount > 0 ? ` · ${sel.lotCount} lot${sel.lotCount > 1 ? "s" : ""}` : ""}
                        <br />
                        <span className="text-[#475569]">since {clock(sel.fillingSince)} · press Start Drying when full</span>
                      </p>
                    ) : (
                      <p className="text-[14px] text-[#475569]">Empty. To load it, press Stop on soaking tanks — they steam straight into Dryer {sel.number}.</p>
                    )}
                    {!sel.drying && !sel.busy && (
                      <Link href={link({ tab: "tanks" })} className="mt-3 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#13284b] text-[15px] font-bold text-white lg:hidden">
                        <Play className="size-4 fill-white" /> Load from soaking tanks
                      </Link>
                    )}
                  </div>

                  <div className="rounded-2xl border border-[#e2e7ef] p-4">
                    <h3 className="mb-3 text-[15px] font-extrabold">Drying control</h3>
                    <form action={startDryer} className="mb-3">
                      <input type="hidden" name="dryer_id" value={sel.eq.id} />
                      <input type="hidden" name="back" value={back} />
                      <input type="hidden" name="request_id" value={randomUUID()} />
                      <PressButton tone="start" disabled={!canDry || !!sel.busy || sel.fillingLots === 0}>
                        <Play className="size-4 fill-white" /> Start Drying
                      </PressButton>
                    </form>
                    <form action={stopDryer} className="grid gap-2">
                      <input type="hidden" name="id" value={sel.drying?.id ?? ""} />
                      <input type="hidden" name="batch_no" value={sel.drying?.batch_no ?? ""} />
                      <input type="hidden" name="feed_name" value={`Feed tank ${sel.number}`} />
                      <input type="hidden" name="back" value={back} />
                      <label className="text-[14px] font-extrabold" htmlFor="moisture">
                        Unload moisture content (%)
                      </label>
                      <input
                        id="moisture"
                        name="moisture_pct"
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        min="0"
                        max="60"
                        required
                        disabled={!sel.drying || !canDry}
                        placeholder="Enter moisture %"
                        className="input min-h-12 text-[16px]"
                      />
                      <PressButton tone="stop" disabled={!canDry || !sel.drying}>
                        <Square className="size-4 fill-white" /> Stop Drying &amp; save moisture
                      </PressButton>
                      <p className="text-[12px] text-[#64748b]">Stopping unloads the paddy into Feed tank {sel.number}, ready for milling.</p>
                    </form>
                  </div>
                </>
              )}
              {!canDry && <p className="text-[12px] text-[#64748b]">View only: your role can&apos;t start or stop dryers.</p>}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
