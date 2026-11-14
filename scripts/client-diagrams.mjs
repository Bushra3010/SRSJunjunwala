// Draws the two client-facing diagrams in docs/client/ (SVG + PNG).
// Usage: node scripts/client-diagrams.mjs
import { writeFileSync } from "node:fs";
import sharp from "sharp";

const OUT = new URL("../docs/client/", import.meta.url).pathname;
const F = "Helvetica Neue, Helvetica, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const C = { ink: "#1b2a1f", muted: "#5f6b62", line: "#e3dccb", green: "#1f6b32", gold: "#c08a24", bg: "#fbf8f0" };

const text = (x, y, s, { size = 16, weight = 400, color = C.ink, anchor = "start", family = F } = {}) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(s)}</text>`;
const box = (x, y, w, h, { fill = "#fff", stroke = C.line, r = 12, sw = 1.5 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
const chip = (x, y, w, label, sub, color) =>
  box(x, y, w, sub ? 52 : 40, { fill: color + "14", stroke: color + "88", r: 8 }) +
  text(x + w / 2, y + (sub ? 22 : 26), label, { size: 15, weight: 700, color, anchor: "middle" }) +
  (sub ? text(x + w / 2, y + 41, sub, { size: 12, color, anchor: "middle" }) : "");
const arrow = (x, y1, y2) =>
  `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2 - 8}" stroke="#a89f86" stroke-width="2"/><path d="M${x - 6} ${y2 - 10} L${x} ${y2} L${x + 6} ${y2 - 10} Z" fill="#a89f86"/>`;

// ---------- Image 1: the process ----------
const W = 1400, LX = 40, LW = 760, RX = 830, RW = 530;
const stages = [
  { name: "Unloading bay (Houdi)", sub: "Weighbridge + unloading QC", color: "#4b5563", id: "RCV-2026-00001",
    rec: ["RST, vehicle, supplier, broker, variety", "Gross / tare / net weight, moisture", "Accepted quantity, QC person"],
    rule: "Permanent ID — RST resets, this never does" },
  { name: "Soaking (Kachi) — 6 tanks", sub: "Truck goes straight into a tank · 12 hrs", color: "#1f7f86", id: "SOAK-2026-… (one per tank)",
    rec: ["Tank, truck, quantity, start / stop time", "Weight = variety's standard weight per tank"],
    rule: "One truck can be split across tanks", body: "tanks" },
  { name: "Steaming (Pakki) — lots", sub: "Common tank · tanks steamed one after another", color: "#b5532f", id: "LOT-2026-… (one per lot)",
    rec: ["Which tanks form the lot", "Dryer it goes into, start / end, operator"],
    rule: "Any finished tanks · any free dryer", body: "lot" },
  { name: "Drying — 3 dryers", sub: "12–14 hrs · 270–340 q per dryer", color: "#c08a24", id: "DRY-2026-…",
    rec: ["Dryer, input, output, moisture %", "Drying loss, start / end, operator"],
    rule: "Steaming done loads the dryer in one step", body: "dryers" },
  { name: "Mill feed — 3 tanks", sub: "Dried paddy waits for the mill", color: "#7b4f8e", id: "MFD-2026-… (per transfer)",
    rec: ["Source dryer batch, quantity, tank", "Transfer time, operator"], rule: "A dryer batch may be split; links are kept", body: "feed" },
  { name: "Milling", sub: "4–6 hrs per dryer batch", color: "#3e6fc0", id: "MIL-2026-…",
    rec: ["Start / end of each of 6 machines", "Paddy in, rice out, loss, downtime"],
    rule: "Combining feed lots needs manager approval", body: "mill" },
  { name: "Final output by grade", sub: "Reference recovery from hybrid paddy", color: "#1f6b32", id: "OUT-2026-… (one per grade)",
    rec: ["Actual quantity per grade", "Quality check, approval, store receipt"],
    rule: "Reference % shown for comparison only", body: "grades" },
];
const bodyH = { tanks: 140, lot: 70, dryers: 60, feed: 60, mill: 64, grades: 74 };
let y = 190, svg = "";
stages.forEach((s, idx) => {
  const h = Math.max(92 + (s.body ? bodyH[s.body] : 0), 118 + (s.rec.length - 1) * 24);
  svg += box(LX, y, LW, h, { stroke: s.color + "66", r: 14, sw: 2 }) + `<rect x="${LX}" y="${y}" width="8" height="${h}" rx="4" fill="${s.color}"/>`;
  svg += `<circle cx="${LX + 50}" cy="${y + 44}" r="20" fill="${s.color}"/>` + text(LX + 50, y + 50, idx + 1, { size: 18, weight: 700, color: "#fff", anchor: "middle" });
  svg += text(LX + 84, y + 40, s.name, { size: 22, weight: 700 }) + text(LX + 84, y + 64, s.sub, { size: 15, color: C.muted });
  const by = y + 88, bx = LX + 84, bw = LW - 110, third = (bw - 20) / 3;
  if (s.body === "tanks") for (let i = 0; i < 6; i++) svg += chip(bx + (i % 3) * (third + 10), by + Math.floor(i / 3) * 62, third, `Tank ${i + 1}`, "std. weight", s.color);
  if (s.body === "lot") ["Tank 1 + Tank 2", "Tank 5 alone", "Any finished tanks"].forEach((p, i) => (svg += chip(bx + i * (third + 10), by, third, p, null, s.color)));
  if (s.body === "dryers") [1, 2, 3].forEach((d, i) => (svg += chip(bx + i * (third + 10), by, third, `Dryer ${d}`, null, s.color)));
  if (s.body === "feed") [1, 2, 3].forEach((d, i) => (svg += chip(bx + i * (third + 10), by, third, `Feed tank ${d}`, null, s.color)));
  if (s.body === "mill") {
    const cw = (bw - 5 * 8) / 6;
    ["Cleaning", "Dehusking", "Whitener", "Silky", "Sortex", "Grading"].forEach((p, i) => (svg += chip(bx + i * (cw + 8), by, cw, p, null, s.color)));
  }
  if (s.body === "grades") {
    const g = [["1st Wand", 30], ["2nd Wand", 10], ["Tibaar", 8], ["Dubaar", 2], ["Broken", 10], ["Rejection", 4], ["Resort", 1]];
    const cw = (bw - 6 * 6) / 7;
    g.forEach(([n, p], i) => (svg += chip(bx + i * (cw + 6), by, cw, n, `${p}%`, i < 2 ? s.color : "#6b6a4f")));
  }
  svg += box(RX, y, RW, h, { fill: C.bg, r: 14 }) + box(RX + 18, y + 16, 300, 30, { fill: s.color, stroke: s.color, r: 6 });
  svg += text(RX + 30, y + 37, s.id, { size: 15, weight: 700, color: "#fff", family: "Menlo, monospace" });
  s.rec.forEach((r, i) => (svg += text(RX + 22, y + 72 + i * 24, "• " + r, { size: 15 })));
  svg += text(RX + 22, y + h - 22, "✓ " + s.rule, { size: 15, weight: 700, color: s.color });
  if (idx < stages.length - 1) svg += arrow(LX + LW / 2, y + h + 2, y + h + 34);
  y += h + 36;
});
const H = y + 120;
const svg1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#ffffff"/>${
  text(W / 2, 64, "Paddy-to-rice production in the ERP", { size: 36, weight: 700, anchor: "middle" }) +
  text(W / 2, 100, "Every stage gets a permanent ID linked to the stage before it — so any rice bag traces back to its truck.", { size: 18, color: C.muted, anchor: "middle" }) +
  text(LX + 10, 165, "FACTORY PROCESS", { size: 14, weight: 700, color: C.gold }) + text(RX + 10, 165, "WHAT THE ERP RECORDS", { size: 14, weight: 700, color: C.gold })
}${svg}${
  box(LX, y - 6, W - 80, 86, { fill: C.green, stroke: C.green, r: 14 }) +
  text(W / 2, y + 28, "Trace in both directions:  OUT → MIL → MFD → DRY → LOT → SOAK → RCV (truck, RST, vehicle, supplier)", { size: 18, weight: 700, color: "#fff", anchor: "middle" }) +
  text(W / 2, y + 56, "and from any truck forward to every rice grade it produced — with every time, quantity and person on record.", { size: 16, color: "#f5d58a", anchor: "middle" })
}</svg>`;

// ---------- Image 2: trace example ----------
const chain = [
  ["RCV-2026-00001", "Truck", "RST 201 · PB 10 GH 2020 · Green Leaf Traders · PB 1121", "160 q received", "#4b5563"],
  ["SOAK ×2", "Soaking", "Tank 1 (80 q) + Tank 2 (80 q) · standard weight · 12 h each", "160 q", "#1f7f86"],
  ["LOT-2026-00001", "Steaming lot", "Tank 1 then Tank 2, continuously · into Dryer 1", "160 q", "#b5532f"],
  ["DRY-2026-00001", "Drying", "Dryer 1 · 13 h · 13.5% moisture", "140 q out", "#c08a24"],
  ["MFD ×2", "Mill feed", "Feed tank 1 (90 q) + Feed tank 2 (50 q)", "140 q", "#7b4f8e"],
  ["MIL-2026-00001", "Milling", "6 machines timed · 140 q paddy in", "95 q rice out", "#3e6fc0"],
  ["OUT-2026-00001", "1st Wand", "Quality passed · confirmed into store", "42 q", "#1f6b32"],
];
const W2 = 1200, rowH = 92;
let s2 = text(W2 / 2, 60, "Tracing one bag of rice back to its truck", { size: 32, weight: 700, anchor: "middle" }) +
  text(W2 / 2, 94, "Search any ID, RST or vehicle number — the ERP shows the whole chain, both ways.", { size: 17, color: C.muted, anchor: "middle" });
let yy = 130;
chain.forEach(([id, stage, detail, qty, color], i) => {
  s2 += box(60, yy, W2 - 120, rowH - 20, { stroke: color + "77", r: 12, sw: 2 }) + `<rect x="60" y="${yy}" width="8" height="${rowH - 20}" rx="4" fill="${color}"/>`;
  s2 += box(86, yy + 20, 210, 32, { fill: color, stroke: color, r: 6 }) + text(191, yy + 42, id, { size: 15, weight: 700, color: "#fff", anchor: "middle", family: "Menlo, monospace" });
  s2 += text(318, yy + 32, stage, { size: 19, weight: 700 }) + text(318, yy + 56, detail, { size: 15, color: C.muted });
  s2 += text(W2 - 84, yy + 44, qty, { size: 19, weight: 700, color, anchor: "end" });
  if (i < chain.length - 1) s2 += arrow(W2 / 2, yy + rowH - 20, yy + rowH);
  yy += rowH;
});
s2 += box(60, yy + 6, W2 - 120, 70, { fill: C.bg, r: 12 }) +
  text(W2 / 2, yy + 36, "Plus a timeline of every start, stop and transfer — with time, quantity and the person who did it.", { size: 16, weight: 700, color: C.green, anchor: "middle" }) +
  text(W2 / 2, yy + 60, "Illustrative figures.", { size: 13, color: C.muted, anchor: "middle" });
const H2 = yy + 110;
const svg2 = `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}"><rect width="100%" height="100%" fill="#ffffff"/>${s2}</svg>`;

writeFileSync(OUT + "production-process-flow.svg", svg1);
writeFileSync(OUT + "traceability-example.svg", svg2);
await sharp(Buffer.from(svg1), { density: 144 }).png().toFile(OUT + "production-process-flow.png");
await sharp(Buffer.from(svg2), { density: 144 }).png().toFile(OUT + "traceability-example.png");
console.log("diagrams written to", OUT);
