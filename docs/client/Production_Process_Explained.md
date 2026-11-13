# How the ERP tracks production: from truck to rice

**Shree Rani Sati Overseas Pvt. Ltd. — Production & Traceability module**

## In one sentence

Every load of paddy that enters the factory gets a permanent ID, and every step it goes through (cleaning, soaking, steaming, drying, milling, grading) gets its own ID linked to the step before. From any bag of finished rice you can trace back to the exact truck it came from, and from any truck forward to every bag of rice it produced.

## Why this matters

- **Know the source of every bag.** If a customer raises a quality issue, you can see which truck, supplier, tanks, dryer and milling run it came from within seconds.
- **No guesswork on quantities.** Every stage records what went in, what came out, and what was lost, so losses are visible stage by stage.
- **Mistakes are blocked, not just reported.** The system will not let someone steam the wrong tank pair, load the wrong dryer, or use the same material twice.
- **Nothing disappears.** Records can't be deleted. Corrections and cancellations need a reason and keep the original values for audit.

## The process, step by step

### 1. Truck arrives — Unloading bay (Houdi)
The truck is weighed on the weighbridge (gross weight, then tare after unloading). Quality control checks the paddy: moisture, sacks, rejected bags. Once QC is posted, the truck enters production with a **Receipt ID** such as `RCV-2026-00001`.

- **Recorded:** RST number, vehicle number, supplier, broker, variety, gross / tare / net weight, moisture, accepted quantity, who did QC.
- **Why a separate ID:** RST numbers restart every few months. The Receipt ID never repeats, so old and new trucks with the same RST can never be confused.

### 2. Pre-cleaning
The paddy is cleaned of dust, stones and straw. **Batch ID:** `PC-2026-…`

- **Recorded:** quantity in, cleaned quantity out, cleaning loss, start and end time, operator.

### 3. Soaking (Kachi) — 6 tanks
Cleaned paddy is soaked in one of six tanks for about **12 hours** (150–180 quintals per tank). One truck can be split across two or more tanks; each tank gets its own **Soaking ID** (`SOAK-2026-…`) and keeps its own history.

- **Recorded:** tank number, how much came from which truck, start and end time, operator.
- **Note:** soaked paddy absorbs water. If it is not weighed, the system marks the quantity as an *estimate* rather than pretending it is exact.

### 4. Steaming (Pakki) — 1 common steaming tank
Tanks are steamed in **fixed pairs**: Tank 1 + 2, Tank 3 + 4, Tank 5 + 6. There is only one steaming tank, so **only one pair at a time**. **Batch ID:** `STM-2026-…`

- **Rules the system enforces:**
  - A pair can only be steamed when **both** its tanks have finished soaking.
  - Tanks from different pairs can never be mixed.
  - A second pair cannot start while the steamer is in use.

### 5. Drying — 3 dryers
Each steamed pair goes to its own dryer for about **12–14 hours** (270–340 quintals):
**Pair 1+2 → Dryer 1 · Pair 3+4 → Dryer 2 · Pair 5+6 → Dryer 3.** **Batch ID:** `DRY-2026-…`

- **Recorded:** dryer, input, output after drying, moisture %, drying loss, times, operator.
- **Rule:** sending a pair to the wrong dryer is blocked.

### 6. Mill feed tanks
Dried paddy is moved into the mill feed tanks. One dryer batch can be split over several transfers; each transfer gets a **Mill Feed ID** (`MFD-2026-…`) and keeps its link back to the dryer.

### 7. Milling — 4–6 hours
Cleaning → Dehusking → Whitener → Silky → Sortex → Grading. **Batch ID:** `MIL-2026-…`

- **Recorded:** start and end time of each of the six machines, input paddy, rice output, processing loss, downtime and faults.
- **Rule:** milling material from more than one feed lot together needs the production manager's approval.

### 8. Final output — rice by grade
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
> → **Pre-cleaning** PC-2026-00001 · 159 q cleaned
> → **Soaking** Tank 1 (79.5 q) and Tank 2 (79.5 q), 12 h each
> → **Steaming** STM-2026-00001 · pair 1+2 · 160.5 q
> → **Drying** Dryer 1 · 13 h · 13.5% moisture · 140 q out
> → **Mill feed** two transfers (90 q + 50 q)
> → **Milling** MIL-2026-00001 · 140 q in · 95 q rice out
> → **Output** 1st Wand 42 q

…plus a full timeline of every start, stop and transfer, with the time and the person who did it. Searching the truck (by Receipt ID, RST or vehicle number) shows the same chain forwards, ending in every rice grade it produced.

*(Figures above are an illustration of how the screen reads, taken from the system's test run.)*

## How quantities are trusted

Each quantity carries a label so everyone knows how reliable it is:

| Label | Meaning |
|---|---|
| **Estimated** | Not weighed; carried forward from the previous stage |
| **Operator entered** | Weighed and entered by the operator |
| **Approved** | Checked and approved by the production manager |
| **Physically confirmed** | Counted into the store; now part of inventory |

## Who does what

| Role | Responsibility |
|---|---|
| QC head | Sends posted trucks into production |
| Soaking operator | Pre-cleaning and the six soaking tanks |
| Steaming operator | The common steaming tank |
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
  - **By equipment:** tank-wise soaking, pair-wise steaming, dryer-wise drying, milling in/out.
  - **Results and losses:** grade-wise output vs reference, losses stage by stage.
  - **People and tracing:** operator activity, batch genealogy, truck-to-rice traceability.
