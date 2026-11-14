# How the ERP tracks production: from truck to rice

**Shree Rani Sati Overseas Pvt. Ltd. — Production & Traceability module**

## In one sentence

Every load of paddy that enters the factory gets a permanent ID, and every step it goes through (cleaning, soaking, steaming, drying, milling, grading) gets its own ID linked to the step before. From any bag of finished rice you can trace back to the exact truck it came from, and from any truck forward to every bag of rice it produced.

## Why this matters

- **Know the source of every bag.** If a customer raises a quality issue, you can see which truck, supplier, tanks, dryer and milling run it came from within seconds.
- **No guesswork on quantities.** Every stage records what went in, what came out, and what was lost, so losses are visible stage by stage.
- **Mistakes are blocked, not just reported.** The system will not let someone steam a tank that hasn't finished soaking, load a dryer that is still full, or use the same material twice.
- **Nothing disappears.** Records can't be deleted. Corrections and cancellations need a reason and keep the original values for audit.

## The process, step by step

### 1. Truck arrives — Unloading bay (Houdi)
The truck is weighed on the weighbridge (gross weight, then tare after unloading). Quality control checks the paddy: moisture, sacks, rejected bags. Once QC is posted, the truck is ready to go into a soaking tank.

- **Recorded:** RST number, vehicle number, supplier, broker, variety, gross / tare / net weight, moisture, accepted quantity, who did QC.
- **Why a separate ID:** RST numbers restart every few months. When the truck goes into a tank it gets a **Receipt ID** such as `RCV-2026-00001`, which never repeats, so old and new trucks with the same RST can never be confused.

### 2. Soaking (Kachi) — 6 tanks
The unloaded paddy goes straight into a soaking tank for about **12 hours**. One truck can be split across two or more tanks; each tank gets its own **Soaking ID** (`SOAK-2026-…`) and keeps its own history.

- **Recorded:** tank, which truck, quantity, soaking start and stop time, operator.
- **Weight:** tanks can't be weighed, so each paddy variety has a **standard weight per tank**. The system uses it automatically.

### 3. Steaming (Pakki) — lots
Finished tanks are steamed in the common steaming tank as a **lot** with its own **Lot number** (`LOT-2026-…`). A lot is usually a pair of tanks (Tank 1 then Tank 2, steamed continuously), but any finished tanks can make a lot, for example when one tank is under repair. One lot steams at a time.

- **Recorded:** which tanks are in the lot, the dryer it goes into, start and end time, operator.

### 4. Drying — 3 dryers
Steaming passes straight into a dryer for about **12–14 hours** (270–340 quintals). **Any lot can go into any free dryer**; the operator picks it when the lot starts steaming. When steaming is done, one click loads the dryer. **Batch ID:** `DRY-2026-…`

- **Recorded:** dryer, input, output after drying, moisture %, drying loss, times, operator.
- **Rule:** a dryer that is still full can't be given another lot.

### 5. Mill feed — 3 tanks
Dried paddy is moved into the three mill feed tanks. One dryer batch can be split over several transfers; each transfer gets a **Mill Feed ID** (`MFD-2026-…`) and keeps its link back to the dryer.

### 6. Milling — 4–6 hours
Cleaning → Dehusking → Whitener → Silky → Sortex → Grading. **Batch ID:** `MIL-2026-…`

- **Recorded:** start and end time of each of the six machines, input paddy, rice output, processing loss, downtime and faults.
- **Rule:** milling material from more than one feed lot together needs the production manager's approval.

### 7. Final output — rice by grade
Every grade produced from a milling run is recorded separately with its own **Output ID** (`OUT-2026-…`):

| Grade | Reference recovery (hybrid paddy) |
|---|---|
| 1st Wand | 30% |
| 2nd Wand | 10% |
| Tibaar | 8% |
| Dubaar | 2% |
| Broken | 10% |
| Rejection | 4% |
| Resort | 1% |

These percentages are **for comparison only**. The system always records the actual quantity produced and shows actual vs reference side by side. Each output can be quality-checked, approved, and then **physically confirmed into the finished-goods store**, which adds it to inventory.

## Tracing a bag of rice — example

Search `OUT-2026-00001` (1st Wand) and the system shows:

> **Truck** RCV-2026-00001 · RST 201 · Vehicle PB 10 GH 2020 · Green Leaf Traders · PB 1121 · 160 q received
> → **Soaking** Tank 1 (80 q) and Tank 2 (80 q), 12 h each
> → **Steaming lot** LOT-2026-00001 · Tank 1 then Tank 2 · into Dryer 1
> → **Drying** Dryer 1 · 13 h · 13.5% moisture · 140 q out
> → **Mill feed** two transfers (90 q + 50 q)
> → **Milling** MIL-2026-00001 · 140 q in · 95 q rice out
> → **Output** 1st Wand 42 q

…plus a full timeline of every start, stop and transfer, with the time and the person who did it. Searching the truck (by Receipt ID, RST or vehicle number) shows the same chain forwards, ending in every rice grade it produced.

*(Figures above are illustrative.)*

## How quantities are trusted

Each quantity carries a label so everyone knows how reliable it is:

| Label | Meaning |
|---|---|
| **Estimated** | Not weighed; taken from the standard weight or carried forward from the previous stage |
| **Operator entered** | Weighed and entered by the operator |
| **Approved** | Checked and approved by the production manager |
| **Physically confirmed** | Counted into the store; now part of inventory |

## Who does what

| Role | Responsibility |
|---|---|
| QC head | Checks and posts the unloading QC |
| Soaking operator | Loading trucks into the six soaking tanks |
| Steaming operator | Steaming lots and loading them into a dryer |
| Drying operator | The three dryers and mill feed transfers |
| Milling operator | Milling steps and recording rice output |
| Production manager | Approvals, corrections, cancellations, stock confirmation |
| Management | Read-only view of everything, trace and reports |

Each person only sees the buttons for their own job, and the database enforces the same rules even if someone tries to bypass the screen.

## What management gets

- **Live plant floor:** all tanks, the steamer, dryers and the mill line, showing what is running, for how long, and what is overdue.
- **Alerts:** overdue batches, open machine faults, quantities still waiting for approval.
- **Ten reports, downloadable to Excel:**
  - **Production by day:** daily production.
  - **By equipment:** tank-wise soaking, steaming lots, dryer-wise drying, milling in/out.
  - **Results and losses:** grade-wise output vs reference, losses stage by stage.
  - **People and tracing:** operator activity, batch genealogy, truck-to-rice traceability.
