#!/usr/bin/env node
/**
 * fetch-animeyour.js
 * สร้าง / อัปเดต playlist JSON จาก animeyour.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้ารายการบน animeyour.com (จำเป็น ยกเว้นใช้ --update-meta)
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th — animeyour ส่วนใหญ่พากย์ไทย)
 *   --season=N        ระบุ season ที่จะ fetch (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ
 *   --update-meta[=poster|cover|title]   อัปเดต metadata อย่างเดียว
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - animeyour อยู่หลัง Sucuri WAF — ต้องใช้ cookies จาก browser session ที่ผ่าน captcha แล้ว
 *   - ตั้งค่า ANIMEYOUR_COOKIES ใน tools/.env (= cookie header string จาก browser)
 *   - iframe pattern: <iframe src="https://moji.team-indy.net/embed/{HASH}/">
 *   - Stream URL: https://moji.abcdxzy.xyz:8443/vod/{HASH}/video.mp4/playlist.m3u8
 *   - CDN รองรับ CORS — ไม่ต้องใช้ CF Worker proxy
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

// animeyour default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;
const epOffsetArg = cli.get('--ep-offset');

let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-animeyour.js <url> [--track=th|subth] [--season=N] [--output=FILE] [--tmdb-id=N]');
  console.error('       node fetch-animeyour.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const REFERER = 'https://animeyour.com/';
const STREAM_HOST = 'moji.abcdxzy.xyz:8443';
const COOKIES = process.env.ANIMEYOUR_COOKIES || '';

if (!COOKIES && !updateMeta) {
  console.error('❌ ต้องตั้งค่า ANIMEYOUR_COOKIES ใน tools/.env');
  console.error('   วิธีดึง cookies:');
  console.error('   1. เปิด animeyour.com ใน Chrome ที่ผ่าน captcha แล้ว');
  console.error('   2. F12 > Network > เลือก request ของหน้า > Copy as cURL');
  console.error('   3. extract ค่า -b "..." หรือ -H "cookie: ..." มาใส่ใน .env:');
  console.error('      ANIMEYOUR_COOKIES=_ga=...; AMP_MKTG_xxx=...; ...');
  process.exit(1);
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Referer': REFERER,
  'Cookie': COOKIES,
};

// ───── Source-specific: fetch HTML ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const isWaf = body.includes('403 - Forbidden') || body.includes('sgcaptcha');
    if (isWaf && res.status === 403) {
      throw new Error(`WAF block (HTTP ${res.status}) — cookies อาจหมดอายุ refresh ANIMEYOUR_COOKIES ใน .env`);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

// ───── Source-specific: parse anime list page → episode list ─────
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch หน้ารายการ: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('h1.ep-head-h2').first().text().trim()
    || $('h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content')
    || $('title').text().replace(/\s*[-|].*$/, '').trim();

  const posterImg = $('meta[property="og:image"]').attr('content')
    || $('.poster img, .thumb img').first().attr('src')
    || '';

  const seen = new Set();
  const episodes = [];

  // จำกัด selector ใน main ep list (<ul id="MVP"> มี <li id="N">) — กัน sidebar แนะนำ
  $("ul#MVP a.ep-a-link, ul#MVP a[href*='/ep/']").each((_, el) => {
    const $el = $(el);
    const epUrl = ($el.attr('href') || '').trim();
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);

    const titleAttr = $el.attr('title') || '';
    const liId = $el.closest('li').attr('id') || '';

    let slug = '';
    let sortKey = 9000;
    let epLabel = '';

    // 1) URL pattern: /ep/<slug>-ep-<N>/
    const decodedUrl = decodeURIComponent(epUrl);
    const urlMatch = decodedUrl.match(/-ep-(\d+)(?:[-/]|$)/i)
      || decodedUrl.match(/-(\d+)\/?$/);
    if (urlMatch) slug = urlMatch[1];

    // 2) <li id="N">
    if (!slug && /^\d+$/.test(liId)) slug = liId;

    // 3) title attribute: "...ตอนที่ N พากย์ไทย"
    if (!slug) {
      const titleMatch = titleAttr.match(/ตอนที่\s*(\d+)/);
      if (titleMatch) slug = titleMatch[1];
    }

    if (/^[\d.]+$/.test(slug)) {
      const num = parseFloat(slug);
      sortKey = num;
      epLabel = String(num);
    } else if (slug) {
      epLabel = slug;
    } else {
      epLabel = String(episodes.length + 1);
      sortKey = episodes.length + 1;
    }

    episodes.push({ url: epUrl, thumb: '', epTitle: titleAttr, sortKey, epLabel });
  });

  episodes.sort((a, b) => a.sortKey - b.sortKey);

  if (!episodes.length) throw new Error('ไม่พบ ep URL ในหน้านี้ — ตรวจสอบ URL หรือ cookies');
  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Source-specific: extract stream URL from episode page ─────
function buildStreamUrl(hash) {
  return `https://${STREAM_HOST}/vod/${hash}/video.mp4/playlist.m3u8`;
}

async function getStreamUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const $ = cheerio.load(html);

  const iframeSrc = $("iframe[src*='moji.team-indy.net/embed'], iframe[src*='team-indy.net/embed']")
    .first().attr('src') || '';
  const hashFromIframe = (iframeSrc.match(/\/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromIframe) return buildStreamUrl(hashFromIframe);

  // Fallback: data-id button (server switcher)
  const dataId = $('span[data-id*="moji.team-indy.net/embed"], span[data-id*="team-indy.net/embed"]')
    .first().attr('data-id') || '';
  const hashFromDataId = (dataId.match(/\/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromDataId) return buildStreamUrl(hashFromDataId);

  // Fallback: embedUrl in JSON-LD
  const ldJson = $('script[type="application/ld+json"]').map((_, el) => $(el).html()).get().join('\n');
  const hashFromLd = (ldJson.match(/embedUrl["\s:]+https?:\/\/[^"]*team-indy\.net\/embed\/([a-zA-Z0-9]+)/i) || [])[1];
  if (hashFromLd) return buildStreamUrl(hashFromLd);

  throw new Error(`ไม่พบ stream hash ใน ${epPageUrl}`);
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
        console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก animeyour แทน');
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
        process.stdout.write(` ${streamUrl.match(/\/vod\/([^/]+)/)?.[1] || '?'}`);
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
        : '';

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

    console.log('\n🎉 เสร็จสิ้น!');
    console.log(`   ไฟล์: ${outputFile}`);
    console.log(`   จำนวนตอน: ${stations.length}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();
