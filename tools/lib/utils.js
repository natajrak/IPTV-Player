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

function buildStationName(epNum, epTitle, isDubbedTrack) {
  if (!epTitle) return isDubbedTrack ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbedTrack ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

const TRACK_MAP = { th: 'พากย์ไทย', subth: 'ซับไทย' };

// Set/clear track.status = 'completed' based on whether the playlist has
// all the episodes TMDB knows about for this season+language.
// tmdbEpCount > 0 required (0 = no signal, leave status untouched? — we delete to be safe).
function markTrackComplete(track, tmdbEpCount) {
  if (!track || !Array.isArray(track.stations)) return;
  if (tmdbEpCount > 0 && track.stations.length >= tmdbEpCount) {
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
  buildStationName,
  markTrackComplete,
  TRACK_MAP,
};
