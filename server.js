#!/usr/bin/env node
'use strict';

const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const url          = require('url');
const { spawn }    = require('child_process');

const PORT      = process.env.PORT || 4000;
const ROOT      = __dirname;
const TOOLS_DIR = path.join(ROOT, 'tools');

// ── MIME types ───────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.png':  'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif':  'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map':  'application/json',
};

// ── Allowed scripts & playlist directories ───────────────────────
const ALLOWED_SCRIPTS = new Set([
  'fetch-fairyanime.js',
  'fetch-indy-anime.js',
  'fetch-kurokamii.js',
  'fetch-7hd.js',
  'fetch-nunghd4k.js',
  'fetch-123hds.js',
  'fetch-javxx.js',
  'fetch-allinhd.js',
  'fetch-037hdd.js',
  'fetch-v8hdd.js',
]);

const PLAYLIST_DIRS = {
  'anime-series': 'playlist/anime/series',
  'anime-movie':  'playlist/anime/movies',
  'movie':        'playlist/movies',
  'series':       'playlist/series',
  'av':           'playlist/av',
};

const CUSTOM_TABS_PATH = path.join(ROOT, 'playlist', 'custom-tabs.json');

/** Load custom tabs and merge with built-in PLAYLIST_DIRS */
function getPlaylistDir(tabKey) {
  if (PLAYLIST_DIRS[tabKey]) return PLAYLIST_DIRS[tabKey];
  try {
    const customs = JSON.parse(fs.readFileSync(CUSTOM_TABS_PATH, 'utf-8'));
    const found = customs.find(c => c.key === tabKey);
    if (found) return found.dir;
  } catch {}
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────
function removeFromIndex(indexPath, file) {
  if (!fs.existsSync(indexPath)) return;
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    idx.groups = (idx.groups || []).filter(g => {
      const f = (g.url || '').split('/').pop().replace(/\.txt$/i, '');
      return f !== file;
    });
    fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2));
  } catch {}
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data',  chunk => body += chunk);
    req.on('end',   ()    => resolve(body));
    req.on('error', reject);
  });
}

// ── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed   = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(parsed.pathname);

  // ── POST /api/run-fetch ────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/run-fetch') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad JSON');
      return;
    }

    const { script, args = [] } = body;

    if (!ALLOWED_SCRIPTS.has(script)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Script not allowed');
      return;
    }

    res.writeHead(200, {
      'Content-Type':      'text/event-stream; charset=utf-8',
      'Cache-Control':     'no-cache',
      'X-Accel-Buffering': 'no',
    });

    const send = obj => {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    const proc = spawn('node', [script, ...args], {
      cwd: TOOLS_DIR,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', chunk => send({ t: 'out', v: chunk.toString() }));
    proc.stderr.on('data', chunk => send({ t: 'err', v: chunk.toString() }));
    proc.on('close',  code => { send({ t: 'done', code }); res.end(); });
    proc.on('error',  err  => {
      send({ t: 'err',  v: `\nProcess error: ${err.message}\n` });
      send({ t: 'done', code: 1 });
      res.end();
    });
    req.on('close', () => { try { proc.kill(); } catch {} });
    return;
  }

  // ── POST /api/save-file ───────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/save-file') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad JSON');
      return;
    }

    const { filePath, data } = body;

    // Only allow writes inside playlist/
    if (typeof filePath !== 'string' || !/^playlist\//.test(filePath)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const fullPath = path.join(ROOT, filePath);
    if (!fullPath.startsWith(ROOT + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.writeFile(fullPath, JSON.stringify(data, null, 4), err => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(err.message);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  // ── POST /api/delete ──────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/delete') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad JSON'); return; }

    const { tab, file, partFile, level, season, trackName } = body;
    const dir = getPlaylistDir(tab);

    if (!dir
      || typeof file !== 'string' || !/^[\w-]+$/.test(file)
      || (partFile && !/^[\w-]+$/.test(partFile))
      || !['title', 'season', 'track'].includes(level)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid request');
      return;
    }

    const dirPath   = path.join(ROOT, dir);
    const mainPath  = path.join(dirPath, file + '.txt');
    const partPath  = partFile ? path.join(dirPath, partFile + '.txt') : null;
    const indexPath = path.join(dirPath, 'index.txt');
    const safe      = p => p.startsWith(dirPath + path.sep);

    if (!safe(mainPath) || (partPath && !safe(partPath))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      const si = Math.max(0, (season || 1) - 1);

      if (level === 'title') {
        // Delete referenced part files (isMainFile format) then main file
        if (fs.existsSync(mainPath)) {
          try {
            const pl = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
            (pl.groups || []).forEach(g => {
              if (g.url) {
                const pf = g.url.split('/').pop();
                const pp = path.join(dirPath, pf);
                if (safe(pp) && pp !== mainPath && fs.existsSync(pp)) fs.unlinkSync(pp);
              }
            });
          } catch {}
          fs.unlinkSync(mainPath);
        }
        removeFromIndex(indexPath, file);

      } else if (level === 'season') {
        if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath);
        if (fs.existsSync(mainPath)) {
          const pl = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
          pl.groups = (pl.groups || []);
          pl.groups.splice(si, 1);
          if (pl.groups.length === 0) {
            fs.unlinkSync(mainPath);
            removeFromIndex(indexPath, file);
          } else {
            fs.writeFileSync(mainPath, JSON.stringify(pl, null, 4));
          }
        }

      } else if (level === 'track') {
        const targetPath = partPath || mainPath;
        if (!fs.existsSync(targetPath)) throw new Error('File not found');
        const pl = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));

        if (partPath) {
          // isMainFile: track is station in part file
          pl.stations = (pl.stations || []).filter(s => s.name !== trackName);
          if (pl.stations.length === 0) {
            fs.unlinkSync(partPath);
            if (fs.existsSync(mainPath)) {
              const mainPl = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
              mainPl.groups = (mainPl.groups || []);
              mainPl.groups.splice(si, 1);
              if (mainPl.groups.length === 0) {
                fs.unlinkSync(mainPath);
                removeFromIndex(indexPath, file);
              } else {
                fs.writeFileSync(mainPath, JSON.stringify(mainPl, null, 4));
              }
            }
          } else {
            fs.writeFileSync(targetPath, JSON.stringify(pl, null, 4));
          }
        } else {
          const seasonGroup = (pl.groups || [])[si];
          if (seasonGroup) {
            if (Array.isArray(seasonGroup.groups)) {
              // Series: track in season.groups
              seasonGroup.groups = seasonGroup.groups.filter(g => g.name !== trackName);
              if (seasonGroup.groups.length === 0) pl.groups.splice(si, 1);
            } else if (Array.isArray(seasonGroup.stations)) {
              // Movie inline: track in part.stations
              seasonGroup.stations = seasonGroup.stations.filter(s => s.name !== trackName);
              if (seasonGroup.stations.length === 0) pl.groups.splice(si, 1);
            }
          }
          if ((pl.groups || []).length === 0) {
            fs.unlinkSync(mainPath);
            removeFromIndex(indexPath, file);
          } else {
            fs.writeFileSync(mainPath, JSON.stringify(pl, null, 4));
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    }
    return;
  }

  // ── GET /api/playlist-files?tab=... ───────────────────────────
  if (req.method === 'GET' && pathname === '/api/playlist-files') {
    const tabKey = parsed.searchParams.get('tab') || '';
    const dir    = getPlaylistDir(tabKey);
    if (!dir) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const dirPath   = path.join(ROOT, dir);
    const indexPath = path.join(dirPath, 'index.txt');

    // Build slug → title map from index.txt
    let nameMap = {};
    try {
      const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      (indexData.groups || []).forEach(g => {
        if (g.url && g.name) {
          const fname = g.url.split('/').pop().replace(/\.txt$/i, '');
          const m     = fname.match(/^(\d+)-(.+)$/);
          const slug  = m ? m[2] : fname;
          nameMap[slug] = g.name;
        }
      });
    } catch {}

    // Build per-part title map from main files (2-file pattern: slug.txt → groups[].url → name)
    // e.g. transformers.txt groups → "38356-transformers" → "Transformers: Dark of the Moon [...]"
    let partNameMap = {};
    try {
      const allFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.txt') && f !== 'index.txt');
      allFiles.forEach(f => {
        const base = f.replace(/\.txt$/, '');
        if (/^\d+-/.test(base)) return; // skip part files (have TMDB prefix)
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
          (data.groups || []).forEach(g => {
            if (g.url && g.name) {
              const partFname = g.url.split('/').pop().replace(/\.txt$/i, '');
              partNameMap[partFname] = g.name;
            }
          });
        } catch {}
      });
    } catch {}

    fs.readdir(dirPath, (err, files) => {
      const list = (err ? [] : files)
        .filter(f => f.endsWith('.txt') && f !== 'index.txt')
        .map(f => {
          const base = f.replace(/\.txt$/, '');
          const m    = base.match(/^(\d+)-(.+)$/);
          const slug   = m ? m[2] : base;
          const tmdbId = m ? m[1] : '';
          return { full: base, slug, tmdbId, name: partNameMap[base] || nameMap[slug] || '' };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    });
    return;
  }

  // ── GET /api/custom-tabs ────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/custom-tabs') {
    try {
      const data = fs.readFileSync(CUSTOM_TABS_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // ── POST /api/add-category ────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/add-category') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad JSON'); return; }

    const { key, name, kind, image } = body;
    if (!key || !name || !['series', 'movie'].includes(kind)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid: need key, name, kind (series|movie)');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(key)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid key: use lowercase a-z, 0-9, hyphens only');
      return;
    }

    // Check no collision with built-in
    if (PLAYLIST_DIRS[key]) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('Key already exists as built-in');
      return;
    }

    // Read existing customs
    let customs = [];
    try { customs = JSON.parse(fs.readFileSync(CUSTOM_TABS_PATH, 'utf-8')); } catch {}
    if (customs.find(c => c.key === key)) {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('Key already exists');
      return;
    }

    const dir = `playlist/${key}`;
    const dirPath = path.join(ROOT, dir);
    const tmdbKind = kind === 'series' ? 'tv' : 'movie';

    // Create directory
    fs.mkdirSync(dirPath, { recursive: true });

    // Create empty index.txt
    const indexData = { name, image: image || '', groups: [] };
    fs.writeFileSync(path.join(dirPath, 'index.txt'), JSON.stringify(indexData, null, 4));

    // Save to custom-tabs.json
    customs.push({ key, name, dir, kind, tmdbKind });
    fs.writeFileSync(CUSTOM_TABS_PATH, JSON.stringify(customs, null, 2));

    // Add to main.txt so Player homepage shows it
    const mainPath = path.join(ROOT, 'playlist', 'main.txt');
    try {
      const mainData = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      const indexUrl = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${dir}/index.txt`;
      const exists = mainData.groups.some(g => g.url === indexUrl);
      if (!exists) {
        mainData.groups.push({ name, image: image || '', url: indexUrl });
        fs.writeFileSync(mainPath, JSON.stringify(mainData, null, 2));
      }
    } catch (e) { console.error('Failed to update main.txt:', e.message); }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tab: customs[customs.length - 1] }));
    return;
  }

  // ── POST /api/delete-category ─────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/delete-category') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad JSON'); return; }

    const { key } = body;
    if (!key || PLAYLIST_DIRS[key]) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Cannot delete built-in or invalid key');
      return;
    }

    let customs = [];
    try { customs = JSON.parse(fs.readFileSync(CUSTOM_TABS_PATH, 'utf-8')); } catch {}
    customs = customs.filter(c => c.key !== key);
    fs.writeFileSync(CUSTOM_TABS_PATH, JSON.stringify(customs, null, 2));

    // Remove from main.txt
    const mainPath = path.join(ROOT, 'playlist', 'main.txt');
    try {
      const mainData = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      const indexUrl = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/playlist/${key}/index.txt`;
      mainData.groups = mainData.groups.filter(g => g.url !== indexUrl);
      fs.writeFileSync(mainPath, JSON.stringify(mainData, null, 2));
    } catch (e) { console.error('Failed to update main.txt:', e.message); }

    // Delete uploaded cover image (if stored locally in web/images/covers/)
    const catDir = path.join(ROOT, 'playlist', key);
    try {
      const idxPath = path.join(catDir, 'index.txt');
      const idxData = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
      if (idxData.image) {
        // Match local covers: /web/images/covers/xxx or full GitHub raw URL pointing to web/images/covers/
        const coverPrefix = '/web/images/covers/';
        const rawPrefix = 'https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/web/images/covers/';
        let coverFile = null;
        if (idxData.image.startsWith(coverPrefix)) coverFile = idxData.image.slice(coverPrefix.length);
        else if (idxData.image.startsWith(rawPrefix)) coverFile = idxData.image.slice(rawPrefix.length);
        if (coverFile) {
          const coverPath = path.join(ROOT, 'web', 'images', 'covers', coverFile);
          if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
        }
      }
    } catch {}

    // Delete playlist folder (playlist/{key}/)
    try { fs.rmSync(catDir, { recursive: true, force: true }); } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  // ── POST /api/upload-image ─────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/upload-image') {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('No boundary'); return;
    }
    const boundary = boundaryMatch[1];

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    // Parse multipart: find the file part
    const boundaryBuf = Buffer.from('--' + boundary);
    let start = 0;
    let fileData = null;
    let origName = 'upload.png';

    while (start < buf.length) {
      const idx = buf.indexOf(boundaryBuf, start);
      if (idx === -1) break;
      const headerEnd = buf.indexOf('\r\n\r\n', idx);
      if (headerEnd === -1) break;
      const headers = buf.slice(idx, headerEnd).toString();
      const nextBound = buf.indexOf(boundaryBuf, headerEnd + 4);
      if (nextBound === -1) break;

      if (headers.includes('filename=')) {
        const fnMatch = headers.match(/filename="([^"]+)"/);
        if (fnMatch) origName = fnMatch[1];
        // data is between headerEnd+4 and nextBound-2 (strip trailing \r\n)
        fileData = buf.slice(headerEnd + 4, nextBound - 2);
      }
      start = nextBound + boundaryBuf.length;
    }

    if (!fileData) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('No file found'); return;
    }

    // Determine extension from original filename
    const ext = path.extname(origName).toLowerCase() || '.png';
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
    if (!allowed.includes(ext)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('File type not allowed'); return;
    }

    // Save to web/images/covers/ with UUID filename
    const destDir = path.join(ROOT, 'web', 'images', 'covers');
    fs.mkdirSync(destDir, { recursive: true });

    const { randomUUID } = require('crypto');
    const uuid = randomUUID();
    const saveName = uuid + ext;
    const destPath = path.join(destDir, saveName);
    fs.writeFileSync(destPath, fileData);

    const publicUrl = `/web/images/covers/${saveName}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: publicUrl, filename: saveName }));
    return;
  }

  // ── Static files ──────────────────────────────────────────────
  if (pathname === '/') {
    res.writeHead(302, { Location: '/web/' });
    res.end();
    return;
  }

  let filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // If directory → try index.html
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {}

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const line = '─'.repeat(42);
  console.log(`\n  ${line}`);
  console.log(`  IPTV Player  —  Local Dev Server`);
  console.log(`  ${line}`);
  console.log(`  Player :  http://localhost:${PORT}/web/`);
  console.log(`  CMS    :  http://localhost:${PORT}/web/cms/`);
  console.log(`  ${line}\n`);
});
