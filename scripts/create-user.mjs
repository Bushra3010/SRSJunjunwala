// Create a user with a role (use this for the first administrator).
// Usage: npm run user:create -- <email> <role> "<Full Name>"
// Reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local.
// Prompts for the password so it never lands in shell history.
import { createClient } from "@supabase/supabase-js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const ROLES = ["admin", "management", "weighbridge_operator", "qc_unloading", "qc_loading", "qc_head", "foreman", "store_custodian", "commercial"];
const [email, role, fullName = ""] = process.argv.slice(2);

if (!email || !ROLES.includes(role)) {
  console.error(`Usage: npm run user:create -- <email> <role> "<Full Name>"\nRoles: ${ROLES.join(", ")}`);
  process.exit(1);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

// Read the password without echoing it to the terminal.
async function askHidden(prompt) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (s) => {
    if (s.startsWith(prompt) || s === "\r\n" || s === "\n") write?.(s);
  };
  const answer = await rl.question(prompt);
  rl.close();
  stdout.write("\n");
  return answer;
}
const password = await askHidden("Password (min 10 chars, hidden): ");
if (password.length < 10) {
  console.error("Password too short");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
if (error) {
  console.error(error.message);
  process.exit(1);
}
const { data: plant } = await supabase.from("plants").select("id").order("created_at").limit(1).single();
const { error: pErr } = await supabase.from("profiles").update({ role, full_name: fullName, plant_id: plant?.id ?? null }).eq("id", data.user.id);
if (pErr) {
  console.error(pErr.message);
  process.exit(1);
}
console.log(`Created ${email} as ${role}`);
