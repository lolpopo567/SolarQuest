/* Solar Quest engine: everything the Python server did (solarquest/game/server.py, hssa.py), in the browser.

   The game ships as static files (scripts/build_static.py) and app.js calls SQEngine.handle(method, path, body)
   with the same paths and JSON it used to send to the server. Scoring follows hssa.py line by line:
     position = mean weight in the player's footprint / best mean of a footprint of the same area
                (axis-aligned rectangles live, rotated rectangles from level.json's denominator table,
                 plus the player's own shape at every whole-pixel translation)
     size     = (net value at the player's area / best net value) ^ gamma, net value = area × (mean − w0)
     score    = 100 × position × size
   Exact polygon/pixel overlap areas come from clipping the footprint to each pixel (Sutherland–Hodgman).
   Progress, attempts and the leaderboard live in localStorage on this device. tests/engine_parity.mjs checks
   the results against the Python implementation. */
"use strict";

const SQEngine = (() => {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  let lang = "en";
  const cache = new Map();
  const getJSON = (p) => {
    if (!cache.has(p)) cache.set(p, fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); }));
    return cache.get(p);
  };
  // DecompressionStream needs Safari 16.4+ (iPads on older iPadOS lack it): fall back to vendor/fflate.js
  let fflate = null;
  const loadFflate = () => fflate || (fflate = new Promise((ok, no) => {
    if (self.fflate) return ok(self.fflate);
    const s = document.createElement("script");
    s.src = "vendor/fflate.js"; s.onload = () => ok(self.fflate); s.onerror = () => no(new Error("vendor/fflate.js"));
    document.head.appendChild(s);
  }));
  async function gunzip(r) {
    if (typeof DecompressionStream === "function" && r.body)
      return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const [zip, ff] = await Promise.all([r.arrayBuffer(), loadFflate()]);
    const out = ff.gunzipSync(new Uint8Array(zip));
    return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer;
  }
  async function getArray(p, Type) {
    if (!cache.has(p)) cache.set(p, (async () => {
      const r = await fetch(p);
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      const buf = await gunzip(r);
      return new Type(buf);
    })());
    return cache.get(p);
  }
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  class SelectionError extends Error {}

  /* ------------------------------------------------------------------ text */
  let C = null;   // { config, meta, dialogue, ui, art }
  const pick = (node) => node && (node[lang] || node.en);
  const fill = (t, vars = {}) => t.replace(/{(\w+)}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const SUBS = () => C.art.substitutions;
  function resolveSprite(who, mood, scene) {
    const chars = C.art.characters[who];
    let emo = chars[mood] ? mood : (SUBS()[`${who}_${mood}`] || `${who}_default`).slice(who.length + 1);
    if (!chars[emo]) emo = "default";
    if (`${who}_${emo}` === "inspector_m_fire" && !C.config.fire_scenes.includes(scene)) emo = "default";
    return { sprite: `${who}_${emo}`, layout: chars[emo].layout };
  }
  function line(node, scene, vars = {}, id = null) {
    const r = C.art.characters[node.who] ? resolveSprite(node.who, node.mood, scene)
                                         : { sprite: null, layout: "none" };          // player, TV news: no portrait
    return { line_id: id, character: node.who, text: fill(pick(node), vars), scene, requested_emotion: node.mood, ...r };
  }
  const react = (key, scene, vars) => line(C.dialogue.reactions[key], scene, vars, `reactions.${key}`);
  const group = (g, scene, vars) => Object.entries(g || {}).map(([k, n]) => line(n, scene, vars, k));

  /* ------------------------------------------------------------------ number formats (Python f-strings) */
  const f0 = (x) => x.toFixed(0), f1 = (x) => x.toFixed(1);
  const fg = (x) => String(Number(x.toPrecision(6)));                         // {x:g}
  const fcomma = (x) => Math.round(x).toLocaleString("en-US");                 // {x:,.0f}
  const round = (x, d) => {                                                    // Python round(): halves go to even
    const k = 10 ** d, v = x * k, r = Math.round(v);
    return (Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r) / k;
  };

  /* ------------------------------------------------------------------ geometry (grid CRS metres) */
  let P = null;                                                                // proj4 lon/lat -> UTM 47N
  const ringArea = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a) / 2; };
  function bounds(r) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
    return [a, b, c, d];
  }
  function segX(p1, p2, p3, p4) {                                              // proper or touching intersection
    const o = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    const on = (a, b, c) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
    const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    return (d1 === 0 && on(p3, p4, p1)) || (d2 === 0 && on(p3, p4, p2)) || (d3 === 0 && on(p1, p2, p3)) || (d4 === 0 && on(p1, p2, p4));
  }
  function selfIntersects(r) {
    const n = r.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;                   // neighbours share a vertex
      if (segX(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return true;
    }
    return false;
  }
  function toGridRing(geojson) {
    if (!geojson || geojson.type !== "Polygon" || !Array.isArray(geojson.coordinates) || !geojson.coordinates.length)
      throw new SelectionError("footprint must be a single Polygon");
    if (geojson.coordinates.length > 1) throw new SelectionError("footprint must not have holes");
    let ll = geojson.coordinates[0].map(([x, y]) => [+x, +y]);
    if (ll.length > C.config.max_vertices) throw new SelectionError(`footprint has more than ${C.config.max_vertices} vertices`);
    const last = ll[ll.length - 1];
    if (ll.length > 1 && last[0] === ll[0][0] && last[1] === ll[0][1]) ll = ll.slice(0, -1);
    if (ll.length < 3 || ringArea(ll) <= 0) throw new SelectionError("footprint is empty");
    if (selfIntersects(ll)) throw new SelectionError("footprint edges cross each other");
    const dense = [];                                                          // shapely.segmentize(g, 0.0005)
    for (let i = 0; i < ll.length; i++) {
      const a = ll[i], b = ll[(i + 1) % ll.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const k = Math.max(1, Math.ceil(len / 0.0005));
      for (let j = 0; j < k; j++) dense.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k]);
    }
    return dense.map((p) => P.forward(p));
  }
  const toGeo = (ring) => {
    const c = ring.map((p) => P.inverse(p).map((v) => round(v, 7)));
    return { type: "Polygon", coordinates: [[...c, c[0]]] };
  };
  const toGeoSites = (rings) => rings.length === 1 ? toGeo(rings[0])
    : { type: "MultiPolygon", coordinates: rings.map((r) => toGeo(r).coordinates) };

  /* several sites (hssa.MAX_SITES, 2026-10-10): a footprint is a Polygon or a MultiPolygon of up to 3 sites that
     must not overlap. Returns the sites as rings in grid metres. */
  function pointIn(pt, r) {                                                    // strictly inside (boundary = outside)
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      const cross = (xj - xi) * (pt[1] - yi) - (yj - yi) * (pt[0] - xi);
      if (Math.abs(cross) < 1e-9 && Math.min(xi, xj) - 1e-9 <= pt[0] && pt[0] <= Math.max(xi, xj) + 1e-9
          && Math.min(yi, yj) - 1e-9 <= pt[1] && pt[1] <= Math.max(yi, yj) + 1e-9) return false;
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function overlaps(a, b) {                                                    // interiors meet (touching is fine)
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      const p1 = a[i], p2 = a[(i + 1) % a.length], p3 = b[j], p4 = b[(j + 1) % b.length];
      if (o(p3, p4, p1) * o(p3, p4, p2) < 0 && o(p1, p2, p3) * o(p1, p2, p4) < 0) return true;
    }
    const probes = (r) => r.flatMap((p, i) => { const q = r[(i + 1) % r.length]; return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]]; });
    return probes(a).some((p) => pointIn(p, b)) || probes(b).some((p) => pointIn(p, a));
  }
  function toGridSites(geojson) {
    if (geojson && geojson.type === "MultiPolygon" && Array.isArray(geojson.coordinates)) {
      if (!geojson.coordinates.length) throw new SelectionError("footprint is empty");
      if (geojson.coordinates.length > C.config.max_sites) throw new SelectionError(`at most ${C.config.max_sites} sites`);
      const rings = geojson.coordinates.map((c) => toGridRing({ type: "Polygon", coordinates: c }));
      for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++)
        if (overlaps(rings[i], rings[j])) throw new SelectionError("sites overlap");
      return rings;
    }
    return [toGridRing(geojson)];
  }
  const translate = (ring, dx, dy) => ring.map(([x, y]) => [x + dx, y + dy]);

  function clipArea(ring, xa, ya, xb, yb) {                                    // area of ring ∩ [xa,xb]×[ya,yb]
    let pts = ring;
    const edges = [[(p) => p[0] >= xa, (p, q) => [xa, p[1] + (q[1] - p[1]) * (xa - p[0]) / (q[0] - p[0])]],
                   [(p) => p[0] <= xb, (p, q) => [xb, p[1] + (q[1] - p[1]) * (xb - p[0]) / (q[0] - p[0])]],
                   [(p) => p[1] >= ya, (p, q) => [p[0] + (q[0] - p[0]) * (ya - p[1]) / (q[1] - p[1]), ya]],
                   [(p) => p[1] <= yb, (p, q) => [p[0] + (q[0] - p[0]) * (yb - p[1]) / (q[1] - p[1]), yb]]];
    for (const [inside, cut] of edges) {
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length], pi = inside(p), qi = inside(q);
        if (pi) out.push(p);
        if (pi !== qi) out.push(cut(p, q));
      }
      pts = out;
      if (pts.length < 3) return 0;
    }
    return ringArea(pts);
  }
  // hssa.coverage: exact area of the ring in each pixel of its bounding window (clip = keep only on-map pixels)
  function coverage(G, ring, clip = true) {
    const [minx, miny, maxx, maxy] = bounds(ring), px = G.px;
    let c0 = Math.floor((minx - G.x0) / px), c1 = Math.ceil((maxx - G.x0) / px);
    let r0 = Math.floor((G.y0 - maxy) / px), r1 = Math.ceil((G.y0 - miny) / px);
    if (clip) { c0 = Math.max(c0, 0); c1 = Math.min(c1, G.W); r0 = Math.max(r0, 0); r1 = Math.min(r1, G.H); }
    const h = r1 - r0, w = c1 - c0;
    if (h <= 0 || w <= 0) return { r0, c0, h: 0, w: 0, cov: new Float64Array(0) };
    const cov = new Float64Array(h * w);
    for (let i = 0; i < h; i++) {
      const yb = G.y0 - (r0 + i) * px, ya = yb - px;
      for (let j = 0; j < w; j++) {
        const xa = G.x0 + (c0 + j) * px;
        cov[i * w + j] = clipArea(ring, xa, ya, xa + px, yb);
      }
    }
    return { r0, c0, h, w, cov };
  }
  function coverageSites(G, rings, clip = true) {                             // sites never overlap: coverages add
    if (rings.length === 1) return coverage(G, rings[0], clip);
    const ks = rings.map((r) => coverage(G, r, clip)).filter((k) => k.h && k.w);
    if (!ks.length) return { r0: 0, c0: 0, h: 0, w: 0, cov: new Float64Array(0) };
    const r0 = Math.min(...ks.map((k) => k.r0)), c0 = Math.min(...ks.map((k) => k.c0));
    const h = Math.max(...ks.map((k) => k.r0 + k.h)) - r0, w = Math.max(...ks.map((k) => k.c0 + k.w)) - c0;
    const cov = new Float64Array(h * w);
    for (const k of ks) for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) cov[(k.r0 - r0 + i) * w + k.c0 - c0 + j] += k.cov[i * k.w + j];
    return { r0, c0, h, w, cov };
  }
  const sitesArea = (rings) => rings.reduce((a, r) => a + ringArea(r), 0);
  const wAt = (G, a, r, c) => (r >= 0 && r < G.H && c >= 0 && c < G.W ? a[r * G.W + c] : 0);

  /* ------------------------------------------------------------------ HSSA (hssa.py) */
  const overBudget = (a, b) => a > b * (1 + C.config.budget_tol);
  const nPixels = (G, area) => Math.max(1, Math.ceil(area / (G.px * G.px) - 1e-9));
  function rectSizes(n) {
    n = Math.max(1, Math.ceil(n - 1e-9));
    const out = new Map();
    for (const r of C.config.aspects) for (const ratio of new Set([r, 1 / r])) {
      const h0 = Math.sqrt(n * ratio);
      let best = null;
      for (const h of new Set([Math.max(1, Math.floor(h0)), Math.max(1, Math.ceil(h0))])) {
        const w = Math.ceil(n / h);
        const cand = [h * w - n, Math.abs(Math.log(h / w / ratio)), h, w];
        if (!best || cand[0] < best[0] || (cand[0] === best[0] && (cand[1] < best[1] || (cand[1] === best[1] && (cand[2] < best[2] || (cand[2] === best[2] && cand[3] < best[3])))))) best = cand;
      }
      out.set(`${best[2]}x${best[3]}`, [best[2], best[3]]);
    }
    return [...out.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  function sat(G, H, W) {                                                      // summed-area table, zero-padded to H×W
    const s = new Float64Array((H + 1) * (W + 1));
    for (let r = 0; r < H; r++) {
      let row = 0;
      for (let c = 0; c < W; c++) {
        row += wAt(G, G.w, r, c);
        s[(r + 1) * (W + 1) + c + 1] = s[r * (W + 1) + c + 1] + row;
      }
    }
    return s;
  }
  function bestRectangle(G, area) {
    const n = area / (G.px * G.px);
    let best = null;
    for (const [h, w] of rectSizes(n)) {
      const H = Math.max(G.H, h), W = Math.max(G.W, w);
      const s = H === G.H && W === G.W ? (G.sat ||= sat(G, G.H, G.W)) : sat(G, H, W), W1 = W + 1;
      let bi = 0, bj = 0, bs = -Infinity;
      for (let i = 0; i + h <= H; i++) for (let j = 0; j + w <= W; j++) {
        const v = s[(i + h) * W1 + j + w] - s[i * W1 + j + w] - s[(i + h) * W1 + j] + s[i * W1 + j];
        if (v > bs) { bs = v; bi = i; bj = j; }
      }
      const mean = bs / (h * w);
      if (!best || mean > best.mean) {
        const x0 = G.x0 + bj * G.px, y0 = G.y0 - bi * G.px;
        best = { mean, ring: [[x0, y0 - h * G.px], [x0 + w * G.px, y0 - h * G.px], [x0 + w * G.px, y0], [x0, y0]],
                 family: `rect ${h}x${w}`, area: h * w * G.px * G.px };
      }
    }
    return best;
  }
  function bestTranslation(G, ring, area, w = G.w) {                           // the player's own shape, every whole-pixel shift
    const k = coverage(G, ring, false), kmax = Math.max(k.h, k.w), off = kmax - 1;
    const nz = [];
    for (let a = 0; a < k.h; a++) for (let b = 0; b < k.w; b++) { const v = k.cov[a * k.w + b]; if (v > 0) nz.push([a, b, v]); }
    let bs = -Infinity, bt = 0, bu = 0;
    for (let t = -off; t <= G.H + off - k.h; t++) for (let u = -off; u <= G.W + off - k.w; u++) {
      let s = 0;
      for (const [a, b, v] of nz) { const r = t + a, c = u + b; if (r >= 0 && r < G.H && c >= 0 && c < G.W) s += v * w[r * G.W + c]; }
      if (s > bs + 1e-9) { bs = s; bt = t; bu = u; }
    }
    return { mean: Math.max(bs, 0) / area, ring: translate(ring, (bu - k.c0) * G.px, -(bt - k.r0) * G.px),
             family: "player_shape", area };
  }
  function bestArrangement(G, rings, area) {                                  // hssa.best_arrangement
    const w = Float64Array.from(G.w), placed = [];
    let total = 0;
    const order = rings.map((r, i) => [ringArea(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, i]) => rings[i]);
    for (const ring of order) {
      const a = ringArea(ring), opt = bestTranslation(G, ring, a, w);
      total += opt.mean * a;
      placed.push(opt.ring);
      const k = coverage(G, opt.ring);
      for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) if (k.cov[i * k.w + j] > 0) w[(k.r0 + i) * G.W + k.c0 + j] = 0;
    }
    return { mean: Math.max(total, 0) / area, rings: placed, family: "player_sites", area };
  }
  function tableRow(table, n) {
    n = Math.min(n, table.length);
    const row = table[n - 1];
    if (row.n_pixels !== n) throw new Error("denominator table is not indexed 1..N");
    return row;
  }
  function denominator(G, area, rings, table) {
    let best = bestRectangle(G, area);
    const row = tableRow(table, nPixels(G, area));
    if (row.mean_weight > best.mean) {
      const r = row.geometry_grid.coordinates[0].slice(0, -1);
      best = { mean: row.mean_weight, ring: r, family: row.family, area: ringArea(r) };
    }
    const own = rings.length > 1 ? bestArrangement(G, rings, area) : bestTranslation(G, rings[0], area);
    if (own.mean > best.mean) best = own;
    if (best.mean <= 0) throw new Error("no positive-weight footprint of this size exists");
    return best;
  }
  const netValue = (area, mean, w0) => area / 1e4 * (mean - w0);
  function optimalSize(table, pxArea, w0) {
    let n = 0, v = -Infinity;
    for (const row of table) { const x = netValue(row.n_pixels * pxArea, row.mean_weight, w0); if (x > v) { n = row.n_pixels; v = x; } }
    return [n, v];
  }
  const sizeFactor = (vp, vs, gamma) => { if (vs <= 0) throw new Error("level is not shippable"); return Math.max(0, Math.min(1, vp / vs)) ** gamma; };
  const grade = (score) => { for (const [lo, g] of C.config.grades) if (score >= lo) return g; return "D"; };

  function selectionStats(G, rings, area) {
    const k = coverageSites(G, rings);
    let s = 0, on = 0, zero = 0;
    for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) {
      const a = k.cov[i * k.w + j], wv = G.w[(k.r0 + i) * G.W + k.c0 + j];
      s += wv * a; on += a; if (wv === 0) zero += a;
    }
    return { area, on, zero, sum: s, mean: s / area, k };
  }
  function scoreGround(G, rings, budget, table, reward) {
    const area = sitesArea(rings);
    if (area <= 0) throw new SelectionError("footprint has zero area");
    if (overBudget(area, budget)) throw new SelectionError(`footprint ${f0(area)} m² exceeds budget ${f0(budget)} m²`);
    const flags = [], n = nPixels(G, area);
    const axis = bestRectangle(G, area);
    const player = selectionStats(G, rings, area);
    const best = denominator(G, area, rings, table);
    const ratio = player.mean / best.mean, position = Math.min(1, ratio);
    if (ratio > 1) flags.push("exceeds_optimum");
    const famMean = Math.max(axis.mean, tableRow(table, n).mean_weight);
    const [nStar, vStar] = optimalSize(table, G.px * G.px, reward.breakeven_weight);
    const size = sizeFactor(netValue(area, famMean, reward.breakeven_weight), vStar, reward.gamma);
    const aStar = nStar * G.px * G.px;
    if (area < 0.9 * aStar) flags.push("undersized"); else if (area > 1.1 * aStar) flags.push("oversized");
    if (player.on < player.area - Math.max(1e-6, 1e-9 * player.area) - 1e-3) flags.push("off_map");  // clip sums carry float error
    if (player.zero > 0) flags.push("touches_excluded");
    const nSites = rings.length, penalty = C.config.site_penalty * (nSites - 1);    // each extra site: its own grid link
    if (nSites > 1) flags.push("split_sites");
    const score = round(Math.max(0, round(100 * position * size, 1) - penalty), 1), g = grade(score);
    return { res: { score, grade: g, verdict: g, position_pct: round(100 * position, 1), size_pct: round(100 * size, 1),
                    n_sites: nSites, site_penalty: penalty,
                    player: { area_m2: round(area, 1), on_map_m2: round(player.on, 1), zero_weight_m2: round(player.zero, 1),
                              mean_weight: round(player.mean, 3) },
                    best_at_player_size: { family: best.family, area_m2: round(best.area, 1), mean_weight: round(best.mean, 3) },
                    optimal_area_m2: round(aStar, 1), raw_ratio: round(ratio, 4), flags },
             best, player };
  }
  function roofGreedy(weights, usable, area, w0 = null) {
    const order = [...weights.keys()].sort((a, b) => weights[b] - weights[a] || (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    let remaining = area, s = 0;
    const chosen = [];
    for (const i of order) {
      if (remaining <= 0 || (w0 !== null && weights[i] <= w0)) break;
      const take = Math.min(usable[i], remaining);
      if (take > 0) { s += weights[i] * take; remaining -= take; chosen.push({ building_id: String(i), area_m2: round(take, 1) }); }
    }
    return [area - remaining, s, chosen];
  }
  function scoreRooftop(weights, usable, idx, budget, reward) {
    let total = 0, s = 0;
    for (const i of idx) { total += usable[i]; s += weights[i] * usable[i]; }
    if (total <= 0) throw new SelectionError("no array placed");
    if (overBudget(total, budget)) throw new SelectionError(`placed ${f0(total)} m² exceeds budget ${f0(budget)} m²`);
    const [got, bestS, chosen] = roofGreedy(weights, usable, total);
    const bestMean = bestS / got, w0 = reward.breakeven_weight;
    const position = bestMean > w0 ? Math.min(1, Math.max(0, (s / total - w0) / (bestMean - w0)))   // hssa.score_rooftop:
                                   : Math.min(1, (s / total) / bestMean);                            // above break-even
    const [aStar, sStar] = roofGreedy(weights, usable, budget, w0);
    const vStar = aStar > 0 ? netValue(aStar, sStar / aStar, w0) : 0;
    const size = sizeFactor(netValue(got, bestMean, w0), vStar, reward.gamma);
    const score = round(100 * position * size, 1), g = grade(score);
    return { score, grade: g, verdict: g, position_pct: round(100 * position, 1), size_pct: round(100 * size, 1),
             player_mean_weight: round(s / total, 3), best_mean_at_player_size: round(bestMean, 3),
             best_at_player_size: chosen, optimal_area_m2: round(aStar, 1), area_m2: round(total, 1) };
  }

  /* ------------------------------------------------------------------ levels */
  const LV = new Map();
  async function level(id) {
    if (LV.has(id)) return LV.get(id);
    const index = await getJSON("levels/index.json");
    if (!index.find((x) => x.level_id === id)) throw new HttpError(404, `unknown level ${id}`);
    const base = `levels/${id}/`;
    const lv = await getJSON(base + "level.json");
    const L = { id, lv, base, explain: await getJSON(base + "explain.json"), dashboard: await getJSON(base + lv.assets.dashboard),
                rooftop: lv.mission_type === "rooftop", mixed: lv.mission_type === "mixed" };
    if (L.rooftop || L.mixed) L.roofs = await getJSON(base + "roofs.json");
    LV.set(id, L);
    return L;
  }
  async function grid(L) {                                                     // loaded on first inspect / submit
    if (L.G || L.rooftop) return L.G;
    const g = await getJSON(L.base + "grid.json");
    const [w, excl] = await Promise.all([getArray(g.weights, Float32Array), getArray(g.excl_code, Uint8Array)]);
    const layers = {};
    await Promise.all(Object.entries(g.layers).map(async ([k, p]) => { layers[k] = await getArray(p, Float32Array); }));
    L.G = { H: g.H, W: g.W, x0: g.x0, y0: g.y0, px: g.px, w, excl, excl_names: g.excl_names, layers };
    return L.G;
  }
  const reward = (sr) => ({ breakeven_weight: sr.breakeven_weight, gamma: sr.gamma });

  function layerSummary(G, k, ids) {
    const out = {};
    for (const lid of ids) {
      const a = G.layers[lid], m = C.meta.layers[lid];
      if (!a || !m) { out[lid] = null; continue; }
      let tot = 0, sum = 0, mn = Infinity, mx = -Infinity, any = false;
      const shares = {};
      for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) {
        const c = k.cov[i * k.w + j]; if (!(c > 0)) continue;
        const v = a[(k.r0 + i) * G.W + k.c0 + j]; if (!Number.isFinite(v)) continue;
        any = true; tot += c; sum += v * c; mn = Math.min(mn, v); mx = Math.max(mx, v);
        if (m.classes) shares[v] = (shares[v] || 0) + c;
      }
      if (!any) { out[lid] = null; continue; }
      if (m.classes) {
        const sp = {};
        for (const [code, name] of Object.entries(m.classes)) if (shares[+code]) sp[name] = round(100 * shares[+code] / tot, 1);
        out[lid] = { shares_pct: sp };
      } else {
        const d = m.digits;
        out[lid] = { mean: round(sum / tot, Math.max(d, 1)), min: round(mn, d), max: round(mx, d) };
      }
    }
    return out;
  }
  function excludedSummary(G, k, area) {
    const acc = new Float64Array(G.excl_names.length + 1);
    for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) acc[G.excl[(k.r0 + i) * G.W + k.c0 + j]] += k.cov[i * k.w + j];
    const out = {};
    G.excl_names.forEach((name, i) => { if (acc[i + 1] > 0) out[name] = round(100 * acc[i + 1] / area, 1); });
    return out;
  }
  function roofCfg(L) {
    if (L.rooftop) return { budget_m2: L.lv.budget_m2, size_reward: L.lv.size_reward, optimal_selection: L.lv.optimal_selection,
                            unlocked_layers: L.lv.unlocked_layers, factors: L.explain.factors, excl_name: L.explain.excl_names[0] };
    return { ...L.lv.rooftop, factors: L.explain.roof_factors, excl_name: L.explain.roof_excl_names[0] };
  }
  function roofPick(L, ids) {
    const n = L.roofs.ids.length;
    if (!ids || !ids.length) throw new SelectionError("pick at least one roof");
    if (new Set(ids).size !== ids.length || Math.min(...ids) < 0 || Math.max(...ids) >= n) throw new SelectionError("unknown or repeated roof id");
    const taken = new Set(L.roofs.has_solar || []);                   // large roofs that already carry solar
    if (ids.some((i) => taken.has(i))) throw new SelectionError("roof already has solar panels");
    return ids;
  }
  function roofSummary(L, idx, ids) {
    const out = {};
    for (const lid of ids) {
      const v = L.roofs.raw[lid], d = C.meta.roof_layers[lid].digits;
      let sa = 0, s = 0, mn = Infinity, mx = -Infinity;
      for (const i of idx) { const a = L.roofs.usable_m2[i]; sa += a; s += v[i] * a; mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); }
      out[lid] = { mean: round(s / sa, Math.max(d, 1)), min: round(mn, d), max: round(mx, d) };
    }
    return out;
  }

  /* ------------------------------------------------------------------ progress (this device) */
  const attempts = () => LS.get("sq_attempts", []);
  const saveAttempts = (a) => LS.set("sq_attempts", a);
  function bestByLevel() {
    const out = {};
    for (const a of attempts()) if (a.submitted) {
      const o = out[a.level_id] ||= { best_score: null, attempts: 0 };
      o.attempts += 1; o.best_score = o.best_score == null ? a.score : Math.max(o.best_score, a.score);
    }
    return out;
  }
  async function unlocked() {
    const index = await getJSON("levels/index.json"), best = bestByLevel(), out = {};
    let prev = true;
    for (const l of index) { out[l.level_id] = prev; prev = ((best[l.level_id] || {}).best_score || 0) >= C.config.pass_score; }
    return out;
  }

  /* ------------------------------------------------------------------ the API app.js used to call */
  async function init() {
    if (C) return;
    const [config, meta, dialogue, ui, art] = await Promise.all(
      ["config.json", "meta.json", "content/dialogue.json", "content/ui.json", "art/manifest.json"].map(getJSON));
    C = { config, meta, dialogue, ui, art };
    proj4.defs("EPSG:32647", config.proj4_scoring);
    P = proj4("EPSG:4326", "EPSG:32647");
  }

  const routes = [];
  const on = (method, re, fn) => routes.push([method, re, fn]);

  on("GET", /^\/api\/config$/, () => C.config);
  on("GET", /^\/api\/art\/manifest$/, () => C.art);
  on("GET", /^\/api\/content$/, () => ({ dialogue: C.dialogue, ui: C.ui, meta: C.meta }));
  on("GET", /^\/api\/story\/prologue$/, () => ({
    narration: Object.values(C.dialogue.prologue_narration).map(pick), background: "bg-work",
    lines: group(C.dialogue.prologue_greeting, "prologue") }));
  // the day loop (dialogue.yaml: days, evening): morning at the office, evening at home with the TV news
  on("GET", /^\/api\/story\/day\/(\d+)$/, ([, n]) => {
    const d = C.dialogue.days[`day_${n}`] || {}, ev = C.dialogue.evening;
    return { day: +n, office: group(d.office, "progression"),
             desk: +n === 1 ? group(C.dialogue.prologue_greeting, "prologue") : group(d.desk, "progression"),
             tv: group(d.tv, "progression"), house_top: group(ev.house_top, "progression"),
             house_pass: group(ev.house_pass, "progression"), door: group(ev.door, "progression"),
             tv_off: group(ev.tv_off, "progression") };
  });
  on("GET", /^\/api\/story\/tutorial$/, () => ({ lines: group(C.dialogue.tutorial, "progression") }));
  on("POST", /^\/api\/players$/, () => ({ ok: true }));                       // the name lives in localStorage (app.js)
  on("DELETE", /^\/api\/players\/[0-9a-f]{32}$/, () => {
    const n = attempts().length; saveAttempts([]); return { deleted_attempts: n };
  });
  on("GET", /^\/api\/levels$/, async () => {
    const index = await getJSON("levels/index.json"), best = bestByLevel(), ul = await unlocked();
    return index.map((l) => ({ ...l, unlocked: ul[l.level_id], ...(best[l.level_id] || { best_score: null, attempts: 0 }) }));
  });
  on("GET", /^\/api\/levels\/(\w+)$/, async ([, id]) => {
    const L = await level(id), lv = L.lv;
    const brief = group(C.dialogue.briefings[id], L.mixed ? "final_briefing" : "briefing");   // fire only in the final briefing
    const health = {};
    for (const c of L.dashboard.layers) health[c.id] = { has_gaps: c.has_gaps, hard_constraint: c.hard_constraint };
    if (!lv.season_complete) health.season = { has_gaps: true };
    const alarm = Object.values(health).some((h) => h.has_gaps || h.hard_constraint);
    const keys = new Set(brief.map((l) => l.sprite)); keys.add("sat_default"); keys.add("sat_shocked");
    const pub = {};
    for (const k of ["level_id", "level_number", "title", "area_id", "season_be", "season_complete", "mission_type", "bbox",
                     "zoom_min", "zoom_max", "budget_m2", "par_score", "unlocked_layers", "streetview_anchors", "difficulty_tier",
                     "briefing_character", "briefing_text", "hints_enabled", "time_limit_s"]) pub[k] = lv[k];
    pub.briefing_text = pick(C.dialogue.memos[id]) || lv.briefing_text;
    if (L.mixed) pub.roof_budget_m2 = lv.rooftop.budget_m2;
    return { ...pub, briefing: brief, preload: [...keys].sort(), dashboard: L.dashboard, sat_emotion: alarm ? "shocked" : "default",
             sat_line: react(alarm ? "sat_alarm" : "sat_nominal", "inspection"),
             proj4_scoring: C.config.proj4_scoring, pixel_size_m: lv.scoring.pixel_size_m };
  });
  on("POST", /^\/api\/levels\/(\w+)\/start$/, async ([, id]) => {
    const L = await level(id);
    if (!(await unlocked())[id]) throw new HttpError(403, "level locked: pass the previous exercise first");
    const a = { id: [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join(""),
                level_id: id, started: Date.now() / 1000, submitted: null, score: null, grade: null };
    saveAttempts([...attempts(), a]);
    grid(L).catch(() => {});                                                   // start downloading the grid now
    return { attempt_id: a.id, started: a.started, time_limit_s: L.lv.time_limit_s };
  });
  on("POST", /^\/api\/levels\/(\w+)\/hint$/, async ([, id]) => {
    const L = await level(id);
    if (!L.lv.hints_enabled) throw new HttpError(403, pick(C.dialogue.reactions.no_hints));
    const G = await grid(L);
    let best = null, spread = -1;
    for (const f of L.explain.factors) {
      let n = 0, s = 0, s2 = 0;
      if (L.rooftop) {
        L.roofs.subs[f.id].forEach((v, i) => { if (L.roofs.weight[i] > 0) { n++; s += v; s2 += v * v; } });
      } else {
        const a = G.layers[f.id];
        for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && G.excl[i] === 0) { n++; s += a[i]; s2 += a[i] * a[i]; }
      }
      const sd = n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0, v = f.weight * sd;
      if (v > spread) { best = f; spread = v; }
    }
    const meta = (L.rooftop ? C.meta.roof_layers : C.meta.layers)[best.layer];
    return { lines: [react("hint_offer", "inspection"), react("hint_layer", "inspection", { layer: meta.label })] };
  });
  on("POST", /^\/api\/levels\/(\w+)\/inspect$/, async ([, id], body) => {
    const L = await level(id);
    if (L.rooftop || (L.mixed && body.buildings != null)) return inspectRoofs(L, body);
    const G = await grid(L);
    let rings;
    try { rings = toGridSites(body.geometry); } catch (e) { throw new HttpError(422, e.message); }
    const area = sitesArea(rings), k = coverageSites(G, rings), excl = excludedSummary(G, k, area), budget = L.lv.budget_m2;
    const warnings = [];
    if (overBudget(area, budget)) warnings.push(react("warn_budget_ground", "warning", { area: f1(area / 1e4), budget: fg(budget / 1e4) }));
    const ex = Object.values(excl).reduce((a, b) => a + b, 0);
    if (Object.keys(excl).length) warnings.push(react("warn_excluded_ground", "warning", { pct: f0(ex) }));
    let covered = 0; for (const c of k.cov) covered += c;
    return { area_m2: round(area, 1), budget_m2: budget, over_budget: overBudget(area, budget), on_map_pct: round(100 * covered / area, 1),
             excluded_pct: excl, layers: layerSummary(G, k, L.lv.unlocked_layers), warnings };
  });
  function inspectRoofs(L, body) {
    let idx;
    try { idx = roofPick(L, body.buildings); } catch (e) { throw new HttpError(422, e.message); }
    const rc = roofCfg(L), budget = rc.budget_m2;
    let area = 0, small = 0;
    for (const i of idx) { area += L.roofs.usable_m2[i]; if (L.roofs.weight[i] === 0) small += L.roofs.usable_m2[i]; }
    const warnings = [];
    if (overBudget(area, budget)) warnings.push(react("warn_budget_roofs", "warning", { area: fcomma(area), budget: fcomma(budget) }));
    if (small) warnings.push(react("warn_excluded_roofs", "warning", { pct: f0(100 * small / area) }));
    return { area_m2: round(area, 1), budget_m2: budget, over_budget: overBudget(area, budget), on_map_pct: 100, n_roofs: idx.length,
             excluded_pct: small ? { [rc.excl_name]: round(100 * small / area, 1) } : {},
             layers: roofSummary(L, idx, rc.unlocked_layers), warnings };
  }

  function explainGround(L, G, rings, area, optRing, res) {
    const pk = coverageSites(G, rings), ok = coverage(G, optRing), oarea = ringArea(optRing);
    const mean = (a, k, ar) => { let s = 0; for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) { const v = a[(k.r0 + i) * G.W + k.c0 + j]; s += (Number.isFinite(v) ? v : 0) * k.cov[i * k.w + j]; } return s / ar; };
    // factors are judged on the part of the footprint inside the study area (every factor layer has data); the
    // rest scores 0 and gets its own "outside" line instead of being blamed on the heaviest factor (server.explain)
    const lys = L.explain.factors.map((f) => G.layers[f.id]);
    let inside = 0;
    const inData = new Uint8Array(pk.h * pk.w);
    for (let i = 0; i < pk.h; i++) for (let j = 0; j < pk.w; j++) {
      const at = (pk.r0 + i) * G.W + pk.c0 + j;
      if (lys.every((a) => Number.isFinite(a[at]))) { inData[i * pk.w + j] = 1; inside += pk.cov[i * pk.w + j]; }
    }
    const meanIn = (a) => { let s = 0; for (let i = 0; i < pk.h; i++) for (let j = 0; j < pk.w; j++) if (inData[i * pk.w + j]) s += a[(pk.r0 + i) * G.W + pk.c0 + j] * pk.cov[i * pk.w + j]; return s / inside; };
    let parts = 0;
    const factors = L.explain.factors.map((f) => {
      const o = mean(G.layers[f.id], ok, oarea), p = inside > 0 ? meanIn(G.layers[f.id]) : o, raw = f.layer;
      parts += 100 * f.weight * p;
      return { id: f.id, label: f.label, weight_pct: Math.round(100 * f.weight), points: round(100 * f.weight * (p - o), 1),
               player_score: round(p, 3), optimal_score: round(o, 3), good: p >= o - 0.02, text: p >= o - 0.02 ? f.good : f.bad,
               player_raw: layerSummary(G, pk, [raw])[raw], optimal_raw: layerSummary(G, ok, [raw])[raw], raw_layer: raw,
               raw_label: C.meta.layers[raw].label, raw_unit: C.meta.layers[raw].unit, no_data: inside <= 0 };
    });
    const outShare = Math.max(0, 1 - inside / area);
    if (outShare > 5e-4) factors.push({ id: "outside", label: "Outside the study area", weight_pct: null,
                                        points: round(-outShare * parts, 1), outside_pct: round(100 * outShare, 1),
                                        text: "Part of the site lies outside the district's data: it scores zero." });
    factors.sort((a, b) => a.points - b.points);
    let covered = 0; for (const c of pk.cov) covered += c;
    const sr = L.lv.size_reward;
    return { factors, not_scored: L.explain.not_scored || [], excluded_pct: excludedSummary(G, pk, area),
             off_map_pct: round(100 - 100 * covered / area, 1),
             size: { player_area_m2: res.player.area_m2, optimal_area_m2: sr.optimal_area_m2, breakeven_weight: sr.breakeven_weight,
                     size_pct: res.size_pct, position_pct: res.position_pct } };
  }
  async function groundPart(L, body, aid) {
    if (!body.geometry) throw new SelectionError("send a footprint geometry");
    const G = await grid(L), rings = toGridSites(body.geometry), lv = L.lv;
    const { res, best } = scoreGround(G, rings, lv.budget_m2, lv.denominator_table, reward(lv.size_reward));
    const bestGeo = best.rings ? toGeoSites(best.rings) : toGeo(best.ring);
    res.best_at_player_size.geometry = bestGeo;
    const optRing = lv.optimal_selection.geometry_grid.coordinates[0].slice(0, -1);
    const explanation = explainGround(L, G, rings, sitesArea(rings), optRing, res);
    const reveal = { heatmap_url: L.base + "reveal/suitability.png", heatmap_corners: L.dashboard.overlay_corners, heatmap_range: [55, 90],
                     optimal_selection: { geometry: lv.optimal_selection.geometry, area_m2: lv.optimal_selection.area_m2,
                                          mean_weight: lv.optimal_selection.mean_weight },
                     best_at_player_size: bestGeo, player_geometry: toGeoSites(rings) };
    const ev = lv.assets.reveal_overlay;
    if (ev) reveal.flood_event = { date: ev.date, corners: L.dashboard.overlay_corners, url: L.base + "reveal/" + ev.extent_file.split("/").pop() };
    return [res, explanation, reveal];
  }
  function roofPart(L, body) {
    const rc = roofCfg(L), idx = roofPick(L, body.buildings), sr = rc.size_reward;
    const r = scoreRooftop(L.roofs.weight, L.roofs.usable_m2, idx, rc.budget_m2, reward(sr));
    const flags = [];
    if (r.area_m2 < 0.9 * sr.optimal_area_m2) flags.push("undersized"); else if (r.player_mean_weight < sr.breakeven_weight) flags.push("oversized");
    const res = { score: r.score, grade: r.grade, verdict: r.verdict, position_pct: r.position_pct, size_pct: r.size_pct, flags,
                  player: { area_m2: r.area_m2 }, player_mean_weight: r.player_mean_weight, best_mean_at_player_size: r.best_mean_at_player_size };
    const opt = rc.optimal_selection.buildings.map((b) => +b.building_id);
    const U = L.roofs.usable_m2, wmean = (sub, ix) => { let s = 0, a = 0; for (const i of ix) { s += sub[i] * U[i]; a += U[i]; } return s / a; };
    const factors = rc.factors.map((f) => {
      const p = wmean(L.roofs.subs[f.id], idx), o = wmean(L.roofs.subs[f.id], opt), raw = f.layer;
      return { id: f.id, label: f.label, weight_pct: Math.round(100 * f.weight), points: round(100 * f.weight * (p - o), 1),
               player_score: round(p, 3), optimal_score: round(o, 3), good: p >= o - 0.02, text: p >= o - 0.02 ? f.good : f.bad, roof: true,
               player_raw: roofSummary(L, idx, [raw])[raw], optimal_raw: roofSummary(L, opt, [raw])[raw], raw_layer: raw,
               raw_label: C.meta.roof_layers[raw].label, raw_unit: C.meta.roof_layers[raw].unit };
    }).sort((a, b) => a.points - b.points);
    let small = 0, tot = 0; for (const i of idx) { tot += U[i]; if (L.roofs.weight[i] === 0) small += U[i]; }
    const explanation = { factors, not_scored: [], off_map_pct: 0,
                          excluded_pct: small ? { [rc.excl_name]: round(100 * small / tot, 1) } : {},
                          size: { player_area_m2: res.player.area_m2, optimal_area_m2: sr.optimal_area_m2, breakeven_weight: sr.breakeven_weight,
                                  size_pct: res.size_pct, position_pct: res.position_pct } };
    const reveal = { roof_weights_url: L.base + "reveal/roof_weights.json", optimal_buildings: opt, player_buildings: idx,
                     roof_optimal_selection: { area_m2: rc.optimal_selection.area_m2, mean_weight: rc.optimal_selection.mean_weight },
                     best_at_player_size_roofs: r.best_at_player_size.map((b) => +b.building_id) };
    return [res, explanation, reveal];
  }
  async function mixedParts(L, body) {
    const empty = () => ({ score: 0, position_pct: 0, size_pct: 0, flags: ["part_missing"], player: { area_m2: 0 } });
    if (!body.geometry && !(body.buildings || []).length) throw new SelectionError("place a ground footprint, pick roofs, or both");
    const [rg, eg, vg] = body.geometry ? await groundPart(L, body) : [empty(), null, {}];
    const [rr, er, vr] = (body.buildings || []).length ? roofPart(L, body) : [empty(), null, {}];
    const score = round((rg.score + rr.score) / 2, 1), g = grade(score);
    const res = { score, grade: g, verdict: g, position_pct: round((rg.position_pct + rr.position_pct) / 2, 1),
                  size_pct: round((rg.size_pct + rr.size_pct) / 2, 1), flags: [...new Set([...rg.flags, ...rr.flags])].sort(),
                  player: rg.player, parts: { ground: { score: rg.score, grade: rg.grade, position_pct: rg.position_pct, size_pct: rg.size_pct,
                                                          site_penalty: rg.site_penalty },
                                              roofs: { score: rr.score, grade: rr.grade, position_pct: rr.position_pct, size_pct: rr.size_pct } } };
    const factors = [];
    for (const [tag, e] of [["ground", eg], ["roofs", er]]) for (const f of (e || {}).factors || []) factors.push({ ...f, part: tag, points: round(f.points / 2, 1) });
    factors.sort((a, b) => a.points - b.points);
    const base = eg || er;
    const explanation = { ...base, factors, excluded_pct: { ...((eg || {}).excluded_pct || {}), ...((er || {}).excluded_pct || {}) },
                          parts: { ground: eg && eg.size, roofs: er && er.size } };
    if (!eg) explanation.size = er.size;
    return [res, explanation, { ...vg, ...vr, mixed: true }];
  }
  function reactions(L, res, explanation, recent) {
    const s = res.score, g = res.grade, flags = res.flags;
    const out = [react("score_summary", "reveal", { position: f0(res.position_pct), size: f0(res.size_pct), score: f1(s), grade: g })];
    if (flags.includes("out_of_time")) out.push(react("out_of_time", "reveal"));
    const ex = explanation.excluded_pct;
    if (Object.keys(ex).length) {
      const worst = Object.keys(ex).reduce((a, b) => (ex[b] > ex[a] ? b : a));
      const tr = (C.ui.excl_reason[worst] || {})[lang];
      out.push(react("hard_exclusion", "reveal", { reason: tr || worst }));
    }
    if (flags.includes("undersized") || flags.includes("oversized"))
      out.push(react(flags.includes("undersized") ? "size_too_small" : "size_too_big", "reveal", { best: fg(explanation.size.optimal_area_m2 / 1e4) }));
    if (g === "S" || g === "A") {
      out.push(react(s > L.lv.par_score ? "beyond_par" : "good_work", "reveal"));
      out.push(react("approved", "reveal"));
    } else if (g === "B") {
      out.push(react("viable", "reveal")); out.push(react("pass_confirmed", "reveal"));
    } else {
      out.push(react("below_threshold", "reveal"));
      const worst = explanation.factors[0];
      if (worst && worst.points < 0) out.push(react("poor_site", "reveal", { factor: worst.id === "outside" ? pick(C.ui.outside_label) || worst.label : worst.label, points: f1(Math.abs(worst.points)) }));
      if (recent.length && ["C", "D"].includes(recent[0]) && ["C", "D"].includes(g)) out.push(react("repeated_mistake", "reveal"));
      if (g === "D") out.push(react("grade_d", "reveal"));
    }
    return out;
  }
  on("POST", /^\/api\/attempts\/(\w+)\/submit$/, async ([, aid], body) => {
    const all = attempts(), a = all.find((x) => x.id === aid);
    if (!a) throw new HttpError(404, "unknown attempt");
    if (a.submitted) throw new HttpError(409, "attempt already submitted");
    const L = await level(a.level_id);
    let res, explanation, reveal;
    try {
      [res, explanation, reveal] = L.rooftop ? roofPart(L, body) : L.mixed ? await mixedParts(L, body) : await groundPart(L, body);
    } catch (e) {
      if (e instanceof SelectionError) throw new HttpError(422, e.message);
      throw e;
    }
    const lv = L.lv;
    if (lv.time_limit_s && Date.now() / 1000 - a.started > lv.time_limit_s + C.config.time_grace_s) {
      Object.assign(res, { score: 0, grade: "D", verdict: "D" }); res.flags.push("out_of_time");
    }
    const recent = all.filter((x) => x.level_id === a.level_id && x.submitted).sort((x, y) => y.submitted - x.submitted).map((x) => x.grade);
    const lines = reactions(L, res, explanation, recent);
    const passed = res.score >= C.config.pass_score;
    if (L.mixed && passed) lines.push(...group(C.dialogue.ending, "ending"));
    const prevBest = (bestByLevel()[L.id] || {}).best_score || 0, before = await unlocked();
    Object.assign(a, { submitted: Date.now() / 1000, score: res.score, grade: res.grade });
    saveAttempts(all);
    const after = await unlocked(), index = await getJSON("levels/index.json"), order = index.map((x) => x.level_id);
    return { result: res, reveal, explanation, dialogue: lines, passed, new_best: res.score > prevBest, ending: !!(L.mixed && passed),
             unlocked: order.filter((id) => after[id] && !before[id]), next_level: order[order.indexOf(L.id) + 1] || null };
  });
  on("GET", /^\/api\/leaderboard\/(\w+)$/, ([, id], _b, q) => {
    const name = q.name || "Applicant";
    return attempts().filter((a) => a.level_id === id && a.submitted).sort((a, b) => b.score - a.score).slice(0, 10)
      .map((a, i) => ({ rank: i + 1, name, score: a.score, grade: a.grade, date: new Date(a.submitted * 1000).toISOString().slice(0, 10) }));
  });

  async function handle(method, url, body = {}) {
    await init();
    const [path, qs] = url.split("?");
    const q = Object.fromEntries(new URLSearchParams(qs || ""));
    for (const [m, re, fn] of routes) {
      const hit = m === method && path.match(re);
      if (hit) return fn(hit, body || {}, q);
    }
    throw new HttpError(404, `no route ${method} ${path}`);
  }
  // app.js: warn before submitting when sites overlap (rings in grid metres)
  const sitesOverlap = (rings) => rings.some((a, i) => rings.slice(i + 1).some((b) => overlaps(a, b)));
  return { handle, init, sitesOverlap, setLang(l) { lang = l; }, say: (k, vars = {}, scene = "inspection") => react(k, scene, vars), get lang() { return lang; }, content: () => C, HttpError,
           _test: { rectSizes, coverage, ringArea, clipArea, scoreRooftop } };
})();
if (typeof module !== "undefined") module.exports = SQEngine;
