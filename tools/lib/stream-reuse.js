/**
 * โหมด --only-new — ใช้ stream URL เดิมจากไฟล์ playlist ของตอนที่มีอยู่แล้ว ดึง stream ใหม่เฉพาะตอนใหม่
 *
 * ขั้นที่ช้าคือ resolve stream ทีละตอน (1-3 request/ตอน) — รายชื่อตอนและข้อมูล TMDB ยังดึงตามปกติ
 * จับคู่ตอนด้วย season + track + label ตอน ("11", "11 (1/2)", "OVA") เท่านั้น
 * เพราะ station ไม่ได้เก็บ URL หน้าตอนของเว็บต้นทางไว้
 *
 * ไม่ใช้ลิงก์เดิมเลย (ดึงใหม่ทุกตอน) เมื่อ:
 *   - track เดิมมาจากแหล่งอื่น (referer ของ track ไม่มี URL ที่ดึงรอบนี้) — url/referer/resolver เป็นของอีกเว็บ
 *   - โหมด append (epOffset > 0 และมี track อยู่แล้ว) — ไฟล์ที่สร้างก่อน offsetEpisodeLabel ตั้งชื่อตอนต่อภาคโดยไม่รวม offset
 *     label จึงอาจชนกับตอนของภาคก่อน และใน CMS รอบแรกของ chain เขียน track ใหม่ทั้งหมดอยู่แล้ว ไม่มีตอนเดิมให้ใช้ซ้ำ
 */

const { matchesSeasonName } = require('./utils');

/** label จากชื่อ station ที่สร้างด้วย buildStationName: "ตอน 11 (1/2) - ชื่อ" → "11(1/2)" */
function stationLabel(name) {
  const m = String(name || '').match(/^(?:ตอน|Ep\.)\s+(.+?)(?:\s+-\s+.*)?$/);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function normalizeLabel(label) {
  return String(label ?? '').replace(/\s+/g, '');
}

/** "a, b/" → ["a", "b"] (ตัด / ท้าย กันต่างกันแค่ slash) */
function splitUrls(value) {
  return String(value || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * - previous: playlist เดิม (io.loadPlaylist(outputPath)) — null = ไม่มีไฟล์ ทุกตอนถือเป็นตอนใหม่
 * - trackName: track ที่รอบนี้เขียน
 * - sourceUrl: ค่าเดียวกับ trackReferer ที่ส่งให้ buildOrMergePlaylist (URL หน้ารายการ คั่นด้วย , ได้)
 * - seasonName/seasonNum: season ที่รอบนี้เขียน (เลือก season แบบเดียวกับ buildOrMergePlaylist)
 * - epOffset: ค่าที่ส่งให้ buildOrMergePlaylist
 */
function createStreamReuse({ enabled, previous, trackName, sourceUrl, seasonName = null, seasonNum = null, epOffset = 0 }) {
  const tracks = new Map();
  const sources = splitUrls(sourceUrl);
  const otherSource = new Set();
  let reused = 0;
  let fresh = 0;

  /** ไม่ระบุ --season แล้วไม่เจอชื่อ → season แรก (เหมือน buildOrMergePlaylist) */
  const findSeason = (name, fallbackToFirst) => {
    const groups = previous?.groups || [];
    return groups.find((g) => matchesSeasonName(g.name, name || 'Season 1')) ?? (fallbackToFirst ? groups[0] : null);
  };

  /** label → station เฉพาะ label ที่ไม่ซ้ำใน track (ซ้ำ = ระบุตอนไม่ได้แน่นอน ไม่ใช้) */
  const trackIndex = (name, fallbackToFirst) => {
    const key = name || 'Season 1';
    if (tracks.has(key)) return tracks.get(key);
    const track = (findSeason(name, fallbackToFirst)?.groups || []).find((t) => t.name === trackName);
    const byLabel = new Map();
    const known = new Set(splitUrls(track?.referer));
    const sameSource = sources.length > 0 && sources.every((u) => known.has(u));
    if (track && !sameSource) otherSource.add(key);
    if (sameSource) {
      const counts = new Map();
      for (const st of track.stations || []) {
        const label = stationLabel(st.name);
        if (!label) continue;
        counts.set(label, (counts.get(label) || 0) + 1);
        byLabel.set(label, st);
      }
      for (const [label, n] of counts) if (n > 1) byLabel.delete(label);
    }
    const entry = { exists: !!track, byLabel };
    tracks.set(key, entry);
    return entry;
  };

  const appendMode = !!enabled && !!previous && epOffset > 0 && trackIndex(seasonName, !seasonNum).exists;
  const active = !!enabled && !!previous && !appendMode;

  return {
    active,

    /**
     * station เดิมของตอนนี้ หรือ null (ต้อง resolve ใหม่)
     * - notUrls: URL ที่ script ใส่แทน stream ตอน resolve ไม่สำเร็จ (หน้าตอน/embed/หน้ารวม) — เจอ = ต้องลองใหม่
     * - season: ชื่อ season ของตอนนี้ (โหมด multi-season) ไม่ระบุ = season ของรอบนี้
     */
    find(label, { notUrls = [], season = null } = {}) {
      if (!active) return null;
      const key = normalizeLabel(label);
      const index = season ? trackIndex(season, false) : trackIndex(seasonName, !seasonNum);
      const old = key ? index.byLabel.get(key) : null;
      if (!old?.url || notUrls.includes(old.url)) {
        fresh++;
        return null;
      }
      reused++;
      return old;
    },

    summary() {
      if (!enabled) return;
      if (!previous) console.log('\nℹ️  --only-new: ยังไม่มีไฟล์เดิม — ดึงทุกตอน');
      else if (appendMode) console.log('\nℹ️  --only-new: ใช้กับโหมดต่อภาค (--ep-offset) ไม่ได้ — ดึงทุกตอน');
      if (otherSource.size) {
        console.log(`\nℹ️  --only-new: track "${trackName}" (${[...otherSource].join(', ')}) มาจากแหล่งอื่น — ดึงใหม่ทุกตอน`);
      }
      if (active) console.log(`\n♻️  --only-new: ใช้ลิงก์เดิม ${reused} ตอน, ดึงใหม่ ${fresh} ตอน`);
    },
  };
}

module.exports = { createStreamReuse, stationLabel };
