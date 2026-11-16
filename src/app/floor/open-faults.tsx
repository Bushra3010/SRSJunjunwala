import { CircleCheck, TriangleAlert } from "lucide-react";
import { fixFault } from "@/app/mill/actions";
import { PressButton } from "./floor-client";

export type OpenFault = { id: string; machine: string; details: string; severity?: string; started_at: string };

const TZ = "Asia/Kolkata";
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
function down(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/**
 * Open faults with a running downtime and a "Fixed" button, so the operator closes the
 * fault the moment the machine runs again (downtime stops at that time).
 */
export function OpenFaults({ faults, back, canFix, hindi = false }: { faults: OpenFault[]; back: string; canFix: boolean; hindi?: boolean }) {
  if (!faults.length) return null;
  const t = (hi: string, en: string) => (hindi ? `${hi} / ${en}` : en);
  return (
    <section className="overflow-hidden rounded-2xl border-2 border-[#f3b4b7] bg-white shadow-sm" aria-label={t("खुले फॉल्ट", "Open faults")}>
      <h2 className="flex items-center gap-2 bg-[#fdecec] px-4 py-2.5 text-[15px] font-extrabold text-[#a11a1a]">
        <TriangleAlert className="size-5" /> {t("खुले फॉल्ट", "Open faults")} ({faults.length})
      </h2>
      <ul className="divide-y divide-[#f1d5d6]">
        {faults.map((f) => (
          <li key={f.id} className="grid gap-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[15px] font-extrabold">{f.machine}</div>
                <div className="text-[13px] text-[#475569]">{f.details}</div>
              </div>
              <div className="text-right text-[12px] leading-tight">
                <div className="text-[18px] font-extrabold tabular-nums text-[#a11a1a]">{down(f.started_at)}</div>
                <div className="text-[#64748b]">
                  {t("बंद", "down")} · {t(`${time(f.started_at)} से`, `since ${time(f.started_at)}`)}
                </div>
              </div>
            </div>
            {canFix && (
              <details className="group rounded-xl border border-[#cfe3d4] bg-[#f3faf5] open:pb-3">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-center gap-2 rounded-xl bg-[#22813d] px-3 text-[15px] font-bold text-white group-open:rounded-b-none">
                  <CircleCheck className="size-5" /> {t("ठीक हो गया — मशीन चालू", "Fixed — machine running")}
                </summary>
                <form action={fixFault} className="grid gap-2 px-3 pt-3">
                  <input type="hidden" name="id" value={f.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="machine" value={f.machine} />
                  <label className="grid gap-1 text-[13px] font-bold">
                    {t("क्या किया गया? (वैकल्पिक)", "What was done? (optional)")}
                    <input name="resolution" className="input min-h-11 text-[15px] font-normal" placeholder={t("जैसे बेल्ट बदली", "e.g. belt replaced")} />
                  </label>
                  <label className="grid gap-1 text-[13px] font-bold">
                    {t("कब ठीक हुआ? (खाली = अभी)", "Fixed at (blank = now)")}
                    <input name="fixed_at" type="time" className="input min-h-11 text-[16px]" />
                  </label>
                  <PressButton tone="start" pendingText={hindi ? "रुकिए… / Saving…" : "Saving…"}>
                    <CircleCheck className="size-5" /> {t("सेव करें — फॉल्ट ठीक", "Save — fault fixed")}
                  </PressButton>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
