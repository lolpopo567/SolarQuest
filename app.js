/* Solar Quest client. Scoring runs in web/engine.js on this device (no server since 8 Oct 2026); this file is the
   interface. All text comes from content/ui.yaml and content/dialogue.yaml via t() and the engine. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NAMES = { inspector_m: "Senior Inspector", inspector_f: "Agency Officer", sat: "SAT · orbital feed",
                news: "Channel 38 News" };                                                             // names stay English
const speaker = (c) => c === "player" ? playerName() : NAMES[c] || c;    // "player" is the main character
const ha = (m2) => (m2 / 1e4).toLocaleString(undefined, { maximumFractionDigits: 1 });

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const S = {
  config: null, art: null, playerId: null, level: null, attemptId: null, map: null, P: null,
  fp: null, sites: [], tool: null, drag: null, inspectTimer: null, lastWarn: "", overlays: new Set(),
  basemap: "satellite", timer: null, deadline: null, frames: [], playTimer: null, revealed: false, floodSeen: false,
  roof: false, roofFC: null, sel: new Map(), roofLayer: null, heatRange: [55, 90],
};
const HEAT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];

async function api(path, opts = {}) {                 // the same calls the server used to answer
  try { return await SQEngine.handle(opts.method || "GET", path, opts.body); }
  catch (e) { throw Object.assign(new Error(e.message), { status: e.status || 500 }); }
}

/* ------------------------------------------------------------------ text (content/ui.yaml, Thai or English) */
let UI = {};
const lang = () => SQEngine.lang;
const pickT = (node) => node && (node[lang()] || node.en);
function t(key, vars = {}) {
  const v = pickT(UI[key]);
  if (v == null) { console.warn("no text for", key); return key; }
  return v.replace(/{(\w+)}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
const tr = (table, key, fallback) => ((UI[table] || {})[key] || {})[lang()] || fallback;   // optional translations
function applyI18n(root = document) {
  $$("[data-t]", root).forEach((el) => { el.textContent = t(el.dataset.t); });
  $$("[data-t-title]", root).forEach((el) => { el.title = t(el.dataset.tTitle); });
  $$("[data-t-ph]", root).forEach((el) => { el.placeholder = t(el.dataset.tPh); });
  document.documentElement.lang = lang();
}
const levelTitle = (id, fallback) => tr("levels", id, fallback);
const unitT = (u) => tr("units", u, u);
const exclT = (n) => tr("excl_reason", n, n);
const verdictT = (g) => t(`grade_${g}`);

/* ------------------------------------------------------------------ sprites (always through the manifest) */
function spriteUrl(key, width) {
  for (const ch of Object.keys(S.art.characters)) {
    if (key.startsWith(ch + "_")) {
      const emo = key.slice(ch.length + 1);
      const e = S.art.characters[ch][emo] || S.art.characters[ch].default;   // spec: fall back to _default
      const ws = Object.keys(e.webp).map(Number).sort((a, b) => a - b);
      const w = ws.find((x) => x >= width) || ws[ws.length - 1];
      return e.webp[String(w)];
    }
  }
  console.error("unknown sprite", key);
  return "";
}
function preload(keys) {
  keys = keys.filter(Boolean);                                   // speakers without a portrait have no sprite
  const urls = keys.flatMap((k) => k.startsWith("sat_") ? [spriteUrl(k, 128)] : [spriteUrl(k, 512), spriteUrl(k, 256)]);
  return Promise.all(urls.map((u) => new Promise((res) => { const i = new Image(); i.onload = i.onerror = res; i.src = u; })));
}
const dline = (key, vars) => SQEngine.say(key, vars);            // a reaction line from content/dialogue.yaml
function eventLine(event, text) {           // client-side events, sprite from the server's event map
  const sprite = S.config.event_sprites[event];
  return { sprite, character: sprite.split("_").slice(0, sprite.startsWith("sat") ? 1 : 2).join("_"), text,
           layout: sprite.startsWith("sat") ? "hud" : sprite.startsWith("inspector_m") ? "bust_left" : "bust_right" };
}

/* ------------------------------------------------------------------ dialogue (visual-novel layout) */
/* Lines appear letter by letter. Tap / Space while a line is typing shows the rest at once; the next tap moves on.
   TYPE_MS is the time per letter: slow enough for a voice blip on each one. Sentence ends and commas pause. */
const TYPE_MS = 45;
const TYPE_PAUSE = { ".": 280, "!": 280, "?": 280, "…": 280, ":": 180, ";": 180, ",": 140, "。": 280 };
const graphemes = (s) => typeof Intl !== "undefined" && Intl.Segmenter      // Thai vowels and tone marks stay on their letter
  ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].map((x) => x.segment)
  : (s.match(/\P{M}\p{M}*/gu) || []);
let typing = null;                           // the line being typed: { finish() }
function typeLine(el, text, character, box = el.closest(".vn-box")) {   // box gets .typing while it runs
  if (typing) typing.finish();
  // the whole line is laid out from the start (the unread part invisible), so words never jump between lines
  el.textContent = "";
  const shown = document.createTextNode(""), rest = document.createElement("span");
  rest.className = "vn-rest"; rest.textContent = text;
  el.append(shown, rest);
  const parts = graphemes(text);
  let k = 0, typed = "", timer = null;
  return new Promise((done) => {
    const end = () => { clearTimeout(timer); Snd.typing(false); shown.data = text; rest.textContent = ""; typing = null; box.classList.remove("typing"); done(); };
    const step = () => {
      if (k >= parts.length) return end();
      const ch = parts[k++];
      typed += ch; shown.data = typed; rest.textContent = text.slice(typed.length);
      timer = setTimeout(step, TYPE_MS + (TYPE_PAUSE[ch] && k < parts.length ? TYPE_PAUSE[ch] : 0));
    };
    typing = { finish: end };
    box.classList.add("typing");
    Snd.typing(true);                        // the dialogue sound (sound.js) runs while the line types out
    step();
  });
}
function playDialogue(lines) {
  return new Promise((resolve) => {
    if (!lines.length) return resolve();
    const vn = $("#vn"); let i = -1;
    const show = () => {
      if (typing) return typing.finish();                    // first tap: show the whole line
      i += 1;
      if (i >= lines.length) { vn.classList.add("hidden"); vn.onclick = null; document.onkeydown = null; return resolve(); }
      const ln = lines[i];
      $("#vn-name").textContent = speaker(ln.character);
      typeLine($("#vn-text"), ln.text, ln.character);
      const left = $("#vn-left"), right = $("#vn-right"), sat = $("#vn-sat");
      sat.classList.toggle("hidden", ln.layout !== "hud");
      if (ln.layout === "hud") { sat.src = spriteUrl(ln.sprite, 128); setSat(ln.sprite); }
      if (ln.layout === "bust_left") { left.src = spriteUrl(ln.sprite, 512); left.classList.remove("hidden", "dim"); right.classList.add("dim"); }
      if (ln.layout === "bust_right") { right.src = spriteUrl(ln.sprite, 512); right.classList.remove("hidden", "dim"); left.classList.add("dim"); }
      if (ln.layout === "hud" || ln.layout === "none") { left.classList.add("dim"); right.classList.add("dim"); }
    };
    $("#vn-left").classList.add("hidden"); $("#vn-right").classList.add("hidden");
    vn.classList.remove("hidden"); vn.focus();
    vn.onclick = show;
    document.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); show(); } };
    show();
  });
}
let toastTimer = null;
function toast(line) {
  $("#toast-img").src = spriteUrl(line.sprite, 256);
  $("#toast-text").textContent = line.text;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 5500);
}
function setSat(sprite, status) {
  $("#sat-img").src = spriteUrl(sprite, 128);
  if (status !== undefined) $("#sat-status").textContent = status;
}

/* ------------------------------------------------------------------ home */
const renderHome = () => { Snd.stop(); return showScreen("home", fillHome); };   // the computer is quiet
async function fillHome() {
  $("#who").textContent = playerName();
  if (!S.desktopReady) initDesktop();
  const list = await refreshDay();
  $("#day-done").classList.toggle("hidden", !evening());
  const ol = $("#level-list"); ol.innerHTML = "";
  for (const l of list) {
    const li = document.createElement("li");
    const today = l.unlocked && l.level_number <= S.day;              // one new exercise per day
    li.className = "level-card" + (today ? "" : " locked");
    const grade = l.best_score == null ? "" : gradeBadge(gradeOf(l.best_score), "chip");
    li.innerHTML = `<div class="num">${l.level_number}</div>
      <div><strong>${esc(levelTitle(l.level_id, l.title))}</strong><div class="meta">${esc(areaName(l.area_id))} · ${t("mission_" + l.mission_type)}
      ${l.season_be ? "· " + t("season_be", { be: l.season_be }) : ""} ${l.attempts ? "· " + t("attempts", { n: l.attempts }) : ""}</div></div>
      <div class="lv-right">${grade}<button class="${today ? "primary" : ""}" ${today ? "" : "disabled"}>${today ? t("begin") : t("on_day", { n: l.level_number })}</button></div>`;
    if (today) $("button", li).onclick = () => startLevel(l.level_id);
    ol.appendChild(li);
  }
}
const gradeOf = (s) => s >= 90 ? "S" : s >= 75 ? "A" : s >= 60 ? "B" : s >= 40 ? "C" : "E";
const areaName = (a) => tr("areas", a, a);
function gradeBadge(g, cls = "") {                     // every grade (S, A, B, C, E) has art; the CSS stamp is the fallback
  const art = (S.art.ui || {})[`grade-${g.toLowerCase()}`];
  if (art) { const w = Object.keys(art).map(Number).sort((a, b) => a - b); return `<img class="grade-img ${cls}" alt="${g}" src="${art[String(cls === "chip" ? w[0] : w[w.length - 1])]}">`; }
  return `<span class="grade-chip ${cls}">${g}</span>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* Page changes: the old page fades to black, the new one fades in from black. prepare() runs while the screen is
   black (the new page is already laid out underneath, so maps get their size). Same-page refreshes (language
   switch) skip the fade unless force is set (retry / next exercise). */
const FADE_OUT_MS = 600, FADE_HOLD_MS = 250, FADE_IN_MS = 700;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function showScreen(id, prepare, force = false) {
  const cur = document.querySelector(".screen.active");
  const swap = () => $$(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
  if (!cur || (cur.id === id && !force)) { swap(); if (prepare) await prepare(); return; }
  const f = $("#fader");
  if (f.classList.contains("boot")) { f.classList.remove("boot"); void f.offsetWidth; }   // end the first-load animation
  f.classList.add("busy");                                    // no clicks while the screen changes
  f.style.transitionDuration = FADE_OUT_MS + "ms"; f.classList.add("on");
  await wait(FADE_OUT_MS);
  swap();
  try { if (prepare) await prepare(); }
  finally {
    await wait(FADE_HOLD_MS);
    f.style.transitionDuration = FADE_IN_MS + "ms"; f.classList.remove("on");
    await wait(FADE_IN_MS);
    f.classList.remove("busy");
  }
}

/* ------------------------------------------------------------------ level flow */
async function startLevel(levelId) {
  const name = playerName();
  await api("/api/players", { method: "POST", body: { player_id: S.playerId, name } });
  const lv = await api(`/api/levels/${levelId}`);
  S.level = lv; S.revealed = false; S.fp = null; S.sites = []; S.boxMode = false; S.attemptId = null; S.floodSeen = false;
  S.roof = lv.mission_type === "rooftop"; S.mixed = lv.mission_type === "mixed";
  S.sel = new Map(); S.roofLayer = null; S.groundArea = 0; S.roofArea = 0; S.optFeats = [];
  proj4.defs("EPSG:32647", lv.proj4_scoring);
  S.P = proj4("EPSG:4326", "EPSG:32647");
  await preload([...lv.preload, "inspector_f_default", "sat_taunt", "sat_smile"]);   // no pop-in mid-dialogue

  await showScreen("game", async () => {                       // set up under the black screen
    $("#lv-num").textContent = t("exercise_n", { n: lv.level_number });
    $("#lv-title").textContent = levelTitle(lv.level_id, lv.title);
    $("#lv-season").textContent = lv.season_be ? `· BE ${lv.season_be}${lv.season_complete ? "" : " " + t("in_progress")}` : "";
    $("#tabbtn-reveal").classList.add("hidden");
    $("#tab-reveal").innerHTML = "";
    selectTab("dash");
    await buildMap(lv);
    if (S.roof || S.mixed) await loadRoofs(lv);
    $$(".tool[data-tool]").forEach((b) => b.classList.toggle("hidden", S.roof));
    updateSiteButton();
    $("#btn-box").classList.toggle("hidden", !(S.roof || S.mixed));
    $("#btn-clear").dataset.t = S.roof ? "tool_clear_roofs" : "tool_clear";      // roof-only maps clear the roofs
    $("#btn-clear").textContent = t($("#btn-clear").dataset.t);
    $("#btn-box").classList.remove("active");
    $("#fp-summary").textContent = t(S.roof ? "fp_roofs" : S.mixed ? "fp_mixed" : "fp_place");
    buildCards(lv);
    buildStreetView(lv);
    buildTimeline(lv);
    $("#btn-hint").classList.toggle("hidden", !lv.hints_enabled);
    setSat(lv.sat_line.sprite, lv.sat_line.text);
    updateBudget(0);
  }, true);

  $("#memo-text").textContent = lv.briefing_text;
  $("#memo").classList.remove("hidden");
  await new Promise((res) => { $("#memo-ok").onclick = () => { $("#memo").classList.add("hidden"); res(); }; });
  await playDialogue(lv.briefing);
  const st = await api(`/api/levels/${levelId}/start`, { method: "POST", body: { player_id: S.playerId } });
  S.attemptId = st.attempt_id;
  startTimer(st.time_limit_s);
  if (S.roof) roofHelp(); else setTool("rect");
}

function startTimer(limit) {
  clearInterval(S.timer); $("#timer").classList.add("hidden");
  if (!limit) return;
  S.deadline = Date.now() + limit * 1000;
  $("#timer").classList.remove("hidden");
  const tick = () => {
    const left = Math.max(0, Math.round((S.deadline - Date.now()) / 1000));
    $("#timer").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    $("#timer").classList.toggle("low", left <= 60);
    if (left === 0) { clearInterval(S.timer); if (!S.revealed) submit(true); }
  };
  tick(); S.timer = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ map */
function basemapStyle() {
  const b = S.config.basemaps, sources = {}, layers = [{ id: "bg", type: "background", paint: { "background-color": "#dcd9d0" } }];
  for (const id of ["satellite", "streets"]) {
    if (!b[id]) continue;   // no satellite without a MapTiler key: Sentinel-2 stands in
    sources[id] = { type: "raster", tiles: b[id].tiles, tileSize: b[id].tileSize || 256, attribution: b[id].attribution, maxzoom: 19 };
    layers.push({ id, type: "raster", source: id, layout: { visibility: "none" } });
  }
  return { version: 8, sources, layers };
}

function basemapOrder() {
  const b = S.config.basemaps;
  return [...(b.satellite ? ["satellite"] : []), ...(S.level.dashboard.basemap_s2 ? ["sentinel-2"] : []), "streets"];
}

function buildMap(lv) {
  return new Promise((resolve) => {
    if (S.map) S.map.remove();
    const [w, s, e, n] = lv.bbox;
    const pad = 0.15 * Math.max(e - w, n - s);
    const map = new maplibregl.Map({
      container: "map", style: basemapStyle(), bounds: [[w, s], [e, n]], fitBoundsOptions: { padding: 30 },
      maxBounds: [[w - pad, s - pad], [e + pad, n + pad]], minZoom: lv.zoom_min, maxZoom: lv.zoom_max,
      attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
    });
    S.map = map; S.overlays = new Set();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    if (S.config.basemaps.logo) {
      const logo = document.createElement("a");
      logo.className = "maptiler-logo"; logo.href = "https://www.maptiler.com"; logo.target = "_blank";
      logo.innerHTML = '<img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler logo">';
      map.getContainer().appendChild(logo);
    }
    map.on("load", () => {
      const s2 = lv.dashboard.basemap_s2;
      if (s2) {
        map.addSource("s2", { type: "image", url: `levels/${lv.level_id}/${s2.file}`, coordinates: s2.corners });
        map.addLayer({ id: "s2", type: "raster", source: "s2", layout: { visibility: "none" },
                       paint: { "raster-fade-duration": 0 } });
      }
      setBasemap(basemapOrder().includes(S.basemap) ? S.basemap : basemapOrder()[0]);
      const empty = { type: "FeatureCollection", features: [] };
      const taken = lv.dashboard.taken_sites;                    // earlier exercises' approved sites: off limits
      if (taken) {
        map.addSource("taken", { type: "geojson", data: { type: "Feature", geometry: taken, properties: {} } });
        map.addLayer({ id: "taken-fill", type: "fill", source: "taken", paint: { "fill-color": "#3a3f4b", "fill-opacity": 0.55 } });
        map.addLayer({ id: "taken-line", type: "line", source: "taken",
                       paint: { "line-color": "#f0a43a", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
        const ring = taken.type === "Polygon" ? taken.coordinates[0] : taken.coordinates.flatMap((p) => p[0]);
        const xs = ring.map((c) => c[0]), ys = ring.map((c) => c[1]);
        const tag = document.createElement("div");
        tag.className = "taken-tag";
        tag.textContent = "🚧 " + t("taken_label");
        new maplibregl.Marker({ element: tag }).setLngLat([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]).addTo(map);
      }
      map.addSource("fp", { type: "geojson", data: empty });
      map.addSource("fp-handles", { type: "geojson", data: empty });
      map.addSource("optimal", { type: "geojson", data: empty });
      map.addLayer({ id: "fp-fill", type: "fill", source: "fp",                 // the selected site is brighter
                     paint: { "fill-color": "#e8b33a", "fill-opacity": ["case", ["==", ["get", "active"], 1], 0.32, 0.18] } });
      map.addLayer({ id: "fp-line", type: "line", source: "fp",
                     paint: { "line-color": "#e8b33a", "line-width": ["case", ["==", ["get", "active"], 1], 3, 2] } });
      map.addLayer({ id: "optimal-line", type: "line", source: "optimal",
                     paint: { "line-color": "#ffffff", "line-width": 3, "line-dasharray": [2, 1.5] } });
      map.addLayer({ id: "fp-handles", type: "circle", source: "fp-handles",
                     paint: { "circle-radius": ["case", ["==", ["get", "kind"], "rotate"], 8, 7],
                              "circle-color": ["case", ["==", ["get", "kind"], "rotate"], "#1d2a44", "#ffffff"],
                              "circle-stroke-color": "#1d2a44", "circle-stroke-width": 2 } });
      wireFootprint(map);
      resolve();
    });
  });
}
const FIRST_FP_LAYER = "fp-fill";

function setOverlay(id, url, on, opacity = 0.75) {
  const map = S.map, src = "ov-" + id;
  if (on && !map.getSource(src)) {
    map.addSource(src, { type: "image", url, coordinates: S.level.dashboard.overlay_corners });
    map.addLayer({ id: src, type: "raster", source: src,
                   paint: { "raster-opacity": opacity, "raster-resampling": "nearest", "raster-fade-duration": 0 } },
                 FIRST_FP_LAYER);
  }
  if (map.getLayer(src)) map.setLayoutProperty(src, "visibility", on ? "visible" : "none");
}

function setBasemap(name) {
  S.basemap = name;
  for (const id of ["satellite", "streets", "s2"]) {
    if (S.map.getLayer(id)) S.map.setLayoutProperty(id, "visibility", (id === "s2" ? "sentinel-2" : id) === name ? "visible" : "none");
  }
  $("#btn-basemap").textContent = t("basemap", { name });
  $("#btn-basemap").title = name === "sentinel-2" ? S.level.dashboard.basemap_s2.attribution : "";
}
$("#btn-basemap").onclick = () => {
  const order = basemapOrder();
  setBasemap(order[(order.indexOf(S.basemap) + 1) % order.length]);
};

/* ------------------------------------------------------------------ rooftop missions: pick whole roofs */
async function loadRoofs(lv) {
  const url = `levels/${lv.level_id}/${lv.dashboard.roofs}`;
  S.roofFC = await (await fetch(url)).json();
  const map = S.map;
  map.addSource("roofs", { type: "geojson", data: S.roofFC, promoteId: "id" });
  map.addLayer({ id: "roofs-fill", type: "fill", source: "roofs",
                 paint: { "fill-color": roofFillColor(), "fill-opacity": ["case", ["==", ["coalesce", ["get", "x"], 0], 1], 0.92,
                                                                    ["boolean", ["feature-state", "sel"], false], 0.85, 0.6] } },
               FIRST_FP_LAYER);
  map.addLayer({ id: "roofs-line", type: "line", source: "roofs",
                 paint: { "line-color": ["case", ["boolean", ["feature-state", "sel"], false], "#e8b33a", "rgba(20,24,30,0.45)"],
                          "line-width": ["case", ["boolean", ["feature-state", "sel"], false], 2.5, 0.6] } }, FIRST_FP_LAYER);
  map.on("click", "roofs-fill", (e) => toggleRoof(e.features[0]));
  wireBoxSelect(map);
  map.on("mouseenter", "roofs-fill", () => (map.getCanvas().style.cursor = S.revealed ? "" : "pointer"));
  map.on("mouseleave", "roofs-fill", () => (map.getCanvas().style.cursor = ""));
}
function roofFillColor() {
  if (S.revealed) {
    const [lo, hi] = S.heatRange;
    return ["case", ["<=", ["coalesce", ["feature-state", "w"], 0], 0], "#8a8984",
            ["interpolate", ["linear"], ["coalesce", ["feature-state", "w"], 0],
             ...HEAT.flatMap((c, i) => [lo + (i * (hi - lo)) / (HEAT.length - 1), c])]];
  }
  const sel = ["case", ["==", ["coalesce", ["get", "x"], 0], 1], "#15171c",          // already has solar: near black
               ["boolean", ["feature-state", "sel"], false], "#e8b33a"];
  const c = S.roofLayer;
  if (!c) return [...sel, "#d9d4c7"];
  const lg = c.legend, n = lg.colors.length;
  return [...sel, ["interpolate", ["linear"], ["get", c.prop],
                   ...lg.colors.flatMap((col, i) => [lg.min + (i * (lg.max - lg.min)) / (n - 1), col])]];
}
function roofHelp() {
  const help = $("#draw-help");
  const cap = S.level.dashboard.max_roof_m2;
  help.textContent = t("help_roofs") + (cap ? " " + t("help_roofs_taken", { m: cap.toLocaleString("en-US") }) : "");
  help.classList.remove("hidden");
  clearTimeout(S.helpTimer);
  S.helpTimer = setTimeout(() => help.classList.add("hidden"), 9000);
}
const roofBudget = () => S.mixed ? S.level.roof_budget_m2 : S.level.budget_m2;
function toggleRoof(f) {
  if (S.revealed || !S.attemptId) return;
  if (S.fp && S.fp.mode === "poly" && !S.fp.closed) return;          // a click while drawing adds a corner, not a roof
  const id = f.properties.id, u = f.properties.u;
  if (f.properties.x) { toast(eventLine("rules", t("roof_has_solar"))); return; }   // large roof: already has panels
  if (S.sel.has(id)) S.sel.delete(id);
  else {
    const now = [...S.sel.values()].reduce((a, b) => a + b, 0), budget = roofBudget();
    if (now + u > budget * 1.001) {
      toast(dline("warn_roof_adds", { area: u.toLocaleString("en-US"), left: Math.max(0, budget - now).toLocaleString("en-US") }));
      return;
    }
    S.sel.set(id, u);
  }
  S.map.setFeatureState({ source: "roofs", id }, { sel: S.sel.has(id) });
  updateBudget([...S.sel.values()].reduce((a, b) => a + b, 0), "roofs");
  scheduleInspect();
}
/* Drag-select (owner request 10 Oct 2026: small roofs are hard to tap one by one). Roofs inside the box are added,
   largest first, until the budget is full; if every free roof in the box is already picked, the box removes them. */
function selectRoofsIn(feats) {
  if (S.revealed || !S.attemptId) return;
  const seen = new Set(), roofs = [];
  for (const f of feats) if (!seen.has(f.properties.id) && !f.properties.x) { seen.add(f.properties.id); roofs.push(f); }
  if (!roofs.length) return;
  const budget = roofBudget();
  let now = [...S.sel.values()].reduce((a, b) => a + b, 0), skipped = 0;
  if (roofs.every((f) => S.sel.has(f.properties.id))) {
    for (const f of roofs) { S.sel.delete(f.properties.id); S.map.setFeatureState({ source: "roofs", id: f.properties.id }, { sel: false }); }
  } else {
    for (const f of roofs.filter((f) => !S.sel.has(f.properties.id)).sort((a, b) => b.properties.u - a.properties.u)) {
      if (now + f.properties.u > budget * 1.001) { skipped++; continue; }
      S.sel.set(f.properties.id, f.properties.u); now += f.properties.u;
      S.map.setFeatureState({ source: "roofs", id: f.properties.id }, { sel: true });
    }
    if (skipped) toast(eventLine("rules", t("box_full", { n: skipped })));
  }
  updateBudget([...S.sel.values()].reduce((a, b) => a + b, 0), "roofs");
  scheduleInspect();
}
function setBoxMode(on) {
  S.boxMode = on;
  $("#btn-box").classList.toggle("active", on);
  S.map.dragPan[on ? "disable" : "enable"]();
  S.map.getCanvas().style.cursor = on ? "crosshair" : "";
  const help = $("#draw-help");
  help.textContent = t(on ? "help_box" : "help_roofs");
  help.classList.remove("hidden");
  clearTimeout(S.helpTimer);
  S.helpTimer = setTimeout(() => help.classList.add("hidden"), 9000);
}
function wireBoxSelect(map) {
  let start = null, last = null, el = null;
  const at = (e) => e.point;                                     // touchend has no reliable point: use the last move
  const down = (e) => {
    if (!S.boxMode || S.revealed) return;
    if (e.originalEvent.touches && e.originalEvent.touches.length > 1) return;   // two fingers: zoom as usual
    start = last = at(e);
    el = document.createElement("div"); el.className = "sel-box";
    map.getContainer().appendChild(el);
  };
  const move = (e) => {
    if (!start) return;
    const p = last = at(e);
    Object.assign(el.style, { left: Math.min(start.x, p.x) + "px", top: Math.min(start.y, p.y) + "px",
                              width: Math.abs(p.x - start.x) + "px", height: Math.abs(p.y - start.y) + "px" });
  };
  const up = (e) => {
    if (!start) return;
    const p = last || start, a = start;
    start = null; el.remove(); el = null;
    if (Math.hypot(p.x - a.x, p.y - a.y) < 6) return;            // a tap: the normal click picks one roof
    selectRoofsIn(map.queryRenderedFeatures([[Math.min(a.x, p.x), Math.min(a.y, p.y)], [Math.max(a.x, p.x), Math.max(a.y, p.y)]],
                                            { layers: ["roofs-fill"] }));
  };
  map.on("mousedown", down); map.on("touchstart", down);
  map.on("mousemove", move); map.on("touchmove", move);
  map.on("mouseup", up); map.on("touchend", up);
}
$("#btn-box").onclick = () => setBoxMode(!S.boxMode);
function setRoofLayer(card, on) {
  S.roofLayer = on ? card : null;
  $$("#cards input[data-roof]").forEach((x) => { if (x.dataset.layer !== card.id) x.checked = false; });
  S.map.setPaintProperty("roofs-fill", "fill-color", roofFillColor());
}
function clearRoofs() {
  for (const id of S.sel.keys()) S.map.setFeatureState({ source: "roofs", id }, { sel: false });
  S.sel = new Map(); updateBudget(0, "roofs");
  if (S.roof) $("#fp-summary").textContent = t("fp_roofs");
}

/* ------------------------------------------------------------------ footprint tool (geometry in EPSG:32647) */
const fwd = (ll) => S.P.forward(ll);
const inv = (xy) => S.P.inverse(xy);

function rectCorners(f) {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const lx = sx * f.w / 2, ly = sy * f.h / 2;
    return [f.cx + lx * c - ly * s, f.cy + lx * s + ly * c];
  });
}
function rotateHandle(f) {
  const d = f.h / 2 + Math.max(40, 0.25 * f.h), c = Math.cos(f.angle), s = Math.sin(f.angle);
  return [f.cx - d * s, f.cy + d * c];
}
/* Up to C.max_sites separate sites (2026-10-10): S.sites holds them, S.fp is the one being edited. */
function ringXY(f = S.fp) {
  if (!f) return null;
  if (f.mode === "rect") return rectCorners(f);
  return f.pts.length >= 3 && f.closed ? f.pts : null;
}
const siteRings = () => S.sites.map((f) => ringXY(f)).filter(Boolean);
const maxSites = () => SQEngine.content().config.max_sites || 1;
const sitesOverlap = () => SQEngine.sitesOverlap(siteRings());
function areaXY(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
function geometry() {                                    // Polygon for one site, MultiPolygon for several
  const polys = siteRings().map((ring) => { const ll = ring.map(inv); return [[...ll, ll[0]]]; });
  if (!polys.length) return null;
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
}

function renderFootprint() {
  const map = S.map;
  const feats = [];
  S.sites.forEach((f, i) => {
    const ring = ringXY(f), props = { site: i, active: f === S.fp ? 1 : 0 };
    if (ring) { const ll = ring.map(inv); feats.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [[...ll, ll[0]]] }, properties: props }); }
    else if (f.mode === "poly" && f.pts.length) {
      const ll = f.pts.map(inv);
      feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: ll.length > 1 ? ll : [ll[0], ll[0]] }, properties: props });
    }
  });
  map.getSource("fp").setData({ type: "FeatureCollection", features: feats });
  const handles = [];
  if (S.fp && !S.revealed) {
    if (S.fp.mode === "rect") {
      rectCorners(S.fp).forEach((xy, i) => handles.push(pt(inv(xy), { kind: "corner", i })));
      handles.push(pt(inv(rotateHandle(S.fp)), { kind: "rotate" }));
    } else {
      S.fp.pts.forEach((xy, i) => handles.push(pt(inv(xy), { kind: "vertex", i })));
    }
  }
  map.getSource("fp-handles").setData({ type: "FeatureCollection", features: handles });
  updateBudget(siteRings().reduce((a, r) => a + areaXY(r), 0));
  updateSiteButton();
}
function updateSiteButton() {
  const b = $("#btn-add-site");
  b.textContent = t("tool_add_site", { n: S.sites.length, max: maxSites() });
  b.disabled = S.revealed || S.sites.length >= maxSites() || (S.fp && S.fp.mode === "poly" && !S.fp.closed);
  b.classList.toggle("hidden", !!S.roof);
}
function addSite() {                                     // a new rectangle beside the others, sized to the budget left
  if (S.revealed || S.roof || S.sites.length >= maxSites()) return;
  const used = siteRings().reduce((a, r) => a + areaXY(r), 0), left = S.level.budget_m2 - used;
  const side = Math.sqrt(Math.max(0.1 * S.level.budget_m2, Math.min(0.5 * S.level.budget_m2, 0.8 * left)));
  const c = fwd(S.map.getCenter().toArray());
  const f = { mode: "rect", cx: c[0], cy: c[1], w: side, h: side, angle: 0 };
  for (let k = 0; k < 12 && SQEngine.sitesOverlap([...siteRings(), rectCorners(f)]); k++) f.cx += 1.2 * side;   // step clear of the others
  S.sites.push(f); S.fp = f;
  $$(".tool[data-tool]").forEach((x) => x.classList.toggle("active", x.dataset.tool === "rect"));
  renderFootprint(); scheduleInspect();
}
const pt = (c, p) => ({ type: "Feature", geometry: { type: "Point", coordinates: c }, properties: p });

function updateBudget(area, kind = S.roof ? "roofs" : "ground") {
  if (kind === "roofs") S.roofArea = area; else S.groundArea = area;
  const gb = S.level.budget_m2, rb = S.roof || S.mixed ? roofBudget() : 0;
  const overG = !S.roof && S.groundArea > gb * 1.001, overR = rb > 0 && S.roofArea > rb * 1.001;
  const m2 = (x) => Math.round(x).toLocaleString();
  let text, frac;
  if (S.mixed) {
    text = t("budget_mixed", { g: ha(S.groundArea), gb: ha(gb), r: m2(S.roofArea), rb: m2(rb) });
    frac = Math.max(S.groundArea / gb, S.roofArea / rb);
  } else if (S.roof) { text = t("budget_roofs", { used: m2(S.roofArea), budget: m2(rb) }); frac = S.roofArea / rb; }
  else { text = t("budget_ground", { used: ha(S.groundArea), budget: ha(gb) }); frac = S.groundArea / gb; }
  $("#budget-text").textContent = text;
  $("#budget-fill").style.width = `${Math.min(100, 100 * frac)}%`;
  $("#budget-fill").classList.toggle("over", overG || overR);
  const any = S.mixed ? S.groundArea > 0 || S.roofArea > 0 : (S.roof ? S.roofArea : S.groundArea) > 0;
  const clash = !S.roof && S.sites.length > 1 && sitesOverlap();
  $("#btn-submit").disabled = !any || overG || overR || clash || S.revealed || !S.attemptId;
  $("#btn-submit").title = overG || overR ? t("over_budget") : clash ? t("sites_overlap") : "";
}

function setTool(tool) {
  if (S.revealed || S.roof) return;
  S.tool = tool;
  $$(".tool[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  const help = $("#draw-help");
  const put = (f) => {                                    // the tool reshapes the selected site, or makes the first one
    const i = S.sites.indexOf(S.fp);
    if (i >= 0) S.sites[i] = f; else S.sites.push(f);
    S.fp = f;
  };
  if (tool === "rect") {
    if (!S.fp || S.fp.mode !== "rect") {
      const st = !S.sites.length && S.level.dashboard.start_footprint;   // the first square starts on a poor spot
      const c = st ? fwd(st.center) : fwd(S.map.getCenter().toArray());  // (startspot.py): it must be moved to pass
      const side = Math.sqrt(0.5 * S.level.budget_m2);
      put({ mode: "rect", cx: c[0], cy: c[1], w: side, h: side, angle: 0 });
      if (S.sites.length === 1) {
        const r = 3 * side;                                 // bring the new footprint to a workable size on screen
        S.map.fitBounds([inv([c[0] - r, c[1] - r]), inv([c[0] + r, c[1] + r])], { duration: 600 });
      }
    }
    help.textContent = t("help_rect");
  } else {
    put({ mode: "poly", pts: [], closed: false });
    help.textContent = t("help_poly");
  }
  help.classList.remove("hidden");
  clearTimeout(S.helpTimer);
  S.helpTimer = setTimeout(() => help.classList.add("hidden"), 9000);
  S.map.doubleClickZoom[tool === "poly" ? "disable" : "enable"]();
  renderFootprint(); scheduleInspect();
}
$$(".tool[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
$("#btn-add-site").onclick = addSite;
$("#btn-clear").onclick = () => {                         // removes the selected site; roofs when no site is left
  if (S.revealed) return;
  if (S.roof) return clearRoofs();
  if (!S.sites.length) { if (S.mixed) clearRoofs(); return; }
  S.sites = S.sites.filter((f) => f !== S.fp);
  S.fp = S.sites[S.sites.length - 1] || null;
  renderFootprint();
  if (S.sites.length || (S.mixed && S.sel.size)) scheduleInspect(); else $("#fp-summary").textContent = t("fp_place");
};

function wireFootprint(map) {
  const startDrag = (e, kind, i) => {
    if (S.revealed || !S.fp || S.boxMode) return;
    e.preventDefault();
    map.dragPan.disable();
    S.drag = { kind, i, start: fwd(e.lngLat.toArray()), fp: JSON.parse(JSON.stringify(S.fp)) };
  };
  const onHandle = (e) => { const f = e.features[0]; startDrag(e, f.properties.kind, f.properties.i); };
  const onBody = (e) => {
    if (map.queryRenderedFeatures(e.point, { layers: ["fp-handles"] }).length) return;
    if (S.fp && S.fp.mode === "poly" && !S.fp.closed) return;
    const hit = S.sites[e.features[0].properties.site];       // grab any site: it becomes the selected one
    if (hit && hit !== S.fp) { S.fp = hit; renderFootprint(); }
    startDrag(e, "move");
  };
  map.on("mousedown", "fp-handles", onHandle); map.on("touchstart", "fp-handles", onHandle);
  map.on("mousedown", "fp-fill", onBody); map.on("touchstart", "fp-fill", onBody);
  map.on("mouseenter", "fp-fill", () => (map.getCanvas().style.cursor = "move"));
  map.on("mouseleave", "fp-fill", () => (map.getCanvas().style.cursor = ""));
  map.on("mouseenter", "fp-handles", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "fp-handles", () => (map.getCanvas().style.cursor = ""));

  const onMove = (e) => {
    if (!S.drag) return;
    const p = fwd(e.lngLat.toArray()), d = S.drag, f = S.fp, o = d.fp;
    const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (d.kind === "move") {
      if (f.mode === "rect") { f.cx = o.cx + dx; f.cy = o.cy + dy; }
      else f.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
    } else if (d.kind === "corner") {
      const rx = p[0] - f.cx, ry = p[1] - f.cy, c = Math.cos(f.angle), s = Math.sin(f.angle);
      f.w = Math.max(2 * S.level.pixel_size_m / 4, 2 * Math.abs(rx * c + ry * s));
      f.h = Math.max(2 * S.level.pixel_size_m / 4, 2 * Math.abs(-rx * s + ry * c));
    } else if (d.kind === "rotate") {
      f.angle = Math.atan2(p[1] - f.cy, p[0] - f.cx) - Math.PI / 2;
    } else if (d.kind === "vertex") {
      f.pts[d.i] = [o.pts[d.i][0] + dx, o.pts[d.i][1] + dy];
    }
    renderFootprint();
  };
  const onUp = () => {
    if (!S.drag) return;
    S.drag = null; map.dragPan.enable(); scheduleInspect();
  };
  map.on("mousemove", onMove); map.on("touchmove", onMove);
  map.on("mouseup", onUp); map.on("touchend", onUp);

  map.on("click", (e) => {
    if (S.revealed || !S.fp || S.fp.mode !== "poly" || S.fp.closed) return;
    const pts = S.fp.pts;
    if (pts.length >= 3) {
      const first = map.project(inv(pts[0]));
      if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 14) { closePoly(); return; }
    }
    pts.push(fwd(e.lngLat.toArray()));
    renderFootprint();
  });
  map.on("dblclick", (e) => {
    if (!S.fp || S.fp.mode !== "poly" || S.fp.closed) return;
    e.preventDefault();
    // a double-click also fired two clicks: drop the duplicate vertex
    if (S.fp.pts.length > 3) S.fp.pts.pop();
    closePoly();
  });
}
function closePoly() {
  if (S.fp.pts.length < 3) return;
  S.fp.closed = true; S.map.doubleClickZoom.enable();
  renderFootprint(); scheduleInspect();
}

function scheduleInspect() {
  clearTimeout(S.inspectTimer);
  S.inspectTimer = setTimeout(inspect, 300);
}
async function inspect() {
  if (S.revealed) return;
  const parts = [];
  if (!S.roof && geometry()) parts.push({ geometry: geometry() });
  if ((S.roof || S.mixed) && S.sel.size) parts.push({ buildings: [...S.sel.keys()] });
  if (!parts.length) return;
  try {
    const rs = await Promise.all(parts.map((body) => api(`/api/levels/${S.level.level_id}/inspect`, { method: "POST", body })));
    const lines = [], warns = [];
    for (const r of rs) {
      const roofs = r.n_roofs !== undefined;
      const excl = Object.values(r.excluded_pct).reduce((a, b) => a + b, 0);
      lines.push(roofs
        ? t("roofs_summary", { n: r.n_roofs, area: Math.round(r.area_m2).toLocaleString("en-US") }) +
          (excl ? " · " + t("roofs_excluded", { pct: excl.toFixed(0) }) : "")
        : t("fp_summary", { area: ha(r.area_m2), budget: ha(r.budget_m2) }) +
          (S.sites.length > 1 ? " · " + t("fp_sites", { n: S.sites.length, pts: S.sites.length * 3 - 3 }) : "") +
          (r.on_map_pct < 100 ? " · " + t("fp_offmap", { pct: (100 - r.on_map_pct).toFixed(0) }) : "") +
          (excl ? " · " + t("fp_excluded", { pct: excl.toFixed(0) }) : ""));
      for (const [lid, v] of Object.entries(r.layers)) {
        const el = $(`#here-${roofs && S.mixed ? "r-" : ""}${lid}`); if (el) el.textContent = fmtHere(lid, v, roofs);
      }
      warns.push(...r.warnings);
      if (excl > 0) setSat("sat_shocked");
    }
    $("#fp-summary").innerHTML = lines.join("<br>");
    const key = warns.map((w) => w.text.split(" ")[0] + w.sprite).join("|");
    if (warns.length && key !== S.lastWarn) toast(warns[0]);
    S.lastWarn = key;
  } catch (e) {
    $("#fp-summary").textContent = /overlap/.test(e.message) ? t("sites_overlap") : e.message;
  }
}
function fmtHere(lid, v, roofs = S.roof) {
  if (!v) return "–";
  if (v.shares_pct) return Object.entries(v.shares_pct).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, p]) => `${k} ${p}%`).join(", ");
  const card = [...(roofs && S.mixed ? S.level.dashboard.roof_layers : S.level.dashboard.layers)].find((c) => c.id === lid);
  return `${fmtNum(v.mean, card.digits)} (${fmtNum(v.min, card.digits)}–${fmtNum(v.max, card.digits)})`;
}
const fmtNum = (x, d) => x == null ? "–" : Number(x).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

/* ------------------------------------------------------------------ dashboard cards */
function buildCards(lv) {
  const box = $("#cards"); box.innerHTML = "";
  for (const c of [...lv.dashboard.layers, ...(lv.dashboard.roof_layers || [])]) {
    const el = document.createElement("div");
    el.className = "card";
    const badges = [c.has_gaps ? `<span class="badge gap" title="${esc(t("badge_gaps_tip", { pct: c.gap_pct }))}">${t("badge_gaps")}</span>` : "",
                    c.hard_constraint ? `<span class="badge" title="${esc(t("badge_hard_tip"))}">${t("badge_hard")}</span>` : "",
                    c.scored ? "" : `<span class="badge off" title="${esc(t("badge_off_tip"))}">${t("badge_off")}</span>`].join(" ");
    let legend = "", district = "";
    if (c.legend.type === "ramp") {
      legend = `<div class="legend-ramp" style="background:linear-gradient(90deg,${c.legend.colors.join(",")})"></div>
        <div class="legend-ends"><span>${fmtNum(c.legend.min, c.digits)}${c.legend.zero_clear ? " " + t("zero_clear") : ""}</span><span>${fmtNum(c.legend.max, c.digits)} ${esc(unitT(c.unit))}</span></div>`;
      district = `<div class="row"><span>${t("district_mmm")}</span><span>${fmtNum(c.district.min, c.digits)} · ${fmtNum(c.district.median, c.digits)} · ${fmtNum(c.district.max, c.digits)}</span></div>`;
    } else {
      legend = `<div class="swatches">${c.legend.classes.map((k) => `<span><i style="background:${k.color}"></i>${esc(k.label)}</span>`).join("")}</div>`;
      district = `<div class="row"><span>${t("district")}</span><span>${Object.entries(c.district.shares_pct).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}%`).join(", ")}</span></div>`;
    }
    el.innerHTML = `<div class="card-head"><h3>${esc(c.label)}</h3>${badges}
        <label class="switch" title="${esc(t("show_on_map"))}"><input type="checkbox" aria-label="${esc(t("show_on_map"))}: ${esc(c.label)}"><span></span></label></div>
      <div class="desc">${esc(tr("layer_desc", c.id, c.description))}</div>${legend}${district}
      <div class="row"><span>${t(c.prop ? "on_your_roofs" : "in_your_footprint")}</span><span class="here" id="here-${c.prop && S.mixed ? "r-" : ""}${c.id}">–</span></div>`;
    $("input", el).dataset.layer = c.id;
    if (c.prop) $("input", el).dataset.roof = "1";
    $("input", el).onchange = (e) => c.prop ? setRoofLayer(c, e.target.checked)
                                            : setOverlay(c.id, `levels/${lv.level_id}/${c.png}`, e.target.checked);
    box.appendChild(el);
  }
}

/* ------------------------------------------------------------------ street photos (no hints here: hard rule 5) */
function buildStreetView(lv) {
  const btns = $("#sv-buttons"), view = $("#sv-view");
  btns.innerHTML = ""; view.innerHTML = "";
  (S.svMarkers || []).forEach((m) => m.remove());
  S.svMarkers = [];
  if (!lv.streetview_anchors.length) { view.innerHTML = `<p class="muted">${t("no_photos_mission")}</p>`; return; }
  lv.streetview_anchors.forEach((a, i) => {
    const b = document.createElement("button");
    b.textContent = t("photo_point", { n: i + 1 });
    b.onclick = () => openSv(a, b);
    btns.appendChild(b);
    const el = document.createElement("div");
    el.className = "sv-marker"; el.textContent = i + 1; el.title = t("photo_point", { n: i + 1 });
    el.onclick = () => { selectTab("sv"); openSv(a, b); };
    S.svMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(S.map));
  });
}
const MLY_JS = "https://unpkg.com/mapillary-js@4.1.2/dist/";
function loadMapillary() {
  if (window.mapillary) return Promise.resolve();
  if (!S.mlyLoading) S.mlyLoading = new Promise((ok, fail) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = MLY_JS + "mapillary.css"; document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = MLY_JS + "mapillary.js"; js.onload = ok; js.onerror = fail; document.head.appendChild(js);
  });
  return S.mlyLoading;
}
async function nearestImage(token, a) {
  // anchors built without an image id: nearest Mapillary photo within ~60 m
  const d = 0.0006, bbox = [a.lon - d, a.lat - d, a.lon + d, a.lat + d].map((v) => v.toFixed(6)).join(",");
  const q = new URLSearchParams({ access_token: token, bbox, limit: 50, fields: "id,captured_at,computed_geometry,geometry" });
  const r = await fetch(`https://graph.mapillary.com/images?${q}`);
  if (!r.ok) return null;
  let best = null, bd = Infinity;
  for (const im of (await r.json()).data || []) {
    const [x, y] = (im.computed_geometry || im.geometry).coordinates;
    const dd = (x - a.lon) ** 2 + (y - a.lat) ** 2;
    if (dd < bd) { bd = dd; best = im; }
  }
  return best && { id: best.id, captured: best.captured_at ? new Date(best.captured_at).toISOString().slice(0, 7) : null };
}
async function openSv(a, btn) {
  $$("#sv-buttons button").forEach((x) => x.classList.toggle("active", x === btn));
  const token = S.config.mapillary_token, view = $("#sv-view");
  const open = `https://www.mapillary.com/app/?lat=${a.lat}&lng=${a.lon}&z=18`;
  const fallback = (msg) => {
    view.innerHTML = `<p class="small">${msg}</p>
      <a class="btn-link" target="_blank" rel="noopener" href="${open}">${t("photo_open")}</a>`;
  };
  if (S.mly) { S.mly.remove(); S.mly = null; }
  if (!token) return fallback(t("photo_link_only"));
  view.innerHTML = `<p class="small muted">${t("photo_loading")}</p>`;
  try {
    const im = a.pano_id ? { id: a.pano_id, captured: a.captured } : await nearestImage(token, a);
    if (!im) return fallback(t("photo_none"));
    await loadMapillary();
    view.innerHTML = `<div id="mly" class="mly"></div><div class="meta">${im.captured ? t("photo_taken", { date: esc(im.captured) }) + " " : ""}·
      © Mapillary contributors, CC BY-SA 4.0</div>`;
    S.mly = new mapillary.Viewer({ accessToken: token, container: "mly", imageId: im.id, component: { cover: false } });
  } catch (e) {
    fallback(t("photo_failed"));
  }
}

/* ------------------------------------------------------------------ flood timeline */
function buildTimeline(lv) {
  const fr = lv.dashboard.flood_frames || [];
  S.frames = fr; clearInterval(S.playTimer);
  $("#timeline").classList.toggle("hidden", !fr.length);
  if (!fr.length) return;
  const range = $("#tl-range");
  range.max = fr.length - 1; range.value = 0;
  $("#tl-show").checked = false;
  const show = () => {
    const f = fr[+range.value], on = $("#tl-show").checked;
    $("#tl-date").textContent = `${f.date}${f.pct_observed != null && f.pct_observed < 90 ? " · " + t("pct_observed", { pct: f.pct_observed }) : ""}` +
      (lv.dashboard.flood_until ? " · " + t("record_ends", { date: lv.dashboard.flood_until }) : "");
    const url = `levels/${lv.level_id}/${f.file}`;
    const src = S.map.getSource("ov-flood");
    if (on && src) src.updateImage({ url, coordinates: lv.dashboard.overlay_corners });
    setOverlay("flood", url, on, 0.85);
    if (on && !S.floodSeen) {
      S.floodSeen = true;
      const ln = dline("flood_animation");
      setSat(ln.sprite, ln.text);
    }
    if (on && f.pct_observed != null && f.pct_observed < 50) { const ln = dline("radar_gap"); setSat(ln.sprite, ln.text); }
  };
  range.oninput = show; $("#tl-show").onchange = show;
  $("#tl-play").onclick = () => {
    if (S.playTimer) { clearInterval(S.playTimer); S.playTimer = null; $("#tl-play").textContent = "▶"; return; }
    $("#tl-show").checked = true; $("#tl-play").textContent = "❚❚";
    S.playTimer = setInterval(() => { range.value = (+range.value + 1) % fr.length; show(); }, 700);
  };
}

/* ------------------------------------------------------------------ submit + reveal */
async function submit(timedOut = false) {
  if (S.revealed || !S.attemptId) return;
  if (S.roof) return submitRoofs(timedOut);
  if (S.mixed) return submitMixed(timedOut);
  let g = geometry();
  if (!g) {
    if (!timedOut) return;
    const c = fwd(S.map.getCenter().toArray());          // nothing placed at the deadline: a token footprint
    S.fp = { mode: "rect", cx: c[0], cy: c[1], w: 50, h: 50, angle: 0 }; S.sites = [S.fp]; g = geometry();
  }
  $("#btn-submit").disabled = true;
  let r;
  try { r = await api(`/api/attempts/${S.attemptId}/submit`, { method: "POST", body: { geometry: g } }); }
  catch (e) { toast(eventLine("excluded_zone", e.message)); $("#btn-submit").disabled = false; return; }
  S.revealed = true; clearInterval(S.timer); clearInterval(S.playTimer);
  renderFootprint();
  $("#draw-help").classList.add("hidden");
  revealMap(r);
  renderReveal(r);
  selectTab("reveal");
  await playDialogue(r.dialogue);
}

async function submitRoofs(timedOut) {
  let ids = [...S.sel.keys()];
  if (!ids.length) {
    if (!timedOut) return;
    ids = [S.roofFC.features[0].properties.id];                       // nothing picked at the deadline: a token roof
  }
  $("#btn-submit").disabled = true;
  let r;
  try { r = await api(`/api/attempts/${S.attemptId}/submit`, { method: "POST", body: { buildings: ids } }); }
  catch (e) { toast(eventLine("excluded_zone", e.message)); $("#btn-submit").disabled = false; return; }
  S.revealed = true; clearInterval(S.timer);
  $("#draw-help").classList.add("hidden");
  const opt = await revealRoofs(r);
  const byId = new Map(S.roofFC.features.map((f) => [f.properties.id, f]));
  fitFeatures([...opt, ...ids.map((i) => byId.get(i))], 17);
  renderReveal(r);
  selectTab("reveal");
  await playDialogue(r.dialogue);
}

async function submitMixed(timedOut) {
  let g = geometry(), ids = [...S.sel.keys()];
  if (!g && !ids.length) {
    if (!timedOut) return;
    const c = fwd(S.map.getCenter().toArray());                          // nothing placed at the deadline
    S.fp = { mode: "rect", cx: c[0], cy: c[1], w: 50, h: 50, angle: 0 }; S.sites = [S.fp]; g = geometry();
  }
  $("#btn-submit").disabled = true;
  let r;
  try { r = await api(`/api/attempts/${S.attemptId}/submit`, { method: "POST", body: { geometry: g, buildings: ids } }); }
  catch (e) { toast(eventLine("excluded_zone", e.message)); $("#btn-submit").disabled = false; return; }
  S.revealed = true; clearInterval(S.timer); clearInterval(S.playTimer);
  renderFootprint();
  $("#draw-help").classList.add("hidden");
  if (r.reveal.heatmap_url) revealMap(r, false);
  await revealRoofs(r);
  const [w, s_, e, n] = S.level.bbox;
  S.map.fitBounds([[w, s_], [e, n]], { padding: 40, duration: 1200 });
  renderReveal(r);
  selectTab("reveal");
  await playDialogue(r.dialogue);
}

async function revealRoofs(r) {
  const w = await (await fetch(r.reveal.roof_weights_url)).json();
  S.heatRange = w.range;
  w.weights.forEach((v, id) => S.map.setFeatureState({ source: "roofs", id }, { w: v }));
  S.map.setPaintProperty("roofs-fill", "fill-color", roofFillColor());
  S.map.setPaintProperty("roofs-fill", "fill-opacity", 0.9);
  const byId = new Map(S.roofFC.features.map((f) => [f.properties.id, f]));
  const opt = r.reveal.optimal_buildings.map((i) => byId.get(i)).filter(Boolean);
  S.optFeats = [...S.optFeats, ...opt];
  S.map.getSource("optimal").setData({ type: "FeatureCollection", features: S.optFeats });
  return opt;
}
function fitFeatures(feats, maxZoom) {
  const pts = (g) => g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates.flatMap((p) => p[0])
    : g.coordinates.flat(1);                                       // several sites arrive as a MultiPolygon
  const coords = feats.filter(Boolean).flatMap((f) => pts(f.geometry));
  const b = coords.reduce((bb, [x, y]) => [[Math.min(bb[0][0], x), Math.min(bb[0][1], y)], [Math.max(bb[1][0], x), Math.max(bb[1][1], y)]],
                          [[180, 90], [-180, -90]]);
  S.map.fitBounds(b, { padding: { top: 80, left: 80, right: 80, bottom: 120 }, maxZoom, duration: 1200 });
}

function revealMap(r, fit = true) {
  const map = S.map, rv = r.reveal;
  map.addSource("heat", { type: "image", url: rv.heatmap_url, coordinates: rv.heatmap_corners });
  map.addLayer({ id: "heat", type: "raster", source: "heat",
                 paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 1800 }, "raster-resampling": "nearest" } },
               FIRST_FP_LAYER);
  setTimeout(() => map.setPaintProperty("heat", "raster-opacity", 0.85), 50);   // heat map fades in
  if (rv.flood_event) {
    map.addSource("flood-event", { type: "image", url: rv.flood_event.url, coordinates: rv.flood_event.corners });
    map.addLayer({ id: "flood-event", type: "raster", source: "flood-event",
                   paint: { "raster-opacity": 0, "raster-opacity-transition": { duration: 1500, delay: 1800 },
                            "raster-resampling": "nearest" } }, FIRST_FP_LAYER);
    setTimeout(() => map.setPaintProperty("flood-event", "raster-opacity", 0.7), 60);
  }
  S.optFeats = [{ type: "Feature", geometry: rv.optimal_selection.geometry, properties: {} }];
  map.getSource("optimal").setData({ type: "FeatureCollection", features: S.optFeats });
  $("#timeline").classList.add("hidden");
  if (fit) fitFeatures([{ geometry: rv.optimal_selection.geometry }, { geometry: rv.player_geometry }], 15);
}

function renderReveal(r) {
  const res = r.result, ex = r.explanation, tab = $("#tab-reveal");
  if (r.passed && S.level.level_number === S.day && S.day <= S.days) {       // today's exercise passed: the day is over
    const ev = evening(), keep = ev && GRADE_RANK[ev.grade] >= GRADE_RANK[res.grade];  // a retry can only raise it
    store.set(EVENING_KEY, JSON.stringify({ day: S.day, grade: keep ? ev.grade : res.grade }));
  }
  const dayOver = !!evening();
  $("#tabbtn-reveal").classList.remove("hidden");
  const factorText = (f) => {
    const tab = f.roof || f.part === "roofs" ? "roof_factor_text" : "factor_text";
    return ((((UI[tab] || {})[f.id] || {})[f.good ? "good" : "bad"]) || {})[lang()] || f.text;
  };
  const factors = ex.factors.map((f) => f.id === "outside" ? `<div class="factor">
      <div class="fh"><span>${f.part ? t(f.part) + " · " : ""}${esc(t("outside_label"))}</span>
      <span class="pts neg">${t("pts", { p: f.points.toFixed(1) })}</span></div>
      <div>${esc(t("outside_text", { pct: f.outside_pct }))}</div></div>` : `<div class="factor">
      <div class="fh"><span>${f.part ? t(f.part) + " · " : ""}${esc(f.label)} <span class="muted">· ${t("weight_pct", { w: f.weight_pct })}</span></span>
      <span class="pts ${f.points < -0.05 ? "neg" : f.points > 0.05 ? "pos" : ""}">${t("pts", { p: (f.points > 0 ? "+" : "") + f.points.toFixed(1) })}</span></div>
      <div>${esc(f.no_data ? t("factor_no_data") : factorText(f))}</div>
      <div class="raw">${esc(t("yours_vs_best", { label: f.raw_label, yours: fmtRaw(f.player_raw, unitT(f.raw_unit)), best: fmtRaw(f.optimal_raw, unitT(f.raw_unit)) }))}</div></div>`).join("");
  const notScored = ex.not_scored.map((n) => `<div class="factor muted"><strong>${esc(n.label)}</strong>: ${esc(tr("not_scored_note", n.label, n.note))}</div>`).join("");
  const excl = Object.entries(ex.excluded_pct).map(([k, v]) => `${v}% ${esc(exclT(k))}`).join(", ");
  const m2s = (x) => Math.round(x).toLocaleString("en-US");
  tab.innerHTML = `<div class="score-block">
      <span class="score-num" id="score-num">0</span><span class="stamp-wrap" id="stamp">${gradeBadge(res.grade, "big")}</span>
      <div class="verdict">“${esc(verdictT(res.grade))}”</div></div>
    <div class="bars">
      <div class="bar"><span>${t("position")}</span><div class="track"><div style="width:${res.position_pct}%"></div></div><span>${res.position_pct.toFixed(0)}%</span></div>
      <div class="bar"><span>${t("size")}</span><div class="track"><div style="width:${res.size_pct}%"></div></div><span>${res.size_pct.toFixed(0)}%</span></div>
    </div>
    ${res.parts ? `<div class="bars">
      <div class="bar"><span>${t("ground")}</span><div class="track"><div style="width:${res.parts.ground.score}%"></div></div><span>${res.parts.ground.score.toFixed(0)}${res.parts.ground.grade ? " " + res.parts.ground.grade : ""}</span></div>
      <div class="bar"><span>${t("roofs")}</span><div class="track"><div style="width:${res.parts.roofs.score}%"></div></div><span>${res.parts.roofs.score.toFixed(0)}${res.parts.roofs.grade ? " " + res.parts.roofs.grade : ""}</span></div>
    </div><p class="small">${t("mixed_note")}</p>` : ""}
    <p class="small">${S.mixed ? [ex.parts.ground ? t("mixed_ground", { yours: ha(ex.parts.ground.player_area_m2), best: ha(ex.parts.ground.optimal_area_m2) }) : t("mixed_ground_none"),
        ex.parts.roofs ? t("mixed_roofs", { yours: m2s(ex.parts.roofs.player_area_m2), best: m2s(ex.parts.roofs.optimal_area_m2) }) : t("mixed_roofs_none"),
        t("best_outlined")].join(" ")
      : S.roof
      ? t("roof_sizes", { yours: m2s(ex.size.player_area_m2), best: m2s(ex.size.optimal_area_m2) })
      : t("ground_sizes", { yours: ha(ex.size.player_area_m2), best: ha(ex.size.optimal_area_m2) })}
      ${S.mixed ? "" : t("breakeven", { w: ex.size.breakeven_weight.toFixed(0) })}
      ${excl ? `<br><strong>${t("on_excluded")}</strong> ${excl}.` : ""}
      ${(res.site_penalty || (res.parts && res.parts.ground.site_penalty)) ? `<br><strong>${t("split_note", { n: res.n_sites || Math.round((res.parts.ground.site_penalty || 0) / 3) + 1, pts: res.site_penalty || res.parts.ground.site_penalty })}</strong>` : ""} ${ex.off_map_pct > 0.5 ? `<br><strong>${t("off_the_map")}</strong> ${ex.off_map_pct}%.` : ""}</p>
    <div class="legend-heat"><div class="legend-ramp" style="background:linear-gradient(90deg,#cde2fb,#9ec5f4,#6da7ec,#3987e5,#256abf,#184f95,#0d366b)"></div>
      <div class="legend-ends"><span>${t("heat_suitability", { v: S.roof ? S.heatRange[0] : 55 })}</span><span>${S.roof ? S.heatRange[1] : 90}</span></div>
      ${S.mixed ? `<div class="fine">${t("heat_mixed_note", { lo: S.heatRange[0], hi: S.heatRange[1] })}</div>` : ""}
      <div class="fine">${t(S.roof ? "heat_grey_roofs" : "heat_grey_land")}</div></div>
    ${r.reveal.flood_event ? `<div class="factor"><label><input type="checkbox" id="flood-ev" checked>
      ${t("flood_event_show", { date: esc(r.reveal.flood_event.date) })}</label>
      <div class="fine">${t("flood_event_note")}</div></div>` : ""}
    <h3>${t("why_best")}</h3>${factors}${notScored}
    <div class="reveal-actions">
      <button id="btn-retry">${t("try_again")}</button>
      ${dayOver ? `<button class="primary" id="btn-end-day">${t("end_day")}</button>` : ""}
      <button id="btn-levels" class="ghost">${t("all_exercises")}</button></div>
    <h3>${t("leaderboard")}</h3><table class="lb" id="lb"></table>`;
  countUp($("#score-num"), res.score, () => $("#stamp").classList.add("on"));
  if ($("#flood-ev")) $("#flood-ev").onchange = (e) =>
    S.map.setLayoutProperty("flood-event", "visibility", e.target.checked ? "visible" : "none");
  $("#btn-retry").onclick = () => startLevel(S.level.level_id);
  $("#btn-levels").onclick = renderHome;
  if ($("#btn-end-day")) $("#btn-end-day").onclick = endDay;
  api(`/api/leaderboard/${S.level.level_id}?name=${encodeURIComponent(playerName())}`).then((rows) => {
    $("#lb").innerHTML = rows.map((x) => `<tr><td>${x.rank}</td><td>${esc(x.date)}</td><td>${x.grade}</td><td style="text-align:right">${x.score.toFixed(1)}</td></tr>`).join("");
  });
}
function fmtRaw(v, unit) {
  if (!v) return "–";   // land-cover class names are dataset names and stay English
  if (v.shares_pct) return Object.entries(v.shares_pct).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, p]) => `${k} ${p}%`).join(", ");
  return `${v.mean} ${unit}`;
}
function countUp(el, target, done) {
  const t0 = performance.now(), dur = 1400;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = (target * (1 - Math.pow(1 - k, 3))).toFixed(1);
    if (k < 1) requestAnimationFrame(step); else done();
  };
  requestAnimationFrame(step);
}

/* ------------------------------------------------------------------ data & credits */
function renderCredits() {
  const tag = { used: t("status_used"), repl: t("status_repl"), no: t("status_no") };
  const html = `<thead><tr><th>${t("col_source")}</th><th>${t("col_owner")}</th><th>${t("col_time")}</th><th>${t("col_use")}</th>
    <th>${t("col_limits")}</th><th>${t("col_status")}</th></tr></thead><tbody>` + window.SQ_SOURCES.map((r) => r.length === 1
      ? `<tr class="grp"><td colspan="6">${esc(r[0])}</td></tr>`
      : `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td><td>${esc(r[4])}</td>
         <td><span class="src-tag ${r[5]}">${tag[r[5]]}</span></td></tr>`).join("") + "</tbody>";
  $$("table.credits").forEach((tb) => { tb.innerHTML = html; });   // desktop window and title-screen overlay
}

/* ------------------------------------------------------------------ story: title, prologue, office */
const playerName = () => (store.get("sq_name") || "").trim() || t("default_name");
const fillName = (t) => t.replaceAll("{name}", playerName());
function bgUrl(name) {
  const ws = S.art.backgrounds[name] || {};
  const want = innerWidth * (devicePixelRatio || 1);
  const k = Object.keys(ws).map(Number).sort((a, b) => a - b);
  return ws[String(k.find((w) => w >= want) || k[k.length - 1])];
}
function paintScenes() {
  $$(".scene[data-bg]").forEach((el) => { el.style.backgroundImage = `url("${bgUrl(el.dataset.bg)}")`; });
}
function showTitle() {
  paintScenes();
  const seen = !!store.get("sq_intro_seen");
  $("#btn-play").dataset.mode = seen ? "continue" : "new";
  $("#btn-play").setAttribute("aria-label", t(seen ? "continue" : "new_game"));
  $("#btn-new").classList.toggle("hidden", !seen);
  Snd.loop("theme", 0.45);                                      // starts on the player's first tap if the browser waits
  return showScreen("title").then(() => $("#player-name").focus());
}
function artSrc(name) {
  const ws = (S.art.ui || {})[name] || {}, k = Object.keys(ws).map(Number).sort((a, b) => a - b);
  return ws[String(k.find((w) => w >= 400) || k[k.length - 1])];
}

/* ------------------------------------------------------------------ settings: language */
function setLang(l) {
  SQEngine.setLang(l); store.set("sq_lang", l);
  applyI18n();
  $$("#settings input[name=lang]").forEach((r) => { r.checked = r.value === l; });
  if ($("#home").classList.contains("active")) renderHome();
  if ($("#credits-table").innerHTML) renderCredits();
  if ($("#title").classList.contains("active")) showTitle();
}
function openSettings() { $("#settings").classList.remove("hidden"); }
$("#settings-close").onclick = () => $("#settings").classList.add("hidden");
$$("#settings input[name=lang]").forEach((r) => (r.onchange = () => setLang(r.value)));
$("#sound-on").checked = Snd.on;
$("#sound-on").onchange = (e) => Snd.setOn(e.target.checked);
$$("[data-settings]").forEach((b) => (b.onclick = openSettings));
function saveName() {
  store.set("sq_name", $("#player-name").value.trim().slice(0, 24));
}
function narrate(cards) {               // black screen, one card per click / Space; Skip ends it
  return new Promise((resolve) => {
    const el = $("#narration"), scr = $("#prologue"); let i = -1;
    const done = () => { if (typing) typing.finish(); scr.onclick = null; document.onkeydown = null; resolve(); };
    const next = () => {
      if (typing) return typing.finish();                    // first tap: show the whole card
      i += 1;
      if (i >= cards.length) return done();
      el.classList.remove("in"); void el.offsetWidth;          // restart the fade
      el.classList.add("in");
      typeLine(el, fillName(cards[i]), "narrator", scr);       // letter by letter, like the dialogue
    };
    $("#btn-skip").onclick = (e) => { e.stopPropagation(); done(); };
    scr.onclick = next;
    document.onkeydown = (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); next(); } };
    scr.focus(); next();
  });
}
function confirmBox(title, text, yes) {                         // resolves true / false
  return new Promise((resolve) => {
    $("#confirm-title").textContent = title;
    $("#confirm-text").textContent = text;
    $("#confirm-yes").textContent = yes;
    $("#confirm").classList.remove("hidden");
    const done = (v) => { $("#confirm").classList.add("hidden"); resolve(v); };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
  });
}
/* ------------------------------------------------------------------ the day loop
   One day = one new exercise passed (7 days). Morning: [Day N] -> office (outside) -> desk -> computer.
   Evening ("End the day"): house -> door closed -> door open -> TV off -> TV on (the news) -> next morning.
   sq_evening holds the finished day and its grade until the player has gone home. Text: dialogue.yaml days/evening. */
const EVENING_KEY = "sq_evening";
const GRADE_RANK = { S: 4, A: 3, B: 2, C: 1, E: 0, D: 0 };   // D: saved before it was renamed E
function evening() { try { return JSON.parse(store.get(EVENING_KEY) || "null"); } catch { return null; } }
async function refreshDay() {
  const list = await api(`/api/levels?player_id=${S.playerId}`);
  const passed = list.filter((l) => l.best_score != null && l.best_score >= S.config.pass_score).length;
  const ev = evening();
  S.days = list.length;
  S.day = ev ? ev.day : Math.min(passed + 1, S.days + 1);       // days + 1: the story is finished
  if (S.clockTick) S.clockTick();                                // the taskbar shows "Day N"
  return list;
}
const say = (lines) => playDialogue(lines.map((l) => ({ ...l, text: fillName(l.text) })));
const loadImg = (src) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = src; });
async function scene(bg, onShow) {                               // a full-screen picture: office, house, door, TV
  await loadImg(bgUrl(bg));
  await showScreen("stage", () => {                              // onShow: the scene's sound, as the picture appears
    $("#stage").style.backgroundImage = `url("${bgUrl(bg)}")`;
    if (onShow) onShow();
  }, true);
  await wait(250);
}
async function dayCard(text, sub = "") {                         // white text on black between days
  await showScreen("daycard", () => { $("#daycard-text").textContent = text; $("#daycard-sub").textContent = sub; }, true);
  await wait(2200);
}
async function playMorning(n) {
  const st = await api(`/api/story/day/${n}`);
  await preload([...new Set([...st.office, ...st.desk].map((l) => l.sprite))]);
  await dayCard(t("day_n", { n }));
  await scene("office", () => Snd.loop("office", 0.9));        // the agency's morning bustle, outside and at the desk
  await say(st.office);
  const office = $("#office");
  office.classList.remove("zoom");
  await showScreen("office");
  await wait(300);
  await say(st.desk);
  office.classList.add("zoom");                                // the camera moves into the monitor
  await wait(1100);
  await renderHome();
  office.classList.remove("zoom");
}
async function endDay() {
  const ev = evening();
  if (!ev) return renderHome();
  clearInterval(S.timer);
  const st = await api(`/api/story/day/${ev.day}`);
  await scene("house", () => Snd.loop("walk", 1, 0.3));     // walking home
  await say(ev.grade === "S" || ev.grade === "A" ? st.house_top : st.house_pass);
  await scene("door-closed", () => Snd.stop(0.6));
  await say(st.door);
  await scene("door-open", () => Snd.play("door_open"));
  await wait(1000);
  await scene("tv-off", () => Snd.play("door_close"));        // inside: the door shuts and locks behind
  await say(st.tv_off);
  await scene("tv-on", () => { Snd.play("tv_on"); setTimeout(() => Snd.loop("news", 0.22), 600); });
  await say(st.tv);
  Snd.stop(0.8);
  await Snd.play("tv_off");
  store.set(EVENING_KEY, "");
  await refreshDay();
  if (S.day <= S.days) return playMorning(S.day);
  await dayCard(t("the_end"), t("the_end_sub"));                // after day 7: the story is over
  await wait(1500);
  return showTitle();
}
async function playIntro() {
  const story = await api("/api/story/prologue");
  Snd.stop(1.5);                                               // the title theme fades out over the black prologue
  await showScreen("prologue");
  await narrate(story.narration);
  store.set("sq_intro_seen", "1");
  await playMorning(1);                                        // Day 1: office, then the Senior Inspector's greeting
  if (!store.get("sq_tutorial_seen")) await playTutorial();    // first visit to the desktop
}
async function playTutorial() {                                  // SAT walks through the desktop (dialogue.yaml: tutorial)
  const { lines } = await api("/api/story/tutorial");
  const ls = lines.map((l) => ({ ...l, text: fillName(l.text) }));
  await preload([...new Set(ls.map((l) => l.sprite))]);
  await playDialogue(ls);
  store.set("sq_tutorial_seen", "1");
}
$("#btn-delete-me").onclick = async () => {
  if (!confirm(t("reset_confirm"))) return;
  await api(`/api/players/${S.playerId}`, { method: "DELETE" });
  ["sq_player", "sq_name", "sq_intro_seen", "sq_tutorial_seen", EVENING_KEY].forEach((k) => store.set(k, ""));
  location.reload();
};
$("#btn-play").onclick = () => {
  saveName();
  if ($("#btn-play").dataset.mode !== "continue") return playIntro();
  return evening() ? endDay() : renderHome();                  // a finished day the player never went home from
};
$("#btn-new").onclick = () => { saveName(); playIntro(); };
$("#player-name").onkeydown = (e) => { if (e.key === "Enter") $("#btn-play").click(); };
$("#btn-title-credits").onclick = () => {
  if (!$("#credits-table").innerHTML) renderCredits();
  $("#title-credits").classList.remove("hidden");
};
$("#title-credits-close").onclick = () => $("#title-credits").classList.add("hidden");
$("#title-credits").onclick = (e) => { if (e.target.id === "title-credits") $("#title-credits").classList.add("hidden"); };

/* ------------------------------------------------------------------ the in-game desktop */
function openWin(id) {
  const w = $("#" + id);
  if (id === "win-credits" && !$("#credits-table").innerHTML) renderCredits();
  w.classList.remove("hidden", "min");
  focusWin(w); renderTasks();
}
function focusWin(w) {
  S.z = (S.z || 10) + 1; w.style.zIndex = S.z;
  $$(".win").forEach((x) => x.classList.toggle("focused", x === w));
}
function renderTasks() {
  const bar = $("#task-wins"); bar.innerHTML = "";
  $$(".win:not(.hidden)").forEach((w) => {
    const b = document.createElement("button");
    b.className = "task" + (w.classList.contains("min") ? "" : " on");
    b.textContent = $(".win-title", w).textContent;
    b.onclick = () => { if (w.classList.contains("min") || !w.classList.contains("focused")) openWin(w.id); else { w.classList.add("min"); renderTasks(); } };
    bar.appendChild(b);
  });
}
function initDesktop() {
  S.desktopReady = true;
  $("#home").style.setProperty("--wall", `url("${bgUrl("bg-start")}")`);
  $$("[data-open]").forEach((b) => (b.onclick = () => openWin(b.dataset.open)));
  $$(".win").forEach((w) => {
    w.addEventListener("pointerdown", () => focusWin(w));
    $("[data-close]", w).onclick = (e) => { e.stopPropagation(); w.classList.add("hidden"); renderTasks(); };
    $("[data-min]", w).onclick = (e) => { e.stopPropagation(); w.classList.add("min"); renderTasks(); };
    const bar = $(".win-bar", w);
    bar.onpointerdown = (e) => {                                  // drag by the title bar (desktop sizes only)
      if (e.target.closest(".win-btn") || matchMedia("(max-width: 820px)").matches) return;
      const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      bar.onpointermove = (m) => {
        w.style.left = Math.max(0, Math.min(innerWidth - 120, m.clientX - dx)) + "px";
        w.style.top = Math.max(0, Math.min(innerHeight - 80, m.clientY - dy)) + "px";
      };
      bar.onpointerup = () => { bar.onpointermove = null; };
    };
  });
  $("#btn-replay").onclick = async () => {                    // replays the start of the day the player is on
    const n = Math.min(S.day || 1, S.days || 7);
    if (!(await confirmBox(t("replay_title"), t("replay_warn", { n }), t("replay_ok", { n })))) return;
    if (n <= 1) playIntro(); else playMorning(n);
  };
  $("#btn-tutorial").onclick = () => playTutorial();
  $("#btn-end-day-home").onclick = () => endDay();
  $("#btn-signout").onclick = () => showTitle();
  const tick = () => {
    const d = new Date();
    $("#clock").innerHTML = `${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}<small>${S.day ? t("day_n", { n: Math.min(S.day, S.days) }) + " · " : ""}${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })} 2038</small>`;
  };
  S.clockTick = tick; tick(); setInterval(tick, 15000);
  focusWin($("#win-exercises")); renderTasks();
}

/* ------------------------------------------------------------------ tabs, hint, boot */
function selectTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
}
$$(".tabs button").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
$("#btn-submit").onclick = () => submit(false);
$("#btn-home").onclick = () => { clearInterval(S.timer); renderHome(); };
$("#btn-hint").onclick = async () => {
  try { const r = await api(`/api/levels/${S.level.level_id}/hint`, { method: "POST" }); await playDialogue(r.lines); }
  catch (e) { toast(eventLine("rules", e.message)); }
};

(async function boot() {
  let pid = store.get("sq_player");
  if (!pid || !/^[0-9a-f]{32}$/.test(pid)) {
    pid = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    store.set("sq_player", pid);
  }
  S.playerId = pid;
  $("#player-name").value = store.get("sq_name") || "";
  SQEngine.setLang(store.get("sq_lang") || ((navigator.language || "").toLowerCase().startsWith("th") ? "th" : "en"));
  try {
    [S.config, S.art] = await Promise.all([api("/api/config"), api("/api/art/manifest")]);
    UI = (await api("/api/content")).ui;
  } catch (e) {        // game files missing (offline before the first full load)
    $(".title-actions").innerHTML = `<p class="offline">Could not load the game files. Check your connection and reopen the game.
      / โหลดไฟล์เกมไม่ได้ ตรวจสอบการเชื่อมต่อแล้วเปิดเกมใหม่</p>`;
    addEventListener("online", () => location.reload(), { once: true });
    return;
  }
  $("#logo").src = artSrc("logo"); $("#btn-play img").src = artSrc("button-play");
  $$(".settings-img").forEach((i) => { i.src = artSrc("button-setting"); });
  $$("#settings input[name=lang]").forEach((r) => { r.checked = r.value === SQEngine.lang; });
  applyI18n();
  showTitle();
})();
