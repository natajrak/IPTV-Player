#!/usr/bin/env python3
"""
skip-audit — ตรวจ/แก้ช่วงข้าม OP/ED (station.skip.segments) ของ anime series ด้วยการวิเคราะห์เสียง

หลักการ: เพลงเปิด/ปิดของ season เดียวกันมีเสียงเหมือนกันทุกตอน
→ ดึงเสียงช่วงต้น (HEAD วินาที) และช่วงท้าย (TAIL วินาที) ของทุกตอนในแทร็ก
→ หา "ช่วงเสียงซ้ำ" ระหว่างตอนข้างเคียง (audio fingerprint แบบ spectral peak pairs)
→ ขอบเขตละเอียดด้วย cosine similarity ของ log-band spectrum เฟรมต่อเฟรม
→ ช่วงซ้ำในหัวตอน = OP, ช่วงซ้ำท้ายตอน = ED

ต้องมี: ffmpeg/ffprobe ใน PATH, Python venv ที่มี numpy + scipy
    python3 -m venv tools/.venv-skip && tools/.venv-skip/bin/pip install numpy scipy

การใช้:
    tools/.venv-skip/bin/python tools/skip-audit.py report playlist/anime/series/XXX.txt [--out report.json]
        พิมพ์ตารางเทียบค่าเดิม vs ค่าที่ตรวจพบ ต่อตอน (ไม่แก้ไฟล์)
    tools/.venv-skip/bin/python tools/skip-audit.py apply playlist/anime/series/XXX.txt report.json --fix [--fill]
        --fix   แก้เวลาของ segment เดิมที่คลาดเกิน tolerance (คงค่า type เดิม เช่น mixed-op)
        --fill  เติม segment ให้ตอนที่ยังไม่มี op/ed แต่ตรวจพบ
        --tracks "Season 1/ซับไทย" [...]   จำกัดเฉพาะ season/track
        --episodes 1 2 3                   จำกัดเฉพาะ label ตอน (ตอนที่ไม่มีเลขใช้ #idx ตามที่ตารางแสดง)
        --kinds op|ed                      จำกัดเฉพาะ OP หรือ ED (default ทั้งคู่; --set ไม่ถูกกรอง)
        --remove "Season 1/ซับไทย|1|op" [...]  ลบ segment op/ed ของตอนนั้น (ค่าเดิมผิดและตรวจไม่พบ เช่น placeholder 0:00-1:30)
        ช่วงที่ยาวต่างจากค่ากลางของแทร็กเกิน 3 วิ จะถูกข้าม (พิมพ์แจ้ง) ต้องยืนยันด้วย --set
        --min-support N                    ใช้เฉพาะ region ที่ตอนข้างเคียงยืนยัน ≥ N ครั้ง (default 2)
        --set "Season 1/พากย์ไทย|1|op=0:52-2:22" [...]   (kind: op | ed | intro = หน้าเปิด/splash ของเว็บต้นทาง)
                                           ค่าที่ผู้ใช้ตรวจด้วยตา ใช้แทนค่าที่ตรวจพบของตอนนั้น (ปรับขอบตามนโยบายให้อัตโนมัติ
                                           ถ้า report มี start_shift/end_shift) — เขียนเสมอไม่สน tolerance/support
        --tolerance S                      ประเมิน ok/fix ใหม่ด้วย tolerance นี้ (default ตาม report)
        --source NAME                      ค่า skip.source เมื่อ --fill/--mark-none ต้องสร้าง skip object ใหม่ (default manual;
                                           job อัตโนมัติใช้ audit = ยังไม่มีคนยืนยัน; --set เขียน manual เสมอ; skip เดิมคง source เดิม)
        --json-out PATH                    เขียนผลแบบ machine-readable {playlist, changes[], outliers[], marked[]} (เขียนแม้ไม่มีอะไรแก้)
        --mark-none                        ตอนที่ตรวจได้แต่ไม่พบ op/ed/intro เลย และยังไม่มี skip → เขียน skip {source: --source, segments: []}
                                           ยกเว้นตอนเดียวกันในแทร็กอื่นของ season (ที่อยู่ใน report) มี op/ed/intro หรือตรวจไม่ได้
                                           (= ตรวจแล้วไม่พบ กัน job อัตโนมัติตรวจซ้ำ; --fill รอบหลังยังเติมทับได้; ถ้าใส่ --kinds จะไม่ mark)
        recap และ type อื่นที่ไม่ใช่ op/ed ไม่ถูกแตะ
        ชนิดที่ผู้ใช้ยืนยันว่าไม่มี (station.skip.none เช่น ["op"] จากช่องติ๊กใน CMS) --fill จะไม่เติม
        (--set ยังเขียนได้ และเอาชนิดนั้นออกจาก none)

ค่าที่ตรวจพบเป็นวินาที ละเอียด 0.1 วิ (hop 32 ms)
intro = หน้าเปิด/splash ของเว็บต้นทางที่หัวไฟล์ (3–29 วิ เริ่มที่ 0:00 ซ้ำกันทุกตอน) ตรวจและเติมให้อัตโนมัติเช่นกัน
    (splash สั้นและเหมือนกันเป๊ะ จึงยอมรับเมื่อมีตอนข้างเคียงยืนยันแค่ 1 ครั้งถ้า sim ≥ 0.9)
    (player รองรับ type 'intro' ตั้งแต่ v66; auto skip ข้ามได้)
นโยบายขอบช่วง (ผู้ใช้กำหนด 2026-10-28): ทั้ง OP และ ED → start +0.5 วิ, end -0.5 วิ (หดเข้าข้างละ 0.5 วิ;
    player เช็คจาก timeupdate ทุก ~250 ms จึงละเอียดพอ)
    --start-shift / --end-shift ของ report ปรับได้ (ค่าที่แสดงและเขียนคือค่าหลังปรับแล้ว)
"""

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import median

import numpy as np
from scipy import ndimage, signal
from scipy.io import wavfile

SR = 8000
N_FFT = 1024
HOP = 256
FPS = SR / HOP
N_BANDS = 64
PEAK_NEIGHBORHOOD = (15, 15)
PEAK_MIN_DB = -45.0
FANOUT = 6
TARGET_MIN_DT = 2
TARGET_MAX_DT = 60
MIN_REGION_SEC = 30.0
MAX_REGION_SEC = 200.0
INTRO_MIN_SEC = 3.0
INTRO_MAX_SEC = 29.0
INTRO_START_MAX_SEC = 1.0
MIN_HASH_HITS = 12
MIXED_SIM = 0.85
SIM_THRESHOLD_MIN = 0.55
SIM_THRESHOLD_MAX = 0.80
SIM_THRESHOLD_DROP = 0.25
SIM_SMOOTH_SEC = 0.8
MAX_DIP_SEC = 3.0
DIP_FLOOR_DROP = 0.15
LENGTH_OUTLIER_SEC = 3.0
TYPICAL_LENGTH_SEC = 90.0
TYPICAL_LENGTH_TOL = 5.0
CROSS_TRACK_TOL = 3.0
MAX_TRACK_SHIFT_SEC = 60.0
SILENCE_FLOOR = float(np.log(1e-9 * 64)) + 1.0
SILENCE_EXTEND_SEC = 2.5
NEIGHBOR_SPAN = 2
DEFAULT_HEAD = 480
DEFAULT_TAIL = 300
DEFAULT_TOLERANCE = 1.5
DEFAULT_START_SHIFT = 0.5
DEFAULT_END_SHIFT = -0.5
RETRIES = 3
RETRY_DELAY_SEC = 5
WORKER_RESOLVE = 'https://shy-haze-2452.natajrak-p.workers.dev/resolve/'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
OP_TYPES = ('op', 'mixed-op')
ED_TYPES = ('ed', 'mixed-ed')
INTRO_TYPES = ('intro',)
KIND_TYPES = {'op': OP_TYPES, 'ed': ED_TYPES, 'intro': INTRO_TYPES}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CACHE = os.path.join(REPO_ROOT, 'tools', '.skip-audit-cache')


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def episode_label(name):
    """label ตอน เช่น "11" หรือ "11(1/2)" — ตรรกะเดียวกับ episodeLabelOf ใน lib/skip-times.js"""
    m = re.search(r'(?:ตอน|Ep\.?)\s*(\d+(?:\s*\(\d+/\d+\))?)', name or '', re.I)
    return re.sub(r'\s+', '', m.group(1)) if m else None


# ---------------------------------------------------------------- stream access

DIRECT_PROXY_HOSTS = ('cdn2.maimeorder.com', 'anime.tonytonychopper.net', 'main.108player.com')
SEGMENT_ONLY_HOSTS = ('cdn2.maimeorder.com',)
FORCE_HLS_HOSTS = ('anime.tonytonychopper.net',)


def _unwrap_proxy(url):
    """URL ที่ห่อผ่าน worker proxy (?url=&referer=) ของ host ที่ origin ตอบ 503 ให้ CF Worker บ่อย
    → ดึงตรงจากเครื่องแทน คืน (inner_url, referer) หรือ None ถ้าไม่เข้าเงื่อนไข"""
    parsed = urllib.parse.urlparse(url)
    if not parsed.netloc.endswith('workers.dev'):
        return None
    q = urllib.parse.parse_qs(parsed.query)
    inner = (q.get('url') or [''])[0]
    if urllib.parse.urlparse(inner).netloc not in DIRECT_PROXY_HOSTS:
        return None
    return inner, (q.get('referer') or [None])[0]


def _resolve_akuma_local(station):
    """akuma-stream (kurokamii / anime-hdzero): หน้า watch มี /api/manifest/{uuid}/master.m3u8?token=... (ลอจิกเดียวกับ resolveAkumaStream ใน worker)
    ดึงจากเครื่องตรง — Referer ต้องเป็น origin ของหน้า watch เอง"""
    origin = '{0.scheme}://{0.netloc}'.format(urllib.parse.urlparse(station['url']))
    html = _http_get(station['url'], origin + '/').decode('utf-8', 'replace')
    m = re.search(r'''src\s*=\s*["']?(/api/manifest/[^"']+\.m3u8\?[^"'\s]+)''', html, re.I)
    if not m:
        raise RuntimeError('ไม่พบ manifest URL ใน watch page')
    return origin + m.group(1), origin + '/'


LOCAL_RESOLVERS = {'kurokamii': _resolve_akuma_local, 'anime-hdzero': _resolve_akuma_local}


def resolve_stream(station):
    """คืน (stream_url, referer_override) — resolver ที่ทำในเครื่องได้ทำก่อน ไม่ได้ค่อยถาม worker /resolve/"""
    resolver = station.get('resolver')
    if not resolver:
        return station['url'], None
    local = LOCAL_RESOLVERS.get(resolver)
    if local:
        try:
            return local(station)
        except Exception as e:
            log(f'    local resolver {resolver} ล้มเหลว ({e}) → ใช้ worker')
    url = WORKER_RESOLVE + resolver + '?url=' + urllib.parse.quote(station['url'], safe='')
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    if not data.get('stream'):
        raise RuntimeError(data.get('error') or 'resolver returned no stream')
    return data['stream'], None


def hls_opts(url):
    """option ของ HLS demuxer (segment ปลอมนามสกุล .webp/.html) — ใส่ไม่ได้กับไฟล์ mp4 ตรง (ffmpeg จะ error 'Option not found')"""
    if re.search(r'\.(mp4|m4v|mkv|webm|mov|avi|ts)(\?|$)', url, re.I) or not url.startswith('http'):
        return []
    opts = ['-allowed_extensions', 'ALL', '-extension_picky', '0']
    if urllib.parse.urlparse(url).netloc in FORCE_HLS_HOSTS:
        opts += ['-f', 'hls']
    return opts


def ff_headers(referer):
    h = f'User-Agent: {UA}\r\n'
    if referer:
        h += f'Referer: {referer}\r\n'
    return h


def probe_duration(url, referer):
    cmd = [
        'ffprobe', '-hide_banner', '-loglevel', 'error',
        *hls_opts(url),
        '-headers', ff_headers(referer),
        '-show_entries', 'format=duration', '-of', 'csv=p=0', url,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError('ffprobe: ' + out.stderr.strip()[-300:])
    return float(out.stdout.strip().splitlines()[-1])


def extract_audio(url, referer, start, length, wav_path):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *hls_opts(url)]
    if url.startswith('http'):
        cmd += ['-headers', ff_headers(referer)]
    if start > 0:
        cmd += ['-ss', f'{start:.3f}']
    cmd += ['-i', url, '-t', f'{length:.3f}', '-vn', '-ac', '1', '-ar', str(SR), '-f', 'wav', wav_path]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if out.returncode != 0 or not os.path.exists(wav_path) or os.path.getsize(wav_path) < 1000:
        raise RuntimeError('ffmpeg: ' + out.stderr.strip()[-300:])


# ---------------------------------------------------------------- fingerprint

def _band_edges():
    """ขอบ bin ของ 64 แถบความถี่แบบ log-spaced 100–3800 Hz (ทุกแถบมีอย่างน้อย 1 bin)"""
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    edges = np.geomspace(100, 3800, N_BANDS + 1)
    idx = np.searchsorted(freqs, edges)
    idx = np.maximum.accumulate(np.maximum(idx, np.arange(len(idx)) + idx[0]))
    return idx


BAND_EDGES = _band_edges()


def analyze_wav(wav_path):
    sr, pcm = wavfile.read(wav_path)
    if sr != SR:
        raise RuntimeError(f'unexpected sample rate {sr}')
    if pcm.ndim > 1:
        pcm = pcm[:, 0]
    x = pcm.astype(np.float32) / 32768.0
    if len(x) < N_FFT * 4:
        raise RuntimeError('audio too short')
    _, _, spec = signal.stft(x, fs=SR, nperseg=N_FFT, noverlap=N_FFT - HOP, window='hann', boundary=None, padded=False)
    mag = np.abs(spec).astype(np.float64)
    logmag = (20 * np.log10(mag + 1e-6)).astype(np.float32)
    logmag -= logmag.max()
    power = (mag ** 2)[:BAND_EDGES[-1]]
    sums = np.add.reduceat(power, BAND_EDGES[:-1], axis=0)
    widths = np.diff(BAND_EDGES)[:, None]
    bands = np.log(sums / widths + 1e-9).T.astype(np.float16)
    peaks = _find_peaks(logmag)
    hashes = _hash_peaks(peaks)
    return {'bands': bands, 'hashes': hashes, 'frames': logmag.shape[1]}


def _find_peaks(logmag):
    local_max = ndimage.maximum_filter(logmag, size=PEAK_NEIGHBORHOOD) == logmag
    mask = local_max & (logmag > PEAK_MIN_DB)
    f, t = np.nonzero(mask)
    order = np.argsort(t, kind='stable')
    return np.stack([t[order], f[order]], axis=1)


def _hash_peaks(peaks):
    """(t, f) → array rows [hash, t]; hash = f1<<20 | f2<<8 | dt"""
    if len(peaks) == 0:
        return np.zeros((0, 2), dtype=np.int64)
    t = peaks[:, 0]
    f = peaks[:, 1]
    out = []
    n = len(peaks)
    for i in range(n):
        t1, f1 = int(t[i]), int(f[i])
        taken = 0
        j = i + 1
        while j < n and taken < FANOUT:
            dt = int(t[j]) - t1
            if dt > TARGET_MAX_DT:
                break
            if dt >= TARGET_MIN_DT:
                h = (f1 << 20) | (int(f[j]) << 8) | dt
                out.append((h, t1))
                taken += 1
            j += 1
    return np.array(out, dtype=np.int64).reshape(-1, 2)


def _smooth(v, win):
    if win <= 1:
        return v
    k = np.ones(win, dtype=np.float32) / win
    return np.convolve(v, k, mode='same')


def frame_similarity(bands_a, bands_b, offset):
    """cosine sim ต่อเฟรมของ A[t] กับ B[t-offset] (ลบค่าเฉลี่ยต่อเฟรม) — คืน array ยาวเท่า A, NaN นอกช่วงซ้อน"""
    a = bands_a.astype(np.float32)
    b = bands_b.astype(np.float32)
    na, nb = len(a), len(b)
    sim = np.full(na, np.nan, dtype=np.float32)
    ta0 = max(0, offset)
    ta1 = min(na, nb + offset)
    if ta1 <= ta0:
        return sim
    sa = a[ta0:ta1]
    sb = b[ta0 - offset:ta1 - offset]
    sa = sa - sa.mean(axis=1, keepdims=True)
    sb = sb - sb.mean(axis=1, keepdims=True)
    num = (sa * sb).sum(axis=1)
    den = np.linalg.norm(sa, axis=1) * np.linalg.norm(sb, axis=1) + 1e-6
    sim[ta0:ta1] = num / den
    return sim


def match_regions(fa, fb, min_sec=MIN_REGION_SEC, max_sec=MAX_REGION_SEC):
    """ช่วงใน A ที่ซ้ำกับ B — คืน list ของ dict(start_f, end_f, offset, hits, sim)
    ไล่จาก offset ที่ hash ตรงกันมากสุด; region ที่ซ้อนกับ region ที่แข็งแรงกว่าแล้ว (เช่น เพลงท่อนซ้ำจับคู่เหลื่อมท่อน) ถูกตัดทิ้ง"""
    ha, hb = fa['hashes'], fb['hashes']
    if len(ha) == 0 or len(hb) == 0:
        return []
    index = defaultdict(list)
    for h, t in hb:
        index[int(h)].append(int(t))
    offsets = defaultdict(list)
    for h, ta in ha:
        tbs = index.get(int(h))
        if not tbs:
            continue
        for tb in tbs:
            offsets[int(ta) - tb].append(int(ta))
    if not offsets:
        return []
    counts = {d: len(ts) for d, ts in offsets.items()}
    regions = []
    used = set()
    for d, c in sorted(counts.items(), key=lambda kv: -kv[1]):
        if c < MIN_HASH_HITS or d in used:
            continue
        if any(abs(d - u) <= 2 for u in used):
            continue
        ts = sorted(t for dd in (d - 2, d - 1, d, d + 1, d + 2) for t in offsets.get(dd, []))
        if len(ts) < MIN_HASH_HITS:
            continue
        used.add(d)
        for cluster in _clusters(ts, gap=int(3 * FPS)):
            if len(cluster) < MIN_HASH_HITS:
                continue
            core0, core1 = cluster[0], cluster[-1]
            if core1 - core0 < 10 * FPS:
                continue
            start_f, end_f, mean_sim = _refine(fa['bands'], fb['bands'], d, core0, core1)
            if end_f - start_f < min_sec * FPS or end_f - start_f > max_sec * FPS:
                continue
            if any(_overlap(r['start_f'], r['end_f'], start_f, end_f) > 0.5 for r in regions):
                continue
            regions.append({'start_f': start_f, 'end_f': end_f, 'offset': d, 'hits': len(cluster), 'sim': float(mean_sim)})
    return regions


def _clusters(ts, gap):
    out = []
    cur = [ts[0]]
    for t in ts[1:]:
        if t - cur[-1] > gap:
            out.append(cur)
            cur = [t]
        else:
            cur.append(t)
    out.append(cur)
    return out


def _refine(bands_a, bands_b, offset, core0, core1):
    """ขอบของช่วงซ้ำ: หา run บน sim ที่ smooth แล้ว (กันเฟรมกระพริบ) → ขยับขอบตาม sim ดิบ (ชดเชยที่ smoothing กินขอบ)
    → ขยายคลุมความเงียบสนิทที่ติดกัน; threshold ปรับตามค่ากลางของ core (เพลงชัด ~0.95 → ~0.7)"""
    sim = frame_similarity(bands_a, bands_b, offset)
    valid = ~np.isnan(sim)
    s = np.where(valid, sim, 0.0)
    s = _smooth(s, int(SIM_SMOOTH_SEC * FPS))
    core = float(np.nanmedian(sim[core0:core1 + 1]))
    threshold = min(SIM_THRESHOLD_MAX, max(SIM_THRESHOLD_MIN, core - SIM_THRESHOLD_DROP))
    above = (s > threshold) & valid
    mid = (core0 + core1) // 2
    if not above[mid]:
        idx = np.nonzero(above[core0:core1 + 1])[0]
        if len(idx) == 0:
            return core0, core1, float(np.nanmean(sim[core0:core1 + 1]))
        mid = core0 + idx[len(idx) // 2]
    dip_ok = valid & (s > max(0.45, threshold - DIP_FLOOR_DROP))
    lo = _walk(above, dip_ok, mid, -1)
    hi = _walk(above, dip_ok, mid, +1)
    raw_above = valid & (np.where(valid, sim, 0.0) > threshold)
    while lo > 0 and raw_above[lo - 1]:
        lo -= 1
    while hi + 1 < len(raw_above) and raw_above[hi + 1]:
        hi += 1
    lo, hi = _extend_over_silence(bands_a, lo, hi)
    return lo, hi, float(np.nanmean(sim[lo:hi + 1]))


def _walk(above, dip_ok, start, step):
    """เดินจาก start ไปทาง step ขณะที่ above เป็นจริง ยอมข้าม "หลุมตื้น" (เฟรมที่ไม่ผ่าน threshold แต่ยังผ่าน dip_ok)
    ที่สั้นกว่า MAX_DIP_SEC เช่น เสียงพากย์ชื่อเรื่องทับเพลง — หลุมลึก (เงียบ/ฉาก) ไม่ข้าม — คืนตำแหน่งสุดท้ายที่ above เป็นจริง"""
    max_dip = int(MAX_DIP_SEC * FPS)
    n = len(above)
    pos = start
    while True:
        nxt = pos + step
        if nxt < 0 or nxt >= n:
            return pos
        if above[nxt]:
            pos = nxt
            continue
        probe = nxt
        gap = 0
        while 0 <= probe < n and not above[probe] and dip_ok[probe] and gap < max_dip:
            probe += step
            gap += 1
        if 0 <= probe < n and above[probe]:
            pos = probe
        else:
            return pos


def _extend_over_silence(bands, lo, hi):
    """ความเงียบสนิทที่ติดกับช่วงเพลง (fade-in/out, ภาพยังเล่นอยู่) นับเป็นส่วนของช่วงด้วย — ขยายได้ไม่เกิน SILENCE_EXTEND_SEC"""
    total = np.log(np.exp(bands.astype(np.float32)).sum(axis=1))
    quiet = total < SILENCE_FLOOR
    limit = int(SILENCE_EXTEND_SEC * FPS)
    n = 0
    while lo > 0 and quiet[lo - 1] and n < limit:
        lo -= 1
        n += 1
    n = 0
    while hi + 1 < len(quiet) and quiet[hi + 1] and n < limit:
        hi += 1
        n += 1
    return lo, hi


# ---------------------------------------------------------------- per-episode features (with cache)

def station_key(station):
    return hashlib.sha1(station['url'].encode('utf-8')).hexdigest()[:16]


def _load_cache(path, head, tail):
    try:
        with np.load(path, allow_pickle=False) as z:
            if float(z['head']) != head or float(z['tail']) != tail:
                return None
            return {
                'duration': float(z['duration']),
                'tail_offset': float(z['tail_offset']),
                'head': {'bands': z['head_bands'], 'hashes': z['head_hashes'], 'frames': int(z['head_frames'])},
                'tail': {'bands': z['tail_bands'], 'hashes': z['tail_hashes'], 'frames': int(z['tail_frames'])},
            }
    except Exception:
        os.remove(path)
        return None


EMPTY_FEATURES = {'bands': np.zeros((0, N_BANDS), dtype=np.float16), 'hashes': np.zeros((0, 2), dtype=np.int64), 'frames': 0}


def _fetch_features(station, head, tail):
    url, referer = resolve_stream(station)
    referer = referer or station.get('referer')
    direct = _unwrap_proxy(url)
    if direct:
        url, referer = direct[0], direct[1] or referer
    segment_only = urllib.parse.urlparse(url).netloc in SEGMENT_ONLY_HOSTS
    with tempfile.TemporaryDirectory() as td:
        hw = os.path.join(td, 'h.wav')
        tw = os.path.join(td, 't.wav')
        try:
            if segment_only:
                raise RuntimeError('does not contain any stream (direct segment fetch)')
            duration = probe_duration(url, referer)
            tail_offset = max(0.0, duration - tail)
            extract_audio(url, referer, 0, min(head, duration), hw)
            if tail_offset > 0:
                extract_audio(url, referer, tail_offset, tail + 5, tw)
        except RuntimeError as e:
            if hls_opts(url) == [] or 'does not contain any stream' not in str(e) and 'received no packets' not in str(e):
                raise
            duration, tail_offset = _extract_via_segments(url, referer, head, tail, hw, tw)
        fh = analyze_wav(hw)
        ft = analyze_wav(tw) if tail_offset > 0 else dict(EMPTY_FEATURES)
    return duration, tail_offset, fh, ft


def _http_get(url, referer, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA, **({'Referer': referer} if referer else {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _parse_m3u8(text, base):
    if text.startswith('{"p":"'):
        text = base64.b64decode(json.loads(text)['p']).decode('utf-8', 'replace')
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if any(l.startswith('#EXT-X-STREAM-INF') for l in lines):
        variants = []
        for i, l in enumerate(lines):
            if l.startswith('#EXT-X-STREAM-INF'):
                m = re.search(r'BANDWIDTH=(\d+)', l)
                nxt = next((x for x in lines[i + 1:] if not x.startswith('#')), None)
                if nxt:
                    variants.append((int(m.group(1)) if m else 0, urllib.parse.urljoin(base, nxt)))
        return 'master', sorted(variants)
    segs = []
    dur = None
    for l in lines:
        if l.startswith('#EXTINF:'):
            dur = float(l[8:].split(',')[0])
        elif not l.startswith('#') and dur is not None:
            segs.append((dur, urllib.parse.urljoin(base, l)))
            dur = None
    return 'media', segs


def _strip_to_ts(data):
    """segment ปลอมนามสกุล (.webp/.html) บางเจ้าแปะรูปจริงไว้หน้า TS — ตัดทิ้งถึง sync byte 0x47 ตัวแรกที่ซ้ำทุก 188 ไบต์"""
    n = len(data)
    i = data.find(b'\x47')
    while 0 <= i < n - 376:
        if data[i + 188] == 0x47 and data[i + 376] == 0x47:
            return data[i:]
        i = data.find(b'\x47', i + 1)
    return data


def _extract_via_segments(url, referer, head, tail, hw, tw):
    """fallback เมื่อ ffmpeg เปิด HLS ตรงไม่ได้ (segment ปลอมเป็นรูป): โหลด segment เองจาก variant ที่เล็กที่สุด
    ตัด header ปลอม ต่อเป็น .ts แล้วค่อยให้ ffmpeg แปลงเสียง — ความยาว/offset คำนวณจาก EXTINF"""
    kind, items = _parse_m3u8(_http_get(url, referer).decode('utf-8', 'replace'), url)
    if kind == 'master':
        if not items:
            raise RuntimeError('master playlist ไม่มี variant')
        url = items[0][1]
        kind, items = _parse_m3u8(_http_get(url, referer).decode('utf-8', 'replace'), url)
    if not items:
        raise RuntimeError('media playlist ไม่มี segment')
    duration = sum(d for d, _ in items)
    head_segs, cum = [], 0.0
    for d, u in items:
        if cum >= head:
            break
        head_segs.append(u)
        cum += d
    tail_offset = max(0.0, duration - tail)
    tail_segs, cum, tail_start = [], 0.0, 0.0
    for d, u in items:
        if cum + d > tail_offset and tail_offset > 0:
            if not tail_segs:
                tail_start = cum
            tail_segs.append(u)
        cum += d
    if tail_offset == 0:
        tail_segs = []
    def decode(seg_url):
        """ถอดเสียงทีละ segment (timestamp ของแต่ละ segment อาจเริ่มใหม่ที่ 0 ต่อกันเป็นไฟล์เดียวไม่ได้) → PCM s16le mono 8 kHz"""
        data = _strip_to_ts(_http_get(seg_url, referer))
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', str(SR), '-f', 's16le', 'pipe:1']
        out = subprocess.run(cmd, input=data, capture_output=True, timeout=120)
        if out.returncode != 0 or len(out.stdout) < 2 * SR:
            raise RuntimeError('ffmpeg segment: ' + out.stderr.decode('utf-8', 'replace').strip()[-200:])
        return out.stdout

    def build(segs, out_wav):
        with ThreadPoolExecutor(max_workers=4) as ex:
            parts = list(ex.map(decode, segs))
        pcm = np.frombuffer(b''.join(parts), dtype=np.int16)
        wavfile.write(out_wav, SR, pcm)

    build(head_segs, hw)
    if tail_segs:
        build(tail_segs, tw)
        return duration, tail_start
    return duration, 0.0


def load_or_build(station, head, tail, cache_dir):
    key = station_key(station)
    path = os.path.join(cache_dir, key + '.npz')
    if os.path.exists(path):
        cached = _load_cache(path, head, tail)
        if cached:
            return cached
    last_err = None
    for attempt in range(RETRIES):
        try:
            duration, tail_offset, fh, ft = _fetch_features(station, head, tail)
            break
        except Exception as e:
            last_err = e
            time.sleep(RETRY_DELAY_SEC * (attempt + 1))
    else:
        raise last_err
    tmp = path + f'.{os.getpid()}.tmp.npz'
    np.savez(
        tmp, head=head, tail=tail, duration=duration, tail_offset=tail_offset,
        head_bands=fh['bands'], head_hashes=fh['hashes'], head_frames=fh['frames'],
        tail_bands=ft['bands'], tail_hashes=ft['hashes'], tail_frames=ft['frames'],
    )
    os.replace(tmp, path)
    return {'duration': duration, 'tail_offset': tail_offset, 'head': fh, 'tail': ft}


# ---------------------------------------------------------------- series-level detection

def detect_track(episodes, feats, start_shift=0.0, end_shift=0.0):
    """episodes: list of dict(label, station); feats: dict label→features (or None)
    คืน dict label → {'op': (start,end,support) | None, 'ed': ... }"""
    n = len(episodes)
    result = {}
    for i, ep in enumerate(episodes):
        fi = feats.get(ep['idx'])
        if not fi:
            result[ep['idx']] = {'op': None, 'ed': None, 'error': ep.get('error') or 'no features'}
            continue
        head_regions = []
        tail_regions = []
        intro_regions = []
        my_key = station_key(ep['station'])
        neighbors = [j for j in range(i - NEIGHBOR_SPAN, i + NEIGHBOR_SPAN + 1) if 0 <= j < n and j != i]
        compared = 0
        for j in neighbors:
            fj = feats.get(episodes[j]['idx'])
            if not fj or station_key(episodes[j]['station']) == my_key:
                continue
            compared += 1
            for r in match_regions(fi['head'], fj['head'], INTRO_MIN_SEC, INTRO_MAX_SEC):
                if r['start_f'] / FPS <= INTRO_START_MAX_SEC:
                    intro_regions.append((r['start_f'] / FPS, r['end_f'] / FPS, r['sim']))
            for other in (fj['head'], fj['tail']):
                for r in match_regions(fi['head'], other):
                    head_regions.append((r['start_f'] / FPS, r['end_f'] / FPS, r['sim']))
                for r in match_regions(fi['tail'], other):
                    s = fi['tail_offset'] + r['start_f'] / FPS
                    e = fi['tail_offset'] + r['end_f'] / FPS
                    tail_regions.append((s, e, r['sim']))
        if compared == 0:
            result[ep['idx']] = {'op': None, 'ed': None, 'error': 'ไม่มีตอนข้างเคียงให้เทียบ', 'duration': fi['duration']}
            continue
        op = _consensus(head_regions)
        if op:
            tail_regions = [r for r in tail_regions if _overlap(op['start'], op['end'], r[0], r[1]) < 0.5]
            intro_regions = [r for r in intro_regions if r[1] <= op['start'] + 1.0]
        ed = _consensus(tail_regions) if fi['tail_offset'] > 0 else None
        intro = _consensus(intro_regions)
        result[ep['idx']] = {
            'op': _shift(op, start_shift, end_shift),
            'ed': _shift(ed, start_shift, end_shift),
            'intro': _shift(intro, start_shift, end_shift),
            'duration': fi['duration'],
        }
    return result


def _shift(region, start_delta, end_delta):
    if not region:
        return region
    for r in [region] + (region.get('alts') or []):
        r['start'] = round(max(0.0, r['start'] + start_delta), 1)
        r['end'] = round(max(r['start'] + 1.0, r['end'] + end_delta), 1)
    return region


def _consensus(regions):
    """รวม region ที่ซ้อนกัน → เลือกกลุ่มที่ยาวที่สุด (OP/ED ตัวจริง) คืน (start, end, support, alts)"""
    if not regions:
        return None
    groups = []
    for r in sorted(regions, key=lambda x: -(x[1] - x[0])):
        for g in groups:
            if _iou(g['s'], g['e'], r[0], r[1]) > 0.5:
                g['items'].append(r)
                break
        else:
            groups.append({'s': r[0], 'e': r[1], 'items': [r]})
    summaries = []
    for g in groups:
        s = median(x[0] for x in g['items'])
        e = median(x[1] for x in g['items'])
        summaries.append({'start': round(s, 1), 'end': round(e, 1), 'support': len(g['items']), 'sim': round(median(x[2] for x in g['items']), 2)})
    summaries.sort(key=lambda x: (-x['support'], -(x['end'] - x['start'])))
    best = summaries[0]
    best['alts'] = summaries[1:]
    return best


def _iou(a0, a1, b0, b1):
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    union = max(a1, b1) - min(a0, b0)
    return inter / max(1e-6, union)


def _overlap(a0, a1, b0, b1):
    inter = max(0.0, min(a1, b1) - max(a0, b0))
    return inter / max(1e-6, min(a1 - a0, b1 - b0))


# ---------------------------------------------------------------- playlist walking

def walk_tracks(playlist):
    for season in playlist.get('groups') or []:
        for track in season.get('groups') or []:
            yield season, track


def track_name(season, track):
    return f"{season.get('name')}/{track.get('name')}"


def existing_segment(station, types):
    segs = ((station.get('skip') or {}).get('segments')) or []
    for seg in segs:
        if seg.get('type') in types:
            return seg
    return None


def verdict(existing, detected, tol, error=None):
    """ok/fix = มีค่าเดิม; missing = ไม่มีค่าเดิมแต่ตรวจพบเสียงชัด; review = ตรวจพบแต่ความคล้ายต่ำ
    (เพลงอาจผสมเสียงพูด/ฉาก → ต้องให้คนตัดสิน type ว่าเป็น mixed-* หรือไม่ ไม่เติมอัตโนมัติ)
    error = ตรวจไม่ได้ (โหลดสตรีมไม่ได้/ไม่มีตอนข้างเคียง) ไม่ตัดสินค่าเดิม"""
    if error:
        return 'error', None, None
    if existing and detected:
        ds = round(detected['start'] - float(existing['start']), 1)
        de = round(detected['end'] - float(existing['end']), 1)
        return ('ok' if abs(ds) <= tol and abs(de) <= tol else 'fix'), ds, de
    if existing and not detected:
        return 'undetected', None, None
    if detected and not existing:
        return ('missing' if detected['sim'] >= MIXED_SIM else 'review'), None, None
    return 'none', None, None


# ---------------------------------------------------------------- commands

def cmd_report(args):
    with open(args.playlist, encoding='utf-8') as f:
        playlist = json.load(f)
    slug = os.path.splitext(os.path.basename(args.playlist))[0]
    cache_dir = os.path.join(args.cache_dir, slug)
    os.makedirs(cache_dir, exist_ok=True)

    jobs = []
    for season, track in walk_tracks(playlist):
        if args.tracks and track_name(season, track) not in args.tracks:
            continue
        for idx, st in enumerate(track.get('stations') or []):
            jobs.append((season, track, idx, st))
    log(f'📼 {playlist.get("name")} — {len(jobs)} ตอน, head {args.head}s / tail {args.tail}s, workers {args.workers}')

    feats = {}
    errors = {}
    done = 0

    def work(job):
        season, track, idx, st = job
        return (track_name(season, track), idx), load_or_build(st, args.head, args.tail, cache_dir)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(work, j): j for j in jobs}
        for fut in as_completed(futs):
            season, track, idx, st = futs[fut]
            key = (track_name(season, track), idx)
            done += 1
            try:
                k, f = fut.result()
                feats[k] = f
                log(f'  [{done}/{len(jobs)}] ✓ {key[0]} · {st.get("name")}')
            except Exception as e:
                errors[key] = str(e)
                log(f'  [{done}/{len(jobs)}] ✗ {key[0]} · {st.get("name")} — {e}')

    report = {'playlist': os.path.realpath(args.playlist), 'name': playlist.get('name'), 'head': args.head, 'tail': args.tail,
              'tolerance': args.tolerance, 'start_shift': args.start_shift, 'end_shift': args.end_shift, 'tracks': []}
    for season, track in walk_tracks(playlist):
        tn = track_name(season, track)
        if args.tracks and tn not in args.tracks:
            continue
        stations = track.get('stations') or []
        episodes = [{'idx': i, 'label': episode_label(st.get('name')), 'station': st, 'error': errors.get((tn, i))} for i, st in enumerate(stations)]
        tfeats = {i: feats.get((tn, i)) for i in range(len(stations))}
        det = detect_track(episodes, tfeats, args.start_shift, args.end_shift)
        rows = []
        for ep in episodes:
            st = ep['station']
            d = det[ep['idx']]
            err = ep['error'] or d.get('error')
            row = {'idx': ep['idx'], 'label': ep['label'], 'name': st.get('name'), 'duration': d.get('duration'), 'error': err}
            for kind, types in KIND_TYPES.items():
                ex = existing_segment(st, types)
                dt = d.get(kind)
                v, ds, de = verdict(ex, dt, args.tolerance, error=err)
                row[kind] = {
                    'existing': {'type': ex['type'], 'start': ex['start'], 'end': ex['end']} if ex else None,
                    'detected': dt,
                    'verdict': v, 'd_start': ds, 'd_end': de,
                }
            other = [s for s in ((st.get('skip') or {}).get('segments') or []) if s.get('type') not in OP_TYPES + ED_TYPES + INTRO_TYPES]
            if other:
                row['other_segments'] = other
            source = (st.get('skip') or {}).get('source')
            if source and source != 'manual':
                row['skip_source'] = source
            rows.append(row)
        report['tracks'].append({'track': tn, 'season': season.get('name'), 'episodes': rows})

    _cross_track_check(report)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    print_report(report)


def _cross_track_check(report):
    """ตอนเดียวกันในอีกแทร็กของ season เดียวกัน (พากย์/ซับ มักเป็นวิดีโอชุดเดียวกัน) ถ้าค่าที่ตรวจพบต่างกันเกิน
    CROSS_TRACK_TOL → ลด fix/missing เป็น review (ไม่เขียนอัตโนมัติ) และใส่หมายเหตุ — คนต้องดู"""
    by_season = defaultdict(list)
    for tr in report['tracks']:
        by_season[tr.get('season')].append(tr)
    for tracks in by_season.values():
        if len(tracks) < 2:
            continue
        for tr in tracks:
            others = [o for o in tracks if o is not tr]
            for ep in tr['episodes']:
                for kind in ('op', 'ed'):
                    dt = ep[kind]['detected']
                    if not dt or ep[kind]['verdict'] not in ('fix', 'missing'):
                        continue
                    for o in others:
                        match = next((e for e in o['episodes'] if e['label'] == ep['label']), None)
                        od = match and match[kind]['detected']
                        if not od:
                            continue
                        if abs(od['start'] - dt['start']) > CROSS_TRACK_TOL or abs(od['end'] - dt['end']) > CROSS_TRACK_TOL:
                            if _same_region_shifted(dt, od):
                                continue
                            if _adopt_other_track(ep, kind, dt, od, o['track']):
                                continue
                            ep[kind]['verdict'] = 'review'
                            ep[kind]['cross_track'] = f'{o["track"].split("/")[-1]} {fmt_t(od["start"])}-{fmt_t(od["end"])}'


def _same_region_shifted(dt, od):
    """2 แทร็กเป็นไฟล์คนละตัดต่อ (เช่น ซับไทยมี bumper หน้าไฟล์ 4 วิ) — ช่วงเลื่อนทั้งก้อนเท่ากันและยาวเท่ากัน
    → ถือว่าตรงกัน (ต่างกันเพราะไฟล์ ไม่ใช่เพราะจับผิด)"""
    ds = od['start'] - dt['start']
    de = od['end'] - dt['end']
    if abs(ds) > MAX_TRACK_SHIFT_SEC:
        return False
    return abs(ds - de) <= 1.5 and abs((dt['end'] - dt['start']) - (od['end'] - od['start'])) <= 1.5


def _adopt_other_track(ep, kind, dt, od, other_track):
    """2 แทร็กเริ่มหรือจบพร้อมกัน (วิดีโอชุดเดียวกัน) แต่แทร็กนี้จับได้สั้นกว่า (เสียงพากย์ทับหัว/ท้ายเพลง) ขณะที่อีกแทร็กยาว ~90 วิ
    → ใช้ช่วงของอีกแทร็กแทน (คง verdict เดิม) และบันทึกที่มาไว้ในหมายเหตุ"""
    mine = dt['end'] - dt['start']
    theirs = od['end'] - od['start']
    starts_agree = abs(od['start'] - dt['start']) <= CROSS_TRACK_TOL
    ends_agree = abs(od['end'] - dt['end']) <= CROSS_TRACK_TOL
    if not (starts_agree or ends_agree):
        return False
    if abs(theirs - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL or mine >= theirs - CROSS_TRACK_TOL:
        return False
    dt['start'], dt['end'] = od['start'], od['end']
    if ep.get('duration'):
        dt['end'] = round(min(dt['end'], ep['duration'] - 0.5), 1)
    dt['sim'] = min(dt['sim'], od['sim'])
    ep[kind]['from_track'] = other_track.split('/')[-1]
    if ep[kind]['existing']:
        ex = ep[kind]['existing']
        ds = round(dt['start'] - float(ex['start']), 1)
        de = round(dt['end'] - float(ex['end']), 1)
        ep[kind]['d_start'], ep[kind]['d_end'] = ds, de
        ep[kind]['verdict'] = 'ok' if abs(ds) <= 1.5 and abs(de) <= 1.5 else 'fix'
    return True


def fmt_t(sec):
    if sec is None:
        return '-'
    tenths = int(round(float(sec) * 10))
    m, r = divmod(tenths, 600)
    return f'{m}:{r / 10:04.1f}'


def print_report(report):
    print(f'\n=== {report["name"]} ===  tolerance ±{report["tolerance"]}s  (ค่าตรวจพบปรับขอบแล้ว start {report.get("start_shift", 0):+.1f}s / end {report.get("end_shift", 0):+.1f}s)')
    totals = defaultdict(int)
    for tr in report['tracks']:
        med_len = {kind: _median_length(tr, kind) for kind in ('op', 'ed')}
        print(f'\n--- {tr["track"]} ({len(tr["episodes"])} ตอน) --- ความยาวกลาง OP {fmt_t(med_len["op"])} / ED {fmt_t(med_len["ed"])}')
        print(f'{"ตอน":<8}{"OP เดิม":<16}{"OP ตรวจพบ":<16}{"Δs/Δe":<13}{"ผล":<11}{"ED เดิม":<16}{"ED ตรวจพบ":<16}{"Δs/Δe":<13}{"ผล":<11}หมายเหตุ')
        for ep in tr['episodes']:
            cells = [ep['label'] or f'#{ep["idx"]}']
            notes = []
            for kind in ('op', 'ed'):
                r = ep[kind]
                ex = r['existing']
                dt = r['detected']
                cells.append(f'{fmt_t(ex["start"])}-{fmt_t(ex["end"])}' if ex else '-')
                cells.append(f'{fmt_t(dt["start"])}-{fmt_t(dt["end"])}' if dt else '-')
                cells.append(f'{r["d_start"]:+.1f}/{r["d_end"]:+.1f}' if r['d_start'] is not None else '-')
                cells.append(r['verdict'])
                totals[f'{kind}:{r["verdict"]}'] += 1
                if ex and ex['type'] not in ('op', 'ed'):
                    notes.append(f'{kind}={ex["type"]}')
                if dt and dt.get('alts'):
                    notes.append(f'{kind} alt ' + ', '.join(f'{fmt_t(a["start"])}-{fmt_t(a["end"])}' for a in dt['alts']))
                if dt and dt['support'] == 1:
                    notes.append(f'{kind} support=1')
                if dt and dt['sim'] < MIXED_SIM:
                    notes.append(f'{kind} sim={dt["sim"]} (ต่ำ อาจผสมฉาก)')
                if r.get('cross_track'):
                    notes.append(f'{kind} ≠ {r["cross_track"]}')
                if r.get('from_track'):
                    notes.append(f'{kind} ใช้ช่วงของ{r["from_track"]}')
                if dt and med_len[kind] is not None and abs((dt['end'] - dt['start']) - med_len[kind]) > LENGTH_OUTLIER_SEC:
                    notes.append(f'{kind} ยาว {dt["end"] - dt["start"]:.1f}s ≠ ค่ากลาง')
                elif dt and abs((dt['end'] - dt['start']) - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL:
                    notes.append(f'{kind} ยาว {dt["end"] - dt["start"]:.1f}s ≠ ~90s')
                if ex and abs((float(ex['end']) - float(ex['start'])) - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL:
                    notes.append(f'{kind} เดิมยาว {float(ex["end"]) - float(ex["start"]):.1f}s')
            intro = ep.get('intro') or {}
            if intro.get('detected') or intro.get('existing'):
                dti, exi = intro.get('detected'), intro.get('existing')
                notes.append('intro ' + (f'{fmt_t(exi["start"])}-{fmt_t(exi["end"])} เดิม ' if exi else '') + (f'{fmt_t(dti["start"])}-{fmt_t(dti["end"])} ตรวจพบ ' if dti else '') + f'({intro.get("verdict")})')
                totals[f'intro:{intro.get("verdict")}'] += 1
            if ep.get('error'):
                notes.append('ERR ' + ep['error'][:60])
            if ep.get('other_segments'):
                notes.append('other=' + ','.join(s.get('type', '?') for s in ep['other_segments']))
            if ep.get('skip_source'):
                notes.append(f'skip={ep["skip_source"]}')
            w = [8, 16, 16, 13, 11, 16, 16, 13, 11]
            print(''.join(f'{c:<{w[i]}}' for i, c in enumerate(cells)) + ' '.join(notes))
    print('\nสรุป: ' + ', '.join(f'{k}={v}' for k, v in sorted(totals.items())))


def cmd_apply(args):
    with open(args.playlist, encoding='utf-8') as f:
        raw = f.read()
    playlist = json.loads(raw)
    with open(args.report, encoding='utf-8') as f:
        report = json.load(f)
    if os.path.realpath(report['playlist']) != os.path.realpath(args.playlist):
        raise SystemExit(f'report นี้เป็นของ {report["playlist"]} ไม่ใช่ {args.playlist}')
    if not args.fix and not args.fill and not args.set and not args.remove and not args.mark_none:
        raise SystemExit('ต้องระบุ --fix และ/หรือ --fill (หรือ --set/--remove/--mark-none)')
    tol = args.tolerance if args.tolerance is not None else report['tolerance']
    if args.backup_dir:
        os.makedirs(args.backup_dir, exist_ok=True)
        shutil.copy2(args.playlist, os.path.join(args.backup_dir, os.path.basename(args.playlist)))

    by_track = {t['track']: t for t in report['tracks']}
    overrides = _parse_overrides(args.set or [], report.get('start_shift', 0.0), report.get('end_shift', 0.0))
    skipped_outliers = []
    removals = set()
    for item in args.remove or []:
        m = re.match(r'^(.+?)\|(.+?)\|(op|ed|intro)$', item.strip())
        if not m:
            raise SystemExit(f'--remove รูปแบบไม่ถูกต้อง: {item!r} (ต้องเป็น "TRACK|LABEL|op")')
        removals.add((m.group(1), m.group(2), m.group(3)))
    changes = []
    marked = []
    for season, track in walk_tracks(playlist):
        tn = track_name(season, track)
        if tn not in by_track or (args.tracks and tn not in args.tracks):
            continue
        stations = track.get('stations') or []
        for row in by_track[tn]['episodes']:
            label = row['label'] or f'#{row["idx"]}'
            if args.episodes and label not in args.episodes:
                continue
            if row['idx'] >= len(stations) or stations[row['idx']].get('name') != row['name']:
                raise SystemExit(f'ไฟล์เปลี่ยนไปจากตอน report: {tn} #{row["idx"]} {row["name"]!r} — รัน report ใหม่')
            st = stations[row['idx']]
            touched = False
            for kind, types in KIND_TYPES.items():
                r = row.get(kind)
                if r is None:
                    continue
                dt = r['detected']
                seg = existing_segment(st, types)
                ov = overrides.pop((tn, row['label'], kind), None)
                rm = (tn, row['label'], kind) in removals
                if rm:
                    removals.discard((tn, row['label'], kind))
                if args.kinds and kind not in args.kinds and not ov and not rm:
                    continue
                if _seg_summary(seg) != r['existing']:
                    raise SystemExit(f'segment {kind} ของ {tn} ตอน {row["label"]} เปลี่ยนไปจากตอน report — รัน report ใหม่')
                if rm:
                    if seg:
                        st['skip']['segments'].remove(seg)
                        touched = True
                        changes.append((tn, label, kind, 'rm', (seg['start'], seg['end']), None, {'support': None, 'sim': None}))
                    continue
                if ov:
                    dt = {'start': ov[0], 'end': ov[1], 'support': 'manual', 'sim': None}
                    v = 'fix' if seg else 'missing'
                    if v == 'fix' and seg['start'] == num(dt['start']) and seg['end'] == num(dt['end']):
                        continue
                else:
                    if not dt or row.get('error') or r['verdict'] in ('review', 'error'):
                        continue
                    min_support = 1 if kind == 'intro' and dt['sim'] >= 0.9 else args.min_support
                    if dt['support'] < min_support:
                        continue
                    if not r['existing'] and kind in ((st.get('skip') or {}).get('none') or []):
                        continue
                    med = _median_length(by_track[tn], kind) if kind != 'intro' else None
                    if med is not None and abs((dt['end'] - dt['start']) - med) > LENGTH_OUTLIER_SEC:
                        skipped_outliers.append((tn, label, kind, dt, med))
                        continue
                    v, _, _ = verdict(r['existing'], dt, tol)
                if v == 'fix' and (args.fix or ov):
                    old = (seg['start'], seg['end'])
                    seg['start'] = num(dt['start'])
                    seg['end'] = num(dt['end'])
                    touched = True
                    changes.append((tn, label, kind, 'fix', old, (seg['start'], seg['end']), dt))
                elif v == 'missing' and (args.fill or ov):
                    source = 'manual' if ov else args.source
                    skip = st.setdefault('skip', {'source': source, 'segments': []})
                    skip.setdefault('source', source)
                    segs = skip.setdefault('segments', [])
                    segs.append({'type': kind, 'start': num(dt['start']), 'end': num(dt['end'])})
                    if ov and kind in (skip.get('none') or []):
                        skip['none'] = [k for k in skip['none'] if k != kind]
                        if not skip['none']:
                            del skip['none']
                    touched = True
                    changes.append((tn, label, kind, 'fill', None, (num(dt['start']), num(dt['end'])), dt))
            if touched:
                st['skip']['segments'].sort(key=lambda s: float(s.get('start', 0)))
            elif (args.mark_none and not args.kinds and not st.get('skip') and not row.get('error')
                  and all((row.get(k) or {}).get('verdict') == 'none' for k in KIND_TYPES)
                  and not _cross_track_evidence(by_track, season.get('name'), tn, label)):
                st['skip'] = {'source': args.source, 'segments': []}
                marked.append((tn, label))

    if overrides:
        raise SystemExit('--set ไม่ตรงกับตอนใดใน report: ' + ', '.join(f'{t}|{l}|{k}' for t, l, k in overrides))
    if removals:
        raise SystemExit('--remove ไม่ตรงกับตอนใดใน report: ' + ', '.join(f'{t}|{l}|{k}' for t, l, k in removals))
    for tn, label, kind, dt, med in skipped_outliers:
        print(f'ข้าม {tn:<24}ตอน {str(label):<8}{kind:<4}{fmt_t(dt["start"])}-{fmt_t(dt["end"])}  (ยาว {dt["end"] - dt["start"]:.1f}s ต่างจากค่ากลางของแทร็ก {med:.1f}s — ต้องยืนยันด้วย --set)')
    if not changes and not marked:
        if args.json_out:
            _write_json_out(args.json_out, args.playlist, changes, skipped_outliers, marked)
        print('ไม่มีอะไรต้องแก้')
        return
    out = json.dumps(playlist, ensure_ascii=False, indent=4)
    if raw.endswith('\n'):
        out += '\n'
    with open(args.playlist, 'w', encoding='utf-8') as f:
        f.write(out)
    if args.json_out:
        _write_json_out(args.json_out, args.playlist, changes, skipped_outliers, marked)
    for tn, label, kind, how, old, new, dt in changes:
        o = f'{fmt_t(old[0])}-{fmt_t(old[1])} → ' if old else ''
        n = f'{fmt_t(new[0])}-{fmt_t(new[1])}' if new else '(ลบ)'
        print(f'{how:<5}{tn:<24}ตอน {str(label):<8}{kind:<4}{o}{n}  (support={dt["support"] if dt["support"] is not None else "-"} sim={dt["sim"] if dt["sim"] is not None else "-"})')
    for tn, label in marked:
        print(f'none {tn:<24}ตอน {str(label):<8}(ตรวจแล้วไม่พบ op/ed/intro)')
    print(f'\nแก้ {len(changes) + len(marked)} รายการ → {args.playlist}')


def _cross_track_evidence(by_track, season_name, tn, label):
    """ตอนเดียวกันในแทร็กอื่นของ season เดียวกัน (ใน report) มี op/ed/intro (ค่าเดิมหรือที่ตรวจพบ) หรือตรวจไม่ได้
    → --mark-none ไม่ทำเครื่องหมาย (ตรวจไม่พบในแทร็กนี้อาจเพราะเสียงคนละ cut/พากย์ทับ ไม่ใช่ไม่มีจริง)"""
    for other in by_track.values():
        if other['track'] == tn or other.get('season') != season_name:
            continue
        for row in other['episodes']:
            if (row['label'] or f'#{row["idx"]}') != label:
                continue
            if row.get('error'):
                return True
            if any((row.get(k) or {}).get('existing') or (row.get(k) or {}).get('detected') for k in KIND_TYPES):
                return True
    return False


def _write_json_out(path, playlist_path, changes, outliers, marked=()):
    """ผลของ apply แบบ machine-readable สำหรับ job อัตโนมัติ — label ตรงกับที่ --episodes รับ (เลขตอน หรือ #idx)
    changes[].action: fill | fix | rm (rm/fix มี old; rm ไม่มี start/end); outliers = ช่วงที่ข้ามเพราะยาวต่างจากค่ากลาง
    marked = ตอนที่ --mark-none เขียน skip {segments: []} (ตรวจแล้วไม่พบ op/ed/intro)"""
    out = {
        'playlist': os.path.realpath(playlist_path),
        'changes': [
            {
                'track': tn, 'label': label, 'kind': kind, 'action': how,
                'start': new[0] if new else None, 'end': new[1] if new else None,
                'old': {'start': old[0], 'end': old[1]} if old else None,
                'support': dt.get('support'), 'sim': dt.get('sim'),
            }
            for tn, label, kind, how, old, new, dt in changes
        ],
        'outliers': [
            {
                'track': tn, 'label': label, 'kind': kind, 'start': dt['start'], 'end': dt['end'],
                'length': round(dt['end'] - dt['start'], 1), 'median': round(med, 1),
                'support': dt.get('support'), 'sim': dt.get('sim'),
            }
            for tn, label, kind, dt, med in outliers
        ],
        'marked': [{'track': tn, 'label': label} for tn, label in marked],
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def _median_length(track_report, kind):
    """ความยาวอ้างอิงของแทร็ก = กลุ่มความยาวที่มีสมาชิกมากที่สุด (ช่วง ±3 วิ) จากแถวที่เชื่อถือได้ (ok/fix/missing)
    ถ้าเท่ากันเลือกกลุ่มที่ใกล้ 90 วิ — กันทั้งกรณีเพลงผสมฉากลากค่ากลางลง และกรณีแถว review มาบิดค่าอ้างอิง"""
    lens = [ep[kind]['detected']['end'] - ep[kind]['detected']['start']
            for ep in track_report['episodes'] if ep.get(kind) and ep[kind]['detected'] and ep[kind]['verdict'] in ('ok', 'fix', 'missing')]
    if not lens:
        return None
    best = None
    for center in lens:
        cluster = [x for x in lens if abs(x - center) <= LENGTH_OUTLIER_SEC]
        key = (len(cluster), -abs(median(cluster) - TYPICAL_LENGTH_SEC))
        if best is None or key > best[0]:
            best = (key, median(cluster))
    return best[1]


def _parse_overrides(items, start_shift, end_shift):
    """'Season 1/พากย์ไทย|1|op=0:52-2:22' → {(track, label, kind): (start, end)} หลังปรับขอบตามนโยบาย"""
    out = {}
    for item in items:
        m = re.match(r'^(.+?)\|(.+?)\|(op|ed|intro)=([\d:.]+)-([\d:.]+)$', item.strip())
        if not m:
            raise SystemExit(f'--set รูปแบบไม่ถูกต้อง: {item!r} (ต้องเป็น "TRACK|LABEL|op=START-END" หรือ intro=)')
        start = _parse_time(m.group(4)) + start_shift
        end = _parse_time(m.group(5)) + end_shift
        if end <= start:
            raise SystemExit(f'--set {item!r}: end ต้องมากกว่า start')
        out[(m.group(1), m.group(2), m.group(3))] = (round(start, 1), round(end, 1))
    return out


def _parse_time(text):
    parts = [float(x) for x in text.split(':')]
    sec = 0.0
    for part in parts:
        sec = sec * 60 + part
    return sec


def _seg_summary(seg):
    return {'type': seg['type'], 'start': seg['start'], 'end': seg['end']} if seg else None


def num(v):
    v = round(float(v), 1)
    return int(v) if v == int(v) else v


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('report')
    r.add_argument('playlist')
    r.add_argument('--out')
    r.add_argument('--head', type=float, default=DEFAULT_HEAD)
    r.add_argument('--tail', type=float, default=DEFAULT_TAIL)
    r.add_argument('--tolerance', type=float, default=DEFAULT_TOLERANCE)
    r.add_argument('--workers', type=int, default=4)
    r.add_argument('--tracks', nargs='*')
    r.add_argument('--cache-dir', default=DEFAULT_CACHE)
    r.add_argument('--start-shift', type=float, default=DEFAULT_START_SHIFT, help='ปรับจุดเริ่มของ OP/ED (วินาที, default +0.5)')
    r.add_argument('--end-shift', type=float, default=DEFAULT_END_SHIFT, help='ปรับจุดจบของ OP/ED (วินาที, default -0.5)')
    a = sub.add_parser('apply')
    a.add_argument('playlist')
    a.add_argument('report')
    a.add_argument('--fix', action='store_true')
    a.add_argument('--fill', action='store_true')
    a.add_argument('--tolerance', type=float)
    a.add_argument('--tracks', nargs='*')
    a.add_argument('--episodes', nargs='*')
    a.add_argument('--backup-dir')
    a.add_argument('--min-support', type=int, default=2, help='ต้องมีตอนข้างเคียงยืนยันอย่างน้อยกี่ครั้ง (default 2)')
    a.add_argument('--set', nargs='*', help='ค่าที่ผู้ใช้ยืนยันเอง "TRACK|LABEL|op=START-END"')
    a.add_argument('--kinds', nargs='*', choices=['op', 'ed', 'intro'], help='จำกัดเฉพาะ op / ed / intro')
    a.add_argument('--remove', nargs='*', help='ลบ segment "TRACK|LABEL|op"')
    a.add_argument('--mark-none', action='store_true', help='ตอนที่ตรวจแล้วไม่พบ op/ed/intro และยังไม่มี skip → เขียน skip ว่าง (segments: [])')
    a.add_argument('--source', default='manual', help='skip.source เมื่อ --fill / --mark-none สร้าง skip object ใหม่ (default manual; job อัตโนมัติใช้ audit)')
    a.add_argument('--json-out', help='เขียนผล apply แบบ JSON {playlist, changes[], outliers[], marked[]}')
    args = p.parse_args()
    if args.cmd == 'report':
        cmd_report(args)
    else:
        cmd_apply(args)


if __name__ == '__main__':
    main()
