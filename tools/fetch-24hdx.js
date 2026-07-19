#!/usr/bin/env node
/**
 * fetch-24hdx.js
 * สร้าง / อัปเดต playlist JSON จาก 24-hdx.com พร้อม metadata จาก TMDB
 * Stream ผ่าน WordPress Halim theme → api.24-hdx.com/get.php → (stream host — verify หลังผ่าน CF)
 *
 * ─── โครงสร้าง ─────────────────────────────────────────────────────────
 *   - WordPress + Halim theme (คล้าย 123-hds / 123-hdx)
 *   - halim_cfg: post_id, episode (default 1), server (1|2|3)
 *   - ajax_player.nonce = "" (empty — server อาจไม่ตรวจ)
 *   - Episode list: <select><option value="N">ตอนที่ N</option>
 *   - 3 servers per ep: 1=หลัก(เก่า), 2=หลัก(ใหม่), 3=สำรอง
 *   - AJAX: POST https://api.24-hdx.com/get.php (subdomain แยก)
 *     Body: action=halim_ajax_player&nonce=&episode=N&postid=PID&lang=&server=1|2|3
 *   - **CF WAF บล็อก AJAX ต้อง cookies (cf_clearance) จาก browser**
 *
 * ─── Setup ──────────────────────────────────────────────────────────────
 *   ตั้ง HDX24_COOKIES ใน tools/.env — เอาจาก DevTools → Network → get.php → Copy as cURL
 *   Cookie ที่สำคัญคือ cf_clearance (อายุ ~30 นาที)
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL 24-hdx.com (comma-separated รองรับ)
 *   --track=th|subth   default: subth (ใช้แค่ label)
 *   --season=N         default: 1
 *   --server=N         1|2|3 (default: 1 — ตัวเล่นหลักเก่า / ลอง 2,3 ถ้าล้มเหลว)
 *   --output=FILE
 *   --tmdb-id=N
 *   --update-meta[=poster|cover|title]
 *   --type=KIND        default: auto-detect
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
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch,
      forceTmdbId, typeArg, filterTrack } = cli;
const HDX24_COOKIES = (process.env.HDX24_COOKIES || '').trim();
// --server=1|2|3 override (default 1 — main old server)
const preferredServer = parseInt(cli.get('--server') || '1', 10) || 1;

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-24hdx.js <url>[,url2,...] [--track=th|subth] [--season=N] [--server=1|2|3] [--output=FILE]');
  console.error('       node fetch-24hdx.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}
// Note: 24-hdx.com's CF WAF whitelist based on IP (ไม่ใช่ cookies) หลัง user ผ่าน challenge ครั้งแรก
// → Cookies เป็น optional (ตั้งเมื่อ IP ไม่ผ่าน / ต้อง fresh clearance)
// → User ต้องเปิด https://www.24-hdx.com/ ใน Chrome (รอ CF challenge ผ่าน) ก่อนรัน script

const SITE_ORIGIN = 'https://www.24-hdx.com';
const API_URL = 'https://api.24-hdx.com/get.php';
const STATION_REFERER = `${SITE_ORIGIN}/`;
// Stream infra — pattern เดียวกับ 123-hds:
//   https://main.24playerhd.com/newplaylist/{HASH}/{HASH}.m3u8
const STREAM_HOST = 'main.24playerhd.com';
const STREAM_REFERER_URL = `https://${STREAM_HOST}/`;
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';
function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}
function buildStreamUrl(hash) {
  return `https://${STREAM_HOST}/newplaylist/${hash}/${hash}.m3u8`;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-ch-ua': '"Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

async function fetchPage(url) {
  // Main page (www.24-hdx.com) ปกติผ่านได้ — CF WAF บล็อกเฉพาะ api subdomain
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, Referer: SITE_ORIGIN + '/', ...(HDX24_COOKIES && { Cookie: HDX24_COOKIES }) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  if (/Just a moment|Attention Required.*Cloudflare/i.test(html.substring(0, 2000))) {
    throw new Error('CF WAF ปิดกั้น main page — cookies (cf_clearance) หมดอายุ');
  }
  return html;
}

// Track → lang param mapping (จาก <select id="Lang_select">)
//   --track=th    → lang="Thai"        (พากย์ไทย)
//   --track=subth → lang="Sound Track" (ซับไทย)
const TRACK_LANG_MAP = { th: 'Thai', subth: 'Sound Track' };
const trackLang = TRACK_LANG_MAP[cli.trackArg === 'th' ? 'th' : 'subth'];

// ───── Headless Chrome AJAX helper ─────
// CF WAF ที่ api.24-hdx.com ตรวจ TLS fingerprint (Chrome ผ่าน, curl/Node ไม่ผ่าน)
// → ยิง AJAX จากใน Chrome page context ให้ใช้ Chrome's TLS จริง
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let chromeCtx = null; // { proc, ws, sessionId, send, sendS, close }
let chromeNavUrl = null; // page URL ที่ต้อง navigate ก่อน (ต้องมี jQuery + same-origin)

async function launchChromeAjax() {
  if (chromeCtx) return chromeCtx;
  const { spawn } = require('child_process');
  const os = require('os');
  const profile = path.join(os.tmpdir(), 'hdx24-prof-' + Date.now());
  fs.mkdirSync(profile, { recursive: true });

  const port = 9280 + Math.floor(Math.random() * 100);
  const proc = spawn(CHROME_PATH, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--user-agent=${BASE_HEADERS['User-Agent']}`,
    // ปิด CORS/web-security — จำเป็นสำหรับ AJAX ข้าม subdomain (www ↔ api)
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process,CrossSiteDocumentBlockingIfIsolating,CrossSiteDocumentBlockingAlways',
    'about:blank',
  ], { stdio: 'ignore' });

  // wait for CDP
  await new Promise(r => setTimeout(r, 1500));
  let versionRes;
  for (let i = 0; i < 10; i++) {
    try { versionRes = await fetch(`http://localhost:${port}/json/version`).then(r => r.json()); break; }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!versionRes) throw new Error('Chrome CDP ไม่พร้อม');

  const ws = new WebSocket(versionRes.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  };
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const sendS = (sid, method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, sessionId: sid, method, params }));
  });

  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await sendS(sessionId, 'Page.enable');
  await sendS(sessionId, 'Runtime.enable');

  // Navigate to anime page (มี jQuery + same-origin สำหรับ AJAX)
  const navTarget = chromeNavUrl || (SITE_ORIGIN + '/');
  process.stdout.write(`  🌐 launching Chrome + navigating to ${navTarget}... `);
  await sendS(sessionId, 'Page.navigate', { url: navTarget, referrer: 'https://www.google.com/' });
  // wait for CF challenge + document ready + jQuery — up to 20s
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    const { result } = await sendS(sessionId, 'Runtime.evaluate', {
      expression: `document.readyState + '|' + (document.title || '') + '|jQuery=' + (typeof jQuery)`,
      returnByValue: true,
    });
    const val = String(result.value || '');
    if (val.startsWith('complete') && !val.includes('Just a moment') && val.includes('jQuery=function')) { ready = true; break; }
  }
  if (!ready) throw new Error('CF challenge ไม่ผ่านใน 20 วิ หรือ jQuery ไม่โหลด');
  process.stdout.write('✅\n');

  chromeCtx = {
    proc, ws, sessionId, send, sendS,
    close: () => {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };
  return chromeCtx;
}

async function postApi(postId, episode, server, nonce = '', lang = trackLang) {
  const body = new URLSearchParams({
    action: 'halim_ajax_player',
    nonce, episode: String(episode), server: String(server), postid: String(postId), lang, title: '',
  }).toString();

  // ─── ยิงจาก Chrome page context ผ่าน CDP (TLS ของ Chrome จริง → ผ่าน CF) ───
  // ใช้ jQuery.ajax (site load jQuery อยู่แล้ว) แทน fetch — เหมือน site's JS ทำ
  const ctx = await launchChromeAjax();
  const expr = `
    (async () => {
      if (typeof jQuery !== 'function') return { ok: false, status: 0, text: 'jQuery ไม่พร้อม' };
      return new Promise((resolve) => {
        jQuery.ajax({
          url: ${JSON.stringify(API_URL)},
          type: 'POST',
          data: ${JSON.stringify(body)},
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
          success: function(data, textStatus, jqXHR) {
            resolve({ ok: true, status: jqXHR.status, text: typeof data === 'string' ? data : JSON.stringify(data) });
          },
          error: function(jqXHR, textStatus, err) {
            resolve({ ok: false, status: jqXHR.status || 0, text: 'err: ' + textStatus + ' | ' + (err || '') + ' | body: ' + (jqXHR.responseText || '').substring(0, 300) });
          },
        });
      });
    })()
  `;
  const { result, exceptionDetails } = await ctx.sendS(ctx.sessionId, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`Chrome eval err: ${exceptionDetails.text}`);
  const { ok, status, text } = result.value || {};
  if (!ok) throw new Error(`api/get.php ล้มเหลว (status=${status}): ${String(text).substring(0, 200)}`);
  if (/Just a moment|Attention Required.*Cloudflare/i.test(String(text).substring(0, 2000))) {
    throw new Error('CF WAF ปิดกั้น AJAX แม้ผ่าน Chrome — ต้อง refresh session');
  }
  return text;
}

function extractHalimData(html) {
  // halim_cfg = { "post_id": 27189, "episode": 1, "server": 1, ... }
  const postIdMatch = html.match(/["']post_id["']\s*:\s*(\d+)/);
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  // ajax_player.nonce (อาจเป็น "" หรือค่าจริง)
  const nonceMatch = html.match(/ajax_player\s*=\s*\{[^}]*["']nonce["']\s*:\s*["']([^"']*)["']/);
  return {
    postId: postIdMatch ? parseInt(postIdMatch[1], 10) : null,
    nonce: nonceMatch ? nonceMatch[1] : '',
    title: titleMatch ? titleMatch[1] : '',
  };
}

// ดึง episodes จาก <select> dropdown
function extractEpisodes($) {
  const eps = [];
  const seen = new Set();
  $('select option').each((_, el) => {
    const $el = $(el);
    const value = ($el.attr('value') || '').trim();
    const label = ($el.text() || '').trim();
    if (!value || seen.has(value)) return;
    const epNumMatch = label.match(/ตอนที่\s*(\d+)/) || value.match(/^(\d+)$/);
    if (!epNumMatch) return;
    seen.add(value);
    eps.push({ epNum: parseInt(epNumMatch[1], 10), value });
  });
  eps.sort((a, b) => a.epNum - b.epNum);
  return eps;
}

// Detect available servers on page (from data-server attrs)
function extractServers(html) {
  const servers = new Set();
  for (const m of html.matchAll(/data-server=["'](\d+)["']/g)) {
    servers.add(parseInt(m[1], 10));
  }
  return [...servers].sort();
}

// Parse response → hash (24-hdx pattern = 123-hds infra)
// Response อาจเป็น: iframe/HTML ที่มี /newplaylist/{HASH}/ หรือ ?id={HASH}
function parseHashFromResponse(html) {
  const patterns = [
    /\/newplaylist\/([a-f0-9]{20,})/i,   // stream URL ตรงๆ ใน response
    /[?&]id=([a-f0-9]{20,})/i,           // ?id=HASH (pattern เดิม 123-hds)
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return m[1];
  }
  return null;
}

async function getStreamHash(postId, episode, server, nonce) {
  const html = await postApi(postId, episode, server, nonce);
  const hash = parseHashFromResponse(html);
  if (!hash) throw new Error(`ไม่พบ hash ใน response: ${html.substring(0, 200)}`);
  return hash;
}

// ───── Parse anime page ─────
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const halim = extractHalimData(html);
  const eps = extractEpisodes($);
  const servers = extractServers(html);

  let rawTitle = halim.title || $('title').text() || '';
  rawTitle = rawTitle.replace(/\s*24-HD\.COM.*$/i, '')
    .replace(/\s*ดูซีรีย์\s*/, '')
    .replace(/\s*ดูหนัง\s*/, '')
    .replace(/\s*\|.*$/, '')
    .trim();
  const rawPoster = ($('meta[property="og:image"]').attr('content') || '').trim();

  if (!halim.postId) throw new Error('ไม่พบ halim_cfg.post_id');
  if (eps.length === 0) throw new Error('ไม่พบ episode dropdown (<select>)');

  const isMoviePage = eps.length === 1;
  console.log(`✅ "${rawTitle}" — ${isMoviePage ? 'Movie' : `Series (${eps.length} ตอน)`}`);
  console.log(`   post_id=${halim.postId}, servers=[${servers.join(',')}]`);
  return { rawTitle, rawPoster, halim, eps, servers, isMoviePage };
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

  try {
    const urls = seriesUrl.split(',').map(u => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;

    let rawTitle = '', rawPoster = '';
    let firstHalim = null;
    let isMoviePage = false;
    let mergedEps = [];

    // ให้ Chrome navigate ไปที่ anime page แรก (มี jQuery + same-origin)
    chromeNavUrl = urls[0];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const parsed = await parsePage(urls[ui]);
      if (ui === 0) {
        rawTitle = parsed.rawTitle;
        rawPoster = parsed.rawPoster;
        firstHalim = parsed.halim;
        isMoviePage = parsed.isMoviePage;
      }
      const offset = mergedEps.length;
      for (const ep of parsed.eps) {
        mergedEps.push({
          epNum: offset > 0 ? offset + ep.epNum : ep.epNum,
          value: ep.value,
          postId: parsed.halim.postId,
          nonce: parsed.halim.nonce,
          availableServers: parsed.servers.length ? parsed.servers : [1, 2, 3],
        });
      }
      if (isMultiUrl) console.log(`  รวม ${mergedEps.length} ตอน`);
    }

    if (mergedEps.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    const detectedType = isMoviePage ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie: isMovieContent, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: detectedType });
    console.log(`📂 ประเภท: ${effectiveTypeArg} | track: ${trackName} (lang="${trackLang}") | server: ${preferredServer}`);

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      if (isMovieContent) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || rawTitle;
          const thName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        }
      } else {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || rawTitle;
          const thName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;

          const sNum = seasonNum || 1;
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
        }
      }
    }

    // Fetch streams
    console.log(`\n🔗 กำลัง fetch streams (${mergedEps.length} ตอน)...`);
    const stations = [];
    for (let i = 0; i < mergedEps.length; i++) {
      const ep = mergedEps[i];
      const epNum = ep.epNum;
      process.stdout.write(`  ตอน ${epNum}/${mergedEps.length} (ep=${ep.value}, srv=${preferredServer})...`);

      let streamUrl = null;
      try {
        const hash = await getStreamHash(ep.postId, ep.value, preferredServer, ep.nonce);
        streamUrl = proxyUrl(buildStreamUrl(hash), STREAM_REFERER_URL);
        process.stdout.write(` ${hash.substring(0, 10)}… ✅\n`);
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }

      const tmdbEp = tmdbEpisodes.find(e => e.episode_number === epNum) || tmdbEpisodes[i];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

      stations.push({
        name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
        ...(epThumb && { image: epThumb }),
        url: streamUrl || urls[0],
        referer: STATION_REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      if (i < mergedEps.length - 1) await utils.sleep(500);
    }

    // Build / save playlist
    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovieContent) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่มี stream'); process.exit(1); }
      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl: s.url, sourceUrl: urls[0],
      });
      const st = partPlaylist.stations.find(s2 => s2.name === trackName);
      if (st) st.release_date = tmdbShow?.release_date || '';
      io.stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      const mainFile = mainSlugArg ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`) : slugFile;
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
      const playlistSeasonNum = seasonNum || 1;
      const playlistSeasonName = seasonName || `Season ${playlistSeasonNum}`;
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: urls[0], tmdbSeasonName,
        seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset: 0,
      });
      io.markSeasonTrackComplete({ playlist, seasonName: playlistSeasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const affected = (playlist.groups || []).find(g => g.name === playlistSeasonName);
        if (affected) affected.release_date = seasonAirDate;
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
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (chromeCtx) { try { chromeCtx.close(); } catch {} }
  }
}

main();
