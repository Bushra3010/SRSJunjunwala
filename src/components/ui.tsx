import Link from "next/link";
import clsx from "clsx";
import { AlertCircle, ArrowDown, ArrowUp, CalendarDays, CheckCircle2, ChevronRight, Home, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ---------------------------------------------------------------------------
 * Status pills — solid, small, always a word (never colour alone).
 * ------------------------------------------------------------------------- */
type Tone = "green" | "amber" | "red" | "blue" | "slate" | "purple" | "orange" | "navy";

const TONES: Record<Tone, string> = {
  green: "bg-[#0a8f44] text-white",
  amber: "bg-[#ffc107] text-[#1b2a1f]",
  red: "bg-[#d10b0b] text-white",
  blue: "bg-[#3e6fc0] text-white",
  slate: "bg-[#e9edf4] text-[#4b5563]",
  purple: "bg-[#7b5e2a] text-white",
  orange: "bg-[#1f6b32] text-white",
  navy: "bg-[#14532d] text-white",
};

export function Badge({ tone = "slate", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-[11px] font-bold whitespace-nowrap", TONES[tone])}>{children}</span>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  // tickets
  awaiting_qc: { label: "Awaiting QC", tone: "amber" },
  qc_in_progress: { label: "QC in progress", tone: "blue" },
  submitted: { label: "Submitted", tone: "purple" },
  posted: { label: "Posted", tone: "green" },
  duplicate: { label: "Duplicate", tone: "red" },
  exception: { label: "Exception", tone: "red" },
  cancelled: { label: "Cancelled", tone: "slate" },
  // qc
  draft: { label: "Draft", tone: "slate" },
  reversed: { label: "Reversed", tone: "red" },
  // orders
  open: { label: "Open", tone: "blue" },
  closed: { label: "Closed", tone: "slate" },
  partial: { label: "Partially fulfilled", tone: "orange" },
  fulfilled: { label: "Fulfilled", tone: "green" },
  not_started: { label: "Not started", tone: "navy" },
  // production batches
  running: { label: "Running", tone: "blue" },
  completed: { label: "Ready for next stage", tone: "amber" },
  consumed: { label: "Moved on", tone: "green" },
  // quantity trust levels
  estimated: { label: "Estimated", tone: "amber" },
  entered: { label: "Operator entered", tone: "blue" },
  approved: { label: "Approved", tone: "navy" },
  confirmed: { label: "Physically confirmed", tone: "green" },
  // quality
  pending: { label: "Quality pending", tone: "slate" },
  passed: { label: "Quality passed", tone: "green" },
  hold: { label: "On hold", tone: "amber" },
  rejected: { label: "Rejected", tone: "red" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "slate" as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/* ---------------------------------------------------------------------------
 * Page title with breadcrumb.
 * ------------------------------------------------------------------------- */
export function PageHeader({
  title,
  description,
  actions,
  crumbs = [],
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  crumbs?: { label: string; href?: string }[];
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-bold tracking-tight text-ink">{title}</h1>
        <nav aria-label="Breadcrumb" className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-muted">
          <Link href="/" className="hover:text-accent" aria-label="Home">
            <Home className="size-3.5" />
          </Link>
          {crumbs.map((c) => (
            <span key={c.label} className="flex items-center gap-1.5">
              <ChevronRight className="size-3 text-gray-400" />
              {c.href ? (
                <Link href={c.href} className="hover:text-accent">
                  {c.label}
                </Link>
              ) : (
                c.label
              )}
            </span>
          ))}
          <ChevronRight className="size-3 text-gray-400" />
          <span className="text-ink">{title}</span>
        </nav>
        {description && <p className="mt-2 max-w-3xl text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("mb-6", className)}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
  tone = "#1f6b32",
  vivid = false,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Header tint colour; defaults to the brand orange. */
  tone?: string;
  /** Colourful header + border (Operations dashboard). */
  vivid?: boolean;
}) {
  return (
    <section className={clsx("card overflow-hidden", className)} style={vivid ? { borderColor: `${tone}40` } : undefined}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5" style={vivid ? vividTint(tone, "soft") : tint(tone, "soft")}>
          {title && (
            <h2 className="flex items-center gap-2 text-[16px] font-bold text-ink">
              <span className="h-4 w-1 rounded-full" style={{ background: tone }} aria-hidden />
              {title}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Restrained card surface: white with a faint wash of the card colour and a neutral border. */
export function tint(color: string, strength: "strong" | "soft" = "strong"): React.CSSProperties {
  return strength === "strong"
    ? { background: `linear-gradient(180deg, ${color}0d 0%, #ffffff 60%)`, borderColor: "#e6e8ec" }
    : { background: "#fbfbfc", borderColor: "#eef0f3" };
}

/** Vivid card surface (colourful gradient + coloured border), used on the Operations dashboard. */
export function vividTint(color: string, strength: "strong" | "soft" = "strong"): React.CSSProperties {
  return strength === "strong"
    ? { background: `linear-gradient(140deg, ${color}38 0%, ${color}1a 55%, ${color}0a 100%), #ffffff`, borderColor: `${color}55` }
    : { background: `linear-gradient(90deg, ${color}1f 0%, ${color}0a 60%, transparent 100%)`, borderColor: `${color}33` };
}

/** Thin colour rule across the top of a card. */
function TopRule({ color }: { color: string }) {
  return <span className="pointer-events-none absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} aria-hidden />;
}

/** Tinted rounded-square icon tile. */
function IconTile({ icon: Icon, color, size = "md" }: { icon: LucideIcon; color: string; size?: "md" | "lg" }) {
  return (
    <span className={clsx("grid shrink-0 place-items-center rounded-lg", size === "lg" ? "size-12" : "size-10")} style={{ background: `${color}14`, color }}>
      <Icon className={size === "lg" ? "size-6" : "size-5"} strokeWidth={1.9} />
    </span>
  );
}

/** Small outline chip with a calendar icon, as used for date ranges on cards. */
export function RangeChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1 text-xs font-semibold text-muted">
      <CalendarDays className="size-3.5" /> {children}
    </span>
  );
}

/** Round solid icon, used on KPI cards and list rows. */
export function IconDot({ icon: Icon, color, size = "md" }: { icon: LucideIcon; color: string; size?: "sm" | "md" }) {
  return (
    <span className={clsx("grid shrink-0 place-items-center rounded-full text-white", size === "md" ? "size-9" : "size-7")} style={{ background: color }}>
      <Icon className={size === "md" ? "size-4" : "size-3.5"} strokeWidth={2.2} />
    </span>
  );
}

/** KPI card: round coloured icon, label, value, delta and a "View" link. */
export function KpiCard({
  icon,
  color,
  label,
  value,
  delta,
  href,
  linkLabel = "View details",
  tinted = true,
  vivid = false,
}: {
  icon: LucideIcon;
  color: string;
  label: string;
  value: React.ReactNode;
  delta?: { text: string; up: boolean };
  href?: string;
  linkLabel?: string;
  /** Colourful variant: soft gradient of the icon colour, faded corner icon, coloured link. */
  tinted?: boolean;
  /** Colourful gradient, solid glowing icon (Operations dashboard). */
  vivid?: boolean;
}) {
  if (vivid) {
    const Icon = icon;
    return (
      <div
        className="relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border p-4 shadow-[0_8px_20px_-14px_rgba(16,24,40,0.35)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_-16px_rgba(16,24,40,0.4)]"
        style={vividTint(color)}
      >
        <Icon className="pointer-events-none absolute -right-3 -bottom-3 size-24" strokeWidth={1.2} style={{ color, opacity: 0.14 }} aria-hidden />
        <span className="grid size-10 place-items-center rounded-full text-white" style={{ background: color, boxShadow: `0 6px 14px -6px ${color}` }}>
          <Icon className="size-[18px]" strokeWidth={2.2} />
        </span>
        <div className="mt-3 text-[13px] font-semibold text-[#4b5563]">{label}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[24px] font-bold tracking-tight whitespace-nowrap text-ink tabular-nums">{value}</span>
          {delta && (
            <span className={clsx("inline-flex items-center text-xs font-bold", delta.up ? "text-[#0a8f44]" : "text-[#d10b0b]")}>
              {delta.up ? <ArrowUp className="size-3" strokeWidth={3} /> : <ArrowDown className="size-3" strokeWidth={3} />}
              {delta.text}
            </span>
          )}
        </div>
        {href && (
          <Link
            href={href}
            className="relative mt-3 inline-flex items-center gap-1 border-t pt-2.5 text-xs font-bold underline-offset-2 hover:underline"
            style={{ color, borderColor: `${color}33` }}
          >
            {linkLabel} <ChevronRight className="size-3.5" />
          </Link>
        )}
      </div>
    );
  }
  if (tinted) {
    const Icon = icon;
    return (
      <div
        className="relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border p-4 shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:shadow-[0_8px_20px_-12px_rgba(16,24,40,0.25)]"
        style={tint(color)}
      >
        <TopRule color={color} />
        <Icon className="pointer-events-none absolute -right-2 -bottom-2 size-20" strokeWidth={1.2} style={{ color, opacity: 0.06 }} aria-hidden />
        <IconTile icon={Icon} color={color} />
        <div className="mt-3 text-[13px] font-semibold text-[#4b5563]">{label}</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[24px] font-bold tracking-tight whitespace-nowrap text-ink tabular-nums">{value}</span>
          {delta && (
            <span className={clsx("inline-flex items-center text-xs font-bold", delta.up ? "text-[#0a8f44]" : "text-[#d10b0b]")}>
              {delta.up ? <ArrowUp className="size-3" strokeWidth={3} /> : <ArrowDown className="size-3" strokeWidth={3} />}
              {delta.text}
            </span>
          )}
        </div>
        {href && (
          <Link
            href={href}
            className="relative mt-3 inline-flex items-center gap-1 border-t pt-2.5 text-xs font-bold underline-offset-2 hover:underline"
            style={{ color, borderColor: "#eef0f3" }}
          >
            {linkLabel} <ChevronRight className="size-3.5" />
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="card flex flex-col p-4">
      <IconDot icon={icon} color={color} />
      <div className="mt-3 text-[13px] font-semibold text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-bold tracking-tight text-ink tabular-nums">{value}</span>
        {delta && (
          <span className={clsx("inline-flex items-center text-xs font-bold", delta.up ? "text-[#0a8f44]" : "text-[#d10b0b]")}>
            {delta.up ? <ArrowUp className="size-3" strokeWidth={3} /> : <ArrowDown className="size-3" strokeWidth={3} />}
            {delta.text}
          </span>
        )}
      </div>
      {href && (
        <Link href={href} className="mt-3 border-t border-line pt-2.5 text-xs font-semibold text-muted underline-offset-2 hover:text-accent hover:underline">
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

/** Stat card in the same tinted style as KPI cards (horizontal layout). */
export function StatCard({
  icon: Icon,
  color,
  label,
  value,
  chip,
  vivid = false,
}: {
  icon: LucideIcon;
  color: string;
  label: string;
  value: React.ReactNode;
  chip?: string;
  /** Colourful gradient, solid glowing icon. */
  vivid?: boolean;
}) {
  if (vivid) {
    return (
      <div
        className="relative flex min-w-0 items-center gap-4 overflow-hidden rounded-[10px] border p-5 shadow-[0_8px_20px_-14px_rgba(16,24,40,0.35)] transition hover:-translate-y-0.5 hover:shadow-[0_14px_28px_-16px_rgba(16,24,40,0.4)]"
        style={vividTint(color)}
      >
        <Icon className="pointer-events-none absolute -right-3 -bottom-4 size-24" strokeWidth={1.2} style={{ color, opacity: 0.14 }} aria-hidden />
        <span className="grid size-12 shrink-0 place-items-center rounded-full text-white" style={{ background: color, boxShadow: `0 6px 14px -6px ${color}` }}>
          <Icon className="size-6" strokeWidth={2} />
        </span>
        <div className="relative min-w-0">
          <div className="text-[13px] font-semibold text-[#4b5563]">{label}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-[22px] font-bold tracking-tight text-ink tabular-nums">{value}</span>
            {chip && (
              <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold" style={{ background: `${color}22`, color }}>
                {chip}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="relative flex min-w-0 items-center gap-4 overflow-hidden rounded-[10px] border p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:shadow-[0_8px_20px_-12px_rgba(16,24,40,0.25)]"
      style={tint(color)}
    >
      <TopRule color={color} />
      <Icon className="pointer-events-none absolute -right-2 -bottom-3 size-20" strokeWidth={1.2} style={{ color, opacity: 0.06 }} aria-hidden />
      <IconTile icon={Icon} color={color} size="lg" />
      <div className="relative min-w-0">
        <div className="text-[13px] font-semibold text-[#4b5563]">{label}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="text-[22px] font-bold tracking-tight text-ink tabular-nums">{value}</span>
          {chip && (
            <span className="rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold" style={{ background: `${color}14`, color }}>
              {chip}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Welcome banner with avatar, greeting, highlighted counts and actions. */
export function WelcomeBanner({
  initials,
  title,
  children,
  actions,
  vivid = false,
}: {
  initials: string;
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  vivid?: boolean;
}) {
  if (vivid) {
    return (
      <div className="relative mb-6 flex flex-wrap items-center gap-4 overflow-hidden rounded-[10px] border p-5 shadow-[0_8px_20px_-14px_rgba(16,24,40,0.35)]" style={vividTint("#1f6b32")}>
        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-white text-lg font-bold text-accent shadow-[0_6px_14px_-6px_#1f6b32] ring-4 ring-white/70">{initials}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[20px] font-bold text-ink">{title}</h2>
          {children && <p className="mt-0.5 text-[13px] text-muted">{children}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    );
  }
  return (
    <div className="relative mb-6 flex flex-wrap items-center gap-4 overflow-hidden rounded-[10px] border p-5 shadow-[0_1px_2px_rgba(16,24,40,0.05)]" style={tint("#1f6b32")}>
      <TopRule color="#1f6b32" />
      <span className="grid size-14 shrink-0 place-items-center rounded-full bg-accent-soft text-lg font-bold text-accent">{initials}</span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[20px] font-bold text-ink">{title}</h2>
        {children && <p className="mt-0.5 text-[13px] text-muted">{children}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Older building blocks, restyled.
 * ------------------------------------------------------------------------- */
export function AppCard({
  icon: Icon,
  iconColor = "#1f6b32",
  title,
  description,
  children,
  footer,
}: {
  icon: LucideIcon;
  iconColor?: string;
  iconClass?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border shadow-[0_1px_2px_rgba(16,24,40,0.05)]" style={tint(iconColor)}>
      <TopRule color={iconColor} />
      <div className="relative flex flex-1 gap-3.5 p-5">
        <IconTile icon={Icon} color={iconColor} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-bold text-ink">{title}</h3>
          {description && <p className="mt-1 text-[13px] leading-relaxed text-[#4b5563]">{description}</p>}
          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>
      {footer && (
        <div className="relative flex flex-wrap items-center gap-3 border-t border-[#eef0f3] bg-white px-5 py-3">
          {footer}
        </div>
      )}
    </div>
  );
}

/** Green on/off switch. Renders a submit button so it works inside a server-action form. */
export function Toggle({ on, label, tip }: { on: boolean; label: string; tip?: string }) {
  return (
    <span className="group relative ml-auto inline-flex">
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={clsx("relative h-5 w-9 rounded-full transition focus-visible:ring-4 focus-visible:ring-green-100 focus-visible:outline-none", on ? "bg-[#0a8f44]" : "bg-gray-300")}
      >
        <span className={clsx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
      </button>
      {tip && (
        <span
          role="tooltip"
          className="pointer-events-none absolute right-full bottom-1/2 z-20 mr-3 hidden w-64 translate-y-1/2 items-start gap-2 rounded-md bg-ink px-3 py-2 text-xs leading-snug text-white shadow-lg group-focus-within:flex group-hover:flex"
        >
          <Info className="mt-px size-4 shrink-0 opacity-80" />
          {tip}
        </span>
      )}
    </span>
  );
}

export function Flash({ error, notice }: { error?: string; notice?: string }) {
  if (!error && !notice) return null;
  return (
    <div
      role={error ? "alert" : "status"}
      className={clsx(
        "mb-5 flex items-start gap-2 rounded-md border px-4 py-3 text-[13px] font-semibold",
        error ? "border-red-200 bg-red-50 text-[#b30a0a]" : "border-green-200 bg-green-50 text-[#08743a]",
      )}
    >
      {error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
      <span>{error ?? notice}</span>
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[#cfe3d4] bg-accent-soft px-4 py-3 text-[13px] text-[#14532d]">
      <Info className="mt-0.5 size-4 shrink-0 text-accent" />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-10 text-center text-[13px] text-muted">{children}</div>;
}

export function Tabs({ tabs, active }: { tabs: { key: string; label: React.ReactNode; href: string }[]; active: string }) {
  return (
    <div className="mb-5 flex max-w-full flex-wrap gap-2">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === active ? "page" : undefined}
          className={clsx(
            "rounded-md border px-3.5 py-2 text-[13px] font-semibold whitespace-nowrap transition",
            t.key === active ? "border-accent bg-accent text-white" : "border-line bg-white text-ink hover:border-accent hover:text-accent",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-[13px] font-bold text-ink">{children}</dd>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-1 text-[22px] font-bold tracking-tight tabular-nums text-ink">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Progress({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full min-w-16 overflow-hidden rounded-full bg-[#e9edf4]">
      <div className={clsx("h-1.5 rounded-full", pct > 100 ? "bg-[#d10b0b]" : "bg-accent")} style={{ width: `${v}%` }} />
    </div>
  );
}
