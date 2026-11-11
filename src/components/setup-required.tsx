export function SetupRequired() {
  return (
    <main className="mx-auto max-w-xl px-4 py-20">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Connect Supabase to continue</h1>
        <p className="mt-2 text-sm text-slate-600">
          The ERP needs a Supabase project. Add these to <code className="rounded bg-slate-100 px-1">.env.local</code> (or pull them
          from Vercel with <code className="rounded bg-slate-100 px-1">vercel env pull</code>), then restart the dev server:
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
{`NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...   # only for scripts/create-user.mjs`}
        </pre>
        <p className="mt-4 text-sm text-slate-600">
          Then apply <code className="rounded bg-slate-100 px-1">supabase/migrations</code> and <code className="rounded bg-slate-100 px-1">supabase/seed.sql</code>, and create the first admin with{" "}
          <code className="rounded bg-slate-100 px-1">npm run user:create</code>. See README.md.
        </p>
      </div>
    </main>
  );
}
