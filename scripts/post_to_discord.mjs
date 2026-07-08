import { chromium } from "playwright";

const MARKET_SUMMARY_URL = "https://stockcharts.com/freecharts/marketsummary.html";
const LOGIN_URL = "https://stockcharts.com/login/";
const MARKET_FACTORS_PANEL = "#panel-market-factors";
const BREADTH_PANEL = "#panel-breadth";
const SECTOR_TAB = "#tab-sector-advance-decline";

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

async function screenshotPanel(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count().catch(() => 0)) === 0) return null;
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  return loc.screenshot({ type: "png" });
}

async function postDiscordWebhook({ webhookUrl, content, files }) {
  const form = new FormData();
  form.set("payload_json", JSON.stringify({ content }));
  files.forEach((f, i) => {
    form.append(`files[${i}]`, new Blob([f.bytes], { type: "image/png" }), f.filename);
  });

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

  // 1) Market Factors
  const marketFactorsPng = await screenshotPanel(page, MARKET_FACTORS_PANEL);

  // 2) Breadth – ADVANCING / DECLINING (default tab)
  const breadthAdvDecPng = await screenshotPanel(page, BREADTH_PANEL);

  // 3) Breadth – SECTOR ADV / DEC
  const sectorTab = page.locator(SECTOR_TAB).first();
  if ((await sectorTab.count().catch(() => 0)) === 0) {
    throw new Error('Could not find "SECTOR ADV / DEC" tab.');
  }
  await sectorTab.click();
  await page.waitForTimeout(600);
  const breadthSectorPng = await screenshotPanel(page, BREADTH_PANEL);

  if (!marketFactorsPng || !breadthAdvDecPng || !breadthSectorPng) {
    const png = await page.screenshot({ fullPage: true, type: "png" });
    const stamp = nowStampHk();
    await postDiscordWebhook({
      webhookUrl,
      content: `StockCharts market summary (${stamp} HK) — couldn't capture all panels. Sending full page.`,
      files: [{ filename: "stockcharts-marketsummary.png", bytes: png }],
    });
    return;
  }

  const stamp = nowStampHk();
  await postDiscordWebhook({
    webhookUrl,
    content: `**Market Summary** (${stamp} HK)\n1) Market Factors\n2) Breadth – ADVANCING / DECLINING\n3) Breadth – SECTOR ADV / DEC`,
    files: [
      { filename: "market-factors.png", bytes: marketFactorsPng },
      { filename: "breadth-adv-dec.png", bytes: breadthAdvDecPng },
      { filename: "breadth-sector-adv-dec.png", bytes: breadthSectorPng },
    ],
  });

  await browser.close();
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
