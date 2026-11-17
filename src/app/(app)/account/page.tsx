import { redirect } from "next/navigation";
import { KeyRound, Mail, ShieldCheck, UserRound } from "lucide-react";
import { getSession } from "@/lib/auth";
import { NAV_ACCESS, ROLE_LABELS, type NavKey } from "@/lib/roles";
import { C } from "@/lib/palette";
import { Badge, Card, Flash, PageHeader } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { changeMyPassword, updateMyName } from "./actions";

export const metadata = { title: "My account" };

const MODULES: Record<NavKey, string> = {
  overview: "Dashboard",
  weighbridge: "Weighbridge",
  qc: "Quality Control",
  "purchase-orders": "Purchase Orders",
  "sales-orders": "Sales Orders",
  processing: "Processing",
  inventory: "Inventory",
  stores: "Stores & Repairs",
  reports: "Reports",
  accounts: "Accounts",
  admin: "Admin",
};

type SP = { error?: string; notice?: string };

export default async function AccountPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const session = await getSession();
  if (!session) redirect("/login");
  const { user, profile } = session;
  const role = profile?.role ?? null;
  const modules = role ? (Object.keys(NAV_ACCESS) as NavKey[]).filter((k) => NAV_ACCESS[k].includes(role)) : [];

  return (
    <>
      <PageHeader title="My account" description="Your profile, access and password." crumbs={[{ label: "My account" }]} />
      <Flash error={sp.error} notice={sp.notice} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card tone={C.green} title="Profile">
            <form action={updateMyName} className="space-y-3 p-4">
              <div>
                <label className="label" htmlFor="full_name">Full name</label>
                <input id="full_name" name="full_name" defaultValue={profile?.full_name ?? ""} className="input" required />
              </div>
              <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Mail className="size-4 text-[#1f6b32]" />
                  <span className="min-w-0 truncate">{user.email}</span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-[#c08a24]" />
                  {role ? <Badge tone="navy">{ROLE_LABELS[role]}</Badge> : <Badge tone="amber">No access</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <UserRound className="size-4 text-[#3e6fc0]" />
                  <span>Last sign-in: {user.last_sign_in_at ? dateTime(user.last_sign_in_at) : "—"}</span>
                </div>
              </dl>
              <button className="btn-primary">Save name</button>
            </form>
          </Card>

          <Card tone={C.plum} title="What you can open">
            <div className="flex flex-wrap gap-2 p-4">
              {modules.length ? modules.map((m) => <Badge key={m} tone="green">{MODULES[m]}</Badge>) : <span className="text-[13px] text-muted">Ask an administrator to give you a role.</span>}
            </div>
          </Card>
        </div>

        <Card tone={C.terracotta} title="Change password">
          <form action={changeMyPassword} className="space-y-3 p-4">
            <p className="flex items-center gap-2 text-xs text-muted">
              <KeyRound className="size-4" /> Use at least 10 characters. You stay signed in after changing it.
            </p>
            <div>
              <label className="label" htmlFor="current">Current password</label>
              <input id="current" name="current" type="password" className="input" required autoComplete="current-password" />
            </div>
            <div>
              <label className="label" htmlFor="password">New password</label>
              <input id="password" name="password" type="password" minLength={10} className="input" required autoComplete="new-password" />
            </div>
            <div>
              <label className="label" htmlFor="confirm">Confirm new password</label>
              <input id="confirm" name="confirm" type="password" minLength={10} className="input" required autoComplete="new-password" />
            </div>
            <button className="btn-primary">Change password</button>
          </form>
        </Card>
      </div>
    </>
  );
}
