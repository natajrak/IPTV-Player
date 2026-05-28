#!/usr/bin/env node
/**
 * fetch-037hdd.js
 * สร้าง / อัปเดต playlist JSON จาก 037hddmovie.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าหนัง/series บน 037hddmovie.com
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N         ระบุ season/ภาค (default: 1)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY     TMDB API key (อ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --tmdb-season=N    TMDB season override
 *   --ep-offset=N      source ep → TMDB ep offset
 *   --type=KIND        anime-series | anime-movie | movie | series (default: movie)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie : page → iframe leoplayer7.com/watch?v={id} → API → hash → m3u8
 *   Series: series iframe → movieList JS object → episode hashes
 *           fallback: episode pages → leoplayer → API → hash
 *
 * ─── Stream URL ──────────────────────────────────────────────────────────
 *   https://master.streamhls.com/hls/{hash}/master   (ผ่าน CF Worker)
 */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
const { parseArgs } = require('./lib/cli');
const { makePaths } = require('./lib/type-config');
const utils = require('./lib/utils');
const tmdb = require('./lib/tmdb');
const io = require('./lib/playlist-io');
const { runUpdateMeta } = require('./lib/update-meta');

loadEnv(__dirname);

// 037hdd default track override: th (พากย์ไทย)
const cli = parseArgs();
let { seriesUrl: pageUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackArg, seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-037hdd.js <url> [--track=th|subth] [--type=movie|series] [--output=FILE]');
  console.error('       node fetch-037hdd.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname, defaultType: 'movie' });

const STREAM_REFERER = 'https://www.037hddmovie.com/';
const CF_WORKER = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ───── Source-specific helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { ...HEADERS, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Extract leoplayer7 video IDs from page. */
function extractLeoPlayerIds($) {
  const ids = [];
  $('iframe').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (src.includes('leoplayer')) {
      const m = src.match(/[?&]v=([^&]+)/);
      if (m) ids.push(m[1]);
    }
  });
  return ids;
}

/** Call leoplayer7 API to get stream hash. */
async function getStreamHash(leoId) {
  const apiUrl = `https://www.leoplayer7.com/api/analogy/mediahls3/${leoId}`;
  try {
    const resp = await fetchJson(apiUrl);
    const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
    const sourceUrl = data?.source?.url || '';
    if (!sourceUrl) {
      const altApis = [
        `https://www.leoplayer7.com/api/analogy/mediahls4/${leoId}`,
        `https://www.leoplayer7.com/api/analogy/mediahls2/${leoId}`,
        `https://www.leoplayer7.com/api/analogy/mediahls/${leoId}`,
      ];
      for (const altUrl of altApis) {
        try {
          const altResp = await fetchJson(altUrl);
          const altData = typeof altResp.data === 'string' ? JSON.parse(altResp.data) : altResp.data;
          const altSourceUrl = altData?.source?.url || '';
          if (altSourceUrl) {
            console.log(`\n    🔄 พบ hash จาก ${altUrl.split('/api/')[1]}`);
            const am = altSourceUrl.match(/\/p2p\/([a-f0-9]+)/i) || altSourceUrl.match(/\/([a-f0-9]{32})/);
            if (am) return am[1];
          }
        } catch {}
      }
      return null;
    }
    const m = sourceUrl.match(/\/p2p\/([a-f0-9]+)/i) || sourceUrl.match(/\/([a-f0-9]{32})/);
    return m ? m[1] : null;
  } catch (err) {
    console.warn(`  ⚠️ API error for ID ${leoId}: ${err.message}`);
    return null;
  }
}

/** Build m3u8 stream URL from hash, wrapped through CF Worker proxy */
function buildStreamUrl(hash) {
  const raw = `https://master.streamhls.com/hls/${hash}/master`;
  return `${CF_WORKER}?url=${encodeURIComponent(raw)}&referer=${encodeURIComponent('https://www.leoplayer7.com/')}`;
}

function extractTitle($) {
  let title = $('h1').first().text().trim()
    || $('.entry-title').first().text().trim()
    || $('title').text().split('-')[0].trim();
  title = title.replace(/\s*[-|]?\s*(ดูหนัง|037HDD).*$/i, '').trim();
  title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  title = title.replace(/\s*(พากย์ไทย|ซับไทย|บรรยายไทย|เต็มเรื่อง|HD|มาสเตอร์)\s*/g, ' ').trim();
  return title;
}

function extractPoster($) {
  return $('.poster img, .sheader img, .movie-poster img, .wp-post-image, .entry-content img').first().attr('src') || '';
}

/** Parse movie page → tracks with stream URLs */
async function parseMoviePage(url) {
  console.log(`\n📄 กำลัง fetch: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = extractTitle($);
  const poster = extractPoster($);
  const leoIds = extractLeoPlayerIds($);
  if (leoIds.length === 0) throw new Error('ไม่พบ leoplayer iframe ในหน้านี้ — ตรวจสอบ URL อีกครั้ง');

  console.log(`  ✅ title: ${title}`);
  console.log(`  ✅ leoplayer IDs: ${leoIds.join(', ')}`);

  const tracks = [];
  const trackLabels = leoIds.length === 1 ? [trackName] : ['พากย์ไทย', 'ซับไทย'];
  for (let i = 0; i < leoIds.length; i++) {
    const label = trackLabels[i] || `Track ${i + 1}`;
    process.stdout.write(`  🔗 ${label} (ID: ${leoIds[i]})...`);
    const hash = await getStreamHash(leoIds[i]);
    if (hash) {
      if (tracks.some((t) => t.hash === hash)) {
        console.log(` ⚠️ hash ซ้ำกับ "${tracks.find((t) => t.hash === hash).name}" → ข้าม`);
      } else {
        tracks.push({ name: label, streamUrl: buildStreamUrl(hash), hash });
        console.log(` ✅ ${hash}`);
      }
    } else {
      console.log(' ⚠️ ไม่พบ hash');
    }
    if (i < leoIds.length - 1) await utils.sleep(300);
  }
  return { title, poster, tracks };
}

/** Parse series listing page → episode link list */
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch series: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = extractTitle($);
  const poster = extractPoster($);
  const baseHost = new URL(url).origin;
  const episodeLinks = [];

  $('a[href*="/episode/"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && !episodeLinks.find((e) => e.url === href)) {
      const fullUrl = href.startsWith('http') ? href : baseHost + href;
      episodeLinks.push({ url: fullUrl, text });
    }
  });

  if (episodeLinks.length === 0) {
    $('a').each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (href && /ตอนที่\s*\d/.test(text) && !episodeLinks.find((e) => e.url === href)) {
        const fullUrl = href.startsWith('http') ? href : baseHost + href;
        episodeLinks.push({ url: fullUrl, text });
      }
    });
  }

  episodeLinks.sort((a, b) => {
    const na = parseInt(a.text.match(/\d+/)?.[0]) || 0;
    const nb = parseInt(b.text.match(/\d+/)?.[0]) || 0;
    return na - nb;
  });

  console.log(`  📺 title: ${title}`);
  console.log(`  📺 พบ ${episodeLinks.length} ตอน`);
  return { title, poster, episodeLinks };
}

async function parseEpisodePage(url, trackIndex = 0) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const leoIds = extractLeoPlayerIds($);
  return leoIds[trackIndex] || leoIds[0] || null;
}

function extractSeriesIframeSrc($) {
  let src = '';
  $('iframe').each((_, el) => {
    const s = $(el).attr('src') || '';
    if (s.includes('series037') || s.includes('steamseries')) {
      src = s;
      return false;
    }
  });
  return src;
}

/** Parse `movieList` JS variable from series player iframe HTML. */
function parseMovieList(html) {
  const marker = html.indexOf('let movieList');
  if (marker < 0) return null;
  const braceStart = html.indexOf('{', marker);
  if (braceStart < 0) return null;
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
  }
  if (braceEnd < 0) return null;
  let raw = html.substring(braceStart, braceEnd + 1).replace(/,\s*([\]}])/g, '$1');
  try { return JSON.parse(raw); }
  catch {
    try { return new Function('return ' + raw)(); }
    catch (e2) { console.warn('⚠️  ไม่สามารถ parse movieList ได้:', e2.message); return null; }
  }
}

function extractSeasonEpisodes(movieListData, targetSeasonNum, soundKey) {
  const seasonList = movieListData.seasonList || {};
  let targetSeasonId = null;
  for (const [sid, sdata] of Object.entries(seasonList)) {
    const m = (sdata.name || '').match(/Season\s*(\d+)/i);
    if (m && parseInt(m[1]) === targetSeasonNum) { targetSeasonId = sid; break; }
  }
  const keys = Object.keys(seasonList);
  if (!targetSeasonId && keys.length === 1) targetSeasonId = keys[0];

  if (!targetSeasonId) {
    const available = Object.values(seasonList).map((s) => s.name).join(', ');
    throw new Error(`ไม่พบ Season ${targetSeasonNum} ใน movieList (มี: ${available})`);
  }

  const seasonData = seasonList[targetSeasonId];
  const epList = seasonData.epList || {};
  const episodes = [];

  const firstEp = Object.values(epList)[0];
  if (firstEp?.link) {
    const availableKeys = Object.keys(firstEp.link);
    console.log(`    🔍 sound keys ใน episode 1: ${availableKeys.join(', ')}`);
  }

  for (const [, epData] of Object.entries(epList)) {
    const links = (epData.link && epData.link[soundKey]) || [];
    const p2pLink = links.find((l) => l.MU_group === 'P2P') || links[0];
    if (!p2pLink) continue;

    let hash = null;
    const hexMatch = p2pLink.MU_url.match(/\/([a-f0-9]{32})/i);
    if (hexMatch) hash = hexMatch[1].toLowerCase();
    else {
      const uuidMatch = p2pLink.MU_url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (uuidMatch) hash = uuidMatch[1].replace(/-/g, '').toLowerCase();
    }
    if (!hash) continue;

    episodes.push({
      name: epData.name || `Episode ${episodes.length + 1}`,
      hash,
      streamUrl: buildStreamUrl(hash),
    });
  }
  return { seasonId: targetSeasonId, episodes };
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    await runUpdateMeta({
      playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
      isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    if (isMovie) {
      // ── Movie flow ──
      const { title, poster, tracks } = await parseMoviePage(pageUrl);
      if (tracks.length === 0) { console.error('❌ ไม่พบ stream URL ใดเลย'); process.exit(1); }

      let seriesTitle = title;
      let posterUrl = poster;
      let tmdbShow = null;

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || title;
          const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : poster;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก 037hdd แทน');
        }
      }

      const partSeason = seasonNum || 1;
      const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').trim());
      const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
      const partFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const partPath = path.resolve(PLAYLIST_DIR, partFile);

      const tracksToAdd = trackArg ? tracks.filter((t) => t.name === trackName) : tracks;

      // Build part file manually (multi-track) — buildPartFile in lib supports single track only
      let partPlaylist;
      if (fs.existsSync(partPath)) {
        try { partPlaylist = JSON.parse(fs.readFileSync(partPath, 'utf-8')); }
        catch { partPlaylist = null; }
      }
      const partName = `ภาค ${partSeason}`;
      if (!partPlaylist) partPlaylist = { name: partName, image: posterUrl, stations: [] };
      partPlaylist.name = partName;
      partPlaylist.image = posterUrl;
      for (const t of tracksToAdd) {
        partPlaylist.stations = (partPlaylist.stations || []).filter((s) => s.name !== t.name);
        partPlaylist.stations.push({
          name: t.name,
          image: posterUrl,
          url: t.streamUrl,
          referer: pageUrl,
          release_date: tmdbShow?.release_date || '',
        });
      }
      partPlaylist.stations.sort((a, b) => {
        if (a.name === 'พากย์ไทย') return -1;
        if (b.name === 'พากย์ไทย') return 1;
        return 0;
      });
      io.stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(partPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึก part file: ${partPath}`);

      const mainFile = mainSlugArg
        ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`)
        : slugFile;
      const mainPath = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl = `${GITHUB_RAW_BASE}${partFile}`;
      const mainPlaylist = io.upsertMainFile({
        mainPath, franchiseName: seriesTitle, franchisePoster: posterUrl,
        partTitle: seriesTitle, partPoster: posterUrl,
        partFileRawUrl: partRawUrl, season: partSeason,
      });
      io.stampPlaylist(mainPlaylist, tmdbShow, true);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), 'utf-8');
      console.log(`📁 บันทึก main file: ${mainPath}`);

      io.updateIndex({
        indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
        seriesTitle, posterUrl, filename: mainFile, upsert: true,
        releaseDate: mainPlaylist.release_date || '',
        updatedAt: mainPlaylist.updated_at,
        seasonCount: null, completion: null,
      });

      console.log('\n🎉 เสร็จสิ้น!');
      console.log(`   Part: ${partFile}`);
      console.log(`   Main: ${mainFile}`);
    } else {
      // ── Series flow ──
      const { title, poster, episodeLinks } = await parseSeriesPage(pageUrl);

      let stations = [];
      let usedMovieList = false;

      console.log('\n🔗 กำลังหา series iframe...');
      const mainHtml = await fetchHtml(pageUrl);
      const $main = cheerio.load(mainHtml);
      let seriesIframe = extractSeriesIframeSrc($main);

      if (!seriesIframe && episodeLinks.length > 0) {
        console.log('  ℹ️ ไม่พบ series iframe ในหน้าหลัก — ลองหน้า episode 1...');
        const ep1Html = await fetchHtml(episodeLinks[0].url);
        const $ep1 = cheerio.load(ep1Html);
        seriesIframe = extractSeriesIframeSrc($ep1);
      }

      // Pre-fetch TMDB stuff so we can stamp release dates while building stations
      let seriesTitle = title;
      let posterUrl = poster;
      let seasonPosterUrl = poster;
      let tmdbEpisodes = [];
      let tmdbSeasonName = null;
      let tmdbShow = null;
      let seasonAirDate = '';

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n📺 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n📺 กำลัง search TMDB (TV)...');
          tmdbResult = await tmdb.searchTmdbTv(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || title;
          const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : poster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบ: "${seriesTitle}" (ID: ${tmdbResult.id})`);

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum) console.log(`📌 ใช้ TMDB Season ${tmdbSeasonNum} (override)`);
          if (epOffset) console.log(`📌 EP Offset: +${epOffset}`);

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก 037hdd แทน');
        }
      }

      if (seriesIframe) {
        try {
          console.log(`  📺 พบ series iframe: ${seriesIframe.split('?')[0]}...`);
          const iframeHtml = await fetchHtml(seriesIframe);
          const movieListData = parseMovieList(iframeHtml);
          if (movieListData) {
            const targetSeasonNum = seasonNum || 1;
            const soundKey = isDubbedTrack ? 'thai' : 'sub';
            const availableSeasons = Object.values(movieListData.seasonList || {}).map((s) => s.name).join(', ');
            console.log(`  📋 movieList พบ seasons: ${availableSeasons}`);

            let seasonResult = extractSeasonEpisodes(movieListData, targetSeasonNum, soundKey);
            let episodes = seasonResult.episodes;
            console.log(`  ✅ Season ${targetSeasonNum}: ${episodes.length} ตอน (${soundKey})`);

            if (episodes.length === 0) {
              const altKey = soundKey === 'thai' ? 'sub' : 'thai';
              console.log(`  ⚠️ ไม่พบ "${soundKey}" — ลอง "${altKey}"...`);
              const altResult = extractSeasonEpisodes(movieListData, targetSeasonNum, altKey);
              if (altResult.episodes.length > 0) {
                episodes = altResult.episodes;
                console.log(`  ✅ พบ ${episodes.length} ตอน ใน "${altKey}"`);
              }
            }

            if (episodes.length > 0) {
              usedMovieList = true;
              for (let i = 0; i < episodes.length; i++) {
                const epNum = i + 1 + epOffset;
                const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i + epOffset];
                const epTitle = tmdbEp?.name || '';
                const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
                stations.push({
                  name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
                  ...(epThumb && { image: epThumb }),
                  url: episodes[i].streamUrl,
                  referer: STREAM_REFERER,
                  release_date: tmdbEp?.air_date || '',
                });
                console.log(`  ตอน ${epNum}: ${episodes[i].hash.substring(0, 12)}...`);
              }
            }
          }
        } catch (err) {
          console.log(`  ⚠️ movieList approach failed: ${err.message}`);
        }
      }

      if (!usedMovieList && episodeLinks.length > 0) {
        console.log(`\n🔗 ใช้วิธี fetch ทีละตอน (${episodeLinks.length} ตอน, ${trackName})...`);
        const trackIndex = isDubbedTrack ? 0 : 1;
        for (let i = 0; i < episodeLinks.length; i++) {
          const ep = episodeLinks[i];
          const epNum = i + 1 + epOffset;
          process.stdout.write(`  ตอน ${epNum}/${episodeLinks.length + epOffset}...`);
          let streamUrl = '';
          try {
            const leoId = await parseEpisodePage(ep.url, trackIndex);
            if (leoId) {
              const hash = await getStreamHash(leoId);
              if (hash) { streamUrl = buildStreamUrl(hash); console.log(` ✅ ${hash.substring(0, 12)}...`); }
              else console.log(' ⚠️ ไม่พบ hash');
            } else console.log(' ⚠️ ไม่พบ leoplayer ID');
          } catch (err) { console.log(` ⚠️ ${err.message}`); }

          const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i + epOffset];
          const epTitle = tmdbEp?.name || '';
          const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
          stations.push({
            name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
            ...(epThumb && { image: epThumb }),
            url: streamUrl,
            referer: STREAM_REFERER,
            release_date: tmdbEp?.air_date || '',
          });
          if (i < episodeLinks.length - 1) await utils.sleep(500);
        }
      }

      if (stations.length === 0) {
        console.error('❌ ไม่พบ episode ใดเลย — ไม่พบ series iframe หรือ episode links');
        process.exit(1);
      }

      const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').trim());
      const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
      const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: pageUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const targetSeasonName = seasonName || 'Season 1';
        const affectedSeason = (playlist.groups || []).find((g) => g.name === targetSeasonName);
        if (affectedSeason) affectedSeason.release_date = seasonAirDate;
      }
      io.stampPlaylist(playlist, tmdbShow, false);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      io.updateIndex({
        indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
        seriesTitle, posterUrl, filename: outputFile, upsert: true,
        releaseDate: playlist.release_date || '',
        updatedAt: playlist.updated_at,
        seasonCount: playlist.season_count ?? null,
        completion: playlist.completion ?? null,
      });
      console.log('\n🎉 เสร็จสิ้น!');
      console.log(`   ไฟล์: ${outputFile}`);
      console.log(`   จำนวนตอน: ${stations.length}`);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
