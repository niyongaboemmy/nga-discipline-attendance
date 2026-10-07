/* App service worker, v2 (see src/pwa/ngaInstall.tsx).
 *
 * Small on purpose: it makes the app installable with the browser's
 * one-click dialog (Chromium only offers it when a worker handles fetch) and
 * shows the app shell when a launch has no connection. API calls and assets
 * are never cached here.
 *
 * v2 fixes "old release stuck in the browser": v1 fetched pages through the
 * normal HTTP cache, and the HTML used to be served without cache headers,
 * so Chrome could keep reusing an old page -- and its old code -- for hours
 * after a deploy. Pages are now always revalidated with the server, and when
 * this version takes over it refreshes open tabs that sit on a safe landing
 * page, so they switch to the current release at once. Pages where someone
 * could be mid-task (a quiz, an editor, a chat) are never reloaded.
 */
const VERSION = "app-shell-v3";
// v3: offline registers (src/offline). The built files under /assets/ have a
// content hash in their names, so they're cached the first time they load and
// served from the cache after that: the app opens with no connection. A new
// worker version starts a fresh assets cache.
const ASSETS = "app-assets-v3";

// Exact paths that are safe to reload without losing anyone's work.
const SAFE_TO_REFRESH = new Set(["/", "/dashboard", "/home", "/login", "/app", "/welcome", "/reminders", "/apps"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(new Request("/", { cache: "no-cache" })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => (k.startsWith("app-shell-") && k !== VERSION) || (k.startsWith("app-assets-") && k !== ASSETS))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window" });
      // Deliberately NOT awaited: the reload's own page request is held until
      // this activation finishes, so waiting for it here would deadlock the
      // worker in "activating" (seen in testing).
      windows.forEach((client) => {
        try {
          const url = new URL(client.url);
          if (url.origin !== self.location.origin || !SAFE_TO_REFRESH.has(url.pathname)) return;
          if ("navigate" in client) client.navigate(client.url).catch(() => null);
        } catch (e) {
          /* ignore */
        }
      });
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Built files (hashed names): cache first, so the app opens offline.
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSETS).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            }),
        ),
      ),
    );
    return;
  }
  // The app's own images (logo, icons): from the cache, refreshed in the background.
  if (url.origin === self.location.origin && req.destination === "image") {
    event.respondWith(
      caches.open(ASSETS).then((cache) =>
        cache.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit || Response.error());
          return hit || fresh;
        }),
      ),
    );
    return;
  }
  if (req.mode !== "navigate") return;
  // Pages: always ask the server (revalidate); the cached app page only when
  // offline. Every page is the same single-page app, so any successful page
  // load refreshes the offline copy.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && url.origin === self.location.origin && (res.headers.get("content-type") || "").includes("text/html")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("/", copy));
        }
        return res;
      })
      .catch(() => caches.match("/").then((hit) => hit || Response.error())),
  );
});
