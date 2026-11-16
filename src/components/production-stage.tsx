import { randomUUID } from "node:crypto";
import { Card, Empty, Flash, Note, PageHeader } from "@/components/ui";
import {
  BatchFilters,
  BatchLink,
  BatchTable,
  CancelForm,
  CompleteForm,
  EquipmentTile,
  FinishSteamingForm,
  ProductionNav,
  Qty,
  SoakingNow,
  SoakingStartButton,
  StartForm,
  UnloadedSummary,
  type UnloadedRow,
} from "@/components/production";
import { requireModule } from "@/lib/auth";
import { PRODUCTION_APPROVERS, STAGE_OPERATORS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import {
  MILL_STEPS,
  STAGE_META,
  equipmentState,
  loadMasters,
  q,
  readyBatches,
  stageHistory,
  type Batch,
  type Equipment,
  type Stage,
  type StageSP,
} from "@/lib/production";
import { millingStep, startDryer, startMillingFromDryer, startSteamingLot, stopDryer, stopSoaking } from "@/app/(app)/production/actions";

type Kind = Equipment["kind"];

const CONFIG: Record<
  string,
  { kinds: Kind[]; tab: string; description: string; needsOutput: boolean; moisture?: boolean; mode: "generic" | "steaming" | "drying"; note?: string }
> = {
  precleaning: {
    kinds: ["precleaner"],
    tab: "precleaning",
    description: "Clean received paddy before soaking. Record input, cleaned output and cleaning loss.",
    needsOutput: true,
    mode: "generic",
  },
  soaking: {
    kinds: ["soaking_tank"],
    tab: "soaking",
    description: "Six tanks, about 12 hours. Press Start soaking on a free tank: the variety's standard weight per tank is taken from the unloaded paddy total. Each tank keeps its own batch ID and history.",
    needsOutput: false,
    mode: "generic",

  },
  steaming: {
    kinds: ["steamer"],
    tab: "steaming",
    description: "A lot is one or more finished tanks, usually a pair. The lot steams continuously, one tank after the other, and passes straight into the dryer you choose. One lot at a time.",
    needsOutput: false,
    mode: "steaming",
  },
  drying: {
    kinds: ["dryer"],
    tab: "drying",
    description: "A dryer fills as soaking tanks are stopped into it (they steam on the way). Start the dryer when it is full; stop it with the unload moisture and it unloads into its own feed tank (Dryer 1 → Feed tank 1).",
    needsOutput: true,
    moisture: true,
    mode: "drying",
  },
  mill_feed: {
    kinds: ["mill_feed_tank"],
    tab: "mill-feed",
    description: "Move dried paddy into mill feed tanks. A dryer batch can be split over several transfers; lineage is kept for each.",
    needsOutput: false,
    mode: "generic",
  },
  milling: {
    kinds: ["mill_line"],
    tab: "milling",
    description: "Start milling with the paddy from Dryer 1, 2 or 3. Cleaning → Dehusking → Whitener → Silky → Sortex → Grading, 4–6 hours per dryer batch.",
    needsOutput: true,
    mode: "generic",
    note: "Mixing paddy from different dryers in one milling batch needs a production manager's authorisation.",
  },
};

export async function StageScreen({ stage, sp }: { stage: Stage; sp: StageSP }) {
  const { profile } = await requireModule("processing");
  const cfg = CONFIG[stage];
  const meta = STAGE_META[stage];
  const canOperate = STAGE_OPERATORS[stage].includes(profile.role);
  const canManage = PRODUCTION_APPROVERS.includes(profile.role);
  const m = await loadMasters();
  const equipment = m.equipment.filter((e) => cfg.kinds.includes(e.kind));
  const [history, state, ready, unloadedRes] = await Promise.all([
    stageHistory(stage, sp),
    equipmentState(equipment.map((e) => e.id)),
    readyBatches(meta.parent!),
    // Soaking draws from the unloaded total per variety (standard weight per tank).
    stage === "soaking" ? m.supabase.rpc("unloaded_paddy_summary") : Promise.resolve({ data: [] }),
  ]);
  const running = history.batches.filter((b) => b.status === "running");
  const unloaded = (unloadedRes.data ?? []) as UnloadedRow[];
  const back = meta.href;
  const parentLabel = (b: Batch) => {
    const e = b.equipment_id ? m.equipmentById.get(b.equipment_id) : null;
    const v = b.variety_id ? m.varietyById.get(b.variety_id)?.name : "Mixed";
    const snap = b.source_snapshot;
    return [e?.name, v, snap ? `RST ${snap.rst} · ${snap.vehicle_no}` : null].filter(Boolean).join(" · ") + " · ";
  };

  // Steaming: soaking batches grouped by tank pair.
  const soakingByTank = new Map<number, { batch: Batch; available: number }>();
  if (cfg.mode === "steaming") {
    const tanks = m.equipment.filter((e) => e.kind === "soaking_tank");
    const tankState = await equipmentState(tanks.map((t) => t.id));
    for (const t of tanks) {
      const s = tankState.get(t.id);
      if (s) soakingByTank.set(t.number!, s);
    }
  }
  const steamer = equipment[0];
  const steamerBusy = steamer ? state.get(steamer.id) : undefined;
  // Any lot may go into any free dryer. A dryer is unavailable while it holds paddy or is
  // promised to a lot that is steaming right now.
  const dryerStatus: { id: string; name: string; number: number; usual: string; busy?: string; fillingKg: number; fillingLots: number; lotCount: number; fillingSince?: string }[] = [];
  if (cfg.mode === "steaming" || cfg.mode === "drying" || stage === "soaking") {
    const { data: fillRows } = await m.supabase.rpc("dryer_filling");
    const filling = new Map(((fillRows ?? []) as { dryer_id: string; lots: number; tanks?: number; filling_kg: number; first_at: string }[]).map((f) => [f.dryer_id, f]));
    const dryers = m.equipment.filter((e) => e.kind === "dryer");
    const ds = await equipmentState(dryers.map((d) => d.id));
    const { data: promised } = await m.supabase
      .from("production_batches")
      .select("batch_no, target_dryer_id")
      .eq("stage", "steaming")
      .eq("status", "running")
      .not("target_dryer_id", "is", null);
    for (const d of dryers) {
      const hold = ds.get(d.id)?.batch.batch_no ?? (promised ?? []).find((x) => x.target_dryer_id === d.id)?.batch_no;
      const f = filling.get(d.id);
      dryerStatus.push({
        id: d.id,
        name: d.name,
        number: d.number ?? 0,
        usual: d.pair_no ? `usually Tanks ${d.pair_no * 2 - 1} + ${d.pair_no * 2}` : "",
        busy: hold,
        fillingKg: Number(f?.filling_kg ?? 0),
        fillingLots: Number(f?.tanks ?? f?.lots ?? 0),
        lotCount: Number(f?.lots ?? 0),
        fillingSince: f?.first_at,
      });
    }
  }
  const freeDryers = dryerStatus.filter((d) => !d.busy);
  const dryerName = (id: string | null | undefined) => dryerStatus.find((d) => d.id === id)?.name;

  // Milling starts from one dryer's feed tank.
  const feedWaiting = new Map<number, { waiting_kg: number; lots: number; since: string }>();
  if (stage === "milling") {
    const { data } = await m.supabase.rpc("feed_tanks_waiting");
    for (const r of (data ?? []) as { dryer_no: number; waiting_kg: number; lots: number; since: string }[]) feedWaiting.set(r.dryer_no, r);
  }

  // Milling: step progress for running batches.
  const steps = new Map<string, { step: string; started_at: string | null; ended_at: string | null }[]>();
  if (stage === "milling" && running.length) {
    const { data } = await m.supabase.from("milling_stage_events").select("batch_id, step, started_at, ended_at").in("batch_id", running.map((r) => r.id));
    for (const r of data ?? []) steps.set(r.batch_id, [...(steps.get(r.batch_id) ?? []), r]);
  }

  return (
    <>
      <PageHeader
        title={`${meta.label}${meta.local ? ` (${meta.local})` : ""}`}
        description={cfg.description}
        crumbs={[{ label: "Production", href: "/production" }]}
      />
      <ProductionNav active={cfg.tab} />
      <Flash error={sp.error} notice={sp.notice} />

      <div className={`mb-6 grid gap-4 ${equipment.length >= 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2"}`}>
        {equipment.map((e) => {
          const s = state.get(e.id);
          return (
            <EquipmentTile
              key={e.id}
              eq={e}
              batch={s?.batch}
              available={s?.available}
              sub={
                e.capacity_max_kg
                    ? `${q(e.capacity_min_kg, 0)}–${q(e.capacity_max_kg, 0)} · ${e.expected_hours_min}${e.expected_hours_max !== e.expected_hours_min ? `–${e.expected_hours_max}` : ""} h`
                    : undefined
              }
            >
              {stage === "soaking" && canOperate && !s ? <SoakingStartButton tank={e} rows={unloaded} back={back} /> : null}
            </EquipmentTile>
          );
        })}
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        {stage === "soaking" && (
          <Card tone="#4b5563" title="Unloaded paddy waiting for a tank" className="xl:col-span-2">
            <UnloadedSummary rows={unloaded} />
            <p className="border-t border-line px-5 py-3 text-[12px] text-muted">
              Press <b>Start soaking</b> on a free tank: the variety&apos;s standard weight per tank is taken from this total, oldest trucks first. Standard weights are set in Admin → Masters → Varieties.
            </p>
          </Card>
        )}
        {stage === "soaking" && (
          <Card tone={meta.color} title={`Soaking now (${running.length} of ${equipment.length} tanks)`} className="xl:col-span-2">
            <SoakingNow batches={running} equipmentById={m.equipmentById} varietyName={(id) => (id ? (m.varietyById.get(id)?.name ?? "—") : "Mixed")} userName={m.userName} />
          </Card>
        )}
        {canOperate && stage !== "soaking" && (
          <Card tone={meta.color} title={cfg.mode === "steaming" ? "Start steaming a lot" : cfg.mode === "drying" ? "Dryers: filling and start" : stage === "milling" ? "Start milling" : `Start ${meta.label.toLowerCase()}`}>
            {cfg.note && (
              <div className="px-4 pt-4">
                <Note>{cfg.note}</Note>
              </div>
            )}
            {cfg.mode === "steaming" ? (
              <form action={startSteamingLot} className="space-y-4 p-4">
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="request_id" value={randomUUID()} />
                <p className="text-[13px] text-muted">
                  Pick the finished tanks for this lot and the dryer it goes into. Usually Tank 1 + 2 go to Dryer 1, 3 + 4 to Dryer 2 and 5 + 6 to Dryer 3, but any tank can go to any free dryer.
                </p>
                <fieldset>
                  <legend className="label">Soaking tanks in this lot</legend>
                  <ul className="grid gap-2 sm:grid-cols-3">
                    {m.equipment
                      .filter((e) => e.kind === "soaking_tank")
                      .map((t) => {
                        const st = soakingByTank.get(t.number!);
                        const ready = st?.batch.status === "completed";
                        return (
                          <li key={t.id}>
                            <label className={`flex items-start gap-2 rounded-md border p-2.5 ${ready ? "border-line bg-white" : "border-dashed border-line opacity-60"}`}>
                              <input type="checkbox" name="pick" value={st?.batch.id ?? ""} disabled={!ready} className="mt-0.5 size-4 accent-[#1f6b32]" />
                              <span className="min-w-0 text-[12px]">
                                <span className="block text-[13px] font-bold text-ink">{t.name.replace("Soaking ", "")}</span>
                                {st ? (
                                  <span className="text-muted">
                                    {st.batch.batch_no} · {st.batch.status === "running" ? "still soaking" : `ready · ${q(st.available)}`}
                                  </span>
                                ) : (
                                  <span className="text-muted">empty</span>
                                )}
                              </span>
                            </label>
                          </li>
                        );
                      })}
                  </ul>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label" htmlFor="lot-dryer">Goes into dryer</label>
                    <select id="lot-dryer" name="dryer_id" className="input" required defaultValue="">
                      <option value="" disabled>
                        {freeDryers.length ? "Select a free dryer…" : "All dryers are full"}
                      </option>
                      {dryerStatus.map((d) => (
                        <option key={d.id} value={d.id} disabled={!!d.busy}>
                          {d.name}
                          {d.busy ? ` — full (${d.busy})` : ` — free${d.usual ? `, ${d.usual}` : ""}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="lot-start">Steaming start (blank = now)</label>
                    <input id="lot-start" type="datetime-local" name="started_at" className="input" />
                  </div>
                </div>
                <button className="btn-primary" disabled={!!steamerBusy || freeDryers.length === 0}>
                  {steamerBusy ? "Steamer in use" : "Start steaming lot"}
                </button>
              </form>
            ) : cfg.mode === "drying" ? (
              <ul className="divide-y divide-line">
                {dryerStatus.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold text-ink">{d.name}</div>
                      <div className="text-[12px] text-muted">
                        {d.busy
                          ? `Drying or holding dried paddy (${d.busy}) — stop it below`
                          : d.fillingLots
                            ? `Filling: ${q(d.fillingKg)} from ${d.fillingLots} tank${d.fillingLots > 1 ? "s" : ""} in ${d.lotCount} lot${d.lotCount > 1 ? "s" : ""} since ${dateTime(d.fillingSince)}`
                            : "Empty — stop a soaking tank into it to start filling"}
                      </div>
                    </div>
                    {!d.busy && d.fillingLots > 0 && (
                      <form action={startDryer} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="dryer_id" value={d.id} />
                        <input type="hidden" name="back" value={back} />
                        <input type="hidden" name="request_id" value={randomUUID()} />
                        <input type="datetime-local" name="started_at" className="input w-auto" aria-label={`${d.name} start time (blank = now)`} />
                        <button className="btn-primary">Start drying</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            ) : stage === "milling" ? (
              <div className="space-y-3 p-4">
                <p className="text-[13px] text-muted">Which dryer&apos;s paddy did the mill receive? Each dryer unloads into its own feed tank.</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[1, 2, 3].map((n) => {
                    const w = feedWaiting.get(n);
                    return (
                      <form key={n} action={startMillingFromDryer} className="flex flex-col gap-2 rounded-md border border-line p-3">
                        <input type="hidden" name="dryer_no" value={n} />
                        <input type="hidden" name="line_id" value={equipment[0]?.id} />
                        <input type="hidden" name="back" value={back} />
                        <input type="hidden" name="request_id" value={randomUUID()} />
                        <div className="text-[14px] font-bold text-ink">Dryer {n}</div>
                        <div className="text-[12px] text-muted">{w ? `${q(w.waiting_kg)} waiting in feed tank ${n}` : `Feed tank ${n} is empty`}</div>
                        <input type="datetime-local" name="started_at" className="input" aria-label={`Milling start for Dryer ${n} paddy (blank = now)`} />
                        <button className="btn-primary" disabled={!w}>
                          Start milling Dryer {n}
                        </button>
                      </form>
                    );
                  })}
                </div>
              </div>
            ) : (
              <StartForm
                stage={stage}
                equipment={equipment.filter((e) => !(["soaking_tank", "precleaner"].includes(e.kind) && state.get(e.id)))}
                candidates={ready.map((c) => ({ ...c, label: parentLabel(c.batch) }))}
                back={back}
                canAuthorize={canManage}
                submitLabel={stage === "mill_feed" ? "Record transfer" : "Start batch"}
              />
            )}
          </Card>
        )}

        {stage !== "mill_feed" && (
          <Card tone="#3e6fc0" title={stage === "soaking" ? `Finish soaking (${running.length})` : `Running now (${running.length})`}>
            {running.length === 0 ? (
              <Empty>Nothing running.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {running.map((b) => (
                  <li key={b.id} className="space-y-2 px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <BatchLink no={b.batch_no} />{" "}
                        <span className="text-[12px] text-muted">
                          {b.equipment_id ? m.equipmentById.get(b.equipment_id)?.name : ""}
                          {b.target_dryer_id ? ` → ${dryerName(b.target_dryer_id) ?? "dryer"}` : ""} · started {dateTime(b.started_at)} · by {m.userName(b.operator_id)}
                        </span>
                      </div>
                      <Qty kg={b.input_kg} />
                    </div>
                    {stage === "milling" && (
                      <div className="flex flex-wrap gap-1.5">
                        {MILL_STEPS.map((s, i) => {
                          const r = steps.get(b.id)?.find((x) => x.step === s);
                          const prevStarted = i === 0 || steps.get(b.id)?.some((x) => x.step === MILL_STEPS[i - 1]);
                          const action = !r ? "start" : !r.ended_at ? "end" : null;
                          return (
                            <form key={s} action={millingStep}>
                              <input type="hidden" name="id" value={b.id} />
                              <input type="hidden" name="step" value={s} />
                              <input type="hidden" name="back" value={back} />
                              <input type="hidden" name="action_type" value={action ?? "end"} />
                              <button
                                disabled={!canOperate || !action || (action === "start" && !prevStarted)}
                                title={r ? `${dateTime(r.started_at)} → ${r.ended_at ? dateTime(r.ended_at) : "running"}` : "Not started"}
                                className={`rounded-md border px-2 py-1 text-[11px] font-bold capitalize ${
                                  r?.ended_at ? "border-[#0a8f44] bg-[#0a8f44] text-white" : r ? "border-[#3e6fc0] bg-[#3e6fc0] text-white" : "border-line bg-white text-ink"
                                } disabled:cursor-default`}
                              >
                                {i + 1}. {s}
                                {action === "start" && prevStarted ? " ▶" : action === "end" ? " ■" : r?.ended_at ? " ✓" : ""}
                              </button>
                            </form>
                          );
                        })}
                      </div>
                    )}
                    {canOperate && (
                      <div className="flex flex-wrap items-start gap-2">
                        {stage === "steaming" ? (
                          <FinishSteamingForm batch={b} back={back} dryer={dryerName(b.target_dryer_id) ?? "the dryer"} />
                        ) : stage === "soaking" ? (
                          <form action={stopSoaking} className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-[#fbf8ef] p-3">
                            <input type="hidden" name="id" value={b.id} />
                            <input type="hidden" name="batch_no" value={b.batch_no} />
                            <input type="hidden" name="back" value={back} />
                            <div>
                              <label className="label" htmlFor={`dry-${b.id}`}>Into dryer</label>
                              <select id={`dry-${b.id}`} name="dryer_id" className="input w-auto" required defaultValue={
                                (dryerStatus.find((d) => !d.busy && d.fillingLots > 0) ?? dryerStatus.find((d) => !d.busy && d.number === m.equipmentById.get(b.equipment_id ?? "")?.pair_no) ?? dryerStatus.find((d) => !d.busy))?.id ?? ""
                              }>
                                <option value="" disabled>
                                  {dryerStatus.some((d) => !d.busy) ? "Choose…" : "All dryers busy"}
                                </option>
                                {dryerStatus.map((d) => (
                                  <option key={d.id} value={d.id} disabled={!!d.busy}>
                                    {d.name}
                                    {d.busy ? " — drying" : d.fillingLots ? ` — filling (${q(d.fillingKg)})` : " — empty"}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="label" htmlFor={`end-${b.id}`}>Soaking stop (blank = now)</label>
                              <input id={`end-${b.id}`} name="ended_at" type="datetime-local" className="input w-auto" />
                            </div>
                            <button className="btn-primary">Stop soaking → steam into dryer</button>
                          </form>
                        ) : stage === "drying" ? (
                          <form action={stopDryer} className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-[#fbf8ef] p-3">
                            <input type="hidden" name="id" value={b.id} />
                            <input type="hidden" name="batch_no" value={b.batch_no} />
                            <input type="hidden" name="back" value={back} />
                            <div>
                              <label className="label" htmlFor={`m-${b.id}`}>Unload moisture %</label>
                              <input id={`m-${b.id}`} name="moisture_pct" type="number" step="0.1" min="0" max="60" className="input w-28" required />
                            </div>
                            <div>
                              <label className="label" htmlFor={`o-${b.id}`}>Output q (if weighed)</label>
                              <input id={`o-${b.id}`} name="output_q" type="number" step="any" min="0.01" className="input w-32" placeholder="blank = estimate" />
                            </div>
                            <div>
                              <label className="label" htmlFor={`e-${b.id}`}>Dryer stop (blank = now)</label>
                              <input id={`e-${b.id}`} name="ended_at" type="datetime-local" className="input w-auto" />
                            </div>
                            <button className="btn-primary">Stop dryer → unload to feed tank {m.equipmentById.get(b.equipment_id ?? "")?.number ?? ""}</button>
                          </form>
                        ) : (
                          <CompleteForm batch={b} back={back} needsOutput={cfg.needsOutput} moisture={cfg.moisture} />
                        )}
                        {canManage && <CancelForm batch={b} back={back} />}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>

      <Card tone={meta.color} title={`${meta.label} history`}>
        <BatchFilters action={back} sp={sp} />
        {history.error ? (
          <div className="p-4">
            <Flash error={history.error.message} />
          </div>
        ) : history.batches.length === 0 ? (
          <Empty>No {meta.label.toLowerCase()} batches match.</Empty>
        ) : (
          <BatchTable
            batches={history.batches}
            equipmentById={m.equipmentById}
            userName={m.userName}
            extra={
              stage === "drying"
                ? { head: "Moisture", cell: (b) => (b.moisture_pct === null ? "—" : `${b.moisture_pct}%`) }
                : stage === "steaming"
                  ? { head: "Into dryer", cell: (b) => (b.target_dryer_id ? (m.equipmentById.get(b.target_dryer_id)?.name ?? "—") : "—") }
                  : undefined
            }
          />
        )}
      </Card>
    </>
  );
}
