"use client";

import { Printer } from "lucide-react";

export function PrintButton({ className = "btn-secondary", label = "Print" }: { className?: string; label?: string }) {
  return (
    <button type="button" className={className} onClick={() => window.print()}>
      <Printer className="size-4" /> {label}
    </button>
  );
}
