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
  | "admin";

/** Which roles may open each module (PRD §9). Enforced again by RLS in the database. */
export const NAV_ACCESS: Record<NavKey, Role[]> = {
  overview: [...ROLES],
  weighbridge: ["admin", "management", "weighbridge_operator", "qc_head", "commercial"],
  qc: ["admin", "management", "qc_unloading", "qc_loading", "qc_head"],
  "purchase-orders": ["admin", "management", "commercial", "qc_head"],
  "sales-orders": ["admin", "management", "commercial", "qc_head"],
  processing: ["admin", "management", "foreman", "qc_head", "commercial"],
  inventory: ["admin", "management", "qc_head"],
  stores: ["admin", "management", "store_custodian"],
  reports: ["admin", "management", "qc_head", "commercial"],
  admin: ["admin", "management"],
};

export function canAccess(role: Role | null | undefined, key: NavKey) {
  return !!role && NAV_ACCESS[key].includes(role);
}

export const QC_REVIEWERS: Role[] = ["admin", "qc_head"];
export const ORDER_EDITORS: Role[] = ["admin", "management", "commercial"];
export const TICKET_CAPTURERS: Role[] = ["admin", "management", "weighbridge_operator"];
export const TICKET_RESOLVERS: Role[] = ["admin", "management", "qc_head"];
