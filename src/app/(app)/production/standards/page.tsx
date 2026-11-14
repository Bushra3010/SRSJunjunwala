import { Card, Empty, Flash, Note, PageHeader, Tabs } from "@/components/ui";
import { ProductionNav } from "@/components/production";
import { requireModule } from "@/lib/auth";
import { PRODUCTION_APPROVERS } from "@/lib/roles";
import { dateTime } from "@/lib/format";
import { addOutputType, saveStandards, toggleOutputType } from "../actions";

export const metadata = { title: "Recovery standards · Production" };

type Output = { id: string; code: string; name: string; kind: "rice" | "by_product"; reference_pct: number | null; sort_order: number; active: boolean };
type Std = { grade_id: string; std_pct: number; min_pct: number | null; max_pct: number | null; updated_at: string };

export default async function StandardsPage({ searchParams }: { searchParams: Promise<{ variety?: string; error?: string; notice?: string }> }) {
  const sp = await searchParams;
  const { profile, supabase } = await requireModule("processing");
  const canEdit = PRODUCTION_APPROVERS.includes(profile.role);
  const [{ data: varieties }, { data: outputs }] = await Promise.all([
    supabase.from("varieties").select("id, code, name, std_tank_kg").eq("active", true).order("name"),
    supabase.from("rice_grades").select("id, code, name, kind, reference_pct, sort_order, active").order("sort_order"),
  ]);
  const vs = varieties ?? [];
  const variety = vs.find((v) => v.id === sp.variety) ?? vs[0];
  const { data: stds } = variety
    ? await supabase.from("variety_output_standards").select("grade_id, std_pct, min_pct, max_pct, updated_at").eq("variety_id", variety.id)
    : { data: [] };
  const byGrade = new Map(((stds ?? []) as Std[]).map((s) => [s.grade_id, s]));
  const all = (outputs ?? []) as Output[];
  const active = all.filter((o) => o.active);
  const total = [...byGrade.values()].reduce((a, s) => a + Number(s.std_pct), 0);
  const lastUpdate = [...byGrade.values()].map((s) => s.updated_at).sort().at(-1);
  const here = `/production/standards${variety ? `?variety=${variety.id}` : ""}`;

  return (
    <>
      <PageHeader
        title="Recovery standards"
        description="Expected output from 100 q of paddy, per variety: each rice grade and by-product, with the range it should stay within. Final outputs are compared against these. Change them whenever your standards change."
        crumbs={[{ label: "Production", href: "/production" }]}
      />
      <ProductionNav active="standards" />
      <Flash error={sp.error} notice={sp.notice} />

      {vs.length === 0 ? (
        <Empty>Add paddy varieties in Admin → Masters first.</Empty>
      ) : (
        <>
          <Tabs tabs={vs.map((v) => ({ key: v.id, label: v.name, href: `/production/standards?variety=${v.id}` }))} active={variety!.id} />
          <Card
            tone="#1f6b32"
            title={`${variety!.name} — standard recovery`}
            actions={
              <span className={`text-[13px] font-bold ${total > 100.0001 ? "text-[#d10b0b]" : "text-muted"}`}>
                Total {total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}% {total > 100.0001 ? "— over 100%" : ""}
              </span>
            }
            className="mb-6"
          >
            <form action={saveStandards}>
              <input type="hidden" name="variety_id" value={variety!.id} />
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Type</th>
                      <th className="text-right">Standard %</th>
                      <th className="text-right">Minimum %</th>
                      <th className="text-right">Maximum %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((o) => {
                      const st = byGrade.get(o.id);
                      return (
                        <tr key={o.id}>
                          <td className="font-bold text-ink">
                            <input type="hidden" name="grade_id" value={o.id} />
                            {o.name}
                          </td>
                          <td className="text-xs">{o.kind === "rice" ? "Rice grade" : "By-product"}</td>
                          {(["std", "min", "max"] as const).map((k) => (
                            <td key={k} className="text-right">
                              <input
                                name={`${k}_${o.id}`}
                                type="number"
                                step="0.01"
                                min="0"
                                max="100"
                                defaultValue={st ? (k === "std" ? st.std_pct : k === "min" ? (st.min_pct ?? "") : (st.max_pct ?? "")) : ""}
                                placeholder={k === "std" && o.reference_pct !== null ? `e.g. ${o.reference_pct}` : "—"}
                                disabled={!canEdit}
                                className="input w-24 text-right"
                                aria-label={`${o.name} ${k === "std" ? "standard" : k === "min" ? "minimum" : "maximum"} % for ${variety!.name}`}
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
                <p className="text-[12px] text-muted">
                  Leave Standard blank to remove it. Minimum and maximum are optional; outputs outside them are flagged on the Outputs page.
                  {lastUpdate ? ` Last changed ${dateTime(lastUpdate)}.` : ""}
                </p>
                {canEdit ? <button className="btn-primary">Save {variety!.name} standards</button> : <span className="text-[12px] text-muted">Read-only for your role.</span>}
              </div>
            </form>
          </Card>
        </>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card tone="#c08a24" title="Outputs and by-products">
          <ul className="divide-y divide-line">
            {all.map((o) => (
              <li key={o.id} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${o.active ? "" : "opacity-60"}`}>
                <span>
                  <b className="text-ink">{o.name}</b> <span className="text-[12px] text-muted">· {o.kind === "rice" ? "rice grade" : "by-product"} · {o.code}</span>
                </span>
                {canEdit && (
                  <form action={toggleOutputType}>
                    <input type="hidden" name="id" value={o.id} />
                    <input type="hidden" name="active" value={o.active ? "false" : "true"} />
                    <input type="hidden" name="back" value={here} />
                    <button className="btn-secondary py-1">{o.active ? "Hide" : "Show"}</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
        {canEdit && (
          <Card tone="#7b4f8e" title="Add an output or by-product">
            <form action={addOutputType} className="grid gap-3 p-4 sm:grid-cols-2">
              <input type="hidden" name="back" value={here} />
              <div>
                <label className="label" htmlFor="out-name">Name</label>
                <input id="out-name" name="name" className="input" placeholder="e.g. Husk, Bran, Chalky" required />
              </div>
              <div>
                <label className="label" htmlFor="out-kind">Type</label>
                <select id="out-kind" name="kind" className="input" defaultValue="by_product">
                  <option value="by_product">By-product</option>
                  <option value="rice">Rice grade</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <Note>New outputs appear on the Outputs page for recording, and in every variety&apos;s standards above.</Note>
              </div>
              <button className="btn-primary sm:col-span-2">Add output</button>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
