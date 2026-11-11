import { PageHeader, Note } from "@/components/ui";

export function Planned({ title, phase, items }: { title: string; phase: string; items: string[] }) {
  return (
    <>
      <PageHeader title={title} description={`Planned for ${phase} of the rollout (PRD §13).`} />
      <div className="card max-w-2xl p-6">
        <Note>This module is not built yet. The database already keeps the lot and stock references it will use.</Note>
        <h2 className="mt-5 text-sm font-semibold text-slate-900">Scope</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </div>
    </>
  );
}
