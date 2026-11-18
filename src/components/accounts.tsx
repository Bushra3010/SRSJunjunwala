import Link from "next/link";
import clsx from "clsx";

export const ACCOUNT_TABS = [
  { key: "outstanding", label: "Outstanding", href: "/accounts" },
  { key: "ledger", label: "Party ledgers", href: "/accounts/ledger" },
  { key: "payments", label: "Payments & receipts", href: "/accounts/payments" },
  { key: "slips", label: "Purchase slips", href: "/purchase-slips" },
  { key: "tally", label: "Tally export", href: "/accounts/tally" },
  { key: "settings", label: "Tally settings", href: "/accounts/settings" },
];

export function AccountsNav({ active }: { active: string }) {
  return (
    <nav aria-label="Accounts" className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="flex w-max gap-1.5">
        {ACCOUNT_TABS.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === active ? "page" : undefined}
            className={clsx(
              "rounded-md border px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap",
              t.key === active ? "border-[#1f6b32] bg-[#1f6b32] text-white" : "border-line bg-white text-ink hover:border-[#c08a24] hover:text-[#7b5e2a]",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Balance with Dr / Cr: positive = they owe us (Dr), negative = we owe them (Cr). */
export function DrCr({ value }: { value: number | string | null | undefined }) {
  const n = Number(value ?? 0);
  if (Math.abs(n) < 0.005) return <span className="text-muted">Nil</span>;
  return (
    <span className={clsx("font-bold tabular-nums", n > 0 ? "text-[#1d4f9a]" : "text-[#a11a1a]")}>
      ₹{Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {n > 0 ? "Dr" : "Cr"}
    </span>
  );
}

export const VTYPE_LABEL: Record<string, string> = {
  Purchase: "Purchase",
  Sales: "Sales",
  Journal: "Brokerage",
  Payment: "Payment",
  Receipt: "Receipt",
};
