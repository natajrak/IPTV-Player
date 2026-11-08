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
        ช่วงที่ "ต้องดู" ยังบันทึก (ผู้ใช้กำหนด 2026-11-03) พร้อม notice: ยาวต่างจากค่ากลางของแทร็กเกิน 3 วิ, ตอนข้างเคียงยืนยันไม่ถึง
        --min-support, ไม่ตรงกับอีกแทร็ก (เฉพาะเติมใหม่ — แก้ค่าเดิมไม่แจ้ง), เสียงคล้ายต่ำ (OP/ED เขียนเป็น mixed-op/mixed-ed
        ซึ่ง player ไม่ข้ามอัตโนมัติ; intro/credits ไม่เติม)
        ตอนที่ผู้ใช้บันทึกเอง (station.skip.edited จาก CMS / --set / --remove) --fill/--fix ไม่แตะ
        --min-support N                    ใช้เฉพาะ region ที่ตอนข้างเคียงยืนยัน ≥ N ครั้ง (default 2; OP/ED ที่จุดตัดภาพยืนยันทั้งสองขอบลดลง 1)
        --set "Season 1/พากย์ไทย|1|op=0:52-2:22" [...]   (kind: op | ed | intro = หน้าเปิด/splash ของเว็บต้นทาง
                                           | credits = end credit ที่มีฉากคั่นหลัง ED เก็บเป็น ed ช่วงที่สอง)
                                           ค่าที่ผู้ใช้ตรวจด้วยตา ใช้แทนค่าที่ตรวจพบของตอนนั้น (ปรับขอบตามนโยบายให้อัตโนมัติ
                                           ถ้า report มี start_shift/end_shift) — เขียนเสมอไม่สน tolerance/support
                                           --set/--remove ตั้ง skip.source = manual และ skip.edited = true (ค่าที่คนยืนยัน)
        --tolerance S                      ประเมิน ok/fix ใหม่ด้วย tolerance นี้ (default ตาม report)
        --source NAME                      ค่า skip.source เมื่อ --fill/--mark-none ต้องสร้าง skip object ใหม่ (default manual;
                                           job อัตโนมัติใช้ audit = ยังไม่มีคนยืนยัน; --set เขียน manual เสมอ; --fill/--fix คง source เดิม)
        --json-out PATH                    เขียนผลแบบ machine-readable {playlist, changes[], marked[]} (เขียนแม้ไม่มีอะไรแก้)
        --mark-none                        ตอนที่ตรวจได้แต่ไม่พบ op/ed/intro เลย และยังไม่มี skip → เขียน skip {source: --source, segments: []}
                                           ยกเว้นตอนเดียวกันในแทร็กอื่นของ season (ที่อยู่ใน report) มี op/ed/intro หรือตรวจไม่ได้
                                           (= ตรวจแล้วไม่พบ กัน job อัตโนมัติตรวจซ้ำ; --fill รอบหลังยังเติมทับได้; ถ้าใส่ --kinds จะไม่ mark)
        recap และ type อื่นที่ไม่ใช่ op/ed ไม่ถูกแตะ
        ชนิดที่ผู้ใช้ยืนยันว่าไม่มี (station.skip.none เช่น ["op"] จากช่องติ๊กใน CMS) --fill จะไม่เติม
        (--set ยังเขียนได้ และเอาชนิดนั้นออกจาก none)

ED / end credit (ผู้ใช้กำหนด 2026-11-02):
    ความเงียบสนิทต่อจากเพลงปิดนับเป็น ED ไม่จำกัดความยาว; ED ที่ไปถึงท้ายวิดีโอจบที่วินาทีสุดท้ายของวิดีโอ (ไม่หักขอบ)
    เครดิตเงียบจนจบไฟล์ ≥ 10 วิ (มักนำด้วยเสียง Netflix "ta-dum" — fingerprint ใน tools/skip-refs/netflix-sting.npy):
    ห่างจาก ED ≤ 8 วิ → รวบเข้า ED ถึงท้ายไฟล์; มีฉากคั่น → kind credits = ed ช่วงที่สอง (ไม่ต้องมีตอนข้างเคียงยืนยัน)
    sting ใน 2 วิแรกของไฟล์ + ความเงียบต่อท้าย → intro ของ Netflix (เมื่อไม่พบ intro จากตอนข้างเคียง)

OP/ED ที่จับได้สั้นกว่าเพลงเต็ม (ผู้ใช้เสนอ 2026-11-02): ช่วงเสียงต่างกันสั้น ๆ กลางเพลงทำให้จับต้นเพลงช้า แต่จุดจบตรงทุกตอน
    → นับถอยจากจุดจบด้วยความยาวเพลงเต็มของแทร็ก (~90±5 วิ, กลุ่มที่ยาวที่สุดซึ่งมี ≥ 3 ตอน) หาจุดที่เสียงเริ่มเหมือนตอนข้างเคียง
    ใช้เมื่อช่วงที่ขยายเหมือนตอนข้างเคียงจริง; OP ที่เริ่มใน 1.5 วิแรกของไฟล์เริ่มที่ 0:00; รายงานแสดง "ขยายต้นเพลงย้อนจากจุดจบ"

ขอบตามจุดตัดภาพ (ผู้ใช้กำหนดขอบตามภาพ 2026-11-02): หลังจับขอบจากเสียง ดึงภาพรอบแต่ละขอบ (ภาพย่อ 32×18 ขาวดำ 25 fps,
    stream วิดีโอจริงที่เล็กสุด, cache เป็น <key>-w<t0*10>-<t1*10>.npy) หาจุดตัดภาพที่ฝั่งเพลงเหมือนตอนข้างเคียงและอีกฝั่งไม่เหมือน → ใช้เป็นขอบ
    (ขอบเริ่ม +0.2 วิ, ขอบจบ −0.5 วิ ตามนโยบาย) — ขอบเริ่มค้นเข้าไปในเพลงได้ 20 วิ (เพลงขึ้นก่อนภาพ), นอกนั้น ±1.5 วิ
    (ออกนอกเพลงไกลเสี่ยงลามเข้าเนื้อเรื่อง; ขอบจบค้นลึกไม่ได้เพราะช็อตท้ายเพลงมักต่างกันทุกตอน)
    ยกเว้นเพลงที่จับจากเสียงได้สั้นกว่าความยาวเต็มของแทร็ก → ขอบจบค้นออกนอกเพลงเพิ่มได้เท่าส่วนที่ขาด (≤ 10 วิ)
    เทียบกับค่ากลางของตอนข้างเคียงก่อน ไม่พบ → ค่าสูงสุด (วิดีโอ OP/ED หลายแบบที่หัวยาวต่างกัน)
    ED ที่ถูกตัดต้นเพลงเพราะเสียงพูดทับ ค้นจากจุดเริ่มเพลงก่อนตัด พบจุดตัดภาพ → ใช้แทนการตัด
    ไม่พบจุดตัดชัดเจน/ดึงตรงไม่ได้ (ต้องผ่าน worker) → คงขอบเสียง; ปิดด้วย report --no-visual
    พากย์/ซับ ตอนเดียวกันเริ่มหรือจบตรงกันแต่แทร็กนี้จับสั้นกว่า → ยืมช่วงของอีกแทร็ก (รวมตอนที่ค่าเดิมตรงกับเสียงที่จับได้)
    เมื่อภาพช่วงที่ยืมตรงกันทั้งสองแทร็ก (ดึงภาพไม่ได้ ยืมตามเสียง)

ค่าที่ตรวจพบเป็นวินาที ละเอียด 0.1 วิ (hop 32 ms)
intro = หน้าเปิด/splash ของเว็บต้นทางที่หัวไฟล์ (3–29 วิ เริ่มที่ 0:00 ซ้ำกันทุกตอน) ตรวจและเติมให้อัตโนมัติเช่นกัน
    (splash สั้นและเหมือนกันเป๊ะ จึงยอมรับเมื่อมีตอนข้างเคียงยืนยันแค่ 1 ครั้งถ้า sim ≥ 0.9)
    (player รองรับ type 'intro' ตั้งแต่ v66; auto skip ข้ามได้)
นโยบายขอบช่วง (ผู้ใช้กำหนด 2026-10-28, ลองใช้ 1 วิ แล้วกลับเป็น 0.5 วิ 2026-11-01): OP / ED / intro → start +0.5 วิ, end -0.5 วิ (หดเข้าข้างละ 0.5 วิ;
    player เช็คจาก timeupdate ทุก ~250 ms จึงละเอียดพอ)
    --start-shift / --end-shift ของ report ปรับได้ (ค่าที่แสดงและเขียนคือค่าหลังปรับแล้ว)
    ขอบเริ่มที่ยืนยันด้วยจุดตัดภาพแล้ว (_snap_to_video) ใช้ +VISUAL_START_SHIFT_SEC (0.2 วิ) แทน — ผู้ใช้ 2026-11-07: ข้ามให้เร็วขึ้นได้
    เพราะจุดตัดภาพแม่น ±0.1 วิ; และค่าเดิมที่ต่างจากขอบที่ยืนยันด้วยภาพเกิน VISUAL_FIX_TOL_SEC (0.3 วิ) ถือว่าต้องแก้ (fix) ไม่รอถึง tolerance 1.5 วิ
    (ค่าจาก build เก่าของ Misanthrope เร็วกว่าภาพ 0.6–0.9 วิ ค้างอยู่เพราะต่างไม่ถึง 1.5 วิ)
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
import warnings
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from statistics import median

import numpy as np
from scipy import ndimage, signal
from scipy.signal import fftconvolve
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
BRIDGE_GAP_SEC = 10.0
BRIDGE_RUN_SEC = 10.0
BRIDGE_SIM = 0.85
DIP_FLOOR_DROP = 0.15
LENGTH_OUTLIER_SEC = 3.0
TYPICAL_LENGTH_SEC = 90.0
TYPICAL_LENGTH_TOL = 5.0
CROSS_TRACK_TOL = 3.0
CROSS_TRACK_SAME_FILE_SEC = 2.0
MAX_TRACK_SHIFT_SEC = 60.0
SILENCE_FLOOR = float(np.log(1e-9 * 64)) + 1.0
SILENCE_EXTEND_SEC = 2.5
SILENCE_BLIP_SEC = 0.1
ED_EOF_TOL_SEC = 1.5
CREDITS_MIN_SEC = 10.0
CLEAN_SIM = 0.85
CLEAN_HOLD_SEC = 5.0
CLEAN_MIN_TRIM_SEC = 1.5
CLEAN_MIN_EPISODES = 3
CLEAN_STRONG_SEC = 4.0
CREDITS_MERGE_GAP_SEC = 8.0
EXTEND_REF_MIN_SEC = 85.0
EXTEND_REF_MAX_SEC = 95.0
EXTEND_REF_CLUSTER_SEC = 1.5
EXTEND_SPAN = 4
EXTEND_SONG_SIM = 0.5
EXTEND_HOLD_SIM = 0.7
EXTEND_MAX_DIP_SEC = 3.5
EXTEND_MAX_DEEP_SEC = 1.5
EXTEND_SEARCH_FWD_SEC = 3.0
EXTEND_SEARCH_BACK_SEC = 2.0
EXTEND_WINDOW_TOL_SEC = 0.5
EXTEND_MIN_VALID = 0.8
EXTEND_MIN_SEC = 1.5
HEAD_SNAP_SEC = 1.5
VISUAL_SNAP_IN_SEC = 20.0
VISUAL_SNAP_OUT_SEC = 1.5
VISUAL_SNAP_DEFICIT_MAX_SEC = 10.0
VISUAL_PAD_SEC = 1.5
VISUAL_INNER_SEC = (1.0, 3.0)
VISUAL_IMAGE_CODECS = ('webp', 'png', 'mjpeg', 'gif', 'bmp')
VISUAL_FPS = 25
VISUAL_W, VISUAL_H = 32, 18
VISUAL_FLAT_NORM = 30.0
VISUAL_CUT_FACTOR = 4.0
VISUAL_CUT_MIN = 2.0
VISUAL_ALIGN_MAX_SEC = 2.0
VISUAL_ALIGN_LATE_SEC = 10.0
VISUAL_ALIGN_MIN_SIM = 0.7
VISUAL_MIN_SCORE = 0.3
VISUAL_ONSET_SIM = 0.9
VISUAL_NOTICE_SEC = 5.0
VISUAL_CREDITS_GAP_SEC = 1.0
VISUAL_START_SHIFT_SEC = 0.2
VISUAL_FIX_TOL_SEC = 0.3
CROSS_VISUAL_SPAN_SEC = 20.0
CROSS_VISUAL_PAD_SEC = 1.5
STING_SIM = 0.9
STING_LEAD_SEC = 2.0
STING_INTRO_MAX_SEC = 20.0
STING_REF_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'skip-refs', 'netflix-sting.npy')
NEIGHBOR_SPAN = 2
DEFAULT_HEAD = 480
DEFAULT_TAIL = 300
DEFAULT_TOLERANCE = 1.5
DEFAULT_START_SHIFT = 0.5
DEFAULT_END_SHIFT = -0.5
RETRIES = 3
SEEK_CHECK_SIM = 0.8
SEEK_CHECK_TOL_SEC = 0.1
SEEK_SEARCH_SEC = 30.0
SEEK_RETRIES = 2
RETRY_DELAY_SEC = 5
WORKER_RESOLVE = 'https://shy-haze-2452.natajrak-p.workers.dev/resolve/'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
OP_TYPES = ('op', 'mixed-op')
ED_TYPES = ('ed', 'mixed-ed')
INTRO_TYPES = ('intro',)
KIND_TYPES = {'op': OP_TYPES, 'ed': ED_TYPES, 'intro': INTRO_TYPES, 'credits': ED_TYPES}

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
    raw_above = valid & (np.where(valid, sim, 0.0) > threshold)
    lo = hi = mid
    while True:
        lo = _walk(above, dip_ok, lo, -1)
        hi = _walk(above, dip_ok, hi, +1)
        while lo > 0 and raw_above[lo - 1]:
            lo -= 1
        while hi + 1 < len(raw_above) and raw_above[hi + 1]:
            hi += 1
        bridged = _bridge(s, valid, lo, hi)
        if bridged == (lo, hi):
            break
        lo, hi = bridged
    lo, hi = _extend_over_silence(bands_a, lo, hi)
    return lo, hi, float(np.nanmean(sim[lo:hi + 1]))


def _bridge(s, valid, lo, hi):
    """เชื่อมช่วงซ้ำข้ามช่วงเสียงต่างกันกลางเพลง (ยาว ≤ BRIDGE_GAP_SEC ลึกแค่ไหนก็ได้) เมื่ออีกฝั่งเหมือนชัด (≥ BRIDGE_SIM) ต่อเนื่อง ≥ BRIDGE_RUN_SEC
    และรวมแล้วยาวไม่เกินเพลงปกติ (TYPICAL_LENGTH_SEC + TYPICAL_LENGTH_TOL) — เพลงที่มีท่อนต่างกันระหว่างตอน เช่น Skeleton Knight S2
    OP ~8 วิ / ED ~1 วิ ที่ _walk ข้ามไม่ได้เพราะลึกเกิน; ความยาวจำกัดไว้กันรวมกับเนื้อหาซ้ำอื่นที่อยู่ติดกัน"""
    strong = valid & (s >= BRIDGE_SIM)
    gap = int(BRIDGE_GAP_SEC * FPS)
    run = int(BRIDGE_RUN_SEC * FPS)
    max_len = int((TYPICAL_LENGTH_SEC + TYPICAL_LENGTH_TOL) * FPS)
    n = len(s)
    changed = True
    while changed:
        changed = False
        j = lo - 1
        while j >= max(0, lo - 1 - gap) and not strong[j]:
            j -= 1
        if 0 <= j and j >= lo - 1 - gap and strong[j]:
            k = j
            while k > 0 and strong[k - 1]:
                k -= 1
            if j - k + 1 >= run and hi - k <= max_len:
                lo, changed = k, True
        j = hi + 1
        while j <= min(n - 1, hi + 1 + gap) and not strong[j]:
            j += 1
        if j < n and j <= hi + 1 + gap and strong[j]:
            k = j
            while k + 1 < n and strong[k + 1]:
                k += 1
            if k - j + 1 >= run and k - lo <= max_len:
                hi, changed = k, True
    return lo, hi


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
                'tail_checked': bool(z['tail_checked']) if 'tail_checked' in z.files else False,
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
        via_segments = False
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
            via_segments = True
        fh = analyze_wav(hw)
        ft = analyze_wav(tw) if tail_offset > 0 else dict(EMPTY_FEATURES)
        checked = True
        if tail_offset > 0 and hls_opts(url) and not via_segments:
            status, err = _tail_seek_error(url, referer, ft['bands'], tail_offset, tail)
            if status == 'nomatch':
                duration, tail_offset = _extract_via_segments(url, referer, head, tail, hw, tw)
                fh = analyze_wav(hw)
                ft = analyze_wav(tw)
            elif status == 'ok' and abs(err) > SEEK_CHECK_TOL_SEC:
                log(f'    เสียงท้ายตอนคลาด {err:+.1f}s (HLS seek) → แก้ tail_offset')
                tail_offset -= err
            checked = status != 'error'
    return duration, tail_offset, fh, ft, checked


def _direct_stream(station):
    """(url, referer) ที่ดึงตรงจากเครื่องได้ — None เมื่อต้องผ่าน worker (ไม่ใช้ quota) หรือ resolver ในเครื่องล้มเหลว"""
    resolver = station.get('resolver')
    referer = station.get('referer')
    if resolver:
        local = LOCAL_RESOLVERS.get(resolver)
        if not local:
            return None
        try:
            url, override = local(station)
        except Exception:
            return None
        referer = override or referer
    else:
        url = station['url']
    direct = _unwrap_proxy(url)
    if direct:
        url, referer = direct[0], direct[1] or referer
    if urllib.parse.urlparse(url).netloc.endswith('workers.dev'):
        return None
    return url, referer


def _locate_audio(ref_bands, ref_t0, bands, expect_t):
    """เวลาจริง (วินาที ตามป้ายเวลาของ ref) ที่เสียง bands เริ่ม — ดูที่คาดไว้ก่อน แล้วค้น ±SEEK_SEARCH_SEC; None เมื่อไม่พบที่เหมือน ≥ SEEK_CHECK_SIM"""
    def score(off):
        sim = frame_similarity(ref_bands, bands, off)
        vals = sim[~np.isnan(sim)]
        return float(vals.mean()) if len(vals) >= 3 * FPS else -1.0
    exp = int(round((expect_t - ref_t0) * FPS))
    near = max(range(exp - 6, exp + 7), key=score)
    if score(near) >= SEEK_CHECK_SIM:
        return ref_t0 + near / FPS
    span = int(SEEK_SEARCH_SEC * FPS)
    coarse = max(range(exp - span, exp + span + 1, 3), key=score)
    best = max(range(coarse - 3, coarse + 4), key=score)
    return ref_t0 + best / FPS if score(best) >= SEEK_CHECK_SIM else None


def _hls_media(url, referer):
    """[(เริ่ม, ยาว, segment url)] จาก variant ที่เล็กที่สุด — [] เมื่อไม่มี หรือเป็น EXT-X-BYTERANGE
    (ทั้งเรื่องอยู่ไฟล์เดียว เช่น akuma-cdn ระดับ GB — segment url เดียวกันทุกท่อน โหลดตรงๆ ไม่ได้)"""
    text = _http_get(url, referer).decode('utf-8', 'replace')
    kind, items = _parse_m3u8(text, url)
    if kind == 'master':
        if not items:
            return []
        url = items[0][1]
        text = _http_get(url, referer).decode('utf-8', 'replace')
        kind, items = _parse_m3u8(text, url)
    if '#EXT-X-BYTERANGE' in text:
        return []
    out, cum = [], 0.0
    for d, u in items:
        out.append((cum, d, u))
        cum += d
    return out


def _tail_seek_error(url, referer, tail_bands, tail_offset, tail):
    """ffmpeg -ss บน HLS บางเว็บได้เสียงคลาดจากที่ขอ ~10–13 วิ (ป้ายเวลาผิด; พบที่ hls.animeindy 2026-11-02)
    → โหลด segment ที่ครอบกลางช่วงเสียงท้ายตาม EXTINF (ไม่ seek) แล้วหาตำแหน่งใน tail_bands — คืน (สถานะ, err)
    'ok': err = เวลาตามป้ายของ tail − เวลาจริง (tail_offset ที่ถูก = tail_offset − err)
    'unverifiable': เพลย์ลิสต์ไม่มี segment แยก (EXT-X-BYTERANGE ทั้งเรื่องไฟล์เดียว) — เช็คแบบนี้ไม่ได้ตลอดไป
    'nomatch': หา segment ในเสียงท้ายไม่เจอ (คลาดเกิน SEEK_SEARCH_SEC หรือเสียงเสีย); 'error': โหลด/ถอดไม่ได้ชั่วคราว"""
    try:
        probe = tail_offset + tail / 2
        seg = next(((start, u) for start, d, u in _hls_media(url, referer) if start <= probe < start + d), None)
        if not seg:
            return 'unverifiable', None
        data = _strip_to_ts(_http_get(seg[1], referer))
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, 's.wav')
            res = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', str(SR), wav],
                                 input=data, capture_output=True, timeout=120)
            if res.returncode != 0 or not os.path.exists(wav):
                return 'error', None
            bands = analyze_wav(wav)['bands']
    except Exception:
        return 'error', None
    found = _locate_audio(tail_bands, tail_offset, bands, seg[0])
    return ('nomatch', None) if found is None else ('ok', found - seg[0])


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
            if cached['tail_checked'] or cached['tail_offset'] <= 0 or _check_cached_tail(station, cached, path, head, tail):
                return cached
    last_err = None
    for attempt in range(RETRIES):
        try:
            duration, tail_offset, fh, ft, checked = _fetch_features(station, head, tail)
            break
        except Exception as e:
            last_err = e
            time.sleep(RETRY_DELAY_SEC * (attempt + 1))
    else:
        raise last_err
    feats = {'duration': duration, 'tail_offset': tail_offset, 'tail_checked': checked, 'head': fh, 'tail': ft}
    _save_cache(path, head, tail, feats)
    return feats


def _save_cache(path, head, tail, f):
    tmp = path + f'.{os.getpid()}.tmp.npz'
    np.savez(
        tmp, head=head, tail=tail, duration=f['duration'], tail_offset=f['tail_offset'], tail_checked=f['tail_checked'],
        head_bands=f['head']['bands'], head_hashes=f['head']['hashes'], head_frames=f['head']['frames'],
        tail_bands=f['tail']['bands'], tail_hashes=f['tail']['hashes'], tail_frames=f['tail']['frames'],
    )
    os.replace(tmp, path)


def _check_cached_tail(station, cached, path, head, tail):
    """cache เก่า (ก่อนมีการเช็ค seek) ของสตรีม HLS: เช็คเวลาเสียงท้ายตอนด้วย _tail_seek_error แล้วแก้ tail_offset + บันทึกว่าเช็คแล้ว
    mp4/ไฟล์ตรง seek แม่นอยู่แล้ว และเพลย์ลิสต์ที่เช็คแบบนี้ไม่ได้ (BYTERANGE) → บันทึกว่าเช็คแล้วเลย
    ต้องผ่าน worker / โหลดไม่ได้ชั่วคราว → ใช้ cache เดิม (ลองใหม่รอบหน้า); หาไม่เจอ (nomatch) → คืน False ให้ดึงใหม่ทั้งตอน"""
    try:
        src = _direct_stream(station)
        if not src:
            return True
        url, referer = src
        if hls_opts(url):
            status, err = _tail_seek_error(url, referer, cached['tail']['bands'], cached['tail_offset'], tail)
            if status == 'error':
                return True
            if status == 'nomatch':
                log(f'    cache เสียงท้ายตอนไม่ตรงกับสตรีม ({station.get("name")}) → ดึงใหม่')
                return False
            if status == 'ok' and abs(err) > SEEK_CHECK_TOL_SEC:
                log(f'    cache เสียงท้ายตอนคลาด {err:+.1f}s ({station.get("name")}) → แก้ tail_offset')
                cached['tail_offset'] -= err
        cached['tail_checked'] = True
        _save_cache(path, head, tail, cached)
    except Exception as e:
        log(f'    เช็คเวลาเสียงท้ายตอนไม่ได้ ({station.get("name")}): {e}')
    return True


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
                    tail_regions.append((s, e, r['sim'], other['bands'], r['offset']))
        if compared == 0:
            result[ep['idx']] = {'op': None, 'ed': None, 'error': 'ไม่มีตอนข้างเคียงให้เทียบ', 'duration': fi['duration']}
            continue
        op = _consensus(head_regions)
        if op:
            tail_regions = [r for r in tail_regions if _overlap(op['start'], op['end'], r[0], r[1]) < 0.5]
            intro_regions = [r for r in intro_regions if r[1] <= op['start'] + 1.0]
        ed = _extend_ed_tail(_consensus(tail_regions), fi) if fi['tail_offset'] > 0 else None
        if ed:
            ed['clipped'] = bool(ed['start'] - fi['tail_offset'] <= 1.0)
            ed['clean_start'] = _clean_start(fi, ed, [(r[3], r[4]) for r in tail_regions if _overlap(ed['start'], ed['song_end'], r[0], r[1]) >= 0.5])
        credits = _detect_credits(fi) if fi['tail_offset'] > 0 else None
        if credits and ed and credits['start'] - ed['end'] <= CREDITS_MERGE_GAP_SEC:
            ed['end'] = max(ed['end'], credits['end'])
            ed['to_eof'] = True
            credits = None
        intro = _consensus(intro_regions) or _detect_sting_intro(fi, op)
        eof = round(int(fi['duration'] * 10) / 10, 1)
        ed = _shift(ed, start_shift, end_shift)
        credits = _shift(credits, start_shift, end_shift)
        for region in (ed, credits):
            if region and region.get('to_eof'):
                region['end'] = eof
        result[ep['idx']] = {
            'op': _shift(op, start_shift, end_shift),
            'ed': ed,
            'intro': _shift(intro, start_shift, end_shift),
            'credits': credits,
            'duration': fi['duration'],
        }
    ed_trim_active = _trim_mixed_ed_start(result)
    _extend_to_song_length(episodes, feats, result, start_shift, end_shift, skip_ed=ed_trim_active)
    return result


def _clean_start(fi, ed, pairs):
    """จุดที่เพลงปิดเริ่มเป็น "เพลงล้วน": ต้นเพลงที่ฉากยังเล่น/มีเสียงพูดทับ (ต่างกันทุกตอน) ค่าคล้ายกับตอนข้างเคียงจะต่ำ
    → จุดแรกที่ค่ากลาง sim ของตอนข้างเคียง ≥ CLEAN_SIM ต่อเนื่อง CLEAN_HOLD_SEC (ผู้ใช้เริ่ม ED หลังเสียงพูดจบ)"""
    if len(pairs) < 2:
        return None
    a = fi['tail']['bands']
    to = fi['tail_offset']
    curves = [_smooth(np.nan_to_num(frame_similarity(a, b, off), nan=0.0), int(0.5 * FPS)) for b, off in pairs]
    m = np.median(np.array(curves), axis=0)
    hold = int(CLEAN_HOLD_SEC * FPS)
    lo = max(0, int((ed['start'] - to) * FPS))
    hi = int((ed['song_end'] - to) * FPS) - hold
    for f in range(lo, min(hi, len(m) - hold)):
        if m[f] >= CLEAN_SIM and np.all(m[f:f + hold] >= CLEAN_SIM - 0.05):
            return to + f / FPS
    return None


def _trim_mixed_ed_start(result):
    """ED ที่ต้นเพลงมีเสียงฉากทับ ≥ CLEAN_MIN_TRIM_SEC → เริ่มที่ song_end − ค่ากลางความยาว "เพลงล้วน" ของแทร็ก
    (ตำแหน่งในเพลงที่เสียงพูดจบมักเท่ากันทุกตอน; ใช้ค่ากลางกันตอนข้างเคียงที่เสียงพูดทับนานผิดปกติ) — ไม่เลื่อนให้เร็วขึ้น
    ยกเว้น ED ที่ชนขอบต้นของเสียงท้ายที่ดึงมา (clipped: เครดิตยาวดัน ED ออกนอกหน้าต่าง TAIL) → ใช้ค่ากลางเดียวกันขยายจุดเริ่ม
    ตัดเฉพาะแทร็กที่มีรูปแบบนี้ชัด (≥ CLEAN_MIN_EPISODES ตอนที่เสียงทับ ≥ CLEAN_STRONG_SEC) — เรื่องที่ต้นเพลงแค่เบา/คล้ายต่ำเล็กน้อย
    (เช่น Index ที่ผู้ใช้เริ่ม ED ตั้งแต่เพลงเริ่ม) จะไม่ถูกตัด — คืน True เมื่อแทร็กนี้ใช้กฎตัดต้นเพลง"""
    all_eds = [r['ed'] for r in result.values() if r.get('ed')]
    eds = [ed for ed in all_eds if ed.get('clean_start') is not None]
    lens = [_song_end(ed) - ed['clean_start'] for ed in eds]
    if len(lens) < CLEAN_MIN_EPISODES:
        return False
    best = None
    for center in lens:
        cluster = [x for x in lens if abs(x - center) <= LENGTH_OUTLIER_SEC]
        if best is None or len(cluster) > len(best):
            best = cluster
    pure = median(best)
    op_end = {id(r['ed']): r['op']['end'] for r in result.values() if r.get('ed') and r.get('op')}
    for ed in all_eds:
        if ed.get('clipped'):
            target = max(round(_song_end(ed) - pure, 1), op_end.get(id(ed), 0.0))
            if ed['start'] - target >= CLEAN_MIN_TRIM_SEC:
                ed['extended'] = round(ed['start'] - target, 1)
                ed['start'] = max(0.0, target)
    strong = sum(1 for ed in eds if ed['clean_start'] - ed['start'] >= CLEAN_STRONG_SEC)
    if strong < CLEAN_MIN_EPISODES:
        return False
    for ed in eds:
        if ed.get('extended') or ed['clean_start'] - ed['start'] < CLEAN_MIN_TRIM_SEC:
            continue
        target = round(_song_end(ed) - pure, 1)
        if target - ed['start'] >= CLEAN_MIN_TRIM_SEC:
            ed['trimmed'] = round(target - ed['start'], 1)
            ed['start'] = target
    return True


def _ref_song_length(regions, shift_gap):
    """ความยาวเพลงเต็มของแทร็ก (วินาทีก่อนปรับขอบ): กลุ่มความยาว ±EXTEND_REF_CLUSTER_SEC ที่ยาวที่สุดซึ่งมี ≥ CLEAN_MIN_EPISODES ตอน
    และอยู่ในช่วง EXTEND_REF_MIN_SEC–EXTEND_REF_MAX_SEC (~90±5 วิ ตามผู้ใช้) — เพลงที่ถูกตัดมีแต่สั้นลง จึงเลือกกลุ่มที่ยาวที่สุด ไม่ใช่กลุ่มที่ใหญ่ที่สุด"""
    lens = sorted((_song_len(r) + shift_gap for r in regions if r['support'] >= 2), reverse=True)
    for center in lens:
        cluster = [x for x in lens if abs(x - center) <= EXTEND_REF_CLUSTER_SEC]
        ref = median(cluster)
        if len(cluster) >= CLEAN_MIN_EPISODES and EXTEND_REF_MIN_SEC <= ref <= EXTEND_REF_MAX_SEC:
            return ref
    return None


def _longest_run(mask):
    best = run = 0
    for x in mask:
        run = run + 1 if x else 0
        best = max(best, run)
    return best


def _song_start_from_end(episodes, feats, i, part, s0, e0, ref):
    """จุดเริ่มเพลงที่นับถอยจากจุดจบ e0 ด้วยความยาว ref (วินาทีก่อนปรับขอบ) — None เมื่อยืนยันกับตอนข้างเคียงไม่ได้
    เทียบกับตอนข้างเคียง ±EXTEND_SPAN ด้วย offset ของช่วงซ้ำเดียวกัน; เฟรมนอกหน้าต่างเสียงที่ดึงมา (NaN) ไม่นับเป็นความต่าง"""
    fi = feats.get(episodes[i]['idx'])
    to = fi['tail_offset'] if part == 'tail' else 0.0
    if part == 'tail' and e0 - ref < to - EXTEND_WINDOW_TOL_SEC:
        return None
    my_key = station_key(episodes[i]['station'])
    curves = []
    for j in range(i - EXTEND_SPAN, i + EXTEND_SPAN + 1):
        if j == i or not 0 <= j < len(episodes):
            continue
        fj = feats.get(episodes[j]['idx'])
        if not fj or station_key(episodes[j]['station']) == my_key:
            continue
        for r in match_regions(fi[part], fj[part]):
            if _overlap(s0, e0, to + r['start_f'] / FPS, to + r['end_f'] / FPS) >= 0.5:
                raw = frame_similarity(fi[part]['bands'], fj[part]['bands'], r['offset'])
                curve = _smooth(np.nan_to_num(raw, nan=0.0), int(0.5 * FPS))
                curve[np.isnan(raw)] = np.nan
                curves.append(curve)
                break
    if len(curves) < 2:
        return None
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        m = np.nanmedian(np.array(curves), axis=0)
    k = int((max(to, e0 - ref) - to) * FPS)
    k1 = int((s0 - to) * FPS)
    limit = k + int(EXTEND_SEARCH_FWD_SEC * FPS)
    while k < k1 and (np.isnan(m[k]) or m[k] < EXTEND_SONG_SIM):
        k += 1
        if k > limit:
            return None
    floor = max(0, k - int(EXTEND_SEARCH_BACK_SEC * FPS))
    while k > floor and not np.isnan(m[k - 1]) and m[k - 1] >= EXTEND_SONG_SIM:
        k -= 1
    if k1 - k < EXTEND_MIN_SEC * FPS:
        return None
    seg = m[k:k1]
    if np.mean(np.isnan(seg)) > 1.0 - EXTEND_MIN_VALID:
        return None
    vals = np.nan_to_num(seg, nan=0.0)
    if _longest_run(vals < EXTEND_HOLD_SIM) > EXTEND_MAX_DIP_SEC * FPS or _longest_run(vals < EXTEND_SONG_SIM) > EXTEND_MAX_DEEP_SEC * FPS:
        return None
    return to + k / FPS


def _extend_to_song_length(episodes, feats, result, start_shift, end_shift, skip_ed=False):
    """OP/ED ที่สั้นกว่าความยาวเพลงเต็มของแทร็กเกิน LENGTH_OUTLIER_SEC (ช่วงเสียงต่างกันสั้น ๆ กลางเพลงทำให้ _walk หยุดก่อนถึงต้นเพลง
    เช่น REBORN! / Arifureta) → นับถอยจากจุดจบเพลงด้วยความยาวอ้างอิง แล้วหาจุดที่เสียงเริ่มเหมือนตอนข้างเคียง
    (เลื่อนไปข้างหน้า ≤ EXTEND_SEARCH_FWD_SEC / ถอยหลัง ≤ EXTEND_SEARCH_BACK_SEC) — ผู้ใช้เสนอ 2026-11-02
    ยอมรับเมื่อช่วงที่ขยายเหมือนตอนข้างเคียง ≥ 2 ตอน: ช่วง sim < EXTEND_HOLD_SIM ยาวไม่เกิน EXTEND_MAX_DIP_SEC,
    ช่วง sim < EXTEND_SONG_SIM ยาวไม่เกิน EXTEND_MAX_DEEP_SEC, เฟรมที่เทียบได้ ≥ EXTEND_MIN_VALID
    OP ที่เริ่มภายใน HEAD_SNAP_SEC แรกของไฟล์ → เริ่มที่ 0:00; ED ไม่เริ่มก่อน OP จบ
    แทร็กที่ใช้กฎตัดต้น ED ที่มีเสียงพูดทับ (skip_ed) ไม่ขยาย ED เพราะผู้ใช้เริ่ม ED หลังเสียงพูดจบโดยตั้งใจ"""
    shift_gap = start_shift - end_shift
    for kind, part in (('op', 'head'), ('ed', 'tail')):
        if kind == 'ed' and skip_ed:
            continue
        items = [(i, result[ep['idx']]) for i, ep in enumerate(episodes) if (result.get(ep['idx']) or {}).get(kind)]
        ref = _ref_song_length([r[kind] for _, r in items], shift_gap)
        if ref is None:
            continue
        for i, r in items:
            region = r[kind]
            if region.get('trimmed') or region.get('extended'):
                continue
            s0 = region['start'] - start_shift
            e0 = _song_end(region) - end_shift
            if e0 - s0 >= ref - LENGTH_OUTLIER_SEC:
                continue
            new = _song_start_from_end(episodes, feats, i, part, s0, e0, ref)
            if new is None:
                continue
            if kind == 'op' and new < HEAD_SNAP_SEC:
                new = 0.0
            if kind == 'ed' and r.get('op'):
                new = max(new, r['op']['end'] - end_shift)
            new_start = round(max(0.0, new + start_shift), 1)
            if region['start'] - new_start >= EXTEND_MIN_SEC:
                region['from_end'] = round(region['start'] - new_start, 1)
                region['start'] = new_start


def _video_source(station):
    """(url, referer, stream map) สำหรับดึงภาพ — None เมื่อดึงตรงจากเครื่องไม่ได้ (ต้องผ่าน worker) เพื่อไม่ใช้ quota ของ worker"""
    src = _direct_stream(station)
    if not src:
        return None
    url, referer = src
    host = urllib.parse.urlparse(url).netloc
    return url, referer, None if host in SEGMENT_ONLY_HOSTS else _video_stream(url, referer)


def _video_stream(url, referer):
    """'0:N' ของ stream วิดีโอจริงที่ความละเอียดต่ำสุด — HLS บางเว็บมี stream รูปปลอม (segment ปลอมเป็น .webp) ปนมา
    ทำให้ ffmpeg เลือกผิดแล้วไม่ได้ภาพ และมีหลาย variant (เลือกเล็กสุดให้ดึงเร็ว); None = ให้ ffmpeg เลือกเอง"""
    cmd = ['ffprobe', '-hide_banner', '-loglevel', 'error', *hls_opts(url)]
    if url.startswith('http'):
        cmd += ['-headers', ff_headers(referer)]
    cmd += ['-show_entries', 'stream=index,codec_type,codec_name,width', '-of', 'json', url]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        streams = json.loads(out.stdout or '{}').get('streams') or []
    except Exception:
        return None
    real = [x for x in streams if x.get('codec_type') == 'video' and x.get('codec_name') not in VISUAL_IMAGE_CODECS]
    if not real:
        return None
    return f"0:{min(real, key=lambda x: x.get('width') or float('inf'))['index']}"


def _grab_frames(src, t0, length, path, ref=None):
    """ภาพขาวดำ VISUAL_W×VISUAL_H ที่ VISUAL_FPS ช่วง [t0, t0+length) — cache เป็น .npy; ดึงไม่ได้คืน None
    HLS: ffmpeg -ss บางเว็บได้ภาพคลาดจากที่ขอ ~10–13 วิ (ป้ายเวลาผิด) → ดึงเสียงมาพร้อมกันแล้วหาตำแหน่งในเสียงที่ cache ไว้ (ref = (bands, เวลาเริ่ม))
    คลาดเกิน SEEK_CHECK_TOL_SEC → ขยับจุด seek แล้วดึงใหม่ (≤ SEEK_RETRIES ครั้ง); ยืนยันไม่ได้ → โหลด segment ตาม EXTINF เอง (_frames_via_segments)"""
    if os.path.exists(path):
        return np.load(path)
    url, referer, stream = src
    hls = bool(hls_opts(url))
    frames = None
    if urllib.parse.urlparse(url).netloc not in SEGMENT_ONLY_HOSTS and (ref is not None or not hls):
        ss = t0
        for _ in range(SEEK_RETRIES + 1):
            got = _ffmpeg_frames(url, referer, stream, ss, length, with_audio=hls)
            if got is None:
                break
            frames, bands = got
            if not hls:
                break
            start = None if bands is None else _locate_audio(ref[0], ref[1], bands, ss)
            if start is not None and abs(start - t0) <= SEEK_CHECK_TOL_SEC:
                break
            frames = None
            if start is None:
                break
            ss += t0 - start
    if (frames is None or len(frames) < VISUAL_FPS * length * 0.9) and hls:
        try:
            frames = _frames_via_segments(url, referer, t0, length)
        except Exception:
            frames = None
    if frames is None or len(frames) < VISUAL_FPS * length * 0.9:
        return None
    tmp = path + f'.{os.getpid()}.tmp.npy'
    np.save(tmp, frames)
    os.replace(tmp, path)
    return frames


def _ffmpeg_frames(url, referer, stream, ss, length, with_audio=False):
    """ffmpeg -ss → (ภาพ, band เสียงช่วงเดียวกัน หรือ None) — ล้มเหลวคืน None"""
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, 'a.wav')
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *hls_opts(url)]
        if url.startswith('http'):
            cmd += ['-headers', ff_headers(referer)]
        cmd += ['-ss', f'{max(0.0, ss):.3f}', '-i', url, '-t', f'{length:.3f}', '-map', stream or '0:v:0',
                '-vf', f'fps={VISUAL_FPS},scale={VISUAL_W}:{VISUAL_H},format=gray', '-f', 'rawvideo', 'pipe:1']
        if with_audio:
            cmd += ['-map', '0:a:0?', '-t', f'{length:.3f}', '-ac', '1', '-ar', str(SR), '-f', 'wav', wav]
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=300)
        except subprocess.TimeoutExpired:
            return None
        if out.returncode != 0:
            return None
        bands = None
        if with_audio and os.path.exists(wav):
            try:
                bands = analyze_wav(wav)['bands']
            except Exception:
                bands = None
        return _to_frames(out.stdout), bands


def _to_frames(raw):
    data = np.frombuffer(raw, dtype=np.uint8)
    size = VISUAL_W * VISUAL_H
    return data[:len(data) // size * size].reshape(-1, VISUAL_H, VISUAL_W)


def _frames_via_segments(url, referer, t0, length):
    """fallback ของ _grab_frames เมื่อ ffmpeg เปิด HLS ตรงไม่ได้ (segment ปลอมเป็นรูป เช่น 108player): โหลดเฉพาะ segment ที่คร่อมช่วง
    จาก variant ที่เล็กที่สุด ตัด header ปลอม ถอดภาพทีละ segment (timestamp แต่ละ segment อาจเริ่มใหม่) แล้ววางตามเวลา EXTINF"""
    items = _hls_media(url, referer)
    if not items:
        return None
    total = int(round(length * VISUAL_FPS))
    out = np.zeros((total, VISUAL_H, VISUAL_W), dtype=np.uint8)
    filled = np.zeros(total, dtype=bool)
    for s0, d, seg_url in items:
        if s0 + d <= t0 or s0 >= t0 + length:
            continue
        data = _strip_to_ts(_http_get(seg_url, referer))
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an',
               '-vf', f'fps={VISUAL_FPS},scale={VISUAL_W}:{VISUAL_H},format=gray', '-f', 'rawvideo', 'pipe:1']
        res = subprocess.run(cmd, input=data, capture_output=True, timeout=120)
        for j, frame in enumerate(_to_frames(res.stdout)):
            k = int(round((s0 + j / VISUAL_FPS - t0) * VISUAL_FPS))
            if 0 <= k < total:
                out[k] = frame
                filled[k] = True
    return out if filled.mean() >= 0.9 else None


def _unit_frames(frames):
    """ภาพย่อแต่ละเฟรมลบค่าเฉลี่ยแล้วหารความยาว (dot ของสองเฟรม = correlation) — ภาพเรียบ (จอดำ/ขาว) เทียบไม่ได้ เป็น NaN"""
    f = frames.reshape(len(frames), -1).astype(np.float32)
    f -= f.mean(axis=1, keepdims=True)
    norm = np.linalg.norm(f, axis=1)
    f /= np.maximum(norm, 1e-6)[:, None]
    f[norm < VISUAL_FLAT_NORM] = np.nan
    return f


def _visual_range(side, deficit=0.0):
    """ระยะค้นหาจุดตัด (τ ต่ำสุด, สูงสุด) จากขอบเสียง — ขอบเริ่มค้นเข้าไปในเพลงได้ VISUAL_SNAP_IN_SEC (เพลงขึ้นก่อนภาพ เช่น Accel World ~4–10 วิ, SAO ตอน 6 ~13 วิ)
    นอกนั้น ±VISUAL_SNAP_OUT_SEC: ออกนอกเพลงไกลกว่านี้เสี่ยงลามเข้าเนื้อเรื่อง/การ์ดตัวอย่างตอนต่อไปที่ใช้แม่แบบเดียวกันทุกตอน
    และขอบจบค้นเข้าในเพลงไกลไม่ได้ เพราะช็อตท้ายเพลงมักต่างกันทุกตอน (ภาพปิดประจำตอน) → จะหด OP/ED ผิด
    deficit = เพลงที่จับจากเสียงสั้นกว่าความยาวเต็มของแทร็กกี่วิ (เสียงท้ายเพลงถูกกลบ เช่น Skeleton Knight OP ตอน 3–5)
    → ขอบจบค้นออกนอกเพลงเพิ่มได้เท่านั้น (≤ VISUAL_SNAP_DEFICIT_MAX_SEC) — ผู้ใช้อนุมัติ 2026-11-02
    ขอบเริ่มไม่ใช้ deficit: ต้นเพลงที่ขาดมีกฎนับถอยจากจุดจบ (_extend_to_song_length) แล้ว และเพลงที่ขึ้นก่อนภาพทำให้ค้นออกไปเจอจุดตัดผิด (Accel World ตอน 23)"""
    if side == 0:
        return -VISUAL_SNAP_OUT_SEC, VISUAL_SNAP_IN_SEC
    return -VISUAL_SNAP_OUT_SEC, VISUAL_SNAP_OUT_SEC + min(max(0.0, deficit), VISUAL_SNAP_DEFICIT_MAX_SEC)


def _visual_inner(side):
    """ช่วงอ้างอิง (τ เริ่ม, จบ) ที่อยู่ในเพลงแน่ๆ ใช้จัดแนวภาพกับตอนข้างเคียง — ถัดจากระยะค้นหาเข้าไปในเพลง VISUAL_INNER_SEC"""
    lo, hi = _visual_range(side)
    if side == 0:
        return hi + VISUAL_INNER_SEC[0], hi + VISUAL_INNER_SEC[1]
    return lo - VISUAL_INNER_SEC[1], lo - VISUAL_INNER_SEC[0]


def _visual_align_range(side):
    """ระยะเลื่อนจัดแนวภาพกับตอนข้างเคียง (วินาที, ต่ำสุด/สูงสุด) — ขอบเริ่ม: ภาพ OP/ED ไม่ได้ผูกกับจังหวะเพลงเสมอ
    (SAO ตอน 6 เพลงนำภาพ 13 วิ ตอนข้างเคียงภาพมาพร้อมเพลง) จึงเลื่อนหาได้เท่าระยะค้นหาเข้าไปในเพลง และเลื่อนไปทางตอนข้างเคียงที่เพลงนำนานกว่า
    ได้ VISUAL_ALIGN_LATE_SEC; ขอบจบ ±VISUAL_ALIGN_MAX_SEC"""
    if side == 0:
        return -VISUAL_SNAP_IN_SEC, VISUAL_ALIGN_LATE_SEC
    return -VISUAL_ALIGN_MAX_SEC, VISUAL_ALIGN_MAX_SEC


def _visual_span(side, deficit=0.0):
    """ช่วงที่ดึงภาพ (τ เริ่ม, จบ) เทียบกับขอบเสียง: ระยะค้นหา + ช่วงอ้างอิง + เผื่อเลื่อนจัดแนว และช่วงคะแนนฝั่งนอก (VISUAL_PAD_SEC)"""
    lo, hi = _visual_range(side, deficit)
    a, b = _visual_inner(side)
    return (lo - VISUAL_PAD_SEC, b + 1.0 + VISUAL_ALIGN_LATE_SEC) if side == 0 else (a - 1.0, hi + VISUAL_PAD_SEC)


def _visual_edge(win, others, side, deficit=0.0):
    """จุดตัดภาพที่เป็นขอบ OP/ED — win/others = (frames, ดัชนีเฟรมของขอบเสียง); คืน (τ วินาทีจากขอบเสียง, score) หรือ None
    จัดแนวภาพกับตอนข้างเคียงแต่ละตอน (เลื่อนหาตาม _visual_align_range จากช่วงอ้างอิง _visual_inner ซึ่งอยู่ในเพลงแน่ๆ)
    → ค่ากลางความเหมือนต่อเฟรม → จุดตัด (ภาพเปลี่ยนกะทันหันเทียบกับทั้งหน้าต่างหรือกับความเคลื่อนไหวรอบ ๆ ±1 วิ)
    ในระยะค้นหาที่ฝั่งเพลงเหมือนตอนข้างเคียงและอีกฝั่งไม่เหมือน (คะแนน ≥ VISUAL_MIN_SCORE) — side 0 = ขอบเริ่ม (หลังจุดตัดเหมือน), 1 = ขอบจบ (ก่อนจุดตัดเหมือน)
    ขอบเริ่มใช้จุดตัดที่ผ่านเกณฑ์**แรกสุด**ซึ่งฝั่งหลังจุดตัดเหมือนตอนข้างเคียงชัด (≥ VISUAL_ONSET_SIM) แทนคะแนนสูงสุด: จุดเริ่ม OP/ED คือจุดแรก
    ที่ภาพเริ่มเหมือนตอนอื่น จุดตัดหลังจากนั้นเป็นจุดตัดภายใน (Okiraku Ryoushu มีการ์ดชื่อตอนที่ต่างกันทุกตอนอยู่กลาง OP → จุดตัดหลังการ์ดคะแนนสูงกว่า
    จุดเริ่มจริง ขอบถูกเลื่อน +19 วิ ทั้ง 16 ขอบ, 2026-11-08) — ต้องเหมือนชัดเพราะจุดตัดอ่อนก่อนเพลง ~1 วิ (ฝั่งหลังเหมือน 0.4–0.6) ผ่านเกณฑ์คะแนนได้
    (SAO S1 ตอน 9/18/24); ไม่มีจุดตัดที่เหมือนชัดเลย (ภาพเฟดเข้า เช่น SAO ตอน 6 เหมือน 0.8) ใช้คะแนนสูงสุดตามเดิม ขอบจบใช้คะแนนสูงสุดเสมอ
    ไม่พบด้วยค่ากลาง → ลองค่าสูงสุดของตอนข้างเคียง (ฝั่งเพลงเหมือนอย่างน้อย 1 ตอน อีกฝั่งไม่เหมือนตอนใดเลย): วิดีโอ OP/ED ที่ออกอากาศ
    มีหลายแบบที่หัวยาวต่างกัน เช่น Mahouka S1 ตอน 10–11 หัว ED ยาวกว่าตอน 8, 9, 12 อยู่ 1.1 วิ — ใช้เป็นทางสำรองเท่านั้น
    (ใช้แทนค่ากลางเลยแล้ว SAO ตอน 6 เลือกจุดตัดผิด 4.8 วิ)"""
    frames, centre = win
    ua = _unit_frames(frames)
    n = len(ua)
    a, b = _visual_inner(side)
    inner = np.arange(max(0, centre + int(a * VISUAL_FPS)), min(n, centre + int(b * VISUAL_FPS)))
    dk_lo, dk_hi = (int(x * VISUAL_FPS) for x in _visual_align_range(side))
    curves = []
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        for other, oc in others:
            ub = _unit_frames(other)
            base = oc - centre
            sims = ua[inner] @ ub.T
            best = None
            for dk in range(dk_lo, dk_hi + 1):
                idx = inner + base + dk
                ok = (idx >= 0) & (idx < len(ub))
                vals = sims[np.nonzero(ok)[0], idx[ok]]
                vals = vals[~np.isnan(vals)]
                if len(vals) < VISUAL_FPS:
                    continue
                score = float(vals.mean())
                if best is None or score > best[0]:
                    best = (score, dk)
            if not best or best[0] < VISUAL_ALIGN_MIN_SIM:
                continue
            off = base + best[1]
            rows = np.full((3, n), np.nan, dtype=np.float32)
            for i, e in enumerate((-1, 0, 1)):
                idx = np.arange(n) + off + e
                ok = (idx >= 0) & (idx < len(ub))
                rows[i, ok] = np.einsum('ij,ij->i', ua[ok], ub[idx[ok]])
            curves.append(np.nanmax(rows, axis=0))
        if not curves:
            return None
        lo, hi = _visual_range(side, deficit)
        diff = np.abs(np.diff(frames.astype(np.float32), axis=0)).mean(axis=(1, 2))
        local = np.array([np.median(diff[max(0, k - VISUAL_FPS):k + VISUAL_FPS + 1]) for k in range(len(diff))])
        floor = VISUAL_CUT_FACTOR * np.minimum(np.median(diff), local) + VISUAL_CUT_MIN
        stack = np.array(curves)
        for m in (np.nanmedian(stack, axis=0), np.nanmax(stack, axis=0)):
            best = None
            for k in range(len(diff)):
                c = k + 1
                tau = (c - centre) / VISUAL_FPS
                if diff[k] <= floor[k] or diff[k] < diff[max(0, k - 2):k + 3].max() or not lo <= tau <= hi:
                    continue
                pre = m[max(0, c - VISUAL_FPS):c]
                post = m[c:c + VISUAL_FPS]
                if len(pre) < VISUAL_FPS // 2 or len(post) < VISUAL_FPS // 2:
                    continue
                pa, pb = np.nanmean(pre), np.nanmean(post)
                if np.isnan(pa) or np.isnan(pb):
                    continue
                score = float(pb - pa if side == 0 else pa - pb)
                if score < VISUAL_MIN_SCORE:
                    continue
                if side == 0 and pb >= VISUAL_ONSET_SIM:
                    return (tau, score)
                if best is None or score > best[1]:
                    best = (tau, score)
            if best:
                return best
    return None


def _audio_ref(fi, t0, t1):
    """เสียงที่ cache ไว้ (bands, เวลาเริ่ม) ที่ซ้อนช่วง [t0, t1) มากที่สุด (≥ 5 วิ) ใช้ยืนยันเวลาภาพที่ดึงมา — None เมื่อไม่มี
    เสียงท้ายตอนใช้เฉพาะที่เช็คเวลาแล้ว (tail_checked) ไม่งั้นอาจ "แก้" ภาพไปตามป้ายเวลาที่ผิด"""
    if not fi:
        return None
    best = None
    for part, start in (('head', 0.0), ('tail', fi.get('tail_offset') or 0.0)):
        bands = fi[part]['bands']
        if part == 'tail' and (start <= 0 or not fi.get('tail_checked')) or not len(bands):
            continue
        overlap = min(t1, start + len(bands) / FPS) - max(t0, start)
        if overlap >= 5.0 and (best is None or overlap > best[0]):
            best = (overlap, bands, start)
    return (best[1], best[2]) if best else None


def _snap_to_video(episodes, det, cache_dir, start_shift, end_shift, workers, feats=None):
    """ขยับขอบ OP/ED ไปที่จุดตัดภาพ (ผู้ใช้กำหนดขอบตามภาพ 2026-11-02: เพลงมักคร่อมจุดตัดภาพ ±1 วิ ทั้งสองทิศ, บางเรื่องเพลงขึ้นก่อนภาพหลายวิ)
    ดึงภาพรอบขอบเสียงแต่ละขอบ (_visual_span, ตัดตามขอบไฟล์) เทียบกับตอนข้างเคียง ±NEIGHBOR_SPAN — ไม่พบจุดตัดที่ชัดเจนคงขอบเสียงเดิม
    ED ที่ตัดต้นเพลงเพราะเสียงพูดทับ (trimmed) ค้นจากจุดเริ่มเพลงก่อนตัด — พบจุดตัดภาพที่ตรงกับตอนข้างเคียงใช้จุดตัดภาพแทนการตัด
    (ตอนข้างเคียงที่มีเสียงพูดทับจริงทำให้ค่ากลางเพี้ยน เช่น Mahouka S2 ตอน 3, 12 ถูกตัดเกินภาพ ED 20 วิ) ไม่พบคงการตัดเดิม
    ไม่แตะ: ปลาย ED ที่รวมเครดิตเงียบ/ถึงท้ายไฟล์, ตอนที่ดึงตรงไม่ได้ (ไม่ใช้ worker)
    ขอบเริ่มที่พบจุดตัดภาพใช้ +VISUAL_START_SHIFT_SEC แทน start_shift (ขอบจบยังใช้ end_shift)"""
    shift_gap = start_shift - end_shift
    ref = {kind: _ref_song_length([r[kind] for r in det.values() if r.get(kind)], shift_gap) for kind in ('op', 'ed')}
    edges = {}
    for ep in episodes:
        r = det.get(ep['idx']) or {}
        dur = r.get('duration') or 0.0
        for kind in ('op', 'ed'):
            region = r.get(kind)
            if not region:
                continue
            deficit = max(0.0, ref[kind] - (_song_len(region) + shift_gap)) if ref[kind] else 0.0
            found = [(0, region['start'] - (region.get('trimmed') or 0.0) - start_shift)]
            if kind == 'op' or not region.get('to_eof') and region['end'] - _song_end(region) < VISUAL_CREDITS_GAP_SEC:
                found.append((1, _song_end(region) - end_shift))
            for side, t in found:
                a, b = _visual_span(side, deficit)
                t0, t1 = max(0.0, t + a), min(dur, t + b)
                if t1 - t0 >= (b - a) * 0.5 and t0 < t < t1:
                    edges[(ep['idx'], kind, side)] = (t, round(t0, 1), round(t1, 1), deficit)
    if not edges:
        return
    by_idx = {ep['idx']: ep for ep in episodes}

    def work(idx):
        """ภาพทุกขอบของตอน idx — ดึงไม่ได้ด้วยสาเหตุใดก็ตามคืนเท่าที่ได้ (ไม่ให้ report ล้ม)"""
        out = {}
        try:
            keys = [k for k in edges if k[0] == idx]
            st = by_idx[idx]['station']
            src = _video_source(st)
            if not src:
                return out
            for key in keys:
                t, t0, t1, _ = edges[key]
                path = os.path.join(cache_dir, f'{station_key(st)}-w{int(round(t0 * 10))}-{int(round(t1 * 10))}.npy')
                frames = _grab_frames(src, t0, t1 - t0, path, _audio_ref((feats or {}).get(idx), t0, t1))
                if frames is not None and len(frames) >= (t1 - t0) * VISUAL_FPS * 0.9:
                    out[key] = (frames, int(round((t - t0) * VISUAL_FPS)))
        except Exception as e:
            log(f'    ดึงภาพไม่ได้ ({e})')
        return out

    frames = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for got in ex.map(work, sorted({k[0] for k in edges})):
            frames.update(got)
    order = [ep['idx'] for ep in episodes]
    snapped = 0
    for key, win in frames.items():
        idx, kind, side = key
        pos = order.index(idx)
        others = [frames[(order[j], kind, side)] for j in range(pos - NEIGHBOR_SPAN, pos + NEIGHBOR_SPAN + 1)
                  if j != pos and 0 <= j < len(order) and (order[j], kind, side) in frames]
        found = _visual_edge(win, others, side, edges[key][3])
        if not found:
            continue
        r = det[idx]
        region = r[kind]
        tau = found[0]
        if side == 0:
            new = round(max(0.0, edges[key][0] + tau + VISUAL_START_SHIFT_SEC), 1)
            if kind == 'ed' and r.get('op') and new < r['op']['end']:
                continue
            if _song_end(region) - new < MIN_REGION_SEC:
                continue
            region['start'] = new
            region.pop('trimmed', None)
        else:
            new = round(edges[key][0] + tau + end_shift, 1)
            if new - region['start'] < MIN_REGION_SEC:
                continue
            region['end'] = new
            if 'song_end' in region:
                region['song_end'] = new
        region.setdefault('visual', {})['start' if side == 0 else 'end'] = round(tau, 2)
        snapped += 1
    log(f'  🎞 ขอบตามจุดตัดภาพ {snapped}/{len(edges)} ขอบ (ดึงภาพได้ {len(frames)})')


def _shift(region, start_delta, end_delta):
    if not region:
        return region
    for r in [region] + (region.get('alts') or []):
        r['start'] = round(max(0.0, r['start'] + start_delta), 1)
        r['end'] = round(max(r['start'] + 1.0, r['end'] + end_delta), 1)
        if 'song_end' in r:
            r['song_end'] = round(max(r['start'] + 1.0, r['song_end'] + end_delta), 1)
        if r.get('clean_start') is not None:
            r['clean_start'] = round(r['clean_start'] + start_delta, 1)
    return region


def _extend_ed_tail(ed, fi):
    """ED: ความเงียบสนิทที่ต่อจากเพลง (end credit ไม่มีเสียง) นับเป็น ED ทั้งหมด ไม่จำกัดความยาวแบบ _extend_over_silence
    ED ที่ไปถึงท้ายวิดีโอ (วิดีโอถูกตัด หรือเงียบจนจบไฟล์) → to_eof: จุดจบ = วินาทีสุดท้ายของวิดีโอ ไม่หักขอบ
    song_end = จุดจบของเพลงเอง ใช้เทียบความยาวกับตอนอื่น/อีกแทร็ก (ช่วงเงียบยาวไม่เท่ากันทุกตอน)"""
    if not ed:
        return ed
    ed['song_end'] = ed['end']
    bands = fi['tail']['bands']
    if len(bands):
        quiet = np.log(np.exp(bands.astype(np.float32)).sum(axis=1)) < SILENCE_FLOOR
        blip = int(SILENCE_BLIP_SEC * FPS)
        k = int(round((ed['end'] - fi['tail_offset']) * FPS))
        last, gap, j = k, 0, k + 1
        while 0 <= j < len(quiet):
            if quiet[j]:
                last, gap = j, 0
            else:
                gap += 1
                if gap > blip:
                    break
            j += 1
        if last > k:
            ed['end'] = fi['tail_offset'] + last / FPS
    if fi['duration'] - ed['end'] <= ED_EOF_TOL_SEC:
        ed['to_eof'] = True
    return ed


_sting_cache = {}


def _sting_ref():
    """fingerprint เสียง Netflix "ta-dum" (~3.6 วิ, log-band ต่อเฟรม) — None ถ้าไม่มีไฟล์อ้างอิง"""
    if 'ref' not in _sting_cache:
        ref = np.load(STING_REF_PATH).astype(np.float32) if os.path.exists(STING_REF_PATH) else None
        if ref is not None:
            ref = ref - ref.mean(axis=1, keepdims=True)
            ref = ref / (np.linalg.norm(ref, axis=1, keepdims=True) + 1e-6)
        _sting_cache['ref'] = ref
    return _sting_cache['ref']


def _sting_hits(bands, lo, hi):
    """เฟรมเริ่มของ sting ที่อยู่ในช่วงเฟรม [lo, hi] → list ของ (frame, sim) เรียงตามเวลา (sim ≥ STING_SIM)"""
    ref = _sting_ref()
    if ref is None or len(bands) == 0:
        return []
    k = len(ref)
    lo = max(0, lo)
    seg = bands[lo:min(len(bands), hi + k)].astype(np.float32)
    if len(seg) < k:
        return []
    seg = seg - seg.mean(axis=1, keepdims=True)
    seg = seg / (np.linalg.norm(seg, axis=1, keepdims=True) + 1e-6)
    corr = fftconvolve(seg, ref[::-1], mode='valid', axes=0).sum(axis=1) / k
    hits = []
    for f in np.nonzero(corr >= STING_SIM)[0]:
        if hits and f - hits[-1][0] < k:
            if corr[f] > hits[-1][1]:
                hits[-1] = (int(f), float(corr[f]))
            continue
        hits.append((int(f), float(corr[f])))
    return [(lo + f, round(v, 2)) for f, v in hits]


def _quiet_frames(bands):
    return np.log(np.exp(bands.astype(np.float32)).sum(axis=1)) < SILENCE_FLOOR


def _detect_credits(fi):
    """end credit เงียบสนิทจนจบไฟล์ (เช่นเครดิตพากย์ Netflix) ยาว ≥ CREDITS_MIN_SEC → region ถึงท้ายวิดีโอ
    ถ้ามี Netflix sting นำหน้าความเงียบ เริ่มที่ sting (ผู้ใช้นับ sting เป็นส่วนของเครดิต); ไม่ต้องมีตอนข้างเคียงยืนยัน"""
    bands = fi['tail']['bands']
    if len(bands) == 0:
        return None
    quiet = _quiet_frames(bands)
    blip = int(SILENCE_BLIP_SEC * FPS)
    start, gap = len(quiet), 0
    for j in range(len(quiet) - 1, -1, -1):
        if quiet[j]:
            start, gap = j, 0
        else:
            gap += 1
            if gap > blip:
                break
    if start >= len(quiet) or (len(quiet) - start) / FPS < CREDITS_MIN_SEC:
        return None
    if fi['duration'] - (fi['tail_offset'] + len(quiet) / FPS) > ED_EOF_TOL_SEC:
        return None
    ref = _sting_ref()
    k = len(ref) if ref is not None else 0
    sim = 1.0
    hits = _sting_hits(bands, start - k - int(STING_LEAD_SEC * FPS), start - k + int(STING_LEAD_SEC * FPS))
    if hits:
        start, sim = hits[-1]
    limit = int(SILENCE_EXTEND_SEC * FPS)
    n = 0
    while start > 0 and quiet[start - 1] and n < limit:
        start -= 1
        n += 1
    return {'start': fi['tail_offset'] + start / FPS, 'end': fi['duration'], 'support': 1, 'sim': sim,
            'alts': [], 'to_eof': True, 'sting': bool(hits)}


def _detect_sting_intro(fi, op):
    """intro ของ Netflix: sting ใน STING_LEAD_SEC แรกของไฟล์ + ความเงียบต่อท้าย → 0 ถึงจบความเงียบ (ไม่เกิน STING_INTRO_MAX_SEC
    และไม่ทับ OP)"""
    bands = fi['head']['bands']
    hits = _sting_hits(bands, 0, int(STING_LEAD_SEC * FPS))
    if not hits:
        return None
    f0, sim = hits[0]
    quiet = _quiet_frames(bands)
    blip = int(SILENCE_BLIP_SEC * FPS)
    end = f0 + len(_sting_ref())
    j = next((x for x in range(end, min(len(quiet), end + int(STING_LEAD_SEC * FPS))) if quiet[x]), None)
    if j is None:
        return None
    gap = 0
    while j < len(quiet) and (j - f0) / FPS < STING_INTRO_MAX_SEC:
        if quiet[j]:
            end, gap = j + 1, 0
        else:
            gap += 1
            if gap > blip:
                break
        j += 1
    end_sec = end / FPS
    if op and end_sec > op['start']:
        end_sec = op['start']
    return {'start': 0.0, 'end': end_sec, 'support': 1, 'sim': sim, 'alts': [], 'sting': True}


def _song_end(region):
    return region.get('song_end', region['end'])


def _song_len(region):
    return _song_end(region) - region['start']


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


def segment_for(station, kind):
    """segment เดิมของ kind — credits = ED-family ช่วงที่สอง (เครดิตที่มีฉากคั่นหลัง ED เก็บเป็น ed อีกช่วง)"""
    if kind != 'credits':
        return existing_segment(station, KIND_TYPES[kind])
    eds = [s for s in (((station.get('skip') or {}).get('segments')) or []) if s.get('type') in ED_TYPES]
    return eds[1] if len(eds) > 1 else None


def verdict(existing, detected, tol, error=None):
    """ok/fix = มีค่าเดิม; missing = ไม่มีค่าเดิมแต่ตรวจพบเสียงชัด; review = ตรวจพบแต่ความคล้ายต่ำ
    (เพลงอาจผสมเสียงพูด/ฉาก → ต้องให้คนตัดสิน type ว่าเป็น mixed-* หรือไม่ ไม่เติมอัตโนมัติ)
    error = ตรวจไม่ได้ (โหลดสตรีมไม่ได้/ไม่มีตอนข้างเคียง) ไม่ตัดสินค่าเดิม
    ขอบที่ยืนยันด้วยจุดตัดภาพ (detected.visual.start/end) ใช้ tolerance VISUAL_FIX_TOL_SEC แทน tol"""
    if error:
        return 'error', None, None
    if existing and detected:
        visual = detected.get('visual') or {}
        ds = round(detected['start'] - float(existing['start']), 1)
        de = round(detected['end'] - float(existing['end']), 1)
        tol_s = VISUAL_FIX_TOL_SEC if visual.get('start') is not None else tol
        tol_e = VISUAL_FIX_TOL_SEC if visual.get('end') is not None else tol
        return ('ok' if abs(ds) <= tol_s and abs(de) <= tol_e else 'fix'), ds, de
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
        if args.visual:
            _snap_to_video(episodes, det, cache_dir, args.start_shift, args.end_shift, args.workers, tfeats)
        rows = []
        for ep in episodes:
            st = ep['station']
            d = det[ep['idx']]
            err = ep['error'] or d.get('error')
            row = {'idx': ep['idx'], 'label': ep['label'], 'name': st.get('name'), 'duration': d.get('duration'), 'error': err}
            for kind in KIND_TYPES:
                ex = segment_for(st, kind)
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

    stations = {(track_name(season, track), i): st for season, track in walk_tracks(playlist) for i, st in enumerate(track.get('stations') or [])}
    _cross_track_check(report, {'stations': stations, 'feats': feats, 'cache_dir': cache_dir} if args.visual else None)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    print_report(report)


def _cross_track_check(report, visual=None):
    """ตอนเดียวกันในอีกแทร็กของ season เดียวกัน (พากย์/ซับ มักเป็นวิดีโอชุดเดียวกัน) ถ้าค่าที่ตรวจพบต่างกันเกิน
    CROSS_TRACK_TOL → ลด fix/missing เป็น review พร้อมหมายเหตุ (apply ยังบันทึกและแจ้ง "ต้องดู" — ผู้ใช้กำหนด 2026-11-03)
    ลดเป็น review เฉพาะตอนที่วิดีโอสองแทร็กยาวต่างกัน ≤ CROSS_TRACK_SAME_FILE_SEC (ไฟล์เดียวกัน) — คนละไฟล์ตำแหน่ง OP/ED ต่างกันได้จริง
    (ผู้ใช้ยืนยัน 2026-11-02: GGO พากย์ 24:00 / ซับ 23:40 ค่าที่ตรวจพบถูกทั้งสองแทร็ก)
    _adopt_other_track (จุดเริ่ม/จบตรงกันแต่แทร็กนี้จับสั้น) ใช้กับแถว ok ด้วย: ค่าเดิมที่ตรงกับเสียงที่จับได้สั้นเกินจริง
    (Blue Box พากย์ ตอน 1 ED จบ 23:20.7 ขณะเครดิตยาวถึงท้ายไฟล์ 23:34) ไม่งั้นตรวจใหม่จะคงค่าสั้นไว้ต่างจากการตรวจหลัง fetch
    visual = {stations, feats, cache_dir} ให้ยืนยันการยืมช่วงด้วยภาพ (ผู้ใช้กำหนด 2026-11-07) — None = ไม่ดึงภาพ"""
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
                    if not dt or ep[kind]['verdict'] not in ('ok', 'fix', 'missing'):
                        continue
                    for o in others:
                        match = next((e for e in o['episodes'] if e['label'] == ep['label']), None)
                        od = match and match[kind]['detected']
                        if not od:
                            continue
                        if abs(od['start'] - dt['start']) > CROSS_TRACK_TOL or abs(_song_end(od) - _song_end(dt)) > CROSS_TRACK_TOL:
                            if _same_region_shifted(dt, od):
                                continue
                            pair = visual and (visual['stations'].get((tr['track'], ep['idx'])), visual['stations'].get((o['track'], match['idx'])),
                                               visual['feats'].get((tr['track'], ep['idx'])), visual['feats'].get((o['track'], match['idx'])), visual['cache_dir'])
                            if _adopt_other_track(ep, kind, dt, od, o['track'], pair, match.get('duration')):
                                continue
                            if ep[kind]['verdict'] == 'ok':
                                continue
                            if abs((ep.get('duration') or 0.0) - (match.get('duration') or 0.0)) > CROSS_TRACK_SAME_FILE_SEC:
                                continue
                            ep[kind]['verdict'] = 'review'
                            ep[kind]['cross_track'] = f'{o["track"].split("/")[-1]} {fmt_t(od["start"])}-{fmt_t(od["end"])}'


def _same_region_shifted(dt, od):
    """2 แทร็กเป็นไฟล์คนละตัดต่อ (เช่น ซับไทยมี bumper หน้าไฟล์ 4 วิ) — ช่วงเลื่อนทั้งก้อนเท่ากันและยาวเท่ากัน
    → ถือว่าตรงกัน (ต่างกันเพราะไฟล์ ไม่ใช่เพราะจับผิด)"""
    ds = od['start'] - dt['start']
    de = _song_end(od) - _song_end(dt)
    if abs(ds) > MAX_TRACK_SHIFT_SEC:
        return False
    return abs(ds - de) <= 1.5 and abs(_song_len(dt) - _song_len(od)) <= 1.5


def _adopt_other_track(ep, kind, dt, od, other_track, pair=None, other_duration=None):
    """2 แทร็กเริ่มหรือจบพร้อมกัน (วิดีโอชุดเดียวกัน) แต่แทร็กนี้จับได้สั้นกว่า (เสียงพากย์ทับหัว/ท้ายเพลง) ขณะที่อีกแทร็กยาว ~90 วิ
    → ใช้ช่วงของอีกแทร็กแทน (คง verdict เดิม; แถว ok เทียบค่าเดิมใหม่) และบันทึกที่มาไว้ในหมายเหตุ
    pair = (station นี้, station อีกแทร็ก, feats นี้, feats อีกแทร็ก, cache_dir) → ยืมเมื่อภาพช่วงที่ยืม (จากขอบของแทร็กนี้ถึงขอบของอีกแทร็ก)
    ตรงกันทั้งสองแทร็ก (_cross_visual_sim ≥ VISUAL_ALIGN_MIN_SIM) — ภาพไม่ตรง = คนละตัดต่อ ไม่ยืม; ดึงภาพไม่ได้ (ต้องผ่าน worker) ยืมตามเสียงอย่างเดิม"""
    mine = _song_len(dt)
    theirs = _song_len(od)
    starts_agree = abs(od['start'] - dt['start']) <= CROSS_TRACK_TOL
    ends_agree = abs(_song_end(od) - _song_end(dt)) <= CROSS_TRACK_TOL
    if not (starts_agree or ends_agree):
        return False
    if abs(theirs - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL or mine >= theirs - CROSS_TRACK_TOL:
        return False
    if pair and pair[0] and pair[1]:
        if starts_agree:
            t0, t1 = max(_song_end(dt), _song_end(od) - CROSS_VISUAL_SPAN_SEC) - CROSS_VISUAL_PAD_SEC, _song_end(od) + CROSS_VISUAL_PAD_SEC
        else:
            t0, t1 = od['start'] - CROSS_VISUAL_PAD_SEC, min(dt['start'], od['start'] + CROSS_VISUAL_SPAN_SEC) + CROSS_VISUAL_PAD_SEC
        t0, t1 = max(0.0, t0), min(t1, ep.get('duration') or t1, other_duration or t1)
        sim = _cross_visual_sim(pair, t0, t1)
        if sim is not None:
            ep[kind]['cross_visual'] = round(sim, 2)
            if sim < VISUAL_ALIGN_MIN_SIM:
                log(f'    ไม่ยืม {kind} ตอน {ep["label"]} จาก{other_track.split("/")[-1]}: ภาพช่วง {fmt_t(t0)}-{fmt_t(t1)} ไม่ตรงกัน (sim {sim:.2f})')
                return False
    dt['start'], dt['end'] = od['start'], od['end']
    dt['song_end'] = _song_end(od)
    dt.pop('to_eof', None)
    if od.get('to_eof'):
        dt['to_eof'] = True
    if ep.get('duration'):
        if dt.get('to_eof'):
            dt['end'] = round(int(ep['duration'] * 10) / 10, 1)
        else:
            dt['end'] = round(min(dt['end'], ep['duration'] - 0.5), 1)
    dt['sim'] = min(dt['sim'], od['sim'])
    dt.pop('visual', None)
    if od.get('visual'):
        dt['visual'] = dict(od['visual'])
    ep[kind]['from_track'] = other_track.split('/')[-1]
    if ep[kind]['existing']:
        v, ds, de = verdict(ep[kind]['existing'], dt, DEFAULT_TOLERANCE)
        ep[kind]['d_start'], ep[kind]['d_end'] = ds, de
        ep[kind]['verdict'] = v
    return True


def _cross_visual_sim(pair, t0, t1):
    """ความเหมือนของภาพสองแทร็กช่วง [t0, t1) (ค่าเฉลี่ย correlation ต่อเฟรมหลังจัดแนวเลื่อนได้ ±CROSS_TRACK_TOL)
    None = ดึงภาพไม่ได้/สั้นเกิน หรือเฟรมเรียบ (จอดำ) จนเทียบไม่ได้"""
    st_a, st_b, fa, fb, cache_dir = pair
    if t1 - t0 < 2.0:
        return None
    got = []
    for st, fi in ((st_a, fa), (st_b, fb)):
        src = _video_source(st)
        if not src:
            return None
        path = os.path.join(cache_dir, f'{station_key(st)}-w{int(round(t0 * 10))}-{int(round(t1 * 10))}.npy')
        try:
            frames = _grab_frames(src, round(t0, 1), round(t1 - t0, 1), path, _audio_ref(fi, t0, t1))
        except Exception as e:
            log(f'    ดึงภาพไม่ได้ ({e})')
            return None
        if frames is None or len(frames) < (t1 - t0) * VISUAL_FPS * 0.5:
            return None
        got.append(_unit_frames(frames))
    ua, ub = got
    best = None
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', RuntimeWarning)
        for dk in range(-int(CROSS_TRACK_TOL * VISUAL_FPS), int(CROSS_TRACK_TOL * VISUAL_FPS) + 1):
            ia = np.arange(len(ua))
            ib = ia + dk
            ok = (ib >= 0) & (ib < len(ub))
            vals = np.einsum('ij,ij->i', ua[ok], ub[ib[ok]])
            vals = vals[~np.isnan(vals)]
            if len(vals) < VISUAL_FPS:
                continue
            score = float(vals.mean())
            if best is None or score > best:
                best = score
    return best


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
                    notes.append(f'{kind} ใช้ช่วงของ{r["from_track"]}' + (f' (ภาพตรงกัน {r["cross_visual"]:.2f})' if r.get('cross_visual') is not None else ''))
                elif r.get('cross_visual') is not None:
                    notes.append(f'{kind} ไม่ยืมช่วงจากอีกแทร็ก ภาพไม่ตรงกัน {r["cross_visual"]:.2f}')
                if dt and med_len[kind] is not None and _length_outlier(dt, med_len[kind]):
                    notes.append(f'{kind} ยาว {_song_len(dt):.1f}s ≠ ค่ากลาง')
                elif dt and abs(_song_len(dt) - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL:
                    notes.append(f'{kind} ยาว {_song_len(dt):.1f}s ≠ ~90s')
                if dt and dt.get('trimmed'):
                    notes.append(f'{kind} ตัดต้นเพลงที่มีเสียงฉากทับ {dt["trimmed"]:.1f}s')
                if dt and dt.get('extended'):
                    notes.append(f'{kind} ต้นเพลงอยู่ก่อนช่วงเสียงท้ายที่ดึงมา ขยายตามความยาวกลาง {dt["extended"]:.1f}s')
                if dt and dt.get('visual'):
                    notes.append(f'{kind} ตามจุดตัดภาพ ' + ' '.join(f'{k} {v:+.2f}s' for k, v in dt['visual'].items()))
                if dt and dt.get('from_end'):
                    notes.append(f'{kind} ขยายต้นเพลงย้อนจากจุดจบตามความยาวเพลงเต็ม {dt["from_end"]:.1f}s')
                if dt and dt.get('to_eof'):
                    notes.append(f'{kind} ถึงท้ายวิดีโอ (เพลงจบ {fmt_t(_song_end(dt))})')
                elif dt and dt['end'] - _song_end(dt) >= 1.0:
                    notes.append(f'{kind} รวมเครดิตเงียบ {dt["end"] - _song_end(dt):.1f}s')
                if ex and abs((float(ex['end']) - float(ex['start'])) - TYPICAL_LENGTH_SEC) > TYPICAL_LENGTH_TOL:
                    notes.append(f'{kind} เดิมยาว {float(ex["end"]) - float(ex["start"]):.1f}s')
            for extra in ('intro', 'credits'):
                rx = ep.get(extra) or {}
                if rx.get('detected') or rx.get('existing'):
                    dti, exi = rx.get('detected'), rx.get('existing')
                    sting = ' sting' if dti and dti.get('sting') else ''
                    notes.append(f'{extra} ' + (f'{fmt_t(exi["start"])}-{fmt_t(exi["end"])} เดิม ' if exi else '') + (f'{fmt_t(dti["start"])}-{fmt_t(dti["end"])} ตรวจพบ{sting} ' if dti else '') + f'({rx.get("verdict")})')
                    totals[f'{extra}:{rx.get("verdict")}'] += 1
            if ep.get('error'):
                notes.append('ERR ' + ep['error'][:60])
            if ep.get('other_segments'):
                notes.append('other=' + ','.join(s.get('type', '?') for s in ep['other_segments']))
            if ep.get('skip_source'):
                notes.append(f'skip={ep["skip_source"]}')
            w = [8, 16, 16, 13, 11, 16, 16, 13, 11]
            print(''.join(f'{c:<{w[i]}}' for i, c in enumerate(cells)) + ' '.join(notes))
    print('\nสรุป: ' + ', '.join(f'{k}={v}' for k, v in sorted(totals.items())))


def _visually_confirmed(kind, dt):
    """OP/ED ที่จุดตัดภาพยืนยันทั้งขอบเริ่มและขอบจบ (_snap_to_video) — หลักฐานจากภาพแยกจากเสียง จึงลดจำนวนตอนข้างเคียงที่ต้องยืนยันลง 1
    (ผู้ใช้อนุมัติ 2026-11-02: ตอนแรก/ตอนที่ข้างเคียงไม่มี ED ยืนยันด้วยเสียงได้ตอนเดียว)"""
    visual = dt.get('visual') or {}
    return kind in ('op', 'ed') and 'start' in visual and 'end' in visual


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
    removals = set()
    for item in args.remove or []:
        m = re.match(r'^(.+?)\|(.+?)\|(op|ed|intro|credits)$', item.strip())
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
            edited = bool((st.get('skip') or {}).get('edited'))
            touched = False
            for kind, types in KIND_TYPES.items():
                r = row.get(kind)
                if r is None:
                    continue
                dt = r['detected']
                seg = segment_for(st, kind)
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
                        st['skip'].update(source='manual', edited=True)
                        touched = True
                        changes.append((tn, label, kind, 'rm', (seg['start'], seg['end']), None, {'support': None, 'sim': None}))
                    continue
                if ov:
                    dt = {'start': ov[0], 'end': ov[1], 'support': 'manual', 'sim': None}
                    v = 'fix' if seg else 'missing'
                    if v == 'fix' and seg['start'] == num(dt['start']) and seg['end'] == num(dt['end']):
                        continue
                else:
                    if edited or not dt or row.get('error') or r['verdict'] == 'error':
                        continue
                    v, _, _ = verdict(r['existing'], dt, tol)
                    if v == 'review':
                        if kind not in ('op', 'ed'):
                            continue
                        v = 'missing'
                        dt['mixed'] = True
                    min_support = 1 if (kind == 'intro' and dt['sim'] >= 0.9) or kind == 'credits' else args.min_support
                    if _visually_confirmed(kind, dt):
                        min_support = max(1, min_support - 1)
                    if dt['support'] < min_support:
                        dt['min_support'] = min_support
                    if not r['existing'] and kind in ((st.get('skip') or {}).get('none') or []):
                        continue
                    if kind == 'credits' and _covered_by_ed(st, dt):
                        continue
                    med = _median_length(by_track[tn], kind) if kind in ('op', 'ed') else None
                    if med is not None and _length_outlier(dt, med):
                        dt['median_length'] = round(med, 1)
                    if v == 'missing' and r.get('cross_track'):
                        dt['cross_track'] = r['cross_track']
                if v == 'fix' and (args.fix or ov):
                    old = (seg['start'], seg['end'])
                    seg['start'] = num(dt['start'])
                    seg['end'] = num(dt['end'])
                    if ov:
                        st['skip'].update(source='manual', edited=True)
                    touched = True
                    changes.append((tn, label, kind, 'fix', old, (seg['start'], seg['end']), dt))
                elif v == 'missing' and (args.fill or ov):
                    source = 'manual' if ov else args.source
                    skip = st.setdefault('skip', {'source': source, 'segments': []})
                    skip.setdefault('source', source)
                    segs = skip.setdefault('segments', [])
                    seg_type = 'ed' if kind == 'credits' else f'mixed-{kind}' if dt.get('mixed') else kind
                    segs.append({'type': seg_type, 'start': num(dt['start']), 'end': num(dt['end'])})
                    if ov:
                        skip.update(source='manual', edited=True)
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
    if not changes and not marked:
        if args.json_out:
            _write_json_out(args.json_out, args.playlist, changes, marked)
        print('ไม่มีอะไรต้องแก้')
        return
    out = json.dumps(playlist, ensure_ascii=False, indent=4)
    if raw.endswith('\n'):
        out += '\n'
    with open(args.playlist, 'w', encoding='utf-8') as f:
        f.write(out)
    if args.json_out:
        _write_json_out(args.json_out, args.playlist, changes, marked)
    for tn, label, kind, how, old, new, dt in changes:
        o = f'{fmt_t(old[0])}-{fmt_t(old[1])} → ' if old else ''
        n = f'{fmt_t(new[0])}-{fmt_t(new[1])}' if new else '(ลบ)'
        notice = _notice(kind, dt)
        print(f'{how:<5}{tn:<24}ตอน {str(label):<8}{kind:<4}{o}{n}  (support={dt["support"] if dt["support"] is not None else "-"} sim={dt["sim"] if dt["sim"] is not None else "-"})'
              + (f'  ⚠️ ต้องดู: {notice}' if notice else ''))
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


def _notice(kind, dt):
    """ข้อความแจ้ง "ต้องดู" ของช่วงที่บันทึกแล้วแต่ผิดปกติ (ผู้ใช้กำหนด 2026-11-02/03: แจ้งแต่บันทึกค่าไปเลย) — None เมื่อไม่ต้องแจ้ง
    - OP/ED: จุดตัดภาพห่างจากขอบเพลง ≥ VISUAL_NOTICE_SEC (SAO ตอน 6 ภาพ ED เริ่มช้ากว่าเพลง 13 วิ)
      และ ED ที่ยังถูกตัดต้นเพลง (trimmed) ≥ VISUAL_NOTICE_SEC หลังค้นจุดตัดภาพไม่พบ (Mahouka S2 ตอน 11–12 ภาพ ED จริงเริ่มก่อนหน้า)
    - ค่าที่ apply ใส่ไว้: median_length (ยาวต่างจากค่ากลางแทร็ก), min_support (ตอนข้างเคียงยืนยันไม่ถึงเกณฑ์),
      cross_track (ไม่ตรงกับอีกแทร็ก), mixed (เสียงคล้ายต่ำ เขียนเป็น mixed-*)"""
    parts = []
    if kind in ('op', 'ed'):
        visual = dt.get('visual') or {}
        for edge, word in (('start', 'เริ่ม'), ('end', 'จบ')):
            tau = visual.get(edge)
            if tau is not None and abs(tau) >= VISUAL_NOTICE_SEC:
                parts.append(f'ภาพ {kind.upper()} {word}{"ช้ากว่า" if tau > 0 else "เร็วกว่า"}เพลง {abs(tau):.1f} วิ')
        if (dt.get('trimmed') or 0.0) >= VISUAL_NOTICE_SEC:
            parts.append(f'{kind.upper()} ตัดต้นเพลง {dt["trimmed"]:.1f} วิ (เสียงพูดทับ) ยืนยันด้วยภาพไม่ได้')
    if dt.get('median_length') is not None:
        parts.append(f'{kind.upper()} ยาว {_song_len(dt):.1f} วิ ต่างจากค่ากลางของแทร็ก {dt["median_length"]:.1f} วิ')
    if dt.get('min_support'):
        parts.append(f'ตอนข้างเคียงยืนยัน {dt["support"]} ตอน (เกณฑ์ {dt["min_support"]})')
    if dt.get('cross_track'):
        parts.append(f'ไม่ตรงกับ {dt["cross_track"]}')
    if dt.get('mixed'):
        parts.append(f'เสียงคล้ายตอนอื่นต่ำ (sim {dt["sim"]}) บันทึกเป็น mixed-{kind} ไม่ข้ามอัตโนมัติ')
    return ', '.join(parts) or None


def _write_json_out(path, playlist_path, changes, marked=()):
    """ผลของ apply แบบ machine-readable สำหรับ job อัตโนมัติ — label ตรงกับที่ --episodes รับ (เลขตอน หรือ #idx)
    changes[].action: fill | fix | rm (rm/fix มี old; rm ไม่มี start/end); changes[].notice = ข้อความแจ้งให้คนดู (_notice) หรือ null
    marked = ตอนที่ --mark-none เขียน skip {segments: []} (ตรวจแล้วไม่พบ op/ed/intro)"""
    out = {
        'playlist': os.path.realpath(playlist_path),
        'changes': [
            {
                'track': tn, 'label': label, 'kind': kind, 'action': how,
                'start': new[0] if new else None, 'end': new[1] if new else None,
                'old': {'start': old[0], 'end': old[1]} if old else None,
                'support': dt.get('support'), 'sim': dt.get('sim'), 'notice': _notice(kind, dt),
            }
            for tn, label, kind, how, old, new, dt in changes
        ],
        'marked': [{'track': tn, 'label': label} for tn, label in marked],
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def _covered_by_ed(station, dt):
    """เครดิตที่ตรวจพบอยู่ใน ED เดิมเกินครึ่งแล้ว (เช่นผู้ใช้รวบ ED ถึงท้ายไฟล์ไว้) → ไม่เติมซ้ำ"""
    for s in ((station.get('skip') or {}).get('segments') or []):
        if s.get('type') in ED_TYPES and _overlap(float(s['start']), float(s['end']), dt['start'], dt['end']) >= 0.5:
            return True
    return False


def _length_outlier(dt, med):
    """ยาวต่างจากค่ากลางแทร็กเกิน LENGTH_OUTLIER_SEC ทั้งความยาวหลังขยับตามจุดตัดภาพและความยาวจากเสียงก่อนขยับ
    (ภาพยืนยันขอบแยกจากเสียง: เพลงขึ้นก่อนภาพ ~10 วิ ทำให้ช่วงสั้นลงได้โดยไม่ผิด — ผู้ใช้ยืนยัน SAO ตอน 18 ED 2026-11-02)"""
    visual = dt.get('visual') or {}
    audio = _song_len(dt) + visual.get('start', 0.0) - visual.get('end', 0.0)
    return abs(_song_len(dt) - med) > LENGTH_OUTLIER_SEC and abs(audio - med) > LENGTH_OUTLIER_SEC


def _median_length(track_report, kind):
    """ความยาวอ้างอิงของแทร็ก = กลุ่มความยาวที่มีสมาชิกมากที่สุด (ช่วง ±3 วิ) จากแถวที่เชื่อถือได้ (ok/fix/missing)
    ถ้าเท่ากันเลือกกลุ่มที่ใกล้ 90 วิ — กันทั้งกรณีเพลงผสมฉากลากค่ากลางลง และกรณีแถว review มาบิดค่าอ้างอิง"""
    lens = [_song_len(ep[kind]['detected'])
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
        m = re.match(r'^(.+?)\|(.+?)\|(op|ed|intro|credits)=([\d:.]+)-([\d:.]+)$', item.strip())
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
    r.add_argument('--start-shift', type=float, default=DEFAULT_START_SHIFT, help='ปรับจุดเริ่มของ OP/ED/intro (วินาที, default +0.5)')
    r.add_argument('--end-shift', type=float, default=DEFAULT_END_SHIFT, help='ปรับจุดจบของ OP/ED/intro (วินาที, default -0.5)')
    r.add_argument('--no-visual', dest='visual', action='store_false', help='ไม่ขยับขอบตามจุดตัดภาพ (ไม่ดึงภาพจากวิดีโอ)')
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
    a.add_argument('--kinds', nargs='*', choices=['op', 'ed', 'intro', 'credits'], help='จำกัดเฉพาะ op / ed / intro / credits')
    a.add_argument('--remove', nargs='*', help='ลบ segment "TRACK|LABEL|op"')
    a.add_argument('--mark-none', action='store_true', help='ตอนที่ตรวจแล้วไม่พบ op/ed/intro และยังไม่มี skip → เขียน skip ว่าง (segments: [])')
    a.add_argument('--source', default='manual', help='skip.source เมื่อ --fill / --mark-none สร้าง skip object ใหม่ (default manual; job อัตโนมัติใช้ audit)')
    a.add_argument('--json-out', help='เขียนผล apply แบบ JSON {playlist, changes[], marked[]}')
    args = p.parse_args()
    if args.cmd == 'report':
        cmd_report(args)
    else:
        cmd_apply(args)


if __name__ == '__main__':
    main()
