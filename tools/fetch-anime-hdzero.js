#!/usr/bin/env node
/**
 * fetch-anime-hdzero.js
 * สร้าง / อัปเดต playlist JSON จาก animehdzeroo.net พร้อม metadata จาก TMDB
 * Stream ผ่าน Cloudflare Worker proxy (CORS bypass)
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน animehdzeroo.net
 *                      เช่น https://animehdzeroo.net/anime/6787
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY    TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --no-touch        skip current-time stamping (deterministic rollup จาก children)
 *   --type=KIND       anime-series | anime-movie | movie | series
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Domain: animehdzeroo.net (migrated from anime-hd-zero.com → anime-hdzero.com)
 *   - เว็บเลิกใช้ Inertia SPA แล้ว ตอนนี้เป็น Laravel Blade แบบ server-rendered
 *     จึง parse จาก HTML ตรงๆ ไม่ต้องยิง X-Inertia อีก:
 *       · ชื่อเรื่อง/โปสเตอร์ ← JSON-LD `TVSeries` (fallback: og:title / og:image)
 *       · รายการตอน         ← <a class="ep-row"> (เรียงตามเลข "ตอนที่ N")
 *       · player URL        ← JSON-LD `VideoObject`.embedUrl
 *   - embedUrl = https://app.akuma-stream.com/watch/{uuid} (signed/expiring)
 *     backend สตรีมไม่เปลี่ยนจากเดิม resolver ฝั่ง worker จึงใช้ตัวเดิมได้
 *   - Stations carry the player_url + `resolver: 'anime-hdzero'` → Player resolves
 *     fresh m3u8 at play time via /resolve/anime-hdzero on the CF worker
 *   - Default --track = th (พากย์ไทย)
 *   - Shared logic อยู่ใน tools/lib/ (env, utils, tmdb, playlist-io, update-meta)
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { loadEnv } = require('./lib/env');
const { parseArgs } = require('./lib/cli');
const { makePaths } = require('./lib/type-config');
const utils = require('./lib/utils');
const tmdb = require('./lib/tmdb');
const io = require('./lib/playlist-io');
const { runUpdateMeta } = require('./lib/update-meta');

loadEnv(__dirname);

// anime-hdzero default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;

// Override default: anime-hdzero defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime-hdzero.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anime-hdzero.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

// anime-hd-zero.com → animehdzeroo.net migration + Inertia SPA → Blade (server-rendered).
// Stream URLs are signed/expiring — playlist stores the player page URL + resolver flag,
// Player resolves via /resolve/anime-hdzero on the CF worker at play time.
const SITE_BASE = 'https://animehdzeroo.net';
const REFERER = `${SITE_BASE}/`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': REFERER,
};

// ───── Source-specific: fetch HTML ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** ดึง JSON-LD block แรกที่ @type ตรงกับที่ระบุ (ข้าม block ที่ parse ไม่ผ่าน) */
function extractJsonLd($, type) {
  const nodes = $('script[type="application/ld+json"]').toArray();
  for (const el of nodes) {
    const raw = $(el).contents().text().trim();
    if (!raw) continue;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const item of Array.isArray(data) ? data : [data]) {
      if (item && item['@type'] === type) return item;
    }
  }
  return null;
}

// ───── Source-specific: Parse anime page (Blade HTML + JSON-LD) ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);

  const $ = cheerio.load(await fetchHtml(url));

  const ld = extractJsonLd($, 'TVSeries');
  const title = ld?.name || $('meta[property="og:title"]').attr('content') || '';
  const posterImg = ld?.image || $('meta[property="og:image"]').attr('content') || '';

  // a.ep-row = แถวรายการตอน (ปุ่ม "ดูตอนนี้" ด้านบนเป็น .btn จึงไม่ติดมา)
  const seen = new Set();
  const episodes = [];
  $('a.ep-row').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/anime\/\d+\/episode\/(\d+)/);
    if (!m) return;
    const listId = Number(m[1]);
    if (seen.has(listId)) return;
    seen.add(listId);

    const epTitle = $(el).find('span').last().text().trim();
    const numMatch = epTitle.match(/ตอนที่\s*(\d+(?:\.\d+)?)/);
    episodes.push({
      url: new URL(href, SITE_BASE).href,
      epTitle,
      listId,
      epNo: numMatch ? Number(numMatch[1]) : null,
    });
  });

  // list_id ออกเป็นชุดๆ ตามรอบอัปโหลด ไม่ได้ไล่ต่อกัน → เรียงตามเลข "ตอนที่ N" ก่อน
  // ถ้ามีตอนไหน parse เลขไม่ได้ (เช่นหน้าหนัง/ตอนพิเศษ) ค่อย fallback เป็น list_id
  const allNumbered = episodes.length > 0 && episodes.every((ep) => ep.epNo !== null);
  episodes.sort((a, b) => (allNumbered ? a.epNo - b.epNo : a.listId - b.listId));

  if (!title) throw new Error(`ไม่พบชื่อเรื่องใน ${url} — โครงสร้างหน้าอาจเปลี่ยนอีก`);

  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน${allNumbered ? '' : ' (เรียงตาม list_id)'}`);
  return { title, posterImg, episodes };
}

// ───── Source-specific: Get player URL from episode page ─────
// Returns the akuma-stream watch URL — Player calls /resolve/anime-hdzero at play time to
// extract the (signed, expiring) m3u8 from that page.
async function getEpisodePlayerUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const $ = cheerio.load(html);

  const ld = extractJsonLd($, 'VideoObject');
  let playerUrl = ld?.embedUrl || '';

  if (!playerUrl) {
    const iframeSrc = $('iframe[src*="akuma-stream"]').attr('src') || '';
    playerUrl = iframeSrc;
  }
  if (!playerUrl) {
    const m = html.match(/https:\/\/app\.akuma-stream\.com\/watch\/[0-9a-fA-F-]+/);
    playerUrl = m ? m[0] : '';
  }
  if (!playerUrl) throw new Error(`ไม่พบ player URL ใน ${epPageUrl}`);
  return playerUrl;
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
    // Support comma-separated URLs for multi-part series
    const urls = seriesUrl.split(',').map((u) => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    let rawTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const offset = episodes.length;
      for (const ep of result.episodes) {
        // Tag each episode with its offset for proper numbering later
        ep._partOffset = offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    // Multi-URL: offset already handled via _partOffset, reset epOffset
    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง');
      process.exit(1);
    }

    // TMDB lookup
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
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl = tmdbPoster;
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-hdzero แทน');
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
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl = tmdbPoster;
          seasonPosterUrl = tmdbPoster;

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum && tmdbSeasonNum !== (seasonNum || 1)) {
            console.log(`📌 TMDB Season override: playlist Season ${seasonNum || 1} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) {
            console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);
          }

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
          console.log(`✅ poster: show-level=${posterUrl !== rawPoster} season-specific=${seasonPosterUrl !== posterUrl}`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-hdzero แทน');
        }
      }
    }

    // Fetch UUID + build stream URL สำหรับทุก episode
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let playerUrl = null;
      try {
        playerUrl = await getEpisodePlayerUrl(ep.url);
        process.stdout.write(` ${playerUrl}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path
        ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}`
        : '';
      const stationName = utils.buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: playerUrl || ep.url,
        // Player resolves the signed m3u8 at play time via the anime-hdzero resolver.
        ...(playerUrl && { resolver: 'anime-hdzero' }),
        referer: REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      console.log(' ✅');
      if (i < episodes.length - 1) await utils.sleep(800);
    }

    // Build / merge playlist
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
        resolver: s.resolver || null,
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
        partCount: mainPlaylist.part_count ?? null,
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
