/**
 * Multi-season mapper — สำหรับเว็บที่รวมทุก season เป็นลิสต์ตอนเดียวยาวรวด
 * (เช่น animehdzero/422 = Reborn! 203 ตอนเรียง 1–203 ส่วน TMDB แบ่งเป็น 8 season)
 *
 * --season-map=33,32,8,...  ระบุจำนวนตอนของแต่ละ season เอง
 * --multi-season            อ่าน episode_count ของแต่ละ season จาก TMDB ให้อัตโนมัติ
 *                           ใช้ต่อเมื่อผลรวมตรงกับจำนวนตอนฝั่ง source เป๊ะเท่านั้น
 *
 * เลขตอนเริ่มนับ 1 ใหม่ทุก season เพราะยึด episode_number ของ TMDB season นั้นๆ
 */

const fs = require('fs');
const tmdb = require('./tmdb');
const io = require('./playlist-io');
const { matchesSeasonName } = require('./utils');

/** "33,32,8" → [33, 32, 8] (ข้ามค่าที่ไม่ใช่จำนวนเต็มบวก) */
function parseSeasonMap(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) {
        console.warn(`⚠️  --season-map: ข้าม "${s}" (ต้องเป็นจำนวนเต็มบวก)`);
        return null;
      }
      return n;
    })
    .filter((n) => n !== null);
}

/** season ที่นับจริง — ตัด Specials (S0) ออก */
function realSeasons(tmdbShow) {
  return (tmdbShow?.seasons || [])
    .filter((s) => (s.season_number ?? 0) > 0 && (s.episode_count ?? 0) > 0)
    .sort((a, b) => a.season_number - b.season_number);
}

/**
 * วางแผนแบ่ง source → season
 * คืน { ok, plan: [{ seasonNum, count }], expected, reason }
 * ok = false เมื่อผลรวมไม่ตรง — ผู้เรียกต้องไม่เดาต่อ
 */
function buildSeasonPlan({ sourceCount, tmdbShow, seasonMap = '' }) {
  const counts = parseSeasonMap(seasonMap);
  const seasons = realSeasons(tmdbShow);

  if (String(seasonMap || '').trim() && !counts.length) {
    return { ok: false, plan: [], expected: 0, reason: '--season-map ไม่มีค่าที่ใช้ได้เลย' };
  }

  let plan;
  if (counts.length) {
    // เกินจำนวน season จริงของ TMDB → ไล่เลขต่อจากตัวสุดท้าย ไม่ใช่ i+1
    // (i+1 ชนกับ season ที่มีอยู่ได้เมื่อเลข season ไม่ต่อเนื่อง เช่น [1,3])
    let last = 0;
    plan = counts.map((count, i) => {
      const seasonNum = seasons[i]?.season_number ?? last + 1;
      last = seasonNum;
      return { seasonNum, count };
    });
  } else {
    if (!seasons.length) {
      return { ok: false, plan: [], expected: 0, reason: 'TMDB ไม่มีข้อมูล season' };
    }
    plan = seasons.map((s) => ({ seasonNum: s.season_number, count: s.episode_count }));
  }

  const nums = plan.map((p) => p.seasonNum);
  if (new Set(nums).size !== nums.length) {
    return { ok: false, plan, expected: 0, reason: `เลข season ซ้ำกัน (${nums.join(', ')})` };
  }

  const expected = plan.reduce((sum, p) => sum + p.count, 0);
  if (expected !== sourceCount) {
    return {
      ok: false,
      plan,
      expected,
      reason: `ผลรวม ${expected} ตอน ไม่ตรงกับ source ${sourceCount} ตอน`,
    };
  }
  return { ok: true, plan, expected, reason: '' };
}

/** ขยายแผนเป็น mapping ต่อ index ของ source → { seasonNum, epNum } */
function expandSeasonPlan(plan) {
  const out = [];
  for (const { seasonNum, count } of plan) {
    for (let e = 1; e <= count; e++) out.push({ seasonNum, epNum: e });
  }
  return out;
}

/** สรุปแผนให้ดูก่อนใช้จริง */
function describeSeasonPlan(plan) {
  let cursor = 1;
  return plan.map(({ seasonNum, count }) => {
    const from = cursor;
    const to = cursor + count - 1;
    cursor = to + 1;
    return `   source ${String(from).padStart(4)}–${String(to).padEnd(4)} → Season ${seasonNum} (E1–${count})`;
  }).join('\n');
}

/**
 * เตรียมแผนแบ่ง season + ดึง metadata ของแต่ละ season
 * คืน null เมื่อไม่ได้เปิดใช้งาน / โยน Error เมื่อเปิดใช้แล้วไปต่อไม่ได้
 * (ห้าม fallback ไปโหมด season เดียวเด็ดขาด เพราะจะยัดทุกตอนลง Season 1)
 */
async function prepareMultiSeason({
  sourceCount, tmdbShow, tmdbKey, isDubbedTrack, posterUrl,
  multiSeason, seasonMap, isMovie, ignoredFlags = {},
}) {
  if (!(multiSeason || seasonMap)) return null;
  if (isMovie) throw new Error('multi-season ใช้กับ movie ไม่ได้ — โหมดนี้สำหรับ series เท่านั้น');
  if (!tmdbShow) {
    throw new Error('multi-season ต้องมีข้อมูล TMDB — ระบุ --tmdb-id หรือตรวจว่า search เจอ');
  }

  const res = buildSeasonPlan({ sourceCount, tmdbShow, seasonMap });
  if (!res.ok) {
    const detail = res.plan.length ? `\n${describeSeasonPlan(res.plan)}` : '';
    throw new Error(
      `multi-season: ${res.reason}${detail}\n   ระบุ --season-map=A,B,C ให้ผลรวมตรงกับจำนวนตอน แล้วรันใหม่`,
    );
  }

  console.log(`\n🗂️  multi-season: แบ่ง ${sourceCount} ตอน ลง ${res.plan.length} season`);
  console.log(describeSeasonPlan(res.plan));

  const data = new Map();
  for (const { seasonNum, count } of res.plan) {
    const bi = await tmdb.getTmdbSeasonBilingual(tmdbShow.id, tmdbKey, seasonNum);
    const episodes = isDubbedTrack ? bi.thEpisodes : bi.enEpisodes;
    if (episodes.length !== count) {
      console.warn(`⚠️  Season ${seasonNum}: TMDB คืน ${episodes.length} ตอน (คาด ${count}) — metadata อาจไม่ครบ`);
    }
    data.set(seasonNum, {
      episodes,
      poster: bi.poster || posterUrl,
      seasonName: bi.seasonName,
      airDate: bi.air_date || '',
    });
  }

  const ignored = Object.entries(ignoredFlags).filter(([, on]) => on).map(([k]) => k);
  if (ignored.length) console.warn(`⚠️  multi-season: ไม่ใช้ ${ignored.join(', ')}`);

  return { plan: res.plan, assign: expandSeasonPlan(res.plan), data };
}

/** metadata ของตอนที่ index นี้ ตาม season ที่ถูก assign ไว้ */
function episodeAt(ms, i) {
  const a = ms.assign[i];
  const sd = ms.data.get(a.seasonNum);
  const tmdbEp = sd?.episodes.find((e) => e.episode_number === a.epNum) || sd?.episodes[a.epNum - 1];
  return { label: String(a.epNum), tmdbEp };
}

/**
 * เขียน playlist ทีละ season — ต้อง write ระหว่างลูปเพราะ buildOrMergePlaylist
 * อ่านไฟล์จากดิสก์ทุกครั้ง รอบถัดไปจึงจะ merge ทับของเดิมได้ถูกต้อง
 */
function writeMultiSeason({ ms, outputPath, seriesTitle, posterUrl, stations, trackName, trackReferer }) {
  // บาง script `continue` ข้ามตอนที่ยังไม่มีสตรีม ทำให้ stations สั้นกว่าแผน
  // ถ้าปล่อยไป slice จะเลื่อนยกแถวตั้งแต่จุดที่ข้าม → ตอนไปอยู่ผิด season เงียบๆ
  const planned = ms.plan.reduce((sum, p) => sum + p.count, 0);
  if (stations.length !== planned) {
    throw new Error(
      `multi-season: ได้ station ${stations.length} ตัว แต่แผนต้องการ ${planned} ตอน ` +
      '— มีตอนถูกข้ามระหว่าง fetch จึงแบ่ง season ไม่ได้อย่างปลอดภัย',
    );
  }

  let playlist = null;
  let cursor = 0;
  for (const { seasonNum, count } of ms.plan) {
    const slice = stations.slice(cursor, cursor + count);
    cursor += count;
    const sd = ms.data.get(seasonNum);
    const sName = `Season ${seasonNum}`;
    playlist = io.buildOrMergePlaylist({
      outputPath, seriesTitle, posterUrl,
      seasonPosterUrl: sd?.poster || posterUrl,
      stations: slice, trackName, trackReferer,
      tmdbSeasonName: sd?.seasonName || null,
      seasonName: sName, seasonNum, epOffset: 0, splitEps: '',
    });
    io.markSeasonTrackComplete({
      playlist, seasonName: sName, trackName, tmdbEpCount: sd?.episodes.length || 0,
    });
    const rewritten = (playlist.groups || []).find((x) => matchesSeasonName(x.name, sName));
    // เลขตอนถูกจัดใหม่ทั้ง season → จุดแบ่งเดิมชี้ผิดตอนแล้ว ถ้าเก็บไว้ CMS จะ prefill กลับมาใช้ซ้ำ
    if (rewritten) delete rewritten.split_eps;
    if (sd?.airDate) {
      const g = (playlist.groups || []).find((x) => matchesSeasonName(x.name, sName));
      if (g) g.release_date = sd.airDate;
    }
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
    console.log(`  📁 ${sName}: ${slice.length} ตอน`);
  }
  return playlist;
}

module.exports = {
  parseSeasonMap, realSeasons, buildSeasonPlan, expandSeasonPlan, describeSeasonPlan,
  prepareMultiSeason, episodeAt, writeMultiSeason,
};
