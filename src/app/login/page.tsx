import Image from "next/image";
import { SetupRequired } from "@/components/setup-required";
import { Flash } from "@/components/ui";
import { backendReady } from "@/lib/supabase/env";
import { signIn } from "./actions";
import { SignInButton } from "./sign-in-button";

export const dynamic = "force-dynamic";

function Brand() {
  return (
    <div className="mb-6 flex flex-col items-center gap-1 text-center">
      <span className="rounded-xl border border-line bg-white px-6 py-3 shadow-[0_1px_2px_rgba(16,24,40,0.05)]"><Image src="/logo.png" alt="Shree Rani Sati Overseas Pvt. Ltd." width={620} height={463} priority className="h-32 w-auto" /></span>
      <div className="text-sm font-semibold text-muted">Factory ERP</div>
    </div>
  );
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!backendReady()) return <SetupRequired />;
  const { error } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm">
        <Brand />
        <div className="card p-6">
          <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
          <Flash error={error} />
          <form action={signIn} className="space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input className="input" id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input className="input" id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <SignInButton />
          </form>
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">Accounts are created by your administrator.</p>
      </div>
    </main>
  );
}
