/**
 * Source ↔ TMDB episode mapper
 *
 * ใช้กับกรณีเว็บต้นทางแบ่งตอนพิเศษของ TMDB (เช่น ตอน 1 ชม. ของ Conan)
 * ออกเป็นหลายตอนย่อย ทำให้เลขตอนฝั่ง source drift จาก TMDB สะสมไปเรื่อยๆ
 *
 * --split-eps=11,20     → TMDB ตอน 11 และ 20 ถูกเว็บแบ่งเป็น 2 ตอน
 * --split-eps=11,20:3   → ตอน 20 แบ่งเป็น 3 ตอน
 *
 * buildEpisodeMap คืน array ยาวเท่าจำนวนตอนฝั่ง source:
 *   { epNum: 11, label: '11 (1/2)' }   ← ตอนที่ถูกแบ่ง
 *   { epNum: 12, label: '12' }         ← ตอนปกติ (เลขตาม TMDB)
 * เอา label ส่งเข้า buildStationName ได้ตรงๆ → "ตอน 11 (1/2) - ชื่อตอน"
 */

const { measureDurationMinutes } = require('./stream-duration');
const { buildStationName } = require('./utils');
const { TMDB_IMG } = require('./tmdb');

/** "11,20:3" → Map { 11 => 2, 20 => 3 } (token ที่ format ผิดถูกข้าม) */
function parseSplitEps(raw) {
  const map = new Map();
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((tok) => {
      const m = tok.match(/^(\d+)(?::(\d+))?$/);
      if (!m) {
        console.warn(`⚠️  --split-eps: ข้าม "${tok}" (format ต้องเป็น N หรือ N:parts)`);
        return;
      }
      map.set(Number(m[1]), Math.max(2, Number(m[2] || 2)));
    });
  return map;
}

/** สร้าง mapping source index → { epNum, label } */
function buildEpisodeMap({ sourceCount, epOffset = 0, splitEps = '' }) {
  const splits = splitEps instanceof Map ? splitEps : parseSplitEps(splitEps);
  const out = [];
  let epNum = 1 + epOffset;
  let part = 0;
  for (let i = 0; i < sourceCount; i++) {
    const totalParts = splits.get(epNum) || 1;
    if (totalParts > 1) {
      part += 1;
      out.push({ epNum, label: `${epNum} (${part}/${totalParts})` });
      if (part >= totalParts) {
        epNum += 1;
        part = 0;
      }
    } else {
      out.push({ epNum, label: String(epNum) });
      epNum += 1;
    }
  }
  return out;
}

/**
 * --auto-split (opt-in): ใช้ split ที่ตรวจพบอัตโนมัติเมื่อสมการลงตัวเป๊ะเท่านั้น
 *   source == (TMDB - offset) + จำนวนตอนที่ runtime ≥ longRuntimeMin
 * เงื่อนไข: ผู้ใช้ส่ง --auto-split เอง / --split-eps ที่กรอกมือชนะเสมอ /
 * ไม่ลงตัว = ไม่เดา คืนค่าเดิม (แล้ว suggestSplitEps จะพิมพ์คำแนะนำตามปกติ)
 * รองรับเฉพาะแบ่ง 2 ตอน — แบ่ง 3+ สมการไม่ลงตัวอยู่แล้ว ต้องกรอกมือ
 */
function resolveAutoSplit({ sourceCount, tmdbEpisodes, epOffset = 0, splitEps = '', autoSplit = false, longRuntimeMin = 40 }) {
  if (!autoSplit || splitEps) return splitEps;
  if (!Array.isArray(tmdbEpisodes) || tmdbEpisodes.length === 0) return splitEps;

  const candidates = tmdbEpisodes.filter(
    (e) => (e.runtime || 0) >= longRuntimeMin && e.episode_number > epOffset,
  );
  const expected = (tmdbEpisodes.length - epOffset) + candidates.length;

  if (candidates.length === 0 || sourceCount !== expected) {
    console.warn(`ℹ️  --auto-split: ไม่ใช้ — ${candidates.length === 0 ? 'ไม่พบตอน runtime ยาว' : `สมการไม่ลงตัว (source ${sourceCount} / คาด ${expected})`} → ใช้ mapping ปกติ`);
    return splitEps;
  }

  const resolved = candidates.map((e) => String(e.episode_number)).join(',');
  console.log(`🔀 --auto-split: พบตอนพิเศษ ${candidates.length} ตอน สมการลงตัว (${sourceCount} = ${tmdbEpisodes.length - epOffset} + ${candidates.length})`);
  console.log(`   ใช้ --split-eps=${resolved} (${candidates.map((e) => `${e.episode_number}:${e.runtime}m`).join(', ')})`);
  return resolved;
}

/**
 * ตัวช่วยแนะนำ ไม่ตัดสินใจเอง — เรียกหลังรู้จำนวนตอนทั้งสองฝั่ง
 * ถ้าจำนวน source ไม่ตรงกับที่คาด จะพิมพ์ตอนที่ runtime ยาว (น่าจะถูกเว็บแบ่งครึ่ง)
 * ให้ผู้ใช้ตรวจแล้วรันใหม่ด้วย --split-eps เอง
 */
function suggestSplitEps({ sourceCount, tmdbEpisodes, epOffset = 0, splitEps = '', longRuntimeMin = 40 }) {
  if (!Array.isArray(tmdbEpisodes) || tmdbEpisodes.length === 0) return;

  const splits = parseSplitEps(splitEps);
  const extraFromSplits = [...splits.values()].reduce((sum, n) => sum + (n - 1), 0);
  const expected = (tmdbEpisodes.length - epOffset) + extraFromSplits;
  if (sourceCount === expected) return;

  const longEps = tmdbEpisodes.filter((e) => (e.runtime || 0) >= longRuntimeMin && !splits.has(e.episode_number));

  console.warn(`\n⚠️  จำนวนตอนไม่ตรง: source ${sourceCount} ตอน / คาดไว้ ${expected} ตอน (TMDB ${tmdbEpisodes.length}${epOffset ? ` -offset ${epOffset}` : ''}${extraFromSplits ? ` +split ${extraFromSplits}` : ''})`);
  console.warn('   ถ้าเป็น series ที่ยังออกอากาศอยู่ จำนวนไม่ตรงเป็นเรื่องปกติ — ข้ามคำเตือนนี้ได้');
  if (longEps.length > 0) {
    const list = longEps.map((e) => `${e.episode_number} (${e.runtime}m)`).join(', ');
    const flagSuggestion = [
      ...[...splits.entries()].map(([n, p]) => (p === 2 ? String(n) : `${n}:${p}`)),
      ...longEps.map((e) => String(e.episode_number)),
    ].join(',');
    console.warn(`💡 ตอนที่ TMDB runtime ≥ ${longRuntimeMin} นาที (เว็บอาจแบ่งครึ่ง): ${list}`);
    console.warn(`   ถ้าใช่ ลองรันใหม่ด้วย --split-eps=${flagSuggestion}`);
  }
}

/** runtime ฐานของ season = ค่าที่พบบ่อยที่สุด (Conan = 25 นาที) */
function baseRuntime(tmdbEpisodes) {
  const counts = new Map();
  for (const e of tmdbEpisodes) {
    const r = e.runtime || 0;
    if (r > 0) counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (counts.size === 0) return 0;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/**
 * Map แบบวัดของจริง (--auto-split): เดินคู่ TMDB ↔ source
 * ตอนไหน TMDB runtime ยาวผิดปกติ → วัด duration ของ stream ตอนนั้นจริงๆ
 *   วัดได้ใกล้ runtime  → เว็บมีไฟล์เต็ม ไม่ได้แบ่ง (1 ตอน)
 *   วัดได้สั้นกว่ามาก   → เว็บแบ่ง k = round(runtime / duration) ตอน
 *   วัดไม่ได้           → ไม่เดา ถือว่าไม่แบ่ง
 * รองรับ season ที่ source มีไม่ครบ และแบ่งกี่ตอนก็ได้ (Conan มีทั้ง 2/4/5)
 *
 * getStation(sourceIndex) → { url, referer, resolver } | null
 * คืน { map, splitEps } — splitEps เก็บลง playlist เพื่อ prefill รอบถัดไป
 */
async function buildMeasuredMap({ sourceCount, tmdbEpisodes, epOffset = 0, getStation, longFactor = 1.5 }) {
  const base = baseRuntime(tmdbEpisodes);
  if (!base) {
    console.warn('⚠️  --auto-split: TMDB ไม่มีข้อมูล runtime → ใช้ mapping ปกติ');
    return { map: buildEpisodeMap({ sourceCount, epOffset }), splitEps: '' };
  }
  console.log(`\n🔎 --auto-split: runtime ฐาน ${base} นาที — ตรวจตอนที่ยาวกว่า ${Math.round(base * longFactor)} นาที`);

  const map = [];
  const detected = [];
  let tmdbIdx = epOffset;

  while (map.length < sourceCount && tmdbIdx < tmdbEpisodes.length) {
    const ep = tmdbEpisodes[tmdbIdx];
    const epNum = ep.episode_number ?? tmdbIdx + 1;
    const runtime = ep.runtime || 0;
    let parts = 1;

    if (runtime >= base * longFactor) {
      const station = await getStation(map.length);
      const measured = station ? await measureDurationMinutes(station.url, station) : null;
      if (measured && measured < runtime * 0.75) {
        parts = Math.max(2, Math.round(runtime / measured));
        detected.push(parts === 2 ? String(epNum) : `${epNum}:${parts}`);
        console.log(`   ตอน ${epNum}: TMDB ${runtime} นาที / stream จริง ${measured.toFixed(1)} นาที → แบ่ง ${parts} ตอน`);
      } else {
        console.log(`   ตอน ${epNum}: TMDB ${runtime} นาที / stream จริง ${measured ? `${measured.toFixed(1)} นาที` : 'วัดไม่ได้'} → ไม่แบ่ง`);
      }
    }

    for (let p = 1; p <= parts && map.length < sourceCount; p++) {
      map.push({ epNum, label: parts > 1 ? `${epNum} (${p}/${parts})` : String(epNum) });
    }
    tmdbIdx += 1;
  }

  // source เกินจำนวนตอนที่ TMDB มี → ตอนที่เหลือไล่เลขต่อไปตามเดิม
  let nextNum = (tmdbEpisodes[tmdbIdx - 1]?.episode_number ?? tmdbIdx) + 1;
  while (map.length < sourceCount) {
    map.push({ epNum: nextNum, label: String(nextNum) });
    nextNum += 1;
  }

  const last = map[map.length - 1];
  console.log(`✅ --auto-split: source ${sourceCount} ตอน → TMDB ตอน ${map[0]?.epNum}–${last?.epNum}${detected.length ? ` (แบ่ง ${detected.length} จุด)` : ' (ไม่พบการแบ่ง)'}`);
  return { map, splitEps: detected.join(',') };
}

/**
 * --auto-split (ใช้ร่วมกันทุก script): เรียกหลังลูปสร้าง stations เสร็จ
 * ใช้ station.url ที่ script ดึงมาแล้ว จึงไม่ต้องรู้วิธีดึง stream ของแต่ละเว็บ
 *
 * เดินคู่ TMDB ↔ stations — ตอนไหน TMDB runtime ยาวผิดปกติจะวัด duration จริง:
 *   วัดได้ใกล้ runtime → เว็บมีไฟล์เต็ม ไม่ได้แบ่ง
 *   วัดได้สั้นกว่ามาก  → เว็บแบ่ง k = round(runtime / duration) ตอน
 *   วัดไม่ได้          → ไม่เดา ถือว่าไม่แบ่ง
 * แล้ว rewrite ชื่อ/ภาพ/วันฉายของ station ตาม mapping ที่ได้ (mutate in place)
 * คืน splitEps string ไว้เก็บลง playlist เพื่อ prefill รอบถัดไป
 */
async function applyMeasuredSplit({ stations, tmdbEpisodes, epOffset = 0, isDubbedTrack, longFactor = 1.5 }) {
  if (!Array.isArray(stations) || stations.length === 0) return '';
  if (!Array.isArray(tmdbEpisodes) || tmdbEpisodes.length === 0) {
    console.warn('⚠️  --auto-split: ไม่มีข้อมูล TMDB → ข้าม');
    return '';
  }
  const base = baseRuntime(tmdbEpisodes);
  if (!base) {
    console.warn('⚠️  --auto-split: TMDB ไม่มีข้อมูล runtime → ข้าม');
    return '';
  }

  console.log(`\n🔎 --auto-split: runtime ฐาน ${base} นาที — ตรวจตอนที่ยาวกว่า ${Math.round(base * longFactor)} นาที`);
  const detected = [];
  const estimated = [];
  let srcIdx = 0;
  let tmdbIdx = epOffset;

  while (srcIdx < stations.length && tmdbIdx < tmdbEpisodes.length) {
    const ep = tmdbEpisodes[tmdbIdx];
    const epNum = ep.episode_number ?? tmdbIdx + 1;
    const runtime = ep.runtime || 0;
    let parts = 1;

    if (runtime >= base * longFactor) {
      const s = stations[srcIdx];
      const measured = await measureDurationMinutes(s.url, { referer: s.referer, resolver: s.resolver });
      // จำนวนตอนย่อยคิดจาก runtime / ฐาน เท่านั้น — TMDB ให้ runtime เป็นพหุคูณสะอาด
      // (50/100/125 = 2/4/5 เท่าของ 25) ส่วน duration ที่วัดได้แกว่ง 20–28 นาที
      // ถ้าเอา duration ไปหารตรงๆ จะปัดพลาด (100/21.2 ปัดเป็น 5 ทั้งที่ควรเป็น 4)
      // measurement มีหน้าที่ยืนยันแค่ว่า "เว็บแบ่งจริงไหม" ไม่ได้ใช้กำหนดจำนวน
      const splitParts = Math.max(2, Math.round(runtime / base));
      if (measured && measured < runtime * 0.75) {
        parts = splitParts;
        detected.push(parts === 2 ? String(epNum) : `${epNum}:${parts}`);
        console.log(`   ตอน ${epNum}: TMDB ${runtime} นาที / stream จริง ${measured.toFixed(1)} นาที → แบ่ง ${parts} ตอน`);
      } else if (measured) {
        console.log(`   ตอน ${epNum}: TMDB ${runtime} นาที / stream จริง ${measured.toFixed(1)} นาที → ไม่แบ่ง`);
      } else {
        // วัดไม่ได้แม้ retry — ประมาณจาก runtime แทนการถือว่า "ไม่แบ่ง"
        // เพราะถ้าเดาผิดข้างนี้ เลขตอนหลังจากนี้จะ drift ยกแถว ส่วนอีกข้างเสียแค่ตอนเดียว
        parts = splitParts;
        estimated.push(epNum);
        detected.push(parts === 2 ? String(epNum) : `${epNum}:${parts}`);
        console.warn(`   ⚠️  ตอน ${epNum}: TMDB ${runtime} นาที / วัดไม่ได้ → ประมาณว่าแบ่ง ${parts} ตอน (ควรตรวจสอบ)`);
      }
    }

    for (let p = 1; p <= parts && srcIdx < stations.length; p++, srcIdx++) {
      const label = parts > 1 ? `${epNum} (${p}/${parts})` : String(epNum);
      const st = stations[srcIdx];
      st.name = buildStationName(label, ep.name || '', isDubbedTrack);
      if (ep.still_path) st.image = `${TMDB_IMG}${ep.still_path}`;
      st.release_date = ep.air_date || '';
    }
    tmdbIdx += 1;
  }

  const covered = tmdbEpisodes[Math.min(tmdbIdx, tmdbEpisodes.length) - 1];
  console.log(`✅ --auto-split: source ${stations.length} ตอน → TMDB ตอน ${tmdbEpisodes[epOffset]?.episode_number ?? 1}–${covered?.episode_number ?? '?'}${detected.length ? ` (แบ่ง ${detected.length} จุด)` : ' (ไม่พบการแบ่ง)'}`);
  if (estimated.length) {
    console.warn(`⚠️  ${estimated.length} จุดวัดไม่ได้ ใช้ค่าประมาณจาก runtime: ตอน ${estimated.join(', ')}`);
  }
  if (srcIdx < stations.length) {
    console.warn(`⚠️  เหลือ ${stations.length - srcIdx} ตอนที่ TMDB ไม่มีข้อมูล — ชื่อเดิมถูกเก็บไว้`);
  }
  return detected.join(',');
}

module.exports = {
  parseSplitEps, buildEpisodeMap, suggestSplitEps, resolveAutoSplit,
  buildMeasuredMap, applyMeasuredSplit,
};
