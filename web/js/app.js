/* ===== Config ===== */
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const PLAYLIST_URL = isLocal
  ? "/playlist/main.txt"
  : "https://raw.githubusercontent.com/natajrak/IPTV-Player/main/playlist/main.txt";

/* ===== State ===== */
let history = [];         // stack ของ {node, title} ที่เคยเข้าถึง
let currentStations = []; // episodes ที่กำลังดูอยู่
let currentIndex = 0;
let hls = null;
let upnextTimer = null;
let upnextCountdown = null;
let upnextCancelled = false;

/* ===== DOM refs ===== */
const loading     = document.getElementById("loading");
const errorView   = document.getElementById("error-view");
const errorMsg    = document.getElementById("error-message");
const gridView    = document.getElementById("grid-view");
const breadcrumb  = document.getElementById("breadcrumb");
const logo        = document.querySelector(".logo");

const playerOverlay = document.getElementById("player-overlay");
const playerVideo   = document.getElementById("player-video");
const playerClose   = document.getElementById("player-close");
const playerTitle   = document.getElementById("player-title");

const upnextToast     = document.getElementById("upnext-toast");
const upnextThumb     = document.getElementById("upnext-thumb");
const upnextTitle     = document.getElementById("upnext-title");
const upnextCountEl   = document.getElementById("upnext-countdown");
const upnextBar       = document.getElementById("upnext-bar");
const upnextPlayBtn   = document.getElementById("upnext-play-now");
const upnextCancelBtn = document.getElementById("upnext-cancel");

/* ===== Init ===== */
logo.addEventListener("click", () => {
  history = [];
  fetchAndRender(PLAYLIST_URL, "LiftPlay");
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePlayer();
});

fetchAndRender(PLAYLIST_URL, "LiftPlay");

/* ===== Fetch & Render ===== */
async function fetchAndRender(url, title, pushHistory = false, previousNode = null) {
  showLoading();
  try {
    const node = await fetchJSON(url);
    if (pushHistory && previousNode) {
      history.push({ node: previousNode, title });
    }
    renderNode(node, title);
  } catch (err) {
    showError(err.message || "โหลดข้อมูลไม่สำเร็จ");
  }
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ===== Render node ===== */
function renderNode(node, title) {
  updateBreadcrumb(title);

  if (node.groups?.length) {
    renderGroups(node.groups, title);
  } else if (node.stations?.length) {
    renderStations(node.stations, node.referer, title);
  } else {
    showError("ไม่พบข้อมูลใน playlist นี้");
    return;
  }
  showGrid();
}

/* ===== Render group cards ===== */
function renderGroups(groups, sectionTitle) {
  gridView.innerHTML = `<h2 class="section-title">${esc(sectionTitle)}</h2>
    <div class="card-grid portrait"></div>`;

  const grid = gridView.querySelector(".card-grid");

  groups.forEach((group, i) => {
    const card = makeCard({
      name: group.name || group.info || "ไม่มีชื่อ",
      image: group.image,
      sub: group.author || null,
      landscape: false,
    });

    card.addEventListener("click", () => {
      const prevNode = { groups, referer: null };
      if (group.url && !group.groups && !group.stations) {
        fetchAndRender(group.url, group.name || "...", true, prevNode);
      } else {
        history.push({ node: prevNode, title: sectionTitle });
        renderNode(group, group.name || "...");
      }
    });

    grid.appendChild(card);
  });
}

/* ===== Render episode cards ===== */
function renderStations(stations, referer, sectionTitle) {
  gridView.innerHTML = `<h2 class="section-title">${esc(sectionTitle)}</h2>
    <div class="card-grid landscape"></div>`;

  const grid = gridView.querySelector(".card-grid");

  stations.forEach((station, i) => {
    const card = makeCard({
      name: station.name || `ตอนที่ ${i + 1}`,
      image: station.image,
      sub: null,
      landscape: true,
    });

    card.addEventListener("click", () => {
      openPlayer(stations, i, referer);
    });

    grid.appendChild(card);
  });
}

/* ===== Make Card element ===== */
function makeCard({ name, image, sub, landscape }) {
  const card = document.createElement("div");
  card.className = "card";
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

  const info = document.createElement("div");
  info.className = "card-info";
  info.innerHTML = `<div class="card-name">${esc(name)}</div>${sub ? `<div class="card-sub">${esc(sub)}</div>` : ""}`;

  card.appendChild(thumb);
  card.appendChild(info);
  return card;
}

/* ===== Breadcrumb ===== */
function updateBreadcrumb(currentTitle) {
  breadcrumb.innerHTML = "";

  history.forEach((entry, i) => {
    const span = document.createElement("span");
    span.className = "breadcrumb-item";
    span.textContent = entry.title;
    span.addEventListener("click", () => {
      // ย้อนกลับไปยัง history entry นั้น
      const targetHistory = history.slice(0, i);
      history = targetHistory;
      renderNode(entry.node, entry.title);
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
function openPlayer(stations, index, inheritedReferer) {
  currentStations = stations;
  currentIndex = index;
  upnextCancelled = false;

  playerOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";

  playEpisode(index, inheritedReferer);
}

function playEpisode(index, inheritedReferer) {
  const station = currentStations[index];
  if (!station) { closePlayer(); return; }

  currentIndex = index;

  const referer = station.referer ?? inheritedReferer ?? null;
  const url = station.url;

  playerTitle.textContent = station.name || `ตอนที่ ${index + 1}`;

  cancelUpnext();
  destroyHls();

  if (Hls.isSupported() && url.includes(".m3u8")) {
    hls = new Hls({
      xhrSetup: referer
        ? (xhr) => { xhr.setRequestHeader("Referer", referer); }
        : undefined,
    });
    hls.loadSource(url);
    hls.attachMedia(playerVideo);
    hls.on(Hls.Events.MANIFEST_PARSED, () => playerVideo.play());
  } else {
    playerVideo.src = url;
    playerVideo.play();
  }

  playerVideo.onended = () => scheduleNext(inheritedReferer);
}

/* ===== Auto-next (Up Next toast) ===== */
function scheduleNext(inheritedReferer) {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= currentStations.length || upnextCancelled) {
    closePlayer();
    return;
  }

  const next = currentStations[nextIndex];
  upnextThumb.src = next.image || "";
  upnextTitle.textContent = next.name || `ตอนที่ ${nextIndex + 1}`;

  upnextToast.classList.remove("hidden");

  let secs = 5;
  upnextCountEl.textContent = secs;
  upnextBar.style.transition = "none";
  upnextBar.style.transform = "scaleX(1)";

  // ทำให้ bar หด 5 วินาที
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
      playEpisode(nextIndex, inheritedReferer);
    }
  }, 1000);

  upnextPlayBtn.onclick = () => {
    cancelUpnext();
    playEpisode(nextIndex, inheritedReferer);
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
  destroyHls();
  playerVideo.pause();
  playerVideo.src = "";
  playerVideo.onended = null;
  playerOverlay.classList.add("hidden");
  document.body.style.overflow = "";
}

function destroyHls() {
  if (hls) { hls.destroy(); hls = null; }
}

playerClose.addEventListener("click", closePlayer);

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
