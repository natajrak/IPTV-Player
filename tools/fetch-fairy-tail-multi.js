#!/usr/bin/env node
/**
 * fetch-fairy-tail-multi.js
 * One-shot multi-source fetcher สำหรับ Fairy Tail (TMDB id 46261)
 * รวม anime-loki + anime108 เป็น playlist เดียว map ตรง TMDB structure (8 seasons, 328 eps)
 *
 * Mapping:
 *   TMDB S01 พากย์ไทย   ep 1-48   ← anime-loki  fairy-tail-1                (48 eps)
 *   TMDB S02 พากย์ไทย   ep 1-24   ← anime108    fairy-tail-2                (24 eps)
 *   TMDB S02 พากย์ไทย   ep 25-48  ← anime108    fairy-tail-3 (slice 1-24)   (24 eps, ตัดท้าย 4 ตอน)
 *   TMDB S03 ซับไทย     ep 1-4    ← anime-loki  fairy-tail-3 ซับ 097-100    (4 link แยก, ทิ้ง "97-100 รวม")
 *   TMDB S03 ซับไทย     ep 5-29   ← anime-loki  fairy-tail-4                (25 eps)
 *   TMDB S03 ซับไทย     ep 30-54  ← anime-loki  fairy-tail-5                (25 eps)
 *   TMDB S04 ซับไทย     ep 1-25   ← anime-loki  fairy-tail-6                (25 eps)
 *   TMDB S05 ซับไทย     ep 1-51   ← anime-loki  fairy-tail-7-1              (51 eps)
 *   TMDB S06 ซับไทย     ep 1-39   ← anime-loki  fairy-tail-7-2              (39 eps)
 *   TMDB S07 ซับไทย     ep 1-12   ← anime-loki  fairy-tail-8                (12 eps, ZERØ)
 *   TMDB S08 ซับไทย     ep 1-51   ← anime-loki  fairy-tail-9-final-season   (51 eps, Final)
 */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
const tmdb = require('./lib/tmdb');
const { isGenericEpisodeName } = require('./lib/utils');

loadEnv(__dirname);

const TMDB_KEY    = process.env.TMDB_API_KEY;
const TMDB_ID     = 46261;
const OUTPUT_PATH = path.resolve(__dirname, '../playlist/anime/series/46261-fairy-tail.txt');

const PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev';

const CONCURRENCY = 4;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ────────────────────────────────────────────────────────────────────
// anime-loki source helpers
// ────────────────────────────────────────────────────────────────────
const LOKI_BASE         = 'https://anime-loki.com';
const LOKI_REFERER      = 'https://anime-loki.com/';
const LOKI_STREAM_HOST  = 'overlay.miku-box.com';
const LOKI_INNER_BASE   = 'https://stream.anislime.com';

async function lokiParseListing(url) {
  const html = await fetchHtml(url, { Referer: LOKI_REFERER });
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $('a[href*="/watch/"]').each((_, el) => {
    const $el = $(el);
    const epUrl = ($el.attr('href') || '').trim();
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);
    const text = ($el.find('p').first().text() || $el.text() || '').trim();
    const isTh  = /พากย์/.test(text);
    const isSub = /ซับ/.test(text);
    const isPending = /รออัพ/.test(text);
    items.push({ url: epUrl, label: text.replace(/\s+/g, ' '), isTh, isSub, isPending });
  });
  return items;
}

async function lokiGetVideoId(epUrl) {
  const html = await fetchHtml(epUrl, { Referer: LOKI_REFERER });
  const m = html.match(/window\.displayvideo\s*\(\s*\d+\s*,\s*(\d+)\s*\)/);
  if (!m) throw new Error(`anime-loki: ไม่พบ window.displayvideo ใน ${epUrl}`);
  return m[1];
}

async function lokiGetStreamUrl(videoId, epUrl) {
  const innerUrl = `${LOKI_INNER_BASE}/video/${videoId}/`;
  const html = await fetchHtml(innerUrl, { Referer: epUrl });
  const m = html.match(/['"]url['"]\s*:\s*['"](https?:\/\/[^'"]*miku-box\.com\/v\/[^'"]+)['"]/i);
  if (!m) throw new Error(`anime-loki: ไม่พบ miku-box iframe (video_id=${videoId})`);
  const hashMatch = m[1].match(/\/v\/([A-Za-z0-9]+)/);
  if (!hashMatch) throw new Error(`anime-loki: extract hash ไม่ได้ จาก ${m[1]}`);
  return `https://${LOKI_STREAM_HOST}/file/${hashMatch[1]}/`;
}

function lokiWrapProxy(rawStreamUrl) {
  const refererForProxy = `https://${LOKI_STREAM_HOST}/`;
  return `${PROXY}/?url=${encodeURIComponent(rawStreamUrl)}&referer=${encodeURIComponent(refererForProxy)}`;
}

async function lokiResolveStream(epUrl) {
  const videoId = await lokiGetVideoId(epUrl);
  const raw = await lokiGetStreamUrl(videoId, epUrl);
  return { proxiedUrl: lokiWrapProxy(raw), pageReferer: LOKI_REFERER };
}

// ────────────────────────────────────────────────────────────────────
// anime108 source helpers
// ────────────────────────────────────────────────────────────────────
const A108_BASE     = 'https://www.anime108.com';
const A108_REFERER  = 'https://www.anime108.com/';
const A108_API      = 'https://www.anime108.com/api/get.php';
const A108_PLAYER   = 'https://main.108player.com';
const A108_LANG     = { th: 'Thai', subth: 'Sound Track' };

async function a108ParseListing(url) {
  const html = await fetchHtml(url, { Referer: A108_REFERER });
  const $ = cheerio.load(html);
  const postIdMatch = html.match(/halim_cfg\s*=\s*\{[^}]*"post_id"\s*:\s*(\d+)/);
  const postId = postIdMatch ? postIdMatch[1] : null;
  if (!postId) throw new Error(`anime108: ไม่พบ post_id ใน ${url}`);

  const parseSelect = (selectId) => {
    const eps = [];
    $(`select#${selectId} option`).each((_, el) => {
      const val = ($(el).attr('value') || '').trim();
      const label = ($(el).text() || '').trim();
      if (!val) return;
      const epUrl = val.startsWith('http') ? val : `${A108_BASE}${val}`;
      const epMatch = val.match(/-ep-(\d+)(?:-|\/?$)/i);
      const epNum = epMatch ? parseInt(epMatch[1]) : eps.length + 1;
      eps.push({ url: epUrl, epNum, label });
    });
    eps.sort((a, b) => a.epNum - b.epNum);
    return eps;
  };

  return { postId, thEps: parseSelect('sequel_select_th'), subEps: parseSelect('sequel_select_en') };
}

async function a108GetPlayerId(postId, epNum, lang) {
  const body = new URLSearchParams({
    action: 'halim_ajax_player', nonce: '', episode: String(epNum),
    server: '1', postid: String(postId), lang, title: '',
  }).toString();
  const res = await fetch(A108_API, {
    method: 'POST',
    headers: {
      ...HEADERS, Referer: A108_REFERER,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!res.ok) throw new Error(`anime108: halim_ajax HTTP ${res.status} (ep=${epNum})`);
  const html = await res.text();
  const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
  if (!iframeMatch) throw new Error(`anime108: ไม่พบ iframe (ep=${epNum})`);
  const idMatch = iframeMatch[1].match(/[?&]id=([a-zA-Z0-9]+)/);
  if (!idMatch) throw new Error(`anime108: ไม่พบ id ใน iframe (ep=${epNum})`);
  return idMatch[1];
}

function a108StreamUrl(playerId) {
  return `${A108_PLAYER}/newplaylist/${playerId}/${playerId}.m3u8`;
}

async function a108ResolveStream(postId, epNum, lang) {
  const id = await a108GetPlayerId(postId, epNum, lang);
  return { streamUrl: a108StreamUrl(id), pageReferer: A108_REFERER };
}

// ────────────────────────────────────────────────────────────────────
// Concurrency
// ────────────────────────────────────────────────────────────────────
async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { __err: e.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// ────────────────────────────────────────────────────────────────────
// Mapping config
// ────────────────────────────────────────────────────────────────────
const SOURCES = [
  { id: 'S01-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-1/',
    tmdbSeason: 1, ranges: [{ tmdbFrom: 1, tmdbTo: 48 }], pickTrack: 'th' },
  { id: 'S02a-a108', kind: 'a108', url: 'https://www.anime108.com/fairy-tail-2/',
    tmdbSeason: 2, ranges: [{ tmdbFrom: 1, tmdbTo: 24, srcFrom: 1, srcTo: 24 }], pickTrack: 'th' },
  { id: 'S02b-a108', kind: 'a108', url: 'https://www.anime108.com/fairy-tail-3/',
    tmdbSeason: 2, ranges: [{ tmdbFrom: 25, tmdbTo: 48, srcFrom: 1, srcTo: 24 }], pickTrack: 'th' },
  { id: 'S03a-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-3/',
    tmdbSeason: 3, ranges: [{ tmdbFrom: 1, tmdbTo: 4 }], pickTrack: 'sub',
    skipLabel: /097-100/ },
  { id: 'S03b-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-4/',
    tmdbSeason: 3, ranges: [{ tmdbFrom: 5, tmdbTo: 29 }], pickTrack: 'sub' },
  { id: 'S03c-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-5/',
    tmdbSeason: 3, ranges: [{ tmdbFrom: 30, tmdbTo: 54 }], pickTrack: 'sub' },
  { id: 'S04-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-6/',
    tmdbSeason: 4, ranges: [{ tmdbFrom: 1, tmdbTo: 25 }], pickTrack: 'sub' },
  { id: 'S05-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-7-1/',
    tmdbSeason: 5, ranges: [{ tmdbFrom: 1, tmdbTo: 51 }], pickTrack: 'sub' },
  { id: 'S06-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-7-2/',
    tmdbSeason: 6, ranges: [{ tmdbFrom: 1, tmdbTo: 39 }], pickTrack: 'sub' },
  { id: 'S07-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-8/',
    tmdbSeason: 7, ranges: [{ tmdbFrom: 1, tmdbTo: 12 }], pickTrack: 'sub' },
  { id: 'S08-loki', kind: 'loki', url: 'https://anime-loki.com/fairy-tail-9-final-season/',
    tmdbSeason: 8, ranges: [{ tmdbFrom: 1, tmdbTo: 51 }], pickTrack: 'sub' },
];

const TRACK_LABEL = {
  1: 'พากย์ไทย', 2: 'พากย์ไทย', 3: 'ซับไทย', 4: 'ซับไทย',
  5: 'ซับไทย', 6: 'ซับไทย', 7: 'ซับไทย', 8: 'ซับไทย',
};

// ────────────────────────────────────────────────────────────────────
// Per-source pipeline: listing → filter → map to TMDB ep slots
// ────────────────────────────────────────────────────────────────────
async function buildSourceTasks(src) {
  console.log(`\n📥 ${src.id} — ${src.url}`);

  if (src.kind === 'loki') {
    const items = await lokiParseListing(src.url);
    let picked = items.filter(it => {
      if (src.skipLabel && src.skipLabel.test(it.label)) return false;
      if (it.isPending) return false;
      if (src.pickTrack === 'th'  && !it.isTh)  return false;
      if (src.pickTrack === 'sub' && !it.isSub) return false;
      return true;
    });

    picked.sort((a, b) => {
      const na = parseInt((a.label.match(/ตอนที่\s*(\d+)/) || [0, 0])[1]);
      const nb = parseInt((b.label.match(/ตอนที่\s*(\d+)/) || [0, 0])[1]);
      return na - nb;
    });

    const range = src.ranges[0];
    const need = range.tmdbTo - range.tmdbFrom + 1;
    if (picked.length < need) {
      throw new Error(`${src.id}: ต้องการ ${need} ตอน แต่ได้ ${picked.length}`);
    }
    if (picked.length > need) {
      console.warn(`⚠️  ${src.id}: source มี ${picked.length} ตอน — ตัดเหลือ ${need} (ตอน ${range.tmdbFrom}-${range.tmdbTo})`);
      picked = picked.slice(0, need);
    }

    return picked.map((it, i) => ({
      srcId: src.id, pageUrl: it.url, label: it.label,
      tmdbSeason: src.tmdbSeason, tmdbEp: range.tmdbFrom + i,
      resolver: 'loki',
    }));
  }

  if (src.kind === 'a108') {
    const { postId, thEps, subEps } = await a108ParseListing(src.url);
    const list = src.pickTrack === 'th' ? thEps : subEps;
    const lang = A108_LANG[src.pickTrack === 'th' ? 'th' : 'subth'];
    const range = src.ranges[0];
    const need = range.tmdbTo - range.tmdbFrom + 1;
    const srcLen = (range.srcTo || list.length) - (range.srcFrom || 1) + 1;
    if (srcLen !== need) {
      throw new Error(`${src.id}: range ขนาดไม่ตรง (need=${need} srcLen=${srcLen})`);
    }
    if (list.length < (range.srcTo || list.length)) {
      throw new Error(`${src.id}: source มี ${list.length} ตอน แต่ต้องการถึงตอน ${range.srcTo}`);
    }
    const slice = list.slice((range.srcFrom || 1) - 1, range.srcTo || list.length);
    return slice.map((it, i) => ({
      srcId: src.id, pageUrl: it.url, label: it.label,
      tmdbSeason: src.tmdbSeason, tmdbEp: range.tmdbFrom + i,
      resolver: 'a108', postId, epNum: it.epNum, lang,
    }));
  }

  throw new Error(`unknown kind: ${src.kind}`);
}

// ────────────────────────────────────────────────────────────────────
// Resolve stream URL per task
// ────────────────────────────────────────────────────────────────────
async function resolveTask(task) {
  if (task.resolver === 'loki') {
    return await lokiResolveStream(task.pageUrl);
  }
  if (task.resolver === 'a108') {
    const { streamUrl, pageReferer } = await a108ResolveStream(task.postId, task.epNum, task.lang);
    return { proxiedUrl: streamUrl, pageReferer };
  }
  throw new Error(`unknown resolver: ${task.resolver}`);
}

// ────────────────────────────────────────────────────────────────────
// TMDB metadata
// ────────────────────────────────────────────────────────────────────
async function fetchTmdbAll(tvId) {
  const show = await tmdb.getTmdbShow(tvId, TMDB_KEY, 'en-US');
  const showTh = await tmdb.getTmdbShow(tvId, TMDB_KEY, 'th-TH');
  const seriesPosterEn = show.poster_path ? `https://image.tmdb.org/t/p/original${show.poster_path}` : '';
  const seasons = {};
  for (const s of show.seasons.filter(x => x.season_number >= 1 && x.season_number <= 8)) {
    const sn = s.season_number;
    const detailEn = await tmdb.getTmdbSeason(tvId, TMDB_KEY, sn, 'en-US');
    const detailTh = await tmdb.getTmdbSeason(tvId, TMDB_KEY, sn, 'th-TH');
    const poster = detailEn.poster_path ? `https://image.tmdb.org/t/p/original${detailEn.poster_path}` : seriesPosterEn;
    const eps = {};
    for (const e of (detailEn.episodes || [])) {
      const enName = e.name || '';
      const still = e.still_path ? `https://image.tmdb.org/t/p/original${e.still_path}` : poster;
      eps[e.episode_number] = { enName, thName: '', still, release: e.air_date || '' };
    }
    for (const e of (detailTh.episodes || [])) {
      if (eps[e.episode_number]) eps[e.episode_number].thName = e.name || '';
    }
    seasons[sn] = {
      seasonName: detailEn.name || `Season ${sn}`,
      seasonNameTh: detailTh.name || '',
      poster, eps,
    };
  }
  return { showName: show.name, showNameTh: showTh.name || '', seriesPoster: seriesPosterEn, seasons };
}

function pickEpName(epMeta) {
  const th = (epMeta.thName || '').trim();
  if (th && !isGenericEpisodeName(th)) return th;
  return (epMeta.enName || '').trim();
}

// ────────────────────────────────────────────────────────────────────
// Build playlist JSON
// ────────────────────────────────────────────────────────────────────
function buildPlaylist(tmdbData, taskResults) {
  const { showName, showNameTh, seriesPoster, seasons } = tmdbData;
  const seriesTitle = showNameTh ? `${showName} [${showNameTh}]` : showName;

  const seasonsWithTasks = new Set(taskResults.map(t => t.tmdbSeason));
  const seasonGroups = [];
  for (const snum of Object.keys(seasons).map(Number).sort((a,b) => a-b)) {
    if (!seasonsWithTasks.has(snum)) continue;
    const seasonMeta = seasons[snum];
    const seasonName = `Season ${snum}`;
    const trackLabel = TRACK_LABEL[snum];

    const stations = [];
    const tasksOfSeason = taskResults.filter(t => t.tmdbSeason === snum).sort((a,b) => a.tmdbEp - b.tmdbEp);
    for (const t of tasksOfSeason) {
      const epMeta = seasonMeta.eps[t.tmdbEp] || { enName: '', thName: '', still: seasonMeta.poster, release: '' };
      const epName = pickEpName(epMeta);
      stations.push({
        name: `ตอน ${t.tmdbEp} - ${epName}`,
        image: epMeta.still,
        url: t.result.proxiedUrl,
        referer: t.result.pageReferer,
        release_date: epMeta.release || undefined,
      });
    }

    seasonGroups.push({
      name: seasonName,
      image: seasonMeta.poster,
      groups: [{
        name: trackLabel,
        image: seasonMeta.poster,
        referer: SOURCES.find(s => s.tmdbSeason === snum)?.url || '',
        stations,
      }],
    });
  }

  return {
    name: seriesTitle,
    image: seriesPoster,
    groups: seasonGroups,
  };
}

function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
async function main() {
  if (!TMDB_KEY) throw new Error('TMDB_API_KEY ไม่อยู่ใน .env');

  const onlySeasons = process.argv.slice(2)
    .filter(a => a.startsWith('--seasons='))
    .map(a => a.replace('--seasons=', '').split(',').map(Number).filter(Boolean))
    .flat();

  let sources = SOURCES;
  if (onlySeasons.length) {
    sources = SOURCES.filter(s => onlySeasons.includes(s.tmdbSeason));
    console.log(`🎯 Filter เฉพาะ TMDB seasons: ${onlySeasons.join(',')} — ${sources.length} sources`);
  }

  console.log('🎬 Fairy Tail multi-source fetch');
  console.log(`   TMDB id=${TMDB_ID}, output=${OUTPUT_PATH}`);
  console.log(`   sources=${sources.length}, concurrency=${CONCURRENCY}`);

  // Phase 1: build tasks per source
  console.log('\n━━━ Phase 1: Parse listings ━━━');
  const allTasks = [];
  for (const src of sources) {
    const tasks = await buildSourceTasks(src);
    console.log(`   ✓ ${src.id} → ${tasks.length} tasks (S${src.tmdbSeason} ep ${tasks[0]?.tmdbEp}-${tasks[tasks.length-1]?.tmdbEp})`);
    allTasks.push(...tasks);
  }
  console.log(`\n📋 รวม tasks: ${allTasks.length}`);

  // Phase 2: resolve stream URLs (parallel)
  console.log('\n━━━ Phase 2: Resolve stream URLs ━━━');
  let done = 0;
  const failures = [];
  const results = await pMap(allTasks, async (t) => {
    try {
      const result = await resolveTask(t);
      done++;
      if (done % 10 === 0 || done === allTasks.length) {
        console.log(`   ${done}/${allTasks.length}`);
      }
      return { ...t, result };
    } catch (e) {
      done++;
      failures.push({ srcId: t.srcId, label: t.label, tmdbSeason: t.tmdbSeason, tmdbEp: t.tmdbEp, err: e.message });
      console.error(`   ❌ ${t.srcId} S${t.tmdbSeason} ep${t.tmdbEp} (${t.label}): ${e.message}`);
      return null;
    }
  }, CONCURRENCY);

  const okResults = results.filter(r => r && !r.__err);
  console.log(`\n📊 Resolved: ${okResults.length}/${allTasks.length}`);
  if (failures.length) {
    console.log(`⚠️  ล้มเหลว ${failures.length} ตอน:`);
    failures.forEach(f => console.log(`     S${f.tmdbSeason} ep${f.tmdbEp} (${f.srcId}): ${f.err}`));
  }

  // Phase 3: fetch TMDB metadata
  console.log('\n━━━ Phase 3: TMDB metadata ━━━');
  const tmdbData = await fetchTmdbAll(TMDB_ID);
  console.log(`   ✓ "${tmdbData.showName}" — ${Object.keys(tmdbData.seasons).length} seasons`);

  // Phase 4: build & write
  console.log('\n━━━ Phase 4: Build playlist JSON ━━━');
  const playlist = buildPlaylist(tmdbData, okResults);

  if (onlySeasons.length) {
    // Partial run — merge เข้าไฟล์เดิม
    if (fs.existsSync(OUTPUT_PATH)) {
      const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
      const map = new Map((existing.groups || []).map(g => [g.name, g]));
      for (const g of playlist.groups) map.set(g.name, g);
      existing.groups = Array.from(map.values()).sort((a,b) => {
        const an = parseInt((a.name.match(/Season\s*(\d+)/i) || [0,0])[1]);
        const bn = parseInt((b.name.match(/Season\s*(\d+)/i) || [0,0])[1]);
        return an - bn;
      });
      existing.name = playlist.name;
      existing.image = playlist.image;
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(stripUndefined(existing), null, 4) + '\n', 'utf-8');
      console.log(`   ✓ merged เข้าไฟล์เดิม (seasons แก้: ${playlist.groups.map(g => g.name).join(', ')})`);
    } else {
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(stripUndefined(playlist), null, 4) + '\n', 'utf-8');
      console.log(`   ✓ เขียนไฟล์ใหม่ (partial)`);
    }
  } else {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(stripUndefined(playlist), null, 4) + '\n', 'utf-8');
    console.log(`   ✓ เขียน ${OUTPUT_PATH}`);
  }

  // Final verify
  console.log('\n━━━ Verify ━━━');
  const final = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
  let total = 0;
  for (const s of final.groups) {
    const epCount = s.groups[0].stations.length;
    total += epCount;
    console.log(`   ${s.name}: ${s.groups[0].name} → ${epCount} eps`);
  }
  console.log(`   รวม: ${total} ตอน`);
}

main().catch(e => { console.error('💥', e.stack || e.message); process.exit(1); });
