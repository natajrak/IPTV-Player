// Shared --update-meta flow (movie + series)
// Unified: station.release_date from TMDB episode air_date,
//          season.updated_at = MAX(episodes[].air_date) → midnight UTC,
//          playlist.updated_at = rollup from season-level fields
const fs = require('fs');
const path = require('path');
const { asMidnightUtc, formatSeriesTitle, buildStationName, markTrackComplete, matchesSeasonName } = require('./utils');
const tmdb = require('./tmdb');
const io = require('./playlist-io');

const TMDB_IMG = 'https://image.tmdb.org/t/p/original';

/**
 * @param {object} ctx
 * @param {string} ctx.playlistDir
 * @param {string} ctx.indexPath
 * @param {string} ctx.githubRawBase
 * @param {boolean} ctx.isMovie
 * @param {string} ctx.tmdbKey
 * @param {string} ctx.customOutput
 * @param {string|null} ctx.seasonName
 * @param {string|null} ctx.filterTrack
 * @param {'all'|'poster'|'cover'|'title'} ctx.updateMetaMode
 * @param {number|null} ctx.forceTmdbId
 * @param {boolean} ctx.noTouch
 */
async function runUpdateMeta(ctx) {
  const {
    playlistDir, indexPath, githubRawBase, isMovie, tmdbKey,
    customOutput, seasonName, filterTrack, updateMetaMode = 'all',
    forceTmdbId, noTouch,
  } = ctx;

  if (!tmdbKey) { console.error('❌ ต้องมี TMDB_API_KEY ใน .env'); process.exit(1); }
  if (!customOutput) { console.error('❌ ต้องระบุ --output=FILENAME.txt'); process.exit(1); }

  const outputFile = customOutput.endsWith('.txt') ? customOutput : `${customOutput}.txt`;
  const resolvedOutput = io.resolvePlaylistFile({ playlistDir, fname: outputFile });
  if (resolvedOutput !== outputFile) console.log(`📂 พบไฟล์: ${resolvedOutput}`);
  const outputPath = path.resolve(playlistDir, resolvedOutput);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === 'all' || updateMetaMode === 'poster';
  const doCover  = updateMetaMode === 'all' || updateMetaMode === 'cover';
  const doTitle  = updateMetaMode === 'all' || updateMetaMode === 'title';
  console.log(`\n🔧 mode: ${updateMetaMode} (poster=${doPoster} cover=${doCover} title=${doTitle})`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  const rawTitle = playlist.name || '';
  const isLegacyMovie = Array.isArray(playlist.stations);
  const isMovieMainFile = !isLegacyMovie && Array.isArray(playlist.groups)
                       && playlist.groups.length > 0 && playlist.groups[0]?.url
                       && !playlist.groups[0]?.stations;
  const isMovieStructure = isMovie || isLegacyMovie || isMovieMainFile;

  // Resolve TMDB ID with priority:
  //   1. Explicit --tmdb-id from caller
  //   2. {tmdbId}-{slug}.txt filename prefix (series files, movie part files)
  //   3. First part's TMDB ID (movie main files with no prefix — use ภาค 1 as anchor)
  // This prevents the search-by-title fallback from picking the wrong TMDB entry
  // (e.g. "You and Me" → "Apocalypse Slough", or "Harry Potter" main → wrong movie).
  let effectiveTmdbId = forceTmdbId;
  if (!effectiveTmdbId) {
    const m = resolvedOutput.match(/^(\d+)-/);
    if (m) {
      effectiveTmdbId = parseInt(m[1], 10) || null;
      if (effectiveTmdbId) console.log(`📎 ใช้ TMDB ID จากชื่อไฟล์: ${effectiveTmdbId}`);
    }
  }
  if (!effectiveTmdbId && isMovieMainFile) {
    const firstPartFile = playlist.groups?.[0]?.url?.split('/').pop() || '';
    const m = firstPartFile.match(/^(\d+)-/);
    if (m) {
      effectiveTmdbId = parseInt(m[1], 10) || null;
      if (effectiveTmdbId) console.log(`📎 ใช้ TMDB ID จาก part แรก: ${effectiveTmdbId} (${firstPartFile})`);
    }
  }

  let tmdbResult;

  // ── Movie update-meta ─────────────────────────────────────────────
  if (isMovieStructure) {
    if (effectiveTmdbId) {
      console.log(`\n🎬 ใช้ TMDB ID: ${effectiveTmdbId}`);
      tmdbResult = await tmdb.getTmdbMovieDetail(effectiveTmdbId, tmdbKey, 'en-US');
      if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${effectiveTmdbId}`); process.exit(1); }
    } else {
      console.log(`\n🎬 กำลัง search TMDB (movie) สำหรับ: "${rawTitle}"`);
      tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
      if (!tmdbResult) { console.error('❌ ไม่พบใน TMDB'); process.exit(1); }
    }
    const tmdbPoster = `${TMDB_IMG}${tmdbResult.poster_path}`;
    const tmdbEnName = tmdbResult.title || rawTitle;
    const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
    const tmdbName = formatSeriesTitle(tmdbEnName, tmdbThName);
    console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

    if (isMovieMainFile) {
      if (doPoster) {
        if (!playlist._name_locked) playlist.name = tmdbName;
        playlist.image = tmdbPoster;
      }
      // Cascade: for each part → fetch its TMDB → stamp dates on part file → mirror onto main's group entry
      // (group.release_date / .updated_at always sync regardless of mode; stampPlaylist below will rollup)
      for (const group of (playlist.groups || [])) {
        if (!group.url) continue;
        const partFile = group.url.split('/').pop();
        const m = partFile.match(/^(\d+)-/);
        if (!m) continue;
        const partTmdbId = m[1];
        const partPath = path.resolve(playlistDir, partFile);
        if (!fs.existsSync(partPath)) continue;
        try {
          const partData = JSON.parse(fs.readFileSync(partPath, 'utf-8'));
          const partTmdb = await tmdb.getTmdbMovieDetail(partTmdbId, tmdbKey, 'en-US');
          if (!partTmdb) { console.warn(`  ⚠️  TMDB ${partTmdbId} ไม่พบ — ข้าม ${partFile}`); continue; }
          const partTmdbEn = partTmdb.title || '';
          const partTmdbTh = await tmdb.getTmdbMovieNameTh(partTmdbId, tmdbKey);
          const partTmdbName = formatSeriesTitle(partTmdbEn, partTmdbTh);
          const partTmdbPoster = partTmdb.poster_path ? `${TMDB_IMG}${partTmdb.poster_path}` : '';
          if (doPoster) {
            if (partTmdbName)   group.name  = partTmdbName;
            if (partTmdbPoster) group.image = partTmdbPoster;
          }
          io.stampPlaylist(partData, partTmdb, true);
          fs.writeFileSync(partPath, JSON.stringify(partData, null, 4), 'utf-8');
          if (partData.release_date) group.release_date = partData.release_date; else delete group.release_date;
          if (partData.updated_at)   group.updated_at   = partData.updated_at;   else delete group.updated_at;
          console.log(`  ✅ part: ${partFile} → "${partTmdbName}" (${partData.release_date || '-'})`);
        } catch (e) {
          console.warn(`  ⚠️  ${partFile}: ${e.message}`);
        }
      }
    } else if (isLegacyMovie) {
      if (doPoster) {
        playlist.image = tmdbPoster;
        (playlist.stations || []).forEach((s) => { s.image = tmdbPoster; });
      }
    } else {
      // Modern part file: groups[0].stations
      if (doPoster) {
        playlist.image = tmdbPoster;
        (playlist.groups || []).forEach((g) => {
          if (g.image !== undefined) g.image = tmdbPoster;
          if (Array.isArray(g.stations)) g.stations.forEach((s) => { s.image = tmdbPoster; });
        });
      }
    }

    // Detect if this is a part file by scanning for a main file referencing its URL
    const partMainFile = io.findMainFileFor({ partFilename: resolvedOutput, playlistDir, githubRawBase });
    const isPartFile = !!partMainFile;
    const mainPath = partMainFile ? path.resolve(playlistDir, partMainFile) : null;

    let mainStamped = null;
    if (isPartFile) {
      try {
        const main = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
        const partRawUrl = `${githubRawBase}${resolvedOutput}`;
        const grp = (main.groups || []).find((g) => g.url === partRawUrl);
        if (grp) {
          if (doPoster) { grp.name = tmdbName; grp.image = tmdbPoster; }
          io.stampPlaylist(main, tmdbResult, true);
          fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), 'utf-8');
          mainStamped = main;
          console.log(`✅ อัปเดต main file group: ${partMainFile}`);
        }
      } catch {}
    }

    io.stampPlaylist(playlist, tmdbResult, true);
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
    console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);

    if (isPartFile && mainStamped) {
      io.updateIndex({
        indexPath, githubRawBase,
        seriesTitle: mainStamped.name || tmdbName,
        posterUrl: mainStamped.image || tmdbPoster,
        filename: partMainFile,
        releaseDate: mainStamped.release_date || '',
        updatedAt: mainStamped.updated_at,
        seasonCount: null, completion: null,
        partCount: mainStamped.part_count ?? null,
      });
    } else if (!isPartFile) {
      io.updateIndex({
        indexPath, githubRawBase,
        seriesTitle: playlist.name || tmdbName,
        posterUrl: tmdbPoster,
        filename: resolvedOutput,
        upsert: true,
        releaseDate: playlist.release_date || '',
        updatedAt: playlist.updated_at,
        seasonCount: null, completion: null,
        partCount: playlist.part_count ?? null,
      });
    }
    console.log('🎉 เสร็จสิ้น!');
    return;
  }

  // ── Series update-meta ────────────────────────────────────────────
  if (effectiveTmdbId) {
    console.log(`\n🎬 ใช้ TMDB ID: ${effectiveTmdbId}`);
    tmdbResult = await tmdb.getTmdbShow(effectiveTmdbId, tmdbKey, 'en-US');
    if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${effectiveTmdbId}`); process.exit(1); }
  } else {
    console.log(`\n🎬 กำลัง search TMDB สำหรับ: "${rawTitle}"`);
    tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
    if (!tmdbResult) { console.error('❌ ไม่พบใน TMDB'); process.exit(1); }
  }

  const tmdbPoster = `${TMDB_IMG}${tmdbResult.poster_path}`;
  const tmdbEnName = tmdbResult.name || rawTitle;
  const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
  const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
  console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

  const allSeasons = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => matchesSeasonName(s.name, seasonName))
    : allSeasons;

  if (seasonName && seasonsToUpdate.length === 0) {
    console.error(`❌ ไม่พบ "${seasonName}" ในไฟล์`);
    process.exit(1);
  }

  console.log(`\n📂 จะอัปเดต: ${seasonsToUpdate.map((s) => s.name).join(', ')}${filterTrack ? ` › ${filterTrack}` : ' (ทุก track)'}`);

  if (doPoster && !seasonName) {
    if (!playlist._name_locked) playlist.name = tmdbName;
    playlist.image = tmdbPoster;
  }

  for (const season of seasonsToUpdate) {
    const sNum = /specials/i.test(season.name) ? 0 : (parseInt(season.name?.match(/\d+/)?.[0]) || 1);

    let enEps = [];
    let thEps = [];
    let seasonPoster = tmdbPoster;
    if (doPoster || doCover || doTitle) {
      const tmdbSeason = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
      enEps = tmdbSeason.enEpisodes;
      thEps = tmdbSeason.thEpisodes;
      if (tmdbSeason.poster) seasonPoster = tmdbSeason.poster;
      if (tmdbSeason.seasonName) season.season_name = tmdbSeason.seasonName;
      else delete season.season_name;
      if (tmdbSeason.air_date) season.release_date = tmdbSeason.air_date;
      // (season.updated_at is computed later by stampPlaylist as MAX of station.release_date
      //  values actually present in the playlist — not TMDB's full episode list which
      //  may include unreleased future episodes.)
      console.log(`\n✅ Season ${sNum}: ${enEps.length} ตอน | poster: ${seasonPoster !== tmdbPoster ? 'season-specific' : 'show-level'}`);
    }

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (filterTrack && track.name !== filterTrack) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed = track.name === 'พากย์ไทย' || !track.name;
      const tmdbEps = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        // จับทั้งเลขตอนและ part suffix ของตอนพิเศษที่ถูกแบ่ง เช่น "ตอน 11 (1/2) - ..."
        // เพื่อให้ rewrite ชื่อแล้ว label "(1/2)" ไม่หาย (map TMDB ด้วยเลข 11 เหมือนเดิม)
        const nameMatch = station.name.match(/(?:ตอน|Ep\.?)\s*([\d.]+(?:\s*\(\d+\/\d+\))?)/i);
        const stationEpNum = nameMatch ? parseInt(nameMatch[1]) : (i + 1);
        const stationLabel = nameMatch ? nameMatch[1] : String(i + 1);
        const tmdbEp = !isNaN(stationEpNum)
          ? (tmdbEps.find((e) => e.episode_number === stationEpNum) || tmdbEps[i])
          : tmdbEps[i];
        if (doTitle && tmdbEp?.name) {
          station.name = buildStationName(stationLabel, tmdbEp.name, dubbed);
        }
        if (doCover && tmdbEp?.still_path) {
          station.image = `${TMDB_IMG}${tmdbEp.still_path}`;
        }
        // Always sync station.release_date from TMDB ep air_date (when available)
        if (tmdbEp?.air_date) station.release_date = tmdbEp.air_date;
      });

      // Mark track.status = 'completed' when this track has all TMDB episodes for its language
      // (พากย์ไทย vs thEps; ซับไทย vs enEps)
      markTrackComplete(track, tmdbEps.length);

      const updated = [doPoster && 'poster', doTitle && 'title', doCover && 'cover'].filter(Boolean).join('+');
      console.log(`  ✅ [${updated}] "${track.name || 'stations'}" (${track.stations.length} ตอน${track.status === 'completed' ? ' ✓ จบแล้ว' : ''})`);
    }
  }

  io.stampPlaylist(playlist, tmdbResult, false);
  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
  console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);

  io.updateIndex({
    indexPath, githubRawBase,
    seriesTitle: playlist.name || tmdbName,
    posterUrl: tmdbPoster,
    filename: resolvedOutput,
    upsert: true,
    releaseDate: playlist.release_date || '',
    updatedAt: playlist.updated_at,
    seasonCount: playlist.season_count ?? null,
    completion: playlist.completion ?? null,
  });
  console.log('🎉 เสร็จสิ้น!');
}

module.exports = { runUpdateMeta };
