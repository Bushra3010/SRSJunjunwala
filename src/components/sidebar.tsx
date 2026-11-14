"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  BarChart3,
  Bell,
  Boxes,
  CalendarDays,
  ChevronDown,
  ClipboardList,
  Cog,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShoppingCart,
  Truck,
  Wrench,
  X,
} from "lucide-react";
import { canAccess, type NavKey, type Role } from "@/lib/roles";
import { LiveRefresh } from "@/components/live-refresh";

type Icon = React.ComponentType<{ className?: string; strokeWidth?: number }>;
type Item = { key: NavKey; href: string; label: string; icon: Icon; children?: { key: NavKey; href: string; label: string }[] };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Main menu",
    items: [
      {
        key: "overview",
        href: "/",
        label: "Dashboard",
        icon: LayoutDashboard,
        children: [
          { key: "overview", href: "/", label: "Operations dashboard" },
          { key: "admin", href: "/admin-panel", label: "Admin dashboard" },
        ],
      },
      { key: "weighbridge", href: "/weighbridge", label: "Weighbridge", icon: Truck },
      { key: "qc", href: "/qc", label: "Quality Control", icon: FlaskConical },
    ],
  },
  {
    title: "Commercial",
    items: [
      { key: "purchase-orders", href: "/purchase-orders", label: "Purchase Orders", icon: ClipboardList },
      { key: "sales-orders", href: "/sales-orders", label: "Sales Orders", icon: ShoppingCart },
    ],
  },
  {
    title: "Plant",
    items: [
      { key: "inventory", href: "/inventory", label: "Inventory", icon: Boxes },
      {
        key: "processing",
        href: "/production",
        label: "Production",
        icon: Cog,
        children: [
          { key: "processing", href: "/production", label: "Floor overview" },
          { key: "processing", href: "/production/soaking", label: "Soaking tanks" },
          { key: "processing", href: "/production/drying", label: "Dryers" },
          { key: "processing", href: "/production/milling", label: "Milling" },
          { key: "processing", href: "/production/standards", label: "Recovery standards" },
          { key: "processing", href: "/production/trace", label: "Traceability" },
          { key: "processing", href: "/production/reports", label: "Reports" },
        ],
      },
      { key: "stores", href: "/stores", label: "Stores & Repairs", icon: Wrench },
      { key: "reports", href: "/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    title: "Settings",
    items: [{ key: "admin", href: "/admin", label: "Admin settings", icon: Settings }],
  },
];

const SHORTCUTS: { key: NavKey; href: string; label: string; dot: string }[] = [
  { key: "weighbridge", href: "/weighbridge?tab=exceptions", label: "Ticket exceptions", dot: "#d10b0b" },
  { key: "qc", href: "/qc", label: "QC work queue", dot: "#0a8f44" },
  { key: "weighbridge", href: "/weighbridge?tab=cycles", label: "RST cycles", dot: "#d8a242" },
  { key: "processing", href: "/production/trace", label: "Trace a batch", dot: "#3e6fc0" },
];

export function AppShell({
  role,
  plantName,
  userName,
  roleLabel,
  initials,
  exceptionCount,
  today,
  signOut,
  children,
}: {
  role: Role | null;
  plantName: string;
  userName: string;
  roleLabel: string;
  initials: string;
  exceptionCount: number;
  today: string;
  signOut: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dashOpen, setDashOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("sidebar-collapsed") === "1");
    } catch {}
  }, []);
  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem("sidebar-collapsed", c ? "0" : "1");
      } catch {}
      return !c;
    });

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"));
  const searchTarget = canAccess(role, "weighbridge") ? "/weighbridge" : "/qc";
  const mini = collapsed && !mobileOpen;

  const sidebar = (
    <aside className={clsx("flex h-full flex-col border-r border-[#e8dcbc] bg-gradient-to-b from-[#fdfaf1] to-[#f5ecd5]", mini ? "w-[76px]" : "w-[260px]")}>
      <div className={clsx("flex shrink-0 items-center gap-2.5 border-b border-[#e8dcbc]", mini ? "h-16 justify-center" : "h-[104px] justify-center px-4")}>
        <Link href="/" className="flex min-w-0 items-center gap-2.5" title={`Shree Rani Sati Overseas Pvt. Ltd. · ${plantName}`}>
          <Image
            src="/logo-transparent.png"
            alt="Shree Rani Sati Overseas Pvt. Ltd."
            width={520}
            height={384}
            priority
            className={mini ? "h-11 w-auto" : "h-[96px] w-auto"}
          />
        </Link>
        {mobileOpen && (
          <button type="button" onClick={() => setMobileOpen(false)} className="ml-auto grid size-8 place-items-center rounded-md text-[#14532d] hover:bg-[#efe3c4]" aria-label="Close menu">
            <X className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
        {SECTIONS.map((sec) => {
          const items = sec.items.filter((i) => canAccess(role, i.key));
          if (!items.length) return null;
          return (
            <div key={sec.title} className="mb-4">
              {!mini && <div className="mb-2 px-3 text-[11px] font-bold tracking-[0.08em] text-[#a47a1c] uppercase">{sec.title}</div>}
              <ul className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const kids = item.children?.filter((c) => canAccess(role, c.key)) ?? [];
                  const hasKids = kids.length > 1;
                  const active = hasKids ? kids.some((k) => isActive(k.href)) : isActive(item.href);
                  const rowClass = clsx(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-[14px] font-semibold transition",
                    mini && "justify-center px-0",
                    active ? "bg-[#1f6b32] text-white shadow-[0_6px_14px_-8px_rgba(20,83,45,0.8)] [&_svg]:text-[#e5b95c]" : "text-[#2c4a33] hover:bg-[#efe3c4] hover:text-[#14532d]",
                  );
                  return (
                    <li key={item.label}>
                      {hasKids && !mini ? (
                        <button type="button" onClick={() => setDashOpen((o) => !o)} className={rowClass} aria-expanded={dashOpen}>
                          <Icon className="size-[18px] shrink-0" strokeWidth={1.9} />
                          <span className="flex-1 text-left">{item.label}</span>
                          <ChevronDown className={clsx("size-4 transition", dashOpen ? "" : "-rotate-90")} />
                        </button>
                      ) : (
                        <Link href={item.href} className={rowClass} title={mini ? item.label : undefined} aria-current={active ? "page" : undefined}>
                          <Icon className="size-[18px] shrink-0" strokeWidth={1.9} />
                          {mini ? <span className="sr-only">{item.label}</span> : item.label}
                        </Link>
                      )}
                      {hasKids && !mini && dashOpen && (
                        <ul className="mt-0.5 mb-1 ml-[22px] space-y-0.5 border-l border-[#e3d3a8] pl-3">
                          {kids.map((k) => (
                            <li key={k.href}>
                              <Link
                                href={k.href}
                                aria-current={isActive(k.href) ? "page" : undefined}
                                className={clsx("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-semibold", isActive(k.href) ? "text-[#14532d]" : "text-[#6b6a4f] hover:text-[#14532d]")}
                              >
                                <span className={clsx("size-1.5 rounded-full", isActive(k.href) ? "bg-[#c08a24]" : "bg-[#d9c79a]")} />
                                {k.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {!mini && SHORTCUTS.some((s) => canAccess(role, s.key)) && (
          <div className="mb-4">
            <div className="mb-2 px-3 text-[11px] font-bold tracking-[0.08em] text-[#a47a1c] uppercase">Shortcuts</div>
            <ul className="space-y-0.5">
              {SHORTCUTS.filter((s) => canAccess(role, s.key)).map((s) => (
                <li key={s.href}>
                  <Link href={s.href} className="flex items-center gap-3 rounded-md px-3 py-2 text-[14px] font-semibold text-[#2c4a33] hover:bg-[#efe3c4] hover:text-[#14532d]">
                    <span className="size-2 rounded-full" style={{ background: s.dot }} aria-hidden />
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>
    </aside>
  );

  return (
    <div className="min-h-screen lg:flex">
      <div className="hidden shrink-0 lg:sticky lg:top-0 lg:block lg:h-screen">{sidebar}</div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/30" aria-label="Close menu" onClick={() => setMobileOpen(false)} />
          <div className="relative h-full w-max">{sidebar}</div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-[#e8dcbc] bg-gradient-to-r from-[#fdfaf1] via-[#fbf6e8] to-[#f7efd9] px-4 sm:px-6">
          <button
            type="button"
            onClick={() => (window.matchMedia("(min-width: 1024px)").matches ? toggle() : setMobileOpen(true))}
            className="grid size-9 shrink-0 place-items-center rounded-md border border-[#e3d3a8] bg-white/70 text-[#1f6b32] hover:border-[#c08a24] hover:text-[#c08a24]"
            aria-label="Toggle menu"
          >
            <span className="lg:hidden">
              <Menu className="size-4" />
            </span>
            <span className="hidden lg:inline">{collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}</span>
          </button>
          <form
            className="hidden max-w-sm flex-1 md:block"
            onSubmit={(e) => {
              e.preventDefault();
              const q = searchRef.current?.value.trim();
              if (q) router.push(`${searchTarget}?q=${encodeURIComponent(q)}`);
            }}
          >
            <label className="flex items-center gap-2 rounded-md border border-[#e3d3a8] bg-white/80 px-3 py-2 focus-within:border-[#c08a24] focus-within:bg-white">
              <Search className="size-4 text-[#a47a1c]" />
              <input ref={searchRef} placeholder="Search RST, vehicle or PID" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-gray-400" />
              <kbd className="rounded border border-[#e3d3a8] bg-[#fbf3e2] px-1.5 py-0.5 font-sans text-[10px] font-bold text-[#7a5408]">CTRL + K</kbd>
            </label>
          </form>

          <div className="ml-auto flex items-center gap-2">
            <LiveRefresh />
            <span className="hidden items-center gap-1.5 rounded-md border border-[#e3d3a8] bg-white/70 px-2.5 py-1.5 text-xs font-semibold text-[#14532d] xl:inline-flex">
              <CalendarDays className="size-3.5" /> {today}
            </span>
            {canAccess(role, "weighbridge") && (
              <Link href="/weighbridge?tab=exceptions" className="relative grid size-9 place-items-center rounded-md border border-[#e3d3a8] bg-white/70 text-[#1f6b32] hover:border-[#c08a24] hover:text-[#c08a24]" aria-label={`${exceptionCount} ticket exceptions`}>
                <Bell className="size-4" />
                {exceptionCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-[#c08a24] px-1 text-[10px] font-bold text-white ring-2 ring-[#fbf6e8]">{exceptionCount}</span>
                )}
              </Link>
            )}
            {canAccess(role, "admin") && (
              <Link href="/admin" className="hidden size-9 place-items-center rounded-md border border-[#e3d3a8] bg-white/70 text-[#1f6b32] hover:border-[#c08a24] hover:text-[#c08a24] sm:grid" aria-label="Admin settings">
                <Settings className="size-4" />
              </Link>
            )}
            <Link href="/account" className="ml-1 flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-[#efe3c4]" title="My account">
              <span className="grid size-9 place-items-center rounded-full bg-[#1f6b32] text-xs font-bold text-[#f5d58a] ring-2 ring-[#d8a242]">{initials}</span>
              <span className="hidden leading-tight sm:block">
                <span className="block text-[13px] font-bold text-[#14532d]">{userName}</span>
                <span className="block text-[11px] text-[#a47a1c]">{roleLabel}</span>
              </span>
            </Link>
            <form action={signOut}>
              <button className="grid size-9 place-items-center rounded-md text-[#1f6b32] hover:bg-[#efe3c4] hover:text-[#c08a24]" title="Sign out" aria-label="Sign out">
                <LogOut className="size-4" />
              </button>
            </form>
          </div>
        </header>

        <main className="px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
