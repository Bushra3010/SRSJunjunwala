export type TicketStatus =
  | "awaiting_qc"
  | "qc_in_progress"
  | "submitted"
  | "posted"
  | "duplicate"
  | "exception"
  | "cancelled";

export type Ticket = {
  id: string;
  pid: string;
  plant_id: string;
  cycle_id: string | null;
  rst: number;
  vehicle_no: string;
  direction: "inbound" | "outbound";
  gross_kg: number | null;
  tare_kg: number | null;
  net_kg: number | null;
  ticket_ref: string | null;
  weighed_at: string;
  capture_method: "sms" | "manual" | "import";
  source_payload: string | null;
  status: TicketStatus;
  exception_reason: string | null;
  duplicate_of: string | null;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
  rst_cycles?: { label: string } | null;
};

export type QcStatus = "draft" | "submitted" | "posted" | "reversed" | "cancelled";

export type Option = { id: string; name: string };
export type Variety = { id: string; code: string; name: string; default_bag_weight_kg: number; est_yield_pct: number };
