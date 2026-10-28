/**
 * ตรวจ OP/ED/intro อัตโนมัติหลัง fetch (ใช้โดย server.js) — รัน tools/skip-audit.py เบื้องหลังทีละงาน
 *
 * - เฉพาะ tab ใน SKIP_TABS และไม่ใช่ --update-meta
 * - ตอนใหม่ = station ที่ URL ไม่อยู่ในไฟล์ก่อน fetch และยังไม่มี skip (ค่าที่ fetch ยกมาจากไฟล์เดิมไม่ถูกแตะ)
 * - report ทุก track ของ season ที่มีตอนใหม่ (ให้ skip-audit เทียบพากย์/ซับได้) แล้ว apply --fill ทีละ track เฉพาะตอนใหม่
 * - apply ไม่เริ่มระหว่างที่ fetch ไฟล์เดียวกันรันอยู่ และ fetch/save ไฟล์นั้นต้องรอ apply จบ (beginFetch / withFile)
 * - ค่าที่เติมได้ skip.source = 'audit' (CMS เขียนเป็น 'manual' เมื่อผู้ใช้กดบันทึก)
 * - ตอนใหม่ที่ report ตรวจไม่ได้ในขณะที่ CF worker ตอบ 429 (quota รายวันหมด) → แยกเฉพาะตอนนั้นไปตรวจหลัง quota reset (00:00 UTC)
 *   ไม่ลองซ้ำถี่ๆ เพราะจะกิน quota ที่ player ใช้เล่น (skip-audit ดึงตรงจากเครื่องได้หลาย host จึงดูจากผล report ไม่เดาจาก URL)
 * - คิว + ประวัติเก็บใน tools/.skip-audit-cache/auto/queue.json — restart server แล้วงานไม่หาย
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { episodeLabelOf } = require('./skip-times');
const { resolvePlaylistFile } = require('./playlist-io');

const SKIP_TABS = new Set(['anime-series']);
const MAX_NEW_EPISODES = 30;
const MAX_ATTEMPTS = 3;
const HISTORY_SIZE = 20;
const REPORT_TIMEOUT_MS = 30 * 60 * 1000;
const APPLY_TIMEOUT_MS = 60 * 1000;
const WAIT_POLL_MS = 1000;
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];
const KINDS = ['op', 'ed', 'intro'];
const WORKER_ORIGIN = 'https://shy-haze-2452.natajrak-p.workers.dev';
const WORKER_RESET_DELAY_MS = 2 * 60 * 1000;

function argValue(args, flag) {
  const a = args.find((x) => typeof x === 'string' && x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : '';
}

function readPlaylist(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function* walkStations(playlist) {
  for (const season of playlist?.groups || []) {
    for (const track of season.groups || []) {
      const stations = track.stations || [];
      for (let idx = 0; idx < stations.length; idx++) {
        yield { season, track, trackName: `${season.name}/${track.name}`, idx, station: stations[idx] };
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** เวลาที่ quota ของ CF worker reset ครั้งถัดไป (00:00 UTC) + เผื่อ */
function nextWorkerReset(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + WORKER_RESET_DELAY_MS;
}

async function workerQuotaExceeded() {
  try {
    const res = await fetch(`${WORKER_ORIGIN}/`, { signal: AbortSignal.timeout(15000) });
    return res.status === 429;
  } catch {
    return false;
  }
}

const toBangkokTime = (ms) => new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });

/**
 * @param {object} opts
 * @param {string} opts.root        root ของ repo
 * @param {(tab: string) => string|null} opts.playlistDirOf  tab → โฟลเดอร์ playlist (relative กับ root)
 */
function createSkipAuto({ root, playlistDirOf }) {
  const toolsDir = path.join(root, 'tools');
  const python = path.join(toolsDir, '.venv-skip', 'bin', 'python');
  const script = path.join(toolsDir, 'skip-audit.py');
  const workDir = path.join(toolsDir, '.skip-audit-cache', 'auto');
  const logPath = path.join(toolsDir, '.skip-audit-cache', 'auto-jobs.log');
  const configPath = path.join(workDir, 'config.json');
  const queuePath = path.join(workDir, 'queue.json');

  const fetching = new Map();
  const locked = new Set();
  const queue = [];
  const history = [];
  let running = null;
  let seq = 0;

  let enabled = true;
  try {
    enabled = JSON.parse(fs.readFileSync(configPath, 'utf-8')).enabled !== false;
  } catch {}

  const available = () => fs.existsSync(python) && fs.existsSync(script);
  const rel = (file) => path.relative(root, file).split(path.sep).join('/');

  function log(line) {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, text);
    } catch {}
    console.log(`[skip-auto] ${line}`);
  }

  function run(args, timeoutMs) {
    return new Promise((resolve) => {
      const env = { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH || ''].join(':'), PYTHONUNBUFFERED: '1' };
      const proc = spawn(python, [script, ...args], { cwd: toolsDir, env });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  const lastLine = (text) => String(text || '').trim().split('\n').pop() || '';

  async function waitNoFetch(file) {
    while ((fetching.get(file) || 0) > 0) await sleep(WAIT_POLL_MS);
  }

  /** จอง lock ทันทีในจังหวะเดียวกับที่เห็นว่าไม่มีใครใช้ไฟล์ (กัน fetch/save แทรกระหว่างเช็คกับจอง) */
  async function acquireLock(file) {
    for (;;) {
      if (!((fetching.get(file) || 0) > 0)) {
        locked.add(file);
        return;
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  async function markBusy(file) {
    while (locked.has(file)) await sleep(100);
    fetching.set(file, (fetching.get(file) || 0) + 1);
  }

  function unmarkBusy(file) {
    const n = (fetching.get(file) || 1) - 1;
    if (n > 0) fetching.set(file, n);
    else fetching.delete(file);
  }

  /** ตอนใหม่แยกตาม track: Map<trackName, Set<label>> (label เดียวกับที่ skip-audit apply --episodes ใช้) */
  function findNewEpisodes(playlist, knownUrls) {
    const byTrack = new Map();
    for (const { trackName, idx, station } of walkStations(playlist)) {
      if (station.skip || !station.url || knownUrls.has(station.url)) continue;
      if (!byTrack.has(trackName)) byTrack.set(trackName, new Set());
      byTrack.get(trackName).add(episodeLabelOf(station) || `#${idx}`);
    }
    return byTrack;
  }

  const countEpisodes = (byTrack) => [...byTrack.values()].reduce((n, s) => n + s.size, 0);

  const toStored = (job) => ({ ...job, tracks: [...job.tracks].map(([t, labels]) => [t, [...labels]]) });
  const fromStored = (job) => ({ ...job, tracks: new Map((job.tracks || []).map(([t, labels]) => [t, new Set(labels)])) });

  /** เขียนคิว (รวมงานที่กำลังรัน — โหลดกลับมาเป็น queued) + ประวัติ ลงไฟล์ */
  function persist() {
    const data = {
      seq,
      queue: [running, ...queue].filter(Boolean).map(toStored),
      history: history.map(toStored),
    };
    try {
      fs.mkdirSync(workDir, { recursive: true });
      fs.writeFileSync(`${queuePath}.tmp`, JSON.stringify(data));
      fs.renameSync(`${queuePath}.tmp`, queuePath);
    } catch (err) {
      console.warn(`[skip-auto] บันทึกคิวไม่สำเร็จ: ${err.message}`);
    }
  }

  function restore() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
    } catch {
      return;
    }
    seq = Number(data.seq) || 0;
    for (const job of (data.queue || []).map(fromStored)) {
      if (!fs.existsSync(job.file)) continue;
      queue.push({ ...job, status: job.status === 'waiting' ? 'waiting' : 'queued', phase: null });
    }
    history.push(...(data.history || []).slice(0, HISTORY_SIZE).map(fromStored));
  }

  function newJob(file, tracks, extra = {}) {
    return {
      id: ++seq,
      file,
      fileRel: rel(file),
      name: '',
      tracks,
      status: 'queued',
      phase: null,
      attempts: 0,
      message: '',
      filled: [],
      review: [],
      errors: [],
      applied: [],
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      ...extra,
    };
  }

  const mergeTracks = (target, tracks) => {
    for (const [track, labels] of tracks) {
      if (!target.has(track)) target.set(track, new Set());
      for (const l of labels) target.get(track).add(l);
    }
  };

  /** ตอนใหม่ที่ report ตรวจไม่ได้ (episodes[].error) แยกตาม track */
  function failedEpisodes(job, report) {
    const failed = new Map();
    for (const tr of report.tracks || []) {
      const labels = job.tracks.get(tr.track);
      if (!labels) continue;
      for (const row of tr.episodes || []) {
        const label = row.label || `#${row.idx}`;
        if (!row.error || !labels.has(label)) continue;
        if (!failed.has(tr.track)) failed.set(tr.track, new Set());
        failed.get(tr.track).add(label);
      }
    }
    return failed;
  }

  /** ย้ายตอนที่ตรวจไม่ได้เพราะ worker quota หมด ไปเป็นงานรอ quota reset (รวมกับงานรอของไฟล์เดียวกัน) */
  function deferEpisodes(job, failed) {
    for (const [track, labels] of failed) {
      const rest = job.tracks.get(track);
      for (const l of labels) rest.delete(l);
      if (!rest.size) job.tracks.delete(track);
    }
    const notBefore = nextWorkerReset();
    const message = `CF worker quota หมด (429) — เลื่อนไปตรวจ ${toBangkokTime(notBefore)}`;
    const waiting = queue.find((j) => j.file === job.file && j.status === 'waiting');
    if (waiting) mergeTracks(waiting.tracks, failed);
    else queue.push(newJob(job.file, failed, { name: job.name, status: 'waiting', notBefore, message }));
    log(`waiting ${job.file} — ${countEpisodes(failed)} ตอน — ${message}`);
    return `เลื่อน ${countEpisodes(failed)} ตอนที่ตรวจไม่ได้ (CF worker quota หมด) ไปตรวจ ${toBangkokTime(notBefore)}`;
  }

  function publicJob(job) {
    const { tracks, file, applied, ...rest } = job;
    return {
      ...rest,
      tracks: [...tracks].map(([track, labels]) => ({ track, episodes: [...labels] })),
      newEpisodes: countEpisodes(tracks),
    };
  }

  function finish(job, status, message) {
    job.status = status;
    job.phase = null;
    job.message = message || job.message || '';
    job.finishedAt = new Date().toISOString();
    history.unshift(job);
    history.length = Math.min(history.length, HISTORY_SIZE);
    const detail = [
      `เติม ${job.filled.length}`,
      `ต้องดู ${job.review.length}`,
      `ตรวจไม่ได้ ${job.errors.length}`,
    ].join(', ');
    log(`${status} ${job.file} — ${detail}${job.message ? ` — ${job.message}` : ''}`);
    for (const f of job.filled) log(`  fill   ${f.track} ตอน ${f.label} ${f.kind} ${f.start}-${f.end}`);
    for (const r of job.review) log(`  review ${r.track} ตอน ${r.label} ${r.kind}${r.start != null ? ` ${r.start}-${r.end}` : ''} (${r.reason})`);
    for (const e of job.errors) log(`  error  ${e.track} ตอน ${e.label} — ${e.error}`);
  }

  /** reason ของแถวที่ skip-audit ไม่เติมเอง (verdict review/missing) */
  function reviewReason(r) {
    if (r.cross_track) return `ไม่ตรงกับ ${r.cross_track}`;
    return r.verdict === 'review' ? 'เสียงคล้ายต่ำ (อาจเป็นเพลงผสมฉาก)' : 'ตอนข้างเคียงยืนยันไม่พอ';
  }

  /**
   * สรุปผลของตอนใหม่จาก report + ผล apply (--json-out) ของทุกรอบ
   * (งานที่ requeue apply track เดิมซ้ำได้ → outlier ซ้ำ จึงนับต่อ track|label|kind ครั้งเดียว)
   */
  function summarize(job, report, applied) {
    const keyOf = (x) => `${x.track}|${x.label}|${x.kind}`;
    const filledKeys = new Set();
    const reviewKeys = new Set();
    for (const out of applied) {
      for (const c of out.changes || []) {
        const item = { track: c.track, label: c.label, kind: c.kind, start: c.start, end: c.end };
        if (c.action !== 'fill' || filledKeys.has(keyOf(item))) continue;
        filledKeys.add(keyOf(item));
        job.filled.push(item);
      }
    }
    for (const out of applied) {
      for (const o of out.outliers || []) {
        const item = { track: o.track, label: o.label, kind: o.kind, start: o.start, end: o.end, reason: 'ความยาวต่างจากตอนอื่น' };
        if (filledKeys.has(keyOf(item)) || reviewKeys.has(keyOf(item))) continue;
        reviewKeys.add(keyOf(item));
        job.review.push(item);
      }
    }
    for (const tr of report.tracks || []) {
      const labels = job.tracks.get(tr.track);
      if (!labels) continue;
      for (const row of tr.episodes || []) {
        const label = row.label || `#${row.idx}`;
        if (!labels.has(label)) continue;
        if (row.error) {
          job.errors.push({ track: tr.track, label, error: row.error });
          continue;
        }
        for (const kind of KINDS) {
          const r = row[kind];
          const key = `${tr.track}|${label}|${kind}`;
          if (!r || filledKeys.has(key) || reviewKeys.has(key)) continue;
          if (r.verdict !== 'review' && r.verdict !== 'missing') continue;
          reviewKeys.add(key);
          const d = r.detected;
          job.review.push({ track: tr.track, label, kind, start: d?.start, end: d?.end, reason: reviewReason(r) });
        }
      }
    }
  }

  async function runJob(job) {
    job.status = 'running';
    job.startedAt = job.startedAt || new Date().toISOString();
    job.attempts++;
    if (!enabled) return finish(job, 'skipped', 'ปิดการตรวจอัตโนมัติอยู่');
    if (!available()) return finish(job, 'skipped', 'ไม่พบ tools/.venv-skip หรือ skip-audit.py');
    const total = countEpisodes(job.tracks);
    if (total > MAX_NEW_EPISODES) return finish(job, 'skipped', `ตอนใหม่ ${total} ตอน เกิน ${MAX_NEW_EPISODES} — ตรวจด้วย skip-audit เอง`);

    job.phase = 'report';
    await waitNoFetch(job.file);
    const playlist = readPlaylist(job.file);
    if (!playlist) return finish(job, 'failed', 'อ่านไฟล์ playlist ไม่ได้');
    job.name = playlist.name || job.name;
    const seasons = new Set();
    for (const { season, trackName } of walkStations(playlist)) if (job.tracks.has(trackName)) seasons.add(season.name);
    const reportTracks = new Set();
    for (const { season, trackName } of walkStations(playlist)) if (seasons.has(season.name)) reportTracks.add(trackName);
    if (!reportTracks.size) return finish(job, 'done', 'ไม่มีตอนใหม่เหลือในไฟล์');

    fs.mkdirSync(workDir, { recursive: true });
    const reportPath = path.join(workDir, `report-${job.id}.json`);
    const applyPaths = [];
    try {
      const rep = await run(['report', job.file, '--out', reportPath, '--workers', '2', '--tracks', ...reportTracks], REPORT_TIMEOUT_MS);
      if (rep.code !== 0 || !fs.existsSync(reportPath)) return finish(job, 'failed', `report ล้มเหลว (exit ${rep.code}): ${lastLine(rep.stderr)}`);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      const failed = failedEpisodes(job, report);
      if (failed.size && (await workerQuotaExceeded())) job.message = deferEpisodes(job, failed);

      job.phase = 'apply';
      for (const [track, labels] of job.tracks) {
        if (!reportTracks.has(track)) continue;
        const outPath = path.join(workDir, `apply-${job.id}-${applyPaths.length}.json`);
        applyPaths.push(outPath);
        await acquireLock(job.file);
        let res;
        try {
          res = await run(
            ['apply', job.file, reportPath, '--fill', '--source', 'audit', '--json-out', outPath, '--tracks', track, '--episodes', ...labels],
            APPLY_TIMEOUT_MS,
          );
        } finally {
          locked.delete(job.file);
        }
        if (res.code !== 0) {
          const reason = lastLine(res.stderr) || lastLine(res.stdout);
          if (/รัน report ใหม่/.test(reason) && job.attempts < MAX_ATTEMPTS) {
            job.status = 'queued';
            job.phase = null;
            job.message = 'ไฟล์เปลี่ยนระหว่างตรวจ — รอตรวจใหม่';
            queue.push(job);
            return;
          }
          return finish(job, 'failed', `apply ล้มเหลว (exit ${res.code}): ${reason}`);
        }
        try {
          job.applied.push(JSON.parse(fs.readFileSync(outPath, 'utf-8')));
        } catch {
          return finish(job, 'failed', 'อ่านผล apply (--json-out) ไม่ได้');
        }
      }
      summarize(job, report, job.applied);
      finish(job, 'done');
    } finally {
      for (const p of [reportPath, ...applyPaths]) fs.rm(p, { force: true }, () => {});
    }
  }

  let wakeTimer = null;

  /** งานถัดไปที่ถึงเวลาแล้ว — งานที่รอ quota worker (notBefore) ตั้ง timer ปลุกไว้ */
  function nextReady() {
    const now = Date.now();
    const i = queue.findIndex((j) => !j.notBefore || j.notBefore <= now);
    if (i >= 0) return queue.splice(i, 1)[0];
    const wake = Math.min(...queue.map((j) => j.notBefore));
    if (Number.isFinite(wake) && !wakeTimer) {
      wakeTimer = setTimeout(() => { wakeTimer = null; void pump(); }, Math.max(1000, wake - now));
    }
    return null;
  }

  async function pump() {
    if (running || !queue.length) return;
    running = nextReady();
    if (!running) return;
    running.notBefore = null;
    persist();
    try {
      await runJob(running);
    } catch (err) {
      finish(running, 'failed', err.message);
    } finally {
      running = null;
      persist();
      setImmediate(pump);
    }
  }

  function enqueue(file, tracks) {
    const pending = queue.find((j) => j.file === file && j.status === 'queued');
    if (pending) mergeTracks(pending.tracks, tracks);
    else queue.push(newJob(file, tracks));
    persist();
    setImmediate(pump);
  }

  restore();
  setImmediate(pump);

  /** ไฟล์ที่ fetch script เขียน: {id}-{slug}.txt ถ้าระบุ --id-prefix/--tmdb-id (เหมือน fetch script) ไม่งั้นค้นแบบ resolvePlaylistFile */
  function resolveOutput(dir, fname, idPrefix) {
    if (idPrefix && fs.existsSync(path.join(dir, `${idPrefix}-${fname}`))) return path.join(dir, `${idPrefix}-${fname}`);
    return path.join(dir, resolvePlaylistFile({ playlistDir: dir, fname }));
  }

  return {
    /**
     * เรียกก่อน spawn fetch script — รอ apply ของไฟล์นั้นจบ แล้วนับว่าไฟล์กำลังถูก fetch
     * คืน ticket (ส่งให้ afterFetch) หรือ null ถ้าไม่ใช่ tab ที่ดูแล
     * --update-meta นับเป็นการเขียนไฟล์ (กัน apply แทรก) แต่ไม่เข้าคิวตรวจ
     * onWait: เรียกครั้งเดียวถ้าต้องรอ apply ของไฟล์นั้น
     */
    async beginFetch(args, onWait = () => {}) {
      if (!Array.isArray(args)) return null;
      const tab = argValue(args, '--type');
      const output = argValue(args, '--output');
      if (!SKIP_TABS.has(tab) || !output || path.basename(output) !== output) return null;
      const dirRel = playlistDirOf(tab);
      if (!dirRel) return null;
      const dir = path.join(root, dirRel);
      const fname = output.endsWith('.txt') ? output : `${output}.txt`;
      const idPrefix = argValue(args, '--id-prefix') || argValue(args, '--tmdb-id');
      let file;
      try {
        file = resolveOutput(dir, fname, idPrefix);
      } catch {
        return null;
      }
      if (locked.has(file)) onWait();
      await markBusy(file);
      const updateMeta = args.some((a) => a === '--update-meta' || String(a).startsWith('--update-meta='));
      const track = enabled && !updateMeta;
      const knownUrls = new Set();
      if (track) for (const { station } of walkStations(readPlaylist(file))) if (station.url) knownUrls.add(station.url);
      return { dir, fname, idPrefix, file, track, knownUrls };
    },

    /** เรียกเมื่อ fetch script จบ — exit 0 แล้วมีตอนใหม่ → เข้าคิว */
    afterFetch(ticket, code) {
      if (!ticket) return;
      unmarkBusy(ticket.file);
      if (code !== 0 || !ticket.track || !enabled) return;
      let file;
      try {
        file = resolveOutput(ticket.dir, ticket.fname, ticket.idPrefix);
      } catch {
        return;
      }
      const tracks = findNewEpisodes(readPlaylist(file), ticket.knownUrls);
      if (tracks.size) enqueue(file, tracks);
    },

    /** เขียนไฟล์ playlist จากที่อื่น (เช่น /api/save-file) — รอ apply จบ และกัน apply แทรกระหว่างเขียน */
    async withFile(file, fn) {
      await markBusy(file);
      try {
        return await fn();
      } finally {
        unmarkBusy(file);
      }
    },

    setEnabled(value) {
      enabled = !!value;
      try {
        fs.mkdirSync(workDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ enabled }));
      } catch {}
      log(`auto ${enabled ? 'เปิด' : 'ปิด'}`);
    },

    status() {
      return {
        enabled,
        available: available(),
        running: running ? publicJob(running) : null,
        queue: queue.map(publicJob),
        recent: history.map(publicJob),
      };
    },
  };
}

module.exports = { createSkipAuto, SKIP_TABS };
