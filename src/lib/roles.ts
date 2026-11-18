export const ROLES = [
  "admin",
  "management",
  "weighbridge_operator",
  "qc_unloading",
  "qc_loading",
  "qc_head",
  "foreman",
  "store_custodian",
  "commercial",
  "production_manager",
  "soaking_operator",
  "steaming_operator",
  "drying_operator",
  "milling_operator",
  "accountant",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  management: "Management",
  weighbridge_operator: "Weighbridge operator",
  qc_unloading: "QC operator – Unloading",
  qc_loading: "QC operator – Loading",
  qc_head: "QC department head",
  foreman: "Boiler operator / Foreman",
  store_custodian: "Store room custodian",
  commercial: "Commercial / Orders",
  production_manager: "Production manager",
  soaking_operator: "Soaking operator",
  steaming_operator: "Steaming operator",
  drying_operator: "Drying operator",
  milling_operator: "Milling operator",
  accountant: "Accountant",
};

export type NavKey =
  | "overview"
  | "weighbridge"
  | "qc"
  | "purchase-orders"
  | "sales-orders"
  | "processing"
  | "inventory"
  | "stores"
  | "reports"
  | "accounts"
  | "purchase-slips"
  | "admin";

/** Which roles may open each module (PRD §9). Enforced again by RLS in the database. */
export const NAV_ACCESS: Record<NavKey, Role[]> = {
  overview: [...ROLES],
  weighbridge: ["admin", "management", "weighbridge_operator", "qc_head", "commercial"],
  qc: ["admin", "management", "qc_unloading", "qc_loading", "qc_head"],
  "purchase-orders": ["admin", "management", "commercial", "qc_head"],
  "sales-orders": ["admin", "management", "commercial", "qc_head"],
  processing: ["admin", "management", "production_manager", "soaking_operator", "steaming_operator", "drying_operator", "milling_operator", "foreman", "qc_head"],
  inventory: ["admin", "management", "qc_head"],
  stores: ["admin", "management", "store_custodian"],
  reports: ["admin", "management", "qc_head", "commercial"],
  accounts: ["admin", "management", "accountant", "commercial"],
  // Weighbridge operator and management can open slips to fill in Khad (set per deduction in Slip parameters).
  "purchase-slips": ["admin", "management", "accountant", "commercial", "qc_head", "weighbridge_operator"],
  admin: ["admin", "management"],
};

export function canAccess(role: Role | null | undefined, key: NavKey) {
  return !!role && NAV_ACCESS[key].includes(role);
}

export const QC_REVIEWERS: Role[] = ["admin", "qc_head"];
/** Who may record payments, fill rates and export to Tally. Mirrors can_edit_accounts() in the database. */
export const ACCOUNT_EDITORS: Role[] = ["admin", "accountant"];
/** Who may send slips to brokers on WhatsApp. Mirrors log_slip_send() in the database. */
export const SLIP_SENDERS: Role[] = ["admin", "accountant", "management"];
export const ORDER_EDITORS: Role[] = ["admin", "management", "commercial"];
export const TICKET_CAPTURERS: Role[] = ["admin", "management", "weighbridge_operator"];
export const TICKET_RESOLVERS: Role[] = ["admin", "management", "qc_head"];

/** Who may operate each production stage. Mirrors require_stage_role() in the database. */
export const STAGE_OPERATORS: Record<string, Role[]> = {
  receipt: ["admin", "production_manager", "qc_head"],
  precleaning: ["admin", "production_manager", "soaking_operator", "foreman"],
  soaking: ["admin", "production_manager", "soaking_operator", "foreman"],
  steaming: ["admin", "production_manager", "steaming_operator", "foreman"],
  drying: ["admin", "production_manager", "drying_operator", "foreman"],
  mill_feed: ["admin", "production_manager", "drying_operator", "milling_operator", "foreman"],
  milling: ["admin", "production_manager", "milling_operator"],
  output: ["admin", "production_manager", "milling_operator"],
};
export const PRODUCTION_APPROVERS: Role[] = ["admin", "production_manager"];
export const PRODUCTION_QUALITY: Role[] = ["admin", "production_manager", "qc_head"];
export const FAULT_REPORTERS: Role[] = ["admin", "production_manager", "soaking_operator", "steaming_operator", "drying_operator", "milling_operator", "foreman"];
