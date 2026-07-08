import { chromium } from "playwright";

const MARKET_SUMMARY_URL = "https://stockcharts.com/freecharts/marketsummary.html";
const LOGIN_URL = "https://stockcharts.com/login/";
const MARKET_FACTORS_PANEL = "#panel-market-factors";
const BREADTH_PANEL = "#panel-breadth";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optionalEnv(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v) : null;
}

function nowStampHk() {
  const dt = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(dt).replaceAll("/", "-").replace(", ", " ");
}

async function ensureLoggedIn(page) {
  const username = optionalEnv("STOCKCHARTS_USERNAME");
  const password = optionalEnv("STOCKCHARTS_PASSWORD");
  if (!username || !password) return;

  const alreadyLoggedIn = await page
    .locator("text=/logout/i")
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadyLoggedIn) return;

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const userFieldCandidates = [
    page.getByLabel(/user(name)?|email/i),
    page.locator('input[name="username"]'),
    page.locator('input[name="email"]'),
    page.locator('input[type="email"]'),
    page.locator('input[type="text"]'),
  ];

  const passFieldCandidates = [
    page.getByLabel(/pass(word)?/i),
    page.locator('input[name="password"]'),
    page.locator('input[type="password"]'),
  ];

  async function firstVisible(cands) {
    for (const c of cands) {
      const loc = c.first();
      const ok = await loc.isVisible().catch(() => false);
      if (ok) return loc;
    }
    return null;
  }

  const userField = await firstVisible(userFieldCandidates);
  const passField = await firstVisible(passFieldCandidates);
  if (!userField || !passField) throw new Error("Could not find StockCharts login fields.");

  await userField.fill(username);
  await passField.fill(password);

  const submitCandidates = [
    page.getByRole("button", { name: /log in|sign in/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];
  const submit = await firstVisible(submitCandidates);
  if (!submit) throw new Error("Could not find StockCharts login submit button.");

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    submit.click(),
  ]);

  await page.waitForLoadState("networkidle").catch(() => {});
}

async function warmUpDashboard(page) {
  const steps = [0.2, 0.5, 0.8, 0.0];
  for (const p of steps) {
    await page.evaluate((pp) => window.scrollTo(0, document.body.scrollHeight * pp), p).catch(() => {});
    await page.waitForTimeout(350);
  }
}

async function getDocumentBox(locator) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      width: r.width,
      height: r.height,
    };
  });
}

async function screenshotCombinedPanels(page, selectors) {
  const boxes = [];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) return null;
    const box = await getDocumentBox(loc);
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) return null;

  const pad = 8;
  const minX = Math.min(...boxes.map((b) => b.x)) - pad;
  const minY = Math.min(...boxes.map((b) => b.y)) - pad;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + pad;

  await page.waitForTimeout(300);
  return await page.screenshot({
    type: "png",
    fullPage: true,
    clip: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  });
}

async function postDiscordWebhook({ webhookUrl, content, filename, fileBytes }) {
  const form = new FormData();
  form.set("content", content);
  form.append("file", new Blob([fileBytes], { type: "image/png" }), filename);

  const resp = await fetch(webhookUrl, { method: "POST", body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${resp.status} ${resp.statusText}\n${text}`);
  }
}

async function main() {
  const webhookUrl = requireEnv("DISCORD_WEBHOOK_URL");

  const browser = await chromium.launch({
    args: ["--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  await ensureLoggedIn(page);

  await page.goto(MARKET_SUMMARY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  await warmUpDashboard(page);

  const combined = await screenshotCombinedPanels(page, [
    MARKET_FACTORS_PANEL,
    BREADTH_PANEL,
  ]);
  if (!combined) {
    const png = await page.screenshot({ fullPage: true, type: "png" });
    const stamp = nowStampHk();
    await postDiscordWebhook({
      webhookUrl,
      content: `StockCharts market summary (${stamp} HK) — couldn't locate Market Factors + Breadth panels. Sending full page.`,
      filename: "stockcharts-marketsummary.png",
      fileBytes: png,
    });
    return;
  }

  const stamp = nowStampHk();
  await postDiscordWebhook({
    webhookUrl,
    content: `**Market Factors + Breadth (Advancing/Declining)** (${stamp} HK)`,
    filename: "stockcharts-market-factors-breadth.png",
    fileBytes: combined,
  });

  await browser.close();
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
