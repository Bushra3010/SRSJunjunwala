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
  SoakingStartForm,
  StartForm,
  type WaitingTruck,
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
import { millingStep, startBatch, startSteamingLot } from "@/app/(app)/production/actions";

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
    description: "Trucks go from the unloading bay straight into a tank. Six tanks, 12 hours, 150–180 q per tank. A truck may be split across tanks; each tank keeps its own batch ID and history.",
    needsOutput: false,
    mode: "generic",
    note: "Soaked paddy absorbs water. Weigh it if you can; otherwise leave output blank and it is carried forward as an estimate.",
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
    description: "Three dryers, 12–14 hours, 270–340 q each. Any steaming lot can go into any free dryer.",
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
    description: "Cleaning → Dehusking → Whitener → Silky → Sortex → Grading. 4–6 hours per dryer batch.",
    needsOutput: true,
    mode: "generic",
    note: "Milling more than one mill-feed lot together needs a production manager's authorisation.",
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
  const [history, state, ready, trucks] = await Promise.all([
    stageHistory(stage, sp),
    equipmentState(equipment.map((e) => e.id)),
    // Soaking takes trucks directly: receipts already in production with paddy left, plus posted QC trucks.
    readyBatches(stage === "soaking" ? "receipt" : meta.parent!),
    stage === "soaking" ? m.supabase.rpc("production_receivable_lines") : Promise.resolve({ data: [] }),
  ]);
  const running = history.batches.filter((b) => b.status === "running");
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
  const dryerStatus: { id: string; name: string; usual: string; busy?: string }[] = [];
  if (cfg.mode === "steaming" || cfg.mode === "drying") {
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
      dryerStatus.push({ id: d.id, name: d.name, usual: d.pair_no ? `usually Tanks ${d.pair_no * 2 - 1} + ${d.pair_no * 2}` : "", busy: hold });
    }
  }
  const freeDryers = dryerStatus.filter((d) => !d.busy);
  const dryerName = (id: string | null | undefined) => dryerStatus.find((d) => d.id === id)?.name;

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
            />
          );
        })}
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        {canOperate && (
          <Card tone={meta.color} title={cfg.mode === "steaming" ? "Start steaming a lot" : cfg.mode === "drying" ? "Load a dryer" : stage === "soaking" ? "Load a tank from trucks" : `Start ${meta.label.toLowerCase()}`}>
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
              ready.length === 0 ? (
                <Empty>No steamed batch is waiting for a dryer.</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {ready.map(({ batch: b, available }) => (
                    <li key={b.id}>
                      <form action={startBatch} className="flex flex-wrap items-center gap-3 px-4 py-3">
                        <input type="hidden" name="stage" value="drying" />
                        <input type="hidden" name="back" value={back} />
                        <input type="hidden" name="request_id" value={randomUUID()} />
                        <input type="hidden" name="pick" value={b.id} />
                        <div className="min-w-0 flex-1">
                          <BatchLink no={b.batch_no} />
                          <div className="text-[12px] text-muted">{q(available)} steamed</div>
                        </div>
                        <select name="equipment_id" className="input w-auto" required defaultValue={freeDryers.find((d) => d.id === b.target_dryer_id)?.id ?? ""} aria-label="Dryer">
                          <option value="" disabled>
                            Dryer…
                          </option>
                          {freeDryers.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                        <input type="datetime-local" name="started_at" className="input w-auto" aria-label="Start time (blank = now)" />
                        <button className="btn-primary" disabled={freeDryers.length === 0}>
                          Load dryer
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )
            ) : stage === "soaking" ? (
              <SoakingStartForm
                tanks={equipment.filter((e) => !state.get(e.id))}
                trucks={(trucks.data ?? []) as WaitingTruck[]}
                receipts={ready.map((c) => ({ ...c, label: parentLabel(c.batch) }))}
                back={back}
                canAuthorize={canManage}
              />
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
          <Card tone="#3e6fc0" title={`Running now (${running.length})`}>
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
                : stage === "steaming" || stage === "soaking"
                  ? { head: "Pair", cell: (b) => (b.pair_no ? `Tanks ${b.pair_no * 2 - 1}+${b.pair_no * 2}` : "—") }
                  : undefined
            }
          />
        )}
      </Card>
    </>
  );
}
