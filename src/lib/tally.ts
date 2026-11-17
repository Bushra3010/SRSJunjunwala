/**
 * TallyPrime import files (XML). The accountant imports them in TallyPrime:
 * Gateway of Tally → Import → Transactions (vouchers) or Masters (ledgers).
 *
 * Amount signs follow Tally: a debit is a negative amount with ISDEEMEDPOSITIVE=Yes,
 * a credit is a positive amount with ISDEEMEDPOSITIVE=No.
 */

export type TallySettings = Record<string, string>;

export type Voucher = {
  voucher_key: string;
  vtype: "Purchase" | "Sales" | "Journal" | "Payment" | "Receipt" | string;
  vdate: string; // YYYY-MM-DD
  ref: string;
  ledger_name: string; // party or broker ledger
  amount: number;
  narration: string;
  bank_ledger?: string | null; // payments / receipts
  party_group?: string; // for the masters file
};

const esc = (s: string | number | null | undefined) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

function entry(ledger: string, amount: number, debit: boolean) {
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? "-" : ""}${amt(amount)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
}

/** Debit / credit ledgers for one voucher. */
export function voucherLines(v: Voucher, s: TallySettings): { type: string; debit: string; credit: string } {
  const bank = v.bank_ledger || s.cash_ledger || "Cash";
  switch (v.vtype) {
    case "Purchase":
      return { type: s.purchase_vch || "Purchase", debit: s.purchase_ledger || "Purchase", credit: v.ledger_name };
    case "Sales":
      return { type: s.sales_vch || "Sales", debit: v.ledger_name, credit: s.sales_ledger || "Sales" };
    case "Journal":
      return { type: s.journal_vch || "Journal", debit: s.brokerage_ledger || "Brokerage", credit: v.ledger_name };
    case "Payment":
      return { type: s.payment_vch || "Payment", debit: v.ledger_name, credit: bank };
    case "Receipt":
      return { type: s.receipt_vch || "Receipt", debit: bank, credit: v.ledger_name };
    default:
      throw new Error(`Unknown voucher type ${v.vtype}`);
  }
}

function envelope(report: "Vouchers" | "All Masters", company: string, messages: string[]) {
  const vars = company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME>${vars}</REQUESTDESC><REQUESTDATA>\n` +
    messages.join("\n") +
    `\n</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`
  );
}

/** Vouchers file. REMOTEID is the ERP's own id for the entry, so Tally can tell entries apart. */
export function vouchersXml(vouchers: Voucher[], s: TallySettings) {
  const msgs = vouchers.map((v) => {
    const { type, debit, credit } = voucherLines(v, s);
    const date = v.vdate.slice(0, 10).replace(/-/g, "");
    const remote = "SRS-" + v.voucher_key.replace(/:/g, "-");
    const party = v.vtype === "Journal" ? credit : v.ledger_name;
    return (
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="${esc(remote)}" VCHTYPE="${esc(type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">` +
      `<DATE>${date}</DATE><EFFECTIVEDATE>${date}</EFFECTIVEDATE><VOUCHERTYPENAME>${esc(type)}</VOUCHERTYPENAME>` +
      `<REFERENCE>${esc(v.ref)}</REFERENCE><PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>` +
      `<NARRATION>${esc(`${v.narration} [ERP ${v.voucher_key}]`)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>` +
      entry(debit, v.amount, true) +
      entry(credit, v.amount, false) +
      `</VOUCHER></TALLYMESSAGE>`
    );
  });
  return envelope("Vouchers", s.company || "", msgs);
}

/** Ledger masters for the parties, brokers, banks and accounts the vouchers use (import once, before the vouchers). */
export function mastersXml(ledgers: { name: string; parent: string }[], s: TallySettings) {
  const seen = new Set<string>();
  const msgs: string[] = [];
  for (const l of ledgers) {
    const key = l.name.trim().toLowerCase();
    if (!l.name.trim() || seen.has(key)) continue;
    seen.add(key);
    msgs.push(
      `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(l.name)}" ACTION="Create"><NAME.LIST><NAME>${esc(l.name)}</NAME></NAME.LIST>` +
        `<PARENT>${esc(l.parent)}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>`,
    );
  }
  return envelope("All Masters", s.company || "", msgs);
}

/** Indian rupee format for screens. */
export function rupees(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === "") return "—";
  return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
