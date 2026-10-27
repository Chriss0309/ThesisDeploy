// End-to-end smoke test of the reviewer journey in a real browser.
//
//   npm run smoke                                   # guest + signed-in + edge cases, local stub stack
//   npm run smoke -- --guest                        # guest demo only; safe against any deployment
//   npm run smoke -- --guest https://thesisdeploy.vercel.app
//
// The signed-in part needs `next start` configured for the local stubs (README, "End-to-end
// smoke test"): it signs in through the OAuth stub and drives failures through both stubs.
// Every step fails on console errors, CSP violations, uncaught exceptions, and 5xx responses.
// Uses an installed Chrome; set CHROME_PATH to point at another Chromium build.

import { chromium } from "playwright-core";

const BASE = (process.argv.slice(2).find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const GUEST_ONLY = process.argv.includes("--guest");
const OAUTH_STUB = process.env.SMOKE_OAUTH_STUB ?? "http://127.0.0.1:4010";
const API_STUB = process.env.SMOKE_API_STUB ?? "http://127.0.0.1:4020";
const WAIT = { timeout: 30_000 };
const RUN_WAIT = { timeout: 90_000 };

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" },
);
const results = [];

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text().slice(0, 240)}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${String(error).slice(0, 240)}`));
  page.on("response", (response) => {
    if (response.url().startsWith(BASE) && response.status() >= 500) problems.push(`HTTP ${response.status()} ${response.url()}`);
  });
  await page.exposeFunction("__smokeCsp", (text) => problems.push(`CSP: ${text}`));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (event) =>
      window.__smokeCsp(`${event.violatedDirective} blocked ${event.blockedURI || "inline"} in ${event.sourceFile}`),
    ),
  );
  return { context, page, problems };
}

async function step(session, name, run) {
  const started = Date.now();
  let error = null;
  try {
    await run(session.page);
  } catch (caught) {
    error = String(caught).split("\n")[0];
  }
  const problems = session.problems.splice(0);
  const ok = !error && problems.length === 0;
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (${Date.now() - started} ms)`);
  for (const line of [error, ...problems].filter(Boolean)) console.log(`     ${line}`);
}

const done = (scope) => scope.getByText(/^Done\. Every fill is recorded in the basket ledger\./).waitFor(RUN_WAIT);

async function runAndClose(page) {
  const dialog = page.getByRole("dialog");
  const run = dialog.getByRole("button", { name: /^(Run paper|Sell everything and close)/ });
  await run.waitFor(WAIT);
  await run.click();
  await done(dialog);
  await dialog.getByRole("button", { name: "Close" }).click();
  await dialog.waitFor({ state: "hidden", ...WAIT });
}

async function generate(page, studioPath) {
  await page.goto(`${BASE}${studioPath}`);
  await page.getByRole("button", { name: "AI power & nuclear" }).click(WAIT);
  await page.getByRole("button", { name: /Generate basket/ }).click(WAIT);
  await page.getByRole("button", { name: "Continue to pre-flight" }).waitFor({ timeout: 90_000 });
}

async function guestJourney() {
  const session = await newPage();
  await step(session, "landing and health", async (page) => {
    const health = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
    await page.goto(BASE);
    await page.getByRole("heading", { level: 1, name: /Invest in a thesis/ }).waitFor(WAIT);
    await health;
    if ((await page.getByText(/Backend ready|Waking backend|Backend degraded|Backend unreachable/).count()) > 0) {
      throw new Error("health status is visible on the landing page");
    }
    if ((await page.getByText(/Built on SnapTrade OAuth/i).count()) > 0) {
      throw new Error("SnapTrade eyebrow is still on the landing page");
    }
    await page.getByText(/Sign in with SnapTrade/).first().waitFor(WAIT);
  });
  await step(session, "demo X-Ray", async (page) => {
    await page.goto(`${BASE}/demo`);
    await page.getByRole("table").first().waitFor(WAIT);
  });
  await step(session, "demo Studio generates a basket", (page) => generate(page, "/demo/studio"));
  await step(session, "paper run with a rejected leg", async (page) => {
    await page.getByRole("button", { name: "Continue to pre-flight" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Run paper simulation" }).waitFor(WAIT);
    await dialog.getByText(/is unavailable:/).first().waitFor(WAIT);
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Run paper simulation" }).click();
    await dialog.getByRole("button", { name: /Retry failed leg/ }).waitFor(RUN_WAIT);
  });
  await step(session, "retry the failed leg", async (page) => {
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /Retry failed leg/ }).click();
    await done(dialog);
    await dialog.getByRole("link", { name: "View saved basket" }).click();
    await page.waitForURL(/\/demo\/baskets\//, WAIT);
  });
  await step(session, "My Theses: simulated move flags drift", async (page) => {
    await page.goto(`${BASE}/demo/theses`);
    const tools = page.getByRole("group", { name: /Reviewer tools/ }).first();
    await tools.getByLabel("Price change").selectOption({ index: 0 });
    await tools.getByRole("button", { name: "Apply" }).click();
    await page.getByText("Rebalance recommended").first().waitFor(WAIT);
  });
  await step(session, "My Theses: rebalance", async (page) => {
    await page.getByRole("button", { name: /^Rebalance( anyway)?$/ }).first().click(WAIT);
    await runAndClose(page);
  });
  await step(session, "My Theses: close", async (page) => {
    await page.getByRole("button", { name: "Close basket" }).first().click(WAIT);
    await runAndClose(page);
    await page.getByText("Closed").first().waitFor(WAIT);
  });
  await step(session, "telemetry drawer", async (page) => {
    await page.getByRole("button", { name: /Product telemetry/ }).click();
    await page.getByRole("dialog").getByText("How ThesisDeploy is used").waitFor(WAIT);
    await page.keyboard.press("Escape");
  });
  await session.context.close();
}

async function signedInJourney() {
  const session = await newPage();
  const post = (url) => fetch(url, { method: "POST" });
  await step(session, "sign in through the OAuth stub", async (page) => {
    await page.goto(BASE);
    await page.getByRole("link", { name: /Sign in with SnapTrade/ }).first().click();
    await page.waitForURL(`${BASE}/`, WAIT);
    await page.getByRole("button", { name: /Sign out/ }).first().waitFor(WAIT);
  });
  await step(session, "X-Ray", async (page) => {
    await page.goto(`${BASE}/portfolio`);
    await page.getByRole("table").first().waitFor(WAIT);
  });
  await step(session, "Studio generates on SnapTrade quotes", (page) => generate(page, "/studio"));
  await step(session, "pre-flight lists why Live is unavailable, paper run", async (page) => {
    await page.getByRole("button", { name: "Continue to pre-flight" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Run paper simulation" }).waitFor(WAIT);
    await dialog.getByText(/is unavailable:|Live brokerage/).first().waitFor(WAIT);
    await dialog.getByRole("button", { name: "Run paper simulation" }).click();
    await done(dialog);
    await dialog.getByRole("link", { name: "View saved basket" }).click();
    await page.waitForURL(/\/baskets\//, WAIT);
  });
  await step(session, "My Theses: Live gated for a Paper basket, rebalance", async (page) => {
    await page.goto(`${BASE}/theses`);
    await page.getByRole("button", { name: /^Rebalance( anyway)?$/ }).first().click(WAIT);
    const dialog = page.getByRole("dialog");
    await dialog.getByText(/This is a Paper basket/).waitFor(WAIT);
    const run = dialog.getByRole("button", { name: /^Run paper rebalance/ });
    await run.waitFor(WAIT);
    if (await run.isEnabled()) {
      await runAndClose(page);
    } else {
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
  });
  await step(session, "My Theses: close", async (page) => {
    await page.getByRole("button", { name: "Close basket" }).first().click(WAIT);
    await runAndClose(page);
  });
  await step(session, "a single 401 refreshes the token without the user noticing", async (page) => {
    await post(`${API_STUB}/__stub/fail-next?status=401`);
    await page.goto(`${BASE}/studio`);
    await page.getByRole("button", { name: /Generate basket/ }).waitFor(WAIT);
  });
  await step(session, "the account budget turns refreshes into a wait notice, not a 429", async (page) => {
    await page.goto(`${BASE}/portfolio`);
    for (let i = 0; i < 6; i++) {
      await page.getByRole("button", { name: /Refresh/ }).first().click();
      await page.waitForURL(/notice=/, WAIT);
      await page.waitForLoadState("load");
    }
    await page.getByText(/request limit \(10 per minute\) is used up/).first().waitFor(WAIT);
  });
  await step(session, "a revoked grant asks the user to reconnect", async (page) => {
    await post(`${OAUTH_STUB}/__stub/revoke-all`);
    await post(`${API_STUB}/__stub/fail-next?status=401`);
    await page.goto(`${BASE}/studio`);
    await page.getByText("Reconnect SnapTrade").waitFor(WAIT);
  });
  await session.context.close();
}

await guestJourney();
if (!GUEST_ONLY) await signedInJourney();
await browser.close();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} steps passed`);
process.exit(passed === results.length ? 0 : 1);
