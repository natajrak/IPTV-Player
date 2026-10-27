// Pure helpers — no fs / no fetch
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function asMidnightUtc(dateStr) {
  return dateStr ? String(dateStr).slice(0, 10) + 'T00:00:00.000Z' : '';
}

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์/g, '')
    .replace(/[฀-๿]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSeriesTitle(enName, thName) {
  if (thName && thName !== enName) return `${enName} [${thName}]`;
  return enName;
}

function isGenericEpisodeName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Episode\s+\d+$/i.test(s) || /^ตอนที่\s*\d+$/.test(s);
}

function isGenericSeasonName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Season\s+\d+$/i.test(s)
      || /^Specials$/i.test(s)
      || /^ซีซั่น\s*\d+$/.test(s)
      || /^ตอนพิเศษ$/.test(s);
}

// Detects "Specials" / "Season 0" / "ตอนพิเศษ" / "ซีซั่น 0" — used to exclude these
// from completion-status analysis (the user doesn't track Specials toward "is this show finished").
function isSpecialSeasonName(name) {
  if (!name) return false;
  const s = String(name).trim();
  return /^Specials?$/i.test(s)
      || /^ตอนพิเศษ$/.test(s)
      || /^Season\s*0$/i.test(s)
      || /^ซีซั่น\s*0$/.test(s);
}

// True when two season names refer to the same season — exact match OR both Special-variants.
// Used by buildOrMergePlaylist + update-meta + per-script post-build to merge "Special",
// "Specials", "specials", "ตอนพิเศษ", "Season 0" etc. into a single logical season.
function matchesSeasonName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (isSpecialSeasonName(a) && isSpecialSeasonName(b)) return true;
  return false;
}

function buildStationName(epNum, epTitle, isDubbedTrack) {
  if (!epTitle) return isDubbedTrack ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbedTrack ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

/**
 * เลขตอนที่ใช้ตั้งชื่อ station เมื่อต่อภาคด้วย --ep-offset: "2" + 12 → "14", "11.5" + 12 → "23.5"
 * label ที่ไม่ใช่ตัวเลข (OVA, SP) คืนค่าเดิม
 */
function offsetEpisodeLabel(label, epOffset) {
  const str = String(label);
  if (!(epOffset > 0) || !/^\d+(?:\.\d+)?$/.test(str)) return str;
  return String(Number(str) + epOffset);
}

/**
 * multi-URL: ตอนของ URL ถัดไปที่เว็บนับเลขใหม่ (เลขชนกับ URL ก่อนหน้า) → เลื่อนให้ต่อจากเลขสูงสุดก่อนหน้า
 * ถ้าเว็บนับเลขต่อเนื่องอยู่แล้ว (เลขไม่ชน) คงเลขเดิม
 */
function continuePartNumbering(prevEpisodes, partEpisodes) {
  const prevNums = prevEpisodes.map((e) => e.epNum).filter(Number.isFinite);
  const pageNums = partEpisodes.map((e) => e.epNum).filter(Number.isFinite);
  if (!prevNums.length || !pageNums.length) return;
  const prevMax = Math.max(...prevNums);
  const pageMin = Math.min(...pageNums);
  if (pageMin > prevMax) return;
  const offset = prevMax - pageMin + 1;
  for (const ep of partEpisodes) {
    if (Number.isFinite(ep.epNum)) ep.epNum += offset;
  }
}

const TRACK_MAP = { th: 'พากย์ไทย', subth: 'ซับไทย' };

// Set/clear track.status = 'completed' based on whether the playlist has
// all the episodes TMDB knows about for this season+language.
// tmdbEpCount > 0 required (0 = no signal, leave status untouched? — we delete to be safe).
function markTrackComplete(track, tmdbEpCount) {
  if (!track || !Array.isArray(track.stations)) return;
  // นับ "จำนวนตอน TMDB ที่ครอบคลุม" จากเลขในชื่อ station (distinct) — ไม่ใช่จำนวน station ตรงๆ
  // เพราะตอนพิเศษที่เว็บแบ่งครึ่ง ("ตอน 11 (1/2)" + "ตอน 11 (2/2)") นับเป็นตอนเดียว
  const distinctEps = new Set(
    track.stations.map((s, i) => {
      const m = String(s?.name || '').match(/(?:ตอน|Ep\.?)\s*(\d+)/i);
      return m ? Number(m[1]) : `idx-${i}`;
    }),
  );
  if (tmdbEpCount > 0 && distinctEps.size >= tmdbEpCount) {
    track.status = 'completed';
  } else {
    delete track.status;
  }
}

module.exports = {
  sleep,
  asMidnightUtc,
  slugify,
  cleanTitleForSearch,
  formatSeriesTitle,
  isGenericEpisodeName,
  isGenericSeasonName,
  isSpecialSeasonName,
  matchesSeasonName,
  buildStationName,
  offsetEpisodeLabel,
  continuePartNumbering,
  markTrackComplete,
  TRACK_MAP,
};
