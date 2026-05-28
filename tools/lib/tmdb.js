// TMDB API helpers — uses global fetch (Node 18+)
const { cleanTitleForSearch, isGenericEpisodeName, isGenericSeasonName } = require('./utils');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/original';

async function searchTmdbTv(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url = `${TMDB_BASE}/search/tv?query=${query}&language=en-US&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0] || null;
}

async function searchTmdbMovie(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url = `${TMDB_BASE}/search/movie?query=${query}&language=en-US&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.results?.[0] || null;
}

async function getTmdbShow(tvId, apiKey, language = 'en-US') {
  const url = `${TMDB_BASE}/tv/${tvId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbShowNameTh(tvId, apiKey) {
  const data = await getTmdbShow(tvId, apiKey, 'th-TH');
  return data?.name || null;
}

async function getTmdbMovieDetail(movieId, apiKey, language = 'en-US') {
  const url = `${TMDB_BASE}/movie/${movieId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbMovieNameTh(movieId, apiKey) {
  const data = await getTmdbMovieDetail(movieId, apiKey, 'th-TH');
  return data?.title || null;
}

async function getTmdbSeason(tvId, apiKey, season = 1, language = 'en-US') {
  const url = `${TMDB_BASE}/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null, name: '', air_date: '' };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster: data.poster_path ? `${TMDB_IMG}${data.poster_path}` : null,
    name: data.name || '',
    air_date: data.air_date || '',
  };
}

// Merge EN + TH season data — uses EN as fallback for generic TH episode names
async function getTmdbSeasonBilingual(tvId, apiKey, season = 1) {
  const [enData, thData] = await Promise.all([
    getTmdbSeason(tvId, apiKey, season, 'en-US'),
    getTmdbSeason(tvId, apiKey, season, 'th-TH'),
  ]);
  const thEps = thData.episodes.map((thEp, i) => {
    const enName = enData.episodes[i]?.name || '';
    const thName = isGenericEpisodeName(thEp.name) ? enName : (thEp.name || enName);
    return { ...enData.episodes[i], ...thEp, name: thName };
  });
  const enSeasonName = enData.name;
  const thSeasonName = thData.name;
  let seasonName = null;
  if (!isGenericSeasonName(enSeasonName)) {
    seasonName = { en: enSeasonName };
    if (thSeasonName && !isGenericSeasonName(thSeasonName)) seasonName.th = thSeasonName;
  }
  return {
    enEpisodes: enData.episodes,
    thEpisodes: thEps,
    poster: enData.poster,
    seasonName,
    air_date: enData.air_date || '',
  };
}

async function getTmdbEpisodes(tvId, apiKey, season = 1, language = 'en-US') {
  return (await getTmdbSeason(tvId, apiKey, season, language)).episodes;
}

module.exports = {
  TMDB_BASE,
  TMDB_IMG,
  searchTmdbTv,
  searchTmdbMovie,
  getTmdbShow,
  getTmdbShowNameTh,
  getTmdbMovieDetail,
  getTmdbMovieNameTh,
  getTmdbSeason,
  getTmdbSeasonBilingual,
  getTmdbEpisodes,
};
