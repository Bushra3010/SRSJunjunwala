import { Trash2 } from "lucide-react";

/**
 * Admin-only permanent delete: opens to ask for a reason and the word DELETE.
 * Render it only for the administrator; the database checks the role again.
 */
export function AdminDelete({
  action,
  id,
  label,
  what,
  back,
  here,
  compact = false,
}: {
  action: (fd: FormData) => Promise<void>;
  id: string;
  /** Shown in the button and the notice, e.g. "RST 212" or "PAY-00004". */
  label: string;
  /** What else goes with it, in plain words. */
  what: string;
  /** Where to go after deleting. */
  back: string;
  /** Where to show an error (the current page). */
  here: string;
  compact?: boolean;
}) {
  return (
    <details className={compact ? "" : "rounded-[10px] border border-red-200 bg-white p-4"}>
      <summary className={`cursor-pointer list-none text-danger ${compact ? "btn-danger py-1 text-xs" : "flex items-center gap-1.5 text-[13px] font-semibold"}`}>
        <Trash2 className="size-3.5" /> Delete{compact ? "" : ` ${label} permanently`}
      </summary>
      <form action={action} className="mt-3 space-y-2">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="label" value={label} />
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="here" value={here} />
        <p className="text-[12px] text-muted">
          Removes {what}. This cannot be undone; a copy is kept in the audit trail. Only for wrong or test entries.
        </p>
        <input name="reason" required className="input text-[13px]" placeholder="Reason" aria-label={`Reason to delete ${label}`} />
        <input
          name="confirm"
          required
          pattern="[Dd][Ee][Ll][Ee][Tt][Ee]"
          autoComplete="off"
          className="input text-[13px]"
          placeholder="Type DELETE to confirm"
          aria-label={`Type DELETE to confirm deleting ${label}`}
        />
        <button className="btn-danger w-full">
          <Trash2 className="size-4" /> Delete {label}
        </button>
      </form>
    </details>
  );
}
