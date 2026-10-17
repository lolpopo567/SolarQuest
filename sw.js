/* Solar Quest service worker. The game is static files scored on the device (web/engine.js), so once loaded it
   plays offline: the app shell is cached on install, and every other file of the site (levels, grids, art,
   flood frames) is cached the first time it is used. Bump VERSION whenever web/ files change.
   One version never mixes with another (owner report 15 Oct 2026: an old engine.js with the new level list said
   exercise 1 was locked): the shell is fetched past the browser's HTTP cache, files are served from this version's
   cache without background refreshes, and a page still running older code reloads at a safe moment (app.js). */
const VERSION = "sq-2026-10-17-1";
const SHELL = ["./", "index.html", "app.js", "engine.js", "sound.js", "style.css", "credits.js", "manifest.webmanifest",
               "config.json", "meta.json", "content/dialogue.json", "content/ui.json", "art/manifest.json",
               "levels/index.json", "icons/icon-192.png", "icons/icon-512.png",
               "vendor/maplibre-gl.css", "vendor/maplibre-gl.js", "vendor/proj4.js", "vendor/fflate.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin) return;    // map tiles, Mapillary: network only
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;                                                // this version's copy: never a newer one
    const r = await fetch(req, { cache: "no-cache" });                  // first use: fresh from the site, then kept
    if (r.ok) c.put(req, r.clone());
    return r;
  }));
});
