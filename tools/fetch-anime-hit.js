#!/usr/bin/env node
/**
 * fetch-anime-hit.js
 * สร้าง / อัปเดต playlist JSON จาก anime-hit.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้ารายการบน anime-hit.com (จำเป็น ยกเว้นใช้ --update-meta)
 *                      เช่น https://anime-hit.com/bartender-kami-no-glass-dubth/
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
 *   - หน้า list ใช้ <ul id="MVP"><li id="N" class="mvp"><a class="ep-a-link"
 *     href="/video/{slug}-ep-{N}-{suffix}/"> ... </li></ul>
 *   - 1 URL = 1 track (sub/dub มี URL แยกกัน เช่น "-dubth" vs "-thai")
 *   - หน้า episode มี <iframe data-src="https://hit.team-indy.net/embed/{HASH}/">
 *     (perfmatters-lazy → ใช้ data-src ไม่ใช่ src)
 *   - Stream URL: https://hls.animeindy.com:8443/vid/{HASH}/video.mp4/playlist.m3u8
 *     (ใช้ infrastructure เดียวกับ indy-anime — ไม่ต้อง proxy, CDN รองรับ CORS)
 *   - Shared logic อยู่ใน tools/lib/ (env, utils, tmdb, playlist-io, update-meta)
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

// anime-hit default track override: th (สอดคล้องกับ animeruka/anifume — ส่วนใหญ่เป็น dub)
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime-hit.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anime-hit.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const REFERER = 'https://anime-hit.com/';
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

// ───── Source-specific: parse series page → episode list ─────
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch หน้ารายการ: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('h1[itemprop="name"]').first().text().trim()
    || $('h1').first().text().trim()
    || $('title').text().replace(/\s*[-|].*$/, '').trim();

  // poster image — lazy-loaded (perfmatters) → use data-src or src
  const posterImg = $('.wp-post-image').attr('data-src')
    || $('.wp-post-image').attr('src')
    || $('article img').first().attr('data-src')
    || $('article img').first().attr('src')
    || '';

  const seen = new Set();
  const episodes = [];

  // Episode anchors: <ul id="MVP"><li id="{N}"><a class="ep-a-link" href="/video/...">
  $('ul#MVP li a.ep-a-link, a.ep-a-link').each((_, el) => {
    const $el = $(el);
    const epUrl = $el.attr('href');
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);

    const thumb = $el.find('img').attr('data-src') || $el.find('img').attr('src') || '';
    const epTitle = $el.attr('title') || $el.text().trim();
    const decodedUrl = decodeURIComponent(epUrl);

    // li id="{N}" — anime-hit's most reliable episode number
    const liId = $el.closest('li').attr('id') || '';

    let slug = '';
    let sortKey = 9000;
    let epLabel = '';

    // 1) Try /video/{slug}-ep-{N}(-suffix)? — match ep number after `-ep-`
    const urlMatch = decodedUrl.match(/-ep-(\d+(?:\.\d+)?|ova\d*|sp\d*)\b/i)
      || decodedUrl.match(/-ep-(\d+)$/i);
    if (urlMatch) slug = urlMatch[1];

    // 2) From <li id="N">
    if (!slug && /^\d+$/.test(liId)) slug = liId;

    // 3) From title text "ตอนที่ N"
    if (!slug) {
      const textNum = epTitle.match(/ตอนที่\s*([\d.]+)/i) || epTitle.match(/episode\s*(\d+)/i);
      if (textNum) slug = textNum[1];
    }

    // 4) Trailing number in URL
    if (!slug) {
      const trailingNum = decodedUrl.match(/[-–](\d+)\/?(?:\?.*)?$/);
      if (trailingNum) slug = trailingNum[1];
    }

    if (/^ova(\d*)/i.test(slug)) {
      const ovaNum = parseInt(slug.match(/\d+/)?.[0] || '1');
      sortKey = 9000 + ovaNum;
      epLabel = `OVA${ovaNum > 1 ? ' ' + ovaNum : ''}`;
    } else if (/^sp(\d*)/i.test(slug)) {
      const spNum = parseInt(slug.match(/\d+/)?.[0] || '1');
      sortKey = 9500 + spNum;
      epLabel = `SP${spNum > 1 ? ' ' + spNum : ''}`;
    } else if (/^[\d.]+$/.test(slug)) {
      const num = parseFloat(slug);
      if (Number.isInteger(num)) {
        sortKey = num;
        epLabel = String(num);
      } else {
        sortKey = num;
        epLabel = String(num);
      }
    } else if (slug) {
      epLabel = slug;
    } else {
      epLabel = String(episodes.length + 1);
      sortKey = episodes.length + 1;
    }

    episodes.push({ url: epUrl, thumb, epTitle, sortKey, epLabel });
  });

  episodes.sort((a, b) => a.sortKey - b.sortKey);
  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Source-specific: extract stream URL from episode page ─────
async function getStreamUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const $ = cheerio.load(html);

  // anime-hit ใช้ perfmatters-lazy → iframe มี data-src ไม่ใช่ src
  const iframeNode = $("iframe[data-src*='team-indy.net/embed'], iframe[src*='team-indy.net/embed'], iframe[data-src*='indy-anime.net/embed'], iframe[src*='indy-anime.net/embed']").first();
  const iframeSrc = iframeNode.attr('data-src') || iframeNode.attr('src') || '';
  const hashFromIframe = (iframeSrc.match(/\/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromIframe) return buildStreamUrl(hashFromIframe);

  const scriptContent = $('script:not([src])').map((_, el) => $(el).html()).get().join('\n');
  const hashFromScript = (scriptContent.match(/\/vid\/([a-zA-Z0-9]+)\/video\.mp4/i) || [])[1]
    || (scriptContent.match(/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromScript) return buildStreamUrl(hashFromScript);

  const directMatch = html.match(/https?:\/\/hls\.animeindy\.com[^"'\s]+playlist\.m3u8/i);
  if (directMatch) return directMatch[0];

  throw new Error(`ไม่พบ stream hash ใน ${epPageUrl}`);
}

function buildStreamUrl(hash) {
  return `https://hls.animeindy.com:8443/vid/${hash}/video.mp4/playlist.m3u8`;
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
    let rawTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseSeriesPage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const offset = episodes.length;
      for (const ep of result.episodes) {
        if (offset > 0) {
          const origNum = parseInt(ep.epLabel);
          if (!isNaN(origNum)) {
            ep.epLabel = String(origNum + offset);
            ep.sortKey = origNum + offset;
          }
        }
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.episodes.length} ตอน (รวม ${episodes.length})`);
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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-hit แทน');
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
          console.log(`✅ poster: show-level=${posterUrl !== rawPoster} season-specific=${seasonPosterUrl !== posterUrl}`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-hit แทน');
        }
      }
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epLabel = ep.epLabel || String(i + 1);
      const epNumInt = parseInt(epLabel);
      process.stdout.write(`  ตอน ${epLabel}/${episodes.length}...`);

      let streamUrl = null;
      try {
        streamUrl = await getStreamUrl(ep.url);
        process.stdout.write(`  URL: ${streamUrl}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEpNum = !isNaN(epNumInt) ? epNumInt + epOffset : NaN;
      const tmdbEp = !isNaN(tmdbEpNum)
        ? (tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset])
        : null;
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path
        ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}`
        : ep.thumb || '';

      const stationName = utils.buildStationName(epLabel, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      console.log(' ✅');
      if (i < episodes.length - 1) await utils.sleep(600);
    }

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
