#!/usr/bin/env node
/**
 * Turns a calibration CSV exported from the in-app Calibration panel into
 * concrete threshold recommendations.
 *
 *   node scripts/analyze-calibration.js path/to/data.csv
 *
 * Record one session per person (~60s each, all three poses), with `truth` set
 * to whoever is actually in front of the camera. Include at least one person who
 * is NOT the enrolled subject — ideally the lookalike you are worried about,
 * since the margin threshold is calibrated entirely off impostor near-misses.
 *
 * Re-run this after ANY change to the embedding model, the alignment template,
 * or enrollment. Thresholds do not survive those changes: they live in cosine
 * space, and each model puts genuine and impostor scores on its own scale.
 */

const fs = require("fs");

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/analyze-calibration.js <data.csv>");
  process.exit(1);
}

const rows = [];
const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
const header = lines[0].split(",");
const idx = (name) => header.indexOf(name);
const [tI, truthI, poseI, yawI, candI, simI, genI, rankI, marI] = [
  "t", "truth", "pose", "yaw", "candidateName", "similarity", "genuine", "rank", "margin",
].map(idx);

for (const line of lines.slice(1)) {
  const c = line.split(",");
  if (c.length < header.length) continue;
  rows.push({
    t: Number(c[tI]),
    truth: c[truthI],
    pose: c[poseI],
    yaw: Number(c[yawI]),
    candidate: c[candI],
    similarity: Number(c[simI]),
    genuine: c[genI] === "1",
    rank: Number(c[rankI]),
    margin: Number(c[marI]),
  });
}

// The pipeline re-emits the same embedding across several frames while a face is
// held. Collapsing on (t, candidate) keeps one row per distinct comparison so a
// long steady pose does not outvote a brief hard one.
const seen = new Set();
const uniq = rows.filter((r) => {
  const k = `${r.t}|${r.candidate}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const pct = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : "  -  ");

const genuine = uniq.filter((r) => r.genuine).map((r) => r.similarity);
const impostor = uniq.filter((r) => !r.genuine).map((r) => r.similarity);

console.log(`\nrows ${rows.length} -> ${uniq.length} distinct comparisons`);
console.log(`genuine  n=${genuine.length}  min ${f(Math.min(...genuine))}  p05 ${f(pct(genuine, 5))}  med ${f(pct(genuine, 50))}  max ${f(Math.max(...genuine))}`);
console.log(`impostor n=${impostor.length}  min ${f(Math.min(...impostor))}  med ${f(pct(impostor, 50))}  p95 ${f(pct(impostor, 95))}  max ${f(Math.max(...impostor))}`);

const sep = pct(genuine, 5) - pct(impostor, 95);
console.log(`\nseparation (genuine p05 - impostor p95): ${f(sep)}`);
if (sep <= 0) {
  console.log("  NEGATIVE -> the distributions overlap. No absolute floor can");
  console.log("  separate these people; the margin test is what protects you.");
}

// Frames where an impostor outranked or nearly outranked the true person are the
// only ones that matter for the margin threshold.
const nearMiss = uniq
  .filter((r) => !r.genuine && r.rank === 0)
  .sort((a, b) => a.margin - b.margin);
console.log(`\nframes where a WRONG person ranked #1: ${nearMiss.length}`);
for (const r of nearMiss.slice(0, 5)) {
  console.log(`  t=${r.t} truth=${r.truth} won=${r.candidate} sim=${f(r.similarity)} margin=${f(r.margin)} yaw=${r.yaw}`);
}

const worstImpostorMargin = Math.min(
  ...uniq.filter((r) => !r.genuine).map((r) => r.margin).filter(Number.isFinite)
);

console.log("\n--- recommended MATCH_TUNING ---");
const floor = pct(genuine, 5);
console.log(`acceptSimilarity   ~ ${f(floor - 0.02)}   (just under genuine p05 ${f(floor)})`);
console.log(`marginOverRunnerUp ~ ${f(worstImpostorMargin + 0.02)}   (above worst impostor margin ${f(worstImpostorMargin)})`);

for (const accept of [floor - 0.05, floor - 0.02, floor + 0.02]) {
  for (const margin of [worstImpostorMargin + 0.01, worstImpostorMargin + 0.03]) {
    let ok = 0, bad = 0, rej = 0;
    const byFrame = new Map();
    for (const r of uniq) {
      if (!byFrame.has(r.t)) byFrame.set(r.t, []);
      byFrame.get(r.t).push(r);
    }
    for (const [, cands] of byFrame) {
      const sorted = [...cands].sort((a, b) => b.similarity - a.similarity);
      const top = sorted[0];
      const gap = sorted.length > 1 ? top.similarity - sorted[1].similarity : 1;
      if (top.similarity < accept || gap < margin) rej++;
      else if (top.genuine) ok++;
      else bad++;
    }
    console.log(`accept ${f(accept)} margin ${f(margin)} -> accepted ${ok}  FALSE ACCEPTS ${bad}  rejected ${rej}`);
  }
}
console.log();
