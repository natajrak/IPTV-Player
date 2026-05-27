#!/usr/bin/env node
/**
 * patch-updated-at-movies.js
 * Patch `updated_at` ของ movies / anime movies — ต่างจาก series ตรงที่ไม่สนใจ status
 *
 * Movie structure:
 *   - Part file ({tmdbId}-{slug}.txt): มี stations[] ที่ root (ไม่มี groups)
 *   - Main file ({slug}.txt): มี groups[] ที่ root, groups[].url ชี้ไปยัง part file
 *
 * Logic:
 *   Phase A — Part files (มี stations[]):
 *     updated_at = ISO midnight UTC ของ release_date
 *
 *   Phase B — Main files (มี groups[] แต่ไม่มี stations[]):
 *     ดู groups[].url → resolve filename → อ่าน release_date จาก part files (หลัง Phase A)
 *     release_date = max(...part release_dates)
 *     updated_at  = ISO midnight UTC ของ release_date นั้น
 *
 *   Phase C — Index.txt rollup:
 *     ทุก entry → sync updated_at + release_date จากไฟล์จริง
 *
 * Usage:
 *   node patch-updated-at-movies.js              # dry-run
 *   node patch-updated-at-movies.js --apply      # เขียนจริง
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["playlist/anime/movies", "playlist/movies"];

const APPLY = process.argv.includes("--apply");

function readJson(p)  { return JSON.parse(fs.readFileSync(p, "utf-8")); }
function writeJson(p, j) { fs.writeFileSync(p, JSON.stringify(j, null, 4), "utf-8"); }
function toIsoMidnight(dateStr) { return new Date(`${dateStr}T00:00:00Z`).toISOString(); }

// ─── Phase A: patch part files ───
function planPartPatches(dir) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) return [];
  const files = fs.readdirSync(absDir).filter(f => f !== "index.txt" && f.endsWith(".txt"));

  const plans = [];
  for (const f of files) {
    const filePath = path.join(absDir, f);
    let j;
    try { j = readJson(filePath); } catch { continue; }
    if (!Array.isArray(j.stations)) continue;      // not a part file
    if (!j.release_date) continue;                  // no date to use

    const newUpdatedAt = toIsoMidnight(j.release_date);
    if (j.updated_at === newUpdatedAt) continue;    // already patched

    plans.push({
      phase: "A-part",
      dir, file: f, filePath,
      oldUpdatedAt: j.updated_at || "(none)",
      newUpdatedAt,
      releaseDate: j.release_date,
      playlist: j,
    });
  }
  return plans;
}

// ─── Phase B: patch main files (use latest part release_date) ───
function planMainPatches(dir) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) return [];
  const files = fs.readdirSync(absDir).filter(f => f !== "index.txt" && f.endsWith(".txt"));

  const plans = [];
  for (const f of files) {
    const filePath = path.join(absDir, f);
    let j;
    try { j = readJson(filePath); } catch { continue; }
    if (!Array.isArray(j.groups))  continue;        // not a main file
    if (Array.isArray(j.stations)) continue;        // hybrid? skip — only pure main

    // Collect release_dates from referenced parts
    const partDates = [];
    const partRefs  = [];
    for (const g of j.groups) {
      if (!g.url) continue;
      const partFname = g.url.split("/").pop();
      const partPath  = path.join(absDir, partFname);
      if (!fs.existsSync(partPath)) continue;       // missing part file
      try {
        const partJson = readJson(partPath);
        if (partJson.release_date) {
          partDates.push(partJson.release_date);
          partRefs.push({ fname: partFname, date: partJson.release_date });
        }
      } catch { /* skip unreadable */ }
    }
    if (!partDates.length) continue;

    const maxDate       = partDates.slice().sort().pop();
    const newUpdatedAt  = toIsoMidnight(maxDate);
    const newReleaseDate = maxDate;

    const needUpdated  = j.updated_at   !== newUpdatedAt;
    const needRelease  = j.release_date !== newReleaseDate;
    if (!needUpdated && !needRelease) continue;

    plans.push({
      phase: "B-main",
      dir, file: f, filePath,
      oldUpdatedAt:   j.updated_at   || "(none)",
      newUpdatedAt,
      oldReleaseDate: j.release_date || "(none)",
      newReleaseDate,
      maxDate, partRefs,
      playlist: j,
    });
  }
  return plans;
}

// ─── Phase C: rollup index.txt ───
function planIndexRollup(dir) {
  const indexPath = path.join(ROOT, dir, "index.txt");
  if (!fs.existsSync(indexPath)) return null;
  const index = readJson(indexPath);
  const changes = [];
  for (const entry of index.groups || []) {
    if (!entry.url) continue;
    const fname    = entry.url.split("/").pop();
    const filePath = path.join(ROOT, dir, fname);
    if (!fs.existsSync(filePath)) continue;
    let j;
    try { j = readJson(filePath); } catch { continue; }
    const wantUpdated = j.updated_at;
    const wantRelease = j.release_date;
    if (!wantUpdated && !wantRelease) continue;
    const needU = wantUpdated && entry.updated_at   !== wantUpdated;
    const needR = wantRelease && entry.release_date !== wantRelease;
    if (!needU && !needR) continue;
    changes.push({ fname, oldUpdatedAt: entry.updated_at, newUpdatedAt: wantUpdated, oldReleaseDate: entry.release_date, newReleaseDate: wantRelease, entry });
  }
  return { indexPath, index, changes };
}

// ─── Execution ───
const allPartPlans = [];
const allMainPlans = [];
for (const dir of DIRS) {
  allPartPlans.push(...planPartPatches(dir));
}

// Phase A apply (so Phase B reads patched part files? — actually we read playlist objects in memory)
// To allow Phase B to read FRESH release_date (which doesn't change in Phase A anyway), we don't need to write yet.
// But to apply, we should write Phase A first, then re-read for Phase B... but release_date isn't changed in Phase A.
// Safe to plan Phase B from disk now since release_date is read-only here.

for (const dir of DIRS) {
  allMainPlans.push(...planMainPatches(dir));
}

const modeTag = APPLY ? "APPLY" : "DRY-RUN";
console.log(`\n=== patch-updated-at-movies  [${modeTag}] ===`);
console.log(`Phase A (part files needing patch):  ${allPartPlans.length}`);
console.log(`Phase B (main files needing patch):  ${allMainPlans.length}`);

// Sample print
function printSample(plans, label) {
  if (!plans.length) return;
  const sample = plans.length <= 8 ? plans : [...plans.slice(0, 6), null, ...plans.slice(-1)];
  console.log(`\n--- ${label} (showing ${sample.filter(Boolean).length}/${plans.length}) ---`);
  for (const p of sample) {
    if (p === null) { console.log("    ..."); continue; }
    console.log(`  ${p.dir}/${p.file}`);
    console.log(`    updated_at: ${p.oldUpdatedAt}  →  ${p.newUpdatedAt}`);
    if (p.phase === "B-main") {
      console.log(`    release_date: ${p.oldReleaseDate}  →  ${p.newReleaseDate}  (latest part: ${p.maxDate})`);
    } else {
      console.log(`    release_date: ${p.releaseDate}  (unchanged)`);
    }
  }
}
printSample(allPartPlans, "Phase A: part files");
printSample(allMainPlans, "Phase B: main files");

if (!allPartPlans.length && !allMainPlans.length) {
  console.log("\nไม่มีไฟล์ที่ต้อง patch (file-level) — ตรวจ Phase C (index rollup) ต่อ");
}

if (!APPLY) {
  // Preview Phase C without applying
  console.log(`\n--- Phase C preview (index.txt rollup) ---`);
  for (const dir of DIRS) {
    const r = planIndexRollup(dir);
    if (!r) continue;
    console.log(`  ${dir}/index.txt — ${r.changes.length} entries will be updated`);
    r.changes.slice(0, 3).forEach(c => {
      console.log(`    ${c.fname}: ${c.oldUpdatedAt} → ${c.newUpdatedAt}`);
    });
    if (r.changes.length > 3) console.log(`    ...`);
  }
  console.log(`\n(dry-run) ใส่ --apply เพื่อเขียนไฟล์จริง:`);
  console.log(`  node tools/patch-updated-at-movies.js --apply`);
  process.exit(0);
}

// APPLY — write files
console.log(`\n--- writing files ---`);

// Phase A
for (const p of allPartPlans) {
  p.playlist.updated_at = p.newUpdatedAt;
  writeJson(p.filePath, p.playlist);
}
console.log(`✅ Phase A: patched ${allPartPlans.length} part files`);

// Phase B — re-read fresh (in case Phase A overlapped), but Phase B operates on main files which Phase A doesn't touch
for (const p of allMainPlans) {
  p.playlist.release_date = p.newReleaseDate;
  p.playlist.updated_at   = p.newUpdatedAt;
  writeJson(p.filePath, p.playlist);
}
console.log(`✅ Phase B: patched ${allMainPlans.length} main files`);

// Phase C — rollup index
let totalRolled = 0;
for (const dir of DIRS) {
  const r = planIndexRollup(dir);
  if (!r) continue;
  if (!r.changes.length) {
    console.log(`✅ Phase C: ${dir}/index.txt — no change`);
    continue;
  }
  for (const c of r.changes) {
    if (c.newUpdatedAt)   c.entry.updated_at   = c.newUpdatedAt;
    if (c.newReleaseDate) c.entry.release_date = c.newReleaseDate;
  }
  fs.writeFileSync(r.indexPath, JSON.stringify(r.index, null, 2), "utf-8");
  console.log(`✅ Phase C: ${dir}/index.txt — ${r.changes.length} entries`);
  totalRolled += r.changes.length;
}

console.log(`\n🎉 เสร็จสิ้น — patched ${allPartPlans.length + allMainPlans.length} files + ${totalRolled} index entries`);
