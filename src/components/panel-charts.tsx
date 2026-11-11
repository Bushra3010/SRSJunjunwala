"use client";

import { useState } from "react";

type Series = { key: string; label: string; color: string };

function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s) ?? 10;
  return step * pow;
}

export function Legend({ items }: { items: { label: string; color: string; extra?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs font-semibold text-[#6b7280]">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full" style={{ background: i.color }} aria-hidden />
          {i.label}
          {i.extra && <span className="font-semibold text-[#1b2a1f]">{i.extra}</span>}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------------
 * Grouped bars — one group per month, thin rounded bars, 2px gap between bars.
 * ------------------------------------------------------------------------- */
export function GroupedBars({
  rows,
  series,
  unit,
  label,
}: {
  rows: Record<string, string | number>[];
  series: readonly Series[];
  unit: string;
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 230;
  const padL = 40;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = niceMax(Math.max(...rows.flatMap((r) => series.map((s) => Number(r[s.key])))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const groupW = plotW / rows.length;
  const barW = Math.min(12, (groupW - 16) / series.length - 2);
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const bar = (x: number, v: number) => {
    const top = y(v);
    const h = padT + plotH - top;
    const r = Math.min(4, barW / 2, h);
    return `M${x},${padT + plotH} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${padT + plotH} Z`;
  };

  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#eef1f6" strokeWidth={1} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="fill-[#8a94a6] text-[11px]">
                {t >= 1000 ? `${(t / 1000).toLocaleString("en-IN")}K` : t}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const gx = padL + i * groupW;
            const total = series.length * barW + (series.length - 1) * 2;
            const start = gx + (groupW - total) / 2;
            return (
              <g key={String(r.month)} opacity={hover === null || hover === i ? 1 : 0.45}>
                {series.map((s, si) => (
                  <path key={s.key} d={bar(start + si * (barW + 2), Number(r[s.key]))} fill={s.color} />
                ))}
                <text x={gx + groupW / 2} y={H - 6} textAnchor="middle" className="fill-[#8a94a6] text-[11px] uppercase">
                  {String(r.month)}
                </text>
                <rect
                  x={gx}
                  y={padT}
                  width={groupW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  tabIndex={0}
                  aria-label={`${r.month}: ${series.map((s) => `${s.label} ${r[s.key]} ${unit}`).join(", ")}`}
                />
              </g>
            );
          })}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 rounded-xl bg-[#1b2a1f] px-3 py-2 text-xs text-white shadow-lg"
            style={{ left: `${((padL + (hover + 0.5) * groupW) / W) * 100}%` }}
          >
            <div className="mb-1 font-semibold">{String(rows[hover]!.month)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-2 whitespace-nowrap">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
                <span className="ml-auto pl-3 font-semibold tabular-nums">
                  {Number(rows[hover]![s.key]).toLocaleString("en-IN")} {unit}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <DataTable
        caption={label}
        head={["Month", ...series.map((s) => `${s.label} (${unit})`)]}
        rows={rows.map((r) => [String(r.month), ...series.map((s) => Number(r[s.key]).toLocaleString("en-IN"))])}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Line with hatched area, crosshair + tooltip on hover.
 * ------------------------------------------------------------------------- */
export function HatchedArea({
  points,
  color,
  highlight,
  prefix = "",
  suffix = "",
  label,
  defaultIndex,
}: {
  points: { month: string; value: number }[];
  color: string;
  highlight: string;
  prefix?: string;
  suffix?: string;
  label: string;
  defaultIndex?: number;
}) {
  const format = (n: number) => `${prefix}${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}${suffix}`;
  const [hover, setHover] = useState<number | null>(defaultIndex ?? null);
  const W = 720;
  const H = 230;
  const padL = 40;
  const padR = 14;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = niceMax(Math.max(...points.map((p) => p.value)) * 1.1);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const x = (i: number) => padL + (i / (points.length - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const area = `${line} L${x(points.length - 1)},${padT + plotH} L${x(0)},${padT + plotH} Z`;
  const step = plotW / (points.length - 1);

  return (
    <div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label}>
          <defs>
            <pattern id="hatch-blue" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="10" fill={color} />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#eef1f6" strokeWidth={1} />
              <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="fill-[#8a94a6] text-[11px]">
                {t}
              </text>
            </g>
          ))}
          <path d={area} fill="url(#hatch-blue)" opacity={0.85} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => (
            <g key={p.month}>
              <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 3.5} fill={color} stroke="#fff" strokeWidth={2} />
              <text x={x(i)} y={H - 6} textAnchor="middle" className="fill-[#8a94a6] text-[11px] uppercase">
                {p.month}
              </text>
            </g>
          ))}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={y(points[hover]!.value)} y2={padT + plotH} stroke={highlight} strokeWidth={3} strokeLinecap="round" />
          )}
          {points.map((p, i) => (
            <rect
              key={`hit-${p.month}`}
              x={x(i) - step / 2}
              y={padT}
              width={step}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${p.month}: ${format(p.value)}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-[#1b2a1f] px-3 py-2 text-white shadow-lg"
            style={{ left: `${(x(hover) / W) * 100}%`, top: `${((y(points[hover]!.value) - 10) / H) * 100}%` }}
          >
            <div className="text-[11px] opacity-75">{points[hover]!.month} total</div>
            <div className="text-sm font-semibold tabular-nums">{format(points[hover]!.value)}</div>
          </div>
        )}
      </div>
      <DataTable caption={label} head={["Month", "Value"]} rows={points.map((p) => [p.month, format(p.value)])} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Ring donut with rounded, separated segments; centre shows total or hovered segment.
 * ------------------------------------------------------------------------- */
export function RingDonut({
  segments,
  total,
  totalLabel,
}: {
  segments: { label: string; value: number; color: string }[];
  total: number;
  totalLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const R = 80;
  const C = 2 * Math.PI * R;
  const sum = segments.reduce((s, x) => s + x.value, 0);
  const gap = 18; // px of circumference between segments (plus round caps)
  let offset = 0;
  const arcs = segments.map((s) => {
    const len = (s.value / sum) * C;
    const a = { ...s, dash: Math.max(0, len - gap), offset };
    offset += len;
    return a;
  });
  const shown = hover === null ? null : segments[hover]!;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[230px]">
      <svg viewBox="0 0 200 200" className="h-full w-full -rotate-90" role="img" aria-label={`${totalLabel}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
        {arcs.map((a, i) => (
          <circle
            key={a.label}
            cx="100"
            cy="100"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth={hover === i ? 20 : 16}
            strokeLinecap="round"
            strokeDasharray={`${a.dash} ${C - a.dash}`}
            strokeDashoffset={-a.offset - gap / 2}
            className="cursor-pointer transition-all"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${a.label}: ${a.value}`}</title>
          </circle>
        ))}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-sm text-[#6b7280]">{shown ? shown.label : totalLabel}</div>
          <div className="text-4xl font-medium tracking-tight text-[#1b2a1f] tabular-nums">{(shown ? shown.value : total).toLocaleString("en-IN")}</div>
        </div>
      </div>
    </div>
  );
}

function DataTable({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <details className="mt-2 text-xs text-[#6b7280]">
      <summary className="cursor-pointer select-none hover:text-[#1b2a1f]">Show data table</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} className="py-1 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[0]} className="border-t border-[#e9edf4]">
                {r.map((c, i) => (
                  <td key={i} className={`py-1 pr-3 ${i ? "tabular-nums" : ""}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/* ---------------------------------------------------------------------------
 * Semicircle gauge with separated, rounded segments (status breakdown).
 * ------------------------------------------------------------------------- */
export function Gauge({
  segments,
  total,
  totalLabel,
}: {
  segments: { label: string; value: number; color: string }[];
  total: number;
  totalLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const R = 90;
  const half = Math.PI * R;
  const sum = segments.reduce((s, x) => s + x.value, 0);
  const gap = 10;
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const len = sum ? (s.value / sum) * half : 0;
      const a = { ...s, dash: Math.max(0.01, len - gap), offset };
      offset += len;
      return a;
    });
  const shown = hover === null ? null : arcs[hover]!;
  return (
    <div className="relative mx-auto w-full max-w-[280px]">
      <svg viewBox="0 0 220 120" className="block w-full" role="img" aria-label={`${totalLabel}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}>
        <path d="M20,110 A90,90 0 0 1 200,110" fill="none" stroke="#eef1f6" strokeWidth={26} strokeLinecap="round" />
        {sum > 0 &&
          arcs.map((a, i) => (
            <path
              key={a.label}
              d="M20,110 A90,90 0 0 1 200,110"
              fill="none"
              stroke={a.color}
              strokeWidth={hover === i ? 30 : 26}
              strokeLinecap="round"
              strokeDasharray={`${a.dash} ${half * 2}`}
              strokeDashoffset={-a.offset - gap / 2}
              className="cursor-pointer transition-all"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${a.label}: ${a.value}`}</title>
            </path>
          ))}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="text-xs font-semibold text-[#6b7280]">{shown ? shown.label : totalLabel}</div>
        <div className="text-[26px] font-bold text-[#1b2a1f] tabular-nums">{(shown ? shown.value : total).toLocaleString("en-IN")}</div>
      </div>
    </div>
  );
}

/** Single horizontal stacked bar with 2px gaps; legend/values rendered by the caller. */
export function StackedBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const sum = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className="flex h-6 w-full gap-[2px] overflow-hidden rounded-md bg-[#eef1f6]" role="img" aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <div key={s.label} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / sum) * 100}%`, background: s.color }} />
        ))}
    </div>
  );
}
