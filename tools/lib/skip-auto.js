/**
 * ตรวจ OP/ED/intro อัตโนมัติหลัง fetch (ใช้โดย server.js) — รัน tools/skip-audit.py เบื้องหลังทีละงาน
 *
 * - เฉพาะ tab ใน SKIP_TABS และไม่ใช่ --update-meta
 * - ตอนที่ตรวจ = station ที่ยังไม่มี skip และ (URL ไม่อยู่ในไฟล์ก่อน fetch หรืออยู่ใน season/track ที่ fetch เขียน
 *   ตาม --season + --track; โหมดหลาย season ใช้เฉพาะ URL ใหม่) — ค่าที่ fetch ยกมาจากไฟล์เดิมไม่ถูกแตะ
 * - เพดาน MAX_EPISODES ต่องาน: ตอน URL ใหม่ตรวจเสมอ ตอนเก่าที่ยังว่างรวมเข้ามาเฉพาะเมื่อรวมแล้วไม่เกินเพดาน
 * - 1 ไฟล์มีงานตรวจได้ทีละงาน: fetch ใหม่ของไฟล์ที่มีงานค้าง (รอคิว / กำลัง report) → ยกเลิกงานเดิม รวมตอนเข้างานใหม่
 *   (งานที่อยู่ขั้น apply ปล่อยให้จบ; ตอนที่รอ quota worker แยกไว้)
 * - ตอนที่ตรวจแล้วไม่พบ op/ed/intro เลย → apply --mark-none เขียน skip {source: 'audit', segments: []} กันตรวจซ้ำ
 * - report ทุก track ของ season ที่มีตอนใหม่ (ให้ skip-audit เทียบพากย์/ซับได้) แล้ว apply --fill ทีละ track เฉพาะตอนใหม่
 * - apply ไม่เริ่มระหว่างที่ fetch ไฟล์เดียวกันรันอยู่ และ fetch/save ไฟล์นั้นต้องรอ apply จบ (beginFetch / withFile)
 * - ค่าที่เติมได้ skip.source = 'audit' (CMS เขียนเป็น 'manual' เมื่อผู้ใช้กดบันทึก)
 * - ตอนใหม่ที่ report ตรวจไม่ได้ในขณะที่ CF worker ตอบ 429 (quota รายวันหมด) → แยกเฉพาะตอนนั้นไปตรวจหลัง quota reset (00:00 UTC)
 *   ไม่ลองซ้ำถี่ๆ เพราะจะกิน quota ที่ player ใช้เล่น (skip-audit ดึงตรงจากเครื่องได้หลาย host จึงดูจากผล report ไม่เดาจาก URL)
 * - คิว + ประวัติเก็บใน tools/.skip-audit-cache/auto/queue.json — restart server แล้วงานไม่หาย
 * - status() เทียบรายการ ต้องดู/ตรวจไม่ได้/ไม่พบ กับไฟล์ปัจจุบัน → ติด resolved เมื่อผู้ใช้จัดการแล้ว (กรอกช่วง / ยืนยันว่าไม่มี)
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { episodeLabelOf } = require('./skip-times');
const { TRACK_MAP, matchesSeasonName } = require('./utils');
const { resolvePlaylistFile } = require('./playlist-io');

const SKIP_TABS = new Set(['anime-series']);
const MAX_EPISODES = 30;
const MAX_ATTEMPTS = 3;
const HISTORY_SIZE = 20;
const REPORT_TIMEOUT_MS = 30 * 60 * 1000;
const APPLY_TIMEOUT_MS = 60 * 1000;
const WAIT_POLL_MS = 1000;
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];
const KINDS = ['op', 'ed', 'intro'];
const KIND_SEGMENT_TYPES = { op: ['op', 'mixed-op'], ed: ['ed', 'mixed-ed'], intro: ['intro'] };
const WORKER_ORIGIN = 'https://shy-haze-2452.natajrak-p.workers.dev';
const WORKER_RESET_DELAY_MS = 2 * 60 * 1000;

function argValue(args, flag) {
  const a = args.find((x) => typeof x === 'string' && x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : '';
}

/** season/track ที่ fetch ครั้งนี้เขียน — ต้องระบุ --season และ --track และไม่ใช่โหมดหลาย season ไม่งั้น null */
function targetTrackOf(args) {
  if (args.includes('--multi-season') || argValue(args, '--season-map')) return null;
  const seasonNum = parseInt(argValue(args, '--season'), 10);
  const trackArg = argValue(args, '--track');
  if (!Number.isFinite(seasonNum) || !trackArg) return null;
  return { season: seasonNum === 0 ? 'Specials' : `Season ${seasonNum}`, track: TRACK_MAP[trackArg] || trackArg };
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
  let activeProc = null;
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
      activeProc = proc;
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => killTree(proc), timeoutMs);
      proc.stdout.on('data', (c) => { stdout += c; });
      proc.stderr.on('data', (c) => { stderr += c; });
      const done = (result) => {
        clearTimeout(timer);
        if (activeProc === proc) activeProc = null;
        resolve(result);
      };
      proc.on('error', (err) => done({ code: -1, stdout, stderr: stderr + err.message }));
      proc.on('close', (code) => done({ code, stdout, stderr }));
    });
  }

  /** หยุด python พร้อม ffmpeg/ffprobe ที่มันเรียก (process ลูกโดยตรง) */
  function killTree(proc) {
    try {
      spawnSync('pkill', ['-TERM', '-P', String(proc.pid)]);
    } catch {}
    try {
      proc.kill();
    } catch {}
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

  const countEpisodes = (byTrack) => [...byTrack.values()].reduce((n, s) => n + s.size, 0);

  /**
   * ตอนที่ยังไม่มี skip แยกตาม track: Map<trackName, Set<label>> (label เดียวกับที่ skip-audit apply --episodes ใช้)
   * - fresh: URL ใหม่ (ไม่อยู่ในไฟล์ก่อน fetch)
   * - old: URL เดิม แต่อยู่ใน season/track ที่ fetch เขียน
   */
  function findCandidates(playlist, knownUrls, target) {
    const fresh = new Map();
    const old = new Map();
    const inTarget = (season, track) => !!target && track.name === target.track && matchesSeasonName(season.name, target.season);
    for (const { season, track, trackName, idx, station } of walkStations(playlist)) {
      if (station.skip || !station.url) continue;
      const known = knownUrls.has(station.url);
      if (known && !inTarget(season, track)) continue;
      const bucket = known ? old : fresh;
      if (!bucket.has(trackName)) bucket.set(trackName, new Set());
      bucket.get(trackName).add(episodeLabelOf(station) || `#${idx}`);
    }
    return { fresh, old };
  }

  const mapToList = (m) => [...(m || new Map())].map(([t, labels]) => [t, [...labels]]);
  const listToMap = (list) => new Map((list || []).map(([t, labels]) => [t, new Set(labels)]));
  const toStored = (job) => ({ ...job, tracks: mapToList(job.tracks), fresh: mapToList(job.fresh), old: mapToList(job.old) });
  const fromStored = (job) => {
    const tracks = listToMap(job.tracks);
    return { ...job, tracks, fresh: job.fresh ? listToMap(job.fresh) : new Map(tracks), old: listToMap(job.old) };
  };

  /** เขียนคิว (รวมงานที่กำลังรัน — โหลดกลับมาเป็น queued) + ประวัติ ลงไฟล์ */
  function persist() {
    const data = {
      seq,
      queue: [running, ...queue].filter((j) => j && !j.cancelled).map(toStored),
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
      queue.push({ none: [], ...job, status: job.status === 'waiting' && job.notBefore ? 'waiting' : 'queued', phase: null });
    }
    history.push(...(data.history || []).slice(0, HISTORY_SIZE).map((j) => ({ none: [], ...fromStored(j) })));
  }

  /**
   * งานใหม่ — fresh/old คือตอนผู้สมัครของงาน (ตอน URL ใหม่ / ตอนเก่าที่ยังว่าง) ส่วน tracks คือตอนที่จะตรวจจริงตาม planJob
   */
  function newJob(file, { fresh = new Map(), old = new Map(), ...extra } = {}) {
    const job = {
      id: ++seq,
      file,
      fileRel: rel(file),
      name: '',
      tracks: new Map(),
      fresh,
      old,
      status: 'queued',
      phase: null,
      attempts: 0,
      message: '',
      filled: [],
      review: [],
      errors: [],
      none: [],
      applied: [],
      note: '',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      ...extra,
    };
    planJob(job);
    return job;
  }

  const mergeTracks = (target, tracks) => {
    for (const [track, labels] of tracks) {
      if (!target.has(track)) target.set(track, new Set());
      for (const l of labels) target.get(track).add(l);
    }
  };

  /** tracks ที่ไม่อยู่ใน covered */
  const subtractTracks = (tracks, covered) => {
    const out = new Map();
    for (const [track, labels] of tracks) {
      const rest = [...labels].filter((l) => !covered.get(track)?.has(l));
      if (rest.length) out.set(track, new Set(rest));
    }
    return out;
  };

  /** ตอนที่จะตรวจ = fresh ทั้งหมด + old ถ้ารวมแล้วไม่เกิน MAX_EPISODES (ไม่งั้นติด note ถ้า fresh เองไม่เกินเพดาน) */
  function planJob(job) {
    const oldOnly = subtractTracks(job.old, job.fresh);
    const tracks = new Map();
    mergeTracks(tracks, job.fresh);
    job.note = '';
    if (countEpisodes(tracks) + countEpisodes(oldOnly) <= MAX_EPISODES) {
      mergeTracks(tracks, oldOnly);
    } else if (oldOnly.size && countEpisodes(tracks) <= MAX_EPISODES) {
      job.note = `ตอนเก่าที่ยังไม่มี OP/ED ${countEpisodes(oldOnly)} ตอน (${[...oldOnly.keys()].join(', ')}) เกินเพดาน ${MAX_EPISODES} — ตรวจเฉพาะตอนใหม่ (ตอนเก่าใช้ skip-audit เอง)`;
    }
    job.tracks = tracks;
  }

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
    job.tracks = subtractTracks(job.tracks, failed);
    job.fresh = subtractTracks(job.fresh, failed);
    job.old = subtractTracks(job.old, failed);
    const waiting = queue.find((j) => j.file === job.file && j.status === 'waiting');
    const notBefore = waiting?.notBefore || nextWorkerReset();
    const message = `CF worker quota หมด (429) — เลื่อนไปตรวจ ${toBangkokTime(notBefore)}`;
    if (waiting) {
      mergeTracks(waiting.fresh, failed);
      planJob(waiting);
    } else {
      queue.push(newJob(job.file, { fresh: failed, name: job.name, status: 'waiting', notBefore, message }));
    }
    log(`waiting ${job.file} — ${countEpisodes(failed)} ตอน — ${message}`);
    return `เลื่อน ${countEpisodes(failed)} ตอนที่ตรวจไม่ได้ (CF worker quota หมด) ไปตรวจ ${toBangkokTime(notBefore)}`;
  }

  const indexCache = new Map();

  /** station ของไฟล์ตาม `${track}|${label}` (label ซ้ำใน track = null) — อ่านใหม่เมื่อ mtime/ขนาดไฟล์เปลี่ยน */
  function stationIndex(file) {
    let stamp;
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
    const hit = indexCache.get(file);
    if (hit && hit.stamp === stamp) return hit.index;
    const index = new Map();
    for (const { trackName, idx, station } of walkStations(readPlaylist(file))) {
      const key = `${trackName}|${episodeLabelOf(station) || `#${idx}`}`;
      index.set(key, index.has(key) ? null : station);
    }
    indexCache.set(file, { stamp, index });
    return index;
  }

  /**
   * สถานะปัจจุบันในไฟล์ของรายการ ต้องดู/ตรวจไม่ได้/ไม่พบ — null = ยังไม่ได้จัดการ
   * - มี kind: มีช่วงชนิดนั้นแล้ว → {start, end, type, source}; skip.none มีชนิดนั้น หรือ manual ที่ไม่มีช่วงเลย → {none: true}
   * - ไม่มี kind: ผู้ใช้บันทึกค่าตอนนั้นแล้ว (source manual) → {manual: true}
   */
  function resolutionOf(index, item) {
    const skip = index?.get(`${item.track}|${item.label}`)?.skip;
    if (!skip) return null;
    const segs = skip.segments || [];
    if (!item.kind) return skip.source === 'manual' ? { manual: true } : null;
    const seg = segs.find((x) => KIND_SEGMENT_TYPES[item.kind]?.includes(x.type));
    if (seg) return { start: seg.start, end: seg.end, type: seg.type, source: skip.source };
    if ((skip.none || []).includes(item.kind) || (skip.source === 'manual' && !segs.length)) return { none: true };
    return null;
  }

  /** publicJob + resolved ของรายการที่ต้องให้คนจัดการ (เทียบกับไฟล์ตอนนี้) */
  function publicJobWithResolution(job) {
    const out = publicJob(job);
    const index = stationIndex(job.file);
    const annotate = (items) => (items || []).map((it) => ({ ...it, resolved: resolutionOf(index, it) }));
    out.review = annotate(out.review);
    out.errors = annotate(out.errors);
    out.none = annotate(out.none);
    return out;
  }

  function publicJob(job) {
    const { tracks, file, applied, fresh, old, ...rest } = job;
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
      `ไม่พบ ${job.none.length}`,
      `ตรวจไม่ได้ ${job.errors.length}`,
    ].join(', ');
    log(`${status} ${job.file} — ${detail}${job.message ? ` — ${job.message}` : ''}${job.note ? ` — ${job.note}` : ''}`);
    for (const f of job.filled) log(`  fill   ${f.track} ตอน ${f.label} ${f.kind} ${f.start}-${f.end}`);
    for (const r of job.review) log(`  review ${r.track} ตอน ${r.label}${r.kind ? ` ${r.kind}` : ''}${r.start != null ? ` ${r.start}-${r.end}` : ''} (${r.reason})`);
    for (const n of job.none) log(`  none   ${n.track} ตอน ${n.label}`);
    for (const e of job.errors) log(`  error  ${e.track} ตอน ${e.label} — ${e.error}`);
  }

  const KIND_LABEL = { op: 'OP', ed: 'ED', intro: 'Intro' };

  /**
   * ตอนที่ตรวจไม่พบอะไรเลยแต่ --mark-none ไม่ทำเครื่องหมาย เพราะตอนเดียวกันในแทร็กอื่นของ season มี op/ed/intro
   * หรือตรวจไม่ได้ (ดู _cross_track_evidence ใน skip-audit.py) → รายการ "ต้องดู" พร้อมเวลาจากแทร็กนั้น
   */
  function crossTrackReview(report, tr, label) {
    const items = [];
    for (const other of report.tracks || []) {
      if (other.track === tr.track || other.season !== tr.season) continue;
      const otherName = other.track.split('/').pop();
      for (const row of (other.episodes || []).filter((r) => (r.label || `#${r.idx}`) === label)) {
        if (row.error) {
          items.push({ track: tr.track, label, kind: null, reason: `ตรวจไม่พบ OP/ED และ${otherName}ตรวจไม่ได้ — ดูด้วยตา` });
          continue;
        }
        for (const kind of KINDS) {
          const seg = row[kind]?.existing || row[kind]?.detected;
          if (!seg) continue;
          items.push({ track: tr.track, label, kind, start: seg.start, end: seg.end, reason: `${otherName}มี ${KIND_LABEL[kind]} ช่วงนี้ — แทร็กนี้ตรวจไม่พบ` });
        }
      }
    }
    return items;
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
    const noneKeys = new Set();
    for (const out of applied) {
      for (const m of out.marked || []) {
        const key = `${m.track}|${m.label}`;
        if (noneKeys.has(key)) continue;
        noneKeys.add(key);
        job.none.push({ track: m.track, label: m.label });
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
        const allNone = KINDS.every((k) => !row[k] || row[k].verdict === 'none');
        if (allNone && !noneKeys.has(`${tr.track}|${label}`)) {
          for (const item of crossTrackReview(report, tr, label)) {
            const key = `${item.track}|${item.label}|${item.kind}`;
            if (reviewKeys.has(key)) continue;
            reviewKeys.add(key);
            job.review.push(item);
          }
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
    if (total > MAX_EPISODES) return finish(job, 'skipped', `ต้องตรวจ ${total} ตอน เกินเพดาน ${MAX_EPISODES} — ตรวจด้วย skip-audit เอง`);

    job.phase = 'report';
    await waitNoFetch(job.file);
    if (job.cancelled) return;
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
      if (job.cancelled) return;
      if (rep.code !== 0 || !fs.existsSync(reportPath)) return finish(job, 'failed', `report ล้มเหลว (exit ${rep.code}): ${lastLine(rep.stderr)}`);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      const failed = failedEpisodes(job, report);
      const quotaExceeded = failed.size > 0 && (await workerQuotaExceeded());
      if (job.cancelled) return;
      if (quotaExceeded) job.message = deferEpisodes(job, failed);

      job.phase = 'apply';
      for (const [track, labels] of job.tracks) {
        if (!reportTracks.has(track)) continue;
        const outPath = path.join(workDir, `apply-${job.id}-${applyPaths.length}.json`);
        applyPaths.push(outPath);
        await acquireLock(job.file);
        let res;
        try {
          res = await run(
            ['apply', job.file, reportPath, '--fill', '--mark-none', '--source', 'audit', '--json-out', outPath, '--tracks', track, '--episodes', ...labels],
            APPLY_TIMEOUT_MS,
          );
        } finally {
          locked.delete(job.file);
        }
        if (res.code !== 0) {
          const reason = lastLine(res.stderr) || lastLine(res.stdout);
          if (/รัน report ใหม่/.test(reason) && job.attempts < MAX_ATTEMPTS) {
            requeue(job);
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

  /**
   * ส่งงานกลับเข้าคิวหลัง apply เจอไฟล์เปลี่ยน — ถ้ามีงาน queued ของไฟล์เดียวกันที่รับได้ไม่เกินเพดาน รวมเข้าไปแทน (1 ไฟล์ 1 งาน)
   */
  function requeue(job) {
    job.status = 'queued';
    job.phase = null;
    job.message = 'ไฟล์เปลี่ยนระหว่างตรวจ — รอตรวจใหม่';
    const other = queue.find((j) => j.file === job.file && j.status === 'queued');
    const merged = new Map();
    if (other) {
      mergeTracks(merged, other.tracks);
      mergeTracks(merged, job.tracks);
    }
    if (!other || countEpisodes(merged) > MAX_EPISODES) {
      queue.unshift(job);
      return;
    }
    mergeTracks(other.fresh, job.tracks);
    mergeTracks(other.old, job.old);
    other.old = subtractTracks(other.old, other.fresh);
    other.applied.unshift(...job.applied);
    other.attempts = Math.max(other.attempts, job.attempts);
    planJob(other);
    log(`งาน #${job.id} ${job.file} — ไฟล์เปลี่ยนระหว่างตรวจ รวมเข้างาน #${other.id}`);
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
    running.status = 'running';
    running.message = '';
    persist();
    try {
      await runJob(running);
    } catch (err) {
      if (!running.cancelled) finish(running, 'failed', err.message);
    } finally {
      running = null;
      persist();
      setImmediate(pump);
    }
  }

  /**
   * เข้าคิว — 1 ไฟล์มีงานตรวจได้ทีละงาน
   * - ตอนที่อยู่ในงานรอ quota worker หรือในงานที่กำลัง apply อยู่แล้ว ไม่นับซ้ำ
   * - งานของไฟล์เดียวกันที่รอคิวหรือกำลัง report → ยกเลิก (หยุด process) แล้วรวมเข้างานใหม่ที่ตำแหน่งเดิมในคิว
   *   ตอนที่งานเดิมวางแผนตรวจไว้ (tracks) ถือเป็นตอนที่ต้องตรวจของงานใหม่
   * - ถ้ารวมแล้วตอนที่ต้องตรวจเกินเพดาน → ไม่ยกเลิกงานเดิม แยกตอนใหม่เป็นอีกงาน (ตัดตอนที่งานเดิมมีอยู่แล้วออก)
   * - ถ้างานใหม่ไม่มีตอนเพิ่มจากที่งานเดิมวางแผนไว้ → ไม่ทำอะไร (ไม่หยุดงานเดิมโดยเปล่าประโยชน์)
   */
  function enqueue(file, fresh, old) {
    const handled = new Map();
    for (const j of queue) if (j.file === file && j.status === 'waiting') mergeTracks(handled, j.tracks);
    if (running?.file === file && running.phase === 'apply') mergeTracks(handled, running.tracks);
    const replaced = queue.filter((j) => j.file === file && j.status === 'queued');
    if (running?.file === file && running.phase !== 'apply' && !running.cancelled) replaced.push(running);

    const required = new Map();
    const candidates = new Map();
    for (const j of replaced) {
      mergeTracks(required, j.tracks);
      mergeTracks(candidates, j.old);
    }
    mergeTracks(required, fresh);
    mergeTracks(candidates, old);
    const mergedFresh = subtractTracks(required, handled);
    const mergedOld = subtractTracks(subtractTracks(candidates, mergedFresh), handled);
    const canReplace = replaced.length > 0 && countEpisodes(mergedFresh) <= MAX_EPISODES;

    let jobFresh = mergedFresh;
    let jobOld = mergedOld;
    let jobReplaced = replaced;
    if (!canReplace) {
      const covered = new Map(handled);
      for (const j of replaced) mergeTracks(covered, j.tracks);
      jobFresh = subtractTracks(fresh, covered);
      jobOld = subtractTracks(subtractTracks(old, covered), jobFresh);
      jobReplaced = [];
    }
    const draft = { fresh: jobFresh, old: jobOld, tracks: new Map(), note: '' };
    planJob(draft);
    const planned = new Map();
    for (const j of jobReplaced) mergeTracks(planned, j.tracks);
    if (jobReplaced.length && !subtractTracks(draft.tracks, planned).size) {
      if (draft.note) log(`${file} — ${draft.note} — งานเดิมตรวจตอนชุดนี้อยู่แล้ว ไม่สร้างงานใหม่`);
      return;
    }
    if (!draft.tracks.size) {
      if (draft.note || jobOld.size) log(`${file} — ${draft.note || 'ไม่มีตอนให้ตรวจ'} — ไม่สร้างงาน`);
      return;
    }

    const job = newJob(file, { fresh: jobFresh, old: jobOld });
    let at = jobReplaced.includes(running) ? 0 : queue.length;
    for (const j of jobReplaced) {
      job.name = job.name || j.name;
      job.applied.push(...(j.applied || []));
      if (j === running) {
        j.cancelled = true;
        if (activeProc) killTree(activeProc);
      } else {
        const i = queue.indexOf(j);
        at = Math.min(at, i);
        queue.splice(i, 1);
      }
      log(`ยกเลิกงาน #${j.id} ${file} — รวมเข้างานใหม่ #${job.id}`);
    }
    queue.splice(Math.min(at, queue.length), 0, job);
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
      return { dir, fname, idPrefix, file, track, knownUrls, target: targetTrackOf(args) };
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
      const { fresh, old } = findCandidates(readPlaylist(file), ticket.knownUrls, ticket.target);
      if (fresh.size || old.size) enqueue(file, fresh, old);
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

    /** ล้างประวัติงานที่จบแล้ว (ไม่แตะงานที่รอ/กำลังรัน) */
    clearHistory() {
      const n = history.length;
      history.length = 0;
      persist();
      log(`ล้างประวัติ ${n} งาน`);
    },

    status() {
      return {
        enabled,
        available: available(),
        running: running && !running.cancelled ? publicJob(running) : null,
        queue: queue.map(publicJob),
        recent: history.map(publicJobWithResolution),
      };
    },
  };
}

module.exports = { createSkipAuto, SKIP_TABS };
