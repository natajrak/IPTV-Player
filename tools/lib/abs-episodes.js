/**
 * --abs-episodes — เว็บนับเลขตอนรวมทั้งเรื่อง (One Piece 1–1162) แต่แบ่งหน้าตาม season ไทยที่ไม่ตรงกับ TMDB
 *
 * เลขตอนจากหน้าเว็บ = เลขรวม → เทียบกับช่วงสะสมของ season จริงใน TMDB (S1 = 1–61, S2 = 62–77, …)
 * แล้ว merge ลง season ที่ถูกต้องทีละตอนตาม label (ตอนที่หน้านี้ไม่มีไม่ถูกลบ)
 * ไฟล์ที่สร้างด้วยโหมดนี้มี abs_episodes: true ที่ root — รันทับโดยไม่ใส่ flag จะ error กันตอนลงผิด season
 */

const fs = require('fs');
const tmdb = require('./tmdb');
const io = require('./playlist-io');
const { realSeasons } = require('./season-map');

const INCOMPATIBLE = ['--multi-season', '--season-map', '--ep-offset', '--split-eps', '--auto-split', '--tmdb-season'];

/** ไฟล์นี้ต้องใช้โหมด abs หรือไม่ — อ่าน root flag ของไฟล์เดิม */
function fileRequiresAbs(outputPath) {
  if (!fs.existsSync(outputPath)) return false;
  try {
    return JSON.parse(fs.readFileSync(outputPath, 'utf-8'))?.abs_episodes === true;
  } catch {
    return false;
  }
}

/** flag ที่ใช้คู่กับ --abs-episodes ไม่ได้ — คืนข้อความ error หรือ '' */
function checkAbsFlags({ absEpisodes, hasFlag, isMovie }) {
  if (!absEpisodes) return '';
  if (isMovie) return '--abs-episodes ใช้กับ movie ไม่ได้';
  const bad = INCOMPATIBLE.filter((f) => hasFlag(f));
  return bad.length ? `--abs-episodes ใช้คู่กับ ${bad.join(', ')} ไม่ได้` : '';
}

/**
 * โหมดของรอบนี้ต้องตรงกับไฟล์เดิม — คืนข้อความ error หรือ ''
 * - ไฟล์ abs แต่ไม่ได้ใส่ flag → ตอนจะลง Season N แบบนับใหม่
 * - ไฟล์เดิมสร้างแบบปกติแต่ใส่ flag → merge ตามเลขรวมทับ track ที่อาจนับเลขอีกแบบ
 */
function checkAbsFile({ absEpisodes, outputPath }) {
  if (absEpisodes && fs.existsSync(outputPath) && !fileRequiresAbs(outputPath)) {
    return 'ไฟล์นี้ไม่ได้สร้างด้วย --abs-episodes — ใช้ flag นี้ทับไม่ได้ (สร้างไฟล์ใหม่ หรือรันโดยไม่ใส่ --abs-episodes)';
  }
  if (absEpisodes || !fileRequiresAbs(outputPath)) return '';
  return 'ไฟล์นี้สร้างด้วย --abs-episodes (season ตาม TMDB จากเลขตอนรวม) — ต้องใส่ --abs-episodes ทุกครั้งที่ fetch';
}

/** ช่วงเลขรวมของแต่ละ season จริงใน TMDB: [{ seasonNum, from, to }] */
function buildRanges(tmdbShow) {
  let cursor = 0;
  return realSeasons(tmdbShow).map((s) => {
    const from = cursor + 1;
    cursor += s.episode_count;
    return { seasonNum: s.season_number, from, to: cursor };
  });
}

/**
 * จับคู่ตอนจากเว็บ → season TMDB
 * - label ต้องเป็นจำนวนเต็ม (เลขรวม) ไม่งั้น throw — ห้ามเดา
 * - เลขซ้ำข้ามหน้า (หลาย URL) → ใช้ตัวที่มาทีหลัง
 * - เลขเกินที่ TMDB มี → ข้ามพร้อมเตือน (รอ TMDB เพิ่มตอนแล้วค่อย fetch ใหม่)
 * คืน { items: [{ ep, abs, seasonNum }], ranges }
 */
function assignEpisodes({ episodes, tmdbShow }) {
  if (!tmdbShow) throw new Error('--abs-episodes ต้องมีข้อมูล TMDB — ระบุ --tmdb-id หรือตรวจว่า search เจอ');
  const ranges = buildRanges(tmdbShow);
  if (!ranges.length) throw new Error('--abs-episodes: TMDB ไม่มีข้อมูล season');

  const bad = episodes.filter((ep) => !/^\d+$/.test(String(ep.epLabel)));
  if (bad.length) {
    throw new Error(`--abs-episodes: เลขตอนต้องเป็นจำนวนเต็ม แต่เจอ ${bad.slice(0, 5).map((e) => `"${e.epLabel}"`).join(', ')}`);
  }

  const byAbs = new Map();
  for (const ep of episodes) {
    const abs = Number(ep.epLabel);
    if (byAbs.has(abs)) console.log(`ℹ️  ตอน ${abs} ซ้ำข้ามหน้า — ใช้ของหน้า ${ep.pageUrl}`);
    byAbs.set(abs, ep);
  }

  const items = [];
  const beyond = [];
  for (const abs of [...byAbs.keys()].sort((a, b) => a - b)) {
    const range = ranges.find((r) => abs >= r.from && abs <= r.to);
    if (!range) { beyond.push(abs); continue; }
    items.push({ ep: byAbs.get(abs), abs, seasonNum: range.seasonNum });
  }
  if (beyond.length) {
    console.warn(`⚠️  --abs-episodes: TMDB ยังไม่มีตอน ${beyond.join(', ')} (มีถึง ${ranges[ranges.length - 1].to}) — ข้าม`);
  }

  const touched = [...new Set(items.map((it) => it.seasonNum))];
  console.log(`\n🗂️  abs-episodes: ${items.length} ตอน ลง ${touched.length} season`);
  for (const r of ranges.filter((x) => touched.includes(x.seasonNum))) {
    const n = items.filter((it) => it.seasonNum === r.seasonNum).length;
    console.log(`   Season ${r.seasonNum} (ตอน ${r.from}–${r.to}): ${n} ตอน`);
  }
  return { items, ranges };
}

/** metadata ของ season ที่มีตอนในรอบนี้ — Map seasonNum → { episodes, poster, seasonName, airDate, count } */
async function loadSeasonData({ items, ranges, tmdbShow, tmdbKey, isDubbedTrack, posterUrl }) {
  const data = new Map();
  for (const seasonNum of new Set(items.map((it) => it.seasonNum))) {
    const bi = await tmdb.getTmdbSeasonBilingual(tmdbShow.id, tmdbKey, seasonNum);
    const range = ranges.find((r) => r.seasonNum === seasonNum);
    data.set(seasonNum, {
      episodes: isDubbedTrack ? bi.thEpisodes : bi.enEpisodes,
      poster: bi.poster || posterUrl,
      seasonName: bi.seasonName,
      airDate: bi.air_date || '',
      count: range.to - range.from + 1,
      from: range.from,
    });
  }
  return data;
}

/**
 * ตอนของ TMDB + label — TMDB บางเรื่องนับเลขต่อข้าม season (One Piece S2 = 62–77) บางเรื่องเริ่ม 1 ทุก season
 * label ใช้ episode_number ของ TMDB เสมอ
 */
function tmdbEpisodeOf(sd, abs) {
  const episodes = sd?.episodes || [];
  const firstNum = episodes.length ? Math.min(...episodes.map((e) => e.episode_number)) : null;
  if (firstNum == null) console.warn(`⚠️  TMDB ไม่มีรายชื่อตอนของ season นี้ — ใช้เลขรวม ${abs} เป็นเลขตอน`);
  const epNum = firstNum == null ? abs : firstNum + (abs - sd.from);
  const tmdbEp = episodes.find((e) => e.episode_number === epNum) || null;
  return { label: String(epNum), tmdbEp };
}

/** เรียง season ตามเลข — "Season N" ก่อน แล้วตามด้วยชื่ออื่น (Specials ฯลฯ) ตามลำดับเดิม */
function sortSeasons(playlist) {
  const num = (g) => {
    const m = /^Season\s+(\d+)$/i.exec(String(g?.name || ''));
    return m ? Number(m[1]) : Infinity;
  };
  playlist.groups = (playlist.groups || [])
    .map((g, i) => ({ g, i }))
    .sort((a, b) => num(a.g) - num(b.g) || a.i - b.i)
    .map(({ g }) => g);
}

/**
 * เขียนทีละ season แบบ merge ตาม label — buildOrMergePlaylist อ่านไฟล์จากดิสก์ทุกครั้ง จึงต้อง write ระหว่างลูป
 * stations[i] คู่กับ items[i]; referer ของ track = หน้าเว็บที่มีตอนลง season นั้น
 */
function writeAbsEpisodes({ items, stations, data, outputPath, seriesTitle, posterUrl, trackName }) {
  let playlist = null;
  for (const [seasonNum, sd] of data) {
    const idx = items.map((it, i) => (it.seasonNum === seasonNum ? i : -1)).filter((i) => i >= 0);
    const pages = [...new Set(idx.map((i) => items[i].ep.pageUrl))].join(',');
    const sName = `Season ${seasonNum}`;
    playlist = io.buildOrMergePlaylist({
      outputPath, seriesTitle, posterUrl,
      seasonPosterUrl: sd.poster,
      stations: idx.map((i) => stations[i]),
      trackName, trackReferer: pages,
      tmdbSeasonName: sd.seasonName || null,
      seasonName: sName, seasonNum, mergeByLabel: true,
    });
    playlist.abs_episodes = true;
    sortSeasons(playlist);
    io.markSeasonTrackComplete({ playlist, seasonName: sName, trackName, tmdbEpCount: sd.count });
    const g = playlist.groups.find((x) => x.name === sName);
    if (g && sd.airDate) g.release_date = sd.airDate;
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
    console.log(`  📁 ${sName}: ${idx.length} ตอนจากรอบนี้`);
  }
  return playlist;
}

module.exports = { checkAbsFlags, checkAbsFile, assignEpisodes, loadSeasonData, tmdbEpisodeOf, writeAbsEpisodes, buildRanges };
