# Product Requirements Document (PRD)
## SRS Overseas Factory ERP

| | |
|---|---|
| **Client** | Shree Rani Sati Overseas Pvt. Ltd. (SRS Overseas) |
| **Product** | SRS Overseas Factory ERP (web, responsive for desktop / tablet / mobile) |
| **Document version** | PRD v1.0 (Draft for discovery workshop) |
| **Date** | 12 November 2026 |
| **Source inputs** | *ERP System Requirements – Functional Requirements v1.0* (30 Oct 2026); 9 UI mockups (Overview, Weighbridge, Quality Control, Purchase Orders, Sales Orders, Processing, Inventory, Stores & Repairs, Reports) |
| **Status** | Draft. Items marked **[TBC]** need a client decision before build (see §15 Decision Log) |

---

## 1. Executive summary

SRS Overseas runs a paddy/rice processing plant (boiler → soaking → drying → milling) fed by inbound purchase trucks and emptied by outbound sales trucks. Today the weighbridge prints an **RST** slip, and everything after that (party, broker, QC deductions, order balances, processing status, stock, store room) lives on paper, phone calls and spreadsheets.

The Factory ERP creates **one traceable chain** from the weighbridge ticket through QC, order allocation, processing lots, stock movement and reporting. The RST stays the number people use on the floor, but every record gets a **permanent system ID** so that RST resets (every 4–5 months) never overwrite or mix up history.

**Core principle:** *one RST-led chain of traceability, keyed internally by a permanent ID that never changes.*

---

## 2. Problem statement

| Problem today | Impact |
|---|---|
| RST numbers reset every 4–5 months and are reused | Historical lookups are ambiguous; risk of merging two different trucks into one record |
| Weighbridge operator must not know party/broker, but someone must attach them later | Commercial data is captured inconsistently, often from memory or paper |
| QC deductions (moisture, rejected/returned bags) are not linked to purchase orders | PO balances and supplier settlements are reconciled manually |
| Multi-variety outbound loads are hard to allocate against sales orders | Over-/under-delivery isn't visible until late |
| No live view of boiler, soaking, drying, milling | Owners/managers must call the floor; faults are found late |
| Estimated milling output and physical stock are mixed | Stock figures are unreliable |
| Store room consumables and items sent for repair aren't tracked | Stock-outs, lost parts, overdue repairs, unknown repair costs |

---

## 3. Goals, non-goals and success metrics

### 3.1 Goals
1. **G1 – Traceability:** every truck movement is traceable from weighbridge ticket → QC → order → lot → stock → report via a permanent ID.
2. **G2 – Data integrity:** posted records are never silently edited or deleted; RST reuse never corrupts history.
3. **G3 – Order reconciliation:** PO and SO balances update automatically from QC-approved transactions using the client's calculation rules.
4. **G4 – Plant visibility:** management sees live (or clearly time-stamped) status and faults of boiler, soaking, drying and milling, remotely.
5. **G5 – Trustworthy stock:** stock by variety / location / lot with on-hand, reserved, in-process and available, keeping *estimated* and *confirmed* separate.
6. **G6 – Store room control:** consumables ledger and repair tracking with overdue reminders.
7. **G7 – Least privilege:** each role sees only what its job needs, enforced on the server.

### 3.2 Non-goals (v1)
- Financial accounting / GST invoicing / ledgers (integration with Tally or similar may be considered later) **[TBC]**
- Payroll, HR, attendance
- Full predictive maintenance or SCADA control of equipment (read-only sensor feeds only, if feasible)
- Customer/supplier self-service portals
- Native mobile apps (responsive web first; PWA considered for offline)

### 3.3 Success metrics (measured during pilot)

| Metric | Target |
|---|---|
| Inbound trucks with a QC record linked to a weighbridge ticket | ≥ 99% |
| Duplicate postings caused by repeated SMS/tickets | 0 |
| Historical records altered by an RST reset (reset simulation test) | 0 |
| PO/SO balance in ERP vs manual reconciliation | 100% match on pilot sample |
| Median time from truck at QC point → QC submitted | ≤ 5 min |
| Faults reported in-system vs by phone (after 4 weeks) | ≥ 90% in-system |
| Overdue repair items without a reminder | 0 |

---

## 4. Users and roles

| Role | Primary goals | Key screens | Must NOT access |
|---|---|---|---|
| **Weighbridge operator** | Capture/verify ticket, print slip | Weighbridge | Party/broker entry, orders, stock, settings |
| **QC operator – Unloading** | Complete inbound QC for assigned trucks | QC → Inbound queue | Stock views, order admin, settings |
| **QC operator – Loading** | Complete outbound QC / multi-variety loading | QC → Outbound queue | Stock views, order admin, settings |
| **QC department head** | Review/approve QC, view department stock | QC (review), Inventory (scoped) | Settings, user admin |
| **Boiler operator / Foreman** (boiler, soaking, drying, milling) | Update status, readings, faults | Processing (own department) | Orders, stock, QC |
| **Store room custodian** | Record receipts/issues, repair dispatch/return | Stores & Repairs | Orders, QC, plant stock |
| **Commercial / order user** | Create and manage POs and SOs | Purchase Orders, Sales Orders, Reports (commercial) | Settings, stock adjustments |
| **Inventory / stock controller** **[TBC – confirm as separate role]** | Approve adjustments, transfers, physical counts | Inventory | Settings |
| **Administrator / Management** | Users, masters, configuration, all reports, approvals | All | — |

Detailed permission matrix: §9.

---

## 5. Glossary

| Term | Meaning |
|---|---|
| **RST** | Weighbridge-generated ticket number. Human-facing; **not unique** (resets every ~4–5 months). |
| **RST cycle** | A period between RST resets. Identified by date range or a cycle label (e.g., `C2026-02`). |
| **Permanent ID (PID)** | System-generated immutable ID for every ERP transaction (mockup: `PID-000981`). Primary key for all links. |
| **Ticket** | A weighbridge record: RST, vehicle, gross/tare/net, timestamp, source payload. |
| **Movement** | A truck visit: Inbound (purchase/unloading) or Outbound (sales/loading). |
| **Inbound QC / Receipt (RST receipt / GRN)** | QC result for an unloaded truck: variety, party, broker, location, moisture, bags, accepted qty. |
| **Outbound QC / Dispatch (DSP)** | QC result for a loaded truck: one or more varieties, quantities, bags, location, driver phone. |
| **Lot** | A traceable quantity of material moving through soaking/drying/milling (mockup: `LOT-2501-0347`). |
| **Posting** | The point where a transaction updates order balances and stock. Before posting, records are draft/under review. |
| **Estimated output** | Milling output computed from input × yield assumption. Never replaces confirmed stock without an approval. |

---

## 6. Information architecture

Left navigation (consistent across mockups):

1. **Overview** – operations dashboard
2. **Weighbridge** – ticket register & capture
3. **Quality Control** – Inbound QC / Outbound QC (Loading – multiple varieties)
4. **Purchase Orders**
5. **Sales Orders**
6. **Processing** – plant floor status, lot details
7. **Inventory** – stock by variety/location/lot, estimated milling output, movement history
8. **Stores & Repairs** – item register, movements, under repair
9. **Reports** – report catalog with filters and export
10. **Admin / Settings** *(not in mockups — required)* – users, roles, masters, RST cycles, alert rules, calculation config

Global header: **Plant selector** (e.g., "Main Plant" → implies multi-plant support **[TBC]**), **Date filter** ("Today"), **notifications bell**, user menu.

Menu items are hidden when the user's role has no access to them (not just disabled).

---

## 7. Functional requirements

Priority key: **P0** = must have for go-live · **P1** = should have for go-live / early follow-up · **P2** = later.
Phase key refers to §13.

### 7.1 Overview dashboard (Phase 3)

**User story:** As a manager I want one screen showing what is happening in the plant right now, so that I can act on exceptions without calling the floor.

| ID | Requirement | Pri |
|---|---|---|
| OV-01 | KPI cards: **Trucks on site**, **Awaiting QC**, **Ready to dispatch**, **Active batches/lots**. Each card links to the filtered list. | P0 |
| OV-02 | **Vehicle queue** table (RST, vehicle, direction, net weight, status) with tabs *All movements / Awaiting QC / Ready to dispatch*. | P0 |
| OV-03 | **Processing status** panel: process, lot ID, state (In progress / Running / Overdue / Paused / Fault), details (equipment, since-time, quantity). | P0 |
| OV-04 | **Needs attention** panel: trucks waiting > X min, overdue lot stages, faults, repair returns due today, integration exceptions. Thresholds configurable. | P0 |
| OV-05 | Dashboard content is role-scoped (e.g., a foreman sees only their department; QC operator sees only their queue). | P0 |
| OV-06 | Every row drills down to the underlying record by permanent ID. | P0 |
| OV-07 | Data freshness indicator on live widgets ("updated 2 min ago"; stale data greyed/labelled). | P0 |
| OV-08 | **AI review inbox** (in mockup: "WhatsApp slip · RST 0421 – Review draft", "Boiler voice note – Draft"). See §7.11 – **proposed, not in requirements brief**. | P2 [TBC] |
| OV-09 | "**New gate entry**" button (in mockup). Gate entry is not defined in the brief – see §15 D-17. | [TBC] |

**Acceptance:** KPI counts equal the counts in the underlying lists for the same plant/date filter; drill-down opens the correct permanent-ID record.

---

### 7.2 Weighbridge & RST management (Phase 2 core; Phase 4 automation)

**Context:** The weighbridge is a classic unit that sends SMS via a SIM card and generates its own RST. The weighbridge operator prints the slip and **must not enter party or broker names**.

**User stories**
- As a weighbridge operator I want tickets to appear automatically (or be quickly captured) so that I don't retype data.
- As a QC user I want to find the truck by RST and confirm it's the right movement.
- As an admin I want duplicates and malformed messages held for review so that nothing is double-posted.

| ID | Requirement | Pri |
|---|---|---|
| WB-01 | **Ticket capture – automated:** ingest weighbridge SMS (via SIM gateway/modem or SMS-forwarding service) and parse RST, vehicle no., timestamp, gross, tare, net, ticket reference. Exact format **[TBC – D-01]**. | P1 (Ph 4) |
| WB-02 | **Ticket capture – assisted (fallback):** "Capture ticket" form / bulk import that records the same fields + original ticket reference. No party/broker fields on this form. | P0 |
| WB-03 | Every ticket gets a **Permanent ID** at creation (`PID-xxxxxx`), immutable. | P0 |
| WB-04 | Store RST together with its **RST cycle** (cycle label and/or date window). | P0 |
| WB-05 | Store raw source payload (SMS text / import row), received time, integration status (Received / Parsed / Failed / Duplicate / Resolved). | P0 |
| WB-06 | **Duplicate check** on ingest: same RST + same cycle + same vehicle + same weights within a window → mark *Duplicate*, do not create a new movement. Show "No duplicate found" / "Possible duplicate" badge (as in mockup). | P0 |
| WB-07 | Malformed/incomplete messages go to an **Exceptions queue** (mockup: "Exceptions 1" tab) for an authorized user to fix, link or reject — with reason and audit. | P0 |
| WB-08 | **Ticket Register** list: RST, Permanent ID, vehicle, cycle (In/Out), gross, tare, net, source (Purchase/Sales), status; search by RST / vehicle / PID; filters by date, source, status; pagination. | P0 |
| WB-09 | **Ticket detail drawer:** RST, status, movement type, original ticket reference (e.g., `WB-2025-01-0421`), duplicate check, ticket information, weights, linked QC/order records, audit history. | P0 |
| WB-10 | Ticket statuses: `Captured → Awaiting QC → QC in progress → QC hold → Submitted → Posted → Completed`; side states `Duplicate`, `Exception`, `Cancelled`. Final list **[TBC – D-06]**. | P0 |
| WB-11 | Print / reprint weighbridge slip from the ERP (reprint is logged). | P1 |
| WB-12 | Weighbridge operator UI must **not** show or allow editing of party/broker. ⚠️ The current mockup shows "Supplier: Sri Ashok Minerals" on the weighbridge ticket detail — this must be removed for the weighbridge role or shown only to roles allowed to see it, and only after QC has captured it. | P0 |

**RST reset rules (critical)**

| ID | Requirement | Pri |
|---|---|---|
| RST-01 | RST is never a unique key; the PID is the key for all links, attachments, audit events and postings. | P0 |
| RST-02 | RST cycles are created by an admin (start date, optional label) or detected automatically when RST numbers drop sharply **[TBC – D-02]**. | P0 |
| RST-03 | On RST reuse, the earlier record stays intact; the new one is told apart by cycle/date, vehicle and ticket metadata. | P0 |
| RST-04 | If a lookup by RST returns more than one plausible record, the user **must** pick (shows cycle, date, vehicle, weights) — the system never auto-picks. If still ambiguous, route to authorized resolution. | P0 |
| RST-05 | Default RST search scope = current cycle; option to search all cycles. | P0 |
| RST-06 | Late-arriving messages from a previous cycle are flagged for review **[TBC – D-02]**. | P1 |
| RST-07 | Posted records cannot be destructively replaced; corrections use amendment/reversal (see §7.12). | P0 |

**Acceptance:**
- Two different vehicles with the same RST in two cycles → two separate PIDs, both independently searchable and unchanged.
- Same SMS received twice → one movement, second marked Duplicate, nothing double-posted.
- RST lookup matching two records → user prompted to choose.

---

### 7.3 Quality Control (Phase 2)

Two tabs: **Inbound QC** and **Outbound QC (Loading – Multiple Varieties)**. QC users see a **work queue** of their assigned trucks only.

#### 7.3.1 Inbound QC (unloading)

**User story:** As an unloading QC operator, when a truck reaches the unloading point I enter or scan its RST, confirm it's the right truck, and record variety, party, broker, location, moisture and bag counts.

| ID | Requirement | Pri |
|---|---|---|
| QCI-01 | Enter or **scan** RST (barcode/QR on printed slip **[TBC]**); system fetches matching ticket(s) and shows vehicle, net weight, time for **confirmation**. | P0 |
| QCI-02 | Capture **Supplier (party)***, **Broker**, **Location*** (yard/godown), **Variety***. | P0 |
| QCI-03 | Configurable QC fields: **Moisture %***, moisture deduction, number of sacks, **sacks received***, returned sacks, **rejected bags**, bags unloaded. Exact definitions, required/optional and formulas **[TBC – D-05]**. | P0 |
| QCI-04 | **Variety-wise QC table** (in mockup): if one inbound truck carries multiple varieties, capture one row per variety (variety, moisture %, sacks received, rejected bags, accepted sacks, status) with totals. ⚠️ The brief only describes multi-variety for *outbound*; confirm for inbound **[TBC – D-07]**. | P0 if confirmed |
| QCI-05 | Auto-calculate accepted sacks / accepted weight / deductions per the confirmed purchase calculation rules; show the formula result read-only. | P0 |
| QCI-06 | **Original slip** panel: show the photo/scan of the paper slip next to the form (mockup). Photo attachment via camera on tablet/mobile. | P1 |
| QCI-07 | Record QC operator, timestamps, notes, attachments. | P0 |
| QCI-08 | **Save draft** and **Submit for review** actions. | P0 |
| QCI-09 | Link to **Purchase Order** line (auto-suggest open POs for this supplier + variety; user confirms). | P0 |
| QCI-10 | On approval/posting: create inventory receipt (stock movement) and update PO received/rejected/balance per confirmed rules. | P0 |
| QCI-11 | Validation: mandatory fields; sensible ranges (e.g., moisture 0–40%, rejected ≤ received, weights > 0); block submit on errors with clear messages. | P0 |

#### 7.3.2 Outbound QC (loading)

| ID | Requirement | Pri |
|---|---|---|
| QCO-01 | Select RST → verify vehicle details. | P0 |
| QCO-02 | **Add variety** button: record one or more varieties on the same vehicle; per variety capture quantity, bag count, bag weight. | P0 |
| QCO-03 | Capture loading location, **driver phone number**, other dispatch details **[TBC]**. | P0 |
| QCO-04 | Link each variety line to a **Sales Order** line; show remaining SO balance live. | P0 |
| QCO-05 | **Over-allocation control:** block, or allow with "requires approval" flag, when loaded qty > SO balance (+ tolerance) **[TBC – D-04]**. | P0 |
| QCO-06 | On posting: reduce SO open balance per "classic" sales calculation; create stock issue movement; create Dispatch record (DSP-xxxx). | P0 |
| QCO-07 | Validation: sum of variety weights vs weighbridge net weight within tolerance **[TBC]**; warn otherwise. | P1 |

#### 7.3.3 Common QC controls

| ID | Requirement | Pri |
|---|---|---|
| QC-01 | Status progression: `Awaiting QC → In progress → Submitted → Reviewed → Posted`, plus `Cancelled`, `QC Hold`. Final list **[TBC – D-06]**. | P0 |
| QC-02 | Review/approval by QC department head (if approval step is confirmed) before posting. | P0 |
| QC-03 | Post-posting correction only via amendment with reason; original values remain visible. | P0 |
| QC-04 | Search by RST, PID, vehicle, date, party, broker, variety, order ref — limited by role. | P0 |
| QC-05 | QC operators cannot see stock, order admin, or settings. | P0 |

**Acceptance:** multi-variety load updates each SO line correctly; a posted receipt correction shows old and new values with user/time/reason.

---

### 7.4 Purchase Orders (Phase 2)

**User story:** As a commercial user I create POs for suppliers and see how much has been received, rejected and is still pending, receipt by receipt.

| ID | Requirement | Pri |
|---|---|---|
| PO-01 | Create/edit PO: supplier, broker (optional), order date, expected-by date, lines (variety, ordered qty, unit, rate), order value, terms **[TBC]**. | P0 |
| PO-02 | PO list with search (PO no., supplier, variety) and filters (supplier, status). Statuses: `Draft, Posted/Open, Partially Received, Closed, Cancelled`. | P0 |
| PO-03 | PO detail: per line **Ordered / Accepted / Rejected / Remaining** + totals (mockup). | P0 |
| PO-04 | **Pending approval (receipts)** section: QC receipts linked to this PO waiting for approval. | P0 |
| PO-05 | **Posted receipts** section: RST no. (clickable to PID record), receipt date, variety, received / accepted / rejected, status. | P0 |
| PO-06 | Purchase calculation (deductions, moisture, tolerance, rounding, returns/rejections, multi-variety) is **configurable** and documented before build **[TBC – D-03]**. | P0 |
| PO-07 | Auto-close PO when remaining ≤ tolerance, or manual close with reason. | P1 |
| PO-08 | Print PO (PDF). | P1 |
| PO-09 | Manual re-allocation of a receipt to a different PO requires permission + reason (+ approval **[TBC]**). | P0 |

---

### 7.5 Sales Orders (Phase 2)

| ID | Requirement | Pri |
|---|---|---|
| SO-01 | Create/edit SO: customer, order date, required-by, lines (variety, qty, unit, rate). | P0 |
| SO-02 | SO list: search (SO no., customer, variety), filters (customer, status), statuses `Open, Partially Dispatched, Dispatched, Closed, Cancelled`. | P0 |
| SO-03 | SO detail header: Ordered / Dispatched / Remaining / Fulfillment % with progress bar (mockup). | P0 |
| SO-04 | Order lines with per-line fulfillment % and status. | P0 |
| SO-05 | **Dispatch history:** dispatch no., date, variety, qty, vehicle no., status; links to RST/PID. | P0 |
| SO-06 | Use client's existing **"classic" calculation** (units, rounding, bag weight, partial/over/under-delivery) **[TBC – D-04]**. | P0 |
| SO-07 | Reserve stock against open SOs (feeds "Reserved" column in Inventory) **[TBC]**. | P1 |

**Reconciliation & posting (PO and SO)**

| ID | Requirement | Pri |
|---|---|---|
| REC-01 | Traceable link between each order line and each RST transaction (many-to-many with quantities). | P0 |
| REC-02 | Partial receipts/dispatches supported; balances always shown. | P0 |
| REC-03 | Order and stock balances update **only** at the agreed QC/approval milestone **[TBC – D-08]**. | P0 |
| REC-04 | Posting is atomic: QC record, order balance and stock movement update together or not at all. | P0 |

---

### 7.6 Processing (Phase 3)

Departments in scope: **Boiler, Soaking, Drying, Milling**.

**Plant floor status** table (mockup): Stage, Equipment (e.g., BLR-01 6 TPH, SOK-01 30 KL, DRY-02 5 TPH, MLN-01 2 TPH), Lot, Start time, Operating state (Running / Paused / Completed / Fault / Idle), Last update. **Report fault** button.

| ID | Requirement | Pri |
|---|---|---|
| PR-01 | **Boiler:** on/off state, pressure (manual or sensor), last update time; operator records state changes, faults, notes. | P0 |
| PR-02 | **Soaking:** start/stop, tank no., lot, responsible operator; multiple tanks and concurrent lots. | P0 |
| PR-03 | **Drying:** start/stop against the same lot; pause with reason (e.g., "Temp high 72 °C"). | P0 |
| PR-04 | **Milling:** current lot, line/machine, start/stop, downtime/faults; input qty and output by variety/grade/product incl. by-products (bran, broken, husk) and losses **[TBC]**. | P0 |
| PR-05 | **Report fault:** department, equipment, fault code, severity, description, photo; triggers notification to configured recipients; fault lifecycle `Open → Acknowledged → Resolved`. | P0 |
| PR-06 | Planned vs actual times and elapsed-time display; "Overdue" status when a stage exceeds planned duration. | P1 [TBC] |
| PR-07 | **Lot details:** linked receipt (GRN/RST), material, received qty, receipt date, supplier, processing history (time, stage, equipment, event, remarks). | P0 |
| PR-08 | **Estimated output** = input × yield % per variety (configurable); shown with "≈ x% recovery". | P0 |
| PR-09 | **Confirmed output** entered via a confirmation workflow (approver, reason); never silently overwrites estimates or stock. Shows "Not yet available" until confirmed. | P0 |
| PR-10 | **Sensor integration** (boiler pressure/state, dryer temperature) — feasibility study; readings labelled *Sensor / Manual / Unavailable / Last received at…*; stale threshold configurable. | P2 (evaluate Ph 4) |
| PR-11 | **Lot rules:** create, split, merge, relabel, rework with full lineage **[TBC – D-09]**. | P0 (basic create) / P1 (split/merge) |
| PR-12 | Foremen only update their own department. | P0 |

---

### 7.7 Inventory (Phase 3)

| ID | Requirement | Pri |
|---|---|---|
| INV-01 | Stock by **variety × location × lot**: On hand, Reserved, In process, Available (= On hand − Reserved − In process), with totals and filters (mockup). | P0 |
| INV-02 | Units of measure & conversions (kg, quintal, bags × bag weight) configurable. | P0 |
| INV-03 | Movement types: Receipt (purchase), Sales issue, Production issue, Production receipt, Transfer (inter-location), Adjustment, Return, Rejection. Each with reference (PO/SO/PROC/TR/ADJ), PID, user, time. | P0 |
| INV-04 | **Stock movement history** with date range, movement type filter, search by lot/variety/reference; status (Processed / Completed / Approved / Pending). | P0 |
| INV-05 | **Estimated milling output** panel: variety, input stock, est. recovery %, est. output – clearly labelled *Estimate*. | P0 |
| INV-06 | Separate **confirmed/on-hand** from **estimated** and **pending/unposted** quantities everywhere they appear. | P0 |
| INV-07 | **Request adjustment** → approval workflow (reason, approver, audit). Physical stock count with variance report. | P0 |
| INV-08 | Visibility restricted to designated QC dept heads and management/stock roles. | P0 |
| INV-09 | Opening balance import for go-live **[TBC – D-14]**. | P0 |

---

### 7.8 Stores & Repairs (Phase 3)

Tabs: **Item register**, **Movements**, **Under repair**. Button: **Record movement**.

| ID | Requirement | Pri |
|---|---|---|
| ST-01 | Item catalogue: code, name, category, unit, opening balance, reorder level, location/bin. | P0 |
| ST-02 | Consumables list: code, item, category, unit, available qty, reorder level, status (`In Stock` / `Below Reorder` / `Out of Stock`); search + category filter. | P0 |
| ST-03 | Record **receipt/issue**: qty, date/time, reference, purpose, recipient/department, issuing/receiving person, recorded-by (custodian). | P0 |
| ST-04 | Item ledger: balance and movement history; flags for negative balance and likely duplicate entries. | P0 |
| ST-05 | Corrections/adjustments only by authorized users with reason + audit. | P0 |
| ST-06 | **Send for repair:** item, qty or serial no., condition/fault, date sent, mechanic/vendor, expected return, quotation/cost, notes → moves to "Under repair" location; **not** counted as available. | P0 |
| ST-07 | Repair status: `Sent → With mechanic → Repair in progress → Returned / Unrepaired / Scrapped`; **Overdue** auto-flag when past expected return (mockup highlights row in red). | P0 |
| ST-08 | Return: actual return date, outcome, final cost, receiving inspection. | P0 |
| ST-09 | Reminders for overdue returns (and "due today" on Overview). | P0 |
| ST-10 | Mechanic/vendor master. | P0 |

---

### 7.9 Reports (Phase 4)

Report catalog with filters (**date range, plant, status** + report-specific) and **Export** (Excel/CSV, PDF). Totals row on each report.

| ID | Report | Key columns/filters | Pri |
|---|---|---|---|
| RP-01 | Weighbridge / RST register | date/cycle, vehicle, movement type, status, original ticket ref | P0 |
| RP-02 | Inbound receipt & QC report | party, broker, variety, location, moisture, deductions, bag counts | P0 |
| RP-03 | Outbound loading / dispatch report | customer/order, variety, vehicle, qty, bags/weight, balance | P0 |
| RP-04 | Order fulfillment (PO & SO) | ordered, received/dispatched, pending, fulfillment %, exceptions | P0 |
| RP-05 | Stock position & movements | variety, lot, location; estimate vs confirmed flag | P0 |
| RP-06 | Processing report | by lot & department: soak/dry timings, boiler status, milling input/output/yield, faults, downtime | P0 |
| RP-07 | Repairs report | items with mechanics, status, expected/actual return, turnaround, cost | P0 |
| RP-08 | Store room ledger | balances, receipts/issues, low-stock list | P0 |
| RP-09 | Audit & exceptions | duplicate RSTs, failed integrations, corrections, reversals, approvals | P0 |

Report totals must reconcile with source transactions (acceptance check).

---

### 7.10 Notifications & alerts (Phase 4)

| ID | Requirement | Pri |
|---|---|---|
| NT-01 | Configurable alert rules: equipment fault, abnormal pressure/temperature, stalled/overdue lot stage, trucks waiting > X min, integration failures, transactions awaiting approval, overdue repairs, low store stock. | P0 |
| NT-02 | Route by department/role; recipients configurable. | P0 |
| NT-03 | Alert lifecycle: `Open → Acknowledged → Resolved`, with owner and timestamps. | P0 |
| NT-04 | De-duplication / throttling (no alert flooding); single alert updates "last seen". | P0 |
| NT-05 | Channels: in-app (P0); SMS / WhatsApp / email (P1) **[TBC – D-12]**; escalation if not acknowledged in X min. | P0/P1 |

---

### 7.11 AI review inbox (proposed – from Overview mockup)

The Overview mockup shows an "AI review inbox" with a *WhatsApp slip – RST 0421 → Review draft* and a *Boiler voice note → Draft*. This is **not in the requirements brief**; treat as an optional enhancement.

| ID | Requirement | Pri |
|---|---|---|
| AI-01 | Accept photos of paper slips (e.g., forwarded via WhatsApp) and extract RST, date, party, broker, variety, sacks into a **draft** QC record. | P2 |
| AI-02 | Accept voice notes from operators (e.g., boiler) and transcribe into a **draft** status/fault update. | P2 |
| AI-03 | AI output is always a draft; a human with the right role must review and submit. Source file is kept as an attachment. | P2 |

Decision needed: include in scope or defer (D-16).

---

### 7.12 Cross-cutting: audit, amendments, search, masters, admin

| ID | Requirement | Pri |
|---|---|---|
| AU-01 | Audit log for create / sensitive view / change / approve / post / reverse / cancel: user, timestamp, old → new values, reason. | P0 |
| AU-02 | Posted records: no hard delete; corrections via **amendment** (new version linked to original) or **reversal** (equal-and-opposite movement). | P0 |
| AU-03 | Global search by RST, PID, vehicle, party, broker, order no., lot — permission-filtered. | P0 |
| MD-01 | Masters (admin-configurable): varieties, parties/suppliers, customers, brokers, locations/yards/godowns, units & conversions, tanks, machines/equipment, fault codes, mechanics/vendors, store item categories, plants, RST cycles. | P0 |
| MD-02 | Calculation configuration (moisture deduction, yield %, tolerances, rounding) versioned with effective date — changing a rule never recalculates posted history. | P0 |
| AD-01 | User management: individual accounts, role + department + plant assignment, deactivate, access review export. | P0 |
| AD-02 | Exports and printable summaries for transactions, orders, stock. | P1 |
| AD-03 | Import tools for masters and opening balances. | P0 |

---

## 8. Key workflows

### 8.1 Inbound (purchase) truck
```
Truck arrives → Weighbridge gross weight → RST generated (SMS/capture) → PID created
  → Status: Awaiting QC
  → QC operator enters/scans RST → confirms vehicle → enters party/broker/variety/location/moisture/bags
  → Save draft / Submit → (QC head review) → Posted
       ├─ PO line accepted/rejected/remaining updated
       └─ Stock receipt created (variety × location × lot)
  → Tare weight → net weight final → Completed
```
**[TBC]** Whether QC happens between gross and tare weighing and how net weight is finalized (D-01).

### 8.2 Outbound (sales) truck
```
Truck arrives (tare) → RST → PID → QC loading: add variety lines → link SO lines
  → over-allocation check → Submit → Approve → Posted
       ├─ SO dispatched/remaining updated
       └─ Stock issue created; Dispatch record (DSP) created
  → Gross weight → net weight → Completed / Ready to dispatch
```

### 8.3 Processing lot
```
Receipt(s) → Lot created → Boiler → Soaking (tank) → Drying (dryer) → Milling (line)
  → Estimated output (yield %) → Confirmed output (approval) → Finished goods stock
```

### 8.4 Repair
```
Item issued "Send for repair" → Under repair (not available) → With mechanic → Returned (inspection) → back to stock
                                                               └→ Unrepaired / Scrapped (write-off with approval)
```

---

## 9. Permission matrix (initial)

V = view · E = create/edit · A = approve/post · — = no access · S = scoped (own department/queue)

| Module | Weighbridge op | QC unload | QC load | QC head | Foreman | Store custodian | Commercial | Admin/Mgmt |
|---|---|---|---|---|---|---|---|---|
| Overview | S | S | S | S | S | S | V | V |
| Weighbridge tickets | E (no party/broker) | V (S) | V (S) | V | — | — | V | A |
| WB exceptions | V | — | — | A **[TBC]** | — | — | — | A |
| Inbound QC | — | E (S) | — | A | — | — | V | A |
| Outbound QC | — | — | E (S) | A | — | — | V | A |
| Purchase orders | — | — | — | V | — | — | E | A |
| Sales orders | — | — | — | V | — | — | E | A |
| Processing | — | — | — | V | E (S) | — | V | A |
| Inventory | — | — | — | V (S) | — | — | V **[TBC]** | A |
| Stock adjustments | — | — | — | E (request) | — | — | — | A |
| Stores & Repairs | — | — | — | — | V (request) **[TBC]** | E | — | A |
| Reports | — | — | — | S | S | S | Commercial | All |
| Admin / masters | — | — | — | — | — | — | — | E |

Permissions are enforced **server-side** on every API call, not only by hiding UI.

---

## 10. Data model (logical, high level)

| Entity | Key fields |
|---|---|
| **Plant** | id, name |
| **RstCycle** | id, plant_id, label, start_at, end_at |
| **WeighbridgeTicket** | **pid**, rst, cycle_id, vehicle_no, direction, gross, tare, net, ticket_ref, weighed_at, source_payload, integration_status, duplicate_of_pid |
| **Movement** (truck visit) | pid, ticket_pid, type (inbound/outbound), status, plant_id |
| **QcInbound** | pid, movement_pid, supplier_id, broker_id, location_id, qc_user, status, notes, attachments |
| **QcInboundLine** | id, qc_pid, variety_id, moisture_pct, sacks_received, returned_sacks, rejected_bags, bags_unloaded, accepted_qty, deduction_qty |
| **QcOutbound** / **QcOutboundLine** | pid, movement_pid, location_id, driver_phone; line: variety_id, qty, bags, bag_weight, so_line_id |
| **PurchaseOrder / PoLine** | po_no, supplier_id, broker_id, dates, status; line: variety_id, ordered_qty, rate |
| **SalesOrder / SoLine** | so_no, customer_id, dates, status; line: variety_id, ordered_qty, rate |
| **OrderAllocation** | id, order_line_id, qc_line_id, qty, posted_at |
| **Lot** | lot_no, variety_id, source receipts, parent_lot_ids (split/merge lineage), status |
| **ProcessEvent** | id, lot_id, stage, equipment_id, event (start/pause/resume/stop), reading, remarks, user, at |
| **Fault** | id, department, equipment_id, fault_code, severity, status, reported_by, ack_by, resolved_by |
| **StockMovement** | pid, type, variety_id, location_id, lot_id, qty (±), uom, reference_type, reference_pid, is_estimate, status |
| **StockBalance** (derived) | variety, location, lot → on_hand, reserved, in_process, available |
| **StoreItem / StoreMovement** | item_code, category, unit, reorder_level, bin; movement: type, qty, purpose, recipient, recorded_by |
| **RepairOrder** | ref_no, item_id, qty/serial, fault, mechanic_id, sent_at, expected_return, quote, status, returned_at, outcome, cost |
| **Amendment** | id, target_pid, version, old_values, new_values, reason, requested_by, approved_by |
| **AuditEvent** | id, entity, pid, action, user, at, diff, reason |
| **AlertRule / Alert** | rule; alert: type, source_pid, recipients, status, ack/resolve info |
| **User / Role / Permission** | user, role, department, plant scope |

**ID formats (proposal):** PID = `PID-` + sequence (display) backed by UUID/ULID internally; PO `PO-####`, SO `SO-####`, Lot `LOT-YYMM-####`, Dispatch `DSP-####`, Repair `REP-####`, Adjustment `ADJ-####`. ⚠️ Mockups use both `LOT-2501-0347` and `BCH-25010` for processing batches — pick one (D-15).

---

## 11. Non-functional requirements

| Area | Requirement |
|---|---|
| **Data integrity** | Permanent IDs; foreign-key-validated relationships; transactional (all-or-nothing) posting. |
| **History** | Append-only history for posted data; amendments/reversals only. Same rule across RST resets. |
| **Reliability** | Every inbound weighbridge message stored before parsing; failures go to a recoverable exception queue; no silent drops. Idempotent APIs (retry-safe). |
| **Security** | Individual logins, strong passwords + optional OTP for admin/management; RBAC enforced server-side; HTTPS; encrypted backups; session timeout; no shared credentials. |
| **Usability** | Minimal typing on floor screens: RST quick lookup/scan, dropdowns, large touch targets on tablets; clear status chips and plain-language errors. Hindi/English UI **[TBC – D-14]**. |
| **Devices** | Desktop (office), tablets/mobiles (weighbridge, QC points, plant floor). Responsive web; PWA for unreliable networks. |
| **Offline / poor network** | QC and processing entries can be queued locally and synced with duplicate protection **[TBC – D-13]**. |
| **Performance** | Targets to agree; proposed: page load < 2 s on 4G, RST lookup < 1 s, dashboard refresh ≤ 30 s. |
| **Availability** | Proposed 99.5% during plant operating hours; hosting choice (cloud vs on-prem) **[TBC]**. |
| **Backup & DR** | Proposed daily backups + point-in-time recovery, 30-day retention, tested restore; retention of transactional data ≥ 8 years **[TBC]**. |
| **Time** | Store UTC; display in company time zone (IST). |
| **Auditability** | Audit log tamper-evident and exportable. |

---

## 12. Integrations

| Integration | Approach | Phase | Risk |
|---|---|---|---|
| Weighbridge (SMS via SIM) | GSM modem / SMS gateway / Android SMS-forwarder → ERP webhook → parser. Fallback: manual capture/import. | 4 (fallback in 2) | High until SMS sample and device model are known |
| Equipment sensors (boiler pressure, dryer temp) | IoT gateway pushing readings (MQTT/HTTP) | Feasibility in 4 | Medium–High |
| Notifications | In-app; SMS/WhatsApp Business API/email providers | 4 | Low |
| Accounting (e.g., Tally) | Export of PO receipts / dispatches | Out of scope v1 **[TBC]** | — |
| Barcode/QR on slips | Print QR with PID/RST on ERP slip | 2–4 | Low |

---

## 13. Release plan (aligned to brief §10)

| Phase | Scope | Exit / acceptance |
|---|---|---|
| **1. Discovery & design** | Confirm calculations, QC fields, roles, statuses, weighbridge interface, masters, devices/network, reports; clickable prototypes (based on current mockups). | Signed workflow maps, data dictionary, integration feasibility note, approved prototypes, closed Decision Log items D-01…D-10. |
| **2. Core transactions (MVP)** | PIDs, RST cycles, ticket capture (manual/import), ticket matching, inbound & outbound QC, PO/SO with reconciliation, roles, audit, amendments, masters. | RST reset simulation passes; duplicate ticket test passes; QC and order balances reconcile with manual sample. |
| **3. Processing & inventory** | Lots, boiler/soaking/drying/milling, faults, stock movements & balances, estimates vs confirmed, adjustments, Stores & Repairs, Overview dashboard. | End-to-end lot traceability demo; stock follows posting rules; overdue repair reminder works. |
| **4. Integrations, reports & alerts** | SMS automation, sensor evaluation, all reports + export, notification rules & channels. | Integration exceptions visible and recoverable; report totals reconcile. |
| **5. Pilot & staged rollout** | Training, opening balances, parallel run with paper, issue fixing, sign-off. | Named users complete agreed scenarios; open issues logged with owner/date. |
| **6. Stabilization & enhancements** | Fixes + change requests (incl. AI inbox if approved). | Prioritized backlog, regression sign-off per release. |

---

## 14. Acceptance test scenarios (mandatory)

| # | Scenario | Expected result |
|---|---|---|
| T-01 | Two different vehicles use the same RST in two reset cycles | Two PIDs; both searchable; neither changed |
| T-02 | Same SMS/ticket received twice | Flagged Duplicate; no double posting |
| T-03 | RST matches more than one plausible record | User must choose; no auto-pick |
| T-04 | Multi-variety outbound load against one SO with two lines | Each SO line reduced correctly per classic calculation |
| T-05 | Multi-variety inbound truck (if confirmed) | Each variety receipt posted to the right PO line and lot |
| T-06 | Posted receipt corrected | Original visible; amendment shows old/new, user, time, reason, approver |
| T-07 | Over-allocation on SO | Blocked or routed for approval per rule |
| T-08 | Sensor data stale / network drop | Dashboard shows "last received at"; operator manual entry works; no duplicates on resync |
| T-09 | Estimated milling output vs confirmed stock | Estimate never changes physical balance until confirmation is approved |
| T-10 | QC operator tries to open Inventory or a PO via direct URL/API | Access denied (server-side) and logged |
| T-11 | Weighbridge operator views ticket | No party/broker field visible or editable |
| T-12 | Repair item past expected return | Marked Overdue; reminder sent; excluded from available stock |
| T-13 | Posting fails midway (e.g., DB error) | No partial update to order or stock |
| T-14 | Change of moisture deduction rule | New rule applies only from effective date; posted history unchanged |

---

## 15. Decision log (open items – to confirm in discovery)

| ID | Topic | Question / information needed | Owner |
|---|---|---|---|
| D-01 | Weighbridge | Make/model, SMS sample & sender format, SIM/phone access, fields, frequency, failure handling; order of gross/tare vs QC | Client + Dev |
| D-02 | RST cycle | How resets are recognized; cycle label available?; late-arriving messages; duplicate RST within a cycle | Client |
| D-03 | Purchase calculation | Step-by-step method with examples: deductions, moisture formula, units, tolerance, rounding, returns/rejections, multi-variety | Client |
| D-04 | Sales "classic" calculation | Steps with examples: rounding, bag weight, partial/over/under-delivery, tolerance | Client |
| D-05 | QC fields | Required vs optional (inbound/outbound); sack vs bag definitions; reasons list | Client |
| D-06 | Statuses | Final status list for tickets, QC, orders, lots | Client + Dev |
| D-07 | Multi-variety inbound | Can one inbound truck carry multiple varieties (mockup shows yes)? | Client |
| D-08 | Posting point | When orders/stock post; approval checkpoints; cancellation & reversal policy | Client |
| D-09 | Lots | Creation, split, mix/merge, relabel, rework rules; lot ↔ receipt mapping | Client |
| D-10 | Access | Named role owners; department-level stock visibility; approval limits; is there a separate stock controller role? | Client |
| D-11 | Processing | Tanks/machines list, planned durations, yield % per variety, fault codes, sensors available | Client |
| D-12 | Alerts & devices | Recipients, channels (SMS/WhatsApp/email), escalation timing; sites' network coverage; device list | Client |
| D-13 | Offline | Which stations need offline entry | Client |
| D-14 | Rollout | Must-have report formats, language (English/Hindi), units, opening balances, historical data migration, training, pilot site | Client |
| D-15 | Naming | Lot vs batch ID format (mockups show both `LOT-2501-0347` and `BCH-25010`) | Dev |
| D-16 | AI review inbox | Include WhatsApp-slip/voice-note drafting in scope or defer? | Client |
| D-17 | Gate entry | "New gate entry" appears in mockup – is there a gate register separate from the weighbridge? | Client |
| D-18 | Multi-plant | Plant selector in mockups – how many plants/sites? | Client |
| D-19 | Hosting & retention | Cloud vs on-prem, backup frequency, retention period, DR | Client + Dev |
| D-20 | Accounting | Any export/integration to accounting software needed in v1? | Client |

---

## 16. Assumptions, risks and dependencies

**Assumptions**
- The business processes paddy into rice (parboiling line: boiler → soaking → drying → milling).
- Internet is available at the office; floor connectivity may be patchy (hence PWA/offline consideration).
- One plant at go-live; data model supports more.

**Risks**

| Risk | Mitigation |
|---|---|
| Weighbridge SMS format is unreliable or undocumented | Ship manual capture/import first (Phase 2); automate in Phase 4 after collecting samples |
| Calculation rules are undocumented / tribal knowledge | Collect worked examples with real slips in Phase 1; make rules configurable and versioned |
| Floor staff resist tablets / typing | Scan-based RST lookup, minimal fields, photo of slip, (optional) AI draft from slip photo |
| Sensors not available or too costly | Manual readings with freshness labels; sensors as separate optional work item |
| Requirements emerging during testing | Change log with impact/effort/approval (brief §12) |

**Dependencies:** client availability for workshops; access to weighbridge SIM/SMS; master data lists (varieties, parties, brokers, locations, equipment); opening balances.

---

## 17. Mockup review notes (for design iteration)

The mockups are a good base and match the brief's module list. Items to fix before they become the build spec:

1. **Demo data is inconsistent with the business.** PO screen shows turmeric (Salem/Erode/Rajapuri), SO screen shows mango (Alphonso/Kesar), Reports show sugar; QC/Inventory show rice varieties (PB 1121, PB 1509, IR 64, Basmati, Sharbati). Use paddy/rice varieties throughout for client demos.
2. **Weighbridge ticket shows "Supplier"** — conflicts with the rule that the weighbridge operator does not handle party/broker (WB-12).
3. **Same RST, different data:** RST 0421 shows supplier "Sri Ashok Minerals" on Weighbridge and "Green Leaf Traders" in QC; RST 0417–0420 show different vehicles on Overview vs Weighbridge. Align demo data so the RST chain story holds.
4. **RST cycle not visible.** Add a cycle column/badge in the Ticket Register and RST search results.
5. **Lot vs Batch naming** (Processing `LOT-…` vs Overview `BCH-…`) — standardize.
6. **Units:** QC works in sacks; PO/SO/Inventory in kg. Show conversion (sacks × bag weight → kg) on QC screen.
7. **Missing screens:** Admin/Settings (users, roles, masters, RST cycles, alert rules, calculation config), Exceptions queue, Amendment/approval screen, Notifications panel, Outbound QC tab, Lot traceability view.
8. **Data freshness** on Processing/Overview should be explicit (e.g., "Sensor · 2 min ago" vs "Manual · 10:24").
9. **Status vocabulary** differs across screens (Captured / Pending QC / QC Hold / QC in progress / Posted / Processed / Completed) — consolidate after D-06.

---

## 18. Appendix – screen inventory

| # | Screen | Mockup | Phase |
|---|---|---|---|
| S01 | Operations overview | ✅ | 3 |
| S02 | Weighbridge – ticket register + detail drawer | ✅ | 2 |
| S03 | Weighbridge – capture ticket form | — | 2 |
| S04 | Weighbridge – exceptions queue | partial (tab) | 2 |
| S05 | QC – Inbound workbench | ✅ | 2 |
| S06 | QC – Outbound loading (multi-variety) | tab only | 2 |
| S07 | QC – review/approval queue | — | 2 |
| S08 | Purchase orders – list + detail | ✅ | 2 |
| S09 | Purchase order – create/edit | — | 2 |
| S10 | Sales orders – list + detail | ✅ | 2 |
| S11 | Sales order – create/edit | — | 2 |
| S12 | Processing – plant floor + lot details | ✅ | 3 |
| S13 | Processing – report fault / update status (mobile) | — | 3 |
| S14 | Inventory – stock, estimates, movements | ✅ | 3 |
| S15 | Inventory – adjustment request/approval | — | 3 |
| S16 | Stores & Repairs – item register, movements, under repair | ✅ | 3 |
| S17 | Stores – record movement / send for repair forms | — | 3 |
| S18 | Reports – catalog + preview + export | ✅ | 4 |
| S19 | Notifications centre | — | 4 |
| S20 | Admin – users, roles, masters, RST cycles, calc config, alert rules | — | 2 |
| S21 | Audit trail / amendment history viewer | — | 2 |
| S22 | AI review inbox (optional) | partial (widget) | 6 [TBC] |
