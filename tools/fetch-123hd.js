#!/usr/bin/env node
/**
 * fetch-123hd.js
 * สร้าง / อัปเดต playlist JSON จาก 123hd.net (movie และ series) พร้อม metadata จาก TMDB
 *
 * ─── โครงสร้างเว็บ ───────────────────────────────────────────────────────
 *   - WordPress theme "eco": หน้าเรื่องมี `var _ply = { post_id, is_movie, is_serie }`
 *   - series: <button class="season-select" data-id="{sid}"> + <div id="season-{sid}">
 *             <article episode-id="{id}"> ... <span class="ep-number">N</span>
 *   - POST /wp-admin/admin-ajax.php action=mix_get_player&post_id={episode-id | movie post_id}
 *     → { player: { data: { th-sound|soundtrack: [{ url: embed }] } } }
 *
 * ─── Embed → ลิงก์ถาวร ──────────────────────────────────────────────────
 *   - dumoviefree.com/player/index.php?data={hash} → MASPlayer config
 *     → https://dumoviefree.com{videoUrl}?s={videoServer}&d={btoa(videoDisk||", ")}&v=2
 *   - c-78.mvshd.com/#/embed/{uuid} → POST /api/play-token/{uuid} (JWT อายุ 2 ชม.)
 *     → playlist ที่มี token ชี้ไฟล์ย่อยบน https://cdn.mvshd.com/hls/ep-{id}/seg_NNN.ts
 *     → เก็บ https://cdn.mvshd.com/hls/ep-{id}/index.m3u8 ซึ่งไม่ต้องใช้ token
 *   ทั้งสองแบบเปิด CORS `*` → เล่นตรงได้ ไม่ต้องผ่าน proxy / ทุกลิงก์เช็คว่าได้ #EXTM3U ก่อนบันทึก
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าเรื่อง 123hd.net (movie หรือ series)
 *   --track=th|subth   th = พากย์ไทย (th-sound), subth = ซับไทย (soundtrack) (default: subth)
 *   --season=N         season ของเว็บที่ดึง + season ใน playlist (default: season แรกของหน้า)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --split-eps=N,M:k  TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *   --multi-season     รวมตอนทุก season ของหน้าเป็นลิสต์เดียว → แบ่งลง season ตาม TMDB
 *   --season-map=A,B   ระบุจำนวนตอนของแต่ละ season เอง (ใช้คู่กับการรวมทุก season)
 *   --auto-split       ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB
 *   --type=KIND        series|movie|anime-series|anime-movie (default: ตามหน้าเว็บ)
 *   --only-new         ใช้ stream URL เดิมของตอนที่มีในไฟล์อยู่แล้ว ดึงใหม่เฉพาะตอนใหม่ (series)
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
const { buildEpisodeMap, suggestSplitEps, applyMeasuredSplit } = require('./lib/episode-map');
const { prepareMultiSeason, episodeAt, writeMultiSeason } = require('./lib/season-map');
const { carryOverFetchedSkips } = require('./lib/skip-times');
const { createStreamReuse } = require('./lib/stream-reuse');

loadEnv(__dirname);

const cli = parseArgs();
const { seriesUrl: pageUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
        trackName, isDubbedTrack, seasonNum, seasonName,
        updateMeta, updateMetaMode, noTouch,
        forceTmdbId, splitEps, autoSplit,
        seasonMap, multiSeason, typeArg, filterTrack, onlyNew } = cli;

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-123hd.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-123hd.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://123hd.net';
const STATION_REFERER = `${SITE_ORIGIN}/`;
const TRACK_KEY = isDubbedTrack ? 'th-sound' : 'soundtrack';
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
};

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, Referer: STATION_REFERER, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Balanced-brace JSON extractor (MASPlayer config) */
function extractJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

// ───── หน้าเรื่อง ─────
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const plyMatch = html.match(/var _ply\s*=\s*(\{[\s\S]*?\});/);
  if (!plyMatch) throw new Error('ไม่พบ _ply ในหน้า — ไม่ใช่หน้าเรื่องของ 123hd.net');
  const ply = JSON.parse(plyMatch[1]);
  const rawTitle = ($('h1').first().text() || $('meta[property="og:title"]').attr('content') || '').trim();
  const rawPoster = ($('meta[property="og:image"]').attr('content') || '').trim();

  const seasons = [];
  $('.season-select').each((_, el) => {
    const $el = $(el);
    const id = ($el.attr('data-id') || '').trim();
    const label = $el.text().trim();
    const num = (label.match(/(?:ซีซั่น|season)\s*(\d+)/i) || [])[1];
    const episodes = [];
    $(`#season-${id} [episode-id]`).each((__, epEl) => {
      const $ep = $(epEl);
      const epId = ($ep.attr('episode-id') || '').trim();
      const epNum = parseInt($ep.find('.ep-number').first().text().trim(), 10);
      if (epId) episodes.push({ epId, epNum: Number.isFinite(epNum) ? epNum : episodes.length + 1 });
    });
    episodes.sort((a, b) => a.epNum - b.epNum);
    if (id) seasons.push({ id, label, seasonNum: num ? parseInt(num, 10) : seasons.length + 1, episodes });
  });

  const isMovie = ply.is_movie === '1';
  console.log(`✅ พบ: "${rawTitle}" — ${isMovie ? 'Movie' : `Series (${seasons.map((s) => `${s.label}: ${s.episodes.length} ตอน`).join(', ')})`}`);
  return { rawTitle, rawPoster, postId: String(ply.post_id), isMovie, seasons };
}

/** mix_get_player → embed URL ของ track ที่ต้องการ */
async function getEmbedUrl(postId) {
  const res = await fetch(`${SITE_ORIGIN}/wp-admin/admin-ajax.php`, {
    method: 'POST',
    headers: {
      ...BASE_HEADERS, Referer: STATION_REFERER, Origin: SITE_ORIGIN,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ action: 'mix_get_player', post_id: postId }).toString(),
  });
  if (!res.ok) throw new Error(`mix_get_player HTTP ${res.status} (post=${postId})`);
  const json = await res.json();
  const data = json?.player?.data;
  if (!json?.success || !data) throw new Error('ยังไม่มีวิดีโอ (mix_get_player ไม่มี data)');
  const url = data[TRACK_KEY]?.[0]?.url;
  if (!url) throw new Error(`ไม่มี ${trackName} (มี: ${Object.keys(data).join(', ') || '-'})`);
  return url;
}

// ───── Embed → ลิงก์ถาวร ─────
async function assertPlaylist(url, headers = {}) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, ...headers } });
  const text = res.ok ? await res.text() : '';
  if (!text.startsWith('#EXTM3U')) throw new Error(`playlist เปิดไม่ได้ (HTTP ${res.status}) ${url}`);
  return text;
}

async function resolveDumoviefree(embedUrl) {
  const embed = new URL(embedUrl);
  const html = await fetchText(embedUrl);
  const callMatch = html.match(/MASPlayer\s*\([^,]+,\s*/);
  if (!callMatch) throw new Error('dumoviefree: ไม่พบ MASPlayer');
  const cfg = JSON.parse(extractJsonObject(html, callMatch.index + callMatch[0].length) || 'null');
  if (!cfg?.videoUrl || !cfg?.videoServer) throw new Error('dumoviefree: ขาด videoUrl/videoServer');
  const dParam = Buffer.from(cfg.videoDisk ? String(cfg.videoDisk) : ', ', 'utf-8').toString('base64');
  const streamUrl = `${embed.origin}${cfg.videoUrl}?s=${cfg.videoServer}&d=${dParam}&v=2`;
  await assertPlaylist(streamUrl);
  return streamUrl;
}

async function resolveMvshd(embedUrl) {
  const embed = new URL(embedUrl);
  const uuid = (embed.hash.match(/embed\/([0-9a-f-]{36})/i) || [])[1];
  if (!uuid) throw new Error(`mvshd: ไม่พบ uuid ใน ${embedUrl}`);
  const tokenRes = await fetch(`${embed.origin}/api/play-token/${uuid}`, {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', 'x-embed-referrer': STATION_REFERER },
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  const streamPath = tokenData.streamUrl || tokenData.r2Url;
  if (!tokenRes.ok || !tokenData.token || !streamPath) throw new Error(`mvshd play-token: ${tokenData.error || tokenRes.status}`);

  const tokenized = await assertPlaylist(new URL(streamPath, embed.origin).href, {
    'x-playback-token': tokenData.token, Referer: `${embed.origin}/`, Origin: embed.origin,
    'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'empty',
  });
  const firstUri = tokenized.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  const segMatch = firstUri && firstUri.match(/^(https:\/\/[^?#]+\/hls\/[^/?#]+)\/[^/?#]+\.ts(?:[?#]|$)/);
  if (!segMatch) throw new Error(`mvshd: รูปแบบ playlist ไม่รองรับ (${(firstUri || '').slice(0, 80)})`);

  const streamUrl = `${segMatch[1]}/index.m3u8`;
  const permanent = await assertPlaylist(streamUrl);
  const segName = firstUri.split('/').pop().split('?')[0];
  if (!permanent.includes(segName)) throw new Error(`mvshd: ${streamUrl} ไม่ตรงกับ playlist ที่มี token`);
  return streamUrl;
}

async function resolveEmbed(embedUrl) {
  const host = new URL(embedUrl).hostname;
  if (host.endsWith('dumoviefree.com')) return resolveDumoviefree(embedUrl);
  if (host.endsWith('mvshd.com')) return resolveMvshd(embedUrl);
  throw new Error(`ตัวเล่นไม่รองรับ: ${host}`);
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    const paths = makePaths({ typeArg, scriptDir: __dirname, defaultType: 'series' });
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  const page = await parsePage(pageUrl);
  const detectedType = page.isMovie ? 'movie' : 'series';
  const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
    makePaths({ typeArg: typeArg || detectedType, scriptDir: __dirname, defaultType: detectedType });
  if (isMovie !== page.isMovie) throw new Error(`หน้านี้เป็น ${detectedType} แต่ระบุ --type=${typeArg}`);
  console.log(`📂 ประเภท: ${typeArg || detectedType} | track: ${trackName} (${TRACK_KEY})`);

  let sourceEps = [];
  let playlistSeasonNum = seasonNum || 1;
  if (!isMovie) {
    if (!page.seasons.length) throw new Error('ไม่พบ season ในหน้า');
    if (multiSeason || seasonMap) {
      sourceEps = page.seasons.flatMap((s) => s.episodes);
    } else {
      const chosen = seasonNum != null ? page.seasons.find((s) => s.seasonNum === seasonNum) : page.seasons[0];
      if (!chosen) throw new Error(`ไม่พบ Season ${seasonNum} — มี: ${page.seasons.map((s) => s.label).join(', ')}`);
      sourceEps = chosen.episodes;
      playlistSeasonNum = seasonNum || chosen.seasonNum;
    }
    if (!sourceEps.length) throw new Error('ไม่พบตอนในหน้า');
  }
  const playlistSeasonName = seasonName || `Season ${playlistSeasonNum}`;

  let seriesTitle = page.rawTitle;
  let posterUrl = page.rawPoster;
  let seasonPosterUrl = posterUrl;
  let tmdbEpisodes = [];
  let tmdbSeasonName = null;
  let tmdbShow = null;
  let seasonAirDate = '';

  if (tmdbKey) {
    if (isMovie) {
      tmdbShow = forceTmdbId
        ? await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US')
        : await tmdb.searchTmdbMovie(page.rawTitle, tmdbKey);
      if (tmdbShow) {
        const thName = await tmdb.getTmdbMovieNameTh(tmdbShow.id, tmdbKey);
        seriesTitle = utils.formatSeriesTitle(tmdbShow.title || page.rawTitle, thName);
      }
    } else {
      tmdbShow = forceTmdbId
        ? await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US')
        : await tmdb.searchTmdbTv(page.rawTitle, tmdbKey);
      if (tmdbShow) {
        const thName = await tmdb.getTmdbShowNameTh(tmdbShow.id, tmdbKey);
        seriesTitle = utils.formatSeriesTitle(tmdbShow.name || page.rawTitle, thName);
        if (!(multiSeason || seasonMap)) {
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbShow.id, tmdbKey, playlistSeasonNum);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
        }
      }
    }
    if (tmdbShow) {
      if (tmdbShow.poster_path) posterUrl = `${tmdb.TMDB_IMG}${tmdbShow.poster_path}`;
      if (seasonPosterUrl === page.rawPoster) seasonPosterUrl = posterUrl;
      console.log(`✅ TMDB: "${seriesTitle}" (ID: ${tmdbShow.id})${isMovie ? '' : ` — ${tmdbEpisodes.length} ตอน`}`);
    } else {
      console.warn('⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน');
    }
  }

  const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()).toLowerCase();
  const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
  const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
  const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
  const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

  if (isMovie) {
    process.stdout.write('\n🔗 กำลัง fetch stream...');
    const streamUrl = await resolveEmbed(await getEmbedUrl(page.postId));
    console.log(` ✅ ${streamUrl}`);

    const partSeason = seasonNum || 1;
    const partPlaylist = io.buildPartFile({ outputPath, season: partSeason, posterUrl, trackName, streamUrl, sourceUrl: pageUrl });
    const newStation = partPlaylist.stations.find((st) => st.name === trackName);
    if (newStation) newStation.release_date = tmdbShow?.release_date || '';
    io.stampPlaylist(partPlaylist, tmdbShow, true);
    fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
    console.log(`\n📁 บันทึก part file: ${outputPath}`);

    const mainFile = mainSlugArg ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`) : slugFile;
    const mainPath = path.resolve(PLAYLIST_DIR, mainFile);
    const mainPlaylist = io.upsertMainFile({
      mainPath, franchiseName: seriesTitle, franchisePoster: posterUrl,
      partTitle: seriesTitle, partPoster: posterUrl,
      partFileRawUrl: `${GITHUB_RAW_BASE}${outputFile}`, season: partSeason,
    });
    io.stampPlaylist(mainPlaylist, tmdbShow, true);
    fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), 'utf-8');
    console.log(`📁 บันทึก main file: ${mainPath}`);
    io.updateIndex({
      indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
      seriesTitle: mainPlaylist.name, posterUrl: mainPlaylist.image, filename: mainFile, upsert: true,
      releaseDate: mainPlaylist.release_date || '', updatedAt: mainPlaylist.updated_at,
      seasonCount: null, completion: null, partCount: mainPlaylist.part_count ?? null,
    });
    console.log('\n🎉 เสร็จสิ้น!');
    console.log(`   ไฟล์: ${outputFile}`);
    return;
  }

  const ms = await prepareMultiSeason({
    sourceCount: sourceEps.length, tmdbShow, tmdbKey, isDubbedTrack, posterUrl,
    multiSeason, seasonMap, isMovie: false,
    ignoredFlags: { '--season': seasonNum != null, '--auto-split': !!autoSplit, '--split-eps': !!splitEps },
  });

  const reuse = createStreamReuse({
    enabled: onlyNew, previous: io.loadPlaylist(outputPath),
    trackName, sourceUrl: pageUrl, seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset: 0,
  });

  let resolvedSplitEps = splitEps;
  const numBase = utils.tmdbNumberBase(tmdbEpisodes);
  const epMap = buildEpisodeMap({ sourceCount: sourceEps.length, epOffset: numBase, splitEps: resolvedSplitEps });
  if (!autoSplit && !ms) suggestSplitEps({ sourceCount: sourceEps.length, tmdbEpisodes, epOffset: 0, splitEps: resolvedSplitEps });

  console.log(`\n🔗 กำลัง fetch streams (${sourceEps.length} ตอน)...`);
  const stations = [];
  for (let i = 0; i < sourceEps.length; i++) {
    const ep = sourceEps[i];
    let tmdbEpNum, label, tmdbEp;
    if (ms) {
      ({ label, tmdbEp } = episodeAt(ms, i));
    } else {
      ({ epNum: tmdbEpNum, label } = epMap[i]);
      tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[tmdbEpNum - 1 - numBase];
    }
    process.stdout.write(`  ตอน ${label} (id=${ep.epId})...`);

    const old = reuse.find(label, { notUrls: [pageUrl], season: ms ? `Season ${ms.assign[i].seasonNum}` : null });
    let streamUrl = old?.url || null;
    if (old) {
      process.stdout.write(' ♻️  ใช้ลิงก์เดิม\n');
    } else {
      try {
        streamUrl = await resolveEmbed(await getEmbedUrl(ep.epId));
        process.stdout.write(' ✅\n');
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }
    }

    const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
    stations.push({
      name: utils.buildStationName(label, tmdbEp?.name || '', isDubbedTrack),
      ...(epThumb && { image: epThumb }),
      url: streamUrl || pageUrl,
      referer: STATION_REFERER,
      release_date: tmdbEp?.air_date || '',
    });
    if (!old && i < sourceEps.length - 1) await utils.sleep(500);
  }
  reuse.summary();

  const resolved = stations.filter((st) => st.url !== pageUrl).length;
  if (!resolved) throw new Error('ไม่ได้ลิงก์ stream เลยสักตอน — ไม่บันทึกไฟล์');
  if (resolved < stations.length) console.warn(`⚠️  ได้ลิงก์ ${resolved}/${stations.length} ตอน — ตอนที่เหลือเก็บเป็นหน้าเรื่อง (เล่นไม่ได้)`);

  if (autoSplit && !splitEps && !ms) {
    resolvedSplitEps = await applyMeasuredSplit({ stations, tmdbEpisodes, epOffset: 0, isDubbedTrack });
  }

  const previousPlaylist = io.loadPlaylist(outputPath);
  let playlist;
  if (ms) {
    playlist = writeMultiSeason({ ms, outputPath, seriesTitle, posterUrl, stations, trackName, trackReferer: pageUrl });
    carryOverFetchedSkips({ playlist, seasons: ms.plan.map((p) => p.seasonNum), previous: previousPlaylist });
  } else {
    playlist = io.buildOrMergePlaylist({
      outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
      trackName, trackReferer: pageUrl, tmdbSeasonName,
      seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset: 0, splitEps: resolvedSplitEps,
    });
    io.markSeasonTrackComplete({ playlist, seasonName: playlistSeasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
    if (seasonAirDate) {
      const affected = (playlist.groups || []).find((g) => utils.matchesSeasonName(g.name, playlistSeasonName));
      if (affected) affected.release_date = seasonAirDate;
    }
    carryOverFetchedSkips({ playlist, seasons: [playlistSeasonName], previous: previousPlaylist });
  }
  io.stampPlaylist(playlist, tmdbShow, false);
  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
  console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
  io.updateIndex({
    indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
    seriesTitle, posterUrl, filename: outputFile, upsert: true,
    releaseDate: playlist.release_date || '', updatedAt: playlist.updated_at,
    seasonCount: playlist.season_count ?? null, completion: playlist.completion ?? null,
  });

  console.log('\n🎉 เสร็จสิ้น!');
  console.log(`   ไฟล์: ${outputFile}`);
  console.log(`   จำนวนตอน: ${stations.length}`);
}

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
