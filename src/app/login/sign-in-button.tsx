"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

/** Submit button that shows progress and blocks repeat clicks while signing in. */
export function SignInButton() {
  const { pending } = useFormStatus();
  return (
    <button className="btn-primary w-full" disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" /> Signing in…
        </>
      ) : (
        "Sign in"
      )}
    </button>
  );
}
