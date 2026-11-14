"use server";

import { revalidatePath } from "next/cache";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getSession, getPlantId } from "@/lib/auth";
import { ROLES } from "@/lib/roles";
import { back, optNum, optStr, str } from "@/lib/actions";

async function requireAdmin(path: string) {
  const s = await getSession();
  if (s?.profile?.role !== "admin" || !s.profile.active) back(path, { error: "Only administrators can do this" });
  return s!.profile!;
}

/** Supabase auth admin client (server-only, service role). */
function authAdmin(path: string) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !url) back(path, { error: "SUPABASE_SERVICE_ROLE_KEY is not set on the server" });
  return createAdminClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } }).auth.admin;
}

const BLOCK_FOR = "876000h"; // ~100 years: effectively blocks sign-in until restored

export async function updateUser(fd: FormData) {
  const id = str(fd, "id");
  const path = `/admin?tab=users&edit=${id}`;
  const me = await requireAdmin(path);
  const role = str(fd, "role");
  const active = str(fd, "active") === "on";
  const fullName = str(fd, "full_name");
  if (role && !(ROLES as readonly string[]).includes(role)) back(path, { error: "Unknown role" });
  if (!fullName) back(path, { error: "Name is required" });
  if (id === me.id && (!active || role !== "admin")) back(path, { error: "You can't remove your own administrator access or deactivate yourself." });

  const supabase = await createClient();
  const { data: before } = await supabase.from("profiles").select("active").eq("id", id).single();
  const { error } = await supabase.from("profiles").update({ role: role || null, active, full_name: fullName }).eq("id", id);
  if (error) back(path, { error });

  // Keep Supabase Auth in step: a deactivated user cannot sign in at all.
  if (before && before.active !== active) {
    const { error: aErr } = await authAdmin(path).updateUserById(id, { ban_duration: active ? "none" : BLOCK_FOR });
    if (aErr) back(path, { error: `Profile saved, but sign-in access was not changed: ${aErr.message}` });
    await supabase.rpc("record_user_event", { p_user: id, p_action: active ? "access_restored" : "access_blocked", p_reason: str(fd, "reason") || null });
  }
  revalidatePath("/admin");
  back(path, { notice: before && before.active !== active ? (active ? "User reactivated — they can sign in again" : "User deactivated — sign-in is blocked") : "User updated" });
}

export async function resetPassword(fd: FormData) {
  const id = str(fd, "id");
  const path = `/admin?tab=users&edit=${id}`;
  await requireAdmin(path);
  const password = str(fd, "password");
  if (password.length < 10) back(path, { error: "The new password must be at least 10 characters" });
  if (password !== str(fd, "confirm")) back(path, { error: "The two passwords don't match" });
  const { error } = await authAdmin(path).updateUserById(id, { password });
  if (error) back(path, { error });
  const supabase = await createClient();
  await supabase.rpc("record_user_event", { p_user: id, p_action: "password_reset", p_reason: "Reset by administrator" });
  back(path, { notice: "Password reset. Share it privately and ask the user to change it under My account." });
}

export async function createUser(fd: FormData) {
  const path = "/admin?tab=users";
  await requireAdmin(path);
  const email = str(fd, "email").toLowerCase();
  const password = str(fd, "password");
  const role = str(fd, "role");
  const fullName = str(fd, "full_name");
  if (!email || password.length < 10) back(path, { error: "Email and a temporary password of at least 10 characters are required" });
  if (!(ROLES as readonly string[]).includes(role)) back(path, { error: "Choose a role" });

  const { data, error } = await authAdmin(path).createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error) back(path, { error });
  const userId = data.user.id;

  // Role is set by the signed-in admin through RLS, not by the service key.
  const supabase = await createClient();
  const { error: pErr } = await supabase.from("profiles").update({ role, plant_id: await getPlantId(), full_name: fullName }).eq("id", userId);
  if (pErr) back(path, { error: pErr });
  await supabase.rpc("record_user_event", { p_user: userId, p_action: "user_created", p_reason: null });
  revalidatePath("/admin");
  back(`/admin?tab=users&edit=${userId}`, { notice: `User ${email} created. Share the temporary password privately.` });
}

const MASTER_TABLES = ["varieties", "parties", "brokers", "locations"] as const;

export async function addMaster(fd: FormData) {
  const table = str(fd, "table") as (typeof MASTER_TABLES)[number];
  const path = "/admin?tab=masters";
  if (!MASTER_TABLES.includes(table)) back(path, { error: "Unknown master" });
  const name = str(fd, "name");
  if (!name) back(path, { error: "Name is required" });

  let row: Record<string, unknown>;
  switch (table) {
    case "varieties": {
      const bag = optNum(fd, "default_bag_weight_kg");
      const yieldPct = optNum(fd, "est_yield_pct");
      if (Number.isNaN(bag) || Number.isNaN(yieldPct)) back(path, { error: "Bag weight and yield must be numbers" });
      row = { name, code: str(fd, "code") || name.replace(/\s+/g, "").toUpperCase(), default_bag_weight_kg: bag ?? 50, est_yield_pct: yieldPct ?? 65 };
      break;
    }
    case "parties":
      row = { name, kind: str(fd, "kind") || "supplier", phone: optStr(fd, "phone"), gstin: optStr(fd, "gstin") };
      break;
    case "brokers":
      row = { name, phone: optStr(fd, "phone") };
      break;
    case "locations":
      row = { name, code: str(fd, "code") || name.replace(/\s+/g, "-").toUpperCase(), kind: str(fd, "kind") || "raw_store", plant_id: await getPlantId() };
      break;
  }
  const supabase = await createClient();
  const { error } = await supabase.from(table).insert(row!);
  if (error) back(path, { error });
  revalidatePath("/admin");
  back(path, { notice: `${name} added` });
}

export async function toggleMaster(fd: FormData) {
  const table = str(fd, "table") as (typeof MASTER_TABLES)[number];
  const path = "/admin?tab=masters";
  if (!MASTER_TABLES.includes(table)) back(path, { error: "Unknown master" });
  const supabase = await createClient();
  const { error } = await supabase.from(table).update({ active: str(fd, "active") === "true" }).eq("id", str(fd, "id"));
  if (error) back(path, { error });
  revalidatePath("/admin");
  back(path, { notice: "Updated" });
}

export async function updateVariety(fd: FormData) {
  const path = "/admin?tab=masters";
  const bag = optNum(fd, "default_bag_weight_kg");
  const yieldPct = optNum(fd, "est_yield_pct");
  if (bag === null || yieldPct === null || Number.isNaN(bag) || Number.isNaN(yieldPct)) back(path, { error: "Enter bag weight and yield" });
  const stdQ = optNum(fd, "std_tank_q");
  if (Number.isNaN(stdQ) || (stdQ !== null && stdQ <= 0)) back(path, { error: "Standard tank weight must be a positive number of quintals" });
  const supabase = await createClient();
  const { error } = await supabase
    .from("varieties")
    .update({ default_bag_weight_kg: bag, est_yield_pct: yieldPct, std_tank_kg: stdQ === null ? null : Math.round(stdQ * 100 * 100) / 100 })
    .eq("id", str(fd, "id"));
  if (error) back(path, { error });
  revalidatePath("/admin");
  back(path, { notice: "Variety updated" });
}

export async function updateSetting(fd: FormData) {
  const path = "/admin?tab=settings";
  await requireAdmin(path);
  const value = optNum(fd, "value");
  if (value === null || Number.isNaN(value)) back(path, { error: "Enter a number" });
  const supabase = await createClient();
  const { error } = await supabase.from("calc_settings").update({ value }).eq("key", str(fd, "key"));
  if (error) back(path, { error });
  revalidatePath("/admin");
  back(path, { notice: "Setting saved. It applies to records posted from now on; posted records keep their snapshot." });
}
