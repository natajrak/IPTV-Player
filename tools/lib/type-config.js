// Tab/type configuration + path resolution
const fs = require('fs');
const path = require('path');

const GITHUB_RAW_ROOT = 'https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/';

const TYPE_CONFIG = {
  'anime-series': { dir: '../playlist/anime/series', base: 'playlist/anime/series/', kind: 'series' },
  'anime-movie':  { dir: '../playlist/anime/movies', base: 'playlist/anime/movies/', kind: 'movie'  },
  'movie':        { dir: '../playlist/movies',       base: 'playlist/movies/',       kind: 'movie'  },
  'series':       { dir: '../playlist/series',       base: 'playlist/series/',       kind: 'series' },
  'av':           { dir: '../playlist/av',           base: 'playlist/av/',           kind: 'series' },
};

const BUILTIN_TYPES = Object.keys(TYPE_CONFIG);

function resolveTypeConfig(typeArg, scriptDir) {
  if (typeArg && !BUILTIN_TYPES.includes(typeArg)) {
    try {
      const customs = JSON.parse(fs.readFileSync(path.resolve(scriptDir, '../playlist/custom-tabs.json'), 'utf-8'));
      const custom = customs.find((c) => c.key === typeArg);
      if (custom) {
        return { ...TYPE_CONFIG, [typeArg]: { dir: `../${custom.dir}`, base: `${custom.dir}/`, kind: custom.kind } };
      }
    } catch {}
  }
  return TYPE_CONFIG;
}

// Returns { contentType, isMovie, playlistDir, indexPath, githubRawBase }
function makePaths({ typeArg, scriptDir, defaultType = 'anime-series' }) {
  const config = resolveTypeConfig(typeArg, scriptDir);
  const contentType = config[typeArg] ? typeArg : defaultType;
  const conf = config[contentType];
  const isMovie = (conf.kind || contentType) === 'movie' || contentType === 'anime-movie';
  const playlistDir = path.resolve(scriptDir, conf.dir);
  const indexPath = path.resolve(playlistDir, 'index.txt');
  const githubRawBase = `${GITHUB_RAW_ROOT}${conf.base}`;
  return { contentType, isMovie, playlistDir, indexPath, githubRawBase };
}

module.exports = {
  GITHUB_RAW_ROOT,
  TYPE_CONFIG,
  BUILTIN_TYPES,
  resolveTypeConfig,
  makePaths,
};
