import { chromium } from "playwright";
import sharp from "sharp";

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

function toDateKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getHkYmd(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function shiftHkYmd({ year, month, day }, deltaDays) {
  const d = new Date(`${toDateKey(year, month, day)}T12:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return getHkYmd(d);
}

function observeFixedHoliday(year, month, day) {
  const utc = new Date(Date.UTC(year, month - 1, day));
  const dow = utc.getUTCDay();
  if (dow === 6) return toDateKey(year, month, day - 1);
  if (dow === 0) return toDateKey(year, month, day + 1);
  return toDateKey(year, month, day);
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return toDateKey(year, month, day);
}

function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return toDateKey(year, month, last.getUTCDate() - offset);
}

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function goodFriday(year) {
  const e = easterSunday(year);
  const d = new Date(Date.UTC(e.year, e.month - 1, e.day));
  d.setUTCDate(d.getUTCDate() - 2);
  return toDateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function usMarketHolidayKeys(year) {
  return [
    observeFixedHoliday(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    goodFriday(year),
    lastWeekday(year, 5, 1),
    observeFixedHoliday(year, 6, 19),
    observeFixedHoliday(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observeFixedHoliday(year, 12, 25),
  ];
}

function shouldSkipScheduledRun() {
  const today = getHkYmd();
  const yesterday = shiftHkYmd(today, -1);
  const yesterdayKey = toDateKey(yesterday.year, yesterday.month, yesterday.day);

  const years = new Set([today.year, yesterday.year]);
  const holidays = new Set();
  for (const y of years) {
    for (const k of usMarketHolidayKeys(y)) holidays.add(k);
  }

  if (holidays.has(yesterdayKey)) {
    console.log(
      `Skip: ${toDateKey(today.year, today.month, today.day)} HK is the day after US market holiday (${yesterdayKey}).`
    );
    return true;
  }
  return false;
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

async function stitchHorizontal(buffers, gap = 12) {
  const metas = await Promise.all(
    buffers.map(async (buf) => {
      const meta = await sharp(buf).metadata();
      return { buf, width: meta.width ?? 0, height: meta.height ?? 0 };
    })
  );

  const totalWidth = metas.reduce((sum, img) => sum + img.width, 0) + gap * (metas.length - 1);
  const maxHeight = Math.max(...metas.map((img) => img.height));

  const composites = [];
  let left = 0;
  for (const img of metas) {
    composites.push({
      input: img.buf,
      left,
      top: Math.floor((maxHeight - img.height) / 2),
    });
    left += img.width + gap;
  }

  return sharp({
    create: {
      width: totalWidth,
      height: maxHeight,
      channels: 4,
      background: { r: 245, g: 245, b: 245, alpha: 1 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function postDiscordWebhook({ webhookUrl, content, filename, fileBytes }) {
  const form = new FormData();
  if (content && String(content).trim()) {
    form.set("content", content);
  }
  form.append("file", new Blob([fileBytes], { type: "image/png" }), filename);

  const resp = await fetch(webhookUrl, { method: "POST", body: form });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${resp.status} ${resp.statusText}\n${text}`);
  }
}

async function main() {
  if (process.env.FORCE_RUN !== "1" && shouldSkipScheduledRun()) {
    return;
  }

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
      filename: "stockcharts-marketsummary.png",
      fileBytes: png,
    });
    return;
  }

  const combined = await stitchHorizontal([marketFactorsPng, breadthAdvDecPng, breadthSectorPng]);

  await postDiscordWebhook({
    webhookUrl,
    content: "",
    filename: "market-summary-combined.png",
    fileBytes: combined,
  });

  await browser.close();
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
