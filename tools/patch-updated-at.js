#!/usr/bin/env node
/**
 * patch-updated-at.js
 * Patch `updated_at` ของเรื่องที่ "จบแล้ว" ให้เท่ากับ release_date ล่าสุดของ season
 *
 * เงื่อนไข "จบแล้ว":
 *   - File เป็น series structure (มี groups[])
 *   - ทุก season มี track อย่างน้อย 1 ตัว และ ทุก track มี status === 'completed'
 *
 * ค่าใหม่ของ updated_at:
 *   - max(season.release_date) ของทุก season ในไฟล์ (YYYY-MM-DD)
 *   - แปลงเป็น ISO timestamp ที่เที่ยงคืน UTC → "YYYY-MM-DDT00:00:00.000Z"
 *
 * Rollup:
 *   - Patch file's updated_at
 *   - Patch index.txt entry's updated_at (ตาม logic เดียวกับ CMS toggle)
 *
 * Usage:
 *   node patch-updated-at.js              # dry-run (default)
 *   node patch-updated-at.js --apply      # เขียนไฟล์จริง
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIRS = ["playlist/anime/series", "playlist/series"];

const APPLY = process.argv.includes("--apply");

function isAllCompleted(playlist) {
  if (!Array.isArray(playlist.groups) || playlist.groups.length === 0) return false;
  return playlist.groups.every(season => {
    const tracks = season.groups || [];
    return tracks.length > 0 && tracks.every(t => t.status === "completed");
  });
}

function maxSeasonDate(playlist) {
  const dates = (playlist.groups || []).map(s => s.release_date).filter(Boolean);
  if (!dates.length) return null;
  return dates.slice().sort().pop();  // YYYY-MM-DD lex sort works for ISO dates
}

function toIsoMidnight(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toISOString();
}

function patchOne(dir, file) {
  const filePath = path.join(ROOT, dir, file);
  let playlist;
  try { playlist = JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (e) { return { skip: `parse error: ${e.message}` }; }

  if (!isAllCompleted(playlist)) return { skip: "not all completed" };

  const latestDate = maxSeasonDate(playlist);
  if (!latestDate) return { skip: "no season release_date" };

  const newUpdatedAt = toIsoMidnight(latestDate);
  const oldUpdatedAt = playlist.updated_at || "(none)";

  if (oldUpdatedAt === newUpdatedAt) return { skip: "already patched" };

  return { filePath, dir, file, oldUpdatedAt, newUpdatedAt, latestDate, playlist };
}

function patchIndexEntry(indexPath, fileBase, newUpdatedAt) {
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, "utf-8")); }
  catch { return false; }
  const entry = (index.groups || []).find(g => g.url && g.url.endsWith(`/${fileBase}`));
  if (!entry) return false;
  if (entry.updated_at === newUpdatedAt) return false;
  entry.updated_at = newUpdatedAt;
  if (APPLY) fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  return true;
}

const summary = { scanned: 0, qualified: 0, skipped: {}, planned: [] };

for (const dir of DIRS) {
  const absDir = path.join(ROOT, dir);
  if (!fs.existsSync(absDir)) continue;
  const files = fs.readdirSync(absDir).filter(f => f !== "index.txt" && f.endsWith(".txt"));
  for (const f of files) {
    summary.scanned++;
    const r = patchOne(dir, f);
    if (r.skip) {
      summary.skipped[r.skip] = (summary.skipped[r.skip] || 0) + 1;
      continue;
    }
    summary.qualified++;
    summary.planned.push(r);
  }
}

const modeTag = APPLY ? "APPLY" : "DRY-RUN";
console.log(`\n=== patch-updated-at  [${modeTag}] ===`);
console.log(`scanned:   ${summary.scanned} files`);
console.log(`qualified: ${summary.qualified} files (all-seasons-completed + has season release_date + needs patch)`);
console.log(`skipped breakdown:`);
for (const [reason, count] of Object.entries(summary.skipped)) {
  console.log(`  • ${reason}: ${count}`);
}

if (!summary.planned.length) {
  console.log("\nไม่มีไฟล์ที่ต้อง patch — เสร็จสิ้น");
  process.exit(0);
}

// Show sample diff (first 8 + last 2)
const sample = summary.planned.length <= 12
  ? summary.planned
  : [...summary.planned.slice(0, 10), null, ...summary.planned.slice(-2)];

console.log(`\n--- planned changes (showing ${sample.filter(Boolean).length}/${summary.planned.length}) ---`);
for (const p of sample) {
  if (p === null) { console.log("    ..."); continue; }
  console.log(`  ${p.dir}/${p.file}`);
  console.log(`    ${p.oldUpdatedAt}`);
  console.log(`    → ${p.newUpdatedAt}  (max season: ${p.latestDate})`);
}

if (!APPLY) {
  console.log(`\n(dry-run) ใส่ --apply เพื่อเขียนไฟล์จริง:`);
  console.log(`  node tools/patch-updated-at.js --apply`);
  process.exit(0);
}

// APPLY mode — write files + rollup index.txt
console.log(`\n--- writing ${summary.planned.length} files ---`);
let indexRolled = 0;
const indexByDir = {};
for (const p of summary.planned) {
  p.playlist.updated_at = p.newUpdatedAt;
  fs.writeFileSync(p.filePath, JSON.stringify(p.playlist, null, 4), "utf-8");

  const indexPath = path.join(ROOT, p.dir, "index.txt");
  if (patchIndexEntry(indexPath, p.file, p.newUpdatedAt)) {
    indexRolled++;
    indexByDir[p.dir] = (indexByDir[p.dir] || 0) + 1;
  }
}

console.log(`✅ patched ${summary.planned.length} playlist files`);
console.log(`✅ rolled up ${indexRolled} index.txt entries`);
for (const [dir, count] of Object.entries(indexByDir)) {
  console.log(`   • ${dir}/index.txt: ${count} entries`);
}
console.log("\n🎉 เสร็จสิ้น");
