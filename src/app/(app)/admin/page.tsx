import { requireModule, hasRole } from "@/lib/auth";
import { NAV_ACCESS, ROLES, ROLE_LABELS, type NavKey, type Role } from "@/lib/roles";
import { C, rot } from "@/lib/palette";
import Link from "next/link";
import { Building2, Handshake, LogIn, Plus, Search, ShieldCheck, Store, UserCheck, Users as UsersIcon, Warehouse, Wheat } from "lucide-react";
import { AppCard, Badge, Card, Empty, Flash, Note, PageHeader, Section, StatCard, Tabs, Toggle } from "@/components/ui";
import { dateTime, num } from "@/lib/format";
import { addMaster, createUser, resetPassword, toggleMaster, updateSetting, updateUser, updateVariety } from "./actions";

type SP = { tab?: string; error?: string; notice?: string; q?: string; role?: string; status?: string; edit?: string };

export default async function AdminPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { supabase, profile } = await requireModule("admin");
  const isAdmin = hasRole(profile, ["admin"]);
  const tab = sp.tab ?? "users";

  return (
    <>
      <PageHeader title="Admin" description="Users and roles, master data, calculation settings and the audit trail." />
      <Flash error={sp.error} notice={sp.notice} />
      <Tabs
        active={tab}
        tabs={[
          { key: "users", label: "Users & roles", href: "/admin?tab=users" },
          { key: "masters", label: "Masters", href: "/admin?tab=masters" },
          { key: "settings", label: "Calculation settings", href: "/admin?tab=settings" },
          { key: "audit", label: "Audit trail", href: "/admin?tab=audit" },
        ]}
      />
      {tab === "users" && <Users isAdmin={isAdmin} supabase={supabase} sp={sp} meId={profile.id} />}
      {tab === "masters" && <Masters supabase={supabase} />}
      {tab === "settings" && <Settings isAdmin={isAdmin} supabase={supabase} />}
      {tab === "audit" && <Audit supabase={supabase} />}
    </>
  );
}

type Sb = Awaited<ReturnType<typeof requireModule>>["supabase"];

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: Role | null;
  plant_id: string | null;
  active: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  banned_until: string | null;
};

const MODULE_LABELS: Record<NavKey, string> = {
  overview: "Dashboard",
  weighbridge: "Weighbridge",
  qc: "Quality Control",
  "purchase-orders": "Purchase Orders",
  "sales-orders": "Sales Orders",
  processing: "Processing",
  inventory: "Inventory",
  stores: "Stores & Repairs",
  reports: "Reports",
  admin: "Admin",
};

function initialsOf(name: string) {
  return (name || "?")
    .split(/[\s.@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0]!.toUpperCase())
    .join("");
}

async function Users({ isAdmin, supabase, sp, meId }: { isAdmin: boolean; supabase: Sb; sp: SP; meId: string }) {
  const { data, error } = await supabase.rpc("admin_list_users");
  const all = (data ?? []) as UserRow[];
  const q = (sp.q ?? "").trim().toLowerCase();
  const users = all.filter(
    (u) =>
      (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
      (!sp.role || (sp.role === "none" ? !u.role : u.role === sp.role)) &&
      (!sp.status || (sp.status === "active" ? u.active : !u.active)),
  );
  const editing = sp.edit ? all.find((u) => u.id === sp.edit) : undefined;
  const canCreate = isAdmin && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const weekAgo = Date.now() - 7 * 864e5;
  const stats = [
    { icon: UsersIcon, color: C.green, label: "Total users", value: all.length },
    { icon: UserCheck, color: C.gold, label: "Active", value: all.filter((u) => u.active).length },
    { icon: ShieldCheck, color: C.blue, label: "Administrators", value: all.filter((u) => u.role === "admin" && u.active).length },
    { icon: LogIn, color: C.terracotta, label: "Signed in · 7 days", value: all.filter((u) => u.last_sign_in_at && new Date(u.last_sign_in_at).getTime() > weekAgo).length },
  ];
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ tab: "users" });
    const merged: Record<string, string | undefined> = { q: sp.q, role: sp.role, status: sp.status, edit: sp.edit, ...patch };
    Object.entries(merged).forEach(([k, v]) => v && p.set(k, v));
    return `/admin?${p.toString()}`;
  };

  return (
    <>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <StatCard key={s.label} icon={s.icon} color={s.color} label={s.label} value={s.value} />
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card tone={C.green} title={`Users (${users.length})`}>
          <form action="/admin" className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
            <input type="hidden" name="tab" value="users" />
            <div className="relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-gray-400" />
              <input name="q" defaultValue={sp.q} placeholder="Search name or email" className="input pl-8" />
            </div>
            <select name="role" defaultValue={sp.role ?? ""} className="input w-auto" aria-label="Filter by role">
              <option value="">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
              <option value="none">No access</option>
            </select>
            <select name="status" defaultValue={sp.status ?? ""} className="input w-auto" aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Deactivated</option>
            </select>
            <button className="btn-secondary">Filter</button>
          </form>
          {error ? (
            <div className="p-5">
              <Flash error={error.message} />
            </div>
          ) : users.length === 0 ? (
            <Empty>No users match these filters.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Last sign-in</th>
                    <th>Added</th>
                    {isAdmin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {users.map((u, i) => (
                    <tr key={u.id} className={sp.edit === u.id ? "bg-accent-soft" : "hover:bg-gray-50"}>
                      <td>
                        <span className="flex items-center gap-3">
                          <span className="grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white" style={{ background: rot(i) }}>
                            {initialsOf(u.full_name || u.email)}
                          </span>
                          <span className="min-w-0">
                            <span className="block font-bold text-ink">
                              {u.full_name || "—"} {u.id === meId && <span className="text-xs font-semibold text-muted">(you)</span>}
                            </span>
                            <span className="block text-xs text-muted">{u.email}</span>
                          </span>
                        </span>
                      </td>
                      <td>{u.role ? <Badge tone="navy">{ROLE_LABELS[u.role]}</Badge> : <Badge tone="amber">No access</Badge>}</td>
                      <td>{u.active ? <Badge tone="green">Active</Badge> : <Badge tone="red">Deactivated</Badge>}</td>
                      <td className="text-xs whitespace-nowrap">{u.last_sign_in_at ? dateTime(u.last_sign_in_at) : "Never"}</td>
                      <td className="text-xs whitespace-nowrap">{dateTime(u.created_at)}</td>
                      {isAdmin && (
                        <td className="text-right">
                          <Link href={qs({ edit: u.id })} className="btn-secondary py-1">
                            Manage
                          </Link>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          {isAdmin && editing ? (
            <>
              <Card
                tone={C.blue}
                title={`Manage ${editing.full_name || editing.email}`}
                actions={
                  <Link href={qs({ edit: undefined })} className="text-xs font-bold text-accent hover:underline">
                    Close
                  </Link>
                }
              >
                <form action={updateUser} className="space-y-3 p-4">
                  <input type="hidden" name="id" value={editing.id} />
                  <div className="text-xs text-muted">{editing.email}</div>
                  <div>
                    <label className="label" htmlFor="edit_name">Full name</label>
                    <input id="edit_name" name="full_name" defaultValue={editing.full_name} className="input" required />
                  </div>
                  <div>
                    <label className="label" htmlFor="edit_role">Role</label>
                    <select id="edit_role" name="role" defaultValue={editing.role ?? ""} className="input" disabled={editing.id === meId}>
                      <option value="">No access</option>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    {editing.id === meId && (
                      <>
                        <input type="hidden" name="role" value={editing.role ?? ""} />
                        <p className="mt-1 text-xs text-muted">You can&apos;t change your own role.</p>
                      </>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <input type="checkbox" name="active" defaultChecked={editing.active} disabled={editing.id === meId} className="size-4 accent-[#1f6b32]" />
                    Active (can sign in)
                    {editing.id === meId && <input type="hidden" name="active" value="on" />}
                  </label>
                  <div>
                    <label className="label" htmlFor="edit_reason">Reason (recorded when access changes)</label>
                    <input id="edit_reason" name="reason" className="input" placeholder="e.g. Left the company" />
                  </div>
                  <dl className="grid grid-cols-2 gap-3 rounded-md border border-line p-3 text-xs">
                    <div>
                      <dt className="text-muted">Last sign-in</dt>
                      <dd className="font-bold text-ink">{editing.last_sign_in_at ? dateTime(editing.last_sign_in_at) : "Never"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Added</dt>
                      <dd className="font-bold text-ink">{dateTime(editing.created_at)}</dd>
                    </div>
                  </dl>
                  <button className="btn-primary w-full">Save changes</button>
                </form>
              </Card>

              <Card tone={C.terracotta} title="Reset password">
                <form action={resetPassword} className="space-y-3 p-4">
                  <input type="hidden" name="id" value={editing.id} />
                  <p className="text-xs text-muted">Sets a new temporary password. Share it privately; the user can change it under My account.</p>
                  <div>
                    <label className="label" htmlFor="new_pw">New password (min 10 characters)</label>
                    <input id="new_pw" name="password" type="password" minLength={10} className="input" required autoComplete="new-password" />
                  </div>
                  <div>
                    <label className="label" htmlFor="new_pw2">Confirm password</label>
                    <input id="new_pw2" name="confirm" type="password" minLength={10} className="input" required autoComplete="new-password" />
                  </div>
                  <button className="btn-dark w-full">Reset password</button>
                </form>
              </Card>
            </>
          ) : (
            isAdmin && (
              <Card tone={C.gold} title="Add user">
                {canCreate ? (
                  <form action={createUser} className="space-y-3 p-4">
                    <div>
                      <label className="label" htmlFor="full_name">Full name</label>
                      <input id="full_name" name="full_name" className="input" required />
                    </div>
                    <div>
                      <label className="label" htmlFor="email">Email</label>
                      <input id="email" name="email" type="email" className="input" required />
                    </div>
                    <div>
                      <label className="label" htmlFor="role">Role</label>
                      <select id="role" name="role" className="input" required defaultValue="">
                        <option value="" disabled>
                          Select role
                        </option>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="password">Temporary password (min 10 characters)</label>
                      <input id="password" name="password" type="password" minLength={10} className="input" required autoComplete="new-password" />
                    </div>
                    <button className="btn-primary w-full">Create user</button>
                  </form>
                ) : (
                  <div className="p-4">
                    <Note>Set SUPABASE_SERVICE_ROLE_KEY on the server to create users here.</Note>
                  </div>
                )}
              </Card>
            )
          )}

          <Card tone={C.plum} title="Role guide">
            <ul className="divide-y divide-line">
              {ROLES.map((r) => (
                <li key={r} className="px-4 py-2.5">
                  <div className="text-[13px] font-bold text-ink">{ROLE_LABELS[r]}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {(Object.keys(NAV_ACCESS) as NavKey[])
                      .filter((k) => NAV_ACCESS[k].includes(r))
                      .map((k) => MODULE_LABELS[k])
                      .join(" · ")}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

const MASTER_TIP = "Switching this off hides it from new entries. Records that already use it keep it.";

function ActiveSwitch({ table, id, active, name }: { table: string; id: string; active: boolean; name: string }) {
  return (
    <form action={toggleMaster} className="ml-auto">
      <input type="hidden" name="table" value={table} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={String(!active)} />
      <Toggle on={active} label={`${name} active`} tip={active ? MASTER_TIP : undefined} />
    </form>
  );
}

function AddCard({ table, title, children }: { table: string; title: string; children: React.ReactNode }) {
  return (
    <form action={addMaster} className="flex flex-col justify-between gap-3 rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/60 p-5">
      <input type="hidden" name="table" value={table} />
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <Plus className="size-4" /> {title}
      </div>
      <div className="grid gap-2">{children}</div>
      <button className="btn-secondary self-start">Add</button>
    </form>
  );
}

async function Masters({ supabase }: { supabase: Sb }) {
  const [{ data: varieties }, { data: parties }, { data: brokers }, { data: locations }] = await Promise.all([
    supabase.from("varieties").select("*").order("name"),
    supabase.from("parties").select("*").order("name"),
    supabase.from("brokers").select("*").order("name"),
    supabase.from("locations").select("*").order("name"),
  ]);
  const grid = "grid gap-5 md:grid-cols-2 xl:grid-cols-3";

  return (
    <>
      <Section title="Varieties" description="Paddy and rice varieties used in QC, orders and stock. Bag weight and estimated yield drive the calculations.">
        <div className={grid}>
          {varieties?.map((v, i) => (
            <AppCard
              key={v.id}
              icon={Wheat}
              iconColor={rot(i)}
              title={v.name}
              description={`Code ${v.code} · default bag ${num(v.default_bag_weight_kg)} kg · est. yield ${num(v.est_yield_pct)}%`}
              footer={
                <>
                  <form action={updateVariety} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={v.id} />
                    <input name="default_bag_weight_kg" defaultValue={v.default_bag_weight_kg} className="input w-20" aria-label={`${v.name} bag weight kg`} title="Bag weight (kg)" />
                    <input name="est_yield_pct" defaultValue={v.est_yield_pct} className="input w-20" aria-label={`${v.name} yield %`} title="Estimated yield %" />
                    <button className="btn-secondary">Save</button>
                  </form>
                  <ActiveSwitch table="varieties" id={v.id} active={v.active} name={v.name} />
                </>
              }
            />
          ))}
          <AddCard table="varieties" title="Add variety">
            <input name="name" placeholder="Variety name" className="input" required />
            <div className="grid grid-cols-3 gap-2">
              <input name="code" placeholder="Code" className="input" />
              <input name="default_bag_weight_kg" placeholder="Bag kg" className="input" />
              <input name="est_yield_pct" placeholder="Yield %" className="input" />
            </div>
          </AddCard>
        </div>
      </Section>

      <Section title="Parties" description="Suppliers and customers. Party names are entered at QC, never at the weighbridge.">
        <div className={grid}>
          {parties?.map((p, i) => (
            <AppCard
              key={p.id}
              icon={p.kind === "customer" ? Store : Building2}
              iconColor={rot(i, 2)}
              title={p.name}
              description={[p.kind === "both" ? "Supplier & customer" : p.kind === "customer" ? "Customer" : "Supplier", p.phone, p.gstin && `GSTIN ${p.gstin}`].filter(Boolean).join(" · ")}
              footer={
                <>
                  <Link href={p.kind === "customer" ? "/sales-orders" : "/purchase-orders"} className="btn-secondary">Orders</Link>
                  <ActiveSwitch table="parties" id={p.id} active={p.active} name={p.name} />
                </>
              }
            />
          ))}
          <AddCard table="parties" title="Add party">
            <input name="name" placeholder="Party name" className="input" required />
            <div className="grid grid-cols-2 gap-2">
              <select name="kind" className="input">
                <option value="supplier">Supplier</option>
                <option value="customer">Customer</option>
                <option value="both">Both</option>
              </select>
              <input name="phone" placeholder="Phone" className="input" />
            </div>
          </AddCard>
        </div>
      </Section>

      <Section title="Brokers & locations" description="Brokers linked to purchases, and the yards and stores where stock is held.">
        <div className={grid}>
          {brokers?.map((b, i) => (
            <AppCard
              key={b.id}
              icon={Handshake}
              iconColor={rot(i, 4)}
              title={b.name}
              description={b.phone ? `Broker · ${b.phone}` : "Broker"}
              footer={<ActiveSwitch table="brokers" id={b.id} active={b.active} name={b.name} />}
            />
          ))}
          {locations?.map((l, i) => (
            <AppCard
              key={l.id}
              icon={Warehouse}
              iconColor={rot(i + (brokers?.length ?? 0), 4)}
              title={l.name}
              description={`${String(l.kind).replace("_", " ")} · code ${l.code}`}
              footer={<ActiveSwitch table="locations" id={l.id} active={l.active} name={l.name} />}
            />
          ))}
          <AddCard table="brokers" title="Add broker">
            <input name="name" placeholder="Broker name" className="input" required />
            <input name="phone" placeholder="Phone" className="input" />
          </AddCard>
          <AddCard table="locations" title="Add location">
            <input name="name" placeholder="Location name" className="input" required />
            <select name="kind" className="input">
              <option value="yard">Yard</option>
              <option value="raw_store">Raw store</option>
              <option value="processing">Processing</option>
              <option value="finished_store">Finished store</option>
              <option value="other">Other</option>
            </select>
          </AddCard>
        </div>
      </Section>
    </>
  );
}

async function Settings({ isAdmin, supabase }: { isAdmin: boolean; supabase: Sb }) {
  const { data } = await supabase.from("calc_settings").select("*").order("key");
  return (
    <Card title="Calculation settings" className="max-w-3xl">
      <div className="p-4">
        <Note>
          These are placeholders until the purchase and “classic” sales calculations are confirmed (PRD D-03, D-04). Each posted QC record
          stores the values it used, so changing a setting never alters history.
        </Note>
      </div>
      <table className="table">
        <tbody>
          {data?.map((s) => (
            <tr key={s.key}>
              <td>
                <div className="font-medium">{s.key}</div>
                <div className="text-xs text-slate-500">{s.description}</div>
              </td>
              <td className="w-56">
                {isAdmin ? (
                  <form action={updateSetting} className="flex gap-2">
                    <input type="hidden" name="key" value={s.key} />
                    <input name="value" defaultValue={s.value} className="input w-24" aria-label={s.key} />
                    <button className="btn-secondary py-1">Save</button>
                  </form>
                ) : (
                  num(s.value)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

async function Audit({ supabase }: { supabase: Sb }) {
  const { data } = await supabase.from("audit_log").select("*").order("at", { ascending: false }).limit(150);
  const userIds = [...new Set((data ?? []).map((a) => a.user_id).filter(Boolean))];
  const { data: users } = userIds.length ? await supabase.from("profiles").select("id, full_name, email").in("id", userIds) : { data: [] };
  const who = (id: string | null) => {
    const u = users?.find((x) => x.id === id);
    return u ? u.full_name || u.email : id ? "—" : "system";
  };
  const changed = (a: { old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null }) => {
    if (!a.old_data || !a.new_data) return "";
    return Object.keys(a.new_data)
      .filter((k) => !["updated_at"].includes(k) && JSON.stringify(a.old_data![k]) !== JSON.stringify(a.new_data![k]))
      .map((k) => `${k}: ${JSON.stringify(a.old_data![k])} → ${JSON.stringify(a.new_data![k])}`)
      .join("; ");
  };
  return (
    <Card title="Audit trail (latest 150)">
      {!data?.length ? (
        <Empty>No audit entries.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Table</th>
                <th>Record</th>
                <th>Action</th>
                <th>Reason</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="text-xs whitespace-nowrap text-slate-500">{dateTime(a.at)}</td>
                  <td className="text-xs">{who(a.user_id)}</td>
                  <td className="text-xs">{a.table_name}</td>
                  <td className="font-mono text-xs">{a.pid ?? "—"}</td>
                  <td>
                    <Badge tone={a.action === "delete" ? "red" : a.action === "insert" ? "green" : "blue"}>{a.action}</Badge>
                  </td>
                  <td className="text-xs">{a.reason}</td>
                  <td className="max-w-md truncate text-xs text-slate-500" title={changed(a)}>
                    {changed(a)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
