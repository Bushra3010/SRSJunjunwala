import type { Profile } from "@/lib/auth";
import { hasRole } from "@/lib/auth";
import { QC_REVIEWERS } from "@/lib/roles";
import type { QcStatus } from "@/lib/types";
import { qcAction } from "./actions";

/** Status actions: post / return (reviewers), reverse posted (reviewers), cancel draft (owner or reviewer). */
export function ReviewPanel({
  id,
  direction,
  status,
  profile,
  isOwner,
}: {
  id: string;
  direction: "inbound" | "outbound";
  status: QcStatus;
  profile: Profile;
  isOwner: boolean;
}) {
  const reviewer = hasRole(profile, QC_REVIEWERS);
  const hidden = (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="direction" value={direction} />
    </>
  );

  if (status === "submitted" && reviewer) {
    return (
      <div className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
        <div className="text-sm font-semibold">Review</div>
        <form action={qcAction} className="flex flex-wrap items-end gap-2">
          {hidden}
          <input type="hidden" name="op" value="post" />
          {direction === "outbound" && (
            <div className="min-w-64 flex-1">
              <label className="label" htmlFor="override">Approval reason (only if posting is blocked)</label>
              <input id="override" name="reason" className="input" placeholder="Leave empty unless posting is blocked" />
            </div>
          )}
          <button className="btn-primary">Approve & post</button>
        </form>
        <form action={qcAction} className="flex flex-wrap items-end gap-2">
          {hidden}
          <input type="hidden" name="op" value="return" />
          <div className="min-w-64 flex-1">
            <label className="label" htmlFor="return_reason">Return to operator — reason</label>
            <input id="return_reason" name="reason" className="input" required />
          </div>
          <button className="btn-secondary">Return to draft</button>
        </form>
      </div>
    );
  }

  if (status === "posted" && reviewer) {
    return (
      <form action={qcAction} className="flex flex-wrap items-end gap-2 rounded-lg border border-red-200 bg-red-50/40 p-4">
        {hidden}
        <input type="hidden" name="op" value="reverse" />
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="reverse_reason">Correct a posted record — reason (kept in the audit trail)</label>
          <input id="reverse_reason" name="reason" className="input" required />
        </div>
        <button className="btn-danger">Reverse for correction</button>
      </form>
    );
  }

  if ((status === "draft" && (isOwner || reviewer)) || (status === "submitted" && reviewer)) {
    return (
      <form action={qcAction} className="flex flex-wrap items-end gap-2">
        {hidden}
        <input type="hidden" name="op" value="cancel" />
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="cancel_reason">Wrong truck? Cancel this QC — reason</label>
          <input id="cancel_reason" name="reason" className="input" required />
        </div>
        <button className="btn-danger">Cancel QC</button>
      </form>
    );
  }
  return null;
}
