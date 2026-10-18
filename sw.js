/**
 * sw.js — offline support.
 *
 * Stale-while-revalidate for everything on this origin: the app opens
 * instantly from cache, and fresh copies are fetched in the background so a
 * new deploy is picked up on the next launch. No cache names to bump by hand.
 */

const CACHE_NAME = "speedrecall-v3";
const CACHE = CACHE_NAME;
const CORE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/state.js",
  "./js/engine.js",
  "./js/normalizer.js",
  "./js/cloze.js",
  "./js/audio.js",
  "./js/routes.js",
  "./js/importer.js",
  "./js/github-sync.js",
  "./data/manifest.json",
  "./data/bilingual-cloze.json",
  "./assets/icons/icon.svg",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/audio/test-sample.opus"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Add individually so one missing file can't block installation
      await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
      // Pre-cache deck files listed in the manifest
      try {
        const manifest = await (await fetch("./data/manifest.json", { cache: "reload" })).json();
        await Promise.all(manifest.decks.map((d) => cache.add(new Request(d.file, { cache: "reload" })).catch(() => {})));
      } catch {
        /* offline during install — decks get cached on first use */
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return; // GitHub API etc. go straight to network

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      return (await network) || (request.mode === "navigate" ? cache.match("./index.html") : Response.error());
    })()
  );
});
