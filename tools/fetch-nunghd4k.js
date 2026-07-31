#!/usr/bin/env node
/**
 * fetch-nunghd4k.js
 * สร้าง / อัปเดต playlist JSON จาก nunghd4k.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า nunghd4k.com (movie หรือ series)
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --split-eps=N,M:k  TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *                      ชื่อออกเป็น "ตอน N (1/2)" และตอนถัดไปเลขตาม TMDB ไม่ drift
 *                      (flag นี้ assume เว็บลิสต์ตอนของ season เรียงต่อเนื่องครบ)
 *   --auto-split       ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB — ใช้เมื่อจำนวนตอน
 *                      ลงตัวเป๊ะเท่านั้น (ถ้าใส่ --split-eps เองจะใช้ค่าที่ใส่)
 *   --type=KIND        anime-series|series|anime-movie|movie (default: auto-detect)
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie : page → iframe#player-url (เดิม #player-iframe) vid.php?...&id={movieId}
 *         → play.gan-play.com/embed/fast168.php?key=nunghd4k&id={movieId}
 *         → m3u8 ในหน้า embed (เดิม doo-play + var videoSrc = "{m3u8}")
 *   Series: page → select#primary-player-select option[0].value → api_player1.php URL
 *         → fetch → JSON [{url, episode}, ...]
 *         → gan-play/embed/?id={seriesId}&ep={N}&type=series
 *
 * ─── หมายเหตุการย้าย host ────────────────────────────────────────────────
 *   เว็บเปลี่ยน id ของ iframe (player-iframe → player-url) และย้าย embed
 *   จาก doo-play.com ไป play.gan-play.com (doo-play ยัง 200 แต่คืนหน้าเปล่า)
 *   ทั้งสองเส้นทางจึงลอง host ใหม่ก่อนแล้ว fallback ไปตัวเดิม
 *
 *   CDN เช็ค Referer ว่าต้องเป็น origin ของหน้า embed (play.gan-play.com)
 *   ไม่ใช่ nunghd4k.com — ใส่ referer ผิดจะดึง m3u8 ได้แต่เล่นไม่ออก
 *   ("ไม่สามารถใช้งานได้กรุณาติดต่อผู้ให้บริการ") จึงต้องห่อผ่าน CF Worker
 *
 *   เว็บนี้มีแต่หนัง ไม่มี series (หมวดซีรีส์ 404) — โค้ดเส้นทาง series
 *   เก็บไว้เผื่ออนาคตเท่านั้น ยังไม่เคยทดสอบกับของจริง
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
const { buildEpisodeMap, applyMeasuredSplit } = require('./lib/episode-map');

loadEnv(__dirname);

// nunghd4k default track override: th (พากย์ไทย)
const cli = parseArgs();
let { seriesUrl: pageUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, splitEps, autoSplit, typeArg, filterTrack } = cli;
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-nunghd4k.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-nunghd4k.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://www.nunghd4k.com';
const DOOPLAY_REFERER = 'https://www.nunghd4k.com/';
// CDN ปลายทางเช็ค Referer ว่าต้องเป็น origin ของ "หน้า embed" (เช่น play.gan-play.com)
// ไม่ใช่หน้าเว็บต้นทาง — และ browser ตั้ง header Referer เองไม่ได้ จึงต้องผ่าน CF Worker
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';
function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}
const SITE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': SITE_ORIGIN + '/',
};

// ───── Source-specific helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const pageTitle = $('title').text()
    .replace(/^ดู\s+/i, '')
    .replace(/\s*ฟรี.*$/i, '')
    .replace(/\s*พากย์ไทย.*$/i, '')
    .trim();

  // เว็บเปลี่ยน id จาก player-iframe → player-url — รับทั้งสองแบบ (และ iframe ที่ชี้ vid.php ตรงๆ)
  const iframeSrc =
    $('iframe#player-url').attr('src') ||
    $('iframe#player-iframe').attr('src') ||
    $('iframe[src*="vid.php"]').attr('src') ||
    '';
  const hasVidPhp = iframeSrc.includes('vid.php');
  const hasApiSelect = $('select#primary-player-select').length > 0;

  if (hasVidPhp) {
    const iUrl = iframeSrc.startsWith('http') ? iframeSrc : `${SITE_ORIGIN}${iframeSrc}`;
    const u = new URL(iUrl);
    const movieId = u.searchParams.get('id');
    if (!movieId) throw new Error('ไม่พบ movie ID ใน iframe src');
    console.log(`✅ พบ: Movie — ID: ${movieId}, ชื่อ: "${pageTitle}"`);
    return { isMoviePage: true, pageTitle, movieId };
  } else if (hasApiSelect) {
    const apiUrl = $('select#primary-player-select option').first().attr('value') || '';
    const idMatch = apiUrl.match(/[?&]id=([^&?\s]+)(?:[?&].*)?$/);
    const seriesId = idMatch ? idMatch[1].split('&')[0] : null;
    if (!seriesId) throw new Error('ไม่พบ series ID ใน api_player URL');

    const allText = $('title, h1').text();
    const epMatch = allText.match(/Ep\d+\s*[-–]\s*(\d+)/i);
    const totalEpisodes = epMatch ? parseInt(epMatch[1]) : 0;

    console.log(`✅ พบ: Series — ID: ${seriesId}, ตอน: ${totalEpisodes || '?'}, ชื่อ: "${pageTitle}"`);
    return { isMoviePage: false, pageTitle, seriesId, apiUrl, totalEpisodes };
  } else {
    throw new Error('ไม่สามารถตรวจจับประเภท (ไม่พบ #player-iframe หรือ #primary-player-select)');
  }
}

/** สกัด stream URL จากหน้า embed — รองรับทั้งรูปแบบเดิมและ m3u8 ที่ฝังตรงๆ */
function extractStreamFromEmbed(html) {
  const patterns = [
    /var\s+videoSrc\s*=\s*["']([^"']+)["']/,
    /sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

/** ลอง host ใหม่ (gan-play) ก่อน แล้ว fallback ไปตัวเดิม (doo-play) */
async function fetchEmbedStream(candidates) {
  for (const embedUrl of candidates) {
    try {
      const html = await fetchHtml(embedUrl, { Referer: DOOPLAY_REFERER });
      const url = extractStreamFromEmbed(html);
      // referer ที่ CDN ยอมรับคือ origin ของหน้า embed ที่ดึง stream มาได้ ไม่ใช่หน้าเว็บ
      if (url) return { url, referer: `${new URL(embedUrl).origin}/`, embedUrl };
    } catch (err) {
      console.warn(`  ⚠️  embed ล้มเหลว (${new URL(embedUrl).host}): ${err.message}`);
    }
  }
  return null;
}

async function getMovieStream(movieId) {
  const candidates = [
    `https://play.gan-play.com/embed/fast168.php?key=nunghd4k&id=${movieId}`,
    `https://doo-play.com/embed/fasthd.php?key=nunghd4k&id=${movieId}`,
  ];
  console.log(`\n🔗 กำลัง fetch embed: ${candidates[0]}`);
  const found = await fetchEmbedStream(candidates);
  if (!found) throw new Error('ไม่พบ stream URL ใน embed (ลองครบทุก host แล้ว)');
  console.log(`✅ พบ stream URL จาก ${new URL(found.embedUrl).host}`);
  return { url: found.url, referer: found.referer };
}

async function getSeriesStream(seriesId, epNum) {
  const found = await fetchEmbedStream([
    `https://play.gan-play.com/embed/?id=${seriesId}&ep=${epNum}&type=series`,
    `https://doo-play.com/embed/?id=${seriesId}&ep=${epNum}&type=series`,
  ]);
  if (!found) {
    throw new Error(`ไม่พบ stream URL ใน episode ${epNum} (seriesId: ${seriesId})`);
  }
  return { url: found.url, referer: found.referer };
}

async function fetchEpisodeList(apiUrl) {
  try {
    const data = await fetchJson(apiUrl, { Referer: DOOPLAY_REFERER });
    if (Array.isArray(data) && data.length > 0 && data[0].url) return data;
    if (data?.error) console.warn(`⚠️  api_player คืน error: ${data.error}`);
    return null;
  } catch (err) {
    console.warn(`⚠️  fetch api_player ล้มเหลว: ${err.message}`);
    return null;
  }
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    // Default to series for update-meta when no --type given
    const paths = makePaths({ typeArg, scriptDir: __dirname, defaultType: 'series' });
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    const pageInfo = await parsePage(pageUrl);

    // Determine type (auto-detect if --type not given)
    const detectedType = pageInfo.isMoviePage ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: detectedType });

    console.log(`📂 ประเภท: ${effectiveTypeArg}`);

    // TMDB lookup
    let seriesTitle = pageInfo.pageTitle;
    let posterUrl = '';
    let seasonPosterUrl = '';
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      if (isMovie) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || pageInfo.pageTitle;
          const thName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : '';
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน');
        }
      } else {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || pageInfo.pageTitle;
          const thName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : '';
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;

          const sNum = seasonNum || 1;
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน');
        }
      }
    }

    // Fetch stream URLs
    const stations = [];
    let resolvedSplitEps = splitEps;
    if (isMovie) {
      const stream = await getMovieStream(pageInfo.movieId);
      stations.push({
        name: trackName,
        image: posterUrl,
        url: proxyUrl(stream.url, stream.referer),
        referer: stream.referer,
        release_date: tmdbShow?.release_date || '',
      });
    } else {
      let episodeItems = await fetchEpisodeList(pageInfo.apiUrl);
      let episodeUrls = [];
      if (episodeItems && episodeItems.length > 0) {
        console.log(`✅ api_player คืน ${episodeItems.length} ตอน`);
        episodeUrls = episodeItems.map((item) => ({ ep: item.episode, url: item.url }));
      } else {
        const total = pageInfo.totalEpisodes;
        if (!total) { console.error('❌ ไม่พบจำนวนตอนทั้งหมด'); process.exit(1); }
        console.log(`⚠️  ใช้ fallback URL จาก ep range (1-${total})`);
        for (let n = 1; n <= total; n++) {
          episodeUrls.push({
            ep: n,
            url: `https://doo-play.com/embed/?id=${pageInfo.seriesId}&ep=${n}&type=series`,
          });
        }
      }

      console.log(`\n🔗 กำลัง fetch stream URLs (${episodeUrls.length} ตอน)...`);
      resolvedSplitEps = splitEps;
      const splitMap = resolvedSplitEps ? buildEpisodeMap({ sourceCount: episodeUrls.length, epOffset: 0, splitEps: resolvedSplitEps }) : null;
      for (let i = 0; i < episodeUrls.length; i++) {
        const { ep, url: epEmbedUrl } = episodeUrls[i];
        const mapped = splitMap ? splitMap[i] : null;
        const tmdbEpNum = mapped ? mapped.epNum : ep;
        const epLabel = mapped ? mapped.label : ep;
        process.stdout.write(`  ตอน ${ep}/${episodeUrls.length}...`);
        let stream = null;
        try {
          stream = await getSeriesStream(pageInfo.seriesId, ep);
          process.stdout.write(' ✅\n');
        } catch (err) {
          process.stdout.write(` ⚠️  ${err.message}\n`);
        }

        const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || (mapped ? tmdbEpisodes[tmdbEpNum - 1] : tmdbEpisodes[i]);
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
        stations.push({
          name: utils.buildStationName(epLabel, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: stream ? proxyUrl(stream.url, stream.referer) : epEmbedUrl,
          referer: stream?.referer || DOOPLAY_REFERER,
          release_date: tmdbEp?.air_date || '',
        });
        if (i < episodeUrls.length - 1) await utils.sleep(600);
      }
    }

    if (autoSplit && !splitEps && !isMovie) {
      resolvedSplitEps = await applyMeasuredSplit({ stations, tmdbEpisodes, epOffset: 0, isDubbedTrack });
    }

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }
      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl: s.url, sourceUrl: pageUrl,
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
        trackName, trackReferer: pageUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset: 0, splitEps: resolvedSplitEps,
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
