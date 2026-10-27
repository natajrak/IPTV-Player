#!/usr/bin/env node
/**
 * fetch-upde.js
 * สร้าง / อัปเดต playlist JSON (series) จาก upde.cc พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าเรื่อง upde.cc/titles/{id}/... (หรือหน้า upde.cc/watch/{videoId})
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: subth)
 *                      เว็บแยกพากย์/ซับเป็นคนละเรื่อง — ระบุ track ให้ตรงกับหน้าที่ใส่
 *   --season=N         season ของเว็บที่ดึง + season ใน playlist (default: 1)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID เอง (ปกติใช้ tmdb_id ที่เว็บให้มา)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --split-eps=N,M:k  TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *   --multi-season     รวมตอนทุก season ของเว็บเป็นลิสต์เดียว → แบ่งลง season ตาม TMDB
 *   --season-map=A,B   ระบุจำนวนตอนของแต่ละ season เอง (ใช้คู่กับการรวมทุก season)
 *   --auto-split       ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB
 *   --type=KIND        series|anime-series (default: series)
 *   --only-new         ใช้ stream URL เดิมของตอนที่มีในไฟล์อยู่แล้ว ดึงใหม่เฉพาะตอนใหม่
 *
 * ─── ที่มาของ stream ─────────────────────────────────────────────────────
 *   1. API ของเว็บ (MTDb): /api/v1/titles/{id}/seasons/{n} → ตอน + primary_video
 *      /api/v1/watch/{videoId} → video.src = https://fpic.cc/embed/{id}
 *   2. หน้า embed fpic.cc: config ซ่อนด้วย aaencode + packer → kaken / __ts / __nc / __sg
 *   3. POST fpic.cc/api/ (header X-Ts/X-Nc/X-Sg) → ตอบกลับเข้ารหัส AES-256-CBC
 *      key/iv = PBKDF2-SHA256(FPIC_KEY_PREFIX + __ts + __nc, salt 16 byte แรก, 10000 รอบ, 48 byte)
 *   4. sources[0].file = fpic.cc/hls/{token} → 302 ไป master m3u8 ของ Vidara (มี token อายุสั้น)
 *      master ของ Vidara เปิดได้โดยไม่ต้องมี token และเปิด CORS → เก็บแบบตัด query ออกเป็นลิงก์ถาวร
 *   LuluStream (ตัวเล่นที่สอง) ลิงก์มีลายเซ็นหมดอายุใน 8 ชม. จึงไม่ใช้
 */

const crypto = require('crypto');
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
const { seriesUrl: pageUrl, tmdbKey, customOutput, idPrefixArg,
        trackName, isDubbedTrack, seasonNum, seasonName,
        updateMeta, updateMetaMode, noTouch,
        forceTmdbId, splitEps, autoSplit,
        seasonMap, multiSeason, typeArg, filterTrack, onlyNew } = cli;

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-upde.js <upde.cc/titles/{id}/...> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-upde.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_BASE = 'https://upde.cc';
const FPIC_BASE = 'https://fpic.cc';
const FPIC_REFERER = 'https://fpic.cc/';
const FPIC_KEY_PREFIX = 'V8xK2mP9qR4wT6yA3bN7cJ5dF1gH0eL';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ───── upde.cc API ─────
async function apiGet(apiPath) {
  const res = await fetch(`${SITE_BASE}${apiPath}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${SITE_BASE}/` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${apiPath}`);
  return res.json();
}

/** URL หน้าเรื่องหรือหน้า watch → title id */
async function resolveTitleId(url) {
  const titleMatch = url.match(/\/titles\/(\d+)/);
  if (titleMatch) return titleMatch[1];
  const watchMatch = url.match(/\/watch\/(\d+)/);
  if (watchMatch) {
    const data = await apiGet(`/api/v1/watch/${watchMatch[1]}?loader=watchPage`);
    if (data?.title?.id) return String(data.title.id);
  }
  throw new Error(`ไม่รู้จักรูปแบบ URL: ${url} (ต้องเป็น upde.cc/titles/{id}/... หรือ upde.cc/watch/{id})`);
}

/** ตอนทั้งหมดของ season (ไล่ทุกหน้าของ pagination) */
async function getSeasonEpisodes(titleId, season) {
  const episodes = [];
  for (let page = 1; page; ) {
    const data = await apiGet(`/api/v1/titles/${titleId}/seasons/${season}?loader=seasonPage&page=${page}`);
    for (const ep of data?.episodes?.data || []) episodes.push(ep);
    page = data?.episodes?.next_page || null;
  }
  return episodes.sort((a, b) => a.episode_number - b.episode_number);
}

/** video ของตอน → URL embed (เลือก fpic.cc ก่อน) */
async function getEmbedUrl(videoId) {
  const data = await apiGet(`/api/v1/watch/${videoId}?loader=watchPage`);
  const candidates = [data?.video, ...(data?.alternative_videos || [])].filter(Boolean);
  const fpic = candidates.find((v) => /^https:\/\/fpic\.cc\/embed\//.test(v.src || ''));
  if (!fpic) throw new Error(`ไม่พบ embed fpic.cc ของ video ${videoId}`);
  return fpic.src;
}

// ───── fpic.cc ─────
/** aaencode → JS source โดยแปลงสัญลักษณ์เป็นเลขฐาน 8/16 ตรงๆ (ไม่ eval โค้ดของเว็บ) */
const AA_DIGITS = [
  ['((ﾟｰﾟ) + (ﾟｰﾟ) + (ﾟΘﾟ))', '9'], ['((ﾟｰﾟ) + (ﾟｰﾟ))', '8'], ['((ﾟｰﾟ) + (o^_^o))', '7'], ['((o^_^o) +(o^_^o))', '6'],
  ['((ﾟｰﾟ) + (ﾟΘﾟ))', '5'], ['((o^_^o) - (ﾟΘﾟ))', '2'], ['(c^_^o)', '0'], ['(ﾟΘﾟ)', '1'], ['(o^_^o)', '3'], ['(ﾟｰﾟ)', '4'],
  ['(ﾟДﾟ) .ﾟωﾟﾉ', 'a'], ['(ﾟДﾟ) .ﾟΘﾟﾉ', 'b'], ["(ﾟДﾟ) ['c']", 'c'], ['(ﾟДﾟ) .ﾟｰﾟﾉ', 'd'], ['(ﾟДﾟ) .ﾟДﾟﾉ', 'e'], ['(ﾟДﾟ) [ﾟΘﾟ]', 'f'],
];
function aadecode(src) {
  const startMatch = src.match(/\(ﾟДﾟ\)\[ﾟoﾟ\]\s*\+\s*/);
  const end = src.lastIndexOf('+(ﾟДﾟ)[ﾟoﾟ])');
  if (!startMatch || end < 0) throw new Error('ไม่พบ payload aaencode ในหน้า embed');
  const body = src.slice(startMatch.index + startMatch[0].length, end);
  let out = '';
  for (const segment of body.split('(ﾟДﾟ)[ﾟεﾟ]+').filter(Boolean)) {
    let rest = segment.replace(/\+$/, '');
    const unicode = rest.startsWith('(oﾟｰﾟo)+');
    if (unicode) rest = rest.slice('(oﾟｰﾟo)+'.length);
    let digits = '';
    while ((rest = rest.replace(/^\s*\+?\s*/, ''))) {
      const hit = AA_DIGITS.find(([sym]) => rest.startsWith(sym));
      if (!hit) throw new Error(`aaencode token ที่ไม่รู้จัก: ${rest.slice(0, 30)}`);
      digits += hit[1];
      rest = rest.slice(hit[0].length);
    }
    out += String.fromCharCode(parseInt(digits, unicode ? 16 : 8));
  }
  return out;
}

/** Dean Edwards packer — แทนคำตามตาราง (string ล้วน ไม่ eval) */
function unpack(src) {
  const m = src.match(/\}\('(.*)',(\d+),(\d+),'(.*)'\.split\('\|'\)/s);
  if (!m) throw new Error('ไม่พบ packer ใน config ของ fpic.cc');
  let [, payload, base, count, words] = m;
  base = Number(base);
  count = Number(count);
  words = words.split('|');
  const encode = (n) => (n < base ? '' : encode(Math.floor(n / base))) + ((n %= base) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  while (count--) {
    if (words[count]) payload = payload.replace(new RegExp(`\\b${encode(count)}\\b`, 'g'), words[count]);
  }
  return payload;
}

function decryptFpic(b64, ts, nc) {
  const raw = Buffer.from(b64, 'base64');
  const material = crypto.pbkdf2Sync(FPIC_KEY_PREFIX + ts + nc, raw.subarray(0, 16), 10000, 48, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

/** ข้อผิดพลาดที่ลองใหม่ก็ไม่หาย (ตัวเล่นไม่ใช่ Vidara) */
class UnsupportedSourceError extends Error {}

/** fpic.cc บางครั้งตอบ "Not Found" ทั้งที่ตอนนั้นมีวิดีโอ — ลองใหม่ (ขอ config ใหม่ทุกรอบ) */
async function getVidaraMaster(embedUrl, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await requestVidaraMaster(embedUrl);
    } catch (err) {
      if (err instanceof UnsupportedSourceError || i >= attempts) throw err;
      await utils.sleep(1500 * i);
    }
  }
}

/** embed fpic.cc → master m3u8 ของ Vidara แบบไม่มี token (เช็คแล้วว่าเปิดได้) */
async function requestVidaraMaster(embedUrl) {
  const embedRes = await fetch(embedUrl, { headers: { 'User-Agent': UA, Referer: `${SITE_BASE}/` } });
  if (!embedRes.ok) throw new Error(`embed HTTP ${embedRes.status}`);
  const html = await embedRes.text();
  const encoded = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((js) => js.includes('ﾟωﾟﾉ'));
  if (!encoded) throw new Error('ไม่พบ config (aaencode) ในหน้า embed');

  const config = {};
  for (const m of unpack(aadecode(encoded)).matchAll(/window\.(\w+)="([^"]*)"/g)) config[m[1]] = m[2];
  if (!config.kaken || !config.__ts || !config.__nc || !config.__sg) throw new Error('config ของ fpic.cc ไม่ครบ (kaken/__ts/__nc/__sg)');

  const apiRes = await fetch(`${FPIC_BASE}/api/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA, Referer: embedUrl, 'Content-Type': 'text/plain', 'X-Requested-With': 'XMLHttpRequest',
      'X-Ts': config.__ts, 'X-Nc': config.__nc, 'X-Sg': config.__sg,
    },
    body: config.kaken,
  });
  if (!apiRes.ok) throw new Error(`fpic api HTTP ${apiRes.status}`);
  const result = JSON.parse(decryptFpic((await apiRes.text()).trim(), config.__ts, config.__nc));
  const sourceUrl = result?.sources?.[0]?.file;
  if (result?.status !== 'ok' || !sourceUrl) throw new Error(`fpic api ไม่มี source (${result?.message || result?.status})`);

  const redirect = await fetch(sourceUrl, { redirect: 'manual', headers: { 'User-Agent': UA, Referer: embedUrl } });
  const location = redirect.headers.get('location');
  if (!location) throw new Error(`fpic hls ไม่ redirect (HTTP ${redirect.status})`);
  const master = new URL(location);
  if (!/^\/hls\/[^/]+\/master\.m3u8$/.test(master.pathname)) {
    throw new UnsupportedSourceError(`ตัวเล่นไม่ใช่ Vidara (${master.host}) — LuluStream ลิงก์หมดอายุใน 8 ชม. ไม่รองรับ`);
  }
  master.search = '';

  const check = await fetch(master.href, { headers: { 'User-Agent': UA } });
  const head = check.ok ? (await check.text()).slice(0, 7) : '';
  if (head !== '#EXTM3U') throw new Error(`master ไม่มี token เปิดไม่ได้ (HTTP ${check.status})`);
  return master.href;
}

// ───── Main ─────
async function main() {
  const paths = makePaths({ typeArg: typeArg || 'series', scriptDir: __dirname, defaultType: 'series' });

  if (updateMeta) {
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }
  if (paths.isMovie) throw new Error('fetch-upde.js รองรับเฉพาะ series');
  const { playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } = paths;

  const titleId = await resolveTitleId(pageUrl);
  const titleData = await apiGet(`/api/v1/titles/${titleId}?loader=titlePage`);
  const title = titleData?.title;
  if (!title) throw new Error(`ไม่พบข้อมูลเรื่อง id=${titleId}`);
  if (!title.is_series) throw new Error(`"${title.name}" ไม่ใช่ series`);
  console.log(`✅ พบ: "${title.name}" (upde id=${titleId}, tmdb=${title.tmdb_id || '-'}, ${title.seasons_count || 1} season)`);

  const allSeasons = multiSeason || seasonMap;
  const siteSeasons = allSeasons
    ? Array.from({ length: title.seasons_count || 1 }, (_, i) => i + 1)
    : [seasonNum || 1];
  const episodes = [];
  for (const s of siteSeasons) {
    const eps = await getSeasonEpisodes(titleId, s);
    console.log(`📺 Season ${s} ของเว็บ: ${eps.length} ตอน`);
    episodes.push(...eps);
  }
  const playable = episodes.filter((ep) => ep.primary_video?.id);
  if (playable.length < episodes.length) console.warn(`⚠️  ข้าม ${episodes.length - playable.length} ตอนที่ยังไม่มีวิดีโอ`);
  if (!playable.length) throw new Error('ไม่พบตอนที่มีวิดีโอ');

  let seriesTitle = title.name;
  let posterUrl = title.poster || '';
  let seasonPosterUrl = posterUrl;
  let tmdbEpisodes = [];
  let tmdbSeasonName = null;
  let tmdbShow = null;
  let seasonAirDate = '';
  const tmdbId = forceTmdbId || title.tmdb_id;

  if (tmdbKey && tmdbId) {
    tmdbShow = await tmdb.getTmdbShow(tmdbId, tmdbKey, 'en-US');
    if (tmdbShow) {
      const thName = await tmdb.getTmdbShowNameTh(tmdbShow.id, tmdbKey);
      seriesTitle = utils.formatSeriesTitle(tmdbShow.name || title.name, thName);
      posterUrl = tmdbShow.poster_path ? `${tmdb.TMDB_IMG}${tmdbShow.poster_path}` : posterUrl;
      seasonPosterUrl = posterUrl;
      if (!allSeasons) {
        const biData = await tmdb.getTmdbSeasonBilingual(tmdbShow.id, tmdbKey, seasonNum || 1);
        tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
        if (biData.poster) seasonPosterUrl = biData.poster;
        tmdbSeasonName = biData.seasonName;
        seasonAirDate = biData.air_date || '';
      }
      console.log(`✅ TMDB: "${seriesTitle}" (ID: ${tmdbShow.id})${allSeasons ? '' : ` — ${tmdbEpisodes.length} ตอน`}`);
    } else {
      console.warn(`⚠️  ไม่พบ TMDB ID ${tmdbId} ใช้ชื่อจากเว็บแทน`);
    }
  } else if (!tmdbId) {
    console.warn('⚠️  เว็บไม่มี tmdb_id และไม่ได้ระบุ --tmdb-id ใช้ชื่อจากเว็บแทน');
  }

  const ms = await prepareMultiSeason({
    sourceCount: playable.length, tmdbShow, tmdbKey, isDubbedTrack, posterUrl,
    multiSeason, seasonMap, isMovie: false,
    ignoredFlags: { '--season': seasonNum != null, '--auto-split': !!autoSplit, '--split-eps': !!splitEps },
  });

  const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()).toLowerCase();
  const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
  const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
  const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
  const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

  const reuse = createStreamReuse({
    enabled: onlyNew, previous: io.loadPlaylist(outputPath),
    trackName, sourceUrl: pageUrl, seasonName, seasonNum, epOffset: 0,
  });

  let resolvedSplitEps = splitEps;
  const numBase = utils.tmdbNumberBase(tmdbEpisodes);
  const epMap = buildEpisodeMap({ sourceCount: playable.length, epOffset: numBase, splitEps: resolvedSplitEps });
  if (!autoSplit && !ms) suggestSplitEps({ sourceCount: playable.length, tmdbEpisodes, epOffset: 0, splitEps: resolvedSplitEps });

  console.log(`\n🔗 กำลัง fetch stream URLs (${playable.length} ตอน)...`);
  const stations = [];
  for (let i = 0; i < playable.length; i++) {
    const ep = playable[i];
    const watchUrl = `${SITE_BASE}/watch/${ep.primary_video.id}`;
    let tmdbEpNum, label, tmdbEp;
    if (ms) {
      ({ label, tmdbEp } = episodeAt(ms, i));
    } else {
      ({ epNum: tmdbEpNum, label } = epMap[i]);
      tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[tmdbEpNum - 1 - numBase];
    }
    process.stdout.write(`  ตอน ${label} (${i + 1}/${playable.length})...`);

    const old = reuse.find(label, { notUrls: [watchUrl], season: ms ? `Season ${ms.assign[i].seasonNum}` : null });
    let streamUrl = old?.url || null;
    if (old) {
      process.stdout.write(' ♻️  ใช้ลิงก์เดิม\n');
    } else {
      try {
        streamUrl = await getVidaraMaster(await getEmbedUrl(ep.primary_video.id));
        process.stdout.write(' ✅\n');
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }
    }

    const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
    stations.push({
      name: utils.buildStationName(label, tmdbEp?.name || '', isDubbedTrack),
      ...(epThumb && { image: epThumb }),
      url: streamUrl || watchUrl,
      referer: FPIC_REFERER,
      release_date: tmdbEp?.air_date || '',
    });
    if (!old && i < playable.length - 1) await utils.sleep(500);
  }
  reuse.summary();

  const resolved = stations.filter((st) => !/^https:\/\/upde\.cc\/watch\//.test(st.url)).length;
  if (!resolved) throw new Error('ไม่ได้ลิงก์ Vidara เลยสักตอน — ไม่บันทึกไฟล์ (เรื่องนี้อาจใช้ LuluStream / ok.ru ซึ่งไม่รองรับ)');
  if (resolved < stations.length) console.warn(`⚠️  ได้ลิงก์ ${resolved}/${stations.length} ตอน — ตอนที่เหลือเก็บเป็นหน้า watch ของ upde (เล่นไม่ได้)`);

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
      seasonName, seasonNum, epOffset: 0, splitEps: resolvedSplitEps,
    });
    io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
    if (seasonAirDate) {
      const affectedSeason = (playlist.groups || []).find((g) => utils.matchesSeasonName(g.name, seasonName || 'Season 1'));
      if (affectedSeason) affectedSeason.release_date = seasonAirDate;
    }
    carryOverFetchedSkips({ playlist, seasons: [seasonName], previous: previousPlaylist });
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

main().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
