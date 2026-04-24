/* ===== Config ===== */
const pathBeforeWeb = location.pathname.split("/web/")[0] || "";
const SITE_BASE_PATH = pathBeforeWeb === "/" ? "" : pathBeforeWeb;
const RAW_GITHUB_BASE = "https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/";
const IS_LOCAL_DEV = location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.hostname === "192.168.1.101";
const PLAYLIST_URL = IS_LOCAL_DEV
  ? `${SITE_BASE_PATH}/playlist/main.txt`
  : `${RAW_GITHUB_BASE}playlist/main.txt`;

const PAGE_SIZE = 20;
const PAGINATION_ICON_PREV = `<i class="fi fi-br-angle-small-left" aria-hidden="true"></i>`;
const PAGINATION_ICON_NEXT = `<i class="fi fi-br-angle-small-right" aria-hidden="true"></i>`;
const SECTION_BACK_ICON = `<i class="fi fi-br-arrow-left" aria-hidden="true"></i>`;
const PLAYER_ICON_PLAY = `<i class="fi fi-sr-play" aria-hidden="true"></i>`;
const PLAYER_ICON_PAUSE = `<i class="fi fi-sr-pause" aria-hidden="true"></i>`;
const EPISODES_ICON = `<i class="fi fi-rr-list" aria-hidden="true"></i>`;
const TV_FOCUSABLE_SELECTOR = [
  "button:not([disabled]):not(.hidden)",
  "#search-input:not([disabled])",
  ".card[tabindex='0']",
  ".ep-card[tabindex='0']",
  ".search-item[tabindex='0']",
  ".breadcrumb-item[tabindex='0']",
  ".logo[tabindex='0']",
].join(", ");
const TV_BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack"]);
const TV_BACK_KEYCODES = new Set([8, 27, 10009, 461]);

/* ===== State ===== */
let navHistory = [];
let currentStations = [];
let currentIndex = 0;
let hls = null;
let upnextCountdown = null;
let upnextCancelled = false;
let shuffleMode = false;
let shuffleHistory = [];   // track played indices to avoid repeats
let isAvMode = false;
let searchIndex = [];
let searchIndexPromise = null;
let searchIndexRootNode = null;
const searchIndexVisitedUrls = new Set();
const searchIndexEntryKeys = new Set();
let currentPage = 0;
let currentSortOrder = "az";
let avUnlocked = false;
let currentGroups = [];
let currentGroupTitle = "";
let currentGroupParent = null;
let inheritedRefererCache = null;
let crossSeasonQueue = [];
let crossSeasonIndex = -1;
let crossSeasonSeasons = [];
let epPanelSeasonFilter = "";
let currentSeasonTitle = "";
let playerSectionTitle = "";   // sectionTitle from renderStations (movie part name for movies)
let playerNoticeTimer = null;
let searchDownLastAt = 0;
let activeSearchIdx = -1;
let preSearchState = null;   // saved state before search
let searchReturnState = null;
let lastNode = null;
let lastTitle = "Home";
let lastFetchUrl = null;
let focusRefreshTimer = null;

/* ===== DOM refs ===== */
const loading    = document.getElementById("loading");
const errorView  = document.getElementById("error-view");
const errorMsg   = document.getElementById("error-message");
const gridView   = document.getElementById("grid-view");
const breadcrumb = document.getElementById("breadcrumb");
const logo       = document.querySelector(".logo");

const playerOverlay = document.getElementById("player-overlay");
const playerVideo   = document.getElementById("player-video");
const playerBack    = document.getElementById("player-back");
const playerTitle   = document.getElementById("player-title");
const playerNotice  = document.getElementById("player-notice");
const playerSeek    = document.getElementById("player-seek");
const playerTime    = document.getElementById("player-time");
const seekPreview     = document.getElementById("seek-preview");
const seekPreviewThumb = document.getElementById("seek-preview-thumb");
const seekPreviewTime  = document.getElementById("seek-preview-time");

const btnPrevEp    = document.getElementById("btn-prev-ep");
const btnRewind    = document.getElementById("btn-rewind");
const btnPlayPause = document.getElementById("btn-playpause");
const btnForward   = document.getElementById("btn-forward");
const btnNextEp    = document.getElementById("btn-next-ep");
const btnMute       = document.getElementById("btn-mute");
const volumeSlider  = document.getElementById("volume-slider");
const btnPip        = document.getElementById("btn-pip");
const btnAirPlay    = document.getElementById("btn-airplay");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnEpisodes   = document.getElementById("btn-episodes");
const btnShuffle    = document.getElementById("btn-shuffle");
const epPanel       = document.getElementById("ep-panel");
const epPanelTitle  = document.getElementById("ep-panel-title");
const epPanelTabs   = document.getElementById("ep-panel-tabs");
const epPanelGrid   = document.getElementById("ep-panel-grid");
const epPanelClose  = document.getElementById("ep-panel-close");

const upnextToast     = document.getElementById("upnext-toast");
const upnextThumb     = document.getElementById("upnext-thumb");
const upnextTitle     = document.getElementById("upnext-title");
const upnextCountEl   = document.getElementById("upnext-countdown");
const upnextBar       = document.getElementById("upnext-bar");
const upnextPlayBtn   = document.getElementById("upnext-play-now");
const upnextCancelBtn = document.getElementById("upnext-cancel");

const searchInput   = document.getElementById("search-input");
const searchClear   = document.getElementById("search-clear");
const searchResults = document.getElementById("search-results");

let avActiveGenre = null;
let avActiveActress = null;

/* ===== Init ===== */
logo.addEventListener("click", () => {
  navHistory = [];
  preSearchState = null;
  searchInput.value = "";
  searchClear.classList.add("hidden");
  closeSearch();
  fetchAndRender(PLAYLIST_URL, "Home");
});
logo.tabIndex = 0;
logo.setAttribute("role", "button");
logo.setAttribute("aria-label", "กลับหน้าแรก");
logo.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    logo.click();
  }
});

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) return;

  if (!playerOverlay.classList.contains("hidden")) {
    if (handlePlayerKeyboardShortcuts(e)) {
      e.preventDefault();
      return;
    }
  }

  if (isTVBackKey(e) && handleTVBack()) {
    e.preventDefault();
    return;
  }

  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    moveTVFocus(e.key);
    return;
  }

  if (e.key === "Enter") {
    const el = document.activeElement;
    if (isTVFocusable(el)) {
      e.preventDefault();
      el.click();
      return;
    }
  }

  if (e.key === " " && !playerOverlay.classList.contains("hidden") && document.activeElement === playerVideo) {
    e.preventDefault();
    togglePlayPause();
  }
});

document.addEventListener("click", (e) => {
  if (!document.getElementById("search-container").contains(e.target)) closeSearch();
});

fetchAndRender(PLAYLIST_URL, "Home");

/* ===== Fetch & Render ===== */
async function fetchAndRender(url, title, pushHistory = false, previousNode = null) {
  showLoading();
  try {
    const { data, sourceUrl } = await fetchJSON(url);
    const node = normalizePlaylistNode(data, sourceUrl);
    if (pushHistory && previousNode) {
      navHistory.push({ node: previousNode, title, page: currentPage, sort: currentSortOrder, url: null });
    }
    if (!searchIndexRootNode && title === "Home") {
      searchIndexRootNode = node;
      searchIndexPromise = buildSearchIndexRecursive(node, [{ node, title: "Home" }]).catch(() => {});
    }
    lastFetchUrl = url;
    renderNode(node, title);
  } catch (err) {
    showError(err.message || "โหลดข้อมูลไม่สำเร็จ");
  }
}

async function fetchJSON(url) {
  // Add cache-busting for local dev to always get fresh data
  const fetchUrl = IS_LOCAL_DEV ? url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now() : url;
  const res = await fetch(fetchUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { data, sourceUrl: res.url || url };
}

function normalizeUrlByBase(url, sourceUrl = null) {
  if (typeof url !== "string") return url;

  const normalizedUrl = url.trim();
  if (!normalizedUrl) return normalizedUrl;

  if (IS_LOCAL_DEV && normalizedUrl.startsWith(RAW_GITHUB_BASE)) {
    const repoPath = normalizedUrl.slice(RAW_GITHUB_BASE.length).replace(/^\/+/, "");
    return `${SITE_BASE_PATH}/${repoPath}`;
  }

  if (/^(?:https?:|data:|blob:|javascript:)/i.test(normalizedUrl)) {
    return normalizedUrl;
  }

  if (normalizedUrl.startsWith("/")) {
    return `${SITE_BASE_PATH}${normalizedUrl}`;
  }

  try {
    const base = sourceUrl || window.location.href;
    return new URL(normalizedUrl, base).toString();
  } catch (_) {
    return normalizedUrl;
  }
}

function normalizePlaylistNode(node, sourceUrl = null) {
  if (!node || typeof node !== "object") return node;

  const cloned = Array.isArray(node) ? [...node] : { ...node };

  if (!Array.isArray(cloned)) {
    if (typeof cloned.image === "string") cloned.image = normalizeUrlByBase(cloned.image, sourceUrl);
    if (typeof cloned.url === "string") cloned.url = normalizeUrlByBase(cloned.url, sourceUrl);
  }

  Object.keys(cloned).forEach((key) => {
    const value = cloned[key];
    if (!value) return;
    if (Array.isArray(value)) cloned[key] = value.map((item) => normalizePlaylistNode(item, sourceUrl));
    else if (typeof value === "object") cloned[key] = normalizePlaylistNode(value, sourceUrl);
  });

  return cloned;
}

/* ===== Search Index ===== */
function pushSearchIndexEntry(group, historyChain) {
  const name = group.name || group.info || "";
  if (!name) return;
  const key = `${name}::${group.url || ""}::${historyChain.map((h) => h.title).join(">")}`;
  if (searchIndexEntryKeys.has(key)) return;
  searchIndexEntryKeys.add(key);
  searchIndex.push({
    name,
    image: group.image || null,
    node: group,
    path: historyChain.map((h) => h.title),
    historyChain: [...historyChain],
  });
}

async function buildSearchIndexRecursive(node, historyChain, sourceUrl = null) {
  const groups = node?.groups || [];
  for (const group of groups) {
    pushSearchIndexEntry(group, historyChain);
    const nextTitle = group.name || group.info || "...";
    const nextHistory = [...historyChain, { node: group, title: nextTitle }];

    if (group.groups?.length) {
      await buildSearchIndexRecursive(group, nextHistory, sourceUrl);
      continue;
    }

    if (group.url && !group.stations) {
      const resolvedUrl = normalizeUrlByBase(group.url, sourceUrl);
      if (!resolvedUrl || searchIndexVisitedUrls.has(resolvedUrl)) continue;
      searchIndexVisitedUrls.add(resolvedUrl);
      try {
        const { data, sourceUrl: childSourceUrl } = await fetchJSON(resolvedUrl);
        const childNode = normalizePlaylistNode(data, childSourceUrl);
        // For search navigation, keep a renderable parent-node chain.
        // If this group is URL-based, store its loaded node in history instead of the lightweight link object.
        const loadedHistory = [...historyChain, { node: childNode, title: nextTitle }];
        await buildSearchIndexRecursive(childNode, loadedHistory, childSourceUrl);
      } catch (_) {
        // Skip broken child playlist URLs in search index.
      }
    }
  }
}

/* ===== Search UI ===== */
searchInput.addEventListener("input", async () => {
  const q = searchInput.value.trim();
  activeSearchIdx = -1;

  // Secret code to unlock AV category
  if (q === "000000" && !avUnlocked) {
    avUnlocked = true;
    searchInput.value = "";
    searchClear.classList.add("hidden");
    closeSearch();
    // Re-render current view to show AV
    if (lastNode) renderNode(lastNode, lastTitle);
    return;
  }

  // save state before first search action
  if (q && !preSearchState) {
    preSearchState = {
      node: lastNode,
      title: lastTitle,
      history: [...navHistory],
      page: currentPage,
      sort: currentSortOrder,
      query: q,
    };
  }

  // toggle clear button
  searchClear.classList.toggle("hidden", q.length === 0);

  if (!q) {
    closeSearch();
    // If on AV browsable page, reapply filters (without text search)
    if (lastNode?.browsable && browseAllStations.length) {
      applyAvFilters();
    }
    return;
  }

  // AV browsable page: use combined filter (search + genre + actress)
  if (lastNode?.browsable && browseAllStations.length) {
    closeSearch();
    applyAvFilters();
    return;
  }

  // Normal search for non-AV pages
  if (searchIndexPromise) {
    await searchIndexPromise;
  } else if (searchIndexRootNode) {
    searchIndexPromise = buildSearchIndexRecursive(searchIndexRootNode, [{ node: searchIndexRootNode, title: "Home" }]).catch(() => {});
    await searchIndexPromise;
  }

  const results = searchIndex
    .filter(e => e.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  renderSearchResults(results, q);
});

searchInput.addEventListener("keydown", (e) => {
  const items = searchResults.querySelectorAll(".search-item");
  if (e.key === "ArrowDown") {
    const now = Date.now();
    if (now - searchDownLastAt <= 200) {
      e.preventDefault();
      searchDownLastAt = 0;
      activeSearchIdx = -1;
      closeSearch();
      searchInput.blur();
      requestAnimationFrame(() => moveTVFocus("ArrowDown"));
      return;
    }
    searchDownLastAt = now;
    e.preventDefault();
    activeSearchIdx = Math.min(activeSearchIdx + 1, items.length - 1);
    updateActiveSearch(items);
  } else if (e.key === "ArrowUp") {
    searchDownLastAt = 0;
    e.preventDefault();
    activeSearchIdx = Math.max(activeSearchIdx - 1, -1);
    updateActiveSearch(items);
  } else if (e.key === "Enter" && activeSearchIdx >= 0) {
    searchDownLastAt = 0;
    items[activeSearchIdx]?.click();
  } else {
    searchDownLastAt = 0;
  }
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.classList.add("hidden");
  closeSearch();
  // AV browsable: reapply filters (without text search)
  if (lastNode?.browsable && browseAllStations.length) {
    applyAvFilters();
    return;
  }
  if (preSearchState) {
    navHistory = preSearchState.history;
    renderNode(preSearchState.node, preSearchState.title, { page: preSearchState.page, sort: preSearchState.sort });
    preSearchState = null;
  }
});

/* ===== AV Filter (inline in section header) ===== */
function closeAvDropdowns() {
  document.getElementById("av-filter-genre-dropdown")?.classList.add("hidden");
  document.getElementById("av-filter-actress-dropdown")?.classList.add("hidden");
}
function resetAvFilters() {
  avActiveGenre = null;
  avActiveActress = null;
}

function buildAvDropdown(dropdownEl, items, onSelect) {
  dropdownEl.innerHTML = `<input type="search" placeholder="ค้นหา..." autocomplete="off" />`
    + items.map(it =>
      `<div class="av-filter-option" data-value="${esc(it.name)}">${esc(it.name)}<span class="av-filter-count">${it.count}</span></div>`
    ).join("");

  const searchBox = dropdownEl.querySelector("input");
  const options = dropdownEl.querySelectorAll(".av-filter-option");

  searchBox.addEventListener("input", () => {
    const q = searchBox.value.trim().toLowerCase();
    options.forEach(opt => {
      opt.style.display = opt.dataset.value.toLowerCase().includes(q) ? "" : "none";
    });
  });
  searchBox.addEventListener("keydown", e => e.stopPropagation());

  options.forEach(opt => {
    opt.addEventListener("click", () => {
      onSelect(opt.dataset.value);
      closeAvDropdowns();
    });
  });
}

function applyAvFilters() {
  if (!browseAllStations.length) return;
  const q = searchInput.value.trim().toLowerCase();
  let filtered = browseAllStations;

  if (q) {
    filtered = filtered.filter(s => {
      if ((s.name || "").toLowerCase().includes(q)) return true;
      const actresses = s.meta?.actresses;
      if (actresses && (Array.isArray(actresses) ? actresses : [actresses]).some(a => a.toLowerCase().includes(q))) return true;
      const genres = s.meta?.genres;
      if (genres && (Array.isArray(genres) ? genres : [genres]).some(g => g.toLowerCase().includes(q))) return true;
      return false;
    });
  }
  if (avActiveGenre) {
    filtered = filtered.filter(s => {
      const genres = s.meta?.genres;
      return genres && (Array.isArray(genres) ? genres : [genres]).some(g => g === avActiveGenre);
    });
  }
  if (avActiveActress) {
    filtered = filtered.filter(s => {
      const actresses = s.meta?.actresses;
      return actresses && (Array.isArray(actresses) ? actresses : [actresses]).some(a => a === avActiveActress);
    });
  }

  currentPage = 0;
  renderBrowsableStations(filtered, browseTitle, browseParentNode, { isFilter: true });
}

function collectAvMeta(field) {
  const countMap = {};
  browseAllStations.forEach(s => {
    const values = s.meta?.[field];
    if (!values) return;
    (Array.isArray(values) ? values : [values]).forEach(v => {
      countMap[v] = (countMap[v] || 0) + 1;
    });
  });
  return Object.entries(countMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function wireAvFilterButtons() {
  const genreBtn = document.getElementById("av-filter-genre-btn");
  const genreDd = document.getElementById("av-filter-genre-dropdown");
  const actressBtn = document.getElementById("av-filter-actress-btn");
  const actressDd = document.getElementById("av-filter-actress-dropdown");
  const clearBtn = document.getElementById("av-filter-clear");
  if (!genreBtn) return;

  genreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (avActiveGenre) { avActiveGenre = null; applyAvFilters(); return; }
    const wasOpen = !genreDd.classList.contains("hidden");
    closeAvDropdowns();
    if (wasOpen) return;
    buildAvDropdown(genreDd, collectAvMeta("genres"), (val) => {
      avActiveGenre = val;
      applyAvFilters();
    });
    genreDd.classList.remove("hidden");
    genreDd.querySelector("input")?.focus();
  });

  actressBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (avActiveActress) { avActiveActress = null; applyAvFilters(); return; }
    const wasOpen = !actressDd.classList.contains("hidden");
    closeAvDropdowns();
    if (wasOpen) return;
    buildAvDropdown(actressDd, collectAvMeta("actresses"), (val) => {
      avActiveActress = val;
      applyAvFilters();
    });
    actressDd.classList.remove("hidden");
    actressDd.querySelector("input")?.focus();
  });

  clearBtn?.addEventListener("click", () => {
    avActiveGenre = null;
    avActiveActress = null;
    applyAvFilters();
  });
}

// Close dropdowns when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".av-filter-group")) closeAvDropdowns();
});

function updateActiveSearch(items) {
  items.forEach((el, i) => el.classList.toggle("active", i === activeSearchIdx));
}

function renderSearchResults(results, q) {
  if (results.length === 0) {
    searchResults.innerHTML = `<div class="search-no-result">ไม่พบ "${esc(q)}"</div>`;
  } else {
    searchResults.innerHTML = results.map((r, i) => {
      const thumb = r.image
        ? `<img class="search-thumb" src="${esc(r.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : "";
      const ph = `<div class="search-thumb-ph" style="${r.image ? "display:none" : ""}">🎬</div>`;
      const pathStr = r.path.length ? esc(r.path.join(" › ")) : "";
      const title = splitCardTitle(r.name);
      return `<div class="search-item" data-idx="${i}" tabindex="0" role="button">${thumb}${ph}
        <div class="search-item-info">
          <div class="search-item-name">
            <div class="search-item-name-main">${esc(title.main)}</div>
            ${title.th ? `<div class="search-item-name-th">${esc(title.th)}</div>` : ""}
          </div>
          ${pathStr ? `<div class="search-item-path">${pathStr}</div>` : ""}
        </div></div>`;
    }).join("");

    searchResults.querySelectorAll(".search-item").forEach((el, i) => {
      el.addEventListener("click", () => {
        navigateToSearchResult(results[i]);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          el.click();
        }
      });
    });
  }
  searchResults.classList.remove("hidden");
}

function navigateToSearchResult(entry) {
  if (preSearchState) {
    searchReturnState = {
      node: preSearchState.node,
      title: preSearchState.title,
      history: [...preSearchState.history],
      page: preSearchState.page,
      sort: preSearchState.sort,
      query: preSearchState.query || searchInput.value.trim(),
    };
  }

  // Set navHistory to reconstruct proper breadcrumb
  navHistory = [...entry.historyChain];
  closeSearch();
  // Keep search text visible
  searchClear.classList.remove("hidden");

  const group = entry.node;
  if (group.url && !group.groups && !group.stations) {
    fetchAndRender(group.url, group.name || "...");
  } else {
    renderNode(group, group.name || "...");
  }
}

function clearSearchReturnState() {
  searchReturnState = null;
  preSearchState = null;
}

function closeSearch() {
  searchResults.classList.add("hidden");
  activeSearchIdx = -1;
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function isTVBackKey(e) {
  return TV_BACK_KEYS.has(e.key) || TV_BACK_KEYCODES.has(e.keyCode);
}

function handleTVBack() {
  if (!playerOverlay.classList.contains("hidden")) {
    if (!epPanel.classList.contains("hidden")) {
      epPanel.classList.add("hidden");
      btnEpisodes.focus({ preventScroll: true });
      return true;
    }
    closePlayer();
    return true;
  }

  if (!searchResults.classList.contains("hidden")) {
    closeSearch();
    queueFocusRefresh();
    return true;
  }

  if (navHistory.length > 0) {
    goBackOneStep();
    return true;
  }

  return false;
}

function isElementVisible(el) {
  if (!el || !el.isConnected) return false;
  if (el.classList?.contains("hidden")) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  if (el.offsetParent === null && style.position !== "fixed") return false;
  return true;
}

function isTVFocusable(el) {
  return !!(el && el.matches && el.matches(TV_FOCUSABLE_SELECTOR) && isElementVisible(el));
}

function getTVFocusableElements() {
  const root = playerOverlay.classList.contains("hidden") ? document : playerOverlay;
  return Array.from(root.querySelectorAll(TV_FOCUSABLE_SELECTOR))
    .filter(isTVFocusable);
}

function focusTVElement(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function getFocusZone(el) {
  if (!el) return "other";
  if (el.classList?.contains("card")) return "card";
  if (el.closest?.("#pagination")) return "pagination";
  if (el.closest?.(".section-header")) return "section";
  if (el.closest?.("#app-header")) return "header";
  if (el.closest?.("#search-results")) return "search";
  return "other";
}

function hasDirectionalCandidate(current, candidates, directionKey) {
  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2,
  };

  return candidates.some((el) => {
    if (el === current) return false;
    const rect = el.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;
    if (directionKey === "ArrowRight") return dx > 2;
    if (directionKey === "ArrowLeft") return dx < -2;
    if (directionKey === "ArrowDown") return dy > 2;
    if (directionKey === "ArrowUp") return dy < -2;
    return false;
  });
}

function getDirectionalCandidates(current, directionKey, elements) {
  const zone = getFocusZone(current);
  const cards = elements.filter((el) => getFocusZone(el) === "card");
  const paginations = elements.filter((el) => getFocusZone(el) === "pagination");
  const sections = elements.filter((el) => getFocusZone(el) === "section");
  const headers = elements.filter((el) => getFocusZone(el) === "header");

  if (zone === "card") {
    if (directionKey === "ArrowLeft" || directionKey === "ArrowRight" || directionKey === "ArrowDown") {
      if (directionKey === "ArrowDown" && !hasDirectionalCandidate(current, cards, directionKey)) {
        return [...paginations, ...cards];
      }
      return cards;
    }
    if (directionKey === "ArrowUp") {
      if (hasDirectionalCandidate(current, cards, directionKey)) return cards;
      return [...sections, ...headers, ...cards];
    }
  }

  if (zone === "pagination") {
    if (directionKey === "ArrowLeft" || directionKey === "ArrowRight") return paginations;
    if (directionKey === "ArrowDown") return paginations;
    if (directionKey === "ArrowUp") {
      if (hasDirectionalCandidate(current, cards, directionKey)) return cards;
      return [...cards, ...sections, ...headers];
    }
  }

  if (zone === "section") {
    if (directionKey === "ArrowLeft" || directionKey === "ArrowRight") return sections;
    if (directionKey === "ArrowDown") return [...cards, ...paginations, ...sections];
    if (directionKey === "ArrowUp") return [...headers, ...sections];
  }

  if (zone === "header") {
    if (directionKey === "ArrowLeft" || directionKey === "ArrowRight") return headers;
    if (directionKey === "ArrowDown") return [...sections, ...cards, ...paginations];
    if (directionKey === "ArrowUp") return headers;
  }

  return elements;
}

function moveTVFocus(directionKey) {
  const elements = getTVFocusableElements();
  if (!elements.length) return;

  const current = isTVFocusable(document.activeElement) ? document.activeElement : null;
  if (!current) {
    focusTVElement(elements[0]);
    return;
  }

  const directionalCandidates = getDirectionalCandidates(current, directionKey, elements);
  const scanElements = directionalCandidates.length ? directionalCandidates : elements;

  const currentRect = current.getBoundingClientRect();
  const currentCenter = { x: currentRect.left + currentRect.width / 2, y: currentRect.top + currentRect.height / 2 };

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;

  scanElements.forEach((el) => {
    if (el === current) return;
    const rect = el.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;

    let primary = 0;
    let cross = 0;
    if (directionKey === "ArrowRight" && dx > 2) { primary = dx; cross = Math.abs(dy); }
    else if (directionKey === "ArrowLeft" && dx < -2) { primary = -dx; cross = Math.abs(dy); }
    else if (directionKey === "ArrowDown" && dy > 2) { primary = dy; cross = Math.abs(dx); }
    else if (directionKey === "ArrowUp" && dy < -2) { primary = -dy; cross = Math.abs(dx); }
    else return;

    const score = primary * 1000 + cross;
    if (score < bestScore) {
      best = el;
      bestScore = score;
    }
  });

  if (best) focusTVElement(best);
}

function queueFocusRefresh() {
  clearTimeout(focusRefreshTimer);
  focusRefreshTimer = setTimeout(() => {
    const elements = getTVFocusableElements();
    if (!elements.length) return;

    const preferred = !playerOverlay.classList.contains("hidden")
      ? (!epPanel.classList.contains("hidden")
        ? epPanelGrid.querySelector(".ep-card.active") || epPanelGrid.querySelector(".ep-card")
        : btnPlayPause)
      : gridView.classList.contains("hidden")
        ? logo
        : document.querySelector(".card") || document.querySelector(".section-back-btn") || logo;

    focusTVElement(isTVFocusable(preferred) ? preferred : elements[0]);
  }, 0);
}

/* ===== Render node ===== */
function renderNode(node, title, options = {}) {
  const { page = null, sort = null } = options;
  lastNode = node;
  lastTitle = title;
  updateBreadcrumb(title);

  if (node.groups?.length) {
    // Hide AV category until unlocked
    const visibleGroups = avUnlocked
      ? node.groups
      : node.groups.filter(g => !/^AV$/i.test(g.name));
    const renderableNode = visibleGroups.length !== node.groups.length
      ? { ...node, groups: visibleGroups }
      : node;
    currentPage = typeof page === "number" ? page : 0;
    currentSortOrder = sort === "za" ? "za" : "az";
    renderGroups(renderableNode.groups, title, renderableNode);
  } else if (node.stations?.length && node.browsable) {
    // Browsable station list (e.g. AV) — explicitly flagged with "browsable": true
    currentPage = typeof page === "number" ? page : 0;
    currentSortOrder = sort === "za" ? "za" : "az";
    renderBrowsableStations(node.stations, title, node);
  } else if (node.stations?.length) {
    renderStations(node.stations, node.referer, title);
  } else {
    showError("ไม่พบข้อมูลใน playlist นี้");
    return;
  }
  showGrid();
}

/* ===== Render group cards (with pagination) ===== */
function renderGroups(groups, sectionTitle, parentNode) {
  currentGroups = groups;
  currentGroupTitle = sectionTitle;
  currentGroupParent = parentNode;
  const extractNum = (name) => { const m = String(name || "").match(/\d+/); return m ? parseInt(m[0]) : null; };
  const allNumeric = groups.every(g => extractNum(g?.name || g?.info) !== null);
  const hasBadges  = groups.some(g => g.badge);
  const sortedGroups = [...groups].sort((a, b) => {
    // ถ้ามี badge (เช่น "ภาค 1", "ภาค 2") → sort ตาม badge number ก่อน
    if (hasBadges) {
      const ba = extractNum(a.badge) ?? Infinity;
      const bb = extractNum(b.badge) ?? Infinity;
      if (ba !== bb) return currentSortOrder === "za" ? bb - ba : ba - bb;
    }
    const nameA = String(a?.name || a?.info || "").toLowerCase();
    const nameB = String(b?.name || b?.info || "").toLowerCase();
    if (allNumeric) {
      const diff = extractNum(nameA) - extractNum(nameB);
      return currentSortOrder === "za" ? -diff : diff;
    }
    return currentSortOrder === "za" ? nameB.localeCompare(nameA) : nameA.localeCompare(nameB);
  });

  const total = sortedGroups.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageGroups = sortedGroups.slice(start, start + PAGE_SIZE);
  const pageItems = getPaginationItems(totalPages, currentPage);

  const normalizedSectionTitle = String(sectionTitle || "").trim().toLowerCase();
  const showCountInTitle = (normalizedSectionTitle === "the series") || (normalizedSectionTitle === "the movies") || (normalizedSectionTitle === "movies") || (normalizedSectionTitle === "series");

  gridView.innerHTML = `${renderSectionHeader(sectionTitle, {
    withSort: true,
    sort: currentSortOrder,
    count: showCountInTitle ? total : null,
  })}
    <div class="card-grid portrait"></div>
    ${totalPages > 1 ? `<nav id="pagination" aria-label="Pagination">
      <button class="page-btn page-nav" id="page-prev" ${currentPage === 0 ? "disabled" : ""} aria-label="หน้าก่อนหน้า">
        ${PAGINATION_ICON_PREV}
      </button>
      <div id="page-numbers">
        ${pageItems.map(item => {
          const pageNum = Number(item);
          const isActive = pageNum === currentPage + 1;
          return `<button class="page-btn page-number${isActive ? " active" : ""}" data-page="${pageNum - 1}" ${isActive ? 'aria-current="page"' : ""} aria-label="หน้า ${pageNum}">${pageNum}</button>`;
        }).join("")}
      </div>
      <button class="page-btn page-nav" id="page-next" ${currentPage >= totalPages - 1 ? "disabled" : ""} aria-label="หน้าถัดไป">
        ${PAGINATION_ICON_NEXT}
      </button>
    </nav>` : ""}`;

  const grid = gridView.querySelector(".card-grid");
  document.getElementById("section-back")?.addEventListener("click", goBackOneStep);

  pageGroups.forEach((group) => {
    const card = makeCard({
      name: group.name || group.info || "ไม่มีชื่อ",
      image: group.image,
      sub: group.author && group.author !== "Bank_" ? group.author : null,
      landscape: false,
      badge: group.badge || null,
    });

    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      const prevNode = { groups, referer: null };
      navHistory.push({ node: prevNode, title: sectionTitle, page: currentPage, sort: currentSortOrder, url: lastFetchUrl || null });
      if (group.url && !group.groups && !group.stations) {
        fetchAndRender(group.url, group.name || "...");
      } else {
        lastFetchUrl = null;  // inline sub-group, no URL to re-fetch
        renderNode(group, group.name || "...");
      }
    });

    grid.appendChild(card);
  });

  if (totalPages > 1) {
    const goToPage = (targetPage) => {
      const clamped = Math.max(0, Math.min(targetPage, totalPages - 1));
      if (clamped === currentPage) return;
      currentPage = clamped;
      renderGroups(currentGroups, currentGroupTitle, currentGroupParent);
      showGrid();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    document.getElementById("page-prev")?.addEventListener("click", () => {
      goToPage(currentPage - 1);
    });

    document.getElementById("page-next")?.addEventListener("click", () => {
      goToPage(currentPage + 1);
    });

    gridView.querySelectorAll(".page-number").forEach((btn) => {
      btn.addEventListener("click", () => {
        goToPage(Number(btn.dataset.page));
      });
    });
  }

  gridView.querySelector(".sort-order-toggle")?.addEventListener("click", () => {
    currentSortOrder = currentSortOrder === "az" ? "za" : "az";
    currentPage = 0;
    renderGroups(currentGroups, currentGroupTitle, currentGroupParent);
    showGrid();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function getPaginationItems(totalPages, activePageIdx) {
  const windowSize = 5;
  if (totalPages <= windowSize) return Array.from({ length: totalPages }, (_, i) => i + 1);

  let start = activePageIdx - Math.floor(windowSize / 2);
  start = Math.max(0, Math.min(start, totalPages - windowSize));
  return Array.from({ length: windowSize }, (_, i) => start + i + 1);
}

function renderSectionHeader(title, options = {}) {
  const { withSort = false, sort = "az", count = null, withFilter = false, sortMode = "alpha" } = options;
  const canGoBack = navHistory.length > 0;
  const splitTitle = splitCardTitle(title);
  const titleMain = typeof count === "number" ? `${splitTitle.main} (${count})` : splitTitle.main;
  let sortIcon, sortLabel;
  if (sortMode === "date") {
    sortIcon = sort === "za"
      ? `<i class="fi fi-rr-calendar-arrow-up" aria-hidden="true"></i>`
      : `<i class="fi fi-rr-calendar-arrow-down" aria-hidden="true"></i>`;
    sortLabel = sort === "za" ? "เก่าสุดก่อน" : "ใหม่สุดก่อน";
  } else {
    sortIcon = sort === "za"
      ? `<i class="fi fi-sr-sort-alpha-up" aria-hidden="true"></i>`
      : `<i class="fi fi-sr-sort-alpha-down" aria-hidden="true"></i>`;
    sortLabel = sort === "za" ? "เรียง Z ไป A" : "เรียง A ไป Z";
  }

  const filterHtml = withFilter ? `
    <div class="av-filter-group">
      <button id="av-filter-genre-btn" class="av-filter-btn${avActiveGenre ? " active" : ""}">${avActiveGenre ? esc(avActiveGenre) + " ✕" : "หมวดหมู่ ▾"}</button>
      <div id="av-filter-genre-dropdown" class="av-filter-dropdown hidden"></div>
    </div>
    <div class="av-filter-group">
      <button id="av-filter-actress-btn" class="av-filter-btn${avActiveActress ? " active" : ""}">${avActiveActress ? esc(avActiveActress) + " ✕" : "นักแสดง ▾"}</button>
      <div id="av-filter-actress-dropdown" class="av-filter-dropdown right hidden"></div>
    </div>
    ${avActiveGenre || avActiveActress ? `<button id="av-filter-clear" class="av-filter-clear-btn">ล้าง</button>` : ""}
  ` : "";

  return `<div class="section-header">
    ${canGoBack ? `<button id="section-back" class="section-back-btn" aria-label="ย้อนกลับ">${SECTION_BACK_ICON}</button>` : ""}
    <h2 class="section-title">
      <span class="section-title-main">${esc(titleMain)}</span>
      ${splitTitle.th ? `<span class="section-title-th">${esc(splitTitle.th)}</span>` : ""}
    </h2>
    ${withSort || withFilter ? `<div class="section-header-right">${filterHtml}${withSort ? `<button class="sort-order-toggle" aria-label="${sortLabel}" title="${sortLabel}">${sortIcon}</button>` : ""}</div>` : ""}
  </div>`;
}

function goBackOneStep() {
  if (searchReturnState) {
    const state = searchReturnState;
    searchReturnState = null;
    preSearchState = null;
    navHistory = state.history;
    renderNode(state.node, state.title, { page: state.page, sort: state.sort });
    searchInput.value = state.query || "";
    searchClear.classList.toggle("hidden", !searchInput.value.trim());
    closeSearch();
    showGrid();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const prev = navHistory.pop();
  if (!prev) return;
  if (prev.url) {
    fetchAndRender(prev.url, prev.title);
  } else {
    renderNode(prev.node, prev.title, { page: prev.page, sort: prev.sort });
    showGrid();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ===== Render episode cards ===== */
function renderStations(stations, referer, sectionTitle) {
  gridView.innerHTML = `${renderSectionHeader(sectionTitle)}
    <div class="card-grid landscape"></div>`;

  const grid = gridView.querySelector(".card-grid");
  document.getElementById("section-back")?.addEventListener("click", goBackOneStep);

  stations.forEach((station, i) => {
    const card = makeCard({
      name: station.name || `ตอนที่ ${i + 1}`,
      image: station.image,
      sub: null,
      landscape: true,
    });

    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      openPlayer(stations, i, referer, sectionTitle);
    });

    grid.appendChild(card);
  });
}

/* ===== Render browsable stations (AV-like) with sort, pagination ===== */
let browseAllStations = [];     // original full list (never overwritten by search filter)
let browseFilteredStations = []; // currently displayed (filtered or full)
let browseTitle = "";
let browseParentNode = null;

function renderBrowsableStations(stations, sectionTitle, parentNode, { isFilter = false } = {}) {
  if (!isFilter) browseAllStations = stations;  // only update full list when NOT a search filter
  browseFilteredStations = stations;
  browseTitle = sectionTitle;
  browseParentNode = parentNode;

  // Sort by release_date (newest first = default "az", oldest first = "za")
  const sorted = [...stations].sort((a, b) => {
    const dateA = a.meta?.release_date || "0000-00-00";
    const dateB = b.meta?.release_date || "0000-00-00";
    return currentSortOrder === "za" ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });

  const total = sorted.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageItems = getPaginationItems(totalPages, currentPage);
  const pageStations = sorted.slice(start, start + PAGE_SIZE);

  gridView.innerHTML = `${renderSectionHeader(sectionTitle, {
    withSort: true,
    withFilter: true,
    sortMode: "date",
    sort: currentSortOrder,
    count: total,
  })}
    <div class="card-grid landscape"></div>
    ${totalPages > 1 ? `<nav id="pagination" aria-label="Pagination">
      <button class="page-btn page-nav" id="page-prev" ${currentPage === 0 ? "disabled" : ""}>
        ${PAGINATION_ICON_PREV}
      </button>
      <div id="page-numbers">
        ${pageItems.map(p => {
          const isActive = p === currentPage + 1;
          return `<button class="page-btn page-number${isActive ? " active" : ""}" data-page="${p - 1}">${p}</button>`;
        }).join("")}
      </div>
      <button class="page-btn page-nav" id="page-next" ${currentPage >= totalPages - 1 ? "disabled" : ""}>
        ${PAGINATION_ICON_NEXT}
      </button>
    </nav>` : ""}`;

  const grid = gridView.querySelector(".card-grid");
  document.getElementById("section-back")?.addEventListener("click", goBackOneStep);
  wireAvFilterButtons();

  pageStations.forEach((station) => {
    const globalIdx = stations.indexOf(station);
    const meta = station.meta;
    // Subtitle: actresses only
    let sub = null;
    if (meta?.actresses) {
      sub = Array.isArray(meta.actresses) ? meta.actresses.join(", ") : meta.actresses;
    }
    // Badge: top-level key e.g. "Uncensored Leaked"
    const badge = station.badge || null;

    const card = makeCard({
      name: station.name || "ไม่มีชื่อ",
      image: station.image,
      sub,
      landscape: true,
      badge,
    });

    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      openPlayer(stations, globalIdx, null, sectionTitle, { allowShuffle: true });
    });

    grid.appendChild(card);
  });

  // Pagination (use filtered list to keep search results intact)
  if (totalPages > 1) {
    const goToPage = (p) => {
      currentPage = Math.max(0, Math.min(p, totalPages - 1));
      renderBrowsableStations(browseFilteredStations, browseTitle, browseParentNode, { isFilter: true });
      showGrid();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    document.getElementById("page-prev")?.addEventListener("click", () => goToPage(currentPage - 1));
    document.getElementById("page-next")?.addEventListener("click", () => goToPage(currentPage + 1));
    gridView.querySelectorAll(".page-number").forEach(btn => {
      btn.addEventListener("click", () => goToPage(Number(btn.dataset.page)));
    });
  }

  // Sort toggle
  gridView.querySelector(".sort-order-toggle")?.addEventListener("click", () => {
    currentSortOrder = currentSortOrder === "az" ? "za" : "az";
    currentPage = 0;
    renderBrowsableStations(browseFilteredStations, browseTitle, browseParentNode, { isFilter: true });
    showGrid();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* ===== Make Card element ===== */
function makeCard({ name, image, sub, landscape, badge }) {
  const card = document.createElement("div");
  card.className = "card";
  card.title = name || "";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") e.target.click();
  });

  const thumb = document.createElement(image ? "img" : "div");
  thumb.className = "card-thumb" + (image ? "" : " card-thumb-placeholder");
  if (image) {
    thumb.src = image;
    thumb.alt = name;
    thumb.loading = "lazy";
    thumb.onerror = () => {
      thumb.style.display = "none";
      const ph = document.createElement("div");
      ph.className = "card-thumb card-thumb-placeholder";
      ph.textContent = landscape ? "▶" : "🎬";
      card.insertBefore(ph, card.firstChild);
    };
  } else {
    thumb.textContent = landscape ? "▶" : "🎬";
  }

  if (badge) {
    const badgeEl = document.createElement("div");
    badgeEl.className = "card-badge";
    badgeEl.textContent = badge;
    thumb.style.position = "relative";
    const wrapper = document.createElement("div");
    wrapper.className = "card-thumb-wrap";
    wrapper.appendChild(thumb);
    wrapper.appendChild(badgeEl);
    card.appendChild(wrapper);
  } else {
    card.appendChild(thumb);
  }

  const info = document.createElement("div");
  info.className = "card-info";
  const title = splitCardTitle(name);
  info.innerHTML = `<div class="card-name"><div class="card-name-main">${esc(title.main)}</div>${title.th ? `<div class="card-name-th">${esc(title.th)}</div>` : ""}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ""}`;

  card.appendChild(info);
  return card;
}

function splitCardTitle(name) {
  const raw = String(name || "").trim();
  if (!raw) return { main: "", th: "" };

  const bracketMatch = raw.match(/^(.*?)\s*[\[\(](.+?)[\]\)]\s*$/);
  if (bracketMatch) {
    const main = bracketMatch[1].trim();
    const alt = bracketMatch[2].trim();
    if (main && /[\u0E00-\u0E7F]/.test(alt)) return { main, th: alt };
  }

  return { main: raw, th: "" };
}

/* ===== Breadcrumb ===== */
function updateBreadcrumb(currentTitle) {
  breadcrumb.innerHTML = "";

  navHistory.forEach((entry, i) => {
    const span = document.createElement("span");
    span.className = "breadcrumb-item";
    span.textContent = entry.title;
    span.tabIndex = 0;
    span.setAttribute("role", "button");
    span.addEventListener("click", () => {
      navHistory = navHistory.slice(0, i);
      if (entry.url) {
        currentPage = entry.page || 0;
        currentSortOrder = entry.sort || "az";
        fetchAndRender(entry.url, entry.title);
      } else {
        renderNode(entry.node, entry.title, { page: entry.page, sort: entry.sort });
      }
    });
    span.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        span.click();
      }
    });
    breadcrumb.appendChild(span);

    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "›";
    breadcrumb.appendChild(sep);
  });

  const current = document.createElement("span");
  current.className = "breadcrumb-item active";
  current.textContent = currentTitle;
  breadcrumb.appendChild(current);
}

/* ===== Player ===== */
function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[‐‑‒–—−]/g, "-");
}

function buildCrossSeasonQueue(languageTitle, inheritedReferer) {
  const seasonEntry = navHistory[navHistory.length - 1];
  const seriesEntry = navHistory[navHistory.length - 2];
  const seasonGroups = seriesEntry?.node?.groups;
  if (!Array.isArray(seasonGroups) || seasonGroups.length === 0) return { queue: [], seasons: [] };
  if (!Array.isArray(seasonEntry?.node?.groups)) return { queue: [], seasons: [] };

  const langKey = normalizeKey(languageTitle);
  const queue = [];
  const seasons = [];

  seasonGroups.forEach((season) => {
    const langs = Array.isArray(season?.groups) ? season.groups : [];
    const matchedLang = langs.find((lang) => normalizeKey(lang.name || lang.info) === langKey);
    if (!matchedLang || !Array.isArray(matchedLang.stations) || matchedLang.stations.length === 0) return;

    const groupReferer = matchedLang.referer ?? season.referer ?? inheritedReferer ?? null;
    const seasonTitle = season.name || season.info || `Season ${seasons.length + 1}`;
    seasons.push({
      title: seasonTitle,
      stations: matchedLang.stations,
      referer: groupReferer,
    });
    matchedLang.stations.forEach((station, localIndex) => {
      queue.push({
        station,
        stations: matchedLang.stations,
        localIndex,
        referer: station.referer ?? groupReferer,
        seasonTitle,
      });
    });
  });

  return { queue, seasons };
}

function resolveAdjacentEpisode(step) {
  // Shuffle mode: pick a random unplayed station from currentStations
  if (shuffleMode && step > 0 && currentStations.length > 1) {
    const unplayed = [];
    for (let i = 0; i < currentStations.length; i++) {
      if (!shuffleHistory.includes(i)) unplayed.push(i);
    }
    // If all played, reset history (but exclude current)
    if (unplayed.length === 0) {
      shuffleHistory = [currentIndex];
      for (let i = 0; i < currentStations.length; i++) {
        if (i !== currentIndex) unplayed.push(i);
      }
    }
    if (unplayed.length > 0) {
      const pick = unplayed[Math.floor(Math.random() * unplayed.length)];
      return { type: "local", index: pick };
    }
  }

  const localIndex = currentIndex + step;
  if (localIndex >= 0 && localIndex < currentStations.length) {
    return { type: "local", index: localIndex };
  }

  if (crossSeasonIndex >= 0) {
    const queueIndex = crossSeasonIndex + step;
    if (queueIndex >= 0 && queueIndex < crossSeasonQueue.length) {
      return { type: "queue", queueIndex };
    }
  }

  return null;
}

function playEpisodeFromQueue(queueIndex) {
  const item = crossSeasonQueue[queueIndex];
  if (!item) return;
  crossSeasonIndex = queueIndex;
  currentStations = item.stations;
  currentSeasonTitle = item.seasonTitle || currentSeasonTitle;
  playEpisode(item.localIndex, item.referer);
}

function openPlayer(stations, index, inheritedReferer, languageTitle = "", { allowShuffle = false } = {}) {
  currentStations = stations;
  currentIndex = index;
  upnextCancelled = false;
  // Shuffle only available for AV (browsable) playlists
  isAvMode = allowShuffle;
  btnShuffle.hidden = !allowShuffle;
  if (!allowShuffle) shuffleMode = false;
  shuffleHistory = shuffleMode ? [index] : [];
  btnShuffle.classList.toggle("active", shuffleMode);
  inheritedRefererCache = inheritedReferer;
  playerSectionTitle = languageTitle;
  const crossSeasonData = buildCrossSeasonQueue(languageTitle, inheritedReferer);
  crossSeasonQueue = crossSeasonData.queue;
  crossSeasonSeasons = crossSeasonData.seasons;
  crossSeasonIndex = crossSeasonQueue.findIndex((item) => item.stations === stations && item.localIndex === index);
  currentSeasonTitle = navHistory[navHistory.length - 1]?.title || "";
  if (crossSeasonIndex >= 0) {
    currentSeasonTitle = crossSeasonQueue[crossSeasonIndex].seasonTitle || currentSeasonTitle;
  }
  epPanelSeasonFilter = currentSeasonTitle || crossSeasonSeasons[0]?.title || "";

  playerOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  updateVolumeUI();
  showPlayerUI();
  hidePlayerNotice();

  playEpisode(index, inheritedReferer);
  queueFocusRefresh();
}

function showPlayerNotice(message, ms = 7000) {
  if (!playerNotice) return;
  clearTimeout(playerNoticeTimer);
  playerNotice.textContent = message;
  playerNotice.classList.remove("hidden");
  if (ms > 0) {
    playerNoticeTimer = setTimeout(() => {
      playerNotice.classList.add("hidden");
    }, ms);
  }
}

function hidePlayerNotice() {
  if (!playerNotice) return;
  clearTimeout(playerNoticeTimer);
  playerNotice.classList.add("hidden");
}

function playEpisode(index, inheritedReferer) {
  const station = currentStations[index];
  if (!station) { closePlayer(); return; }

  currentIndex = index;
  // Track in shuffle history
  if (shuffleMode && !shuffleHistory.includes(index)) shuffleHistory.push(index);
  const referer = station.referer ?? inheritedReferer ?? null;
  inheritedRefererCache = referer;
  const url = station.url;
  const matchedQueueIdx = crossSeasonQueue.findIndex((item) => item.stations === currentStations && item.localIndex === index);
  if (matchedQueueIdx >= 0) {
    crossSeasonIndex = matchedQueueIdx;
    currentSeasonTitle = crossSeasonQueue[matchedQueueIdx].seasonTitle || currentSeasonTitle;
    epPanelSeasonFilter = currentSeasonTitle || epPanelSeasonFilter;
  }

  const episodeTitle = station.name || `ตอนที่ ${index + 1}`;

  // Movie/Anime-Movie: station name เป็นชื่อ track type (พากย์ไทย/ซับไทย) → สลับให้ part title เป็น main, track เป็น sub
  const isTrackLabel = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i.test(episodeTitle);
  // AV: แสดงชื่อ + นักแสดง เหมือน card
  const actresses = station.meta?.actresses;
  const actressSub = Array.isArray(actresses) ? actresses.join(", ") : (typeof actresses === "string" ? actresses : "");
  let displayMain, displaySub;
  if (actressSub) {
    // AV mode: name = "ABF-114", sub = "Suzumori Remu"
    displayMain = episodeTitle;
    displaySub = actressSub;
  } else if (isTrackLabel && playerSectionTitle) {
    displayMain = playerSectionTitle;
    displaySub = episodeTitle;
  } else {
    displayMain = episodeTitle;
    displaySub = currentSeasonTitle;
  }
  playerTitle.innerHTML = `<span class="player-title-main">${esc(displayMain)}</span>${displaySub ? `<span class="player-title-sub">${esc(displaySub)}</span>` : ""}`;
  btnPrevEp.disabled = !resolveAdjacentEpisode(-1);
  btnNextEp.disabled = !resolveAdjacentEpisode(1);
  btnEpisodes.innerHTML = `${EPISODES_ICON}<span>${index + 1}/${currentStations.length}</span>`;
  if (!epPanel.classList.contains("hidden")) renderEpPanel();

  cancelUpnext();
  resetProgress();
  hidePlayerNotice();
  loadSeekPreview();

  // ถ้ากำลัง AirPlay/Cast อยู่ ต้องข้าม HLS.js → ใช้ native source ต่อเนื่อง
  // เพื่อไม่ให้ blob: URL (MSE) ไป kill cast session — ไม่งั้นจอทีวีจะกระพริบ
  // แล้วภาพหาย (เพราะ cast receiver serialize blob ข้ามเครือข่ายไม่ได้)
  setupVideoSource(url, referer, { forceNative: isCurrentlyCasting() });

  playerVideo.onended = () => scheduleNext();
}

/** true ถ้า video element กำลัง cast อยู่ (Safari AirPlay หรือ W3C Remote Playback) */
function isCurrentlyCasting() {
  // Safari / WebKit AirPlay
  if ("webkitCurrentPlaybackTargetIsWireless" in playerVideo) {
    if (playerVideo.webkitCurrentPlaybackTargetIsWireless) return true;
  }
  // Chrome / W3C Remote Playback API
  if (playerVideo.remote && typeof playerVideo.remote.state === "string") {
    const s = playerVideo.remote.state;
    if (s === "connected" || s === "connecting") return true;
  }
  return false;
}

/**
 * Set up the <video> element to play `url`, using HLS.js (MSE) by default.
 * ใช้ `forceNative: true` ตอนต้องการใช้ native HLS (เช่น AirPlay/Cast) เพราะ
 * MSE-based playback (blob: URL) ส่งผ่านไปที่ cast target ไม่ได้
 * → audio streams แต่ภาพค้างดำ
 *
 * options:
 *   forceNative  — บังคับใช้ native source แทน HLS.js
 *   startTime    — วินาที สำหรับ seek หลัง metadata โหลดเสร็จ (0 = เริ่มต้น)
 *   autoplay     — true = เรียก play() หลัง source พร้อม (default true)
 */
function setupVideoSource(url, referer, { forceNative = false, startTime = 0, autoplay = true } = {}) {
  const isHlsUrl = /\.m3u8($|\?)/i.test(String(url || ""));
  const isDirectMediaUrl = /\.(mp4|webm|ogg|mov|m4v|avi|mp3|aac|wav)($|\?)/i.test(String(url || ""));
  const hasHlsRuntime = typeof Hls !== "undefined";
  let hlsJsSupported = false;
  if (hasHlsRuntime) {
    try { hlsJsSupported = Hls.isSupported(); } catch (_) { hlsJsSupported = false; }
  }
  // Safari WebKit (iOS + macOS) มี native HLS + native AirPlay ที่เสถียรมาก →
  // ต้องใช้ native source เสมอ ไม่แตะ HLS.js/MSE/blob: URL เลย มิฉะนั้น AirPlay
  // session จะพังตอนเปลี่ยนตอน/เปลี่ยนเรื่อง (blob URL serialize ไป Apple TV ไม่ได้)
  // Detect ผ่าน webkitShowPlaybackTargetPicker — มีเฉพาะใน WebKit ที่รองรับ AirPlay
  // (เชื่อถือได้กว่า canPlayType ที่ Chrome 146+ return "maybe" ทั้งที่เล่น HLS ไม่ได้)
  const isSafariWebKit = typeof playerVideo.webkitShowPlaybackTargetPicker === "function";
  // ใช้ Hls.isSupported() เป็น gate หลักแทน canPlayType
  // เหตุผล: Chrome 146+ บน desktop เริ่ม return "maybe" สำหรับ application/vnd.apple.mpegurl
  // ทั้งที่จริงๆ เล่น HLS native ไม่ได้ → canPlayType ไม่น่าเชื่อถืออีกต่อไป
  // HLS.js ทำงานได้ดีในทุก browser ที่มี MSE ยกเว้น Safari (ต้อง native เพื่อ AirPlay)
  // จะ fallback ไป native ก็ต่อเมื่อ: Safari, HLS.js ไม่ทำงาน, หรือ forceNative = true
  const shouldTryHls = !forceNative && !isSafariWebKit && hlsJsSupported && (isHlsUrl || !isDirectMediaUrl);

  if (shouldTryHls) {
    // HLS.js path: ต้อง destroy instance เดิมก่อนสร้างใหม่ เพื่อไม่ให้ attach ซ้อน
    destroyHls();
    let networkRetries = 0;
    let mediaRetries = 0;
    hls = new Hls({
      xhrSetup: referer
        ? (xhr) => {
            try {
              xhr.setRequestHeader("Referer", referer);
            } catch (_) {}
          }
        : undefined,
    });
    hls.loadSource(url);
    hls.attachMedia(playerVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (startTime > 0) {
        try { playerVideo.currentTime = startTime; } catch (_) {}
      }
      if (!autoplay) return;
      playerVideo.play().catch(err => {
        if (err.name !== "AbortError") console.error("[player] play() rejected:", err);
        if (err.name === "NotSupportedError") {
          showPlayerNotice("เล่นวิดีโอไม่ได้: codec ของสตรีมไม่รองรับ (play/NotSupportedError)");
        }
      });
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      // Log every error, fatal or not, for diagnostics
      console.warn("[HLS error]", {
        fatal: data?.fatal,
        type: data?.type,
        details: data?.details,
        reason: data?.reason,
        url: data?.url || data?.frag?.url || data?.context?.url,
        responseCode: data?.response?.code,
        responseText: data?.response?.text,
        err: data?.err?.message || data?.err,
      });
      if (!data?.fatal) return;

      const details = String(data?.details || "");
      const statusCode = Number(data?.response?.code || 0);
      const errLine = statusCode ? `HTTP ${statusCode}` : (data?.err?.message || data?.reason || "network/codec");

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (networkRetries < 1 && details !== "manifestLoadError") {
          networkRetries += 1;
          hls.startLoad();
          return;
        }
        // Fallback: ถ้า HLS.js โหลดไม่ได้ (เช่น CORS block) ลอง native HLS แทน
        // จะใช้ได้ใน browser ที่รองรับ native HLS (Safari, บาง Chrome)
        if (isHlsUrl && playerVideo.canPlayType("application/vnd.apple.mpegurl")) {
          console.warn("[HLS fallback] HLS.js network error → trying native HLS");
          destroyHls();
          playerVideo.src = url;
          playerVideo.load();
          if (startTime > 0) {
            playerVideo.addEventListener("loadedmetadata", () => {
              try { playerVideo.currentTime = startTime; } catch (_) {}
            }, { once: true });
          }
          if (autoplay) playerVideo.play().catch(() => {});
          return;
        }
        destroyHls();
        showPlayerNotice(`โหลดสตรีมไม่สำเร็จ: ${details} (${errLine})`, 10000);
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (mediaRetries < 1) {
          mediaRetries += 1;
          try { hls.recoverMediaError(); } catch (_) {}
          return;
        }
        destroyHls();
        showPlayerNotice(`เล่นสตรีมไม่สำเร็จ (Media): ${details}`, 10000);
        return;
      }
      destroyHls();
      showPlayerNotice(`เล่นสตรีมไม่สำเร็จ: ${data?.type || "UNKNOWN"} / ${details}`, 10000);
    });
  } else {
    if (!forceNative) {
      if (isHlsUrl && !hasHlsRuntime) {
        console.warn("HLS runtime is missing. Falling back to native video playback.");
      } else if (isHlsUrl && hasHlsRuntime && !Hls.isSupported()) {
        console.warn("HLS.js is loaded but Media Source Extensions are not supported in this browser.");
      }
    }
    // Native path: ตั้ง src ใหม่ก่อน แล้วค่อย destroy HLS.js
    // เหตุผล: ถ้า destroy ก่อน hls.destroy() จะ clear blob URL → video.src ว่างชั่วคราว
    // → ตัด AirPlay session (ทำให้จอทีวีกระพริบและหายไป). การตั้ง src ใหม่ก่อน
    // ทำให้ video element transition จาก blob URL เก่าไป native URL ตรงๆ โดย
    // cast receiver รับ source ใหม่ได้ต่อเนื่อง (hls.destroy() หลังจากนั้นจะไม่แตะ
    // src เพราะเช็คว่า media.src !== internal mediaSrc แล้ว จึงข้ามไป)
    playerVideo.src = url;
    destroyHls();
    const onReady = () => {
      if (startTime > 0) {
        try { playerVideo.currentTime = startTime; } catch (_) {}
      }
      if (!autoplay) return;
      playerVideo.play().catch(err => {
        if (err.name !== "AbortError") console.error(err);
        if (err.name === "NotSupportedError" && !forceNative) {
          showPlayerNotice("เล่นวิดีโอไม่ได้: รูปแบบสตรีมไม่รองรับ (NotSupportedError)");
        }
      });
    };
    if (startTime > 0) {
      playerVideo.addEventListener("loadedmetadata", onReady, { once: true });
    } else {
      onReady();
    }
  }
}

function seekBySeconds(delta) {
  const duration = Number(playerVideo.duration);
  const current = Number(playerVideo.currentTime) || 0;
  if (Number.isFinite(duration) && duration > 0) {
    playerVideo.currentTime = Math.min(duration, Math.max(0, current + delta));
    return;
  }
  playerVideo.currentTime = Math.max(0, current + delta);
}

function adjustVolumeBy(delta) {
  const next = Math.min(1, Math.max(0, (Number(playerVideo.volume) || 0) + delta));
  playerVideo.volume = next;
  playerVideo.muted = next === 0;
  updateVolumeUI();
}

function handlePlayerKeyboardShortcuts(e) {
  if (e.ctrlKey && e.key === "ArrowRight") {
    const target = resolveAdjacentEpisode(1);
    if (!target) return true;
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
    else playEpisodeFromQueue(target.queueIndex);
    return true;
  }

  if (e.ctrlKey && e.key === "ArrowLeft") {
    const target = resolveAdjacentEpisode(-1);
    if (!target) return true;
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
    else playEpisodeFromQueue(target.queueIndex);
    return true;
  }

  if (e.key === "ArrowRight") {
    seekBySeconds(5);
    showPlayerUI();
    return true;
  }

  if (e.key === "ArrowLeft") {
    seekBySeconds(-5);
    showPlayerUI();
    return true;
  }

  if (e.key === "ArrowUp") {
    adjustVolumeBy(0.05);
    showPlayerUI();
    return true;
  }

  if (e.key === "ArrowDown") {
    adjustVolumeBy(-0.05);
    showPlayerUI();
    return true;
  }

  return false;
}

/* ===== Player Controls ===== */
function togglePlayPause() {
  if (playerVideo.paused) playerVideo.play().catch(() => {});
  else playerVideo.pause();
}

function rewind10()  { playerVideo.currentTime = Math.max(0, playerVideo.currentTime - 10); }
function forward10() { if (playerVideo.duration) playerVideo.currentTime = Math.min(playerVideo.duration, playerVideo.currentTime + 10); }

btnPlayPause.addEventListener("click", togglePlayPause);
btnRewind.addEventListener("click", rewind10);
btnForward.addEventListener("click", forward10);
btnPrevEp.addEventListener("click", () => {
  const target = resolveAdjacentEpisode(-1);
  if (!target) return;
  if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
  else playEpisodeFromQueue(target.queueIndex);
});
btnNextEp.addEventListener("click", () => {
  const target = resolveAdjacentEpisode(1);
  if (!target) return;
  if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
  else playEpisodeFromQueue(target.queueIndex);
});

btnShuffle.addEventListener("click", () => {
  shuffleMode = !shuffleMode;
  btnShuffle.classList.toggle("active", shuffleMode);
  shuffleHistory = shuffleMode ? [currentIndex] : [];
  showPlayerNotice(shuffleMode ? "สุ่มเล่น: เปิด" : "สุ่มเล่น: ปิด", 2000);
  // Update next button state (shuffle always has a next)
  if (shuffleMode && currentStations.length > 1) btnNextEp.disabled = false;
  else btnNextEp.disabled = !resolveAdjacentEpisode(1);
});

playerVideo.addEventListener("play",  () => { btnPlayPause.innerHTML = PLAYER_ICON_PAUSE; showPlayerUI(); });
playerVideo.addEventListener("pause", () => { btnPlayPause.innerHTML = PLAYER_ICON_PLAY; showPlayerUI(); });
playerVideo.addEventListener("error", () => {
  const mediaErr = playerVideo.error;
  if (!mediaErr) {
    showPlayerNotice("เล่นวิดีโอไม่สำเร็จ");
    return;
  }
  const codeMap = {
    1: "การเล่นถูกยกเลิก",
    2: "เกิดปัญหาเครือข่ายขณะโหลดวิดีโอ",
    3: "ข้อมูลวิดีโอเสียหายหรืออ่านไม่ได้",
    4: "ไม่พบวิดีโอหรือรูปแบบไม่รองรับ",
  };
  const label = codeMap[mediaErr.code] || "เล่นวิดีโอไม่สำเร็จ";
  showPlayerNotice(label);
});

playerVideo.addEventListener("timeupdate", () => {
  if (!playerVideo.duration) return;
  const pct = (playerVideo.currentTime / playerVideo.duration) * 100;
  playerSeek.value = pct;
  playerSeek.style.background = `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,.3) ${pct}%)`;
  playerTime.textContent = `${formatTime(playerVideo.currentTime)} / ${formatTime(playerVideo.duration)}`;
});

playerSeek.addEventListener("input", () => {
  if (playerVideo.duration) {
    playerVideo.currentTime = (playerSeek.value / 100) * playerVideo.duration;
  }
});

// ===== Seek Preview (VTT sprite thumbnails — AV only) =====
let seekPreviewCues = null;    // [{start, end, url, x, y, w, h}] หรือ null
let seekPreviewSpriteUrl = ""; // URL ของ sprite image
let seekPreviewLoading = false;

/** แปลง VTT timestamp "HH:MM:SS.mmm" เป็น seconds */
function parseVttTime(str) {
  const parts = str.split(":");
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return +parts[0] * 60 + parseFloat(parts[1]);
  return parseFloat(str);
}

/** Parse VTT text → array of cues with sprite coordinates */
function parseVttThumbnails(vttText, baseUrl) {
  const cues = [];
  // Split by double-newline (cue blocks)
  const blocks = vttText.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    // Find timestamp line: "00:00:00.000 --> 00:05:00.000"
    const tsLine = lines.find(l => l.includes("-->"));
    if (!tsLine) continue;
    const [startStr, endStr] = tsLine.split("-->").map(s => s.trim());
    const start = parseVttTime(startStr);
    const end = parseVttTime(endStr);
    // Find image line: "preview.jpg#xywh=0,0,160,90" or full URL
    const imgLine = lines.find(l => l.includes("#xywh=") || /\.(jpg|jpeg|png|webp)/i.test(l));
    if (!imgLine) continue;
    const [imgPath, fragment] = imgLine.trim().split("#xywh=");
    const url = imgPath.startsWith("http") ? imgPath : baseUrl + imgPath;
    let x = 0, y = 0, w = 160, h = 90;
    if (fragment) {
      const coords = fragment.split(",").map(Number);
      if (coords.length >= 4) { x = coords[0]; y = coords[1]; w = coords[2]; h = coords[3]; }
    }
    cues.push({ start, end, url, x, y, w, h });
  }
  return cues;
}

/** Derive preview VTT/sprite URLs จาก stream URL (AV wowstream pattern) */
function getPreviewUrls(streamUrl) {
  if (!streamUrl) return null;
  const match = streamUrl.match(/^(https?:\/\/.+\/)video\.m3u8/);
  if (!match) return null;
  const base = match[1];
  return { vtt: base + "preview.vtt", sprite: base + "preview.jpg", base };
}

/** โหลด VTT ของ episode ปัจจุบัน (AV เท่านั้น) */
function loadSeekPreview() {
  seekPreviewCues = null;
  seekPreviewSpriteUrl = "";
  if (!isAvMode) return;
  const station = currentStations?.[currentIndex];
  if (!station) return;
  const urls = getPreviewUrls(station.url);
  if (!urls) return;

  seekPreviewLoading = true;
  fetch(urls.vtt)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(text => {
      seekPreviewCues = parseVttThumbnails(text, urls.base);
      seekPreviewSpriteUrl = urls.sprite;
      // Preload sprite image
      if (seekPreviewCues.length > 0) {
        const img = new Image();
        img.src = seekPreviewSpriteUrl;
      }
    })
    .catch(() => { /* no preview available — fail silently */ })
    .finally(() => { seekPreviewLoading = false; });
}

/** หา cue ที่ตรงกับ time */
function findPreviewCue(time) {
  if (!seekPreviewCues) return null;
  return seekPreviewCues.find(c => time >= c.start && time < c.end) || null;
}

const progressRow = document.getElementById("player-progress-row");

progressRow.addEventListener("mousemove", (e) => {
  if (!playerVideo.duration || !seekPreviewCues || seekPreviewCues.length === 0) return;
  const rect = playerSeek.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const pct = x / rect.width;
  const time = pct * playerVideo.duration;

  const cue = findPreviewCue(time);
  if (!cue) { seekPreview.classList.add("hidden"); return; }

  // Position tooltip
  const previewW = 160;
  const rowRect = progressRow.getBoundingClientRect();
  let left = e.clientX - rowRect.left;
  left = Math.max(previewW / 2 + 4, Math.min(left, rowRect.width - previewW / 2 - 4));
  seekPreview.style.left = left + "px";
  seekPreviewTime.textContent = formatTime(time);

  // Show sprite tile at native pixel coordinates
  seekPreviewThumb.style.width = cue.w + "px";
  seekPreviewThumb.style.height = cue.h + "px";
  seekPreviewThumb.style.backgroundImage = `url(${cue.url})`;
  seekPreviewThumb.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;

  seekPreview.classList.remove("hidden");
});

progressRow.addEventListener("mouseleave", () => {
  seekPreview.classList.add("hidden");
});

// Episode picker
const TRACK_LABEL_RE = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i;

function getEpPanelLabel() {
  if (isAvMode) return "เลือกเรื่อง";
  // Movie: stations are track labels (พากย์ไทย/ซับไทย)
  const hasTrackLabels = currentStations?.some(s => TRACK_LABEL_RE.test(s.name));
  if (hasTrackLabels) return "เลือกแทร็กเสียง";
  return "เลือกตอน";
}

btnEpisodes.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = !epPanel.classList.contains("hidden");
  if (isOpen) {
    epPanel.classList.add("hidden");
    btnEpisodes.focus({ preventScroll: true });
    return;
  }
  epPanelTitle.textContent = getEpPanelLabel();
  renderEpPanel();
  epPanel.classList.remove("hidden");
  showPlayerUI();
  queueFocusRefresh();
});

epPanelClose.addEventListener("click", () => {
  epPanel.classList.add("hidden");
  btnEpisodes.focus({ preventScroll: true });
});

// Keep interactions inside panel from bubbling to overlay close handler.
epPanel.addEventListener("click", (e) => {
  e.stopPropagation();
});

function renderEpPanel() {
  const seasonTabs = crossSeasonSeasons.filter((season) => Array.isArray(season.stations) && season.stations.length > 0);
  if (epPanelTabs && seasonTabs.length > 1) {
    const hasSelectedSeason = seasonTabs.some((season) => season.title === epPanelSeasonFilter);
    if (!hasSelectedSeason) epPanelSeasonFilter = currentSeasonTitle || seasonTabs[0].title;

    epPanelTabs.innerHTML = seasonTabs.map((season) => {
      const activeClass = season.title === epPanelSeasonFilter ? " active" : "";
      return `<button class="ep-season-tab${activeClass}" data-season="${esc(season.title)}">${esc(season.title)}</button>`;
    }).join("");
    epPanelTabs.classList.remove("hidden");

    epPanelTabs.querySelectorAll(".ep-season-tab").forEach((btn, idx) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        epPanelSeasonFilter = seasonTabs[idx].title;
        renderEpPanel();
      });
    });
  } else if (epPanelTabs) {
    epPanelTabs.classList.add("hidden");
    epPanelTabs.innerHTML = "";
  }

  const selectedSeason = seasonTabs.find((season) => season.title === epPanelSeasonFilter);
  const panelStations = selectedSeason?.stations || currentStations;
  const panelReferer = selectedSeason?.referer ?? inheritedRefererCache;

  epPanelGrid.innerHTML = "";
  panelStations.forEach((station, i) => {
    const card = document.createElement("div");
    const isActive = panelStations === currentStations && i === currentIndex;
    card.className = "ep-card" + (isActive ? " active" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "button");

    const thumbEl = station.image
      ? `<img class="ep-card-thumb" src="${esc(station.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=ep-card-thumb-ph>▶</div>'">`
      : `<div class="ep-card-thumb-ph">▶</div>`;

    const isTrack = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i.test(station.name);
    const actresses = station.meta?.actresses;
    const actressStr = Array.isArray(actresses) ? actresses.join(", ") : (typeof actresses === "string" ? actresses : "");
    let label;
    if (actressStr) {
      // AV: show name as main, actresses as sub
      label = { ep: station.name || `Ep. ${i + 1}`, title: actressStr };
    } else if (isTrack && playerSectionTitle) {
      label = { ep: playerSectionTitle, title: station.name };
    } else if (isAvMode) {
      // AV without actress data: show station name directly
      label = { ep: station.name || `Ep. ${i + 1}`, title: "" };
    } else {
      label = splitEpisodeLabel(station.name, i + 1);
    }
    const playingBadge = isActive ? `<span class="ep-card-playing">กำลังเล่น</span>` : "";

    const titleEl = label.title ? `<div class="ep-card-title">${esc(label.title)}</div>` : "";
    card.innerHTML = `<div class="ep-card-media">${thumbEl}${playingBadge}</div><div class="ep-card-content"><div class="ep-card-label"><div class="ep-card-epno">${esc(label.ep)}</div>${titleEl}</div></div>`;

    card.addEventListener("click", () => {
      currentStations = panelStations;
      playEpisode(i, panelReferer);
      renderEpPanel();  // refresh active state
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        card.click();
      }
    });

    epPanelGrid.appendChild(card);
  });

  // scroll active card into view
  setTimeout(() => {
    epPanelGrid.querySelector(".ep-card.active")?.scrollIntoView({ block: "nearest" });
  }, 50);
}

// Close panel when clicking outside
playerOverlay.addEventListener("click", (e) => {
  if (!epPanel.contains(e.target) && e.target !== btnEpisodes) {
    if (!epPanel.classList.contains("hidden")) {
      epPanel.classList.add("hidden");
      btnEpisodes.focus({ preventScroll: true });
    }
  }
});

// Mute toggle
btnMute.addEventListener("click", () => {
  playerVideo.muted = !playerVideo.muted;
  updateVolumeUI();
});

// Volume slider
volumeSlider.addEventListener("input", () => {
  playerVideo.volume = volumeSlider.value;
  playerVideo.muted = playerVideo.volume === 0;
  updateVolumeUI();
});

const VOL_ICONS = {
  low: `<i class="fi fi-rr-volume-down" aria-hidden="true"></i>`,
  high: `<i class="fi fi-rr-volume" aria-hidden="true"></i>`,
  mute: `<i class="fi fi-rr-volume-mute" aria-hidden="true"></i>`,
};

function updateVolumeUI() {
  const v = playerVideo.volume;
  volumeSlider.value = v;
  const pct = v * 100;
  volumeSlider.style.background = `linear-gradient(to right, rgba(255,255,255,.9) ${pct}%, rgba(255,255,255,.3) ${pct}%)`;
  btnMute.innerHTML = playerVideo.muted || v === 0 ? VOL_ICONS.mute : v < 0.5 ? VOL_ICONS.low : VOL_ICONS.high;
}

// AirPlay / Remote Playback
//
// ปัญหาที่แก้ที่นี่: HLS.js ต่อวิดีโอผ่าน Media Source Extensions (MSE) โดยทำให้
// playerVideo.src = blob: URL ชี้ไปที่ MediaSource. blob: URL serialize ข้ามเครือข่าย
// ไปหา Apple TV / cast receiver ไม่ได้ → AirPlay เลย mirror ได้แค่ audio stream
// จากระบบเสียง ส่วนภาพค้างดำ (อาการที่ user เจอ)
//
// วิธีแก้: ก่อนเปิด picker ให้ tear down HLS.js แล้วตั้ง playerVideo.src = ไฟล์ m3u8
// ตรงๆ (native source) — Apple TV decode HLS ได้เอง เลยเล่นได้ทั้งภาพและเสียง.
// พอ disconnect ก็สลับกลับมาใช้ HLS.js สำหรับเล่น local ต่อ (เพราะ Chrome desktop
// เล่น native HLS ไม่ได้แน่นอนเนื่องจาก canPlayType="maybe" แต่จริงๆ ไม่รองรับ)
(function initAirPlay() {
  // Safari WebKit ใช้ native HLS อยู่แล้ว (setupVideoSource มี gate) →
  // ไม่ต้อง swap source ก่อน/หลัง cast. video element ต่อ stream เดิมตลอด
  // AirPlay session จึงเสถียร แม้เปลี่ยนตอน/เรื่องระหว่าง cast
  const isSafariWebKit = typeof playerVideo.webkitShowPlaybackTargetPicker === "function";

  // Helper: ยิงก่อนกด picker — สลับไปใช้ native source (เฉพาะ Chrome/Edge/Firefox)
  function prepareForCast() {
    if (isSafariWebKit) return true;   // Safari: ไม่ต้องทำอะไร source เป็น native อยู่แล้ว
    const station = currentStations[currentIndex];
    if (!station) return false;
    const savedTime  = playerVideo.currentTime || 0;
    const wasPlaying = !playerVideo.paused;
    setupVideoSource(station.url, inheritedRefererCache, {
      forceNative: true,
      startTime:   savedTime,
      autoplay:    wasPlaying,
    });
    return true;
  }

  // Helper: สลับกลับไปใช้ HLS.js สำหรับเล่น local หลัง disconnect (Chrome path)
  function restoreLocalPlayback() {
    if (isSafariWebKit) return;        // Safari: stream ต่อเนื่องเอง ไม่ต้อง swap
    const station = currentStations[currentIndex];
    if (!station) return;
    const savedTime  = playerVideo.currentTime || 0;
    const wasPlaying = !playerVideo.paused;
    setupVideoSource(station.url, inheritedRefererCache, {
      forceNative: false,
      startTime:   savedTime,
      autoplay:    wasPlaying,
    });
  }

  // WebKit AirPlay API — Safari on macOS / iOS → Apple TV, AirPlay speakers
  if (typeof playerVideo.webkitShowPlaybackTargetPicker === "function") {
    playerVideo.addEventListener("webkitplaybacktargetavailabilitychanged", (e) => {
      btnAirPlay.hidden = e.availability !== "available";
    });
    playerVideo.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
      const casting = !!playerVideo.webkitCurrentPlaybackTargetIsWireless;
      btnAirPlay.classList.toggle("casting", casting);
      btnAirPlay.title = casting
        ? "กำลัง Cast อยู่ — คลิกเพื่อหยุด"
        : "AirPlay / Cast to TV";
      // Disconnect → สลับกลับไป HLS.js เพื่อเล่น local ต่อ
      if (!casting) restoreLocalPlayback();
    });
    btnAirPlay.addEventListener("click", () => {
      // Safari: prepareForCast() เป็น no-op (native HLS อยู่แล้ว) → เปิด picker ตรงๆ
      try { playerVideo.webkitShowPlaybackTargetPicker(); } catch (e) { console.warn(e); }
    });
  }
  // W3C Remote Playback API — Chrome (รองรับ AirPlay บน macOS ผ่าน system picker)
  else if (playerVideo.remote) {
    playerVideo.remote.watchAvailability((available) => {
      btnAirPlay.hidden = !available;
    }).catch(() => {
      btnAirPlay.hidden = false;
    });
    playerVideo.remote.addEventListener("connecting", () => {
      btnAirPlay.classList.add("casting");
      btnAirPlay.title = "กำลังเชื่อมต่อ...";
    });
    playerVideo.remote.addEventListener("connect", () => {
      btnAirPlay.classList.add("casting");
      btnAirPlay.title = "กำลัง Cast อยู่ — คลิกเพื่อหยุด";
    });
    playerVideo.remote.addEventListener("disconnect", () => {
      btnAirPlay.classList.remove("casting");
      btnAirPlay.title = "AirPlay / Cast to TV";
      restoreLocalPlayback();
    });
    btnAirPlay.addEventListener("click", () => {
      prepareForCast();
      setTimeout(() => {
        playerVideo.remote.prompt().catch((err) => {
          // ผู้ใช้กดยกเลิก picker → สลับกลับไป HLS.js เพราะ Chrome desktop
          // ไม่สามารถเล่น native HLS ได้ (canPlayType lies) — ถ้าไม่ swap กลับ
          // local playback จะค้าง
          if (err && err.name !== "NotAllowedError") console.warn(err);
          restoreLocalPlayback();
        });
      }, 50);
    });
  }
})();

// Fullscreen
btnFullscreen.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    playerOverlay.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

/* ===== Picture-in-Picture ===== */
// Prefer Document PiP (resizable, with controls) → fallback to Video PiP
const hasDocPip = typeof documentPictureInPicture !== "undefined";
const hasVideoPip = typeof playerVideo.requestPictureInPicture === "function";
if (hasDocPip || hasVideoPip) btnPip.hidden = false;

let docPipWindow = null;

async function togglePip() {
  // If already in Document PiP → close it
  if (docPipWindow) {
    docPipWindow.close();
    docPipWindow = null;
    btnPip.classList.remove("active");
    return;
  }
  // If already in Video PiP → exit
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    btnPip.classList.remove("active");
    return;
  }

  // Try Document PiP first (resizable, custom controls)
  if (hasDocPip) {
    try {
      docPipWindow = await documentPictureInPicture.requestWindow({
        width: 480,
        height: 270,
      });

      // Copy stylesheets for controls styling
      const pipDoc = docPipWindow.document;
      pipDoc.documentElement.style.cssText = "margin:0;padding:0;background:#000;overflow:hidden;height:100%";
      pipDoc.body.style.cssText = "margin:0;padding:0;background:#000;display:flex;align-items:center;justify-content:center;height:100%;position:relative";

      // Move video to PiP window
      const wrapper = pipDoc.createElement("div");
      wrapper.style.cssText = "width:100%;height:100%;position:relative;display:flex;align-items:center;justify-content:center;background:#000";

      // Style the video in PiP
      playerVideo.style.cssText = "width:100%;height:100%;object-fit:contain";
      wrapper.appendChild(playerVideo);

      // Simple overlay controls
      const controls = pipDoc.createElement("div");
      controls.style.cssText = "position:absolute;bottom:0;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:16px;padding:12px;background:linear-gradient(transparent,rgba(0,0,0,.8));opacity:0;transition:opacity .2s";
      wrapper.addEventListener("mouseenter", () => controls.style.opacity = "1");
      wrapper.addEventListener("mouseleave", () => controls.style.opacity = "0");

      const makeBtn = (label, onClick) => {
        const b = pipDoc.createElement("button");
        b.textContent = label;
        b.style.cssText = "background:rgba(255,255,255,.15);border:none;color:#fff;font-size:16px;cursor:pointer;padding:6px 10px;border-radius:6px";
        b.addEventListener("click", onClick);
        return b;
      };

      controls.appendChild(makeBtn("⏮", () => {
        const t = resolveAdjacentEpisode(-1);
        if (t?.type === "local") playEpisode(t.index, inheritedRefererCache);
        else if (t) playEpisodeFromQueue(t.queueIndex);
      }));
      controls.appendChild(makeBtn("⏪", rewind10));
      const playPauseBtn = makeBtn(playerVideo.paused ? "▶" : "⏸", () => togglePlayPause());
      controls.appendChild(playPauseBtn);
      playerVideo.addEventListener("play",  () => playPauseBtn.textContent = "⏸");
      playerVideo.addEventListener("pause", () => playPauseBtn.textContent = "▶");
      controls.appendChild(makeBtn("⏩", forward10));
      controls.appendChild(makeBtn("⏭", () => {
        const t = resolveAdjacentEpisode(1);
        if (t?.type === "local") playEpisode(t.index, inheritedRefererCache);
        else if (t) playEpisodeFromQueue(t.queueIndex);
      }));

      wrapper.appendChild(controls);
      pipDoc.body.appendChild(wrapper);

      btnPip.classList.add("active");

      // When PiP window closes → move video back
      docPipWindow.addEventListener("pagehide", () => {
        playerVideo.style.cssText = "";
        const notice = document.getElementById("player-notice");
        playerOverlay.insertBefore(playerVideo, notice);
        docPipWindow = null;
        btnPip.classList.remove("active");
      });
      return;
    } catch (e) {
      console.warn("Document PiP failed, trying video PiP:", e);
    }
  }

  // Fallback: standard Video PiP
  if (hasVideoPip) {
    try {
      await playerVideo.requestPictureInPicture();
      btnPip.classList.add("active");
    } catch (e) {
      showPlayerNotice("PiP ไม่รองรับในเบราว์เซอร์นี้", 3000);
    }
  }
}

btnPip.addEventListener("click", togglePip);

// Track video PiP state changes (for standard PiP fallback)
playerVideo.addEventListener("enterpictureinpicture", () => btnPip.classList.add("active"));
playerVideo.addEventListener("leavepictureinpicture", () => btnPip.classList.remove("active"));

/* ===== Auto-hide UI ===== */
let idleTimer = null;

function showPlayerUI() {
  playerOverlay.classList.add("show-ui");
  clearTimeout(idleTimer);
  if (!playerVideo.paused) {
    idleTimer = setTimeout(() => {
      playerOverlay.classList.remove("show-ui");
      epPanel.classList.add("hidden");
    }, 3000);
  }
}

playerOverlay.addEventListener("mousemove", showPlayerUI);
playerOverlay.addEventListener("touchstart", showPlayerUI, { passive: true });

// Swipe left/right บน player → real-time scrub (max 90s per full-width swipe)
let _swipeStart = null;   // { x, y, time }
let _swipeHandled = false;
let _swipeWasPlaying = false;

playerOverlay.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  _swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: playerVideo.currentTime };
  _swipeHandled = false;
}, { passive: true });

playerOverlay.addEventListener("touchmove", (e) => {
  if (!_swipeStart || e.touches.length !== 1) return;
  const dx = e.touches[0].clientX - _swipeStart.x;
  const dy = e.touches[0].clientY - _swipeStart.y;

  if (!_swipeHandled) {
    if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    _swipeHandled = true;
    _swipeWasPlaying = !playerVideo.paused;
    if (_swipeWasPlaying) playerVideo.pause();
  }

  e.preventDefault();
  const secs = dx / window.innerWidth * 90;
  playerVideo.currentTime = Math.max(0, Math.min(playerVideo.duration || 0, _swipeStart.time + secs));
}, { passive: false });

playerOverlay.addEventListener("touchend", () => {
  _swipeStart = null;
  if (!_swipeHandled) return;
  if (_swipeWasPlaying) playerVideo.play();
}, { passive: true });

// Click on video toggles play/pause (ยกเว้นหลัง swipe)
playerVideo.addEventListener("click", () => {
  if (_swipeHandled) { _swipeHandled = false; return; }
  togglePlayPause();
});

function resetProgress() {
  playerSeek.value = 0;
  playerSeek.style.background = `linear-gradient(to right, var(--accent) 0%, rgba(255,255,255,.3) 0%)`;
  playerTime.textContent = "0:00 / 0:00";
}

function formatTime(secs) {
  if (!isFinite(secs)) return "0:00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function splitEpisodeLabel(name, index) {
  const fallbackEp = `Ep. ${index}`;
  if (!name) return { ep: fallbackEp, title: "" };

  const trimmed = String(name).trim();
  const normalized = trimmed
    .replace(/\s+/g, " ")
    .replace(/[‐‑‒–—−]/g, "-")
    .trim();
  const enMatch = normalized.match(/^(?:ep|episode)\.?\s*(\d+)(?:\s*[-:]\s*(.+)|\s+(.+))?$/i);
  if (enMatch) {
    const ep = `Ep. ${enMatch[1]}`;
    const title = (enMatch[2] || enMatch[3] || "").trim();
    return { ep, title };
  }

  const thMatch = normalized.match(/^(?:ตอนที่|ตอน)\s*(\d+)(?:\s*[-:]\s*(.+)|\s+(.+))?$/u);
  if (thMatch) {
    const ep = `ตอน ${thMatch[1]}`;
    let title = (thMatch[2] || thMatch[3] || "").trim();
    if (!title) {
      title = normalized
        .replace(/^(?:ตอนที่|ตอน)\s*\d+\s*/u, "")
        .replace(/^[-:]\s*/, "")
        .trim();
    }
    return { ep, title };
  }

  // Unknown format: keep full label as title.
  const hasThai = /[\u0E00-\u0E7F]/.test(normalized);
  return { ep: hasThai ? `ตอน ${index}` : fallbackEp, title: normalized };
}

function formatSeasonEpisodeMeta(seasonTitle, stationName, fallbackIndex) {
  const label = splitEpisodeLabel(stationName, fallbackIndex);
  const normalizedSeason = String(seasonTitle || "").trim() || "Season";
  return {
    meta: `${normalizedSeason} - ${label.ep}`,
    title: label.title || stationName || "",
  };
}
/* ===== Auto-next (Up Next toast) ===== */
function scheduleNext() {
  const target = resolveAdjacentEpisode(1);
  if (!target || upnextCancelled) {
    closePlayer();
    return;
  }

  const next = target.type === "local"
    ? currentStations[target.index]
    : crossSeasonQueue[target.queueIndex]?.station;
  const nextLabelIndex = target.type === "local"
    ? target.index + 1
    : (crossSeasonQueue[target.queueIndex]?.localIndex ?? 0) + 1;
  const nextSeasonTitle = target.type === "local"
    ? (currentSeasonTitle || "Season")
    : (crossSeasonQueue[target.queueIndex]?.seasonTitle || currentSeasonTitle || "Season");
  if (!next) {
    closePlayer();
    return;
  }

  upnextThumb.src = next.image || "";
  // AV: แสดงชื่อ + นักแสดง แทน season/episode format
  const nextActresses = next.meta?.actresses;
  const nextActressSub = Array.isArray(nextActresses) ? nextActresses.join(", ") : (typeof nextActresses === "string" ? nextActresses : "");
  if (nextActressSub) {
    upnextTitle.innerHTML = `<span class="upnext-title-meta">${esc(next.name || "")}</span><span class="upnext-title-name">${esc(nextActressSub)}</span>`;
  } else {
    const upnextLabel = formatSeasonEpisodeMeta(nextSeasonTitle, next.name, nextLabelIndex);
    upnextTitle.innerHTML = `<span class="upnext-title-meta">${esc(upnextLabel.meta)}</span><span class="upnext-title-name">${esc(upnextLabel.title || `ตอนที่ ${nextLabelIndex}`)}</span>`;
  }
  upnextToast.classList.remove("hidden");

  let secs = 5;
  upnextCountEl.textContent = secs;
  upnextBar.style.transition = "none";
  upnextBar.style.transform = "scaleX(1)";

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      upnextBar.style.transition = `transform ${secs}s linear`;
      upnextBar.style.transform = "scaleX(0)";
    });
  });

  upnextCountdown = setInterval(() => {
    secs--;
    upnextCountEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(upnextCountdown);
      upnextToast.classList.add("hidden");
      if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
      else playEpisodeFromQueue(target.queueIndex);
    }
  }, 1000);

  upnextPlayBtn.onclick = () => {
    cancelUpnext();
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);
    else playEpisodeFromQueue(target.queueIndex);
  };
  upnextCancelBtn.onclick = () => { upnextCancelled = true; cancelUpnext(); };
}

function cancelUpnext() {
  clearInterval(upnextCountdown);
  upnextToast.classList.add("hidden");
}

function closePlayer() {
  cancelUpnext();
  // Close PiP if open
  if (docPipWindow) { docPipWindow.close(); docPipWindow = null; }
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  btnPip.classList.remove("active");
  destroyHls();
  hidePlayerNotice();
  playerVideo.pause();
  playerVideo.src = "";
  playerVideo.onended = null;
  playerOverlay.classList.add("hidden");
  playerOverlay.classList.remove("show-ui");
  clearTimeout(idleTimer);
  document.body.style.overflow = "";
  crossSeasonQueue = [];
  crossSeasonIndex = -1;
  crossSeasonSeasons = [];
  shuffleHistory = [];
  epPanelSeasonFilter = "";
  seekPreviewCues = null;
  seekPreviewSpriteUrl = "";
  seekPreview.classList.add("hidden");
  currentSeasonTitle = "";
  playerSectionTitle = "";
  queueFocusRefresh();
}

function destroyHls() {
  if (hls) { hls.destroy(); hls = null; }
}

playerBack.addEventListener("click", closePlayer);

/* ===== UI state helpers ===== */
function showLoading() {
  loading.classList.remove("hidden");
  errorView.classList.add("hidden");
  gridView.classList.add("hidden");
}

function showGrid() {
  loading.classList.add("hidden");
  errorView.classList.add("hidden");
  gridView.classList.remove("hidden");
  queueFocusRefresh();
}

function showError(msg) {
  loading.classList.add("hidden");
  gridView.classList.add("hidden");
  errorMsg.textContent = msg;
  errorView.classList.remove("hidden");
}

/* ===== Util ===== */
function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
