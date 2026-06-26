/* AUTO-GENERATED from app.js by tools/build-tv.js — DO NOT EDIT. */
/* แก้ที่ app.js แล้วรัน `npm run build:tv` เพื่อ regenerate ไฟล์นี้ */
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
(function detectFlexGap() {
  const docEl = document.documentElement;
  try {
    const probe = document.createElement("div");
    probe.style.display = "flex";
    probe.style.flexDirection = "column";
    probe.style.rowGap = "1px";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.appendChild(document.createElement("div"));
    probe.appendChild(document.createElement("div"));
    (document.body || docEl).appendChild(probe);
    const supported = probe.scrollHeight === 1;
    probe.parentNode.removeChild(probe);
    docEl.classList.add(supported ? "flex-gap" : "no-flex-gap");
  } catch (e) {
    docEl.classList.add("no-flex-gap");
  }
})();
const pathBeforeWeb = location.pathname.split("/web/")[0] || "";
const SITE_BASE_PATH = pathBeforeWeb === "/" ? "" : pathBeforeWeb;
const RAW_GITHUB_BASE = "https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/";
const IS_LOCAL_DEV = location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.hostname === "192.168.1.101";
const PLAYLIST_URL = IS_LOCAL_DEV ? `${SITE_BASE_PATH}/playlist/main.txt` : `${RAW_GITHUB_BASE}playlist/main.txt`;
const PAGE_SIZE = 24;
const PAGINATION_ICON_PREV = `<i class="fi fi-br-angle-small-left" aria-hidden="true"></i>`;
const PAGINATION_ICON_NEXT = `<i class="fi fi-br-angle-small-right" aria-hidden="true"></i>`;
const PAGINATION_ICON_FIRST = `<i class="fi fi-br-angle-double-small-left" aria-hidden="true"></i>`;
const PAGINATION_ICON_LAST = `<i class="fi fi-br-angle-double-small-right" aria-hidden="true"></i>`;
const PAGINATION_FIRST_LAST_THRESHOLD = 5;
const SECTION_BACK_ICON = `<i class="fi fi-br-arrow-left" aria-hidden="true"></i>`;
const PLAYER_ICON_PLAY = `<i class="fi fi-sr-play" aria-hidden="true"></i>`;
const PLAYER_ICON_PAUSE = `<i class="fi fi-sr-pause" aria-hidden="true"></i>`;
const EPISODES_ICON = `<i class="fi fi-rr-list" aria-hidden="true"></i>`;
const TV_FOCUSABLE_SELECTOR = ["button:not([disabled]):not(.hidden)", "#search-input:not([disabled])", ".card[tabindex='0']", ".ep-card[tabindex='0']", ".search-item[tabindex='0']", ".breadcrumb-item[tabindex='0']", ".logo[tabindex='0']"].join(", ");
const TV_BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack"]);
const TV_BACK_KEYCODES = new Set([8, 27, 10009, 461]);
const KEYCODE_TO_KEY = {
  8: "Backspace",
  13: "Enter",
  27: "Escape",
  32: " ",
  37: "ArrowLeft",
  38: "ArrowUp",
  39: "ArrowRight",
  40: "ArrowDown"
};
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
function eventKey(ev) {
  const k = ev.key;
  if (k && k !== "Unidentified") return k;
  return KEYCODE_TO_KEY[ev.keyCode] || k || "";
}
let navHistory = [];
let currentStations = [];
let currentIndex = 0;
let hls = null;
let upnextCountdown = null;
let upnextCancelled = false;
let shuffleMode = false;
let shuffleHistory = [];
let playEpisodeEpoch = 0;
const STREAM_RESOLVERS = {
  anifume: "https://shy-haze-2452.natajrak-p.workers.dev/resolve/anifume",
  kurokamii: "https://shy-haze-2452.natajrak-p.workers.dev/resolve/kurokamii",
  "anime-hdzero": "https://shy-haze-2452.natajrak-p.workers.dev/resolve/anime-hdzero"
};
function resolveStreamUrl(_x) {
  return _resolveStreamUrl.apply(this, arguments);
}
function _resolveStreamUrl() {
  _resolveStreamUrl = _asyncToGenerator(function* (station) {
    const endpoint = STREAM_RESOLVERS[station.resolver];
    if (!endpoint) throw new Error(`unknown resolver: ${station.resolver}`);
    const url = `${endpoint}?url=${encodeURIComponent(station.url)}`;
    const resp = yield fetch(url, {
      method: "GET"
    });
    if (!resp.ok) throw new Error(`resolver HTTP ${resp.status}`);
    const data = yield resp.json();
    if (!data || !data.stream) throw new Error((data === null || data === void 0 ? void 0 : data.error) || "no stream in resolver response");
    return data.stream;
  });
  return _resolveStreamUrl.apply(this, arguments);
}
let isAvMode = false;
let searchIndex = [];
let searchIndexPromise = null;
let searchIndexRootNode = null;
const searchIndexVisitedUrls = new Set();
const searchIndexEntryKeys = new Set();
let currentPage = 0;
let currentSortOrder = "za";
let currentSortMode = "updated";
let privateUnlocked = false;
const PRIVATE_UNLOCK_SALT = "bkl-play-2026-private-v1";
const PRIVATE_UNLOCK_HASH = "185f94f034c271ba3a165be96f9c54fde01ddfef46f9de140e33102d0ce8fbfe";
function sha256Hex(_x2) {
  return _sha256Hex.apply(this, arguments);
}
function _sha256Hex() {
  _sha256Hex = _asyncToGenerator(function* (text) {
    const buf = new TextEncoder().encode(text);
    const hash = yield crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
  });
  return _sha256Hex.apply(this, arguments);
}
let currentGroups = [];
let currentGroupTitle = "";
let currentGroupParent = null;
let inheritedRefererCache = null;
let crossSeasonQueue = [];
let crossSeasonIndex = -1;
let crossSeasonSeasons = [];
let epPanelSeasonFilter = "";
let currentSeasonTitle = "";
let playerSectionTitle = "";
let playerNoticeTimer = null;
let searchDownLastAt = 0;
let activeSearchIdx = -1;
let preSearchState = null;
let searchReturnState = null;
let lastNode = null;
let lastTitle = "Home";
let lastFetchUrl = null;
let focusRefreshTimer = null;
const loading = document.getElementById("loading");
const errorView = document.getElementById("error-view");
const errorMsg = document.getElementById("error-message");
const gridView = document.getElementById("grid-view");
const breadcrumb = document.getElementById("breadcrumb");
const logo = document.querySelector(".logo");
const playerOverlay = document.getElementById("player-overlay");
const playerVideo = document.getElementById("player-video");
const playerLoading = document.getElementById("player-loading");
const playerBack = document.getElementById("player-back");
const playerTitle = document.getElementById("player-title");
const playerNotice = document.getElementById("player-notice");
const playerSeek = document.getElementById("player-seek");
const playerTime = document.getElementById("player-time");
const seekPreview = document.getElementById("seek-preview");
const seekPreviewThumb = document.getElementById("seek-preview-thumb");
const seekPreviewTime = document.getElementById("seek-preview-time");
const btnPrevEp = document.getElementById("btn-prev-ep");
const btnRewind = document.getElementById("btn-rewind");
const btnPlayPause = document.getElementById("btn-playpause");
const btnForward = document.getElementById("btn-forward");
const btnNextEp = document.getElementById("btn-next-ep");
const btnMute = document.getElementById("btn-mute");
const volumeSlider = document.getElementById("volume-slider");
const btnPip = document.getElementById("btn-pip");
const btnAirPlay = document.getElementById("btn-airplay");
const btnFullscreen = document.getElementById("btn-fullscreen");
const btnEpisodes = document.getElementById("btn-episodes");
const btnShuffle = document.getElementById("btn-shuffle");
const epPanel = document.getElementById("ep-panel");
const epPanelTitle = document.getElementById("ep-panel-title");
const epPanelTabs = document.getElementById("ep-panel-tabs");
const epPanelGrid = document.getElementById("ep-panel-grid");
const epPanelClose = document.getElementById("ep-panel-close");
const upnextToast = document.getElementById("upnext-toast");
const upnextThumb = document.getElementById("upnext-thumb");
const upnextTitle = document.getElementById("upnext-title");
const upnextCountEl = document.getElementById("upnext-countdown");
const upnextBar = document.getElementById("upnext-bar");
const upnextPlayBtn = document.getElementById("upnext-play-now");
const upnextCancelBtn = document.getElementById("upnext-cancel");
const searchInput = document.getElementById("search-input");
const searchClear = document.getElementById("search-clear");
const searchResults = document.getElementById("search-results");
let avActiveGenre = null;
let avActiveActress = null;
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
logo.addEventListener("keydown", e => {
  if (eventKey(e) === "Enter" || eventKey(e) === " ") {
    e.preventDefault();
    logo.click();
  }
});
window.addEventListener("keydown", e => {
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
  const navKey = eventKey(e);
  if (ARROW_KEYS.has(navKey)) {
    e.preventDefault();
    moveTVFocus(navKey);
    return;
  }
  if (eventKey(e) === "Enter") {
    const el = document.activeElement;
    if (isTVFocusable(el)) {
      e.preventDefault();
      el.click();
      return;
    }
  }
  if (eventKey(e) === " " && !playerOverlay.classList.contains("hidden") && document.activeElement === playerVideo) {
    e.preventDefault();
    togglePlayPause();
  }
});
document.addEventListener("click", e => {
  if (!document.getElementById("search-container").contains(e.target)) closeSearch();
});
fetchAndRender(PLAYLIST_URL, "Home");
function fetchAndRender(_x3, _x4) {
  return _fetchAndRender.apply(this, arguments);
}
function _fetchAndRender() {
  _fetchAndRender = _asyncToGenerator(function* (url, title, pushHistory = false, previousNode = null, {
    page = null,
    sort = null
  } = {}) {
    showLoading();
    try {
      const {
        data,
        sourceUrl
      } = yield fetchJSON(url);
      const node = normalizePlaylistNode(data, sourceUrl);
      if (pushHistory && previousNode) {
        navHistory.push({
          node: previousNode,
          title,
          page: currentPage,
          sort: currentSortOrder,
          url: null
        });
      }
      if (!searchIndexRootNode && title === "Home") {
        searchIndexRootNode = node;
        searchIndexPromise = buildSearchIndexRecursive(node, [{
          node,
          title: "Home"
        }]).catch(() => {});
      }
      lastFetchUrl = url;
      renderNode(node, title, {
        page,
        sort
      });
    } catch (err) {
      showError(err.message || "โหลดข้อมูลไม่สำเร็จ");
    }
  });
  return _fetchAndRender.apply(this, arguments);
}
function fetchJSON(_x5) {
  return _fetchJSON.apply(this, arguments);
}
function _fetchJSON() {
  _fetchJSON = _asyncToGenerator(function* (url) {
    const fetchUrl = IS_LOCAL_DEV ? url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now() : url;
    const res = yield fetch(fetchUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = yield res.json();
    return {
      data,
      sourceUrl: res.url || url
    };
  });
  return _fetchJSON.apply(this, arguments);
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
  const cloned = Array.isArray(node) ? [...node] : _objectSpread({}, node);
  if (!Array.isArray(cloned)) {
    if (typeof cloned.image === "string") cloned.image = normalizeUrlByBase(cloned.image, sourceUrl);
    if (typeof cloned.url === "string") cloned.url = normalizeUrlByBase(cloned.url, sourceUrl);
  }
  Object.keys(cloned).forEach(key => {
    const value = cloned[key];
    if (!value) return;
    if (Array.isArray(value)) cloned[key] = value.map(item => normalizePlaylistNode(item, sourceUrl));else if (typeof value === "object") cloned[key] = normalizePlaylistNode(value, sourceUrl);
  });
  return cloned;
}
function pushSearchIndexEntry(group, historyChain) {
  const name = group.name || group.info || "";
  if (!name) return;
  const key = `${name}::${group.url || ""}::${historyChain.map(h => h.title).join(">")}`;
  if (searchIndexEntryKeys.has(key)) return;
  searchIndexEntryKeys.add(key);
  searchIndex.push({
    name,
    image: group.image || null,
    node: group,
    path: historyChain.map(h => h.title),
    historyChain: [...historyChain]
  });
}
function buildSearchIndexRecursive(_x6, _x7) {
  return _buildSearchIndexRecursive.apply(this, arguments);
}
function _buildSearchIndexRecursive() {
  _buildSearchIndexRecursive = _asyncToGenerator(function* (node, historyChain, sourceUrl = null) {
    const groups = (node === null || node === void 0 ? void 0 : node.groups) || [];
    for (const group of groups) {
      var _group$groups;
      if (!privateUnlocked && group.private) continue;
      pushSearchIndexEntry(group, historyChain);
      const nextTitle = group.name || group.info || "...";
      const nextHistory = [...historyChain, {
        node: group,
        title: nextTitle
      }];
      if ((_group$groups = group.groups) !== null && _group$groups !== void 0 && _group$groups.length) {
        yield buildSearchIndexRecursive(group, nextHistory, sourceUrl);
        continue;
      }
      if (group.url && !group.stations) {
        const resolvedUrl = normalizeUrlByBase(group.url, sourceUrl);
        if (!resolvedUrl || searchIndexVisitedUrls.has(resolvedUrl)) continue;
        searchIndexVisitedUrls.add(resolvedUrl);
        try {
          const {
            data,
            sourceUrl: childSourceUrl
          } = yield fetchJSON(resolvedUrl);
          const childNode = normalizePlaylistNode(data, childSourceUrl);
          const loadedHistory = [...historyChain, {
            node: childNode,
            title: nextTitle
          }];
          yield buildSearchIndexRecursive(childNode, loadedHistory, childSourceUrl);
        } catch (_) {}
      }
    }
  });
  return _buildSearchIndexRecursive.apply(this, arguments);
}
searchInput.addEventListener("input", _asyncToGenerator(function* () {
  var _lastNode2;
  const q = searchInput.value.trim();
  activeSearchIdx = -1;
  if (!privateUnlocked && q.length >= 4 && q.length <= 32) {
    const candidate = yield sha256Hex(q + PRIVATE_UNLOCK_SALT);
    if (candidate === PRIVATE_UNLOCK_HASH) {
      privateUnlocked = true;
      searchInput.value = "";
      searchClear.classList.add("hidden");
      closeSearch();
      if (lastNode) renderNode(lastNode, lastTitle);
      if (searchIndexRootNode) {
        buildSearchIndexRecursive(searchIndexRootNode, [{
          node: searchIndexRootNode,
          title: "Home"
        }]).catch(() => {});
      }
      return;
    }
  }
  if (q && !preSearchState) {
    preSearchState = {
      node: lastNode,
      title: lastTitle,
      history: [...navHistory],
      page: currentPage,
      sort: currentSortOrder,
      query: q
    };
  }
  searchClear.classList.toggle("hidden", q.length === 0);
  if (!q) {
    var _lastNode;
    closeSearch();
    if ((_lastNode = lastNode) !== null && _lastNode !== void 0 && _lastNode.browsable && browseAllStations.length) {
      applyAvFilters();
    }
    return;
  }
  if ((_lastNode2 = lastNode) !== null && _lastNode2 !== void 0 && _lastNode2.browsable && browseAllStations.length) {
    closeSearch();
    applyAvFilters();
    return;
  }
  if (searchIndexPromise) {
    yield searchIndexPromise;
  } else if (searchIndexRootNode) {
    searchIndexPromise = buildSearchIndexRecursive(searchIndexRootNode, [{
      node: searchIndexRootNode,
      title: "Home"
    }]).catch(() => {});
    yield searchIndexPromise;
  }
  const results = searchIndex.filter(e => e.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  renderSearchResults(results, q);
}));
searchInput.addEventListener("keydown", e => {
  const items = searchResults.querySelectorAll(".search-item");
  if (eventKey(e) === "ArrowDown") {
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
  } else if (eventKey(e) === "ArrowUp") {
    searchDownLastAt = 0;
    e.preventDefault();
    activeSearchIdx = Math.max(activeSearchIdx - 1, -1);
    updateActiveSearch(items);
  } else if (eventKey(e) === "Enter" && activeSearchIdx >= 0) {
    var _items$activeSearchId;
    searchDownLastAt = 0;
    (_items$activeSearchId = items[activeSearchIdx]) === null || _items$activeSearchId === void 0 || _items$activeSearchId.click();
  } else {
    searchDownLastAt = 0;
  }
});
searchClear.addEventListener("click", () => {
  var _lastNode3;
  searchInput.value = "";
  searchClear.classList.add("hidden");
  closeSearch();
  if ((_lastNode3 = lastNode) !== null && _lastNode3 !== void 0 && _lastNode3.browsable && browseAllStations.length) {
    applyAvFilters();
    return;
  }
  if (preSearchState) {
    navHistory = preSearchState.history;
    renderNode(preSearchState.node, preSearchState.title, {
      page: preSearchState.page,
      sort: preSearchState.sort
    });
    preSearchState = null;
  }
});
function closeAvDropdowns() {
  var _document$getElementB, _document$getElementB2;
  (_document$getElementB = document.getElementById("av-filter-genre-dropdown")) === null || _document$getElementB === void 0 || _document$getElementB.classList.add("hidden");
  (_document$getElementB2 = document.getElementById("av-filter-actress-dropdown")) === null || _document$getElementB2 === void 0 || _document$getElementB2.classList.add("hidden");
}
function resetAvFilters() {
  avActiveGenre = null;
  avActiveActress = null;
}
function buildAvDropdown(dropdownEl, items, onSelect) {
  dropdownEl.innerHTML = `<input type="search" placeholder="ค้นหา..." autocomplete="off" />` + items.map(it => `<div class="av-filter-option" data-value="${esc(it.name)}">${esc(it.name)}<span class="av-filter-count">${it.count}</span></div>`).join("");
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
      var _s$meta, _s$meta2;
      if ((s.name || "").toLowerCase().includes(q)) return true;
      const actresses = (_s$meta = s.meta) === null || _s$meta === void 0 ? void 0 : _s$meta.actresses;
      if (actresses && (Array.isArray(actresses) ? actresses : [actresses]).some(a => a.toLowerCase().includes(q))) return true;
      const genres = (_s$meta2 = s.meta) === null || _s$meta2 === void 0 ? void 0 : _s$meta2.genres;
      if (genres && (Array.isArray(genres) ? genres : [genres]).some(g => g.toLowerCase().includes(q))) return true;
      return false;
    });
  }
  if (avActiveGenre) {
    filtered = filtered.filter(s => {
      var _s$meta3;
      const genres = (_s$meta3 = s.meta) === null || _s$meta3 === void 0 ? void 0 : _s$meta3.genres;
      return genres && (Array.isArray(genres) ? genres : [genres]).some(g => g === avActiveGenre);
    });
  }
  if (avActiveActress) {
    filtered = filtered.filter(s => {
      var _s$meta4;
      const actresses = (_s$meta4 = s.meta) === null || _s$meta4 === void 0 ? void 0 : _s$meta4.actresses;
      return actresses && (Array.isArray(actresses) ? actresses : [actresses]).some(a => a === avActiveActress);
    });
  }
  currentPage = 0;
  renderBrowsableStations(filtered, browseTitle, browseParentNode, {
    isFilter: true
  });
}
function collectAvMeta(field) {
  const countMap = {};
  browseAllStations.forEach(s => {
    var _s$meta5;
    const values = (_s$meta5 = s.meta) === null || _s$meta5 === void 0 ? void 0 : _s$meta5[field];
    if (!values) return;
    (Array.isArray(values) ? values : [values]).forEach(v => {
      countMap[v] = (countMap[v] || 0) + 1;
    });
  });
  return Object.entries(countMap).map(([name, count]) => ({
    name,
    count
  })).sort((a, b) => b.count - a.count);
}
function wireAvFilterButtons() {
  const genreBtn = document.getElementById("av-filter-genre-btn");
  const genreDd = document.getElementById("av-filter-genre-dropdown");
  const actressBtn = document.getElementById("av-filter-actress-btn");
  const actressDd = document.getElementById("av-filter-actress-dropdown");
  const clearBtn = document.getElementById("av-filter-clear");
  if (!genreBtn) return;
  genreBtn.addEventListener("click", e => {
    var _genreDd$querySelecto;
    e.stopPropagation();
    if (avActiveGenre) {
      avActiveGenre = null;
      applyAvFilters();
      return;
    }
    const wasOpen = !genreDd.classList.contains("hidden");
    closeAvDropdowns();
    if (wasOpen) return;
    buildAvDropdown(genreDd, collectAvMeta("genres"), val => {
      avActiveGenre = val;
      applyAvFilters();
    });
    genreDd.classList.remove("hidden");
    (_genreDd$querySelecto = genreDd.querySelector("input")) === null || _genreDd$querySelecto === void 0 || _genreDd$querySelecto.focus();
  });
  actressBtn.addEventListener("click", e => {
    var _actressDd$querySelec;
    e.stopPropagation();
    if (avActiveActress) {
      avActiveActress = null;
      applyAvFilters();
      return;
    }
    const wasOpen = !actressDd.classList.contains("hidden");
    closeAvDropdowns();
    if (wasOpen) return;
    buildAvDropdown(actressDd, collectAvMeta("actresses"), val => {
      avActiveActress = val;
      applyAvFilters();
    });
    actressDd.classList.remove("hidden");
    (_actressDd$querySelec = actressDd.querySelector("input")) === null || _actressDd$querySelec === void 0 || _actressDd$querySelec.focus();
  });
  clearBtn === null || clearBtn === void 0 || clearBtn.addEventListener("click", () => {
    avActiveGenre = null;
    avActiveActress = null;
    applyAvFilters();
  });
}
document.addEventListener("click", e => {
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
      const thumb = r.image ? `<img class="search-thumb" src="${esc(r.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : "";
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
      el.addEventListener("keydown", e => {
        if (eventKey(e) === "Enter" || eventKey(e) === " ") {
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
      query: preSearchState.query || searchInput.value.trim()
    };
  }
  navHistory = [...entry.historyChain];
  closeSearch();
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
  return TV_BACK_KEYS.has(eventKey(e)) || TV_BACK_KEYCODES.has(e.keyCode);
}
function handleTVBack() {
  if (!playerOverlay.classList.contains("hidden")) {
    if (!epPanel.classList.contains("hidden")) {
      epPanel.classList.add("hidden");
      btnEpisodes.focus({
        preventScroll: true
      });
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
  var _el$classList;
  if (!el || !el.isConnected) return false;
  if ((_el$classList = el.classList) !== null && _el$classList !== void 0 && _el$classList.contains("hidden")) return false;
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
  return Array.from(root.querySelectorAll(TV_FOCUSABLE_SELECTOR)).filter(isTVFocusable);
}
function focusTVElement(el) {
  if (!el) return;
  el.focus({
    preventScroll: true
  });
  el.scrollIntoView({
    block: "nearest",
    inline: "nearest"
  });
}
function getFocusZone(el) {
  var _el$classList2, _el$closest, _el$closest2, _el$closest3, _el$closest4;
  if (!el) return "other";
  if ((_el$classList2 = el.classList) !== null && _el$classList2 !== void 0 && _el$classList2.contains("card")) return "card";
  if ((_el$closest = el.closest) !== null && _el$closest !== void 0 && _el$closest.call(el, "#pagination")) return "pagination";
  if ((_el$closest2 = el.closest) !== null && _el$closest2 !== void 0 && _el$closest2.call(el, ".section-header")) return "section";
  if ((_el$closest3 = el.closest) !== null && _el$closest3 !== void 0 && _el$closest3.call(el, "#app-header")) return "header";
  if ((_el$closest4 = el.closest) !== null && _el$closest4 !== void 0 && _el$closest4.call(el, "#search-results")) return "search";
  return "other";
}
function hasDirectionalCandidate(current, candidates, directionKey) {
  const currentRect = current.getBoundingClientRect();
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };
  return candidates.some(el => {
    if (el === current) return false;
    const rect = el.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
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
  const cards = elements.filter(el => getFocusZone(el) === "card");
  const paginations = elements.filter(el => getFocusZone(el) === "pagination");
  const sections = elements.filter(el => getFocusZone(el) === "section");
  const headers = elements.filter(el => getFocusZone(el) === "header");
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
  const currentCenter = {
    x: currentRect.left + currentRect.width / 2,
    y: currentRect.top + currentRect.height / 2
  };
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  scanElements.forEach(el => {
    if (el === current) return;
    const rect = el.getBoundingClientRect();
    const center = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
    const dx = center.x - currentCenter.x;
    const dy = center.y - currentCenter.y;
    let primary = 0;
    let cross = 0;
    if (directionKey === "ArrowRight" && dx > 2) {
      primary = dx;
      cross = Math.abs(dy);
    } else if (directionKey === "ArrowLeft" && dx < -2) {
      primary = -dx;
      cross = Math.abs(dy);
    } else if (directionKey === "ArrowDown" && dy > 2) {
      primary = dy;
      cross = Math.abs(dx);
    } else if (directionKey === "ArrowUp" && dy < -2) {
      primary = -dy;
      cross = Math.abs(dx);
    } else return;
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
    const preferred = !playerOverlay.classList.contains("hidden") ? !epPanel.classList.contains("hidden") ? epPanelGrid.querySelector(".ep-card.active") || epPanelGrid.querySelector(".ep-card") : btnPlayPause : gridView.classList.contains("hidden") ? logo : document.querySelector(".card") || document.querySelector(".section-back-btn") || logo;
    focusTVElement(isTVFocusable(preferred) ? preferred : elements[0]);
  }, 0);
}
function renderNode(node, title, options = {}) {
  var _node$groups, _node$stations, _node$stations2;
  const {
    page = null,
    sort = null
  } = options;
  lastNode = node;
  lastTitle = title;
  updateBreadcrumb(title);
  if ((_node$groups = node.groups) !== null && _node$groups !== void 0 && _node$groups.length) {
    const visibleGroups = privateUnlocked ? node.groups : node.groups.filter(g => !g.private);
    const renderableNode = visibleGroups.length !== node.groups.length ? _objectSpread(_objectSpread({}, node), {}, {
      groups: visibleGroups
    }) : node;
    currentPage = typeof page === "number" ? page : 0;
    currentSortOrder = sort === "az" ? "az" : "za";
    renderGroups(renderableNode.groups, title, renderableNode);
  } else if ((_node$stations = node.stations) !== null && _node$stations !== void 0 && _node$stations.length && node.browsable) {
    currentPage = typeof page === "number" ? page : 0;
    currentSortOrder = sort === "za" ? "za" : "az";
    renderBrowsableStations(node.stations, title, node);
  } else if ((_node$stations2 = node.stations) !== null && _node$stations2 !== void 0 && _node$stations2.length) {
    renderStations(node.stations, node.referer, title);
  } else {
    showError("ไม่พบข้อมูลใน playlist นี้");
    return;
  }
  showGrid();
}
function renderGroups(groups, sectionTitle, parentNode) {
  var _document$getElementB3, _gridView$querySelect, _gridView$querySelect2;
  currentGroups = groups;
  currentGroupTitle = sectionTitle;
  currentGroupParent = parentNode;
  const extractNum = name => {
    const m = String(name || "").match(/\d+/);
    return m ? parseInt(m[0]) : null;
  };
  const allNumeric = groups.every(g => extractNum((g === null || g === void 0 ? void 0 : g.name) || (g === null || g === void 0 ? void 0 : g.info)) !== null);
  const hasBadges = groups.some(g => g.badge);
  const hasAnyDateData = groups.some(g => g && (g.release_date || g.updated_at));
  const effectiveSortMode = hasAnyDateData ? currentSortMode : "alpha";
  const effectiveSortOrder = hasAnyDateData ? currentSortOrder : "az";
  const dateKey = effectiveSortMode === "release" ? "release_date" : effectiveSortMode === "updated" ? "updated_at" : null;
  const dateAvailable = dateKey && groups.some(g => g && g[dateKey]);
  const sortedGroups = [...groups].sort((a, b) => {
    if (dateAvailable) {
      const da = a && a[dateKey] || "";
      const db = b && b[dateKey] || "";
      if (da || db) {
        if (!da) return 1;
        if (!db) return -1;
        const diff = da.localeCompare(db);
        if (diff !== 0) return effectiveSortOrder === "za" ? -diff : diff;
      }
    }
    if (hasBadges) {
      var _extractNum, _extractNum2;
      const ba = (_extractNum = extractNum(a.badge)) !== null && _extractNum !== void 0 ? _extractNum : Infinity;
      const bb = (_extractNum2 = extractNum(b.badge)) !== null && _extractNum2 !== void 0 ? _extractNum2 : Infinity;
      if (ba !== bb) return effectiveSortOrder === "za" ? bb - ba : ba - bb;
    }
    const nameA = String((a === null || a === void 0 ? void 0 : a.name) || (a === null || a === void 0 ? void 0 : a.info) || "").toLowerCase();
    const nameB = String((b === null || b === void 0 ? void 0 : b.name) || (b === null || b === void 0 ? void 0 : b.info) || "").toLowerCase();
    if (allNumeric) {
      const diff = extractNum(nameA) - extractNum(nameB);
      return effectiveSortOrder === "za" ? -diff : diff;
    }
    return effectiveSortOrder === "za" ? nameB.localeCompare(nameA) : nameA.localeCompare(nameB);
  });
  const total = sortedGroups.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageGroups = sortedGroups.slice(start, start + PAGE_SIZE);
  const normalizedSectionTitle = String(sectionTitle || "").trim().toLowerCase();
  const showCountInTitle = normalizedSectionTitle === "the series" || normalizedSectionTitle === "the movies" || normalizedSectionTitle === "movies" || normalizedSectionTitle === "series";
  gridView.innerHTML = `${renderSectionHeader(sectionTitle, {
    withSort: hasAnyDateData,
    sort: effectiveSortOrder,
    sortMode: effectiveSortMode,
    withSortMode: hasAnyDateData,
    count: showCountInTitle ? total : null
  })}
    <div class="card-grid portrait"></div>
    ${renderPaginationNav(currentPage, totalPages)}`;
  const grid = gridView.querySelector(".card-grid");
  (_document$getElementB3 = document.getElementById("section-back")) === null || _document$getElementB3 === void 0 || _document$getElementB3.addEventListener("click", goBackOneStep);
  pageGroups.forEach(group => {
    const sn = group.season_name;
    const displayName = sn !== null && sn !== void 0 && sn.en ? sn.th ? `${sn.en} [${sn.th}]` : sn.en : group.name || group.info || "ไม่มีชื่อ";
    const isTrack = Array.isArray(group.stations) && !group.groups;
    const isSeasonGroup = !isTrack && Array.isArray(group.groups) && group.groups.length > 0 && group.groups.every(t => t && Array.isArray(t.stations));
    let seasonCompletion = null;
    if (isSeasonGroup) {
      const incomplete = group.groups.filter(t => t.status !== "completed").map(t => t.name || "");
      const complete = group.groups.filter(t => t.status === "completed").map(t => t.name || "");
      seasonCompletion = incomplete.length === 0 ? {
        status: "completed"
      } : {
        status: "incomplete",
        incomplete,
        complete
      };
    }
    const card = makeCard({
      name: displayName,
      image: group.image,
      sub: group.author && group.author !== "Bank_" ? group.author : null,
      landscape: false,
      badge: group.badge || (sn !== null && sn !== void 0 && sn.en ? group.name || null : null),
      seasonCount: typeof group.season_count === "number" ? group.season_count : null,
      partCount: typeof group.part_count === "number" ? group.part_count : null,
      completion: group.completion || null,
      seasonCompletion,
      status: isTrack ? group.status === "completed" ? "completed" : "ongoing" : null
    });
    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      const prevNode = {
        groups,
        referer: null
      };
      navHistory.push({
        node: prevNode,
        title: sectionTitle,
        page: currentPage,
        sort: currentSortOrder,
        url: lastFetchUrl || null
      });
      const navTitle = sn !== null && sn !== void 0 && sn.en ? sn.th ? `${sn.en} [${sn.th}]` : sn.en : group.name || "...";
      if (group.url && !group.groups && !group.stations) {
        fetchAndRender(group.url, navTitle);
      } else {
        lastFetchUrl = null;
        renderNode(group, navTitle);
      }
    });
    grid.appendChild(card);
  });
  if (totalPages > 1) {
    const goToPage = targetPage => {
      const clamped = Math.max(0, Math.min(targetPage, totalPages - 1));
      if (clamped === currentPage) return;
      currentPage = clamped;
      renderGroups(currentGroups, currentGroupTitle, currentGroupParent);
      showGrid();
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    };
    wirePaginationButtons(goToPage, totalPages);
  }
  (_gridView$querySelect = gridView.querySelector(".sort-mode-toggle")) === null || _gridView$querySelect === void 0 || _gridView$querySelect.addEventListener("click", () => {
    const modes = ["alpha", "release", "updated"];
    const i = modes.indexOf(currentSortMode);
    currentSortMode = modes[(i + 1) % modes.length];
    currentPage = 0;
    renderGroups(currentGroups, currentGroupTitle, currentGroupParent);
  });
  (_gridView$querySelect2 = gridView.querySelector(".sort-order-toggle")) === null || _gridView$querySelect2 === void 0 || _gridView$querySelect2.addEventListener("click", () => {
    currentSortOrder = currentSortOrder === "az" ? "za" : "az";
    currentPage = 0;
    renderGroups(currentGroups, currentGroupTitle, currentGroupParent);
    showGrid();
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  });
}
function getPaginationItems(totalPages, activePageIdx) {
  const windowSize = 5;
  if (totalPages <= windowSize) return Array.from({
    length: totalPages
  }, (_, i) => i + 1);
  let start = activePageIdx - Math.floor(windowSize / 2);
  start = Math.max(0, Math.min(start, totalPages - windowSize));
  return Array.from({
    length: windowSize
  }, (_, i) => start + i + 1);
}
function renderPaginationNav(currentPage, totalPages) {
  if (totalPages <= 1) return "";
  const pageItems = getPaginationItems(totalPages, currentPage);
  const atFirst = currentPage === 0;
  const atLast = currentPage >= totalPages - 1;
  const showFirstLast = totalPages > PAGINATION_FIRST_LAST_THRESHOLD;
  const firstBtn = showFirstLast ? `<button class="page-btn page-nav" id="page-first" ${atFirst ? "disabled" : ""} aria-label="หน้าแรก">${PAGINATION_ICON_FIRST}</button>` : "";
  const lastBtn = showFirstLast ? `<button class="page-btn page-nav" id="page-last" ${atLast ? "disabled" : ""} aria-label="หน้าสุดท้าย">${PAGINATION_ICON_LAST}</button>` : "";
  const nums = pageItems.map(p => {
    const isActive = p === currentPage + 1;
    return `<button class="page-btn page-number${isActive ? " active" : ""}" data-page="${p - 1}" ${isActive ? 'aria-current="page"' : ""} aria-label="หน้า ${p}">${p}</button>`;
  }).join("");
  return `<nav id="pagination" aria-label="Pagination">
      ${firstBtn}
      <button class="page-btn page-nav" id="page-prev" ${atFirst ? "disabled" : ""} aria-label="หน้าก่อนหน้า">${PAGINATION_ICON_PREV}</button>
      <div id="page-numbers">${nums}</div>
      <button class="page-btn page-nav" id="page-next" ${atLast ? "disabled" : ""} aria-label="หน้าถัดไป">${PAGINATION_ICON_NEXT}</button>
      ${lastBtn}
    </nav>`;
}
function wirePaginationButtons(goToPage, totalPages) {
  var _document$getElementB4, _document$getElementB5, _document$getElementB6, _document$getElementB7;
  (_document$getElementB4 = document.getElementById("page-first")) === null || _document$getElementB4 === void 0 || _document$getElementB4.addEventListener("click", () => goToPage(0));
  (_document$getElementB5 = document.getElementById("page-prev")) === null || _document$getElementB5 === void 0 || _document$getElementB5.addEventListener("click", () => goToPage(currentPage - 1));
  (_document$getElementB6 = document.getElementById("page-next")) === null || _document$getElementB6 === void 0 || _document$getElementB6.addEventListener("click", () => goToPage(currentPage + 1));
  (_document$getElementB7 = document.getElementById("page-last")) === null || _document$getElementB7 === void 0 || _document$getElementB7.addEventListener("click", () => goToPage(totalPages - 1));
  gridView.querySelectorAll(".page-number").forEach(btn => {
    btn.addEventListener("click", () => goToPage(Number(btn.dataset.page)));
  });
}
function renderSectionHeader(title, options = {}) {
  const {
    withSort = false,
    sort = "az",
    count = null,
    withFilter = false,
    sortMode = "alpha",
    withSortMode = false
  } = options;
  const canGoBack = navHistory.length > 0;
  const splitTitle = splitCardTitle(title);
  const titleMain = typeof count === "number" ? `${splitTitle.main} (${count})` : splitTitle.main;
  let sortIcon, sortLabel;
  if (sortMode === "release" || sortMode === "updated" || sortMode === "date") {
    sortIcon = sort === "za" ? `<i class="fi fi-rr-calendar-arrow-up" aria-hidden="true"></i>` : `<i class="fi fi-rr-calendar-arrow-down" aria-hidden="true"></i>`;
    sortLabel = sort === "za" ? "เก่าสุดก่อน" : "ใหม่สุดก่อน";
  } else {
    sortIcon = sort === "za" ? `<i class="fi fi-sr-sort-alpha-up" aria-hidden="true"></i>` : `<i class="fi fi-sr-sort-alpha-down" aria-hidden="true"></i>`;
    sortLabel = sort === "za" ? "เรียง Z ไป A" : "เรียง A ไป Z";
  }
  const sortModeMeta = {
    alpha: {
      icon: "fi-rr-text",
      label: "ชื่อ"
    },
    release: {
      icon: "fi-rr-calendar",
      label: "วันออกอากาศ"
    },
    updated: {
      icon: "fi-rr-time-quarter-past",
      label: "อัปเดตล่าสุด"
    }
  };
  const modeInfo = sortModeMeta[sortMode] || sortModeMeta.alpha;
  const modeBtnHtml = withSortMode ? `<button class="sort-mode-toggle" aria-label="โหมดเรียง: ${modeInfo.label}" title="โหมดเรียง: ${modeInfo.label}"><i class="fi ${modeInfo.icon}" aria-hidden="true"></i></button>` : "";
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
    ${withSort || withFilter ? `<div class="section-header-right">${filterHtml}${modeBtnHtml}${withSort ? `<button class="sort-order-toggle" aria-label="${sortLabel}" title="${sortLabel}">${sortIcon}</button>` : ""}</div>` : ""}
  </div>`;
}
function goBackOneStep() {
  if (searchReturnState) {
    const state = searchReturnState;
    searchReturnState = null;
    preSearchState = null;
    navHistory = state.history;
    renderNode(state.node, state.title, {
      page: state.page,
      sort: state.sort
    });
    searchInput.value = state.query || "";
    searchClear.classList.toggle("hidden", !searchInput.value.trim());
    closeSearch();
    showGrid();
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
    return;
  }
  const prev = navHistory.pop();
  if (!prev) return;
  if (prev.url) {
    fetchAndRender(prev.url, prev.title, false, null, {
      page: prev.page,
      sort: prev.sort
    });
  } else {
    renderNode(prev.node, prev.title, {
      page: prev.page,
      sort: prev.sort
    });
    showGrid();
  }
  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}
function renderStations(stations, referer, sectionTitle) {
  var _document$getElementB8;
  gridView.innerHTML = `${renderSectionHeader(sectionTitle)}
    <div class="card-grid landscape"></div>`;
  const grid = gridView.querySelector(".card-grid");
  (_document$getElementB8 = document.getElementById("section-back")) === null || _document$getElementB8 === void 0 || _document$getElementB8.addEventListener("click", goBackOneStep);
  stations.forEach((station, i) => {
    const card = makeCard({
      name: station.name || `ตอนที่ ${i + 1}`,
      image: station.image,
      sub: null,
      landscape: true
    });
    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      openPlayer(stations, i, referer, sectionTitle);
    });
    grid.appendChild(card);
  });
}
let browseAllStations = [];
let browseFilteredStations = [];
let browseTitle = "";
let browseParentNode = null;
const PREVIEW_BLOB_CACHE = new Map();
const PREVIEW_HOVER_DELAY = 400;
function derivePreviewUrl(coverUrl) {
  if (!coverUrl) return null;
  const m = String(coverUrl).match(/^(https?:\/\/[^/]+)\/img2\/([a-f0-9]+)\/([^/]+)\/cover\.[a-z]+$/i);
  if (!m) return null;
  return `${m[1]}/preview/${m[2]}/${m[3]}/preview.mp4`;
}
function loadPreviewBlobUrl(_x8) {
  return _loadPreviewBlobUrl.apply(this, arguments);
}
function _loadPreviewBlobUrl() {
  _loadPreviewBlobUrl = _asyncToGenerator(function* (previewUrl) {
    if (PREVIEW_BLOB_CACHE.has(previewUrl)) return PREVIEW_BLOB_CACHE.get(previewUrl);
    const res = yield fetch(previewUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = yield res.arrayBuffer();
    const blob = new Blob([buf], {
      type: "video/mp4"
    });
    const url = URL.createObjectURL(blob);
    PREVIEW_BLOB_CACHE.set(previewUrl, url);
    return url;
  });
  return _loadPreviewBlobUrl.apply(this, arguments);
}
function attachHoverPreview(card, coverUrl) {
  const previewUrl = derivePreviewUrl(coverUrl);
  if (!previewUrl) return;
  let timer = null;
  let video = null;
  let token = 0;
  const teardown = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    token++;
    if (video) {
      try {
        video.pause();
      } catch (_unused) {}
      video.remove();
      video = null;
    }
  };
  card.addEventListener("mouseenter", () => {
    if (timer) clearTimeout(timer);
    const myToken = ++token;
    timer = setTimeout(_asyncToGenerator(function* () {
      try {
        const blobUrl = yield loadPreviewBlobUrl(previewUrl);
        if (myToken !== token) return;
        const thumb = card.querySelector("img.card-thumb, .card-thumb-placeholder");
        if (!thumb) return;
        const wrap = thumb.parentElement;
        if (!wrap) return;
        if (getComputedStyle(wrap).position === "static") wrap.style.position = "relative";
        video = document.createElement("video");
        video.className = "card-preview-video";
        video.src = blobUrl;
        video.autoplay = true;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        wrap.appendChild(video);
        video.play().catch(() => {});
      } catch (_unused2) {}
    }), PREVIEW_HOVER_DELAY);
  });
  card.addEventListener("mouseleave", teardown);
}
function renderBrowsableStations(stations, sectionTitle, parentNode, {
  isFilter = false
} = {}) {
  var _document$getElementB9, _gridView$querySelect3;
  if (!isFilter) browseAllStations = stations;
  browseFilteredStations = stations;
  browseTitle = sectionTitle;
  browseParentNode = parentNode;
  const sorted = [...stations].sort((a, b) => {
    var _a$meta, _b$meta;
    const dateA = ((_a$meta = a.meta) === null || _a$meta === void 0 ? void 0 : _a$meta.release_date) || "0000-00-00";
    const dateB = ((_b$meta = b.meta) === null || _b$meta === void 0 ? void 0 : _b$meta.release_date) || "0000-00-00";
    return currentSortOrder === "za" ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });
  const total = sorted.length;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));
  const start = currentPage * PAGE_SIZE;
  const pageStations = sorted.slice(start, start + PAGE_SIZE);
  gridView.innerHTML = `${renderSectionHeader(sectionTitle, {
    withSort: true,
    withFilter: true,
    sortMode: "date",
    sort: currentSortOrder,
    count: total
  })}
    <div class="card-grid landscape"></div>
    ${renderPaginationNav(currentPage, totalPages)}`;
  const grid = gridView.querySelector(".card-grid");
  (_document$getElementB9 = document.getElementById("section-back")) === null || _document$getElementB9 === void 0 || _document$getElementB9.addEventListener("click", goBackOneStep);
  wireAvFilterButtons();
  pageStations.forEach(station => {
    const globalIdx = stations.indexOf(station);
    const meta = station.meta;
    let sub = null;
    if (meta !== null && meta !== void 0 && meta.actresses) {
      sub = Array.isArray(meta.actresses) ? meta.actresses.join(", ") : meta.actresses;
    }
    const badge = station.badge || null;
    const card = makeCard({
      name: station.name || "ไม่มีชื่อ",
      image: station.image,
      sub,
      landscape: true,
      badge
    });
    attachHoverPreview(card, station.image);
    card.addEventListener("click", () => {
      if (searchReturnState) clearSearchReturnState();
      openPlayer(stations, globalIdx, null, sectionTitle, {
        allowShuffle: true
      });
    });
    grid.appendChild(card);
  });
  if (totalPages > 1) {
    const goToPage = p => {
      currentPage = Math.max(0, Math.min(p, totalPages - 1));
      renderBrowsableStations(browseFilteredStations, browseTitle, browseParentNode, {
        isFilter: true
      });
      showGrid();
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    };
    wirePaginationButtons(goToPage, totalPages);
  }
  (_gridView$querySelect3 = gridView.querySelector(".sort-order-toggle")) === null || _gridView$querySelect3 === void 0 || _gridView$querySelect3.addEventListener("click", () => {
    currentSortOrder = currentSortOrder === "az" ? "za" : "az";
    currentPage = 0;
    renderBrowsableStations(browseFilteredStations, browseTitle, browseParentNode, {
      isFilter: true
    });
    showGrid();
    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  });
}
function buildCompletionText(completion, seasonCount) {
  if (!completion) return null;
  if (completion.status === "completed") return "จบแล้ว";
  if (completion.status !== "incomplete") return null;
  const trackQual = completion.track === "th" ? "(th) " : completion.track === "sub" ? "(sub) " : "";
  const sPrefix = seasonCount && seasonCount > 1 && completion.season ? `S${completion.season} ` : "";
  return `${sPrefix}${trackQual}ยังไม่จบ`;
}
function makeCard({
  name,
  image,
  sub,
  landscape,
  badge,
  status,
  seasonCount,
  partCount,
  completion,
  seasonCompletion
}) {
  const card = document.createElement("div");
  card.className = "card";
  card.title = name || "";
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.addEventListener("keydown", e => {
    if (eventKey(e) === "Enter" || eventKey(e) === " ") e.target.click();
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
  const wrapper = document.createElement("div");
  wrapper.className = "card-thumb-wrap";
  wrapper.appendChild(thumb);
  let countBadgeText = null;
  if (typeof seasonCount === "number" && seasonCount > 0) {
    countBadgeText = seasonCount === 1 ? "1 Season" : `${seasonCount} Seasons`;
  } else if (typeof partCount === "number" && partCount > 0) {
    countBadgeText = `${partCount} ภาค`;
  }
  const displayBadge = countBadgeText || badge;
  if (displayBadge) {
    const badgeEl = document.createElement("div");
    badgeEl.className = "card-badge";
    badgeEl.textContent = displayBadge;
    wrapper.appendChild(badgeEl);
  }
  let statusText = null,
    statusKind = null;
  if (completion) {
    statusText = buildCompletionText(completion, seasonCount);
    statusKind = completion.status === "completed" ? "completed" : "ongoing";
  } else if (seasonCompletion) {
    if (seasonCompletion.status === "completed") {
      statusText = "จบแล้ว";
      statusKind = "completed";
    } else {
      const inc = seasonCompletion.incomplete || [];
      const comp = seasonCompletion.complete || [];
      statusText = inc.length === 1 && comp.length >= 1 ? `${inc[0]} ยังไม่จบ` : "ยังไม่จบ";
      statusKind = "ongoing";
    }
  } else if (status === "completed" || status === "ongoing") {
    statusText = status === "completed" ? "จบแล้ว" : "ยังไม่จบ";
    statusKind = status;
  }
  if (statusText) {
    const statusEl = document.createElement("div");
    statusEl.className = `card-status-badge card-status-${statusKind}`;
    statusEl.textContent = statusText;
    wrapper.appendChild(statusEl);
  }
  card.appendChild(wrapper);
  const info = document.createElement("div");
  info.className = "card-info";
  const title = splitCardTitle(name);
  info.innerHTML = `<div class="card-name"><div class="card-name-main">${esc(title.main)}</div>${title.th ? `<div class="card-name-th">${esc(title.th)}</div>` : ""}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ""}`;
  card.appendChild(info);
  return card;
}
function splitCardTitle(name) {
  const raw = String(name || "").trim();
  if (!raw) return {
    main: "",
    th: ""
  };
  const bracketMatch = raw.match(/^(.*?)\s*[\[\(](.+?)[\]\)]\s*$/);
  if (bracketMatch) {
    const main = bracketMatch[1].trim();
    const alt = bracketMatch[2].trim();
    if (main && /[\u0E00-\u0E7F]/.test(alt)) return {
      main,
      th: alt
    };
  }
  return {
    main: raw,
    th: ""
  };
}
function updateBreadcrumb(currentTitle) {
  breadcrumb.innerHTML = "";
  navHistory.forEach((entry, i) => {
    const span = document.createElement("span");
    span.className = "breadcrumb-item";
    span.textContent = splitCardTitle(entry.title).main;
    span.tabIndex = 0;
    span.setAttribute("role", "button");
    span.addEventListener("click", () => {
      navHistory = navHistory.slice(0, i);
      if (entry.url) {
        currentPage = entry.page || 0;
        currentSortOrder = entry.sort || "az";
        fetchAndRender(entry.url, entry.title);
      } else {
        renderNode(entry.node, entry.title, {
          page: entry.page,
          sort: entry.sort
        });
      }
    });
    span.addEventListener("keydown", e => {
      if (eventKey(e) === "Enter" || eventKey(e) === " ") {
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
  const splitCurrent = splitCardTitle(currentTitle);
  current.className = "breadcrumb-item active" + (splitCurrent.th ? " has-subline" : "");
  if (splitCurrent.th) {
    current.innerHTML = `${esc(splitCurrent.main)}<span class="breadcrumb-item-th">${esc(splitCurrent.th)}</span>`;
  } else {
    current.textContent = currentTitle;
  }
  breadcrumb.appendChild(current);
}
function normalizeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[‐‑‒–—−]/g, "-");
}
function buildCrossSeasonQueue(languageTitle, inheritedReferer) {
  var _seriesEntry$node, _seasonEntry$node;
  const seasonEntry = navHistory[navHistory.length - 1];
  const seriesEntry = navHistory[navHistory.length - 2];
  const seasonGroups = seriesEntry === null || seriesEntry === void 0 || (_seriesEntry$node = seriesEntry.node) === null || _seriesEntry$node === void 0 ? void 0 : _seriesEntry$node.groups;
  if (!Array.isArray(seasonGroups) || seasonGroups.length === 0) return {
    queue: [],
    seasons: []
  };
  if (!Array.isArray(seasonEntry === null || seasonEntry === void 0 || (_seasonEntry$node = seasonEntry.node) === null || _seasonEntry$node === void 0 ? void 0 : _seasonEntry$node.groups)) return {
    queue: [],
    seasons: []
  };
  const langKey = normalizeKey(languageTitle);
  const queue = [];
  const seasons = [];
  seasonGroups.forEach(season => {
    var _ref3, _ref4, _matchedLang$referer;
    const langs = Array.isArray(season === null || season === void 0 ? void 0 : season.groups) ? season.groups : [];
    const matchedLang = langs.find(lang => normalizeKey(lang.name || lang.info) === langKey);
    if (!matchedLang || !Array.isArray(matchedLang.stations) || matchedLang.stations.length === 0) return;
    const groupReferer = (_ref3 = (_ref4 = (_matchedLang$referer = matchedLang.referer) !== null && _matchedLang$referer !== void 0 ? _matchedLang$referer : season.referer) !== null && _ref4 !== void 0 ? _ref4 : inheritedReferer) !== null && _ref3 !== void 0 ? _ref3 : null;
    const seasonTitle = season.name || season.info || `Season ${seasons.length + 1}`;
    seasons.push({
      title: seasonTitle,
      stations: matchedLang.stations,
      referer: groupReferer
    });
    matchedLang.stations.forEach((station, localIndex) => {
      var _station$referer;
      queue.push({
        station,
        stations: matchedLang.stations,
        localIndex,
        referer: (_station$referer = station.referer) !== null && _station$referer !== void 0 ? _station$referer : groupReferer,
        seasonTitle
      });
    });
  });
  return {
    queue,
    seasons
  };
}
function resolveAdjacentEpisode(step) {
  if (shuffleMode && step > 0 && currentStations.length > 1) {
    const unplayed = [];
    for (let i = 0; i < currentStations.length; i++) {
      if (!shuffleHistory.includes(i)) unplayed.push(i);
    }
    if (unplayed.length === 0) {
      shuffleHistory = [currentIndex];
      for (let i = 0; i < currentStations.length; i++) {
        if (i !== currentIndex) unplayed.push(i);
      }
    }
    if (unplayed.length > 0) {
      const pick = unplayed[Math.floor(Math.random() * unplayed.length)];
      return {
        type: "local",
        index: pick
      };
    }
  }
  const localIndex = currentIndex + step;
  if (localIndex >= 0 && localIndex < currentStations.length) {
    return {
      type: "local",
      index: localIndex
    };
  }
  if (crossSeasonIndex >= 0) {
    const queueIndex = crossSeasonIndex + step;
    if (queueIndex >= 0 && queueIndex < crossSeasonQueue.length) {
      return {
        type: "queue",
        queueIndex
      };
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
function openPlayer(stations, index, inheritedReferer, languageTitle = "", {
  allowShuffle = false
} = {}) {
  var _navHistory, _crossSeasonSeasons$;
  currentStations = stations;
  currentIndex = index;
  upnextCancelled = false;
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
  crossSeasonIndex = crossSeasonQueue.findIndex(item => item.stations === stations && item.localIndex === index);
  currentSeasonTitle = ((_navHistory = navHistory[navHistory.length - 1]) === null || _navHistory === void 0 ? void 0 : _navHistory.title) || "";
  if (crossSeasonIndex >= 0) {
    currentSeasonTitle = crossSeasonQueue[crossSeasonIndex].seasonTitle || currentSeasonTitle;
  }
  epPanelSeasonFilter = currentSeasonTitle || ((_crossSeasonSeasons$ = crossSeasonSeasons[0]) === null || _crossSeasonSeasons$ === void 0 ? void 0 : _crossSeasonSeasons$.title) || "";
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
  var _ref5, _station$referer2, _station$meta;
  const station = currentStations[index];
  if (!station) {
    closePlayer();
    return;
  }
  currentIndex = index;
  if (shuffleMode && !shuffleHistory.includes(index)) shuffleHistory.push(index);
  const referer = (_ref5 = (_station$referer2 = station.referer) !== null && _station$referer2 !== void 0 ? _station$referer2 : inheritedReferer) !== null && _ref5 !== void 0 ? _ref5 : null;
  inheritedRefererCache = referer;
  const url = station.url;
  const matchedQueueIdx = crossSeasonQueue.findIndex(item => item.stations === currentStations && item.localIndex === index);
  if (matchedQueueIdx >= 0) {
    crossSeasonIndex = matchedQueueIdx;
    currentSeasonTitle = crossSeasonQueue[matchedQueueIdx].seasonTitle || currentSeasonTitle;
    epPanelSeasonFilter = currentSeasonTitle || epPanelSeasonFilter;
  }
  const episodeTitle = station.name || `ตอนที่ ${index + 1}`;
  const isTrackLabel = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i.test(episodeTitle);
  const actresses = (_station$meta = station.meta) === null || _station$meta === void 0 ? void 0 : _station$meta.actresses;
  const actressSub = Array.isArray(actresses) ? actresses.join(", ") : typeof actresses === "string" ? actresses : "";
  let displayMain, displaySub;
  if (actressSub) {
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
  showPlayerLoading();
  loadSeekPreview();
  const epochAtPlay = ++playEpisodeEpoch;
  const playerOpts = {
    forceNative: isCurrentlyCasting()
  };
  if (station.resolver) {
    resolveStreamUrl(station).then(resolvedUrl => {
      if (epochAtPlay !== playEpisodeEpoch) return;
      setupVideoSource(resolvedUrl, referer, playerOpts);
    }).catch(err => {
      if (epochAtPlay !== playEpisodeEpoch) return;
      console.error("[player] resolver error:", err);
      hidePlayerLoading();
      showPlayerNotice(`โหลดสตรีมไม่สำเร็จ: ${err.message || err}`);
    });
  } else {
    setupVideoSource(url, referer, playerOpts);
  }
  playerVideo.onended = () => scheduleNext();
}
function isCurrentlyCasting() {
  if ("webkitCurrentPlaybackTargetIsWireless" in playerVideo) {
    if (playerVideo.webkitCurrentPlaybackTargetIsWireless) return true;
  }
  if (playerVideo.remote && typeof playerVideo.remote.state === "string") {
    const s = playerVideo.remote.state;
    if (s === "connected" || s === "connecting") return true;
  }
  return false;
}
function setupVideoSource(url, referer, {
  forceNative = false,
  startTime = 0,
  autoplay = true
} = {}) {
  const isHlsUrl = /\.m3u8($|\?)/i.test(String(url || ""));
  const isDirectMediaUrl = /\.(mp4|webm|ogg|mov|m4v|avi|mp3|aac|wav)($|\?)/i.test(String(url || ""));
  const hasHlsRuntime = typeof Hls !== "undefined";
  let hlsJsSupported = false;
  if (hasHlsRuntime) {
    try {
      hlsJsSupported = Hls.isSupported();
    } catch (_) {
      hlsJsSupported = false;
    }
  }
  const isSafariWebKit = typeof playerVideo.webkitShowPlaybackTargetPicker === "function";
  const shouldTryHls = !forceNative && !isSafariWebKit && hlsJsSupported && (isHlsUrl || !isDirectMediaUrl);
  if (shouldTryHls) {
    destroyHls();
    let networkRetries = 0;
    let mediaRetries = 0;
    hls = new Hls({
      xhrSetup: referer ? xhr => {
        try {
          xhr.setRequestHeader("Referer", referer);
        } catch (_) {}
      } : undefined
    });
    hls.loadSource(url);
    hls.attachMedia(playerVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (startTime > 0) {
        try {
          playerVideo.currentTime = startTime;
        } catch (_) {}
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
      var _data$frag, _data$context, _data$response, _data$response2, _data$err, _data$response3, _data$err2;
      console.warn("[HLS error]", {
        fatal: data === null || data === void 0 ? void 0 : data.fatal,
        type: data === null || data === void 0 ? void 0 : data.type,
        details: data === null || data === void 0 ? void 0 : data.details,
        reason: data === null || data === void 0 ? void 0 : data.reason,
        url: (data === null || data === void 0 ? void 0 : data.url) || (data === null || data === void 0 || (_data$frag = data.frag) === null || _data$frag === void 0 ? void 0 : _data$frag.url) || (data === null || data === void 0 || (_data$context = data.context) === null || _data$context === void 0 ? void 0 : _data$context.url),
        responseCode: data === null || data === void 0 || (_data$response = data.response) === null || _data$response === void 0 ? void 0 : _data$response.code,
        responseText: data === null || data === void 0 || (_data$response2 = data.response) === null || _data$response2 === void 0 ? void 0 : _data$response2.text,
        err: (data === null || data === void 0 || (_data$err = data.err) === null || _data$err === void 0 ? void 0 : _data$err.message) || (data === null || data === void 0 ? void 0 : data.err)
      });
      if (!(data !== null && data !== void 0 && data.fatal)) return;
      const details = String((data === null || data === void 0 ? void 0 : data.details) || "");
      const statusCode = Number((data === null || data === void 0 || (_data$response3 = data.response) === null || _data$response3 === void 0 ? void 0 : _data$response3.code) || 0);
      const errLine = statusCode ? `HTTP ${statusCode}` : (data === null || data === void 0 || (_data$err2 = data.err) === null || _data$err2 === void 0 ? void 0 : _data$err2.message) || (data === null || data === void 0 ? void 0 : data.reason) || "network/codec";
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        if (networkRetries < 1 && details !== "manifestLoadError") {
          networkRetries += 1;
          hls.startLoad();
          return;
        }
        if (isHlsUrl && playerVideo.canPlayType("application/vnd.apple.mpegurl")) {
          console.warn("[HLS fallback] HLS.js network error → trying native HLS");
          destroyHls();
          playerVideo.src = url;
          playerVideo.load();
          if (startTime > 0) {
            playerVideo.addEventListener("loadedmetadata", () => {
              try {
                playerVideo.currentTime = startTime;
              } catch (_) {}
            }, {
              once: true
            });
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
          try {
            hls.recoverMediaError();
          } catch (_) {}
          return;
        }
        destroyHls();
        showPlayerNotice(`เล่นสตรีมไม่สำเร็จ (Media): ${details}`, 10000);
        return;
      }
      destroyHls();
      showPlayerNotice(`เล่นสตรีมไม่สำเร็จ: ${(data === null || data === void 0 ? void 0 : data.type) || "UNKNOWN"} / ${details}`, 10000);
    });
  } else {
    if (!forceNative) {
      if (isHlsUrl && !hasHlsRuntime) {
        console.warn("HLS runtime is missing. Falling back to native video playback.");
      } else if (isHlsUrl && hasHlsRuntime && !Hls.isSupported()) {
        console.warn("HLS.js is loaded but Media Source Extensions are not supported in this browser.");
      }
    }
    playerVideo.src = url;
    destroyHls();
    const onReady = () => {
      if (startTime > 0) {
        try {
          playerVideo.currentTime = startTime;
        } catch (_) {}
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
      playerVideo.addEventListener("loadedmetadata", onReady, {
        once: true
      });
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
  if (e.ctrlKey && eventKey(e) === "ArrowRight") {
    const target = resolveAdjacentEpisode(1);
    if (!target) return true;
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
    return true;
  }
  if (e.ctrlKey && eventKey(e) === "ArrowLeft") {
    const target = resolveAdjacentEpisode(-1);
    if (!target) return true;
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
    return true;
  }
  if (eventKey(e) === "ArrowRight") {
    seekBySeconds(5);
    showPlayerUI();
    return true;
  }
  if (eventKey(e) === "ArrowLeft") {
    seekBySeconds(-5);
    showPlayerUI();
    return true;
  }
  if (eventKey(e) === "ArrowUp") {
    adjustVolumeBy(0.05);
    showPlayerUI();
    return true;
  }
  if (eventKey(e) === "ArrowDown") {
    adjustVolumeBy(-0.05);
    showPlayerUI();
    return true;
  }
  return false;
}
function togglePlayPause() {
  if (playerVideo.paused) playerVideo.play().catch(() => {});else playerVideo.pause();
}
function rewind10() {
  playerVideo.currentTime = Math.max(0, playerVideo.currentTime - 10);
}
function forward10() {
  if (playerVideo.duration) playerVideo.currentTime = Math.min(playerVideo.duration, playerVideo.currentTime + 10);
}
btnPlayPause.addEventListener("click", togglePlayPause);
btnRewind.addEventListener("click", rewind10);
btnForward.addEventListener("click", forward10);
btnPrevEp.addEventListener("click", () => {
  const target = resolveAdjacentEpisode(-1);
  if (!target) return;
  if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
});
btnNextEp.addEventListener("click", () => {
  const target = resolveAdjacentEpisode(1);
  if (!target) return;
  if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
});
btnShuffle.addEventListener("click", () => {
  shuffleMode = !shuffleMode;
  btnShuffle.classList.toggle("active", shuffleMode);
  shuffleHistory = shuffleMode ? [currentIndex] : [];
  showPlayerNotice(shuffleMode ? "สุ่มเล่น: เปิด" : "สุ่มเล่น: ปิด", 2000);
  if (shuffleMode && currentStations.length > 1) btnNextEp.disabled = false;else btnNextEp.disabled = !resolveAdjacentEpisode(1);
});
playerVideo.addEventListener("play", () => {
  btnPlayPause.innerHTML = PLAYER_ICON_PAUSE;
  showPlayerUI();
});
playerVideo.addEventListener("pause", () => {
  btnPlayPause.innerHTML = PLAYER_ICON_PLAY;
  showPlayerUI();
});
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
    4: "ไม่พบวิดีโอหรือรูปแบบไม่รองรับ"
  };
  const label = codeMap[mediaErr.code] || "เล่นวิดีโอไม่สำเร็จ";
  showPlayerNotice(label);
});
playerVideo.addEventListener("timeupdate", () => {
  if (!playerVideo.duration) return;
  const pct = playerVideo.currentTime / playerVideo.duration * 100;
  playerSeek.value = pct;
  playerSeek.style.background = `linear-gradient(to right, var(--accent) ${pct}%, rgba(255,255,255,.3) ${pct}%)`;
  playerTime.textContent = `${formatTime(playerVideo.currentTime)} / ${formatTime(playerVideo.duration)}`;
});
playerSeek.addEventListener("input", () => {
  if (playerVideo.duration) {
    playerVideo.currentTime = playerSeek.value / 100 * playerVideo.duration;
  }
});
let seekPreviewCues = null;
let seekPreviewSpriteUrl = "";
let seekPreviewLoading = false;
function parseVttTime(str) {
  const parts = str.split(":");
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return +parts[0] * 60 + parseFloat(parts[1]);
  return parseFloat(str);
}
function parseVttThumbnails(vttText, baseUrl) {
  const cues = [];
  const blocks = vttText.replace(/\r\n/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const tsLine = lines.find(l => l.includes("-->"));
    if (!tsLine) continue;
    const [startStr, endStr] = tsLine.split("-->").map(s => s.trim());
    const start = parseVttTime(startStr);
    const end = parseVttTime(endStr);
    const imgLine = lines.find(l => l.includes("#xywh=") || /\.(jpg|jpeg|png|webp)/i.test(l));
    if (!imgLine) continue;
    const [imgPath, fragment] = imgLine.trim().split("#xywh=");
    const url = imgPath.startsWith("http") ? imgPath : baseUrl + imgPath;
    let x = 0,
      y = 0,
      w = 160,
      h = 90;
    if (fragment) {
      const coords = fragment.split(",").map(Number);
      if (coords.length >= 4) {
        x = coords[0];
        y = coords[1];
        w = coords[2];
        h = coords[3];
      }
    }
    cues.push({
      start,
      end,
      url,
      x,
      y,
      w,
      h
    });
  }
  return cues;
}
function getPreviewUrls(streamUrl) {
  if (!streamUrl) return null;
  const match = streamUrl.match(/^(https?:\/\/.+\/)video\.m3u8/);
  if (!match) return null;
  const base = match[1];
  return {
    vtt: base + "preview.vtt",
    sprite: base + "preview.jpg",
    base
  };
}
function loadSeekPreview() {
  var _currentStations;
  seekPreviewCues = null;
  seekPreviewSpriteUrl = "";
  if (!isAvMode) return;
  const station = (_currentStations = currentStations) === null || _currentStations === void 0 ? void 0 : _currentStations[currentIndex];
  if (!station) return;
  const urls = getPreviewUrls(station.url);
  if (!urls) return;
  seekPreviewLoading = true;
  fetch(urls.vtt).then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.text();
  }).then(text => {
    seekPreviewCues = parseVttThumbnails(text, urls.base);
    seekPreviewSpriteUrl = urls.sprite;
    if (seekPreviewCues.length > 0) {
      const img = new Image();
      img.src = seekPreviewSpriteUrl;
    }
  }).catch(() => {}).finally(() => {
    seekPreviewLoading = false;
  });
}
function findPreviewCue(time) {
  if (!seekPreviewCues) return null;
  return seekPreviewCues.find(c => time >= c.start && time < c.end) || null;
}
const progressRow = document.getElementById("player-progress-row");
progressRow.addEventListener("mousemove", e => {
  if (!playerVideo.duration || !seekPreviewCues || seekPreviewCues.length === 0) return;
  const rect = playerSeek.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const pct = x / rect.width;
  const time = pct * playerVideo.duration;
  const cue = findPreviewCue(time);
  if (!cue) {
    seekPreview.classList.add("hidden");
    return;
  }
  const previewW = 160;
  const rowRect = progressRow.getBoundingClientRect();
  let left = e.clientX - rowRect.left;
  left = Math.max(previewW / 2 + 4, Math.min(left, rowRect.width - previewW / 2 - 4));
  seekPreview.style.left = left + "px";
  seekPreviewTime.textContent = formatTime(time);
  seekPreviewThumb.style.width = cue.w + "px";
  seekPreviewThumb.style.height = cue.h + "px";
  seekPreviewThumb.style.backgroundImage = `url(${cue.url})`;
  seekPreviewThumb.style.backgroundPosition = `-${cue.x}px -${cue.y}px`;
  seekPreview.classList.remove("hidden");
});
progressRow.addEventListener("mouseleave", () => {
  seekPreview.classList.add("hidden");
});
const TRACK_LABEL_RE = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i;
function getEpPanelLabel() {
  var _currentStations2;
  if (isAvMode) return "เลือกเรื่อง";
  const hasTrackLabels = (_currentStations2 = currentStations) === null || _currentStations2 === void 0 ? void 0 : _currentStations2.some(s => TRACK_LABEL_RE.test(s.name));
  if (hasTrackLabels) return "เลือกแทร็กเสียง";
  return "เลือกตอน";
}
btnEpisodes.addEventListener("click", e => {
  e.stopPropagation();
  const isOpen = !epPanel.classList.contains("hidden");
  if (isOpen) {
    epPanel.classList.add("hidden");
    btnEpisodes.focus({
      preventScroll: true
    });
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
  btnEpisodes.focus({
    preventScroll: true
  });
});
epPanel.addEventListener("click", e => {
  e.stopPropagation();
});
function renderEpPanel() {
  var _selectedSeason$refer;
  const seasonTabs = crossSeasonSeasons.filter(season => Array.isArray(season.stations) && season.stations.length > 0);
  if (epPanelTabs && seasonTabs.length > 1) {
    const hasSelectedSeason = seasonTabs.some(season => season.title === epPanelSeasonFilter);
    if (!hasSelectedSeason) epPanelSeasonFilter = currentSeasonTitle || seasonTabs[0].title;
    epPanelTabs.innerHTML = seasonTabs.map(season => {
      const activeClass = season.title === epPanelSeasonFilter ? " active" : "";
      return `<button class="ep-season-tab${activeClass}" data-season="${esc(season.title)}">${esc(season.title)}</button>`;
    }).join("");
    epPanelTabs.classList.remove("hidden");
    epPanelTabs.querySelectorAll(".ep-season-tab").forEach((btn, idx) => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        epPanelSeasonFilter = seasonTabs[idx].title;
        renderEpPanel();
      });
    });
  } else if (epPanelTabs) {
    epPanelTabs.classList.add("hidden");
    epPanelTabs.innerHTML = "";
  }
  const selectedSeason = seasonTabs.find(season => season.title === epPanelSeasonFilter);
  const panelStations = (selectedSeason === null || selectedSeason === void 0 ? void 0 : selectedSeason.stations) || currentStations;
  const panelReferer = (_selectedSeason$refer = selectedSeason === null || selectedSeason === void 0 ? void 0 : selectedSeason.referer) !== null && _selectedSeason$refer !== void 0 ? _selectedSeason$refer : inheritedRefererCache;
  epPanelGrid.innerHTML = "";
  panelStations.forEach((station, i) => {
    var _station$meta2;
    const card = document.createElement("div");
    const isActive = panelStations === currentStations && i === currentIndex;
    card.className = "ep-card" + (isActive ? " active" : "");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    const thumbEl = station.image ? `<img class="ep-card-thumb" src="${esc(station.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=ep-card-thumb-ph>▶</div>'">` : `<div class="ep-card-thumb-ph">▶</div>`;
    const isTrack = /^(พากย์ไทย|ซับไทย|บรรยายไทย|พากย์.+|ซับ.+|Thai|English|Japanese|Sub\s?Thai|Thai\s?Dub|Dub|Sub)$/i.test(station.name);
    const actresses = (_station$meta2 = station.meta) === null || _station$meta2 === void 0 ? void 0 : _station$meta2.actresses;
    const actressStr = Array.isArray(actresses) ? actresses.join(", ") : typeof actresses === "string" ? actresses : "";
    let label;
    if (actressStr) {
      label = {
        ep: station.name || `Ep. ${i + 1}`,
        title: actressStr
      };
    } else if (isTrack && playerSectionTitle) {
      label = {
        ep: playerSectionTitle,
        title: station.name
      };
    } else if (isAvMode) {
      label = {
        ep: station.name || `Ep. ${i + 1}`,
        title: ""
      };
    } else {
      label = splitEpisodeLabel(station.name, i + 1);
    }
    const playingBadge = isActive ? `<span class="ep-card-playing">กำลังเล่น</span>` : "";
    const titleEl = label.title ? `<div class="ep-card-title">${esc(label.title)}</div>` : "";
    card.innerHTML = `<div class="ep-card-media">${thumbEl}${playingBadge}</div><div class="ep-card-content"><div class="ep-card-label"><div class="ep-card-epno">${esc(label.ep)}</div>${titleEl}</div></div>`;
    card.addEventListener("click", () => {
      currentStations = panelStations;
      playEpisode(i, panelReferer);
      renderEpPanel();
    });
    card.addEventListener("keydown", e => {
      if (eventKey(e) === "Enter" || eventKey(e) === " ") {
        e.preventDefault();
        card.click();
      }
    });
    epPanelGrid.appendChild(card);
  });
  setTimeout(() => {
    var _epPanelGrid$querySel;
    (_epPanelGrid$querySel = epPanelGrid.querySelector(".ep-card.active")) === null || _epPanelGrid$querySel === void 0 || _epPanelGrid$querySel.scrollIntoView({
      block: "nearest"
    });
  }, 50);
}
playerOverlay.addEventListener("click", e => {
  if (!epPanel.contains(e.target) && e.target !== btnEpisodes) {
    if (!epPanel.classList.contains("hidden")) {
      epPanel.classList.add("hidden");
      btnEpisodes.focus({
        preventScroll: true
      });
    }
  }
});
btnMute.addEventListener("click", () => {
  playerVideo.muted = !playerVideo.muted;
  updateVolumeUI();
});
volumeSlider.addEventListener("input", () => {
  playerVideo.volume = volumeSlider.value;
  playerVideo.muted = playerVideo.volume === 0;
  updateVolumeUI();
});
const VOL_ICONS = {
  low: `<i class="fi fi-rr-volume-down" aria-hidden="true"></i>`,
  high: `<i class="fi fi-rr-volume" aria-hidden="true"></i>`,
  mute: `<i class="fi fi-rr-volume-mute" aria-hidden="true"></i>`
};
function updateVolumeUI() {
  const v = playerVideo.volume;
  volumeSlider.value = v;
  const pct = v * 100;
  volumeSlider.style.background = `linear-gradient(to right, rgba(255,255,255,.9) ${pct}%, rgba(255,255,255,.3) ${pct}%)`;
  btnMute.innerHTML = playerVideo.muted || v === 0 ? VOL_ICONS.mute : v < 0.5 ? VOL_ICONS.low : VOL_ICONS.high;
}
(function initAirPlay() {
  const isSafariWebKit = typeof playerVideo.webkitShowPlaybackTargetPicker === "function";
  function prepareForCast() {
    if (isSafariWebKit) return true;
    const station = currentStations[currentIndex];
    if (!station) return false;
    const savedTime = playerVideo.currentTime || 0;
    const wasPlaying = !playerVideo.paused;
    setupVideoSource(station.url, inheritedRefererCache, {
      forceNative: true,
      startTime: savedTime,
      autoplay: wasPlaying
    });
    return true;
  }
  function restoreLocalPlayback() {
    if (isSafariWebKit) return;
    const station = currentStations[currentIndex];
    if (!station) return;
    const savedTime = playerVideo.currentTime || 0;
    const wasPlaying = !playerVideo.paused;
    setupVideoSource(station.url, inheritedRefererCache, {
      forceNative: false,
      startTime: savedTime,
      autoplay: wasPlaying
    });
  }
  if (typeof playerVideo.webkitShowPlaybackTargetPicker === "function") {
    playerVideo.addEventListener("webkitplaybacktargetavailabilitychanged", e => {
      btnAirPlay.hidden = e.availability !== "available";
    });
    playerVideo.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
      const casting = !!playerVideo.webkitCurrentPlaybackTargetIsWireless;
      btnAirPlay.classList.toggle("casting", casting);
      btnAirPlay.title = casting ? "กำลัง Cast อยู่ — คลิกเพื่อหยุด" : "AirPlay / Cast to TV";
      if (!casting) restoreLocalPlayback();
    });
    btnAirPlay.addEventListener("click", () => {
      try {
        playerVideo.webkitShowPlaybackTargetPicker();
      } catch (e) {
        console.warn(e);
      }
    });
  } else if (playerVideo.remote) {
    playerVideo.remote.watchAvailability(available => {
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
        playerVideo.remote.prompt().catch(err => {
          if (err && err.name !== "NotAllowedError") console.warn(err);
          restoreLocalPlayback();
        });
      }, 50);
    });
  }
})();
btnFullscreen.addEventListener("click", () => {
  if (!document.fullscreenElement) {
    var _playerOverlay$reques;
    (_playerOverlay$reques = playerOverlay.requestFullscreen) === null || _playerOverlay$reques === void 0 || _playerOverlay$reques.call(playerOverlay);
  } else {
    var _document$exitFullscr, _document;
    (_document$exitFullscr = (_document = document).exitFullscreen) === null || _document$exitFullscr === void 0 || _document$exitFullscr.call(_document);
  }
});
const hasDocPip = typeof documentPictureInPicture !== "undefined";
const hasVideoPip = typeof playerVideo.requestPictureInPicture === "function";
if (hasDocPip || hasVideoPip) btnPip.hidden = false;
let docPipWindow = null;
function togglePip() {
  return _togglePip.apply(this, arguments);
}
function _togglePip() {
  _togglePip = _asyncToGenerator(function* () {
    if (docPipWindow) {
      docPipWindow.close();
      docPipWindow = null;
      btnPip.classList.remove("active");
      return;
    }
    if (document.pictureInPictureElement) {
      yield document.exitPictureInPicture();
      btnPip.classList.remove("active");
      return;
    }
    if (hasDocPip) {
      try {
        docPipWindow = yield documentPictureInPicture.requestWindow({
          width: 480,
          height: 270
        });
        const pipDoc = docPipWindow.document;
        pipDoc.documentElement.style.cssText = "margin:0;padding:0;background:#000;overflow:hidden;height:100%";
        pipDoc.body.style.cssText = "margin:0;padding:0;background:#000;display:flex;align-items:center;justify-content:center;height:100%;position:relative";
        const wrapper = pipDoc.createElement("div");
        wrapper.style.cssText = "width:100%;height:100%;position:relative;display:flex;align-items:center;justify-content:center;background:#000";
        playerVideo.style.cssText = "width:100%;height:100%;object-fit:contain";
        wrapper.appendChild(playerVideo);
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
          if ((t === null || t === void 0 ? void 0 : t.type) === "local") playEpisode(t.index, inheritedRefererCache);else if (t) playEpisodeFromQueue(t.queueIndex);
        }));
        controls.appendChild(makeBtn("⏪", rewind10));
        const playPauseBtn = makeBtn(playerVideo.paused ? "▶" : "⏸", () => togglePlayPause());
        controls.appendChild(playPauseBtn);
        playerVideo.addEventListener("play", () => playPauseBtn.textContent = "⏸");
        playerVideo.addEventListener("pause", () => playPauseBtn.textContent = "▶");
        controls.appendChild(makeBtn("⏩", forward10));
        controls.appendChild(makeBtn("⏭", () => {
          const t = resolveAdjacentEpisode(1);
          if ((t === null || t === void 0 ? void 0 : t.type) === "local") playEpisode(t.index, inheritedRefererCache);else if (t) playEpisodeFromQueue(t.queueIndex);
        }));
        wrapper.appendChild(controls);
        pipDoc.body.appendChild(wrapper);
        btnPip.classList.add("active");
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
    if (hasVideoPip) {
      try {
        yield playerVideo.requestPictureInPicture();
        btnPip.classList.add("active");
      } catch (e) {
        showPlayerNotice("PiP ไม่รองรับในเบราว์เซอร์นี้", 3000);
      }
    }
  });
  return _togglePip.apply(this, arguments);
}
btnPip.addEventListener("click", togglePip);
playerVideo.addEventListener("enterpictureinpicture", () => btnPip.classList.add("active"));
playerVideo.addEventListener("leavepictureinpicture", () => btnPip.classList.remove("active"));
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
playerOverlay.addEventListener("touchstart", showPlayerUI, {
  passive: true
});
let _swipeStart = null;
let _swipeHandled = false;
let _swipeWasPlaying = false;
playerOverlay.addEventListener("touchstart", e => {
  if (e.touches.length !== 1) return;
  _swipeStart = {
    x: e.touches[0].clientX,
    y: e.touches[0].clientY,
    time: playerVideo.currentTime
  };
  _swipeHandled = false;
}, {
  passive: true
});
playerOverlay.addEventListener("touchmove", e => {
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
}, {
  passive: false
});
playerOverlay.addEventListener("touchend", () => {
  _swipeStart = null;
  if (!_swipeHandled) return;
  if (_swipeWasPlaying) playerVideo.play();
}, {
  passive: true
});
playerVideo.addEventListener("click", () => {
  if (_swipeHandled) {
    _swipeHandled = false;
    return;
  }
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
  const m = Math.floor(secs % 3600 / 60).toString().padStart(2, "0");
  const s = Math.floor(secs % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function splitEpisodeLabel(name, index) {
  const fallbackEp = `Ep. ${index}`;
  if (!name) return {
    ep: fallbackEp,
    title: ""
  };
  const trimmed = String(name).trim();
  const normalized = trimmed.replace(/\s+/g, " ").replace(/[‐‑‒–—−]/g, "-").trim();
  const enMatch = normalized.match(/^(?:ep|episode)\.?\s*(\d+)(?:\s*[-:]\s*(.+)|\s+(.+))?$/i);
  if (enMatch) {
    const ep = `Ep. ${enMatch[1]}`;
    const title = (enMatch[2] || enMatch[3] || "").trim();
    return {
      ep,
      title
    };
  }
  const thMatch = normalized.match(/^(?:ตอนที่|ตอน)\s*(\d+)(?:\s*[-:]\s*(.+)|\s+(.+))?$/u);
  if (thMatch) {
    const ep = `ตอน ${thMatch[1]}`;
    let title = (thMatch[2] || thMatch[3] || "").trim();
    if (!title) {
      title = normalized.replace(/^(?:ตอนที่|ตอน)\s*\d+\s*/u, "").replace(/^[-:]\s*/, "").trim();
    }
    return {
      ep,
      title
    };
  }
  const hasThai = /[\u0E00-\u0E7F]/.test(normalized);
  return {
    ep: hasThai ? `ตอน ${index}` : fallbackEp,
    title: normalized
  };
}
function formatSeasonEpisodeMeta(seasonTitle, stationName, fallbackIndex) {
  const label = splitEpisodeLabel(stationName, fallbackIndex);
  const normalizedSeason = String(seasonTitle || "").trim() || "Season";
  return {
    meta: `${normalizedSeason} - ${label.ep}`,
    title: label.title || stationName || ""
  };
}
function scheduleNext() {
  var _crossSeasonQueue$tar, _crossSeasonQueue$tar2, _crossSeasonQueue$tar3, _crossSeasonQueue$tar4, _next$meta;
  const target = resolveAdjacentEpisode(1);
  if (!target || upnextCancelled) {
    closePlayer();
    return;
  }
  const next = target.type === "local" ? currentStations[target.index] : (_crossSeasonQueue$tar = crossSeasonQueue[target.queueIndex]) === null || _crossSeasonQueue$tar === void 0 ? void 0 : _crossSeasonQueue$tar.station;
  const nextLabelIndex = target.type === "local" ? target.index + 1 : ((_crossSeasonQueue$tar2 = (_crossSeasonQueue$tar3 = crossSeasonQueue[target.queueIndex]) === null || _crossSeasonQueue$tar3 === void 0 ? void 0 : _crossSeasonQueue$tar3.localIndex) !== null && _crossSeasonQueue$tar2 !== void 0 ? _crossSeasonQueue$tar2 : 0) + 1;
  const nextSeasonTitle = target.type === "local" ? currentSeasonTitle || "Season" : ((_crossSeasonQueue$tar4 = crossSeasonQueue[target.queueIndex]) === null || _crossSeasonQueue$tar4 === void 0 ? void 0 : _crossSeasonQueue$tar4.seasonTitle) || currentSeasonTitle || "Season";
  if (!next) {
    closePlayer();
    return;
  }
  upnextThumb.src = next.image || "";
  const nextActresses = (_next$meta = next.meta) === null || _next$meta === void 0 ? void 0 : _next$meta.actresses;
  const nextActressSub = Array.isArray(nextActresses) ? nextActresses.join(", ") : typeof nextActresses === "string" ? nextActresses : "";
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
      if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
    }
  }, 1000);
  upnextPlayBtn.onclick = () => {
    cancelUpnext();
    if (target.type === "local") playEpisode(target.index, inheritedRefererCache);else playEpisodeFromQueue(target.queueIndex);
  };
  upnextCancelBtn.onclick = () => {
    upnextCancelled = true;
    cancelUpnext();
  };
}
function cancelUpnext() {
  clearInterval(upnextCountdown);
  upnextToast.classList.add("hidden");
}
function closePlayer() {
  cancelUpnext();
  if (docPipWindow) {
    docPipWindow.close();
    docPipWindow = null;
  }
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  btnPip.classList.remove("active");
  destroyHls();
  hidePlayerNotice();
  hidePlayerLoading();
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
  if (hls) {
    hls.destroy();
    hls = null;
  }
}
playerBack.addEventListener("click", closePlayer);
function showPlayerLoading() {
  playerLoading.classList.remove("hidden");
}
function hidePlayerLoading() {
  playerLoading.classList.add("hidden");
}
playerVideo.addEventListener("loadstart", showPlayerLoading);
playerVideo.addEventListener("waiting", showPlayerLoading);
playerVideo.addEventListener("seeking", showPlayerLoading);
playerVideo.addEventListener("canplay", hidePlayerLoading);
playerVideo.addEventListener("playing", hidePlayerLoading);
playerVideo.addEventListener("seeked", hidePlayerLoading);
playerVideo.addEventListener("error", hidePlayerLoading);
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
function esc(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
