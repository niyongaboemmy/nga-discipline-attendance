// Offline registers (src/offline), in a real browser against the built client,
// with the API mocked. From client/:
//   npm i --no-save playwright && npx playwright install chromium
//   npx vite build && (npx vite preview --port 4173 &) && node e2e-offline/offline.mjs
import { chromium } from "playwright";
const BASE = "http://localhost:4173";
const results = [], errors = [];
const check = (n, ok, d = "") => results.push(`${ok ? "PASS" : "FAIL"} ${n}${d ? " — " + d : ""}`);
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
const user = { id: "42", name: "Grace Teacher", email: "grace@nga.ac.rw", role: "teacher", academicYearId: 1, academicTermId: 1 };
await ctx.addInitScript((u) => {
  if (!localStorage.getItem("sso_token")) {
    localStorage.setItem("sso_token", "test-token");
    localStorage.setItem("sso_user", JSON.stringify(u));
    localStorage.setItem("sso_permissions", JSON.stringify([]));
    localStorage.setItem("sso_role_permissions", JSON.stringify(["ATTENDANCE_MARK", "ATTENDANCE_VIEW_OWN"]));
  }
}, user);
let offline = false;
const posts = [];
const seen = [];
await ctx.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  seen.push(p);
  // Playwright's mocks answer even when the browser is "offline": refuse like a dead network.
  if (offline) return route.abort("internetdisconnected");
  const json = (data) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data }) });
  if (route.request().method() === "POST" && p === "/api/attendance/mark") {
    posts.push(JSON.parse(route.request().postData() || "{}"));
    return json({ inserted: 3, updated: 0 });
  }
  if (p === "/api/mis/classes") return json([{ id: "c7", name: "S2 A" }]);
  if (p === "/api/mis/students") return json([{ id: "501", name: "Aline U", email: "a@x" }, { id: "502", name: "Bob K", email: "b@x" }, { id: "503", name: "Chantal M", email: "c@x" }]);
  if (p === "/api/attendance/session") return json({ exists: false, markedByName: null, markedByMe: false, lastMarkedAt: null, records: [] });
  if (p === "/api/roles-permissions/me") return json({ permissions: ["ATTENDANCE_MARK", "ATTENDANCE_VIEW_OWN"] });
  if (p === "/api/sso/verify-mis") return json({ valid: true });
  return json([]);
});
const p = await ctx.newPage();
p.on("pageerror", (e) => errors.push(e.message));
const MARK = `${BASE}/attendance/mark?classId=c7&date=2026-10-08&period=Morning&sessionType=homeroom`;

// 1. Online first: the app, its files and the roster get cached.
await p.goto(MARK);
const dismiss = async () => { const b = p.getByRole("button", { name: "Not now" }); if (await b.count()) await b.first().click().catch(() => undefined); };
await p.waitForTimeout(2500);
await dismiss();
await p.waitForTimeout(1000);
await p.locator('[data-mark-row="1"]').filter({ visible: true }).first().waitFor({ timeout: 20000 });
await p.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15000 }).catch(() => undefined);
await p.goto(MARK);
await p.waitForTimeout(1500);
await dismiss();
await p.locator('[data-mark-row="1"]').filter({ visible: true }).first().waitFor({ timeout: 20000 });
check("roster loads online", true);

// 2. Offline: reload still opens the app with the roster (cached), and saving queues.
await ctx.setOffline(true);
offline = true;
await p.goto(MARK);
await p.waitForTimeout(1500);
await dismiss();
const opened = await p.locator('[data-mark-row="1"]').filter({ visible: true }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
check("app and roster open with no connection", opened);
await p.getByTestId("offline-banner").waitFor({ timeout: 5000 }).catch(() => undefined);
check("banner says offline", (await p.getByTestId("offline-banner").textContent().catch(() => "")).includes("You're offline"));
const absentBtn = p.locator('[data-mark-row="1"]').getByRole("button", { name: /absent/i }).first();
if (await absentBtn.count()) await absentBtn.click();
await p.getByRole("button", { name: /Save & mark another/ }).click();
await p.getByText(/saved on this device/i).waitFor({ timeout: 5000 }).catch(() => undefined);
check("saving offline keeps it on the device", (await p.content()).includes("saved on this device"));
const banner = await p.getByTestId("offline-banner").textContent();
await p.getByText("1 register waiting to be sent").waitFor({ timeout: 5000 }).catch(() => undefined);
const banner2 = await p.getByTestId("offline-banner").textContent();
check("banner counts 1 waiting register", banner2.includes("1 register waiting to be sent"), banner2.slice(0, 160));
check("nothing reached the server yet", posts.length === 0);
check("logo shows offline", await p.evaluate(() => { const i = document.querySelector('img[alt="Tendo logo"]'); return !!i && i.naturalWidth > 0; }));

// 3. Back online: it is sent by itself, and the banner goes.
await ctx.setOffline(false);
offline = false;
await p.evaluate(() => window.dispatchEvent(new Event("online")));
await p.waitForFunction(() => !document.querySelector('[data-testid="offline-banner"]'), null, { timeout: 15000 }).catch(() => undefined);
check("sent automatically when back online", posts.length === 1, `posts=${posts.length}`);
check("the sent register is the one taken offline", posts[0]?.classId === "c7" && posts[0]?.date === "2026-10-08" && posts[0]?.records?.length === 3);
check("banner gone", (await p.getByTestId("offline-banner").count()) === 0);
check("queue empty", await p.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith("tendo.outbox"))));

console.log(results.join("\n"));
console.log(errors.length ? "PAGE ERRORS:\n" + errors.join("\n") : "no page errors");
await b.close();
