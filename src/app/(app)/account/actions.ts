"use server";

import { redirect } from "next/navigation";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { getSession } from "@/lib/auth";
import { supabaseEnv } from "@/lib/supabase/env";

const PATH = "/account";
const fail = (msg: string): never => redirect(`${PATH}?error=${encodeURIComponent(msg)}`);

export async function updateMyName(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const name = String(fd.get("full_name") ?? "").trim();
  if (!name) fail("Enter your name.");
  const { error } = await session.supabase.from("profiles").update({ full_name: name }).eq("id", session.user.id);
  if (error) fail(error.message);
  redirect(`${PATH}?notice=${encodeURIComponent("Name updated.")}`);
}

export async function changeMyPassword(fd: FormData) {
  const session = await getSession();
  if (!session) redirect("/login");
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirm") ?? "");
  if (next.length < 10) fail("New password must be at least 10 characters.");
  if (next !== confirm) fail("The new passwords don't match.");
  if (next === current) fail("Choose a password different from the current one.");

  // Check the current password with a throwaway client so the browser session is untouched.
  const { url, key } = supabaseEnv()!;
  const probe = createPlainClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: wrong } = await probe.auth.signInWithPassword({ email: session.user.email!, password: current });
  if (wrong) fail("Your current password is incorrect.");
  await probe.auth.signOut({ scope: "local" });

  const { error } = await session.supabase.auth.updateUser({ password: next });
  if (error) fail(error.message);
  redirect(`${PATH}?notice=${encodeURIComponent("Password changed.")}`);
}
