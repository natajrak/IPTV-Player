/**
 * Skip times — ช่วงเวลาข้าม (ย้อนความ / เพลงเปิด / เพลงปิด) ต่อตอน ที่กรอกเองใน CMS
 *
 * station.skip = {
 *   source: 'manual',
 *   segments: [ { type: 'op', start: 143, end: 232 }, ... ]   // [] = ยืนยันว่าไม่มีช่วงข้าม
 * }
 *
 * fetch script สร้าง station ใหม่ทั้ง track ตอน refetch — ต้องยก skip จากไฟล์เดิมไปใส่ ไม่งั้นค่าที่กรอกไว้จะหาย
 */

const { matchesSeasonName } = require('./utils');

/** label ตอนแบบเต็ม เช่น "11" หรือ "11(1/2)" (ตอนที่เว็บแบ่งครึ่ง) — ไม่มีเลขคืน null */
function episodeLabelOf(station) {
  const m = String(station?.name || '').match(/(?:ตอน|Ep\.?)\s*(\d+(?:\s*\(\d+\/\d+\))?)/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

/**
 * ยก station.skip จากไฟล์เดิมไปใส่ station ใหม่ ภายใน season + track ชื่อเดียวกัน
 * (ชื่อ season เทียบด้วย matchesSeasonName เหมือน buildOrMergePlaylist — ชื่อ Specials ทุกแบบถือเป็น season เดียวกัน)
 *   1. URL เดียวกัน → ยกไป
 *   2. URL เปลี่ยน → จับคู่ label ตอนเต็ม ("11", "11(1/2)")
 *      และต้องไม่ซ้ำทั้งใน track เดิมและ track ใหม่ (กันสลับกันระหว่างลิงก์สำรองที่เลขตอนซ้ำ)
 * station ที่มี skip อยู่แล้ว (เช่นโหมด append ที่ใช้ station เดิม) ไม่แตะ
 */
function carryOverSkips(playlist, previous, seasonNames) {
  if (!previous?.groups) return;
  const isWanted = (name) => seasonNames.some((n) => matchesSeasonName(n, name));
  const countLabels = (stations) => {
    const counts = new Map();
    for (const st of stations || []) {
      const label = episodeLabelOf(st);
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    }
    return counts;
  };
  for (const season of playlist.groups || []) {
    if (!isWanted(season.name)) continue;
    const oldSeason = previous.groups.find((g) => matchesSeasonName(g.name, season.name));
    if (!oldSeason) continue;
    for (const track of season.groups || []) {
      const oldTrack = (oldSeason.groups || []).find((t) => t.name === track.name);
      if (!oldTrack) continue;
      const byUrl = new Map();
      const byLabel = new Map();
      const oldCounts = countLabels(oldTrack.stations);
      const newCounts = countLabels(track.stations);
      for (const st of oldTrack.stations || []) {
        if (!st.skip) continue;
        if (st.url && !byUrl.has(st.url)) byUrl.set(st.url, st);
        const label = episodeLabelOf(st);
        if (label && oldCounts.get(label) === 1) byLabel.set(label, st);
      }
      for (const st of track.stations || []) {
        if (st.skip) continue;
        const sameFile = byUrl.get(st.url);
        if (sameFile) {
          st.skip = sameFile.skip;
          continue;
        }
        const label = episodeLabelOf(st);
        const old = label && newCounts.get(label) === 1 ? byLabel.get(label) : null;
        if (old) st.skip = old.skip;
      }
    }
  }
}

/**
 * เรียกจาก fetch script ก่อนเขียนไฟล์ — ยกเวลาข้ามจากไฟล์เดิมไปใส่ season ที่เพิ่ง fetch
 * - previous: playlist เดิมที่อ่านไว้ "ก่อน" build/merge (writeMultiSeason เขียนไฟล์ทับระหว่างทาง อ่านทีหลังไม่ได้)
 * - seasons: เลขหรือชื่อ season ("Season N"; null/ว่าง = Season 1 เหมือน buildOrMergePlaylist)
 * ไม่ throw
 */
function carryOverFetchedSkips({ playlist, seasons, previous = null }) {
  try {
    const names = (seasons || []).map((s) => (typeof s === 'number' ? `Season ${s}` : s || 'Season 1'));
    carryOverSkips(playlist, previous, names);
  } catch (e) {
    console.warn(`⚠️  ยกเวลาข้ามจากไฟล์เดิมไม่สำเร็จ: ${e.message}`);
  }
}

module.exports = { episodeLabelOf, carryOverSkips, carryOverFetchedSkips };
