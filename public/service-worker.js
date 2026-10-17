// Naikkan VERSION setiap kali fail app diubah supaya cache lama dibuang.
const VERSION = "v8";
const SHELL = `shell-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;

const SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/js/app.js",
  "/js/firebase-init.js",
  "/js/session.js",
  "/js/admin-tools.js",
  "/js/geofenceService.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Sentiasa guna rangkaian (data masa nyata / pengesahan / jubin peta)
const BYPASS = /(firestore\.googleapis\.com|identitytoolkit|securetoken|firebaseio\.com|tile\.openstreetmap\.org)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, RUNTIME].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (BYPASS.test(url.hostname)) return;

  // Fail sendiri: rangkaian dahulu, cache sebagai sandaran (luar talian)
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          if (req.mode === "navigate") return caches.match("/index.html");
          return Response.error();
        })
    );
    return;
  }

  // Pustaka CDN (Tailwind, Leaflet, Firebase SDK): stale-while-revalidate
  event.respondWith(
    caches.open(RUNTIME).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok || res.type === "opaque") cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
