const TZ = "Asia/Kolkata";

export function kg(value: number | string | null | undefined, digits = 0) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return `${n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: 2 })} kg`;
}

export function num(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  return Number(value).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function date(value: string | null | undefined) {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(value + "T00:00:00+05:30") : new Date(value);
  return d.toLocaleDateString("en-IN", { timeZone: TZ, day: "2-digit", month: "short", year: "numeric" });
}

/** Start of today in IST, as an ISO string, for "today" filters. */
export function todayIST() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}

export function startOfTodayIST() {
  return new Date(`${todayIST()}T00:00:00+05:30`).toISOString();
}

export function minutesSince(value: string) {
  return Math.floor((Date.now() - new Date(value).getTime()) / 60000);
}

/** Readable message from a Supabase/Postgres error. */
export function errorMessage(err: { message?: string } | null | undefined) {
  const msg = err?.message ?? "Something went wrong";
  const labels: Record<string, string> = {
    PERMISSION_DENIED: "Not allowed",
    OVER_ALLOCATION: "Over-allocation",
    INSUFFICIENT_STOCK: "Not enough stock",
    DUPLICATE_CONSUMPTION: "Already used",
    INCOMPLETE_BATCH: "Not finished yet",
    EQUIPMENT_BUSY: "Equipment in use",
    STEAMER_BUSY: "Steamer in use",
    DRYER_BUSY: "Dryer still full",
    NO_STANDARD_WEIGHT: "Standard weight missing",
    NOTHING_UNLOADED: "Nothing unloaded",
    WRONG_PAIR: "Wrong tank pair",
    WRONG_DRYER: "Wrong dryer",
    WRONG_EQUIPMENT: "Wrong equipment",
    WRONG_SOURCE: "Wrong source batch",
    MULTI_INPUT: "Authorisation needed",
    MIXED_VARIETY: "Mixed variety",
  };
  return (
    msg
      .replace(/^([A-Z_]{4,}): /, (m, code: string) => (labels[code] ? `${labels[code]}: ` : m))
      // Database messages count kg; the plant floor works in quintals (1 q = 100 kg), so show both.
      .replace(/(\d+(?:\.\d+)?) kg\b/g, (_m, n: string) => {
        const kgVal = Number(n);
        const qVal = (kgVal / 100).toLocaleString("en-IN", { maximumFractionDigits: 3 });
        return `${qVal} q / ${kgVal.toLocaleString("en-IN", { maximumFractionDigits: 2 })} kg`;
      })
  );
}
