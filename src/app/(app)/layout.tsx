import { redirect } from "next/navigation";
import { AppShell } from "@/components/sidebar";
import { SetupRequired } from "@/components/setup-required";
import { backendReady } from "@/lib/supabase/env";
import { getSession } from "@/lib/auth";
import { canAccess, ROLE_LABELS } from "@/lib/roles";
import { signOut } from "../login/actions";
import { todayIST, date } from "@/lib/format";

// Every screen shows live, per-user data.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!backendReady()) return <SetupRequired />;
  const session = await getSession();
  if (!session) redirect("/login");
  const { profile, supabase } = session;

  if (!profile?.role || !profile.active) {
    return (
      <main className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="text-xl font-semibold">Waiting for access</h1>
        <p className="mt-2 text-sm text-slate-600">
          Your account ({session.user.email}) has no role yet{profile && !profile.active ? " or has been deactivated" : ""}. Ask an
          administrator to assign one.
        </p>
        <form action={signOut} className="mt-6">
          <button className="btn-secondary">Sign out</button>
        </form>
      </main>
    );
  }

  const { data: plant } = profile.plant_id
    ? await supabase.from("plants").select("name").eq("id", profile.plant_id).single()
    : await supabase.from("plants").select("name").order("created_at").limit(1).single();

  const initials = (profile.full_name || profile.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");

  const { count: exceptionCount } = canAccess(profile.role, "weighbridge")
    ? await supabase.from("weighbridge_tickets").select("id", { count: "exact", head: true }).in("status", ["exception", "duplicate"])
    : { count: 0 };

  return (
    <AppShell
      role={profile.role}
      plantName={plant?.name ?? "Plant"}
      userName={profile.full_name || profile.email || ""}
      roleLabel={ROLE_LABELS[profile.role]}
      initials={initials}
      exceptionCount={exceptionCount ?? 0}
      today={date(todayIST())}
      signOut={signOut}
    >
      {children}
    </AppShell>
  );
}
