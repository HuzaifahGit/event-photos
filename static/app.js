// Event Photos — guest page
// Screens: home → (consent sheet → camera) → loading → results; browse; viewer overlay.

const $ = (id) => document.getElementById(id);
const CFG = window.EVENT || {};
// Mac first, Raspberry Pi as backup (selfie search + uploads keep working
// while the Mac is offline). The gallery itself never needs either.
const APIS = [CFG.api || "", CFG.api2].filter((x, i) => i === 0 || x).map((u) => u.replace(/\/$/, ""));
let API = APIS[0];
// Relative media paths are served by the Mac API; absolute ones come from R2.
// /r2/... is served by the guest site itself (works with the Mac off);
// other relative paths (/media/...) come from the Mac API.
const abs = (u) => (u && u.startsWith("/") && !u.startsWith("/r2/") ? API + u : u);
const SID_KEY = "event_session";
const SID_API_KEY = "event_session_api";   // which server holds the session
const store = {
  get() { try { return localStorage.getItem(SID_KEY); } catch { return null; } },
  set(v) { try { localStorage.setItem(SID_KEY, v); } catch {} },
  clear() { try { localStorage.removeItem(SID_KEY); } catch {} },
};

const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ♥ Saved: kept on this phone only, no account needed.
const FAV_KEY = "event_favs";
let favs = (() => { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || {}; } catch { return {}; } })();
const isFav = (id) => !!favs[id];
function toggleFav(p) {
  if (favs[p.id]) delete favs[p.id];
  else favs[p.id] = { id: p.id, thumb: p.thumb, web: p.web, full: p.full, w: p.w, h: p.h, taken: p.taken, source: p.source, by: p.by };
  lsSet(FAV_KEY, JSON.stringify(favs));
}
const favList = () => Object.values(favs).sort((a, b) => (b.taken || "").localeCompare(a.taken || ""));

// ------------------------------------------------------------------ programmes (tabs)
// Day 1 / Dinner / Day 2. A tab shows once its "opens" time has passed (event local
// time) or when switched on from the dashboard; the newest open one comes first.
// A photo belongs to the programme whose from..to range holds its capture time.
// Before any tab opens the gallery shows "All".
let programs = [
  { id: "day1", label: "Day 1", opens: "2030-01-01T07:00", from: "2030-01-01T00:00", to: "2030-01-01T18:30", mode: "auto" },
  { id: "dinner", label: "Dinner", opens: "2030-01-01T19:00", from: "2030-01-01T18:30", to: "2030-01-02T05:00", mode: "auto" },
  { id: "day2", label: "Day 2", opens: "2030-01-02T07:00", from: "2030-01-02T05:00", to: "2030-01-03T05:00", mode: "auto" },
];
const nowMYT = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16);
function openPrograms() {
  const now = nowMYT();
  return programs.filter((p) => p.mode === "show" || (p.mode === "auto" && now >= p.opens))
    .sort((a, b) => b.opens.localeCompare(a.opens));
}
function programOf(p) {
  const t = (p.taken || "").slice(0, 16);
  const g = t && programs.find((x) => t >= x.from && t < x.to);
  return g ? g.id : null;
}
const inEventRange = (taken) => programs.some((x) => taken.slice(0, 16) >= x.from && taken.slice(0, 16) < x.to);
// Tab order: Dinner, Photobooth, Day 2, Day 1, then Top (anything new goes before Top)
const TAB_ORDER = ["dinner", "booth", "day2", "day1"];
function browseSegments() {
  const o = openPrograms().map((p) => p.id), segs = [...(o.length ? o : ["all"]), "booth"];
  const rank = (s) => { const i = TAB_ORDER.indexOf(s); return i < 0 ? 50 : i; };
  segs.sort((a, b) => rank(a) - rank(b));
  const mine = state.results && (state.results.strong || []).length ? ["mine"] : [];   // after a selfie search
  return [...segs, "top", ...mine];
}
// Tab icons (drawn here, simple line style): calendar with the day number, cutlery,
// a photo strip, a heart
function segIcon(s) {
  const a = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
  const day = /^day(\d+)$/.exec(s);
  if (day) return `<svg ${a}><rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M3.5 9.6h17M8.2 3v4M15.8 3v4"/>`
    + `<text x="12" y="18.6" text-anchor="middle" font-size="8.6" font-weight="800" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">${day[1]}</text></svg>`;
  if (s === "dinner") return `<svg ${a}><path d="M7 3v7.2a2.2 2.2 0 0 0 4.4 0V3M9.2 3v18"/><path d="M17.2 21V3c-2.2 1.2-3.4 4-3.4 7.2 0 1.6.9 2.6 3.4 2.8"/></svg>`;   // cutlery
  if (s === "booth") return `<img class="seg-img seg-booth" src="/static/brand/booth-logo.png" alt="">`;   // the vendor's logo
  if (s === "mine") return `<svg ${a}><path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M4 15.5V18a2 2 0 0 0 2 2h2.5"/>`
    + `<circle cx="11" cy="9.6" r="2.4"/><path d="M6.8 16.2c.7-2 2.3-3.1 4.2-3.1"/><circle cx="16.4" cy="16.4" r="2.9"/><path d="M18.5 18.5l2.3 2.3"/></svg>`;
  if (s === "top") return `<svg ${a}><path d="M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>`;
  return `<svg ${a}><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>`;
}
const BOOTH_URL = "https://photobooth.example.com/gallery";
const isBooth = (p) => p.by === "Photobooth";        // photobooth photos live only in their own tab
function resultsSegments() { return ["all"]; }   // "Find my photos" shows every photo of you on one page (no day tabs)
const segLabel = (id) => id === "all" ? "All" : id === "top" ? "Top" : id === "mine" ? "My photos" : id === "booth" ? "Photobooth" : (programs.find((p) => p.id === id) || {}).label || id;

const state = {
  sid: store.get(),
  browseSource: null,      // a programme id, "all" (before the event) or "top"
  resultsSource: "all",    // all | programme id
  addingAngle: false,
  results: null,          // last results payload
  browse: { photos: [], offset: 0, total: 0, done: false, loading: false },
  viewer: { list: [], index: 0, context: "results" },
  selecting: false,
  selected: new Set(),
  verdicts: {},           // photo_id -> "me" | "not_me"
};

// ------------------------------------------------------------------ utils
// Signed pass from the QR-code gate; selfie search / uploads require it.
let passToken = null;
async function getPass() {
  if (passToken) return passToken;
  try { const r = await fetch("/pass"); if (r.ok) passToken = (await r.json()).token; } catch {}
  return passToken;
}

async function api(path, opts = {}) {
  const tok = await getPass();
  if (tok) opts = { ...opts, headers: { ...(opts.headers || {}), "X-Event-Pass": tok } };
  const sessionCall = path.startsWith("/api/session/");
  const bases = sessionCall ? [sessionApi()] : [API, ...APIS.filter((b) => b !== API)];
  let lastErr;
  for (const base of bases) {
    try {
      const res = await fetch(base + path, opts);
      let body = null;
      try { body = await res.json(); } catch {}
      if ([502, 503, 504, 530].includes(res.status)) throw Object.assign(new Error(`http_${res.status}`), { status: res.status, down: true });
      if (!res.ok) {
        const err = new Error((body && body.detail) || `http_${res.status}`);
        err.status = res.status;
        throw err;
      }
      if (base !== API && !sessionCall) API = base;   // stick with the server that answered
      if (path === "/api/match" && body && body.session) lsSet(SID_API_KEY, base);
      return body;
    } catch (err) {
      lastErr = err;
      const down = err.down || err.name === "TypeError";
      if (!down || sessionCall) throw err;            // real answer (bad code etc.): don't retry
    }
  }
  throw lastErr;
}
const sessionApi = () => lsGet(SID_API_KEY) || API;

// ------------------------------------------------------------------ phone back button
// Every screen / viewer / sheet / camera is a "layer" with a browser-history
// entry, so Android's back button (or iOS swipe-back) closes the top layer
// instead of leaving the site. Closing with an on-screen button removes the
// matching history entry again.
const layers = [];
let ignorePop = 0, popping = false;
function pushLayer(name, close) {
  layers.push({ name, close });
  history.pushState({ event: layers.length }, "");
}
function dropLayer(name) {
  if (popping) return;
  const i = layers.map((l) => l.name).lastIndexOf(name);
  if (i < 0) return;
  const top = i === layers.length - 1;
  layers.splice(i, 1);
  if (top) { ignorePop++; history.back(); }
}
window.addEventListener("popstate", () => {
  if (ignorePop) { ignorePop--; return; }
  const l = layers.pop();
  if (!l) return;
  popping = true;
  try { l.close(); } finally { popping = false; }
});

const DEPTH = { home: 0, feed: 1, browse: 1, results: 1, profile: 1 };   // the three tab screens are siblings
let screenNow = "home";
function show(id) {
  if (window.showTopBars && !["browse", "feed"].includes(id)) showTopBars();
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  window.scrollTo(0, 0);
  const tabbed = ["feed", "browse", "results", "profile"].includes(id);
  try { sessionStorage.setItem("event_screen", id); } catch {}
  document.body.classList.toggle("tabbed", tabbed);
  document.querySelectorAll("#tabbar button[data-tab]").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === id || (b.dataset.tab === "me" && id === "results")));
  if (!(id in DEPTH)) return;                 // the loading screen isn't a layer
  const from = screenNow;
  screenNow = id;
  if (DEPTH[id] > DEPTH[from]) {
    pushLayer("screen:" + id, () => {
      if (id === "feed" && state.search) clearSearch();
      show(from);
      if (from === "home") loadHome();
    });
  } else if (DEPTH[id] === DEPTH[from] && id !== from) {
    // switching tabs: the history entry now stands for the new tab
    const top = layers[layers.length - 1];
    if (top && top.name === "screen:" + from) top.name = "screen:" + id;
  } else if (DEPTH[id] < DEPTH[from]) {
    dropLayer("screen:" + from);
    if (id === "home") dropLayer("screen:results");
  }
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function dayLabel(iso) {
  if (!iso) return "Earlier";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

function groupByDay(photos) {
  const groups = new Map();
  for (const p of photos) {
    const key = dayLabel(p.taken);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return groups;
}

// High-quality resize on the phone before upload. pica (Lanczos) gives clean
// results on every browser; the built-in canvas downscale can look jagged.
// Fallback: halve step by step with smoothing, which is close to Lanczos.
let picaInstance = null;
function picaLib() {
  if (!picaInstance && window.pica) {
    try { picaInstance = window.pica({ features: ["js", "wasm", "ww"] }); } catch {}
  }
  return picaInstance;
}

async function shrinkImage(file, longEdge = 1280, quality = 0.9) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // undecodable here (e.g. HEIC on Android): let the server try
  }
  const scale = Math.min(1, longEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  try {
    const p = picaLib();
    if (!p || scale === 1) throw new Error("no pica");
    await p.resize(bmp, out, { filter: "lanczos3", unsharpAmount: 60, unsharpRadius: 0.6, unsharpThreshold: 2 });
  } catch {
    stepDown(bmp, out);
  }
  bmp.close && bmp.close();
  return await new Promise((r) => out.toBlob(r, "image/jpeg", quality));
}

function stepDown(src, out) {
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 >= out.width) {
    const c = document.createElement("canvas");
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const x = out.getContext("2d");
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  x.drawImage(cur, 0, 0, out.width, out.height);
}

// ------------------------------------------------------------------ reactions & comments
// Stored on Cloudflare (works with the Mac off). One small request gives every
// photo's counts; comments load only when a photo is opened.
const social = { emojis: ["❤️", "😂", "😮", "👏", "🔥"], reactions: {}, comments: {}, mine: {}, firstComment: {}, captions: {}, avatars: {}, loaded: 0 };
const likesOf = (id) => Object.values(social.reactions[id] || {}).reduce((a, b) => a + b, 0);

// hoisted + guarded: may run before myUs is defined further down
function myUsList() { try { return [...myUs()]; } catch { return []; } }
async function loadSocial(force = false) {
  if (!force && Date.now() - social.loaded < 20000) return;
  try {
    const r = await fetch(`/api/social/summary?device=${encodeURIComponent(uploaderId())}&us=${myUsList().join(",")}&name=${encodeURIComponent(lsGet(NAME_KEY) || "")}&full=${encodeURIComponent(lsGet(FULLNAME_KEY) || "")}`);
    if (!r.ok) return;
    Object.assign(social, await r.json(), { loaded: Date.now() });
    paintMyAvatars();
    if ($("feed").classList.contains("active")) feedIndex.forEach((x) => x.el._update && x.el._update());
  } catch {}
}

// ------------------------------------------------------------------ tiles
// Tiles are cached per gallery and reused when the gallery re-renders (more
// photos loaded, filter change, refresh). Rebuilding them made every image
// fade in again, which looked like flicker while scrolling.
const tileCache = new Map();
// Boomerang tiles play only while visible (saves battery and data).
const tileVideoIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) { if (!v.src) v.src = v.dataset.src; v.play().catch(() => {}); }
    else v.pause();
  }
}, { rootMargin: "120px" });
// Photobooth tab and Feed: only the video most in view plays; the ones above/below pause.
const boothVis = new Map();
const boothVideoIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio > 0) boothVis.set(e.target, e.intersectionRatio);
    else boothVis.delete(e.target);
  }
  let best = null, top = 0.5;                         // must be at least half on screen
  for (const [v, r] of boothVis) if (r > top && v.isConnected) { best = v; top = r; }
  for (const v of document.querySelectorAll(".focus-vid")) {
    if (v === best) { if (!v.src) v.src = v.dataset.src; v.play().catch(() => {}); }
    else if (!v.paused) v.pause();
  }
}, { threshold: [0, 0.25, 0.5, 0.6, 0.75, 0.9, 1] });
function tileStats(id) {          // "❤️ 4  💬 2" in the tile corner
  const l = likesOf(id), c = social.comments[id] || 0;
  return [l ? `❤️ ${l}` : "", c ? `💬 ${c}` : ""].filter(Boolean).join("  ");
}
function makeTile(photo, list, context, opts = {}) {
  const key = `${context}:${photo.id}:${photo.thumb}`;
  let el = tileCache.get(key);
  if (!el) {
    el = document.createElement("button");
    el.className = "tile";
    el.dataset.id = photo.id;
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.onload = () => img.classList.add("loaded");
    // 400 px for small tiles, 900 px for big ones / sharp screens: the phone picks
    // by the tile's real size (set in layoutJustified); never the heavy 2000 px copy
    if (photo.mid) {
      const r = photo.w && photo.h ? Math.min(1, photo.w / photo.h) : 1;
      img.srcset = `${abs(photo.thumb)} ${Math.round(400 * r)}w, ${abs(photo.mid)} ${Math.round(900 * r)}w`;
      img.sizes = "33vw";
      img.onerror = () => { if (img.srcset) { img.srcset = ""; img.src = abs(photo.thumb); } };
    }
    img.src = abs(photo.thumb);
    if (img.complete && img.naturalWidth) img.classList.add("loaded");
    el.appendChild(img);
    if (photo.kind === "boomerang" && photo.vthumb) {
      const v = document.createElement("video");
      v.className = "tile-vid"; v.muted = true; v.loop = true; v.playsInline = true; v.preload = "none";
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.dataset.src = abs(photo.vthumb);
      v.onplaying = () => v.classList.add("on");
      el.appendChild(v);
      const b = document.createElement("span"); b.className = "badge-boom"; b.textContent = photo.by === PHOTOBOOTH_NAME || photo.vid ? "▶" : "∞";
      el.appendChild(b);
      tileVideoIO.observe(v);
    }
    const check = document.createElement("span");
    check.className = "check";
    el.appendChild(check);
    el.addEventListener("click", () => {
      if (state.selecting) return toggleSelect(el, photo.id);
      openViewer(el._list, el._list.indexOf(el._photo), el._context);
    });
    tileCache.set(key, el);
  }
  el._list = list; el._photo = photo; el._context = context;
  const badge = (cls, text) => {
    let b = el.querySelector("." + cls);
    if (!text) { b && b.remove(); return; }
    if (!b) { b = document.createElement("span"); b.className = cls; el.appendChild(b); }
    b.textContent = text;
  };
  badge("badge-new", opts.isNew ? "NEW" : "");
  if (freshIds.has(photo.id)) { freshIds.delete(photo.id); el.classList.add("fresh"); }
  badge("badge-likes", tileStats(photo.id));
  badge("badge-fav", isFav(photo.id) ? "♥" : "");
  el.classList.toggle("selected", state.selected.has(photo.id));
  return el;
}

// Justified rows (Google Photos style): every photo keeps its own shape,
// rows are scaled so both edges line up, nothing is cropped.
const GAP = 2;
const layouts = new Set(); // registered grids, re-laid-out on resize

// Photos per row cycle in a rhythm so a run of same-shaped (landscape) event
// shots still reads like an edited album: hero, pair, trio, pair, ...
// Bursts: the same poster, seconds apart, near-identical frames -> one big swipeable card
// (like a Photobooth session) instead of a row of look-alike thumbnails.
const BURST_GAP_S = 30, BURST_BITS = 14;
function phDist(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let k = 0; k < a.length; k += 8) {
    let x = parseInt(a.slice(k, k + 8), 16) ^ parseInt(b.slice(k, k + 8), 16);
    while (x) { x &= x - 1; d++; }
  }
  return d;
}
function burstItems(photos) {
  const items = [];
  let cur = null;
  const who = (p) => p.source === "guest" ? "u:" + (p.u || p.by) : "cam";
  const ts = (p) => Date.parse(p.taken || "") / 1000;
  for (const p of photos) {
    const ok = cur && p.kind !== "boomerang" && p.ph && who(p) === cur.who
      && Math.abs(ts(p) - ts(cur.last)) <= BURST_GAP_S && phDist(p.ph, cur.last.ph) <= BURST_BITS;
    if (ok) { cur.photos.push(p); cur.last = p; continue; }
    cur = { photos: [p], last: p, who: who(p) };
    items.push(cur);
  }
  return items;
}
// object-position that puts the photo's focus point (its faces) in the middle of a
// square crop: p = (f - v/2) / (1 - v), v = the visible share of that axis
function cropAt(p) {
  const r = p._ratio || (p.w && p.h ? p.w / p.h : 1);
  const [fx, fy] = p.f || [0.5, 0.42];
  const pos = (f, v) => v >= 0.999 ? 50 : Math.min(100, Math.max(0, (f - v / 2) / (1 - v) * 100));
  return r >= 1 ? `${pos(fx, 1 / r).toFixed(1)}% 50%` : `50% ${pos(fy, r).toFixed(1)}%`;
}
// Burst cards are cached like tiles: rebuilding them on every live refresh
// reloaded their images, which made those cards flicker.
const burstCache = new Map();
function makeBurst(photos, list, context, width) {
  const key = `${context}|${Math.round(width)}|${photos.map((p) => p.id + (p.v || "")).join(",")}`;
  const hit = burstCache.get(key);
  if (hit) { hit._mark(); return hit; }
  const card = buildBurst(photos, list, context, width);
  burstCache.set(key, card);
  return card;
}
function buildBurst(photos, list, context, width) {
  const card = document.createElement("div"); card.className = "burst-card";
  const media = document.createElement("div"); media.className = "post-media burst";
  const r = Math.min(1.5, Math.max(0.8, photos[0]._ratio || 1.5));
  media.style.height = `${Math.round(width / r)}px`;
  const track = document.createElement("div"); track.className = "post-track";
  photos.forEach((p) => {
    const s = document.createElement("div"); s.className = "post-slide";
    const im = document.createElement("img");
    im.loading = "lazy"; im.decoding = "async"; im.alt = "";
    im.src = abs((innerWidth >= 900 ? p.web : p.mid) || p.web || p.thumb);   // big card on a desktop: full-quality copy
    im.onerror = () => { if (im.src !== abs(p.web)) im.src = abs(p.web); };
    im.onload = () => im.classList.add("loaded");
    s.appendChild(im);
    s.dataset.id = p.id;
    s.onclick = () => openViewer(photos, photos.indexOf(p), context, true);   // swipe through just this burst
    track.appendChild(s);
  });
  media.appendChild(track);
  const count = document.createElement("span"); count.className = "post-count"; media.appendChild(count);
  const stats = document.createElement("span"); stats.className = "badge-likes"; media.appendChild(stats);
  const dots = document.createElement("div"); dots.className = "post-dots burst-dots";
  photos.forEach(() => dots.appendChild(document.createElement("i")));
  const mark = () => {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    count.textContent = `${i + 1}/${photos.length}`;
    [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
    const st = tileStats(photos[i].id); stats.textContent = st; stats.hidden = !st;
  };
  track.addEventListener("scroll", mark, { passive: true });
  mark();
  card.append(media, dots);
  card._mark = mark;
  return card;
}

function swapRows(grid, frag) {
  const h = grid.offsetHeight;
  if (h) grid.style.minHeight = `${h}px`;
  grid.replaceChildren(frag);
  requestAnimationFrame(() => { grid.style.minHeight = ""; });
}
function layoutJustified(grid) {
  // Samsung-Gallery style: every row fills the width at its photos' own shapes, sized
  // close to a target height (portraits pack 3, landscapes 2), never one lone hero.
  const { photos, list, context, markNew } = grid._data;
  const cs = getComputedStyle(grid);
  const width = grid.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 0.5;   // content box, no overflow
  if (width <= 0) return;
  // Phones fire "resize" whenever the address bar slides away while you scroll (the height changes,
  // not the width). Rebuilding the rows then collapsed the page and threw you back up: only
  // lay out again if the width really changed.
  if (grid._done && grid._laidW && Math.abs(grid._laidW - width) < 1 && grid.childElementCount) return;
  grid._laidW = width;
  grid._done = true;
  const target = width < 420 ? 205 : width < 800 ? 260 : 300;
  const lastRowH = target;
  const frag = document.createDocumentFragment();

  for (const p of photos) p._ratio = p.w && p.h ? Math.min(3, Math.max(0.5, p.w / p.h)) : 1.5;

  // Explore groups bursts into one big card; elsewhere (your photos, search) every
  // photo stays its own tile so it can be picked and saved individually
  if ((context === "browse" || context === "results") && !grid._noBursts) {
    // Explore + your photos: big rounded squares, two per row, cropped around the
    // people; on Explore, bursts are full-width cards (your photos keep every
    // shot separate so each can be picked and saved)
    let run = [];
    const flush = () => { if (run.length) { squareRun(run); run = []; } };
    const items = context === "browse" ? burstItems(photos) : photos.map((p) => ({ photos: [p] }));
    for (const it of items) {
      if (it.photos.length > 1) { flush(); frag.appendChild(makeBurst(it.photos, list, context, width)); }
      else run.push(it.photos[0]);
    }
    flush();
    swapRows(grid, frag);
    return;
  }
  layoutRun(photos);
  swapRows(grid, frag);

  function squareRun(photos) {
    const box = document.createElement("div");
    box.className = "sqgrid";
    for (const p of photos) {
      const tile = makeTile(p, list, context, { isNew: markNew && p.new });
      tile.classList.add("sq");
      tile.style.width = "";
      const ti = tile.querySelector("img");
      if (ti) {
        if (ti.srcset) ti.sizes = "(min-width: 900px) 520px, 50vw";   // desktop: always the sharp 900 px copy
        ti.style.objectPosition = cropAt(p);
      }
      box.appendChild(tile);
    }
    frag.appendChild(box);
  }

  function layoutRun(photos) {
  let i = 0;
  while (i < photos.length) {
    const left = photos.length - i;
    const heightFor = (k) => {
      const sum = photos.slice(i, i + k).reduce((a, p) => a + p._ratio, 0);
      return (width - GAP * (k - 1)) / sum;
    };
    let n = 1;
    while (n < left && heightFor(n) > target) n++;
    // pick whichever of n / n-1 lands nearer the target height (rows of at least 2)
    if (n > 2 && Math.abs(heightFor(n - 1) - target) < Math.abs(heightFor(n) - target)) n--;
    if (n < 2 && left >= 2) n = 2;
    if (left - n === 1) n++;                         // never leave a single photo for the last row
    let h = heightFor(n);
    if (i + n >= photos.length && h > lastRowH * 1.25) h = lastRowH;   // short last row: don't blow it up

    const rowEl = document.createElement("div");
    rowEl.className = "jrow";
    rowEl.style.height = `${Math.round(h)}px`;
    for (const p of photos.slice(i, i + n)) {
      const tile = makeTile(p, list, context, { isNew: markNew && p.new });
      tile.style.width = `${(p._ratio * h).toFixed(2)}px`;
      const ti = tile.querySelector("img");
      if (ti && ti.srcset) ti.sizes = `${Math.round(p._ratio * h)}px`;
      rowEl.appendChild(tile);
    }
    frag.appendChild(rowEl);
    i += n;
  }
  }
}

function makeJustified(photos, list, context, markNew) {
  const grid = document.createElement("div");
  grid.className = "jgrid";
  grid._data = { photos, list, context, markNew };
  layouts.add(grid);
  // laid out by the caller right after it's attached; this is only a fallback
  requestAnimationFrame(() => { if (!grid._done) layoutJustified(grid); });
  return grid;
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const g of layouts) {
      if (!g.isConnected) layouts.delete(g);
      else layoutJustified(g);
    }
  }, 120);
});

// Day header, then 15-minute sections ("8:45 – 9:00 PM"). Sparse neighbouring
// sections merge (up to an hour) so there's no header for a lone photo.
const BUCKET_MIN = 15;
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function rangeLabel(from, to) {
  const a = fmtTime(from), b = fmtTime(to);
  const [ta, pa] = a.split(" "), [, pb] = b.split(" ");
  return pa && pa === pb ? `${ta} – ${b}` : `${a} – ${b}`;
}

function momentsOf(items) {           // items are newest first
  const buckets = [];
  for (const p of items) {
    const t = p.taken ? new Date(p.taken) : null;
    if (!t || isNaN(t)) {
      const last = buckets[buckets.length - 1];
      if (last && last.unknown) last.photos.push(p);
      else buckets.push({ unknown: true, photos: [p] });
      continue;
    }
    const start = new Date(t);
    start.setMinutes(Math.floor(t.getMinutes() / BUCKET_MIN) * BUCKET_MIN, 0, 0);
    const last = buckets[buckets.length - 1];
    if (last && !last.unknown && last.start.getTime() === start.getTime()) last.photos.push(p);
    else buckets.push({ start, photos: [p] });
  }
  const moments = [];
  for (const b of buckets) {
    const m = moments[moments.length - 1];
    const canMerge = m && !m.unknown && !b.unknown
      && (m.photos.length < 4 || b.photos.length < 4)
      && m.to - b.start <= 60 * 60000;
    if (canMerge) { m.photos.push(...b.photos); m.from = b.start; }
    else if (b.unknown) moments.push({ unknown: true, photos: b.photos });
    else moments.push({ from: b.start, to: new Date(b.start.getTime() + BUCKET_MIN * 60000), photos: [...b.photos] });
  }
  return moments;
}

// Hourly sections, Samsung-gallery style: a small floating label
// ("11:00 AM, Oct 9") above each hour that sticks while you scroll through it.
// the floating hour label sits just under the gallery's search/tab header
function measureHeads() {
  const h = document.querySelector("#browse .sticky-head");
  if (h && h.offsetHeight) document.documentElement.style.setProperty("--browse-head", `${h.offsetHeight}px`);
}
window.addEventListener("resize", measureHeads);

// Explore + Feed: scrolling down tucks the logo / heart / + row away (the day tabs
// or the search bar stay pinned); scrolling up brings it back. Only the guest's own
// scrolling counts: changing tabs (which jumps to the top) leaves it as it was.
// The header slides rather than shrinking, so the photos underneath never jump.
(() => {
  let lastY = scrollY, hidden = false, userUntil = 0, touchY = null;
  const root = document.documentElement;
  const onPage = () => document.querySelector("#browse.active, #feed.active");
  const setHide = (h) => {
    if (h === hidden) return;
    hidden = h;
    const bar = onPage() && onPage().querySelector(".sticky-head .top-bar");
    if (h && bar) {
      const safe = parseFloat(getComputedStyle(bar).paddingTop) - 6;   // keep the notch area covered
      root.style.setProperty("--bar-hide", `${Math.max(0, bar.offsetHeight - safe - 10)}px`);   // leave a little air above the tabs
    }
    document.body.classList.toggle("bars-hidden", h);
  };
  const user = () => { userUntil = Date.now() + 700; };
  // the app's own jumps (tab change -> top, "new posts" -> top) never count, even
  // right after a tap/swipe: hold the bar as it is until that jump has finished
  let appUntil = 0;
  const hold = (ms) => { appUntil = Date.now() + ms; };
  for (const fn of ["scrollTo", "scroll", "scrollBy"]) {
    const orig = window[fn].bind(window);
    window[fn] = (...a) => { hold(a[0] && a[0].behavior === "smooth" ? 1200 : 400); return orig(...a); };
  }
  window.holdTopBars = hold;
  addEventListener("wheel", (e) => { user(); if (e.deltaY < 0 && scrollY <= 2) setHide(false); }, { passive: true });
  let touchX = null;
  addEventListener("touchstart", (e) => { user(); touchY = e.touches[0].clientY; touchX = e.touches[0].clientX; }, { passive: true });
  addEventListener("touchmove", (e) => {
    user();
    const dyT = touchY === null ? 0 : e.touches[0].clientY - touchY, dxT = touchX === null ? 0 : e.touches[0].clientX - touchX;
    if (scrollY <= 2 && Date.now() > appUntil && dyT > 24 && dyT > Math.abs(dxT) * 1.5) setHide(false);   // pull down at the top
  }, { passive: true });
  addEventListener("touchend", () => { touchY = null; user(); }, { passive: true });
  addEventListener("keydown", user);
  addEventListener("scroll", () => {
    const y = scrollY, dy = y - lastY;
    if (!onPage() || document.querySelector(".tour-tip")) { setHide(false); lastY = y; return; }
    if (Date.now() > userUntil || Date.now() < appUntil) { lastY = y; return; }   // the app scrolled, not the guest
    if (dy > 6 && y > 40) setHide(true);
    else if (dy < -6) setHide(false);
    if (Math.abs(dy) > 6) lastY = y;
  }, { passive: true });
  window.showTopBars = () => { setHide(false); lastY = scrollY; };
})();
new ResizeObserver(measureHeads).observe(document.querySelector("#browse .sticky-head"));
function hourBuckets(items) {           // items are newest first
  const out = [];
  for (const p of items) {
    const t = p.taken ? new Date(p.taken) : null;
    const key = t && !isNaN(t) ? new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours()).getTime() : "unknown";
    const last = out[out.length - 1];
    if (last && last.key === key) last.photos.push(p);
    else out.push({ key, photos: [p] });
  }
  return out;
}
function hourLabel(key) {
  if (key === "unknown") return "Time unknown";
  const d = new Date(key);
  return `${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, ${d.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
function renderGroups(container, photos, context, markNew) {
  // Build everything, swap it in at once, then lay out in the same frame, so
  // the page never collapses to zero height for a frame (no jump, no flash).
  const minH = container.offsetHeight;
  container.style.minHeight = `${minH}px`;
  // Rebuilding (e.g. the next page of photos arrived) must not move what the guest is
  // looking at: remember the first photo on screen and put it back in the same spot.
  let anchorId = null, anchorTop = 0;
  if (container.isConnected && container.offsetParent) {
    const headH = 150;
    for (const el of container.querySelectorAll("[data-id]")) {
      const r = el.getBoundingClientRect();
      if (r.bottom > headH && r.height) { anchorId = el.dataset.id; anchorTop = r.top; break; }
    }
  }
  const frag = document.createDocumentFragment(), grids = [];
  for (const h of hourBuckets(photos)) {
    const head = document.createElement("div");
    head.className = "hour-head";
    const pill = document.createElement("span");
    pill.textContent = hourLabel(h.key);
    head.append(pill);
    const g = makeJustified(h.photos, photos, context, markNew);
    grids.push(g);
    const sec = document.createElement("section");   // the label only sticks while its own hour is on screen
    sec.className = "hour";
    sec.append(head, g);
    frag.append(sec);
  }
  container.replaceChildren(frag);
  for (const g of grids) layoutJustified(g);
  container.style.minHeight = "";
  if (anchorId) {
    const el = container.querySelector(`[data-id="${CSS.escape(anchorId)}"]`);
    if (el) {
      const d = el.getBoundingClientRect().top - anchorTop;
      if (Math.abs(d) > 1) window.scrollBy(0, d);
    }
  }
}

// ------------------------------------------------------------------ gallery source
// Normally the Mac API lists photos. If the Mac or tunnel is down, fall back to
// photos.json on R2 so "Browse all" keeps working (selfie search needs the Mac).
let manifestCache = null, manifestAt = 0;
const mapManifest = (m) => m.photos.map((p) => ({
  ...p, thumb: `/r2/thumb/${p.id}.jpg${p.v ? `?v=${p.v}` : ""}`, web: `/r2/web/${p.id}.jpg${p.v ? `?v=${p.v}` : ""}`,
  mid: `/r2/mid/${p.id}.jpg${p.v ? `?v=${p.v}` : ""}`,
  full: `/r2/full/${p.id}.jpg${p.v ? `?v=${p.v}` : ""}`,
  ...(p.kind === "boomerang" ? { video: `/r2/video/${p.id}.mp4${p.v ? `?v=${p.v}` : ""}`, vthumb: `/r2/vthumb/${p.id}.mp4${p.v ? `?v=${p.v}` : ""}` } : {}),
}));

// ---- live gallery: new photos slide in by themselves (no refresh needed)
// Checks the photo list every few seconds while the gallery is open (faster
// right after you share something), inserts new photos where they belong and
// keeps your scroll position. If you're scrolled down, a "new photos" pill
// takes you up to them.
const freshIds = new Set();
let liveFastUntil = 0, liveTimer = null, newAbove = 0;
function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(liveTick, Date.now() < liveFastUntil ? 3000 : 8000);
}
async function liveTick() {
  try {
    if (document.visibilityState === "visible" && $("feed").classList.contains("active") && $("viewer").hidden) await refreshFeed();
    else if (document.visibilityState === "visible" && $("browse").classList.contains("active")
        && !state.selecting && $("viewer").hidden && manifestCache) await refreshGallery();
    else if (document.visibilityState === "visible" && $("results").classList.contains("active")
        && Date.now() - (state.resultsAt || 0) > 30000) { state.resultsAt = Date.now(); refreshResults(true); }
  } catch {}
  scheduleLive();
}
async function refreshGallery() {
  const r = await fetch(`/photos.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return;
  const next = mapManifest(await r.json());
  const before = new Set(manifestCache.map((p) => p.id));
  const added = next.filter((p) => !before.has(p.id));
  const removed = manifestCache.length + added.length !== next.length;
  if (!added.length && !removed) return;
  manifestCache = next; manifestAt = Date.now();
  added.forEach((p) => freshIds.add(p.id));
  const src = state.browseSource;
  if (state.search) return;     // search results live in the Feed; re-running them here threw the scroll position away
  // keep what's on screen in place while content is inserted above it
  const anchor = [...document.querySelectorAll("#browseGroups .tile")].find((t) => t.getBoundingClientRect().bottom > 120);
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  if (src === "top") { await renderTop(); }
  else {
    const b = state.browse;
    const data = await listPhotos(0, Math.max(60, b.offset + added.length), src);
    b.photos = data.photos; b.offset = data.photos.length; b.total = data.total; b.done = b.offset >= data.total;
    renderGroups($("browseGroups"), b.photos, "browse", false);
    updateSegCounts(data.counts);
    showBrowseEmpty(b.photos.length ? "" : $("browseEmpty").textContent);
  }
  if (anchor && anchor.isConnected && window.scrollY > 40) {
    window.scrollBy(0, anchor.getBoundingClientRect().top - anchorTop);
    const visible = added.filter((p) => src === "all" || src === "top" || programOf(p) === src).length;
    if (visible) { newAbove += visible; showNewPill(); }
  }
}
function showNewPill() {
  const pill = $("newPill");
  pill.textContent = `↑ ${newAbove} new photo${newAbove === 1 ? "" : "s"}`;
  pill.hidden = false;
}
$("newPill").onclick = () => { newAbove = 0; $("newPill").hidden = true; window.scrollTo({ top: 0, behavior: "smooth" }); };
window.addEventListener("scroll", () => { if (window.scrollY < 60 && !$("newPill").hidden) { newAbove = 0; $("newPill").hidden = true; } }, { passive: true });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { clearTimeout(liveTimer); liveTick(); } });
scheduleLive();

async function listPhotos(offset, limit, source = "all") {
  if (!manifestCache || Date.now() - manifestAt > 15000 || offset === 0) {
    const r = await fetch(`/photos.json?t=${Date.now()}`);
    if (!r.ok) throw new Error("manifest");
    manifestCache = mapManifest(await r.json());
    manifestAt = Date.now();
  }
  const who = byWho(manifestCache).filter((p) => !isBooth(p));   // Photographer / Guests filter (photobooth has its own tab)
  const pool = source === "all" ? who : who.filter((p) => programOf(p) === source);
  const counts = { all: who.length };
  for (const p of who) { const g = programOf(p); if (g) counts[g] = (counts[g] || 0) + 1; }
  counts.booth = new Set(manifestCache.filter(isBooth).map((p) => p.b)).size;   // photobooth sessions
  return { total: pool.length, counts, photos: pool.slice(offset, offset + limit) };
}

// ------------------------------------------------------------------ home
async function loadHome() {
  try {
    const data = await listPhotos(0, 12);
    state.apiOffline = !!data.offline;
    state.totalPhotos = data.total;
  } catch {}
  updateWelcome();
}

$("findBtn").onclick = () => openConsent();
$("profFind").onclick = () => { $("profileSheet").hidden = true; if (state.results) show("results"); else openConsent(); };
$("browseBtn").onclick = () => openExplore();

function openConsent() { $("consentSheet").hidden = false; loadFaceDetector(); }
function closeConsent() { $("consentSheet").hidden = true; }
$("consentCancel").onclick = closeConsent;
$("consentSheet").addEventListener("click", (e) => { if (e.target.id === "consentSheet") closeConsent(); });
$("agreeBtn").onclick = () => {
  closeConsent();
  state.addingAngle = false;
  openSelfieCamera();
};

$("selfieInput").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  await runMatch(file);
});

// ------------------------------------------------------------------ selfie camera
// Opens the FRONT camera inside the page with an oval face guide. If the phone
// blocks camera access (or has none), fall back to the normal photo picker.
let camStream = null;
async function openSelfieCamera(title = "Take a selfie", hint = "Fit your face inside the oval · good light · no sunglasses") {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return pickSelfieFile();
  $("camTitle").textContent = title;
  $("camHint").textContent = hint;
  $("cam").classList.remove("ready");
  $("cam").hidden = false;
  document.body.style.overflow = "hidden";
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
    });
    const v = $("camVideo");
    v.srcObject = camStream;
    await v.play().catch(() => {});
    $("cam").classList.add("ready");
    startFaceGuide();
  } catch {
    closeSelfieCamera();
    toast("Camera not available — choose a selfie instead", 3000);
    pickSelfieFile();
  }
}
function closeSelfieCamera() {
  stopFaceGuide();
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  $("camVideo").srcObject = null;
  $("cam").hidden = true;
  document.body.style.overflow = "";
}
function pickSelfieFile() {
  $("selfieInput").value = "";
  $("selfieInput").click();
}
$("camClose").onclick = () => { closeSelfieCamera(); state.addingAngle = false; };
$("camPick").onclick = () => { closeSelfieCamera(); pickSelfieFile(); };
// ---- auto-capture: an on-device face detector (MediaPipe, loaded on demand)
// guides the guest into the oval and takes the selfie once the face has been
// well placed for a moment. The shutter button stays for manual use.
let faceDetector = null, faceDetectorLoading = null, guideTimer = null, goodSince = 0, capturing = false;
const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
function loadFaceDetector() {
  if (faceDetector || faceDetectorLoading) return faceDetectorLoading;
  faceDetectorLoading = (async () => {
    try {
      const vision = await import(`${MP}/vision_bundle.mjs`);
      const files = await vision.FilesetResolver.forVisionTasks(`${MP}/wasm`);
      faceDetector = await vision.FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite", delegate: "GPU" },
        runningMode: "VIDEO", minDetectionConfidence: 0.6,
      });
    } catch (e) { console.warn("face detector unavailable", e); faceDetector = null; }
    return faceDetector;
  })();
  return faceDetectorLoading;
}
function setGuide(text, progress, mode) {
  if ($("camHint").textContent !== text) $("camHint").textContent = text;
  $("camProg").style.strokeDasharray = `${Math.round(progress * 100)} 100`;
  $("camProg").style.opacity = progress > 0 ? "1" : "0";
  $("cam").dataset.guide = mode;
}
async function startFaceGuide() {
  goodSince = 0; capturing = false;
  setGuide("Fit your face inside the oval", 0, "search");
  const det = await loadFaceDetector();
  if (!det || !camStream) { if (camStream) setGuide("Fit your face in the oval, then tap the button", 0, "manual"); return; }
  const v = $("camVideo");
  const tick = () => {
    if (!camStream || capturing) return;
    if (v.readyState >= 2 && v.videoWidth) {
      let res;
      try { res = det.detectForVideo(v, performance.now()); } catch { res = null; }
      judge(res ? res.detections : [], v);
    }
    guideTimer = setTimeout(tick, 120);
  };
  tick();
}
function stopFaceGuide() { clearTimeout(guideTimer); guideTimer = null; goodSince = 0; }
function judge(faces, v) {
  const W = innerWidth, H = innerHeight, vw = v.videoWidth, vh = v.videoHeight;
  const s = Math.max(W / vw, H / vh), ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;   // object-fit: cover
  const ov = $("camOval").getBoundingClientRect();
  const ocx = ov.left + ov.width / 2, ocy = ov.top + ov.height / 2;
  let msg = "Fit your face inside the oval", ok = false;
  if (faces.length > 1) msg = "Just one face please";
  else if (faces.length === 1) {
    const b = faces[0].boundingBox;
    const fw = b.width * s;
    const fx = W - (ox + (b.originX + b.width / 2) * s);          // the preview is mirrored
    const fy = oy + (b.originY + b.height / 2) * s;
    const ratio = fw / ov.width;
    if (ratio < 0.36) msg = "Move a little closer";
    else if (ratio > 0.9) msg = "Move back a little";
    else if (Math.abs(fx - ocx) > ov.width * 0.17 || Math.abs(fy - ocy) > ov.height * 0.16) msg = "Center your face in the oval";
    else ok = true;
  }
  const now = performance.now();
  if (!ok) { goodSince = 0; setGuide(msg, 0, faces.length ? "adjust" : "search"); return; }
  if (!goodSince) goodSince = now;
  const p = Math.min(1, (now - goodSince) / 700);
  setGuide(p < 1 ? "Hold still…" : "Got it!", p, "hold");
  if (p >= 1) { capturing = true; $("camShutter").click(); }
}

$("camShutter").onclick = async () => {
  const v = $("camVideo");
  if (!camStream || !v.videoWidth) return;
  // grab the frame as the camera sees it (not mirrored), cropped to the oval area
  const c = document.createElement("canvas");
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  const flash = document.createElement("div");
  flash.className = "cam-flash";
  $("cam").appendChild(flash);
  setTimeout(() => flash.remove(), 300);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
  closeSelfieCamera();
  await runMatch(new File([blob], "selfie.jpg", { type: "image/jpeg" }));
};
document.addEventListener("visibilitychange", () => { if (document.hidden && camStream) closeSelfieCamera(); });

// ------------------------------------------------------------------ matching
async function runMatch(file) {
  const total = state.results ? state.results.total_photos : state.totalPhotos || 0;
  $("loadingTitle").textContent = "Looking for you…";
  $("loadingSub").textContent = total ? `Checking ${total.toLocaleString()} photos` : "Checking every photo from the event";
  show("loading");
  const t0 = performance.now();
  try {
    const blob = await shrinkImage(file);
    const fd = new FormData();
    let data;
    if (state.addingAngle && state.sid) {
      fd.append("selfie", blob, "selfie.jpg");
      data = await api(`/api/session/${state.sid}/selfie`, { method: "POST", body: fd });
    } else {
      fd.append("consent", "yes");
      fd.append("selfies", blob, "selfie.jpg");
      fd.append("fullname", lsGet(FULLNAME_KEY));      // links your face to your name for name search
      fd.append("nick", lsGet(NAME_KEY));
      fd.append("device", uploaderId());
      data = await api("/api/match", { method: "POST", body: fd });
    }
    // Keep the scan animation on screen long enough to read as "work happened".
    const wait = 900 - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const before = state.results ? state.results.strong.length : 0;
    state.sid = data.session;
    store.set(state.sid);
    setTimeout(saveProfile, 500);
    renderResults(data);
    show("results");
    if (state.addingAngle && data.strong.length > before) toast(`${data.strong.length - before} more photos found`);
  } catch (err) {
    if (err.message === "no_face") toast("We couldn't see a face. Try again facing the camera in good light.", 4000);
    else if (err.message === "session_expired") { forgetLocal(); toast("Session expired. Please take a new selfie."); }
    else if (err.name === "TypeError" || [502, 503, 504, 530].includes(err.status))
      toast("Selfie search is offline for a moment. You can still browse all photos.", 4500);
    else toast("Something went wrong. Please try again.");
    show(state.results ? "results" : "home");
  } finally {
    state.addingAngle = false;
  }
}

function renderResults(data) {
  // add the "My photos" tab only when the tab list actually changes (renderSegButtons
  // itself calls renderResults, so rebuilding unconditionally here loops forever)
  setTimeout(() => {
    if ($("browseSeg").dataset.key !== browseSegments().join(",")) renderSegButtons();
    updateSegCounts();
  }, 0);
  state.results = data;
  const n = data.strong.length;
  $("resultsTitle").textContent = n ? `We found ${n} photo${n === 1 ? "" : "s"} of you` : "No photos of you yet";
  $("resultsSub").textContent = n
    ? `From ${data.total_photos.toLocaleString()} event photos · tap one to save`
    : `We checked ${data.total_photos.toLocaleString()} photos`;
  $("resultsEmpty").hidden = n > 0;
  $("selectBtn").hidden = n === 0;
  $("liveBanner").hidden = false;
  if (!resultsSegments().includes(state.resultsSource)) state.resultsSource = resultsSegments()[0];
  const bySource = (list) => state.resultsSource === "all" ? list : list.filter((x) => programOf(x) === state.resultsSource);
  const shown = bySource(data.strong);
  $("resultsSeg").hidden = n === 0 || resultsSegments().length < 2;
  renderGroups($("resultsGroups"), shown, "results", true);
  if (n && !shown.length) $("resultsGroups").innerHTML = `<div class="empty"><p class="muted">None in this filter yet.</p></div>`;

  const p = data.possible.length;
  $("possibleWrap").hidden = p === 0;
  state.resultsSigShown = resultsSig(data);
  if (p) {
    const wasOpen = !$("possibleGrid").hidden;
    $("possibleBtn").textContent = `Show ${p} more possible match${p === 1 ? "" : "es"}`;
    $("possibleGrid").hidden = true;
    $("possibleGrid").innerHTML = "";
    if (wasOpen) $("possibleBtn").onclick();      // keep it open if the guest had opened it
  }
  if (data.new_count && data.new_count < n) toast(`${data.new_count} new photo${data.new_count === 1 ? "" : "s"} of you`);
}

$("possibleBtn").onclick = () => {
  const grid = $("possibleGrid");
  if (!grid.hidden) {
    grid.hidden = true;
    $("possibleBtn").textContent = `Show ${state.results.possible.length} more possible matches`;
    return;
  }
  grid.innerHTML = "";
  const list = state.results.possible;
  grid.hidden = false;
  const g = makeJustified(list, list, "results", false);
  grid.appendChild(g);
  layoutJustified(g);
  $("possibleBtn").textContent = "Hide possible matches";
};

const resultsSig = (d) => [d.strong, d.possible].map((l) => (l || []).map((x) => x.id || x.video || x.thumb || "").join(",")).join("|") + "|" + (d.total_photos || 0);
async function refreshResults(quiet = false) {
  if (!state.sid) return;
  try {
    const data = await api(`/api/session/${state.sid}`);
    // A quiet background refresh with nothing new must not rebuild the page: that
    // closed "possible matches" and threw the scroll position away.
    const sig = resultsSig(data);
    if (quiet && sig === state.resultsSigShown) { state.results = data; return; }
    renderResults(data);
    if (!quiet && !data.new_count) toast("No new photos yet");
  } catch (err) {
    if (err.status === 404) { forgetLocal(); show("home"); toast("Session expired. Please take a new selfie."); }
  }
}
$("refreshBtn").onclick = () => refreshResults(false);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && $("results").classList.contains("active")) refreshResults(true);
});

$("resultsBrowseBtn").onclick = () => openBrowse();
$("menuAngle").onclick = () => {
  $("menuSheet").hidden = true;
  state.addingAngle = true;
  openSelfieCamera("Another angle", "Turn your head slightly to one side");
};
$("resultsBack").onclick = () => { show("home"); loadHome(); };

// ------------------------------------------------------------------ menu
$("resultsMenu").onclick = () => ($("menuSheet").hidden = false);
$("menuCancel").onclick = () => ($("menuSheet").hidden = true);
$("menuSheet").addEventListener("click", (e) => { if (e.target.id === "menuSheet") $("menuSheet").hidden = true; });
$("menuBrowse").onclick = () => { $("menuSheet").hidden = true; openBrowse(); };
$("menuRetake").onclick = () => { $("menuSheet").hidden = true; forgetServer(); openConsent(); };
$("menuForget").onclick = () => {
  $("menuSheet").hidden = true;
  forgetServer();
  show("home");
  loadHome();
  toast("Done. Your face data is removed from this session.");
};

function forgetLocal() {
  state.sid = null;
  state.results = null;
  state.verdicts = {};
  store.clear();
}
function forgetServer() {
  if (state.sid) fetch(`${sessionApi()}/api/session/${state.sid}`, { method: "DELETE", headers: passToken ? { "X-Event-Pass": passToken } : {} }).catch(() => {});
  forgetLocal();
}

// ------------------------------------------------------------------ browse
// Build the tab buttons from the open programmes (re-run every minute so a tab
// appears by itself when its time comes).
function renderSegButtons() {
  const build = (id, segs, withCounts) => {
    const box = $(id), key = segs.join(",");
    if (box.dataset.key === key) return false;
    box.dataset.key = key;
    box.querySelectorAll("button").forEach((b) => b.remove());
    box.style.gridTemplateColumns = `repeat(${segs.length}, minmax(0, 1fr))`;   // every tab the same width
    box.classList.toggle("many", segs.length >= 5);
    for (const s of segs) {
      const b = document.createElement("button");
      b.dataset.seg = s;
      b.setAttribute("role", "tab");
      const lab = (txt) => { const l = document.createElement("span"); l.className = "seg-label"; l.textContent = txt; return l; };
      if (id === "browseSeg") {
        // icon + count at rest; the selected tab also shows its name
        const ic = document.createElement("span"); ic.className = "seg-ico"; ic.innerHTML = segIcon(s);
        const main = document.createElement("span"); main.className = "seg-main";   // icon + name stay on one line
        const l = lab(s === "booth" ? "Photo booth" : segLabel(s));   // two short lines, so it can be bigger
        if (s === "booth") l.classList.add("two");
        main.append(ic, l);
        b.append(main);
        if (withCounts) { const c = document.createElement("span"); c.className = "seg-count"; b.append(c); }
        b.setAttribute("aria-label", s === "top" ? "Most liked" : s === "booth" ? "Photobooth" : segLabel(s));
      }
      else if (s === "top") { b.append(lab("Top")); b.setAttribute("aria-label", "Most liked"); }
      else if (s === "booth") {
        b.append(lab("Photobooth"));
        if (withCounts) { const c = document.createElement("span"); c.className = "seg-count"; b.append(c); }
        b.setAttribute("aria-label", "Photobooth");
      }
      else {
        b.append(lab(segLabel(s)));
        if (withCounts) { const c = document.createElement("span"); c.className = "seg-count"; b.append(c); }
      }
      box.appendChild(b);
    }
    return true;
  };
  const bs = browseSegments();
  const changed = build("browseSeg", bs, true);
  build("resultsSeg", resultsSegments(), false);
  if (!state.browseSource || !bs.includes(state.browseSource)) {
    const first = bs.includes("booth") ? "booth" : bs[0];   // Photobooth is the default tab
    state.browseSource = first;
    if ($("browse").classList.contains("active") && !state.search) setBrowseSource(first, true);
  }
  setSegmentUI("browseSeg", state.browseSource);
  setSegmentUI("resultsSeg", resultsSegments().includes(state.resultsSource) ? state.resultsSource : resultsSegments()[0]);
  if (changed) updateSegCounts();
  if (state.results) renderResults(state.results);
}
async function loadPrograms() {
  try {
    const r = await fetch("/programs.json", { cache: "no-cache" });
    if (r.ok) { const d = await r.json(); if (d.programs && d.programs.length) programs = d.programs; }
  } catch {}
  renderSegButtons();
}

function openBrowse(source) {
  show("browse");
  requestAnimationFrame(() => placePill("browseSeg", state.browseSource, false));
  setTimeout(maybeTour, 450);
  if (source && source !== state.browseSource) return setBrowseSource(source, true);
  if (source) return setBrowseSource(source, true);
  if (!state.browse.photos.length && state.browseSource !== "saved") loadMoreBrowse();
}

function setSegmentUI(id, value) {
  if (window.holdTopBars) holdTopBars(1000);        // new day's photos load: the page height jumps
  document.querySelectorAll(`#${id} button`).forEach((b) => {
    const on = b.dataset.seg === value;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  });
  const pill = pillOf(id);
  const swiped = pill && pill.dataset.swiped === value;    // already moved there with the finger
  if (pill) delete pill.dataset.swiped;
  placePill(id, value, true);
  if (pill && !swiped) { pill.classList.remove("pop"); void pill.offsetWidth; pill.classList.add("pop"); }
}

// First visit, straight after the landing page: a 3-step tour that glides between
// the day tabs (with a swiping hand), the Feed tab and the heart. Once per phone.
let tourStarted = false;
function maybeTour() {
  if (tourStarted || lsGet("event_tour") || !$("browse").classList.contains("active") || !$("viewer").hidden) return;
  tourStarted = true;
  lsSet("event_tour", "1");
  const days = [...$("browseSeg").querySelectorAll("button")].filter((b) => b.dataset.seg !== "top")
    .map((b) => segLabel(b.dataset.seg)).join(", ").replace(/, ([^,]*)$/, " & $1");
  const steps = [];
  if (!$("browseSeg").hidden && days) steps.push({ el: () => $("browseSeg"), swipe: true, demo: true,
    html: `<b>Swipe</b> left or right on the photos to switch between ${days}.` });
  steps.push({ el: () => $("fabFind").closest(".fab-stack"),
    prep: () => $("fabFind").closest(".fab-stack").classList.add("open"),
    html: "<b>Find my photos</b> (magnifying glass) finds every photo you're in from one selfie. <b>Share photos</b> (camera) adds your own. Tap a round button once to see its name, again to use it." });
  steps.push({ el: () => document.querySelector('#tabbar [data-tab="feed"]'),
    html: "Tap <b>Feed</b> to see posts from guests and the photographer, newest first." });
  steps.push({ el: () => $("exHeart"), html: "The <b>heart</b> shows likes and comments on your photos." });
  runTour(steps);
}

// First visit to the Feed: the search box, scrolling by poster, and multi-photo posts.
let feedTourStarted = false;
function maybeFeedTour() {
  if (feedTourStarted || lsGet("event_tour_feed") || !$("feed").classList.contains("active") || !$("viewer").hidden
      || state.search || document.querySelector(".tour-tip")) return;
  const multi = () => [...document.querySelectorAll("#feedList .post")].find((p) => p.querySelector(".post-count"));
  if (!document.querySelector("#feedList .post")) return;
  feedTourStarted = true;
  lsSet("event_tour_feed", "1");
  const steps = [
    { el: () => $("searchBox"), prep: () => window.scrollTo({ top: 0, behavior: "smooth" }),
      html: "<b>Search a name</b> to see every photo of that person and their posts. Try <b>photographer</b> for the official shots." },
    { el: () => document.querySelector("#feedList .post"), scroll: true,
      html: "<b>Scroll down</b> to see posts by each guest and the photographer, newest first." },
  ];
  if (multi()) steps.push({ el: () => multi().querySelector(".post-media"), swipe: true,
    prep: () => { const m = multi(); const top = m.getBoundingClientRect().top + window.scrollY - 120; window.scrollTo({ top, behavior: "smooth" }); },
    html: "Posts with a number like <b>1/3</b> hold several photos: <b>swipe sideways</b> through them, or tap to open them full screen." });
  runTour(steps);
}

function runTour(steps) {
  let i = 0;
  const veil = document.createElement("div"); veil.className = "tour-veil";
  const ring = document.createElement("div"); ring.className = "tour-ring";
  const tip = document.createElement("div"); tip.className = "tour-tip"; tip.setAttribute("role", "dialog");
  tip.innerHTML = '<div class="tour-body"></div><div class="tour-row"><span class="tour-dots"></span><button type="button"></button></div>';
  const hand = document.createElement("div"); hand.className = "tour-hand"; hand.textContent = "👆";
  document.body.append(veil, ring, hand, tip);
  const body = tip.querySelector(".tour-body"), btn = tip.querySelector("button"), dots = tip.querySelector(".tour-dots");
  const end = () => {
    demoStop();
    document.querySelectorAll(".fab-mini.open").forEach((s) => s.classList.remove("open"));
    for (const e of [veil, ring, hand, tip]) e.classList.add("bye");
    setTimeout(() => { veil.remove(); ring.remove(); hand.remove(); tip.remove(); }, 300);
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place);
  };
  function place() {
    const st = steps[i], el = st.el();
    if (!el) return;
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    const w = Math.min(290, window.innerWidth - 32), H = tip.offsetHeight;
    const below = r.top < window.innerHeight / 2;
    const left = Math.max(16, Math.min(window.innerWidth - w - 16, r.left + r.width / 2 - w / 2));
    tip.classList.toggle("below", below);
    Object.assign(tip.style, { width: `${w}px`, left: `${left}px`, top: `${below ? r.bottom + 16 : r.top - 16 - H}px` });
    tip.style.setProperty("--ax", `${Math.max(18, Math.min(w - 18, r.left + r.width / 2 - left))}px`);
    hand.classList.toggle("on", !!(st.swipe || st.scroll));
    hand.classList.toggle("vert", !!st.scroll);
    if (st.swipe) hand.style.top = `${Math.min(window.innerHeight - 160, st.prep ? r.top + r.height / 2 : r.bottom + 190)}px`;
    if (st.scroll) hand.style.top = `${Math.min(window.innerHeight - 200, Math.max(140, r.top + r.height / 2))}px`;
  }
  // demo step: the tab strip slides to the next tab and back, on a loop, so the swipe is obvious
  let demoTimer = null;
  const demoStop = () => {
    if (!demoTimer) return;
    clearInterval(demoTimer); demoTimer = null;
    if (state.browseSource) placePill("browseSeg", state.browseSource, true);
  };
  const demoStart = () => {
    demoStop();
    const segs = (typeof browseSegments === "function" ? browseSegments() : []), cur = state.browseSource;
    const next = segs[(segs.indexOf(cur) + 1) % segs.length];
    if (!cur || !next) return;
    let away = false;
    const tick = () => { away = !away; placePill("browseSeg", away ? next : cur, true); };
    tick();                                             // first slide right away
    demoTimer = setInterval(tick, 850);
  };
  function show() {
    demoStop();
    if (steps[i].demo) setTimeout(demoStart, 120);
    body.classList.add("swap");
    if (steps[i].prep) steps[i].prep();
    setTimeout(() => {
      body.innerHTML = steps[i].html;
      btn.textContent = i === steps.length - 1 ? "Got it" : "Next";
      dots.innerHTML = steps.map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("");
      body.classList.remove("swap");
      place();
      if (steps[i].prep) setTimeout(place, 450);          // after the smooth scroll lands
    }, steps[i].prep ? 380 : i ? 160 : 0);
  }
  function next() { i++; if (i >= steps.length) end(); else show(); }
  btn.onclick = next;
  veil.onclick = next;
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, { passive: true });
  show();
  requestAnimationFrame(() => tip.classList.add("in"));
}

// A highlight "pill" behind the active tab. It slides between tabs, and while
// you swipe the gallery it follows your finger (progress -1..1 toward a neighbour).
function pillOf(id) {
  const seg = $(id);
  let pill = seg.querySelector(".seg-pill");
  if (!pill) { pill = document.createElement("span"); pill.className = "seg-pill"; seg.prepend(pill); }
  return pill;
}
function rectOf(id, value) {
  const b = $(id).querySelector(`button[data-seg="${value}"]`);
  return b ? { x: b.offsetLeft, w: b.offsetWidth } : null;
}
// Day tabs as a centred carousel: the selected tab sits in the middle, full size with
// the outline; its neighbours shrink and fade with distance. Follows the finger on swipe.
const TAB_CAROUSEL = true;
if (TAB_CAROUSEL) document.body.classList.add("tabs-carousel");
function placeCarousel(value, animate, toValue = null, progress = 0) {
  const box = $("browseSeg"), btns = [...box.querySelectorAll("button")];
  const segs = btns.map((b) => b.dataset.seg), n = segs.length;
  const i0 = segs.indexOf(value);
  if (i0 < 0 || !box.clientWidth) return;
  const drag = !!toValue && progress !== 0;
  const f = i0 - Math.sign(progress) * Math.min(1, Math.abs(progress));   // swipe left = towards the next tab
  const W = btns[0].offsetWidth, mid = box.clientWidth / 2;
  box.classList.toggle("dragging", drag);
  const last = box._d || [];
  btns.forEach((b, i) => {
    let d = (((i - f) % n) + n) % n;                    // endless: the strip wraps around
    if (d > n / 2) d -= n;
    // exactly opposite (even tab count): stay on the side it was on, so it fades out
    // there instead of jumping across while still visible
    if (Math.abs(Math.abs(d) - n / 2) < 0.001 && last[i]) d = Math.sign(last[i]) * n / 2;
    const look = (dd) => {                              // transform + opacity for a distance from the centre
      const aa = Math.min(Math.abs(dd), 3);
      const sc = 1 - 0.2 * Math.min(aa, 2.5);
      const pos = Math.sign(dd) * (aa <= 1 ? aa * 0.6 : 0.6 + (aa - 1) * 0.36) * W;
      const low = Math.min(aa, 2) * 3;
      return { tf: `translateX(${(mid + pos - W / 2 - b.offsetLeft).toFixed(1)}px) translateY(${low.toFixed(1)}px) scale(${sc.toFixed(3)})`,
               op: (aa <= 1 ? 1 - 0.12 * aa : aa <= 2 ? 0.88 - 0.28 * (aa - 1) : Math.max(0, 0.6 - 1.4 * (aa - 2))).toFixed(3) };
    };
    const a = Math.min(Math.abs(d), 3);
    const jump = last[i] !== undefined && Math.abs(last[i] - d) > n / 2;   // came round the back of the loop
    const L = look(d);
    if (jump && animate) {
      // enter from one step further out on its new side, invisible, then slide/fade in
      const S = look(d + Math.sign(d || 1));
      b.style.transition = "none"; b.style.transform = S.tf; b.style.opacity = "0";
      void b.offsetWidth;
    }
    // the highlight (outline, fill, text colour) fades with the slide instead of switching at once
    b.style.transition = animate ? "transform .42s cubic-bezier(.2,.8,.2,1), opacity .42s, --z .42s cubic-bezier(.2,.8,.2,1)" : "none";
    b.style.transform = L.tf;
    b.style.opacity = L.op;
    b.style.setProperty("--z", Math.max(0, 1 - Math.abs(d)).toFixed(3));
    b.style.zIndex = String(10 - Math.round(a * 3));
    last[i] = d;
  });
  box._d = last;
  if (!drag) box._target = value;                       // where the strip is (or is heading)
  const pill = pillOf("browseSeg");
  pill.style.transition = "none";
  pill.style.width = `${W}px`;
  pill.style.transform = `translateX(${(mid - W / 2).toFixed(1)}px)`;
}
function placePill(id, value, animate, toValue = null, progress = 0) {
  if (id === "browseSeg" && TAB_CAROUSEL && document.body.classList.contains("tabs-carousel")) return placeCarousel(value, animate, toValue, progress);
  const pill = pillOf(id), a = rectOf(id, value);
  if (!a) return;
  const b = toValue ? rectOf(id, toValue) : null;
  const t = b ? Math.min(1, Math.abs(progress)) : 0;
  const x = a.x + ((b ? b.x : a.x) - a.x) * t, w = a.w + ((b ? b.w : a.w) - a.w) * t;
  pill.style.transition = animate ? "transform .32s cubic-bezier(.2,.8,.2,1), width .32s cubic-bezier(.2,.8,.2,1)" : "none";
  pill.style.width = `${w}px`;
  pill.style.transform = `translateX(${x}px)`;
  if (id === "browseSeg") {
    // during a swipe the zoom (label size + colour) hands over gradually, in step with the finger
    const box = $(id), drag = !!b && t > 0;
    box.classList.toggle("dragging", drag);
    box.querySelectorAll("button").forEach((btn) => {
      if (!drag) { btn.style.removeProperty("--z"); btn.style.zIndex = ""; return; }
      const z = btn.dataset.seg === value ? 1 - t : btn.dataset.seg === toValue ? t : 0;
      btn.style.setProperty("--z", z.toFixed(3));
      btn.style.zIndex = z > 0 ? "3" : "";            // both ends of the swipe stay above the bubble
    });
  }
}
// buttons rebuilt or resized (icons/labels change width): keep the bubble on the right tab
// Re-centre after a real size change, but never mid-swipe, and always on the tab the strip is
// heading to (Android Chrome resizes the page when its address bar slides during a swipe)
const recentreTabs = () => {
  const box = $("browseSeg");
  if (box.classList.contains("dragging") || Date.now() < (box._busyUntil || 0)) return;
  const v = box._target || state.browseSource;
  if (v) placePill("browseSeg", v, false);
};
new ResizeObserver(recentreTabs).observe($("browseSeg"));
window.addEventListener("resize", () => {
  recentreTabs();
  placePill("resultsSeg", state.resultsSource, false);
});

function setBrowseSource(source, force = false) {
  if (source === state.browseSource && !force) return;
  state.browseSource = source;
  setSegmentUI("browseSeg", source);
  state.browse = { photos: [], offset: 0, total: 0, done: false, loading: false };
  $("browseGroups").innerHTML = "";
  $("browseEmpty").hidden = true;
  window.scrollTo(0, 0);
  if (source === "saved") return renderSaved();
  if (source === "top") return renderTop();
  if (source === "booth") return renderBooth();
  if (source === "mine") return renderMine();
  loadMoreBrowse();
}
// "My photos" tab: the photos the guest's selfie search found
function renderMine() {
  state.browse.done = true;
  const list = (state.results && state.results.strong) || [];
  if (list.length) renderGroups($("browseGroups"), list, "browse", false);
  showBrowseEmpty(list.length ? "" : "Do a selfie search to see your photos here.");
}

// Photobooth tab: the vendor's own gallery look - white page, their logo and title,
// one square tile per session (newest first); a tile opens that session's photos.
async function renderBooth() {
  $("browseMore").hidden = false;
  state.browse.done = true;
  try { await Promise.all([listPhotos(0, 1), loadSocial()]); } catch {}   // reactions for the tile badges
  $("browseMore").hidden = true;
  if (state.browseSource !== "booth") return;
  const sessions = buildPosts(manifestCache || []).filter((ps) => ps.by === PHOTOBOOTH_NAME)
    .sort((a, b) => (b.photos[0].taken || "").localeCompare(a.photos[0].taken || ""));
  const c = $("browseGroups");
  const head = document.createElement("div");
  head.className = "booth-head";
  head.innerHTML = '<a class="booth-logo-link" href="' + BOOTH_URL + '" target="_blank" rel="noopener" aria-label="Open the Photobooth gallery"><img class="booth-logo" src="/static/brand/booth-logo.png" alt="Photobooth"></a>'
    + '<button class="booth-share" type="button" aria-label="Share the photobooth gallery"><svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.3M8.3 13.2l7.4 4.3"/></svg></button>';
  head.querySelector(".booth-share").onclick = async () => {
    const data = { title: "Event · Photobooth", text: "Check this out!", url: BOOTH_URL };
    try { if (navigator.share) return await navigator.share(data); } catch { return; }
    try { await navigator.clipboard.writeText(BOOTH_URL); toast("Link copied"); } catch { toast(BOOTH_URL, 4000); }
  };
  const grid = document.createElement("div");
  grid.className = "booth-grid";
  for (const ps of sessions) {
    const photos = ps.photos;                               // vendor order: video, strip, shots
    const cover = photos.filter((p) => p.kind !== "boomerang").slice(-1)[0] || photos[0];
    // feed-style mini carousel: swipe inside the tile, "2/5" top right, dots underneath
    const card = document.createElement("div"); card.className = "booth-card";
    const first = photos[0];
    if (first && first.w && first.h) card.style.setProperty("--ar", `${first.w} / ${first.h}`);   // desktop: real shape
    const t = document.createElement("div"); t.className = "booth-tile post-media";
    t.setAttribute("aria-label", `Photobooth session, ${photos.length} items`);
    const track = document.createElement("div"); track.className = "post-track";
    photos.forEach((p, i) => {
      const s = document.createElement("div"); s.className = "post-slide";
      const im = document.createElement("img");
      im.loading = "lazy"; im.decoding = "async"; im.alt = ""; im.src = abs(p.web || p.thumb);
      im.onload = () => im.classList.add("loaded");
      s.appendChild(im);
      if (p.kind === "boomerang" && (p.video || p.vthumb)) {   // plays muted on its own, like the Feed
        const v = document.createElement("video");
        v.className = "booth-vid focus-vid";
        v.muted = true; v.loop = true; v.playsInline = true; v.preload = "none"; v.poster = abs(p.web);
        v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
        v.dataset.src = abs(p.video || p.vthumb);
        v.onplaying = () => v.classList.add("on");
        boothVideoIO.observe(v);
        s.appendChild(v);
      }
      if (p.kind === "boomerang") { const bb = document.createElement("span"); bb.className = "badge-boom"; bb.textContent = "▶"; s.appendChild(bb); }
      s.onclick = () => openViewer(photos, i, "browse");
      track.appendChild(s);
    });
    t.appendChild(track);
    // the session's reactions + comments, added up across its photos
    const likes = photos.reduce((n, p) => n + likesOf(p.id), 0), cmts = photos.reduce((n, p) => n + (social.comments[p.id] || 0), 0);
    const st = [likes ? `❤️ ${likes}` : "", cmts ? `💬 ${cmts}` : ""].filter(Boolean).join("  ");
    if (st) { const bl = document.createElement("span"); bl.className = "badge-likes"; bl.textContent = st; t.appendChild(bl); }
    card.appendChild(t);
    if (photos.length > 1) {
      const count = document.createElement("span"); count.className = "post-count"; t.appendChild(count);
      const dots = document.createElement("div"); dots.className = "post-dots";
      photos.forEach(() => dots.appendChild(document.createElement("i")));
      card.appendChild(dots);
      const mark = () => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        count.textContent = `${i + 1}/${photos.length}`;
        [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
      };
      track.addEventListener("scroll", mark, { passive: true });
      mark();
    }
    grid.appendChild(card);
  }
  c.replaceChildren(head, grid);
  showBrowseEmpty(sessions.length ? "" : "No photobooth photos yet.");
  updateSegCounts({ ...(state.counts || {}), booth: sessions.length });
}

// ------------------------------------------------------------------ search by name
// people.json (published by the Mac): who is in which photo, from each guest's
// selfie search, linked to the full name they picked. Guest uploads also match
// the name they were shared under.
let people = [], peopleAt = 0;
async function loadPeople(force = false) {
  if (!force && Date.now() - peopleAt < 60000) return;
  try {
    const r = await fetch("/people.json", { cache: "no-cache" });
    if (r.ok) { people = (await r.json()).people || []; peopleAt = Date.now(); }
  } catch {}
}
function searchCandidates(q) {
  const toks = fold(q).split(" ").filter(Boolean);
  if (!toks.length) return [];
  const hit = (s) => { const f = fold(s || ""), w = f.split(" "); return toks.every((t) => w.some((x) => x.startsWith(t)) || f.includes(t)); };
  const out = new Map();
  for (const p of people) {
    if (hit(p.name) || hit(p.nick)) out.set(p.name, { name: p.name, nick: p.nick, ids: new Set(p.photos), by: [p.name, p.nick].filter(Boolean) });
  }
  // guests who shared photos but never did a selfie search
  for (const ph of manifestCache || []) {
    if (ph.source === "guest" && ph.by && hit(ph.by) && ![...out.values()].some((c) => c.by.includes(ph.by)))
      out.set("by:" + ph.by, { name: ph.by, nick: null, ids: new Set(), by: [ph.by] });
  }
  const list = [...out.values()].map((c) => ({ ...c, photos: searchPhotos(c) }));
  const res = list.filter((c) => c.photos.length).sort((a, b) => b.photos.length - a.photos.length).slice(0, 8);
  // the official photographer's account ("Event Photographer", or just "photographer")
  if (hit(PHOTOG_NAME)) {
    const shots = byWho(manifestCache || []).filter((p) => p.source !== "guest");
    if (shots.length) res.unshift({ photog: true, name: PHOTOG_NAME, nick: null, photos: shots });
  }
  return res;
}
function searchPhotos(c) {
  return byWho(manifestCache || []).filter((p) => c.ids.has(p.id) || (p.source === "guest" && c.by.includes(p.by)));
}
function renderSuggest() {
  const q = $("searchInput").value, box = $("searchSuggest");
  $("searchClear").hidden = !q && !state.search;
  box.innerHTML = "";
  if (fold(q).length < 2) { box.hidden = true; $("searchInput").setAttribute("aria-expanded", "false"); return; }
  const list = searchCandidates(q);
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "suggest-empty";
    e.textContent = "No photos found for that name yet. People appear here after they do a selfie search.";
    box.appendChild(e);
  }
  for (const c of list) {
    const o = document.createElement("button");
    o.type = "button"; o.className = "suggest-opt"; o.setAttribute("role", "option");
    const av = document.createElement("img");
    av.className = "suggest-av"; av.alt = ""; av.loading = "lazy"; av.src = abs(c.photos[0].thumb);
    const t = document.createElement("span");
    t.className = "suggest-txt";
    const n = document.createElement("b"); n.textContent = c.nick || c.name;
    const sub = document.createElement("small");
    sub.textContent = c.photog ? `Official photographer · ${c.photos.length} photos`
      : `${c.nick ? c.name + " · " : ""}${c.photos.length} photo${c.photos.length === 1 ? "" : "s"}`;
    t.append(n, sub);
    o.append(av, t);
    o.addEventListener("pointerdown", (e) => e.preventDefault());
    o.onclick = () => {
      if (!c.photog) return applySearch(c);
      $("searchInput").value = ""; $("searchInput").blur(); box.hidden = true; $("searchClear").hidden = !state.search;
      openProfile({ photographer: true });
    };
    box.appendChild(o);
  }
  box.hidden = false;
  $("searchInput").setAttribute("aria-expanded", "true");
}
function applySearch(c) {
  if (!state.search) pushLayer("search", clearSearch);
  state.search = c;
  $("searchInput").value = c.nick || c.name;
  $("searchInput").blur();
  $("searchSuggest").hidden = true;
  $("searchClear").hidden = false;
  const list = searchPhotos(c);
  for (const id of ["feedList", "feedEmpty", "feedPill", "feedMore"]) $(id).hidden = true;
  $("feedList").hidden = true;
  $("feedSearch").hidden = false;
  const head = $("searchHead");
  head.hidden = false;
  head.innerHTML = "";
  const h = document.createElement("h3"); h.textContent = c.nick || c.name;
  const p = document.createElement("p");
  p.textContent = `${list.length} photo${list.length === 1 ? "" : "s"}${c.nick ? " · " + c.name : ""}`;
  head.append(h, p);
  window.scrollTo(0, 0);
  renderGroups($("searchGroups"), list, "browse", false);
  // then everything this person has posted, as feed posts (carousels)
  const posts = buildPosts(manifestCache || []).filter((ps) => c.by.includes(ps.by));
  const frag = document.createDocumentFragment();
  for (const ps of posts) frag.appendChild(makePost(ps));
  $("searchPosts").replaceChildren(frag);
  $("searchPostsTitle").hidden = !posts.length;
  $("searchPostsTitle").textContent = `Posts by ${c.nick || c.name.split(" ")[0]}`;
}
function clearSearch() {
  const was = state.search;
  if (was) dropLayer("search");
  state.search = null;
  $("searchInput").value = "";
  $("searchSuggest").hidden = true;
  $("searchClear").hidden = true;
  $("feedSearch").hidden = true;
  $("searchPosts").replaceChildren();
  $("feedList").hidden = false;
  if (was) renderFeed(true);
}
$("searchInput").addEventListener("focus", async () => { await Promise.all([loadPeople(), listPhotos(0, 1)]); renderSuggest(); });
$("searchInput").addEventListener("input", renderSuggest);
$("searchInput").addEventListener("blur", () => setTimeout(() => { $("searchSuggest").hidden = true; }, 150));
$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); const f = $("searchSuggest").querySelector(".suggest-opt"); if (f) f.click(); }
  if (e.key === "Escape") clearSearch();
});
$("searchClear").onclick = clearSearch;

// ------------------------------------------------------------------ who took it
// Filter beside the search bar: all photos, the photographer's, or guests'.
// Applies to every tab (and Top); remembered on this phone.
let srcFilter = "all";     // All / Photographer / Guests (the small filter button beside the tabs)
function setSrcFilter(v) {
  srcFilter = v;
  $("srcMenu").hidden = true;
  $("srcFilterBtn").querySelector(".src-dot").hidden = v === "all";
  document.querySelectorAll("#srcMenu button").forEach((b) => b.classList.toggle("on", b.dataset.src === v));
  manifestAt = 0;
  if (state.browseSource) setBrowseSource(state.browseSource, true);
  toast(v === "camera" ? "Showing photographer photos" : v === "guest" ? "Showing guest photos" : "Showing all photos");
}
$("srcFilterBtn").onclick = (e) => { e.stopPropagation(); $("srcMenu").hidden = !$("srcMenu").hidden; };
document.querySelectorAll("#srcMenu button").forEach((b) => { b.onclick = () => setSrcFilter(b.dataset.src); });
document.addEventListener("click", (e) => { if (!e.target.closest("#srcMenu")) $("srcMenu").hidden = true; });
document.querySelector('#srcMenu [data-src="all"]').classList.add("on");
const byWho = (list) => srcFilter === "all" ? list : list.filter((p) => (p.source || "camera") === srcFilter);

// Most liked: every photo with at least one reaction, ranked (no time sections).
async function renderTop() {
  $("browseMore").hidden = false;
  state.browse.done = true;
  await Promise.all([loadSocial(true), listPhotos(0, 1)]);
  $("browseMore").hidden = true;
  if (state.browseSource !== "top") return;
  const live = openPrograms().length > 0;    // during the event: only event photos
  const list = byWho(manifestCache || []).filter((p) => !isBooth(p) && likesOf(p.id) > 0 && (!live || programOf(p)))
    .sort((a, b) => likesOf(b.id) - likesOf(a.id) || (b.taken || "").localeCompare(a.taken || ""));
  const c = $("browseGroups");
  c.innerHTML = "";
  if (list.length) {
    const h = document.createElement("div");
    h.className = "top-head";
    h.innerHTML = `<h3>Most liked</h3><p>${list.length} photo${list.length === 1 ? "" : "s"} with reactions · tap one to react</p>`;
    const g = makeJustified(list, list, "browse", false);
    c.append(h, g);
    layoutJustified(g);
  }
  showBrowseEmpty(list.length ? "" : "No reactions yet. Open any photo and tap ❤️ 😂 😮 👏 🔥.");
}

function renderSaved() {
  const list = favList();
  $("browseMore").hidden = true;
  state.browse.done = true;
  renderGroups($("browseGroups"), list, "browse", false);
  showBrowseEmpty(list.length ? "" : "Tap ♥ on any photo to keep it here. Saved on this phone only.");
  updateSegCounts();
}

function showBrowseEmpty(msg) {
  $("browseEmpty").hidden = !msg;
  $("browseEmpty").innerHTML = msg ? `<p class="muted">${msg}</p>` : "";
}

function updateSegCounts(counts) {
  if (counts) state.counts = counts;
  const c = { ...(state.counts || {}) };
  if (manifestCache) c.top = manifestCache.filter((p) => !isBooth(p) && likesOf(p.id) > 0).length;   // photos with reactions
  if (state.results) c.mine = (state.results.strong || []).length;
  document.querySelectorAll("#browseSeg button").forEach((b) => {
    const n = c[b.dataset.seg], slot = b.querySelector(".seg-count");
    if (slot) slot.textContent = n ? n.toLocaleString() : "";
  });
}

$("browseSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-seg]"); if (b) setBrowseSource(b.dataset.seg); });
$("resultsSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-seg]"); if (b) setResultsSource(b.dataset.seg); });

function setResultsSource(source) {
  state.resultsSource = source;
  setSegmentUI("resultsSeg", source);
  if (state.results) renderResults(state.results);
}

async function loadMoreBrowse() {
  const b = state.browse;
  const source = state.browseSource;
  if (b.loading || b.done || source === "saved" || source === "top" || state.search) return;
  b.loading = true;
  $("browseMore").hidden = false;
  try {
    const [data] = await Promise.all([listPhotos(b.offset, 60, source), loadSocial()]);
    if (source !== state.browseSource) return;   // filter changed mid-request
    b.photos.push(...data.photos);
    b.offset += data.photos.length;
    b.total = data.total;
    b.done = b.offset >= data.total || !data.photos.length;
    renderGroups($("browseGroups"), b.photos, "browse", false);
    updateSegCounts(data.counts);
    setTimeout(nearBottomLoad, 300);   // short page? keep filling
    showBrowseEmpty(b.photos.length ? "" : srcFilter === "camera" ? "No photographer photos here yet."
      : `No ${srcFilter === "guest" ? "guest " : ""}${source === "all" ? "" : segLabel(source) + " "}photos yet. Tap Share photos to add yours.`);
  } catch {
    toast("Couldn't load photos");
  } finally {
    b.loading = false;
    $("browseMore").hidden = b.done;
  }
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && $("browse").classList.contains("active")) loadMoreBrowse();
}, { rootMargin: "800px" }).observe($("browseMore"));
// Backup for the observer (it can miss when the loader appears already on screen):
// near the bottom of the page -> load the next batch.
function nearBottomLoad() {
  if (!$("browse").classList.contains("active") || state.browse.done || state.browse.loading) return;
  if (window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 1200) loadMoreBrowse();
}
window.addEventListener("scroll", nearBottomLoad, { passive: true });

// Swipe left/right on the gallery to change filter (buttons stay the main way).
// Swipe the gallery left/right to change tab. The grid follows your finger (with
// rubber-banding at the first/last tab), the tab pill tracks along; let go past
// ~25% of the width or flick, and the next tab slides in. Like Android/iOS pagers.
function swipeSegments(screen, content, segId, getList, getValue, setValue, enabled = () => true) {
  let x0, y0, t0, axis = null, dx = 0, active = false;
  const W = () => screen.clientWidth || window.innerWidth;
  const ease = "cubic-bezier(.2,.8,.2,1)";

  screen.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || state.selecting || !$("viewer").hidden || !enabled()
        ) { active = false; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = performance.now();
    axis = null; dx = 0; active = true;
  }, { passive: true });

  screen.addEventListener("touchmove", (e) => {
    if (!active) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (axis === null && Math.abs(mx) + Math.abs(my) > 10) axis = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
    if (axis !== "x") return;
    if (e.cancelable) e.preventDefault();              // we own horizontal drags
    content.style.willChange = "transform, opacity";
    const list = getList(), i = list.indexOf(getValue());
    const wrap = segId === "browseSeg" && document.body.classList.contains("tabs-carousel");
    const at = (k) => wrap ? list[(k + list.length) % list.length] : list[k];
    const toward = mx < 0 ? at(i + 1) : at(i - 1);
    dx = toward ? mx : mx * 0.28;                       // rubber band at the ends
    content.style.transition = "none";
    content.style.transform = `translate3d(${dx}px,0,0)`;
    content.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / W() * 0.6));
    if (toward) placePill(segId, getValue(), false, toward, dx / W() * 1.6);
    else placePill(segId, getValue(), false);
  }, { passive: false });

  const end = () => {
    if (!active) return;
    active = false;
    if (axis !== "x") return;
    const list = getList(), i = list.indexOf(getValue());
    const v = dx / Math.max(1, performance.now() - t0);  // px per ms
    const dir = dx < 0 ? 1 : -1;
    const wrapE = segId === "browseSeg" && document.body.classList.contains("tabs-carousel");
    const next = wrapE ? list[(i + dir + list.length) % list.length] : list[i + dir];
    const commit = next && (Math.abs(dx) > W() * 0.25 || (Math.abs(v) > 0.6 && Math.abs(dx) > 60));
    if (!commit) {                                      // spring back
      content.style.transition = `transform .3s ${ease}, opacity .3s`;
      content.style.transform = "translate3d(0,0,0)";
      content.style.opacity = "1";
      placePill(segId, getValue(), true);
      setTimeout(() => { content.style.transition = ""; content.style.transform = ""; content.style.opacity = ""; content.style.willChange = ""; }, 350);
      return;
    }
    // slide out, switch tab, slide the new tab in from the other side
    content.style.transition = `transform .18s ${ease}, opacity .18s`;
    content.style.transform = `translate3d(${-dir * W()}px,0,0)`;
    content.style.opacity = "0";
    // mark the new tab selected right away, so the zoom carries straight on from the
    // finger instead of springing back to the old tab for a moment
    $(segId).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.seg === next));
    pillOf(segId).dataset.swiped = next;
    $(segId)._busyUntil = Date.now() + 700;
    placePill(segId, next, true);
    setTimeout(() => {
      setValue(next);
      content.style.transition = "none";
      content.style.transform = `translate3d(${dir * W() * 0.35}px,0,0)`;
      void content.offsetWidth;                         // apply the start position now (no rAF wait)
      content.style.transition = `transform .32s ${ease}, opacity .32s`;
      content.style.transform = "translate3d(0,0,0)";
      content.style.opacity = "1";
      // safety net: never leave the gallery off-screen or invisible
      setTimeout(() => { content.style.transition = ""; content.style.transform = ""; content.style.opacity = ""; content.style.willChange = ""; }, 450);
    }, 180);
  };
  screen.addEventListener("touchend", end);
  screen.addEventListener("touchcancel", end);
}
swipeSegments($("browse"), $("browseGroups"), "browseSeg", browseSegments, () => state.browseSource,
  (v) => setBrowseSource(v), () => !state.search);
swipeSegments($("results"), $("resultsGroups"), "resultsSeg", resultsSegments, () => state.resultsSource,
  (v) => setResultsSource(v), () => !$("resultsSeg").hidden);
requestAnimationFrame(() => { placePill("browseSeg", state.browseSource, false); placePill("resultsSeg", state.resultsSource, false); });

// ------------------------------------------------------------------ viewer
const viewer = state.viewer;

function openViewer(list, index, context, burst = false) {
  viewer.burst = burst;
  viewer.list = list;
  viewer.index = Math.max(0, index);
  viewer.context = context;
  const track = $("viewerTrack");
  track.innerHTML = "";
  list.forEach(() => {
    const s = document.createElement("div");
    s.className = "viewer-slide";
    track.appendChild(s);
  });
  $("viewer").hidden = false;
  $("viewer").classList.remove("bare");
  document.body.style.overflow = "hidden";
  goTo(viewer.index, false);
}

function loadSlide(i) {
  const slide = $("viewerTrack").children[i];
  if (!slide || slide.firstChild) return;
  const p = viewer.list[i];
  if (p.kind === "boomerang" && p.video) {
    const v = document.createElement("video");
    v.src = abs(p.video); v.poster = abs(p.web);
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("autoplay", "");
    if (p.vid) { v.controls = true; v.loop = false; }       // a guest's video: sound on tap, play/pause/seek
    slide.classList.toggle("land", !(p.w && p.h) || p.w >= p.h * 1.05);
    slide.appendChild(v);
    v.play().catch(() => {});
    return;
  }
  const img = document.createElement("img");
  img.src = abs(p.web);
  img.alt = "Event photo";
  // Portrait photos use the full screen height and sit under the fading
  // controls; landscape ones are centred in the clear space above them.
  const land = !(p.w && p.h) || p.w >= p.h * 1.05;
  slide.classList.toggle("land", land);
  img.onload = () => slide.classList.toggle("land", img.naturalWidth >= img.naturalHeight * 1.05);
  slide.appendChild(img);
}

function goTo(i, animate = true) {
  if (zoom.on) zoomOut();
  viewer.index = Math.max(0, Math.min(viewer.list.length - 1, i));
  const track = $("viewerTrack");
  track.style.transition = animate ? "transform .28s cubic-bezier(.2,.8,.2,1)" : "none";
  track.style.transform = `translateX(${-viewer.index * 100}%)`;
  [viewer.index, viewer.index + 1, viewer.index - 1].forEach(loadSlide);
  $("viewerCount").textContent = `${viewer.index + 1} / ${viewer.list.length}`;
  $("viewerPrev").hidden = viewer.index <= 0;                       // desktop arrows (CSS hides them on phones)
  $("viewerNext").hidden = viewer.index >= viewer.list.length - 1;
  [0, 1, -1].forEach((d) => prepShare(viewer.list[viewer.index + d], d === 0));
  const vd = $("viewerDots"), many = viewer.list.length > 1 && viewer.list.length <= 12 && (viewer.list.every(isBooth) || viewer.burst);
  vd.hidden = !many;
  if (many) {
    if (vd.children.length !== viewer.list.length) vd.replaceChildren(...viewer.list.map(() => document.createElement("i")));
    [...vd.children].forEach((d, k) => d.classList.toggle("on", k === viewer.index));
  }
  const cur = viewer.list[viewer.index];
  renderCaption(cur);
  $("saveBtn").lastChild.textContent = cur.kind === "boomerang" ? (isBooth(cur) || cur.vid ? " Save video" : " Save boomerang") : " Save photo";
  renderReactions(cur.id);
  $("reactWho").textContent = "";
  loadReactors(cur.id);
  const showFeedback = viewer.context === "results";
  $("viewerFeedback").hidden = !showFeedback;
  if (showFeedback) {
    const v = state.verdicts[viewer.list[viewer.index].id];
    document.querySelectorAll("#viewerFeedback .chip").forEach((c) => c.classList.toggle("on", c.dataset.verdict === v));
  }
}

// Keep the photo area in step with the size of the overlay panels.
new ResizeObserver(() => {
  const v = $("viewer");
  v.style.setProperty("--vb-h", `${v.querySelector(".viewer-bottom").offsetHeight}px`);
  v.style.setProperty("--vt-h", `${v.querySelector(".viewer-top").offsetHeight}px`);
}).observe(document.querySelector("#viewer .viewer-bottom"));
// mouse / desktop: click the photo to hide or show the controls
$("viewerStage").addEventListener("click", (e) => { if (!("ontouchstart" in window) && !zoom.on) $("viewer").classList.toggle("bare"); });
$("viewerStage").addEventListener("dblclick", (e) => { if ("ontouchstart" in window) return; zoom.on ? zoomOut() : zoomIn(e.clientX, e.clientY); });

// ---- double-tap to zoom (drag to look around); Back zooms out before closing
const zoom = { on: false, el: null, s: 2.5, tx: 0, ty: 0, w: 0, h: 0 };
function zoomApply(anim) {
  const z = zoom.el;
  if (!z) return;
  z.style.transition = anim ? "transform .26s cubic-bezier(.2,.8,.2,1)" : "none";
  z.style.transformOrigin = "0 0";
  z.style.transform = zoom.on ? `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})` : "";
}
function zoomIn(cx, cy) {
  const img = $("viewerTrack").children[viewer.index]?.querySelector("img");
  if (!img) return;                                   // videos don't zoom
  const r = img.getBoundingClientRect();
  if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
  Object.assign(zoom, { on: true, el: img, w: r.width, h: r.height });
  const px = cx - r.left, py = cy - r.top;            // keep the tapped spot under the finger
  zoom.tx = px * (1 - zoom.s); zoom.ty = py * (1 - zoom.s);
  zoomClamp();
  zoomApply(true);
  $("viewer").classList.add("zoomed", "bare");
  pushLayer("zoom", () => zoomOut(true));
}
function zoomClamp() {
  zoom.tx = Math.min(0, Math.max(zoom.w * (1 - zoom.s), zoom.tx));
  zoom.ty = Math.min(0, Math.max(zoom.h * (1 - zoom.s), zoom.ty));
}
function zoomOut(fromBack = false) {
  if (!zoom.on) return;
  zoom.on = false;
  zoomApply(true);
  $("viewer").classList.remove("zoomed", "bare");
  if (!fromBack) dropLayer("zoom");
}

function closeViewer() {
  if (zoom.on) zoomOut();
  $("viewer").hidden = true;
  $("commentSheet").hidden = true;
  document.body.style.overflow = "";
  if (state.browseSource === "saved" && $("browse").classList.contains("active")) renderSaved();
}
$("viewerClose").onclick = closeViewer;
$("viewerPrev").onclick = () => goTo(viewer.index - 1);
$("viewerNext").onclick = () => goTo(viewer.index + 1);
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden) return;
  if (e.key === "ArrowRight") goTo(viewer.index + 1);
  if (e.key === "ArrowLeft") goTo(viewer.index - 1);
  if (e.key === "Escape") closeViewer();
});

// swipe
(() => {
  const stage = $("viewerStage");
  let x0 = null, y0 = null, dx = 0, horizontal = null;
  let lastTap = 0, tapTimer = null, panX = 0, panY = 0;
  // Listen on the whole viewer: the caption/reaction panel overlays the lower part
  // of the photo, and swipes that started there used to do nothing. Touches on
  // buttons, fields and the desktop side panel are left alone.
  const area = $("viewer");
  const skip = (t) => t.closest && (t.closest("button, a, input, textarea, select, label, [contenteditable], .react-sheet, .sheet")
    || (innerWidth >= 900 && t.closest(".viewer-bottom")));
  area.addEventListener("touchstart", (e) => {
    if (e.touches.length > 1 || skip(e.target)) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null;
    panX = zoom.tx; panY = zoom.ty;
    $("viewerTrack").style.transition = "none";
  }, { passive: true });
  area.addEventListener("touchmove", (e) => {
    if (x0 === null) return;
    if (zoom.on) {                                      // zoomed: drag to look around
      zoom.tx = panX + e.touches[0].clientX - x0; zoom.ty = panY + e.touches[0].clientY - y0;
      zoomClamp(); zoomApply(false);
      dx = 99; return;
    }
    dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) horizontal = Math.abs(dx) > Math.abs(dy);
    if (horizontal) {
      const w = stage.clientWidth;
      $("viewerTrack").style.transform = `translateX(calc(${-viewer.index * 100}% + ${dx}px))`;
      if (Math.abs(dx) > w * 0.02) [viewer.index + 1, viewer.index - 1].forEach(loadSlide);
    }
  }, { passive: true });
  area.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const t = e.changedTouches && e.changedTouches[0];
    const tap = horizontal === null && Math.abs(dx) < 4 && t && Math.abs(t.clientY - y0) < 10;
    if (tap) {
      const now = Date.now();
      if (now - lastTap < 300) {                        // double tap: zoom in / out
        clearTimeout(tapTimer); lastTap = 0;
        if (zoom.on) zoomOut(); else zoomIn(t.clientX, t.clientY);
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => { if (!zoom.on) $("viewer").classList.toggle("bare"); }, 300);   // single tap: controls
      }
      x0 = null; return;
    }
    if (zoom.on) { x0 = null; return; }
    if (horizontal) {
      const w = stage.clientWidth;
      if (dx < -w * 0.18) goTo(viewer.index + 1);
      else if (dx > w * 0.18) goTo(viewer.index - 1);
      else goTo(viewer.index);
    }
    x0 = null;
  });
})();

// feedback
document.querySelectorAll("#viewerFeedback .chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    const photo = viewer.list[viewer.index];
    const verdict = chip.dataset.verdict;
    state.verdicts[photo.id] = verdict;
    goTo(viewer.index, false);
    try {
      const data = await api(`/api/session/${state.sid}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo_id: photo.id, verdict }),
      });
      const before = state.results.strong.length;
      renderResults(data);
      if (verdict === "not_me") {
        toast("Removed from your photos");
        closeViewer();
      } else {
        const gained = data.strong.length - before;
        toast(gained > 0 ? `Thanks! Found ${gained} more` : "Thanks!");
      }
    } catch {
      toast("Couldn't save that. Try again.");
    }
  });
});

// Under the photo: "Alex  caption…" (guest photos) and the first comment, so
// people see the conversation without opening the comments sheet.
function renderCaption(p) {
  const cap = social.captions[p.id];
  const mine = (cap && cap.mine) || myUploads().has(p.id);
  const credit = $("viewerCredit"), box = $("vCaption");
  const guestCredit = p.by ? `Shared by ${p.by}` : "Guest photo";   // nickname / full name, else just "Guest photo"
  credit.textContent = p.source === "guest" ? guestCredit : "Photographer";
  box.innerHTML = "";
  box.hidden = !(cap || mine);
  if (cap) {
    credit.textContent = p.source === "guest" ? guestCredit : "Photographer";
    const b = document.createElement("b");
    b.textContent = cap.name || p.by || "Guest";
    const t = document.createElement("span");
    t.textContent = cap.body;
    box.append(b, " ", t);
    box.classList.toggle("long", cap.body.length > 90);
  }
  if (mine) {
    const e = document.createElement("button");
    e.type = "button"; e.className = "link-btn cap-edit";
    e.textContent = cap ? "Edit" : "+ Add a caption";
    e.onclick = (ev) => { ev.stopPropagation(); openCaptionEditor(p.id); };
    box.append(cap ? " " : "", e);
  }
}
$("vCaption").onclick = () => $("vCaption").classList.toggle("open");   // tap long captions to expand

function renderFirstComment(id) {
  const box = $("vComment"), n = social.comments[id] || 0, first = social.firstComment[id];
  box.innerHTML = "";
  if (!n || !first) {
    box.className = "v-comment empty";
    box.textContent = "Add a comment…";
    return;
  }
  box.className = "v-comment";
  const line = document.createElement("span");
  line.className = "v-comment-line";
  const b = document.createElement("b");
  b.textContent = first.name || "Guest";
  line.append(b, " ", first.body);
  box.append(line);
  if (n > 1) {
    const more = document.createElement("span");
    more.className = "v-comment-more";
    more.textContent = `View all ${n} comments`;
    box.append(more);
  }
}
$("vComment").onclick = () => openComments(viewer.list[viewer.index].id);

let captionPhoto = null;
function openCaptionEditor(id) {
  captionPhoto = id;
  const cap = social.captions[id];
  $("captionTitle").textContent = cap ? "Edit caption" : "Add a caption";
  $("captionInput").value = cap ? cap.body : "";
  $("captionSheet").hidden = false;
  setTimeout(() => $("captionInput").focus(), 250);
}
$("captionCancel").onclick = () => ($("captionSheet").hidden = true);
$("captionSheet").addEventListener("click", (e) => { if (e.target.id === "captionSheet") $("captionSheet").hidden = true; });
$("captionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("captionInput").value.replace(/\s+/g, " ").trim().slice(0, 150);
  try {
    await postCaption(captionPhoto, text);
    $("captionSheet").hidden = true;
    const cur = viewer.list[viewer.index];
    if (cur && cur.id === captionPhoto) renderCaption(cur);
    toast(text ? "Caption saved" : "Caption removed");
  } catch { toast("Couldn't save the caption. Try again."); }
});

function renderReactions(id) {
  const mine = new Set(social.mine[id] || []);
  const counts = social.reactions[id] || {};
  $("reactBar").innerHTML = social.emojis.map((e) =>
    `<button class="react-btn${mine.has(e) ? " on" : ""}" data-emoji="${e}">${e}${counts[e] ? ` <span>${counts[e]}</span>` : ""}</button>`).join("");
  const n = social.comments[id] || 0;
  $("commentCount").textContent = n ? n : "";
  renderFirstComment(id);
}

$("reactBar").addEventListener("click", async (e) => {
  const b = e.target.closest(".react-btn");
  if (!b) return;
  const id = viewer.list[viewer.index].id, emoji = b.dataset.emoji;
  const on = toggleMine(id, emoji);   // instant on screen, saved in the background
  renderReactions(id);
  const nb = $("reactBar").querySelector(`[data-emoji="${emoji}"]`);
  if (on && nb) { nb.classList.add("pop"); setTimeout(() => nb.classList.remove("pop"), 160); }
  updateTileBadge(id);
  try {
    const r = await fetch("/api/social/react", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo_id: id, device: uploaderId(), emoji, on, name: lsGet(NAME_KEY), us: myUsList() }) });
    if (r.ok) { social.reactions[id] = (await r.json()).counts; if (viewer.list[viewer.index].id === id) { renderReactions(id); loadReactors(id, true); } updateTileBadge(id); }
  } catch { toast("Couldn't save your reaction"); }
});

// "❤️🔥 Alex, Sara and 3 others" under the reaction buttons
const reactorCache = {};
let reactorTimer;
function loadReactors(id, force = false) {
  clearTimeout(reactorTimer);
  if (!likesOf(id)) { $("reactWho").textContent = ""; return; }
  if (!force && reactorCache[id]) return showReactors(id);
  reactorTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/social/reactors?photo_id=${id}`);
      if (r.ok) { reactorCache[id] = (await r.json()).reactors; if (viewer.list[viewer.index].id === id) showReactors(id); }
    } catch {}
  }, force ? 0 : 250);
}
// Tap "❤️ Alex, Siti and 3 others" for everyone who reacted
function openReactors(id) {
  const list = reactorCache[id] || [];
  if (!list.length) return;
  const box = $("reactList");
  box.replaceChildren(...list.map((x) => {
    const row = document.createElement("div"); row.className = "react-row";
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av, null, x.name);
    const n = document.createElement("b"); n.textContent = x.name || "Guest";
    const e = document.createElement("span"); e.className = "react-emoji"; e.textContent = x.emoji;
    row.append(av, n, e);
    return row;
  }));
  $("reactTitle").textContent = `${list.length} reaction${list.length === 1 ? "" : "s"}`;
  $("reactSheet").hidden = false;
}
function showReactors(id) {
  const list = reactorCache[id] || [];
  const box = $("reactWho");
  box.textContent = "";
  if (!list.length) return;
  const emojis = [...new Set(list.map((x) => x.emoji))].slice(0, 3).join("");
  const names = [...new Set(list.map((x) => x.name))];
  const shown = names.slice(0, 2), rest = names.length - shown.length;
  box.append(emojis + " ");
  shown.forEach((n, i) => {
    const b = document.createElement("b");
    b.textContent = n;
    box.append(b);
    if (i < shown.length - 1) box.append(rest ? ", " : " and ");
  });
  if (rest) box.append(` and ${rest} other${rest === 1 ? "" : "s"}`);
}

function updateTileBadge(id) {
  document.querySelectorAll(`.tile[data-id="${id}"]`).forEach((tile) => {
    let badge = tile.querySelector(".badge-likes");
    const text = tileStats(id);
    if (!text) { badge && badge.remove(); return; }
    if (!badge) { badge = document.createElement("span"); badge.className = "badge-likes"; tile.appendChild(badge); }
    badge.textContent = text;
  });
}

// ----- comments sheet
let commentPhoto = null;
const timeAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
};
function renderComments(list) {
  const box = $("commentList");
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<p class="muted" style="text-align:center;padding:18px 0">No comments yet. Say something nice!</p>`; return; }
  for (const c of list) {
    const d = document.createElement("div");
    d.className = "comment";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = c.name || "Guest";
    const t = document.createElement("span");
    t.textContent = timeAgo(c.at);
    who.appendChild(t);
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = c.body;
    const like = document.createElement("button");                 // ❤️ like a comment
    like.type = "button"; like.className = "c-like" + (c.liked ? " on" : "");
    like.setAttribute("aria-label", "Like comment");
    const paint = () => { like.innerHTML = `<svg viewBox="0 0 24 24">${HEART_PATH}</svg>${c.likes ? `<span>${c.likes}</span>` : ""}`; like.classList.toggle("on", !!c.liked); };
    paint();
    like.onclick = async () => {
      c.liked = !c.liked; c.likes = Math.max(0, (c.likes || 0) + (c.liked ? 1 : -1)); paint();   // instant, then confirm
      try {
        const r = await fetch(`/api/social/comments/${c.id}/like`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ device: uploaderId() }) });
        if (r.ok) { const x = await r.json(); c.liked = x.liked; c.likes = x.likes; paint(); }
      } catch {}
    };
    d.append(who, body, like);
    if (c.mine) {
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "Delete";
      del.onclick = async () => {
        await fetch(`/api/social/comments/${c.id}?device=${encodeURIComponent(uploaderId())}`, { method: "DELETE" }).catch(() => {});
        social.comments[commentPhoto] = Math.max(0, (social.comments[commentPhoto] || 1) - 1);
        openComments(commentPhoto);
      };
      d.appendChild(del);
    }
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}
async function openComments(id) {
  commentPhoto = id;
  $("commentSheet").hidden = false;
  $("commentAs").innerHTML = "";
  $("commentAs").append(`Posting as ${lsGet(NAME_KEY) || "Guest"} · `);
  const ch = document.createElement("button");
  ch.type = "button"; ch.className = "link-btn"; ch.textContent = "Change name";
  ch.onclick = () => askName(true);
  $("commentAs").append(ch);
  $("commentList").innerHTML = `<p class="muted" style="text-align:center;padding:18px 0">Loading…</p>`;
  try {
    const r = await fetch(`/api/social/comments?photo_id=${id}&device=${encodeURIComponent(uploaderId())}`);
    const d = await r.json();
    social.comments[id] = d.comments.length;
    if (d.comments.length) social.firstComment[id] = { name: d.comments[0].name || "Guest", body: d.comments[0].body };
    else delete social.firstComment[id];
    renderComments(d.comments);
    updateTileBadge(id);
    if (!$("viewer").hidden && viewer.list[viewer.index]) renderReactions(viewer.list[viewer.index].id);
    updateFeedPhoto(id);
  } catch { $("commentList").innerHTML = `<p class="muted">Couldn't load comments.</p>`; }
}
$("commentBtn").onclick = () => openComments(viewer.list[viewer.index].id);
$("commentSheet").addEventListener("click", (e) => { if (e.target.id === "commentSheet") $("commentSheet").hidden = true; });
$("commentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("commentInput").value.trim();
  if (!body || !commentPhoto) return;
  $("commentSend").disabled = true;
  try {
    const r = await fetch("/api/social/comments", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo_id: commentPhoto, device: uploaderId(), name: lsGet(NAME_KEY), body }) });
    if (r.status === 429) toast("Slow down a little 🙂");
    else if (!r.ok) toast("Couldn't post. Try again.");
    else { $("commentInput").value = ""; await openComments(commentPhoto); }
  } catch { toast("Couldn't post. Try again."); }
  $("commentSend").disabled = false;
});

// ------------------------------------------------------------------ saving
async function photoFile(p) {
  if (p.kind === "boomerang" && p.video) {
    const r = await fetch(abs(p.video));
    return new File([await r.blob()], `event-boomerang-${p.id}.mp4`, { type: "video/mp4" });
  }
  let res = p.full ? await fetch(abs(p.full)).catch(() => null) : null;
  if (!res || !res.ok) res = await fetch(abs(p.web));
  const blob = await res.blob();
  return new File([blob], `event-photos-${p.id}.jpg`, { type: "image/jpeg" });
}

// Share one photo/video to WhatsApp and other apps Safari only opens the share
// sheet straight from a tap, so the file is fetched ahead (prepShare) and the tap
// itself never waits; if it isn't ready yet, the album link is shared instead.
const shareFiles = new Map();
const sharePrepIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && e.target._cur) prepShare(e.target._cur()); }), { rootMargin: "200px" });
function prepShare(p, withVideo = false) {
  if (!p || shareFiles.has(p.id) || !navigator.canShare) return;
  const vid = p.kind === "boomerang" || p.vid;
  if (vid && !withVideo) return;              // videos can be big: only the one on screen
  shareFiles.set(p.id, null);
  const url = abs(vid ? (p.video || p.vthumb) : p.web);
  fetch(url).then((r) => r.ok ? r.blob() : null).then((b) => {
    if (!b) return shareFiles.delete(p.id);
    const f = new File([b], `event-${p.id}.${vid ? "mp4" : "jpg"}`, { type: vid ? "video/mp4" : "image/jpeg" });
    if (navigator.canShare({ files: [f] })) shareFiles.set(p.id, f);
  }).catch(() => shareFiles.delete(p.id));
}
function shareToApps(p) {
  if (!p) return;
  const text = "From the Event album 📸";
  const f = shareFiles.get(p.id);
  const data = f ? { files: [f], text } : { text, url: location.origin };
  if (navigator.share) {
    navigator.share(data).catch((err) => {
      if (err && err.name === "AbortError") return;
      if (f) navigator.share({ text, url: location.origin }).catch(() => {});
    });
    return;
  }
  navigator.clipboard.writeText(location.origin).then(() => toast("Album link copied"), () => toast(location.origin, 4000));
}

// Feed: confirm before downloading (the icon is easy to tap by accident while scrolling)
function askSave(p) {
  if (!p) return;
  const vid = p.kind === "boomerang";
  $("saveAskImg").src = abs(p.thumb || p.web);
  $("saveAskTitle").textContent = vid ? "Save this video?" : "Save this photo?";
  $("saveAskGo").textContent = vid ? "Save video" : "Save photo";
  $("saveAskGo").onclick = () => { $("saveAsk").hidden = true; savePhotos([p]); };
  $("saveAsk").hidden = false;
}

// iOS: the share sheet's "Save Image" puts photos straight into Photos.
// A plain download would land in Files, which guests don't expect.
async function savePhotos(list) {
  if (!list.length) return;
  try {
    const files = await Promise.all(list.map(photoFile));
    // Only iPhone/iPad use the share sheet (its "Save Image" is the only way into Photos).
    // Android and laptops download straight to the gallery / Downloads folder.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && navigator.canShare && navigator.canShare({ files })) {
      const vid = files.some((f) => f.type.startsWith("video"));
      toast(`Tap “Save ${vid ? "Video" : "Image"}” to keep it in Photos`, 3500);
      await navigator.share({ files });
      return true;
    }
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      await new Promise((r) => setTimeout(r, 250));
    }
    toast(list.length > 1 ? `${list.length} saved to your device` : "Saved to your device");
    return true;
  } catch (err) {
    if (err && err.name === "AbortError") return false; // guest closed the share sheet
    toast("Couldn't save. Press and hold the photo to save it instead.", 4000);
    return false;
  }
}

$("saveBtn").onclick = () => savePhotos([viewer.list[viewer.index]]);
$("shareBtn").onclick = () => shareToApps(viewer.list[viewer.index]);

// ------------------------------------------------------------------ multi-select
function setSelecting(on) {
  state.selecting = on;
  state.selected.clear();
  document.body.classList.toggle("selecting", on);
  document.querySelectorAll(".tile.selected").forEach((t) => t.classList.remove("selected"));
  $("selectBar").hidden = !on;
  updateSelectCount();
}
function toggleSelect(el, id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  el.classList.toggle("selected", state.selected.has(id));
  updateSelectCount();
}
function updateSelectCount() {
  const n = state.selected.size;
  $("selectCount").textContent = `${n} selected`;
  $("selectSave").disabled = n === 0;
}
$("selectBtn").onclick = () => setSelecting(true);
$("selectCancel").onclick = () => setSelecting(false);
$("selectSave").onclick = async () => {
  const all = [...state.results.strong, ...state.results.possible];
  const list = all.filter((p) => state.selected.has(p.id));
  if (await savePhotos(list)) setSelecting(false);
};

// ------------------------------------------------------------------ guest upload
const UID_KEY = "event_uid", CODE_KEY = "event_code", NAME_KEY = "event_name", FULLNAME_KEY = "event_fullname";
const MAX_UPLOAD = 40;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// The QR code link carries the event code (?code=ABC234); keep it, then tidy the URL.
(() => {
  const c = new URLSearchParams(location.search).get("code");
  if (c) {
    lsSet(CODE_KEY, c.trim().toUpperCase());
    history.replaceState(null, "", location.pathname);
  }
})();

function uploaderId() {
  let id = lsGet(UID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "");
    lsSet(UID_KEY, id);
  }
  return id;
}

const MY_UPLOADS_KEY = "event_my_uploads";
const myUploads = () => { try { return new Set(JSON.parse(lsGet(MY_UPLOADS_KEY) || "[]")); } catch { return new Set(); } };
function rememberUpload(id) { const m = myUploads(); m.add(id); lsSet(MY_UPLOADS_KEY, JSON.stringify([...m].slice(-200))); setTimeout(saveProfile, 1500); }

// The indexer names a guest photo "g" + sha1(file bytes)[:11]; the phone computes
// the same ID so it can attach the caption without waiting for the Mac/Pi.
async function guestPhotoId(blob) {
  if (!crypto.subtle) return null;
  const h = new Uint8Array(await crypto.subtle.digest("SHA-1", await blob.arrayBuffer()));
  return "g" + [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 11);
}

let compose = [];   // [{ file, url }]
function uploadMode(mode) {          // "pick" | "compose" | "busy"
  $("upActions").hidden = mode !== "pick";
  $("upAs").hidden = mode !== "pick";
  $("upIntro").hidden = mode !== "pick";
  $("upCompose").hidden = mode === "pick";
  $("upCancel").hidden = mode === "busy";
  $("upPost").disabled = $("upBack").disabled = mode === "busy";
  $("upBack").hidden = mode === "busy";
  $("upStrip").classList.toggle("busy", mode === "busy");
}
function clearCompose() {
  compose.forEach((c) => { if (c.url) URL.revokeObjectURL(c.url); });
  bounceGen++;
  compose = [];
  $("upStrip").innerHTML = "";
}
function showUploadNote(text) { $("upNote").textContent = text; $("upNote").hidden = false; }
function openUpload() {
  clearCompose();
  $("upNote").hidden = true;
  renderShareAs();
  $("upProgress").hidden = true;
  $("uploadTitle").textContent = "Share your moments";
  uploadMode("pick");
  $("upChoose").disabled = false;
  $("upCamera").disabled = false;
  $("uploadSheet").hidden = false;
}
function closeUpload() {
  if ($("upCompose").hidden === false && $("upStrip").classList.contains("busy")) return;  // sharing in progress
  $("uploadSheet").hidden = true;
  clearCompose();
}
$("homeUploadBtn").onclick = openUpload;
$("reactWho").onclick = () => { const p = viewer.list[viewer.index]; if (p) openReactors(p.id); };
$("reactSheet").addEventListener("click", (e) => { if (e.target.id === "reactSheet") $("reactSheet").hidden = true; });
$("saveAskNo").onclick = () => { $("saveAsk").hidden = true; };
$("saveAsk").addEventListener("click", (e) => { if (e.target.id === "saveAsk") $("saveAsk").hidden = true; });
// Round Find / Share buttons: the first tap opens both into labelled pills, the next does the action.
(() => {
  let timer = null;
  const close = () => { clearTimeout(timer); document.querySelectorAll(".fab-mini.open").forEach((s) => s.classList.remove("open")); };
  for (const stack of document.querySelectorAll(".fab-mini")) {
    stack.addEventListener("click", (e) => {
      if (stack.classList.contains("open")) { setTimeout(close, 250); return; }   // let the action run
      e.stopPropagation(); e.preventDefault();
      stack.classList.add("open");
      clearTimeout(timer); timer = setTimeout(close, 4500);
    }, true);
  }
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".fab-mini")) close(); });
  window.addEventListener("scroll", () => { if (document.querySelector(".fab-mini.open")) close(); }, { passive: true });
})();
$("fabBrowseAll").onclick = () => openExplore();
$("fabSelect").onclick = () => $("selectBtn").click();
$("fabUpload").onclick = openUpload;
$("fabUploadFeed").onclick = openUpload;
// "Find me": straight to your photos (or the selfie search if you haven't done it yet)
$("fabFind").onclick = $("fabFindFeed").onclick = () => { if (state.results) show("results"); else openConsent(); };
$("upCancel").onclick = closeUpload;
$("uploadSheet").addEventListener("click", (e) => { if (e.target.id === "uploadSheet") closeUpload(); });

function renderShareAs() {
  const box = $("upAs");
  box.textContent = `Sharing as ${lsGet(NAME_KEY) || "Guest"} · `;
  const ch = document.createElement("button");
  ch.type = "button"; ch.className = "link-btn"; ch.textContent = "Change nickname";
  ch.onclick = () => askName(true);
  box.append(ch);
  $("upAsChoice").hidden = true;
}
function saveUploadName() {
  if (lsGet(FULLNAME_KEY)) return true;
  askName(false);
  return false;
}
$("upChoose").onclick = () => {
  if (!saveUploadName()) return;
  $("uploadInput").value = "";
  $("uploadInput").click();
};
$("upCamera").onclick = () => {
  if (!saveUploadName()) return;
  openShareCam();
};
$("uploadCamInput").addEventListener("change", (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) startCompose(files, true);
});
$("uploadInput").addEventListener("change", (e) => {
  const files = [...(e.target.files || [])];
  if (files.length) startCompose(files, false);
});
$("upBack").onclick = () => { clearCompose(); $("upNote").hidden = true; $("upProgress").hidden = true; $("uploadTitle").textContent = "Share your moments"; uploadMode("pick"); };

// Step 2: every picked photo as a card with its own (optional) caption.
async function startCompose(files, fromCamera) {
  if (files.length > MAX_UPLOAD) toast(`Up to ${MAX_UPLOAD} photos at a time`);
  files = files.slice(0, MAX_UPLOAD);
  if (!fromCamera) clearCompose();
  const live = openPrograms().length > 0;      // event has started: only event photos
  let noTime = 0, outside = 0, tooBig = 0;
  for (const file of files) {
    if ((file.type || "").startsWith("video/")) {          // a video from the gallery (max 100 MB)
      if (file.size > MAX_VIDEO_BYTES) { tooBig++; continue; }
      const t = new Date((file.lastModified || Date.now()) + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ").replace(/-/g, ":");
      compose.push({ file, taken: t, kind: "video", url: URL.createObjectURL(file) });
      continue;
    }
    const taken = fromCamera ? nowExif() : await exifTaken(file);
    if (!taken) { noTime++; continue; }
    if (live && !inEventRange(exifToIso(taken))) { outside++; continue; }
    compose.push({ file, taken, url: URL.createObjectURL(file) });
  }
  const msg = [
    noTime ? `${noTime} photo${noTime === 1 ? " has" : "s have"} no capture time (saved from WhatsApp, Telegram or a screenshot).` : "",
    outside ? `${outside} photo${outside === 1 ? " wasn't" : "s weren't"} taken during the EVENT event.` : "",
    tooBig ? `${tooBig} video${tooBig === 1 ? " is" : "s are"} over 100 MB. Trim ${tooBig === 1 ? "it" : "them"} in your Photos app, then try again.` : "",
  ].filter(Boolean).join(" ");
  if (!compose.length) {
    showUploadNote(msg + " Please share the original photo from your phone's Gallery or Photos app, or tap Camera.");
    return;
  }
  if (msg) showUploadNote(msg + " Those were skipped.");
  else $("upNote").hidden = true;
  renderCompose();
  uploadMode("compose");
  $("upProgress").hidden = true;
  const first = $("upStrip").querySelector("textarea");
  if (first && compose.length === 1) setTimeout(() => first.focus({ preventScroll: true }), 350);
}
function renderCompose() {
  const strip = $("upStrip");
  const keep = [...strip.querySelectorAll("textarea")].map((t) => t.value);
  strip.innerHTML = "";
  compose.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "compose-card";
    let img;
    if (c.kind === "boomerang") {
      img = document.createElement("canvas");
      img.className = "compose-boom";
      playBounce(img, c.frames);
      const tag = document.createElement("span");
      tag.className = "boom-tag"; tag.textContent = "∞ Boomerang";
      card.appendChild(tag);
    } else if (c.kind === "video") {
      img = document.createElement("video");
      img.className = "compose-vid"; img.src = c.url; img.muted = true; img.playsInline = true; img.loop = true; img.autoplay = true;
      img.setAttribute("muted", ""); img.setAttribute("playsinline", "");
      const tag = document.createElement("span");
      tag.className = "boom-tag"; tag.textContent = `▶ Video · ${(c.file.size / 1048576).toFixed(0)} MB`;
      card.appendChild(tag);
    } else {
      img = document.createElement("img");
      img.src = c.url; img.alt = "";
    }
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "compose-rm"; rm.setAttribute("aria-label", "Remove photo"); rm.textContent = "×";
    rm.onclick = () => {
      keepCaptions();
      if (c.url) URL.revokeObjectURL(c.url);
      compose.splice(i, 1);
      if (!compose.length) return $("upBack").onclick();
      renderCompose();
    };
    const ta = document.createElement("textarea");
    ta.className = "cap-input"; ta.rows = 2; ta.maxLength = 150;
    ta.placeholder = "Write a caption… (optional)";
    ta.value = c.caption ?? keep[i] ?? "";
    ta.oninput = () => { c.caption = ta.value; };
    card.append(img, rm, ta);
    strip.appendChild(card);
  });
  const n = compose.length;
  $("uploadTitle").textContent = n === 1 ? "Add a caption" : `${n} ready to share`;
  $("upHint").textContent = n > 1 ? "Swipe to add a caption to each photo" : `Shared as ${lsGet(NAME_KEY) || "Guest"}`;
  $("upPost").textContent = n === 1 ? (compose[0].kind === "boomerang" ? "Share boomerang" : compose[0].kind === "video" ? "Share video" : "Share photo") : `Share ${n}`;
}
function keepCaptions() {
  [...$("upStrip").querySelectorAll("textarea")].forEach((t, i) => { if (compose[i]) compose[i].caption = t.value; });
}
$("upPost").onclick = () => { keepCaptions(); uploadFiles(compose.map((c) => ({ file: c.file, kind: c.kind || "photo", mirror: c.mirror, taken: c.taken, caption: (c.caption || "").trim() }))); };

// ------------------------------------------------------------------ share camera
// Tap the shutter = photo. Hold it = boomerang: a short clip is recorded (ring
// fills, max ~1.8 s), the Mac turns it into a forward-backward loop with ffmpeg.
// Small preview frames are kept so the caption screen can bounce it right away.
let shareStream = null, shareFacing = "environment", boomRec = null, holdTimer = null, ringRaf = 0, bounceGen = 0;
const BOOM_MIN_MS = 700, BOOM_MAX_MS = 1850, HOLD_MS = 280;
function pickVideoType() {
  if (!window.MediaRecorder) return null;
  for (const t of ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

// draw a camera frame / still onto a canvas, mirrored for the selfie camera
function drawFiltered(canvas, src, mirror) {
  const x = canvas.getContext("2d");
  x.save();
  if (mirror) { x.translate(canvas.width, 0); x.scale(-1, 1); }
  x.drawImage(src, 0, 0, canvas.width, canvas.height);
  x.restore();
}

async function openShareCam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {   // very old phones: native camera
    $("uploadCamInput").value = ""; $("uploadCamInput").click(); return;
  }
  $("scam").hidden = false;
  $("scamHint").textContent = pickVideoType() === null ? "Tap to take a photo" : "Tap for photo · hold for boomerang";
  await startShareStream();
}
async function startShareStream() {
  stopShareStream();
  try {
    shareStream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: shareFacing, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 } } });
    const v = $("scamVideo");
    v.srcObject = shareStream;
    v.classList.toggle("mirror", shareFacing === "user");
    await v.play().catch(() => {});
  } catch {
    closeShareCam();
    toast("Camera not available — opening your phone camera", 2600);
    $("uploadCamInput").value = ""; $("uploadCamInput").click();
  }
}
function stopShareStream() {
  if (shareStream) shareStream.getTracks().forEach((t) => t.stop());
  shareStream = null;
}
function closeShareCam() {
  cancelBoom();
  stopShareStream();
  $("scamVideo").srcObject = null;
  $("scam").hidden = true;
}
$("scamClose").onclick = closeShareCam;
$("scamFlip").onclick = () => { shareFacing = shareFacing === "user" ? "environment" : "user"; startShareStream(); };
$("scamGallery").onclick = () => { closeShareCam(); $("uploadInput").value = ""; $("uploadInput").click(); };

function flashScreen() {
  const f = document.createElement("div"); f.className = "cam-flash"; $("scam").appendChild(f);
  setTimeout(() => f.remove(), 300);
}
// Photos: a real still from the camera where the browser offers one (ImageCapture,
// full sensor resolution and the phone's still processing), else the sharpest
// video frame. Mirror is baked in and it's encoded once, at full resolution
// (no re-encode at upload).
async function sharePhoto() {
  const v = $("scamVideo");
  if (!v.videoWidth) return;
  flashScreen();
  const mirror = shareFacing === "user";
  let src = null;
  const track = shareStream && shareStream.getVideoTracks()[0];
  if (!mirror && track && window.ImageCapture) {
    try {
      const still = await new ImageCapture(track).takePhoto();
      src = await createImageBitmap(still, { imageOrientation: "from-image" });
      if (src.width * src.height <= v.videoWidth * v.videoHeight) { src.close && src.close(); src = null; }   // no better than the stream
    } catch { src = null; }
  }
  if (!src) {                             // freeze the frame now, before anything else moves
    const f = document.createElement("canvas");
    f.width = v.videoWidth; f.height = v.videoHeight;
    f.getContext("2d").drawImage(v, 0, 0);
    src = f;
  }
  closeShareCam();
  const full = document.createElement("canvas");
  full.width = src.width; full.height = src.height;
  drawFiltered(full, src, mirror);
  src.close && src.close();
  let out = full;
  const scale = Math.min(1, 6000 / Math.max(full.width, full.height));
  if (scale < 1) {
    out = document.createElement("canvas");
    out.width = Math.round(full.width * scale); out.height = Math.round(full.height * scale);
    try {
      const p = picaLib();
      if (!p) throw 0;
      await p.resize(full, out, { filter: "lanczos3", unsharpAmount: 50, unsharpRadius: 0.6, unsharpThreshold: 2 });
    } catch { stepDown(full, out); }
  }
  const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.95));
  addCaptured({ file: new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }), kind: "photo", taken: nowExif(), ready: true });
}
function startBoom() {
  const type = pickVideoType();
  if (type === null || !shareStream) return sharePhoto();
  const chunks = [], frames = [], v = $("scamVideo");
  let rec;
  try { rec = new MediaRecorder(shareStream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 8e6 }); }
  catch { return sharePhoto(); }
  const t0 = performance.now();
  boomRec = { rec, t0, frames, stopAt: 0 };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const tag = boomRec && boomRec.cancelled;
    boomRec = null;
    $("scam").classList.remove("recording");
    if (tag) return;
    const mime = rec.mimeType || type || "video/mp4";
    const ext = mime.includes("webm") ? "webm" : "mp4";
    const blob = new Blob(chunks, { type: mime });
    closeShareCam();
    if (blob.size < 2000) { toast("That was too short. Hold the button a little longer."); return; }
    addCaptured({ file: new File([blob], `boomerang-${Date.now()}.${ext}`, { type: mime }), kind: "boomerang",
      taken: nowExif(), frames, mirror: shareFacing === "user" });
  };
  rec.start(100);
  $("scam").classList.add("recording");
  // small preview frames for the bounce on the caption screen
  const pc = document.createElement("canvas");
  const grab = () => {
    if (!boomRec || boomRec.rec !== rec) return;
    if (v.videoWidth) {
      const s = 360 / Math.max(v.videoWidth, v.videoHeight);
      pc.width = Math.round(v.videoWidth * s); pc.height = Math.round(v.videoHeight * s);
      const x = pc.getContext("2d");
      x.setTransform(1, 0, 0, 1, 0, 0);
      if (shareFacing === "user") { x.translate(pc.width, 0); x.scale(-1, 1); }
      x.drawImage(v, 0, 0, pc.width, pc.height);
      const f = document.createElement("canvas"); f.width = pc.width; f.height = pc.height;
      f.getContext("2d").drawImage(pc, 0, 0);
      frames.push(f);
    }
    setTimeout(grab, 66);
  };
  grab();
  const ring = () => {
    if (!boomRec || boomRec.rec !== rec) { setRing(0); return; }
    const p = Math.min(1, (performance.now() - t0) / BOOM_MAX_MS);
    setRing(p);
    if (p >= 1) return stopBoom();
    ringRaf = requestAnimationFrame(ring);
  };
  ring();
}
function setRing(p) { $("scamRing").style.strokeDasharray = `${(p * 100).toFixed(1)} 100`; }
function stopBoom() {
  if (!boomRec) return;
  const left = BOOM_MIN_MS - (performance.now() - boomRec.t0);
  if (left > 0) { setTimeout(stopBoom, left); return; }       // keep going to the minimum length
  cancelAnimationFrame(ringRaf);
  try { boomRec.rec.stop(); } catch {}
}
function cancelBoom() {
  clearTimeout(holdTimer);
  if (boomRec) { boomRec.cancelled = true; try { boomRec.rec.stop(); } catch {} }
  cancelAnimationFrame(ringRaf);
  setRing(0);
}
(() => {
  const s = $("scamShutter");
  let down = false;
  s.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (down || boomRec) return;
    down = true;
    s.setPointerCapture && s.setPointerCapture(e.pointerId);
    holdTimer = setTimeout(() => { holdTimer = null; if (down) startBoom(); }, HOLD_MS);
  });
  const up = () => {
    if (!down) return;
    down = false;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; sharePhoto(); }   // a tap = photo
    else stopBoom();
  };
  s.addEventListener("pointerup", up);
  s.addEventListener("pointercancel", up);
  s.addEventListener("contextmenu", (e) => e.preventDefault());   // no long-press menu
})();

// Bounce the preview frames forward and back on a canvas.
function playBounce(canvas, frames) {
  const gen = bounceGen;
  if (!frames || !frames.length) return;
  canvas.width = frames[0].width; canvas.height = frames[0].height;
  const x = canvas.getContext("2d");
  const seq = [...frames.slice(1), ...frames.slice(1, -1).reverse()];
  let i = 0;
  const step = () => {
    if (gen !== bounceGen || !canvas.isConnected && i > 2) return;
    x.drawImage(seq[i % seq.length] || frames[0], 0, 0);
    i++;
    setTimeout(step, 1000 / 30 / 1.4 * 2);   // preview frames are 15 fps; play them ~1.4x
  };
  step();
}
function addCaptured(item) {
  if (!$("upCompose").hidden) keepCaptions(); else clearCompose();
  compose.push({ ...item, url: item.kind === "photo" ? URL.createObjectURL(item.file) : null });
  renderCompose();
  uploadMode("compose");
  $("upProgress").hidden = true;
  $("upNote").hidden = true;
  $("uploadSheet").hidden = false;
}

async function postCaption(photoId, caption) {
  const r = await fetch("/api/social/caption", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ photo_id: photoId, device: uploaderId(), name: lsGet(NAME_KEY), caption }) });
  if (!r.ok) throw new Error("caption");
  if (caption) social.captions[photoId] = { name: lsGet(NAME_KEY) || "Guest", body: caption, mine: true };
  else delete social.captions[photoId];
}

// Capture time for the programme tabs and 15-minute sections. Resizing on a
// canvas drops EXIF, so read DateTimeOriginal first. Photos saved from WhatsApp /
// Telegram / screenshots have no capture time and are refused: we can't tell
// which part of the event they belong to.
async function exifTaken(file) {
  try {
    const head = new TextDecoder("latin1").decode(await file.slice(0, 196608).arrayBuffer());
    if (!/Exif/.test(head.slice(0, 4096))) return null;
    const m = head.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m && m[1] > "2000") return m[0];
  } catch {}
  return null;
}
function nowExif() {
  const d = new Date(Date.now() + 8 * 3600e3);   // event local time, UTC+8: change the offset
  return d.toISOString().slice(0, 19).replace("T", " ").replace(/-/g, ":");
}
const exifToIso = (t) => t.replace(/^(\d{4}):(\d{2}):(\d{2}) /, "$1-$2-$3T");

// Videos (max 100 MB) stream straight into cloud storage; progress for the bar.
function sendVideo(file, taken, batch, onProgress) {
  const ext = ((file.name || "").split(".").pop() || "").toLowerCase() || (file.type.includes("quicktime") ? "mov" : "mp4");
  const q = new URLSearchParams({ uploader: uploaderId(), taken, batch, ext,
    name: lsGet(NAME_KEY) });
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/upload-video?${q}`);
    x.setRequestHeader("content-type", file.type || "video/mp4");
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) return resolve();
      let d = {}; try { d = JSON.parse(x.responseText); } catch {}
      reject(new Error(d.detail || d.error || "upload_failed"));
    };
    x.onerror = () => reject(new Error("network"));
    x.send(file);
  });
}

// Straight to cloud storage through the website (fast, works even if the Mac is
// off); the old route through the Mac/Pi is the fallback.
const UPLOAD_REFUSALS = ["limit_reached", "too_large", "bad_image", "bad_video", "bad_uploader", "no_file"];
async function sendUpload(fd) {
  try {
    const r = await fetch("/api/upload-direct", { method: "POST", body: fd });
    if (r.ok) return;
    if ([400, 413, 429].includes(r.status)) {
      const d = await r.json().catch(() => ({}));
      if (UPLOAD_REFUSALS.includes(d.detail)) throw new Error(d.detail);
    }
  } catch (e) {
    if (UPLOAD_REFUSALS.includes(e.message)) throw e;
  }
  await api("/api/upload", { method: "POST", body: fd });
}
async function uploadFiles(items) {
  const batch = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);   // photos shared together = one post
  const status = $("upStatus"), bar = $("upBar");
  $("upProgress").hidden = false;
  uploadMode("busy");
  const reset = () => uploadMode("compose");
  let ok = 0, failed = 0, capFailed = 0;
  for (let i = 0; i < items.length; i++) {
    status.textContent = `Sharing ${i + 1} of ${items.length}…`;
    bar.style.width = `${(i / items.length) * 100}%`;
    try {
      const taken = items[i].taken;
      // 3000 px @ 0.92 ≈ 1.3 MB: 6 MP, prints sharp at A4; measured on real event photos
      const boom = items[i].kind === "boomerang";
      // The original file goes up untouched (the server keeps it for Save, minus the
      // GPS location). Only non-JPEGs (HEIC/PNG) or huge files are converted here.
      const f0 = items[i].file;
      const asIs = boom || items[i].kind === "video" || items[i].ready || (f0.type === "image/jpeg" && f0.size <= 24 * 1024 * 1024);
      const blob = asIs ? f0 : await shrinkImage(f0, 6000, 0.95);
      if (items[i].kind === "video") {
        await sendVideo(f0, taken, batch, (p) => {
          bar.style.width = `${((i + p) / items.length) * 100}%`;
          status.textContent = `Sharing video ${i + 1} of ${items.length}… ${Math.round(p * 100)}%`;
        });
      } else {
      const fd = new FormData();
      fd.append("photo", blob, boom ? items[i].file.name : "photo.jpg");
      fd.append("kind", boom ? "boomerang" : "photo");
      fd.append("batch", batch);
      if (boom && items[i].mirror) fd.append("mirror", "1");
      fd.append("code", lsGet(CODE_KEY));
      fd.append("uploader", uploaderId());
      fd.append("name", lsGet(NAME_KEY));
      fd.append("taken", taken);
      await sendUpload(fd);
      }
      ok++;
      const id = await guestPhotoId(blob).catch(() => null);
      if (id) {
        rememberUpload(id);
        if (items[i].caption) await postCaption(id, items[i].caption).catch(() => capFailed++);
      } else if (items[i].caption) capFailed++;
    } catch (err) {
      if (err.message === "bad_code" || err.message === "guests_only") {
        status.textContent = "Please open the site from the QR code on your table, then try again.";
        return reset();
      }
      if (err.message === "limit_reached") { status.textContent = "You've reached the photo limit for this event. Thank you!"; break; }
      if (err.name === "TypeError" || [502, 503, 504, 530].includes(err.status)) {
        status.textContent = `Sharing is offline for a moment. ${ok ? `${ok} shared so far. ` : ""}Please try again shortly.`;
        compose.splice(0, ok);          // keep only the ones not shared yet
        renderCompose();
        return reset();
      }
      failed++;
    }
  }
  bar.style.width = "100%";
  if (ok) {
    status.textContent = `${ok} photo${ok === 1 ? "" : "s"} shared${failed ? ` (${failed} couldn't be read)` : ""}${capFailed ? " · a caption didn't save, add it from the photo" : ""}. Thank you!`;
    liveFastUntil = Date.now() + 90000;
    setTimeout(() => { $("upStrip").classList.remove("busy"); closeUpload(); openFeed(); scheduleLive(); }, 1800);
  } else {
    status.textContent = failed ? "Those photos couldn't be read. Please try JPEG photos." : status.textContent;
    reset();
  }
}

function updateWelcome() {
  const n = lsGet(NAME_KEY);
  $("welcomeLine").hidden = !n;
  $("welcomeLine").textContent = n ? `Welcome, ${n} ` : "";
  if (n) { const w = document.createElement("span"); w.className = "wave"; w.textContent = "👋"; $("welcomeLine").append(w); }
}

// ------------------------------------------------------------------ avatars
// Each guest has a round avatar: their profile picture if they set one, else
// their initials on a colour picked from their id. "u" = hashed device id.
let myU = "";
const MY_US_KEY = "event_my_us";        // owner hashes of this guest's earlier browsers (restored by name)
const myUs = () => { const s = new Set((() => { try { return JSON.parse(lsGet(MY_US_KEY) || "[]"); } catch { return []; } })()); if (myU) s.add(myU); return s; };
const isMe = (u) => !!u && myUs().has(u);
(async () => {
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(uploaderId())));
    myU = [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
  } catch {}
  paintMyAvatars();
})();
const AV_COLORS = ["#3f7bff", "#8b5cf6", "#e06fd0", "#14b8a6", "#f59e0b", "#ef4444", "#22c55e", "#0ea5e9"];
function initials(name) {
  const w = (name || "Guest").replace(/\b(bin|binti|a\/l|a\/p)\b/gi, "").trim().split(/\s+/);
  return ((w[0] || "?")[0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase();
}
function fillAvatar(el, u, name) {
  el.innerHTML = "";
  el.style.background = "";
  el.classList.toggle("av-photog", name === PHOTOG_NAME);
  el.classList.toggle("av-booth", name === PHOTOBOOTH_NAME);
  if (name === PHOTOBOOTH_NAME) {
    el.innerHTML = '<img src="/static/brand/booth-av.jpg" alt="">';
    return;
  }
  if (name === PHOTOG_NAME) {
    el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    return;
  }
  const v = u && social.avatars && social.avatars[u];
  if (v) {
    const img = document.createElement("img");
    img.src = `/avatar/${u}.jpg?v=${v}`; img.alt = ""; img.loading = "lazy";
    el.appendChild(img);
  } else {
    let n = 0;
    for (const ch of (u || name || "x")) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.background = AV_COLORS[n % AV_COLORS.length];
    el.textContent = initials(name);
  }
}
function paintMyAvatars() {
  document.querySelectorAll(".me-av").forEach((el) => fillAvatar(el, myU, lsGet(FULLNAME_KEY) || lsGet(NAME_KEY)));
}

// ------------------------------------------------------------------ feed
// Feed home: one post per share (photos shared together are one
// carousel), newest first. Each photo keeps its own caption, reactions and
// comments, so the actions under a post follow the slide you're on.
const FEED_PAGE = 8;
let feedPosts = [], feedShown = 0;
const feedIndex = new Map();       // photo id -> { el, post, i }
const ago = (ms) => {
  const s = Math.max(1, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
};
function buildPosts(list) {
  // photobooth posts sit at the time they were added to the album (their newest import),
  // and among themselves keep the vendor's order: newest session first
  const booth = list.filter((p) => p.by === PHOTOBOOTH_NAME);
  const boothAt = Math.max(0, ...booth.map((p) => Date.parse(p.at || 0) || 0));
  const boothT0 = Math.min(Infinity, ...booth.map((p) => Date.parse(p.taken || 0) || Infinity));
  const at = (p) => p.by === PHOTOBOOTH_NAME
    ? boothAt + ((Date.parse(p.taken || 0) || boothT0) - boothT0) / 1e4
    : Date.parse(p.at || p.taken || 0) || 0;
  const guests = list.filter((p) => p.source === "guest").sort((a, b) => at(a) - at(b));
  const groups = new Map(), lastOf = new Map();
  for (const p of guests) {
    // photos shared together carry the same batch; older uploads: same person within 10 minutes
    let key = p.b ? "b:" + p.b : null;
    if (!key) {
      const who = p.u || p.by, prev = lastOf.get(who);
      key = prev && at(p) - prev.t < 600000 ? prev.key : `u:${who}:${at(p)}`;
      lastOf.set(who, { key, t: at(p) });
    }
    if (!groups.has(key)) groups.set(key, { key, photos: [], u: p.u, by: p.by, at: 0 });
    const g = groups.get(key);
    g.photos.push(p);
    g.at = Math.max(g.at, at(p));
  }
  // Photographer photos: one post per run of uploads (gap under 10 min), up to 10 photos each
  const cam = list.filter((p) => p.source !== "guest").sort((a, b) => at(a) - at(b) || (a.taken || "").localeCompare(b.taken || ""));
  let cur = null;
  for (const p of cam) {
    if (!cur || at(p) - cur.last > 600000 || cur.photos.length >= 10) {
      cur = { key: "p:" + p.id, photos: [], u: null, by: PHOTOG_NAME, at: 0, last: 0, photog: true };
      groups.set(cur.key, cur);
    }
    cur.photos.push(p);
    cur.last = at(p);
    cur.at = Math.max(cur.at, at(p));
  }
  for (const g of groups.values()) if (g.photog) g.photos.sort((a, b) => (a.taken || "").localeCompare(b.taken || ""));
  // photobooth: the video first, then exactly the vendor's order
  for (const g of groups.values()) if (g.by === PHOTOBOOTH_NAME)
    g.photos.sort((a, b) => (a.kind === "boomerang" ? -1 : a.o ?? 99) - (b.kind === "boomerang" ? -1 : b.o ?? 99)
      || (b.taken || "").localeCompare(a.taken || ""));   // video first, then the vendor's order
  return [...groups.values()].sort((a, b) => b.at - a.at);
}
async function openFeed() {
  show("feed");
  if (!manifestCache) {
    $("feedMore").hidden = false;
    try { await listPhotos(0, 1); } catch {}
    $("feedMore").hidden = true;
  }
  loadSocial();
  renderFeed(true);
}
function renderFeed(reset) {
  feedPosts = buildPosts(manifestCache || []);
  $("feedEmpty").hidden = feedPosts.length > 0;
  const list = $("feedList");
  const keep = reset ? FEED_PAGE : Math.max(feedShown, FEED_PAGE);
  const frag = document.createDocumentFragment();
  feedShown = 0;
  feedIndex.clear();
  while (feedShown < Math.min(keep, feedPosts.length)) frag.appendChild(makePost(feedPosts[feedShown++]));
  list.replaceChildren(frag);
  $("feedMore").hidden = state.search || feedShown >= feedPosts.length;
  setTimeout(maybeFeedTour, 700);
}
function moreFeed() {
  const list = $("feedList");
  const end = Math.min(feedPosts.length, feedShown + FEED_PAGE);
  while (feedShown < end) list.appendChild(makePost(feedPosts[feedShown++]));
  $("feedMore").hidden = feedShown >= feedPosts.length;
}
new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting) && $("feed").classList.contains("active")) moreFeed(); },
  { rootMargin: "900px" }).observe($("feedMore"));

const HEART_PATH = '<path d="M12 20s-7.5-4.6-7.5-10.1A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/>';
function makePost(post) {
  const el = document.createElement("article");
  el.className = "post";
  // header: avatar, name, when · programme · count
  const hd = document.createElement("header"); hd.className = "post-h";
  const av = document.createElement("span"); av.className = "av"; fillAvatar(av, post.u, post.by);
  const who = document.createElement("div"); who.className = "post-who";
  const nm = document.createElement("b"); nm.textContent = post.by || "Guest";
  const meta = document.createElement("small");
  const prog = programOf(post.photos[0]);
  meta.textContent = [ago(post.at), prog ? segLabel(prog) : "", post.photos.length > 1 ? `${post.photos.length} photos` : ""]
    .filter(Boolean).join(" · ");
  who.append(nm, meta);
  hd.append(av, who);
  hd.classList.add("tappable");
  hd.onclick = () => { if ($("profile").classList.contains("active")) return; openProfile(post.photog ? { photographer: true } : isMe(post.u) ? undefined : { by: post.by, u: post.u }); };
  // carousel
  const media = document.createElement("div"); media.className = "post-media";
  const track = document.createElement("div"); track.className = "post-track";
  const first = post.photos[0];
  const ratio = first.w && first.h ? Math.max(0.8, Math.min(1.91, first.w / first.h)) : 1;   // portrait 4:5 .. landscape 1.91:1
  media.style.aspectRatio = String(ratio);
  post.photos.forEach((p, i) => {
    const s = document.createElement("div"); s.className = "post-slide";
    if (p.kind === "boomerang" && p.vthumb) {
      const v = document.createElement("video");
      v.muted = true; v.loop = true; v.playsInline = true; v.preload = "none"; v.poster = abs(p.web);
      v.setAttribute("muted", ""); v.setAttribute("playsinline", "");
      v.dataset.src = abs(p.video || p.vthumb);
      v.className = "focus-vid";
      v.onplaying = () => v.classList.add("on");
      boothVideoIO.observe(v);
      s.appendChild(v);
      const bb = document.createElement("span"); bb.className = "badge-boom"; bb.textContent = p.by === PHOTOBOOTH_NAME || p.vid ? "▶" : "∞"; s.appendChild(bb);
    } else {
      const img = document.createElement("img");
      img.loading = i ? "lazy" : "eager"; img.decoding = "async"; img.alt = ""; img.src = abs(p.web);
      s.appendChild(img);
    }
    track.appendChild(s);
    feedIndex.set(p.id, { el, post, i });
  });
  media.appendChild(track);
  const burst = document.createElement("span"); burst.className = "heart-burst"; burst.textContent = "❤️";
  media.appendChild(burst);
  let count = null, dots = null;
  if (post.photos.length > 1) {
    count = document.createElement("span"); count.className = "post-count"; media.appendChild(count);
    dots = document.createElement("div"); dots.className = "post-dots";
    post.photos.forEach(() => dots.appendChild(document.createElement("i")));
  }
  // actions + text, always for the slide on screen
  const act = document.createElement("div"); act.className = "post-actions";
  const likeBtn = document.createElement("button"); likeBtn.className = "pa-like"; likeBtn.setAttribute("aria-label", "Like");
  const cmtBtn = document.createElement("button"); cmtBtn.className = "pa-cmt"; cmtBtn.setAttribute("aria-label", "Comments");
  cmtBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/></svg>';
  const sum = document.createElement("span"); sum.className = "pa-sum";
  const saveBtn = document.createElement("button"); saveBtn.className = "pa-save"; saveBtn.setAttribute("aria-label", "Save");
  saveBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  const shareBtn = document.createElement("button"); shareBtn.className = "pa-share"; shareBtn.setAttribute("aria-label", "Share");
  shareBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M6 12v7h12v-7"/></svg>';
  act.append(likeBtn, cmtBtn, sum, saveBtn, shareBtn);
  const cap = document.createElement("p"); cap.className = "post-cap";
  const cmt = document.createElement("button"); cmt.className = "post-cmtline";
  el.append(hd, media);
  if (dots) el.append(dots);
  el.append(act, cap, cmt);

  el._post = post;
  el._i = 0;
  const cur = () => post.photos[el._i];
  el._update = () => {
    const p = cur(), mine = new Set(social.mine[p.id] || []);
    likeBtn.innerHTML = `<svg viewBox="0 0 24 24"${mine.has("❤️") ? ' class="on"' : ""}>${HEART_PATH}</svg>`;
    const parts = Object.entries(social.reactions[p.id] || {}).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
    const total = parts.reduce((t, [, n]) => t + n, 0);
    sum.textContent = total ? `${parts.slice(0, 3).map(([e]) => e).join("")} ${total}` : "";
    const c = social.captions[p.id];
    cap.innerHTML = "";
    if (c) { const b = document.createElement("b"); b.textContent = c.name || post.by || "Guest"; cap.append(b, " ", c.body); }
    cap.hidden = !c;
    const n = social.comments[p.id] || 0, f = social.firstComment[p.id];
    cmt.innerHTML = "";
    if (n && f) {
      const l = document.createElement("span"); l.className = "pc-first";
      const b = document.createElement("b"); b.textContent = f.name || "Guest";
      l.append(b, " ", f.body);
      cmt.append(l);
      if (n > 1) { const m = document.createElement("span"); m.className = "pc-more"; m.textContent = `View all ${n} comments`; cmt.append(m); }
    } else {
      const m = document.createElement("span"); m.className = "pc-more"; m.textContent = "Add a comment…"; cmt.append(m);
    }
    if (count) count.textContent = `${el._i + 1}/${post.photos.length}`;
    if (dots) [...dots.children].forEach((d, k) => d.classList.toggle("on", k === el._i));
  };
  el._update();
  track.addEventListener("scroll", () => {
    const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    if (i !== el._i && post.photos[i]) { el._i = i; el._update(); }
  }, { passive: true });
  likeBtn.onclick = () => feedReact(cur().id, "❤️", el);
  cmtBtn.onclick = cmt.onclick = () => openComments(cur().id);
  saveBtn.onclick = () => askSave(cur());
  shareBtn.onclick = () => shareToApps(cur());
  shareBtn.addEventListener("pointerdown", () => prepShare(cur(), true));
  sharePrepIO.observe(act); act._cur = cur;
  // tap = open full screen, double tap = ❤️ (like most photo feeds)
  let lastTap = 0, tapTimer;
  media.addEventListener("click", () => {
    const now = Date.now();
    if (now - lastTap < 280) {
      clearTimeout(tapTimer);
      lastTap = 0;
      const p = cur();
      if (!(social.mine[p.id] || []).includes("❤️")) feedReact(p.id, "❤️", el);
      burst.classList.remove("go"); void burst.offsetWidth; burst.classList.add("go");
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => openViewer(post.photos, el._i, "browse"), 280);
  });
  return el;
}
function updateFeedPhoto(id) {
  const x = feedIndex.get(id);
  if (x && x.el._update) x.el._update();
}
// One reaction per person per photo: picking a new emoji replaces the old one.
function toggleMine(id, emoji) {
  const prev = social.mine[id] || [], counts = (social.reactions[id] ||= {});
  const on = !prev.includes(emoji);
  for (const e of prev) counts[e] = Math.max(0, (counts[e] || 0) - 1);
  if (on) counts[emoji] = (counts[emoji] || 0) + 1;
  social.mine[id] = on ? [emoji] : [];
  return on;
}
async function feedReact(id, emoji, el) {
  const on = toggleMine(id, emoji);
  el._update();
  updateTileBadge(id);
  try {
    const r = await fetch("/api/social/react", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ photo_id: id, device: uploaderId(), emoji, on, name: lsGet(NAME_KEY), us: myUsList() }) });
    if (r.ok) { social.reactions[id] = (await r.json()).counts; updateFeedPhoto(id); updateTileBadge(id); }
  } catch { toast("Couldn't save your reaction"); }
}
async function refreshFeed() {
  const r = await fetch(`/photos.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return;
  const next = mapManifest(await r.json());
  const before = new Set((manifestCache || []).map((p) => p.id));
  const added = next.filter((p) => !before.has(p.id) && p.source === "guest");
  const changed = !manifestCache || manifestCache.length !== next.length;
  manifestCache = next;
  manifestAt = Date.now();
  if (!added.length && !changed) return;
  if (state.search) return;     // searching: leave the results (and where you are in them) alone
  const anchor = [...document.querySelectorAll("#feedList .post")].find((p) => p.getBoundingClientRect().bottom > 140);
  const anchorKey = anchor && anchor._post && anchor._post.key, anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  renderFeed(false);
  if (anchorKey && window.scrollY > 40) {
    const again = [...document.querySelectorAll("#feedList .post")].find((p) => p._post.key === anchorKey);
    if (again) window.scrollBy(0, again.getBoundingClientRect().top - anchorTop);
    if (added.length) { $("feedPill").textContent = "↑ New posts"; $("feedPill").hidden = false; }
  }
}
$("feedPill").onclick = () => { $("feedPill").hidden = true; window.scrollTo({ top: 0, behavior: "smooth" }); };
window.addEventListener("scroll", () => { if (window.scrollY < 60) $("feedPill").hidden = true; }, { passive: true });

// ------------------------------------------------------------------ tab bar + top bar
function openExplore() { openBrowse(browseSegments().includes("booth") ? "booth" : undefined); }   // always opens on Photobooth
$("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  const t = b.dataset.tab;
  dropLayer("profileOf");
  if (t === "feed") $("feed").classList.contains("active") ? window.scrollTo({ top: 0, behavior: "smooth" }) : openFeed();
  else if (t === "browse") $("browse").classList.contains("active") ? window.scrollTo({ top: 0, behavior: "smooth" }) : openExplore();
  else if (t === "share") openUpload();
  else if (t === "me") { if (state.results) show("results"); else openConsent(); }
  else if (t === "profile") openProfileSheet();
});
["fd", "ex"].forEach((p) => {
  $(p + "Share").onclick = () => openUpload();
  $(p + "Heart").onclick = () => openNotifs();
});

// ------------------------------------------------------------------ notifications
// Likes and comments by others on photos I shared (my uploads are remembered on
// this phone). A red dot shows when there's something newer than last time I looked.
const SEEN_KEY = "event_notif_seen";
let notifItems = [];
async function loadActivity() {
  // photos I shared, plus photos my selfie search found me in
  const mine = new Set(myUploads());
  const inIt = (state.results && state.results.strong || []).map((p) => p.id).filter((id) => !mine.has(id));
  const ids = [...mine, ...inIt];
  if (!ids.length) { notifItems = []; return; }
  try {
    const r = await fetch("/api/social/activity", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: uploaderId(), ids }) });
    if (r.ok) notifItems = ((await r.json()).items || []).map((n) => ({ ...n, mine: mine.has(n.photo) }));
  } catch {}
  const seen = Number(lsGet(SEEN_KEY) || 0);
  const fresh = notifItems.some((x) => x.at > seen);
  document.querySelectorAll(".heart-btn .dot").forEach((d) => (d.hidden = !fresh));
}
async function openNotifs() {
  $("notifSheet").hidden = false;
  $("notifList").innerHTML = `<p class="muted" style="text-align:center;padding:18px 0">Loading…</p>`;
  await loadActivity();
  const seen = Number(lsGet(SEEN_KEY) || 0);
  const box = $("notifList");
  box.innerHTML = "";
  if (!notifItems.length) {
    box.innerHTML = `<p class="muted" style="text-align:center;padding:22px 8px">When people like or comment on photos you shared, or photos you're in, you'll see it here.</p>`;
  }
  for (const n of notifItems) {
    const row = document.createElement("button"); row.className = "notif" + (n.at > seen ? " new" : "");
    const av = document.createElement("span"); av.className = "av"; fillAvatar(av, n.u, n.name);
    const t = document.createElement("span"); t.className = "notif-txt";
    const b = document.createElement("b"); b.textContent = n.name;
    const what = n.mine ? "your photo" : "a photo you're in";
    t.append(b, n.type === "like" ? ` reacted ${n.emoji} to ${what}` : ` commented on ${what}: ${n.body}`);
    const tm = document.createElement("small"); tm.textContent = ago(n.at);
    t.append(" ", tm);
    row.append(av, t);
    const p = (manifestCache || []).find((x) => x.id === n.photo);
    if (p) { const im = document.createElement("img"); im.src = abs(p.thumb); im.alt = ""; im.className = "notif-th"; row.append(im); }
    row.onclick = () => {
      $("notifSheet").hidden = true;
      if (p) { openViewer([p], 0, "browse"); if (n.type === "comment") setTimeout(() => openComments(p.id), 300); }
    };
    box.appendChild(row);
  }
  lsSet(SEEN_KEY, String(Date.now()));
  document.querySelectorAll(".heart-btn .dot").forEach((d) => (d.hidden = true));
}
$("notifSheet").addEventListener("click", (e) => { if (e.target.id === "notifSheet") $("notifSheet").hidden = true; });
setInterval(() => { if (document.visibilityState === "visible") loadActivity(); }, 60000);

// ------------------------------------------------------------------ profile
// Profile tab: a sheet with my details and buttons (as before).
function openProfileSheet() {
  paintMyAvatars();
  $("profName").textContent = lsGet(NAME_KEY) || "Guest";
  const full = lsGet(FULLNAME_KEY);
  $("profFull").textContent = full && full !== lsGet(NAME_KEY) ? full : "";
  const mine = buildPosts(manifestCache || []).filter((ps) => isMe(ps.u));
  const n = mine.reduce((k, ps) => k + ps.photos.length, 0);
  $("profStats").textContent = n ? `${mine.length} post${mine.length === 1 ? "" : "s"} · ${n} photo${n === 1 ? "" : "s"}` : "No photos shared yet";
  $("profRemove").hidden = !(social.avatars && social.avatars[myU]);
  $("profileSheet").hidden = false;
}
$("profileSheet").addEventListener("click", (e) => { if (e.target.id === "profileSheet") $("profileSheet").hidden = true; });
$("profMyPosts").onclick = () => { $("profileSheet").hidden = true; openProfile(undefined, true); };

// Posts page: mine ("Show my posts"), the photographer's, or another guest's (tap a post header).
let profileWho = null;
function openProfile(who, viaPost = true) {
  if (who && who.u && isMe(who.u)) who = undefined;
  const mine = !who, all = buildPosts(manifestCache || []);
  profileWho = who || { me: true };
  let posts, name, full = "";
  if (mine) {
    name = lsGet(NAME_KEY) || "Guest";
    const f = lsGet(FULLNAME_KEY);
    full = f && f !== name ? f : "";
    posts = all.filter((ps) => isMe(ps.u));
  } else if (who.photographer) {
    name = PHOTOG_NAME;
    full = "Official photos from the event photographer";
    posts = all.filter((ps) => ps.photog);
  } else {
    name = who.by || "Guest";
    posts = all.filter((ps) => !ps.photog && (who.u ? ps.u === who.u : ps.by === who.by));
  }
  fillAvatar($("pfAv"), mine ? myU : who.photographer ? null : who.u, mine ? lsGet(FULLNAME_KEY) || name : name);
  $("pfTitle").textContent = mine ? "Your posts" : name;
  $("pfName").textContent = name;
  $("pfFull").textContent = full;
  const nPhotos = posts.reduce((n, ps) => n + ps.photos.length, 0);
  $("pfStats").textContent = nPhotos
    ? `${posts.length} post${posts.length === 1 ? "" : "s"} · ${nPhotos} photo${nPhotos === 1 ? "" : "s"}`
    : "No posts yet";
  const frag = document.createDocumentFragment();
  for (const ps of posts) frag.appendChild(makePost(ps));
  $("profPosts").replaceChildren(frag);
  $("profPostsTitle").hidden = true;
  $("profEmpty").hidden = !!posts.length;
  $("profEmpty").querySelector("p").textContent = mine ? "Share a photo and it shows up here." : "No posts yet.";
  if (!$("profile").classList.contains("active")) {
    const from = screenNow;
    show("profile");
    pushLayer("profileOf", () => { profileWho = null; show(from); });
  } else window.scrollTo(0, 0);
}
$("pfBack").onclick = () => history.back();
$("profAvBtn").onclick = () => { $("avatarInput").value = ""; $("avatarInput").click(); };
$("profName2").onclick = () => { $("profileSheet").hidden = true; askName(true); };
$("avatarInput").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const s = Math.min(bmp.width, bmp.height), c = document.createElement("canvas");
    c.width = c.height = 320;
    c.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 320, 320);   // centre square
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
    const r = await fetch(`/api/social/avatar?device=${encodeURIComponent(uploaderId())}`, { method: "POST", body: blob,
      headers: { "content-type": "image/jpeg" } });
    if (!r.ok) throw 0;
    const d = await r.json();
    (social.avatars ||= {})[d.u] = d.v;
    myU = d.u;
    paintMyAvatars();
    openProfileSheet();
    if ($("feed").classList.contains("active")) renderFeed(false);
    toast("Profile picture updated");
  } catch { toast("Couldn't use that picture. Try another one."); }
});
$("profRemove").onclick = async () => {
  try {
    await fetch(`/api/social/avatar?device=${encodeURIComponent(uploaderId())}`, { method: "DELETE" });
    delete social.avatars[myU];
    paintMyAvatars();
    openProfileSheet();
    if ($("feed").classList.contains("active")) renderFeed(false);
  } catch {}
};

// ------------------------------------------------------------------ saved profile (survives clearing the browser)
// Everything else lives in this browser's storage. A copy is kept in the cloud under
// the guest-list name; picking the same name on a fresh browser brings it back.
const SYNC_KEYS = ["event_name", "event_session", "event_session_api", "event_my_uploads", "event_favs", "event_notif_seen", "event_src", "event_tour", "event_tour_feed"];
let lastSaved = "";
async function saveProfile() {
  const fullname = lsGet(FULLNAME_KEY);
  if (!fullname) return;
  const data = {};
  for (const k of SYNC_KEYS) { const v = lsGet(k); if (v) data[k] = v; }
  const body = JSON.stringify({ device: uploaderId(), fullname, data });
  if (body === lastSaved) return;
  try {
    const r = await fetch("/api/social/profile", { method: "POST", headers: { "content-type": "application/json" }, body });
    if (r.ok) lastSaved = body;
  } catch {}
}
setInterval(() => { if (document.visibilityState === "visible") saveProfile(); }, 20000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveProfile(); });

async function restoreProfile(fullname, typedNick) {
  let d;
  try {
    const r = await fetch("/api/social/profile/restore", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ device: uploaderId(), fullname }) });
    if (!r.ok) return false;
    d = await r.json();
  } catch { return false; }
  if (!d.found) return await restoreFromSelfie(fullname, typedNick);
  const data = d.data || {};
  for (const [k, v] of Object.entries(data)) {
    if (!SYNC_KEYS.includes(k) || typeof v !== "string") continue;
    if (k === "event_name") { if (!typedNick) lsSet(k, v); continue; }
    if (k === "event_my_uploads") {
      try { lsSet(k, JSON.stringify([...new Set([...JSON.parse(v), ...myUploads()])].slice(-200))); } catch {}
      continue;
    }
    if (k === "event_favs") {
      try { favs = { ...JSON.parse(v), ...favs }; lsSet(FAV_KEY, JSON.stringify(favs)); } catch {}
      continue;
    }
    if (!lsGet(k)) lsSet(k, v);
  }
  lsSet(MY_US_KEY, JSON.stringify(d.us || []));
  // selfie results come back without a new selfie
  if (!state.sid && store.get()) {
    state.sid = store.get();
    try { renderResults(await api(`/api/session/${state.sid}`)); } catch { forgetLocal(); }
  }
  updateWelcome();
  loadSocial();
  loadActivity();
  if ($("feed").classList.contains("active")) renderFeed(false);
  return true;
}

// No saved profile yet (cleared before backups existed): the Mac still knows which
// browser did this person's selfie search. Claim that browser's posts and show the
// photos the search found, without a new selfie.
async function restoreFromSelfie(fullname, nick = "") {
  await loadPeople(true);
  if (!manifestCache) { try { await listPhotos(0, 1); } catch {} }
  const p = people.find((x) => x.name === fullname);
  const us = new Set((() => { try { return JSON.parse(lsGet(MY_US_KEY) || "[]"); } catch { return []; } })());
  for (const u of (p && p.us) || []) if (u !== myU) us.add(u);
  // no selfie search: posts shared under exactly this full name or nickname, if only one
  // earlier browser used that name (so two people with the same nickname never mix)
  for (const nm of [fullname, nick].filter(Boolean)) {
    const owners = new Set((manifestCache || []).filter((x) => x.u && x.by 
      && fold(x.by) === fold(nm)).map((x) => x.u));
    if (owners.size === 1) for (const u of owners) if (u !== myU) us.add(u);
  }
  if (!p && !us.size) return false;
  lsSet(MY_US_KEY, JSON.stringify([...us]));
  const mineIds = (manifestCache || []).filter((x) => isMe(x.u)).map((x) => x.id);
  if (mineIds.length) lsSet(MY_UPLOADS_KEY, JSON.stringify([...new Set([...mineIds, ...myUploads()])].slice(-200)));
  if (p && p.nick && !lsGet(NAME_KEY)) lsSet(NAME_KEY, p.nick);
  if (p && !state.sid && !state.results) {
    const byId = new Map((manifestCache || []).map((x) => [x.id, x]));
    const strong = p.photos.map((id) => byId.get(id)).filter(Boolean);
    renderResults({ strong, possible: [], total_photos: (manifestCache || []).length });
  }
  updateWelcome();
  loadSocial();
  loadActivity();
  if ($("feed").classList.contains("active")) renderFeed(false);
  return true;
}
// Guests who already picked their name before backups existed get one try at boot.
setTimeout(async () => {
  const full = lsGet(FULLNAME_KEY);
  if (!full || lsGet("event_restore_tried")) return;
  lsSet("event_restore_tried", "1");
  const back = await restoreProfile(full, lsGet(NAME_KEY));
  if (back && (lsGet(MY_US_KEY) || "[]") !== "[]") toast("Your earlier posts and photos are back 👋", 3000);
  saveProfile();
}, 3000);

// ------------------------------------------------------------------ name (asked once, after the QR code)
// The visitor types their name; the optional nickname is what shows on posts,
// comments and reactions. Without a nickname the full name is shown.
let GUESTS = [];          // optional: fill this array to offer a pick-list of names
const PHOTOG_NAME = "Event Photographer";
const PHOTOBOOTH_NAME = "Photobooth";     // imported from a photobooth vendor's gallery
const fold = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9/ ]+/g, " ").replace(/\s+/g, " ").trim();
let GUEST_INDEX = GUESTS.map((n) => ({ n, f: fold(n), words: fold(n).split(" ") }));
let pickedFull = "", pickerHi = -1, offList = false;

function matchGuests(q) {
  const tokens = fold(q).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  const scored = [];
  for (const g of GUEST_INDEX) {
    let score = 0, ok = true;
    for (const t of tokens) {
      const w = g.words.findIndex((x) => x.startsWith(t));
      if (w >= 0) score += w === 0 ? 3 : 2;             // word starts with what you typed
      else if (g.f.includes(t)) score += 1;              // somewhere inside
      else { ok = false; break; }
    }
    if (ok) scored.push([score, g.n]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).slice(0, 6).map((x) => x[1]);
}
function highlight(name, q) {
  const frag = document.createDocumentFragment();
  const toks = fold(q).split(" ").filter(Boolean);
  name.split(/(\s+)/).forEach((part) => {
    const t = toks.find((x) => fold(part).startsWith(x));
    if (t && part.trim()) {
      const b = document.createElement("b");
      b.textContent = part.slice(0, t.length);
      frag.append(b, part.slice(t.length));
    } else frag.append(part);
  });
  return frag;
}
function setPicked(name, manual = false) {
  pickedFull = name; offList = manual;
  $("fullNameInput").value = name;
  $("namePicked").hidden = !name;
  closePicker();
  updateNameSave();
  $("nameHelp").textContent = manual ? "Not on the list, saved as you typed it." : "";
  if (name && !manual) setTimeout(() => $("nameInput").focus(), 50);
}
function closePicker() { $("namePicker").hidden = true; $("fullNameInput").setAttribute("aria-expanded", "false"); pickerHi = -1; }
function renderPicker() {
  const q = $("fullNameInput").value, box = $("namePicker");
  box.innerHTML = "";
  if (fold(q).length < 2) return closePicker();
  const hits = matchGuests(q);
  hits.forEach((n, i) => {
    const o = document.createElement("button");
    o.type = "button"; o.className = "pick-opt" + (i === pickerHi ? " hi" : ""); o.setAttribute("role", "option");
    o.append(highlight(n, q));
    o.addEventListener("pointerdown", (e) => e.preventDefault());   // keep the keyboard open
    o.onclick = () => setPicked(n);
    box.appendChild(o);
  });
  const none = document.createElement("button");
  none.type = "button"; none.className = "pick-none";
  none.textContent = hits.length ? "Not on the list? Use the name as typed" : `No match. Use "${q.trim()}" anyway`;
  none.addEventListener("pointerdown", (e) => e.preventDefault());
  none.onclick = () => setPicked(q.replace(/\s+/g, " ").trim().slice(0, 80), true);
  box.appendChild(none);
  box.hidden = false;
  $("fullNameInput").setAttribute("aria-expanded", "true");
}
function updateNameSave() { $("nameSave").disabled = !pickedFull; }
$("fullNameInput").addEventListener("input", () => {
  pickedFull = ""; offList = false;
  $("namePicked").hidden = true; $("nameHelp").textContent = "";
  updateNameSave(); renderPicker();
});
$("fullNameInput").addEventListener("focus", () => { if (!pickedFull && !$("fullNameInput").readOnly) renderPicker(); });
$("fullNameInput").addEventListener("keydown", (e) => {
  const opts = [...$("namePicker").querySelectorAll(".pick-opt")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!opts.length) return;
    e.preventDefault();
    pickerHi = (pickerHi + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("hi", i === pickerHi));
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (!pickedFull && opts.length) setPicked((opts[Math.max(0, pickerHi)]).textContent);
    else if (pickedFull) $("nameInput").focus();
  } else if (e.key === "Escape") closePicker();
});

function askName(change = false) {
  const full = lsGet(FULLNAME_KEY);
  const lock = change && !!full;                 // once picked, the full name stays; only the nickname changes
  $("nameTitle").textContent = lock ? "Change nickname" : change ? "Your name" : "Welcome to Event 👋";
  $("fullNameInput").readOnly = lock;
  $("fullNameInput").closest(".picker").classList.toggle("locked", lock);
  $("nameSheet").querySelector(".sheet-text").textContent = lock
    ? "Your full name stays as it is. Your nickname is what shows on your posts, comments and reactions."
    : "Type your name. We use it to keep your photos together.";
  pickedFull = full; offList = full && !GUESTS.includes(full);
  $("fullNameInput").value = full;
  $("namePicked").hidden = !full;
  $("nameHelp").textContent = "";
  // nickname: whatever was shown before, unless that was just the full name
  const shown = lsGet(NAME_KEY);
  $("nameInput").value = shown && shown !== full ? shown : "";
  updateNameSave();
  $("nameAnon").hidden = $("nameAnonNote").hidden = change;      // first visit only
  $("nameSheet").hidden = false;
  setTimeout(() => $(lock ? "nameInput" : "fullNameInput").focus(), 250);
}
// Anonymous: look around without picking a name (asked again only when posting etc.)
$("nameAnon").onclick = () => {
  lsSet("event_viewer", "1");
  $("nameSheet").hidden = true;
  toast("Browsing as a guest 👋");
};
$("nameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!pickedFull) { $("fullNameInput").focus(); renderPicker(); return; }
  const nick = $("nameInput").value.replace(/\s+/g, " ").trim().slice(0, 30);
  if ([PHOTOG_NAME, PHOTOBOOTH_NAME].some((n) => fold(nick) === fold(n))) { $("nameHelp").textContent = "That name is reserved."; return; }
  const fresh = !lsGet(FULLNAME_KEY);
  lsSet(FULLNAME_KEY, pickedFull);
  lsSet(NAME_KEY, nick || pickedFull);
  if (fresh) {
    // signing in again (cleared browser, new phone): show the tour again
    const replayTour = () => { try { localStorage.removeItem("event_tour"); localStorage.removeItem("event_tour_feed"); } catch {} tourStarted = false; feedTourStarted = false; setTimeout(maybeTour, 600); };
    replayTour();
    restoreProfile(pickedFull, nick).then((back) => {
      if (back) toast(`Welcome back, ${lsGet(NAME_KEY).split(" ")[0]}! Your photos and settings are back 👋`, 3200);
      replayTour();                       // the restored profile carries the old "tour seen" flag
      saveProfile();
    });
  }
  else saveProfile();
  updateWelcome();
  if (!$("uploadSheet").hidden) renderShareAs();
  $("nameSheet").hidden = true;
  if (!$("commentSheet").hidden && commentPhoto) openComments(commentPhoto);
  toast(`Hi ${nick || pickedFull.split(" ")[0]}! 👋`);
});

// ------------------------------------------------------------------ boot
// Overlays become layers when they open and drop out when they close.
(() => {
  const special = {
    viewer: () => closeViewer(),
    cam: () => { closeSelfieCamera(); state.addingAngle = false; },
    scam: () => closeShareCam(),
    uploadSheet: () => { closeUpload(); if (!$("uploadSheet").hidden) pushLayer("uploadSheet", () => closeUpload()); },
  };
  for (const id of ["viewer", "saveAsk", "reactSheet", "cam", "scam", "notifSheet", "profileSheet", "consentSheet", "uploadSheet", "commentSheet", "captionSheet", "menuSheet"]) {
    const el = $(id);
    let open = !el.hidden;
    new MutationObserver(() => {
      if (el.hidden === !open) return;
      open = !el.hidden;
      if (open) pushLayer(id, special[id] || (() => { el.hidden = true; }));
      else dropLayer(id);
    }).observe(el, { attributes: true, attributeFilter: ["hidden"] });
  }
})();

(async function boot() {
  renderSegButtons();
  loadPrograms();
  setInterval(() => { if (document.visibilityState === "visible") loadPrograms(); }, 60000);
  loadHome();
  // invited guests (one-time link) browse without a name; they're asked only if they post or comment
  if (new URLSearchParams(location.search).has("invited")) { lsSet("event_viewer", "1"); history.replaceState(history.state, "", location.pathname); }
  if (!lsGet(FULLNAME_KEY) && !lsGet("event_viewer")) setTimeout(() => askName(false), 600);   // also re-asks guests from before the list existed
  loadSocial();
  setInterval(() => { if (document.visibilityState === "visible") loadSocial(); }, 30000);
  setTimeout(loadActivity, 2500);
  let last = null;
  try { last = sessionStorage.getItem("event_screen"); } catch {}
  if (last === "feed") openFeed();
  else if (last === "browse" || last === "profile") openExplore();

  if (state.sid) {
    try {
      const data = await api(`/api/session/${state.sid}`);
      renderResults(data);          // ready for "Show pictures of me", but only shown when asked
      if (!last || last === "results") show("results");
    } catch {
      forgetLocal();
    }
  }
})();
