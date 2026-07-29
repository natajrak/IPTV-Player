// Playlist file I/O + builders + index management
const fs = require('fs');
const path = require('path');
const { asMidnightUtc, markTrackComplete, isSpecialSeasonName, matchesSeasonName } = require('./utils');

function loadPlaylist(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function savePlaylist(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
}

// Unified release_date + updated_at stamp logic.
// For series (seasons → tracks → stations): roll up per-season from stations actually in
// the playlist (NOT from TMDB's full episode list, which includes unreleased future episodes).
// For movie main files (groups have .url): roll up from each group's release_date/updated_at.
// For movie part files (stations[] at root or under groups[0]): derive from tmdbResult.
function stampPlaylist(playlist, tmdbResult, isMovie) {
  const hasGroups = Array.isArray(playlist.groups) && playlist.groups.length > 0;

  // Step 1: per-season rollup (series only — groups w/ nested tracks/stations)
  if (!isMovie && hasGroups) {
    for (const season of playlist.groups) {
      if (!season) continue;
      const hasNestedStructure = Array.isArray(season.groups) || Array.isArray(season.stations);
      if (!hasNestedStructure) continue;
      const tracks = (Array.isArray(season.groups) && season.groups.length > 0)
        ? season.groups
        : [season];
      const stationDates = tracks
        .flatMap((t) => (t && Array.isArray(t.stations) ? t.stations : []))
        .map((s) => s && s.release_date)
        .filter(Boolean);
      if (stationDates.length > 0) {
        season.updated_at = asMidnightUtc(stationDates.slice().sort().pop());
      } else if (season.release_date) {
        season.updated_at = asMidnightUtc(season.release_date);
      }
    }
  }

  // Step 2: playlist-level release_date rollup from groups[].release_date
  if (hasGroups) {
    const childDates = playlist.groups.map((g) => g && g.release_date).filter(Boolean);
    if (childDates.length > 0) {
      playlist.release_date = childDates.slice().sort()[0];
    } else if (tmdbResult) {
      const rd = isMovie ? tmdbResult.release_date : tmdbResult.first_air_date;
      if (rd) playlist.release_date = rd;
    }
  } else if (tmdbResult) {
    const rd = isMovie ? tmdbResult.release_date : tmdbResult.first_air_date;
    if (rd) playlist.release_date = rd;
  }

  // Step 3: playlist-level updated_at rollup from groups[].updated_at
  if (hasGroups) {
    const upd = playlist.groups.map((g) => g && g.updated_at).filter(Boolean).slice().sort();
    if (upd.length > 0) playlist.updated_at = upd[upd.length - 1];
    else if (playlist.release_date) playlist.updated_at = asMidnightUtc(playlist.release_date);
  } else if (playlist.release_date) {
    playlist.updated_at = asMidnightUtc(playlist.release_date);
  }

  // Stamp count/completion meta for the Player + index badges.
  // Series: season_count + completion. Movie main files (groups with .url to parts): part_count.
  // Movie part files / legacy flat: nothing (neither field applies).
  if (!isMovie) {
    const meta = deriveCompletionMeta(playlist);
    if (meta.season_count != null) playlist.season_count = meta.season_count;
    else delete playlist.season_count;
    if (meta.completion) playlist.completion = meta.completion;
    else delete playlist.completion;
    delete playlist.part_count;
  } else {
    const isMovieMain = Array.isArray(playlist.groups) && playlist.groups.length > 0
                     && playlist.groups[0]?.url && !playlist.groups[0]?.stations;
    if (isMovieMain) playlist.part_count = playlist.groups.length;
    else delete playlist.part_count;
    delete playlist.season_count;
    delete playlist.completion;
  }
  return playlist;
}

// Build/merge series playlist (3-level: seasons → tracks → episodes)
// All non-shared inputs passed explicitly so callers control state.
function buildOrMergePlaylist({
  outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
  trackName, trackReferer = null, tmdbSeasonName = null,
  seasonName, seasonNum, epOffset = 0, splitEps = '',
}) {
  // เก็บ split config ลง season เพื่อให้ CMS prefill ตอน update รอบถัดไป
  // (ไม่ลบค่าเดิมเมื่อรันโดยไม่ใส่ flag — กันเผลอทำ hint หาย)
  const stampSplitEps = (season) => {
    if (splitEps) season.split_eps = String(splitEps);
  };
  const newTrack = {
    name: trackName,
    image: seasonPosterUrl,
    ...(trackReferer && { referer: trackReferer }),
    stations,
  };

  if (fs.existsSync(outputPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); }
    catch { console.warn('⚠️  ไฟล์เดิม parse ไม่ได้ สร้างใหม่แทน'); existing = null; }

    if (existing) {
      const targetName = seasonName || 'Season 1';
      let season = existing.groups?.find((g) => matchesSeasonName(g.name, targetName))
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = {
          name: targetName,
          ...(tmdbSeasonName && { season_name: tmdbSeasonName }),
          image: seasonPosterUrl,
          groups: [],
        };
        existing.groups.push(season);
      }

      if (tmdbSeasonName) season.season_name = tmdbSeasonName;

      if (season.stations && !season.groups) {
        const otherTrackName = trackName === 'พากย์ไทย' ? 'ซับไทย' : 'พากย์ไทย';
        season.groups = [{ name: otherTrackName, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];
      const existingTrack = season.groups.find((g) => g.name === trackName);
      if (epOffset > 0 && existingTrack && Array.isArray(existingTrack.stations)) {
        const merged = [...existingTrack.stations, ...stations];
        merged.sort((a, b) => {
          const aNum = parseInt(a.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          const bNum = parseInt(b.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          return aNum - bNum;
        });
        existingTrack.stations = merged;
        existingTrack.image = seasonPosterUrl;
        if (trackReferer && existingTrack.referer) {
          const oldRefs = existingTrack.referer.split(',').map((s) => s.trim());
          if (!oldRefs.includes(trackReferer)) {
            existingTrack.referer = oldRefs.concat(trackReferer).join(',');
          }
        } else if (trackReferer) {
          existingTrack.referer = trackReferer;
        }
        console.log(`\n🔀 Append ${stations.length} ตอนเข้า "${trackName}" (รวม ${merged.length} ตอน)`);
      } else {
        season.groups = season.groups.filter((g) => g.name !== trackName);
        season.groups.push(newTrack);
      }

      season.groups.sort((a, b) => {
        if (a.name === 'พากย์ไทย') return -1;
        if (b.name === 'พากย์ไทย') return 1;
        return 0;
      });
      stampSplitEps(season);
      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  const newSeasonName = seasonName || 'Season 1';
  const newSeason = {
    name: newSeasonName,
    ...(tmdbSeasonName && { season_name: tmdbSeasonName }),
    image: seasonPosterUrl,
    groups: [newTrack],
  };
  stampSplitEps(newSeason);
  return {
    name: seriesTitle,
    image: posterUrl,
    groups: [newSeason],
  };
}

// Build/update movie part file ({tmdbId}-{slug}.txt)
function buildPartFile({ outputPath, season, posterUrl, trackName, streamUrl, sourceUrl = null, resolver = null }) {
  const partName = `ภาค ${season}`;
  const newStation = {
    name: trackName,
    image: posterUrl,
    url: streamUrl,
    // เว็บที่ stream URL หมดอายุ (signed) เก็บ player page URL + resolver flag
    // ให้ Player ไป resolve เอาสตรีมสดตอนกดเล่น เหมือนฝั่ง series
    ...(resolver && { resolver }),
    ...(sourceUrl && { referer: sourceUrl }),
  };

  let playlist;
  if (fs.existsSync(outputPath)) {
    try { playlist = JSON.parse(fs.readFileSync(outputPath, 'utf-8')); }
    catch { playlist = null; }
  }

  if (!playlist) {
    return { name: partName, image: posterUrl, stations: [newStation] };
  }

  playlist.name = partName;
  playlist.image = posterUrl;
  playlist.stations = (playlist.stations || []).filter((s) => s.name !== trackName);
  playlist.stations.push(newStation);
  playlist.stations.sort((a, b) => {
    if (a.name === 'พากย์ไทย') return -1;
    if (b.name === 'พากย์ไทย') return 1;
    return 0;
  });
  console.log(`\n🔀 Merge "${trackName}" เข้า ${partName}`);
  return playlist;
}

// Upsert group entry in movie main file ({slug}.txt).
// After upsert, self-heal: refresh release_date/updated_at on every part-group by
// reading each referenced part file from disk — so the main's stampPlaylist rollup
// has fresh dates to work with (even for parts not touched in this run).
function upsertMainFile({ mainPath, franchiseName, franchisePoster, partTitle, partPoster, partFileRawUrl, season }) {
  const badgeName = `ภาค ${season}`;
  let main;
  if (fs.existsSync(mainPath)) {
    try { main = JSON.parse(fs.readFileSync(mainPath, 'utf-8')); }
    catch { main = null; }
  }
  if (!main) main = { name: franchiseName, image: franchisePoster, groups: [] };
  main.groups = main.groups || [];
  const existing = main.groups.find((g) => g.url === partFileRawUrl);
  if (existing) {
    existing.name = partTitle;
    existing.image = partPoster;
    existing.badge = badgeName;
    console.log(`\n🔀 อัปเดต group "${badgeName}" ใน main file`);
  } else {
    main.groups.push({ name: partTitle, image: partPoster, url: partFileRawUrl, badge: badgeName });
    console.log(`\n➕ เพิ่ม group "${badgeName}" เข้า main file`);
  }
  main.groups.sort((a, b) => {
    const na = parseInt(a.badge?.match(/\d+/)?.[0]) || 0;
    const nb = parseInt(b.badge?.match(/\d+/)?.[0]) || 0;
    return na - nb;
  });

  const baseDir = path.dirname(mainPath);
  for (const g of main.groups) {
    if (!g || !g.url) continue;
    const pFile = g.url.split('/').pop();
    if (!pFile || !pFile.endsWith('.txt')) continue;
    const pPath = path.resolve(baseDir, pFile);
    if (!fs.existsSync(pPath)) continue;
    try {
      const pData = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
      if (pData.release_date) g.release_date = pData.release_date; else delete g.release_date;
      if (pData.updated_at)   g.updated_at   = pData.updated_at;   else delete g.updated_at;
    } catch {}
  }

  return main;
}

// Upsert/update entry in {tab}/index.txt
// seasonCount + completion are stamped for series; partCount is stamped for movie main files.
// Pass null for fields that don't apply to clear them from the entry.
function updateIndex({
  indexPath, githubRawBase, seriesTitle, posterUrl, filename,
  upsert = false, releaseDate = '', updatedAt = '',
  seasonCount = null, completion = null, partCount = null,
}) {
  if (!fs.existsSync(indexPath)) {
    console.warn('⚠️  ไม่พบ index.txt ข้าม...');
    return;
  }
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); }
  catch { console.warn('⚠️  index.txt parse ไม่ได้ ข้าม...'); return; }

  const fileUrl = `${githubRawBase}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  const applyMeta = (entry) => {
    if (releaseDate) entry.release_date = releaseDate;
    if (updatedAt)   entry.updated_at  = updatedAt;
    if (typeof seasonCount === 'number') entry.season_count = seasonCount;
    else if (seasonCount === null && 'season_count' in entry) delete entry.season_count;
    if (typeof partCount === 'number') entry.part_count = partCount;
    else if (partCount === null && 'part_count' in entry) delete entry.part_count;
    if (completion) entry.completion = completion;
    else if (completion === null && 'completion' in entry) delete entry.completion;
  };

  if (existing) {
    if (!upsert && !updatedAt && !releaseDate && seasonCount == null && completion == null && partCount == null) {
      console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`);
      return;
    }
    existing.name = seriesTitle;
    existing.image = posterUrl;
    applyMeta(existing);
  } else {
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    const entry = { url: fileUrl, name: seriesTitle, image: posterUrl };
    applyMeta(entry);
    index.groups.push(entry);
  }

  index.groups.sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  const action = existing ? 'อัปเดต' : 'เพิ่ม';
  console.log(`✅ ${action} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

// For a part file ({tmdbId}-{slug}.txt), find the main file that references its URL
function findMainFileFor({ partFilename, playlistDir, githubRawBase }) {
  if (!/^\d+-/.test(partFilename)) return null;
  const partRawUrl = `${githubRawBase}${partFilename}`;
  let files;
  try { files = fs.readdirSync(playlistDir); } catch { return null; }
  for (const fname of files) {
    if (fname === 'index.txt' || !fname.endsWith('.txt')) continue;
    if (/^\d+-/.test(fname)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.resolve(playlistDir, fname), 'utf-8'));
      if (Array.isArray(data.groups) && data.groups.some((g) => g && g.url === partRawUrl)) return fname;
    } catch {}
  }
  return null;
}

// Derive { season_count, completion } from a series-shaped playlist for index.txt stamping.
// completion shape:
//   { status: 'completed' }                                — all season-tracks complete
//   { status: 'incomplete', season: N, track: 'th'|'sub'|null }
//     — highest incomplete season; track qualifier only if exactly one track in that season
//       is incomplete AND another track of the same season IS complete.
// Returns { season_count: null, completion: null } for non-series shapes (movies, etc).
function deriveCompletionMeta(playlist) {
  if (!playlist || !Array.isArray(playlist.groups) || playlist.groups.length === 0) {
    return { season_count: null, completion: null };
  }
  const seasons = playlist.groups.filter(
    (g) => g && (Array.isArray(g.groups) || Array.isArray(g.stations))
  );
  if (seasons.length === 0) return { season_count: null, completion: null };

  // season_count counts everything (Specials too); completion analysis ignores Specials/Season 0.
  const seasonCount = seasons.length;
  const completionSeasons = seasons.filter((g) => !isSpecialSeasonName(g.name));
  if (completionSeasons.length === 0) {
    // Only Specials in the playlist → no real season to track; report as completed.
    return { season_count: seasonCount, completion: { status: 'completed' } };
  }
  const seasonStates = completionSeasons.map((season, idx) => {
    const seasonNum = parseInt(String(season.name || '').match(/\d+/)?.[0]) || (idx + 1);
    const tracks = (Array.isArray(season.groups) && season.groups.length > 0)
      ? season.groups
      : [season];
    const trackList = tracks.filter((t) => t && Array.isArray(t.stations));
    const incomplete = trackList.filter((t) => t.status !== 'completed').map((t) => t.name);
    const complete = trackList.filter((t) => t.status === 'completed').map((t) => t.name);
    return { seasonNum, trackCount: trackList.length, incomplete, complete };
  });

  const incompleteSeasons = seasonStates.filter((s) => s.incomplete.length > 0);
  if (incompleteSeasons.length === 0) {
    return { season_count: seasonCount, completion: { status: 'completed' } };
  }

  const highest = incompleteSeasons.reduce((a, b) => (b.seasonNum > a.seasonNum ? b : a));
  let track = null;
  if (highest.trackCount >= 2 && highest.incomplete.length === 1 && highest.complete.length >= 1) {
    if (highest.incomplete[0] === 'พากย์ไทย') track = 'th';
    else if (highest.incomplete[0] === 'ซับไทย') track = 'sub';
  }
  return {
    season_count: seasonCount,
    completion: { status: 'incomplete', season: highest.seasonNum, track },
  };
}

// Find season+track in the playlist and set track.status = 'completed' iff
// stations.length >= tmdbEpCount. No-op if season/track not found or tmdbEpCount <= 0.
function markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount }) {
  if (!playlist || !tmdbEpCount || tmdbEpCount <= 0) return;
  const targetSeason = seasonName || 'Season 1';
  const season = (playlist.groups || []).find((g) => g && matchesSeasonName(g.name, targetSeason));
  if (!season) return;
  const tracks = Array.isArray(season.groups) && season.groups.length > 0 ? season.groups : [season];
  const track = tracks.find((t) => t && t.name === trackName);
  if (!track) return;
  markTrackComplete(track, tmdbEpCount);
}

function resolvePlaylistFile({ playlistDir, fname }) {
  if (fs.existsSync(path.resolve(playlistDir, fname))) return fname;
  const files = fs.readdirSync(playlistDir);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

module.exports = {
  loadPlaylist,
  savePlaylist,
  stampPlaylist,
  buildOrMergePlaylist,
  buildPartFile,
  upsertMainFile,
  updateIndex,
  findMainFileFor,
  resolvePlaylistFile,
  markSeasonTrackComplete,
  deriveCompletionMeta,
};
