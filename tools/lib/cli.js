// Unified CLI arg parser for fetch scripts
const { TRACK_MAP } = require('./utils');

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const get = (flag) => {
    const a = args.find((x) => x.startsWith(flag + '='));
    return a ? a.slice(flag.length + 1) : '';
  };
  const hasFlag = (flag) => args.includes(flag) || args.some((a) => a.startsWith(flag + '='));

  const seriesUrl    = args.find((a) => a.startsWith('http')) || '';
  const tmdbKey      = get('--tmdb-key') || process.env.TMDB_API_KEY || '';
  const customOutput = get('--output');
  const mainSlugArg  = get('--main-slug');
  const idPrefixArg  = get('--id-prefix');

  const trackArg     = get('--track');
  const trackName    = TRACK_MAP[trackArg] || trackArg || 'ซับไทย';
  const isDubbedTrack = trackName === 'พากย์ไทย';
  const filterTrack  = trackArg ? trackName : null;

  const seasonRaw = get('--season');
  const seasonNum = seasonRaw ? (parseInt(seasonRaw) ?? null) : null;
  const seasonName = seasonNum != null
    ? (seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`)
    : null;

  const updateMetaArg = args.find((a) => a === '--update-meta' || a.startsWith('--update-meta='));
  const updateMeta = !!updateMetaArg;
  const updateMetaMode = updateMetaArg?.includes('=') ? updateMetaArg.split('=')[1] : 'all';

  const noTouch = args.includes('--no-touch');
  const silent  = args.includes('--silent');

  const tmdbIdRaw = get('--tmdb-id');
  const forceTmdbId = tmdbIdRaw ? (parseInt(tmdbIdRaw) || null) : null;

  const tmdbSeasonRaw = get('--tmdb-season');
  const tmdbSeasonNum = tmdbSeasonRaw ? (parseInt(tmdbSeasonRaw) || null) : null;

  const epOffsetRaw = get('--ep-offset');
  const epOffset = epOffsetRaw ? (parseInt(epOffsetRaw) || 0) : 0;

  const typeArg = get('--type');

  return {
    args,
    seriesUrl,
    tmdbKey,
    customOutput,
    mainSlugArg,
    idPrefixArg,
    trackArg,
    trackName,
    isDubbedTrack,
    filterTrack,
    seasonNum,
    seasonName,
    updateMeta,
    updateMetaMode,
    noTouch,
    silent,
    forceTmdbId,
    tmdbSeasonNum,
    epOffset,
    typeArg,
    hasFlag,
    get,
  };
}

module.exports = { parseArgs };
