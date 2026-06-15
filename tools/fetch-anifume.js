#!/usr/bin/env node
/**
 * fetch-anifume.js
 * สร้าง / อัปเดต playlist JSON จาก anifume.com พร้อม metadata จาก TMDB
 * Stream เป็น MP4 direct (rukoluo.com) — ไม่ต้องผ่าน proxy
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน anifume.com
 *                      เช่น https://anifume.com/41474
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/
 *   --tmdb-key=KEY    TMDB API key (อ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --no-touch        skip current-time stamping (deterministic rollup จาก children)
 *   --type=KIND       anime-series | anime-movie | movie | series | av
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - หน้า anime มีทั้ง sub/dub และอาจมีหลาย season ในที่หน้าเดียว
 *     URL pattern (suffix):
 *       /<id>/<slug>-NN          → S1, ep NN, ซับไทย     (single-season)
 *       /<id>/<slug>-th-NN       → S1, ep NN, พากย์ไทย   (single-season)
 *       /<id>/<slug>-S-NN        → S{S}, ep NN, ซับไทย   (multi-season — Fairy Tail)
 *       /<id>/<slug>-S-th-NN     → S{S}, ep NN, พากย์ไทย (multi-season — K-On)
 *   - Multi-season: ใช้ --season=N filter เพื่อดึงเฉพาะ season นั้น
 *   - EP numbering ใน station name = index ภายใน season (reset ที่ 1 ต่อ season)
 *   - Track detection: ดู text label "พากย์ไทย"/"ซับไทย" เป็นหลัก, URL `-th-` เป็น fallback
 *   - Episode page → iframe ของ JWPlayer → parse "file":"https://..." ตรงๆ
 *   - Stream มี time-based signature (m=HMAC, e=expiration) → URL หมดอายุภายในวัน
 *   - Hybrid resolver mode: เก็บ ep URL + `resolver: "anifume"` ใน station, ไม่เก็บ stream URL
 *     player จะเรียก worker `/resolve/anifume?url=<ep>` ตอนเล่น → ได้ fresh signature
 *     → ไม่ต้อง re-scrape เมื่อ URL signature หมดอายุ
 *   - ไม่มี Origin block, CORS friendly → ใช้ raw URL ใน playlist ได้เลย
 *   - Default --track = th (พากย์ไทย)
 *   - Shared logic อยู่ใน tools/lib/
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

const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;

// Override default: anifume defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anifume.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anifume.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE = 'https://anifume.com';
const REFERER   = 'https://anifume.com/';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer':         REFERER,
};

// ───── Source-specific: HTTP helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ───── Source-specific: Parse anime page → sections (track + season grouped) ─────
/**
 * Parse URL suffix → { isDub, season, epNum } | null
 *   - "Liar-Game-01"      → { isDub:false, season:1, epNum:1 }
 *   - "Liar-Game-th-01"   → { isDub:true,  season:1, epNum:1 }
 *   - "Fairy-Tail-1-01"   → { isDub:false, season:1, epNum:1 }
 *   - "Fairy-Tail-2-49"   → { isDub:false, season:2, epNum:49 }
 *   - "K-On-2-th-01"      → { isDub:true,  season:2, epNum:1 }
 *
 * Pattern: optional "-{season}" → optional "-th" → required "-{ep}"
 *   (season ก่อน th- เสมอ — confirmed จาก K-On + Fairy Tail)
 */
function parseUrlSuffix(href) {
  const m = href.match(/-(?:(\d+)-)?(th-)?(\d+)$/i);
  if (!m) return null;
  const season = m[1] ? parseInt(m[1]) : 1;
  const isDub  = !!m[2];
  const epNum  = parseInt(m[3]);
  if (!Number.isFinite(epNum)) return null;
  return { isDub, season, epNum };
}

/**
 * คืน { title, posterImg, sections: [{ track, season, name, episodes }] }
 *
 * แต่ละ section = 1 (track, season) combination — ทำให้ pickSection() เลือกได้ตรงตาม --season + --track
 */
async function parseAnimePage(url, wantSeason = null) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($('h1.post-title').first().text() || $('title').first().text() || '').trim();

  let posterImg = '';
  $('img').each((_, img) => {
    if (posterImg) return;
    const src = ($(img).attr('src') || '').trim();
    if (src && /\.(jpe?g|png|webp)/i.test(src) && !/favicon|logo|ads?\//i.test(src)) {
      posterImg = src;
    }
  });

  const idMatch = url.match(/\/(\d+)(?:\/?$)/);
  const animeId = idMatch ? idMatch[1] : null;

  // Group by (track, season)
  const buckets = new Map();  // key = "track:season" → episodes[]
  const seenUrls = new Set();

  $('a').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    const text = ($(a).text() || '').trim();
    if (!href || !text) return;
    if (animeId && !href.includes(`/${animeId}/`)) return;
    const cleanHref = href.replace(/\/$/, '');
    if (seenUrls.has(cleanHref)) return;

    const parsed = parseUrlSuffix(cleanHref);
    if (!parsed) return;
    seenUrls.add(cleanHref);

    // Track: text label "พากย์ไทย"/"ซับไทย" override URL `-th-` (text เชื่อถือกว่า เพราะ Fairy Tail URL ไม่มี `-th-`)
    let isDub = parsed.isDub;
    if (/พากย์/i.test(text)) isDub = true;
    else if (/ซับ/i.test(text)) isDub = false;

    const track = isDub ? 'th' : 'subth';
    const key = `${track}:${parsed.season}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({
      url: cleanHref,
      epNum: parsed.epNum,    // absolute (จาก URL)
      label: text,
      thumb: '',
    });
  });

  // Sort episodes within each bucket, then build sections array
  const sections = [];
  for (const [key, eps] of buckets) {
    eps.sort((a, b) => a.epNum - b.epNum);
    const [track, seasonStr] = key.split(':');
    const season = parseInt(seasonStr);
    sections.push({
      track,
      season,
      name: track === 'th' ? 'พากย์ไทย' : 'ซับไทย',
      episodes: eps,
    });
  }

  // Sort sections: dub-first (matches CMS convention), then by season asc
  sections.sort((a, b) => {
    if (a.track !== b.track) return a.track === 'th' ? -1 : 1;
    return a.season - b.season;
  });

  if (!sections.length) throw new Error('ไม่พบ episode link ในหน้านี้ — ตรวจสอบ URL อีกครั้ง');
  console.log(`✅ พบ: "${title}" — ${sections.length} section(s)`);
  sections.forEach((s) => console.log(`   • ${s.name} (${s.track}) S${s.season} — ${s.episodes.length} ตอน`));
  return { title, posterImg, sections };
}

/** เลือก section ที่ match (track, season); fallback ถ้ามี section เดียว */
function pickSection(sections, wantTrack, wantSeason = null) {
  // หา section ที่ match ทั้ง track + season
  let matched = sections.find((s) => s.track === wantTrack && (wantSeason == null || s.season === wantSeason));
  if (matched) return matched;
  // ถ้าระบุ season แต่ track ไม่ตรง → ลองหา season ใดก็ได้
  if (wantSeason != null) {
    const sameSeason = sections.find((s) => s.season === wantSeason);
    if (sameSeason) {
      console.warn(`⚠️  Season ${wantSeason} มีเฉพาะ track "${sameSeason.name}" (${sameSeason.track}) — ใช้ section นี้แทน`);
      return sameSeason;
    }
  }
  // Fallback: section เดียวเท่านั้น
  if (sections.length === 1) {
    const only = sections[0];
    console.warn(`⚠️  หน้านี้มี section เดียว (${only.name}, S${only.season}) แต่ขอ --track=${wantTrack}${wantSeason ? `, --season=${wantSeason}` : ''}`);
    console.warn(`    ใช้ section นี้แทน — ตรวจสอบว่า URL ถูกต้องสำหรับ track ที่ต้องการ`);
    return only;
  }
  return null;
}

// ───── Source-specific: Episode page → iframe → stream URL ─────
/**
 * ดึง stream MP4 URL จากหน้า episode:
 *   1. Fetch episode page → หา iframe ของ anifume.com/player
 *   2. Fetch iframe → parse `"file":"https://..."` จาก JWPlayer setup
 *   3. คืน MP4 URL ตรงๆ
 */
async function getStreamUrl(epPageUrl) {
  const epHtml = await fetchHtml(epPageUrl);
  // Iframe แรก (player/) เป็น primary; player2/ เป็น backup
  const iframeMatch = epHtml.match(/<iframe[^>]+src="(https?:\/\/[^"]*anifume\.com\/player[^"]*)"/i);
  if (!iframeMatch) throw new Error(`ไม่พบ iframe player ใน ${epPageUrl}`);
  const iframeUrl = iframeMatch[1];

  const playerHtml = await fetchHtml(iframeUrl, { Referer: epPageUrl });
  const fileMatch = playerHtml.match(/"file"\s*:\s*"([^"]+)"/);
  if (!fileMatch) throw new Error(`ไม่พบ "file" ใน iframe ${iframeUrl}`);
  return fileMatch[1].replace(/\\\//g, '/');
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    await runUpdateMeta({
      playlistDir: PLAYLIST_DIR,
      indexPath: INDEX_PATH,
      githubRawBase: GITHUB_RAW_BASE,
      isMovie,
      tmdbKey,
      customOutput,
      seasonName,
      filterTrack,
      updateMetaMode,
      forceTmdbId,
      noTouch,
    });
    return;
  }

  try {
    const urls = seriesUrl.split(',').map((u) => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    const wantTrack = cli.trackArg === 'subth' ? 'subth' : 'th';
    let rawTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const wantSeason = seasonNum != null ? seasonNum : null;
      const chosen = pickSection(result.sections, wantTrack, wantSeason);
      if (!chosen) {
        console.error(`❌ ไม่พบ section ที่ตรงกับ --track=${wantTrack}${wantSeason ? `, --season=${wantSeason}` : ''} ใน ${urls[ui]}`);
        console.error(`   มี: ${result.sections.map((s) => `${s.name}(${s.track}) S${s.season}`).join(', ')}`);
        process.exit(1);
      }
      console.log(`📌 ใช้ section: "${chosen.name}" (${chosen.track}) S${chosen.season} — ${chosen.episodes.length} ตอน`);

      const offset = episodes.length;
      for (const ep of chosen.episodes) {
        ep._partOffset = offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${chosen.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง');
      process.exit(1);
    }

    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      let tmdbResult;
      if (isMovie) {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || rawTitle;
          const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow    = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl   = tmdbPoster;
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anifume แทน');
        }
      } else {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || rawTitle;
          const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow        = tmdbResult;
          seriesTitle     = tmdbName;
          posterUrl       = tmdbPoster;
          seasonPosterUrl = tmdbPoster;

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum && tmdbSeasonNum !== (seasonNum || 1)) {
            console.log(`📌 TMDB Season override: playlist Season ${seasonNum || 1} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) {
            console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);
          }

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes    = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName  = biData.seasonName;
          seasonAirDate   = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anifume แทน');
        }
      }
    }

    // Hybrid resolver mode: เก็บ ep URL + resolver flag ใน playlist
    // (player จะเรียก worker resolver ตอนเล่นเพื่อได้ fresh signature)
    // ทำให้ไม่ต้อง re-scrape เมื่อ URL signature หมดอายุ (mp4?m=...&e=...)
    console.log(`\n🔗 สร้าง station entries (${episodes.length} ตอน) — resolver=anifume...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = i + 1;

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path
        ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}`
        : (ep.thumb || '');
      const stationName = utils.buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: ep.url,            // ep page URL — player resolve ตอนเล่น
        resolver: 'anifume',    // ระบุ resolver ที่ player ต้องเรียก
        referer: REFERER,
        release_date: tmdbEp?.air_date || '',
      });
    }
    console.log(`✅ สร้าง ${stations.length} stations (ep URLs)`);

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }

      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl,
        trackName, streamUrl: s.url, sourceUrl: seriesUrl,
      });
      io.stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      const mainFile = mainSlugArg
        ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`)
        : slugFile;
      const mainPath = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl = `${GITHUB_RAW_BASE}${outputFile}`;
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
    } else {
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: seriesUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const targetSeasonName = seasonName || 'Season 1';
        const affectedSeason = (playlist.groups || []).find((g) => utils.matchesSeasonName(g.name, targetSeasonName));
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
    }

    console.log('\n🎉 เสร็จสิ้น!');
    console.log(`   ไฟล์: ${outputFile}`);
    console.log(`   ${isMovie ? 'ประเภท: Movie' : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
