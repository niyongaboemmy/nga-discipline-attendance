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
const VERSION = "app-shell-v6";
// v5: the staff clock page (/c/<school>, clock.html) keeps its own offline copy
// under "/clock.html"; it never overwrites the app page cached under "/".
// v4: multi-tenancy -- offline keys now carry the school (tendo.outbox.v2.<tid>.<uid>).
// v3: offline registers (src/offline). The built files under /assets/ have a
// content hash in their names, so they're cached the first time they load and
// served from the cache after that: the app opens with no connection. A new
// worker version starts a fresh assets cache.
// v5: never keep a web page under a script or style address (see `real` below);
// the new name also drops any such copy saved by an earlier worker.
const ASSETS = "app-assets-v5";

// Exact paths that are safe to reload without losing anyone's work.
const SAFE_TO_REFRESH = new Set(["/", "/dashboard", "/home", "/login", "/app", "/welcome", "/reminders", "/apps"]);

/** A built file answered with a web page is the server's "no such file", not the file. */
function real(res) {
  return !(res.headers.get("content-type") || "").includes("text/html");
}

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
              // After a release the old files are gone and the server answers their
              // addresses with the app's page (200, text/html). Keeping that as "the
              // script" left pages blank for good: answer "not found" instead, so the
              // page reloads itself onto the new release.
              if (!real(res)) return new Response("", { status: 404, statusText: "Not Found" });
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
  const shellKey = /^\/c(\/|$)/.test(url.pathname) ? "/clock.html" : "/";
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok && url.origin === self.location.origin && (res.headers.get("content-type") || "").includes("text/html")) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(shellKey, copy));
        }
        return res;
      })
      .catch(() => caches.match(shellKey).then((hit) => hit || Response.error())),
  );
});

// Staff check-in / check-out reminders (server: modules/clock/reminders.ts). The
// payload is { title, body, url, tag }; a tap opens (or focuses) the check-in page.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "Staff attendance";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || "clock",
      renotify: true,
      icon: "/pwa-192x192.png",
      badge: "/favicon-48x48.png",
      data: { url: typeof data.url === "string" && data.url.startsWith("/c/") ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        try {
          if (new URL(client.url).pathname.startsWith(url) && "focus" in client) return client.focus();
        } catch (e) {
          /* ignore */
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
