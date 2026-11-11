import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { backendReady } from "@/lib/supabase/env";
import { canAccess, type NavKey, type Role } from "@/lib/roles";

export type Profile = {
  id: string;
  email: string | null;
  full_name: string;
  role: Role | null;
  plant_id: string | null;
  active: boolean;
};

export const getSession = cache(async () => {
  // Without Supabase configured, send everyone to /login, which shows the setup notice.
  if (!backendReady()) redirect("/login");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, email, full_name, role, plant_id, active")
    .eq("id", user.id)
    .single<Profile>();
  return { supabase, user, profile: profile ?? null };
});

/** Use at the top of each module page. Redirects if the role cannot open the module. */
export async function requireModule(key: NavKey) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!session.profile?.active || !canAccess(session.profile.role, key)) redirect("/?denied=" + key);
  return { ...session, profile: session.profile as Profile & { role: Role } };
}

export function hasRole(profile: Profile | null, roles: Role[]) {
  return !!profile?.role && roles.includes(profile.role);
}

export async function getPlantId(): Promise<string> {
  const session = await getSession();
  if (session?.profile?.plant_id) return session.profile.plant_id;
  const supabase = await createClient();
  const { data } = await supabase.from("plants").select("id").order("created_at").limit(1).single();
  if (!data) throw new Error("No plant configured");
  return data.id as string;
}
