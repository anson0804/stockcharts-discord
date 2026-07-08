import { chromium } from "playwright";

const MARKET_SUMMARY_URL = "https://stockcharts.com/freecharts/marketsummary.html";
const LOGIN_URL = "https://stockcharts.com/login/";
const TARGET_TITLE = "Advancers & Decliners";

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

async function ensureAdvDeclPanelEnabled(page) {
  // No-op for public market summary.
  void page;
}

async function findPanelByHeading(page, headingText) {
  // Try a few strategies to be resilient to markup changes.
  const candidates = [
    page.getByRole("heading", { name: headingText, exact: false }),
    page.getByText(headingText, { exact: false }),
  ];

  for (const loc of candidates) {
    try {
      await loc.first().waitFor({ state: "visible", timeout: 20_000 });
      const heading = loc.first();

      // Walk up the DOM to find a container that looks like a panel/card.
      const handle = await heading.elementHandle();
      if (!handle) continue;

      const panelHandle = await handle.evaluateHandle((el) => {
        const maxHops = 8;
        let cur = el;
        for (let i = 0; i < maxHops && cur; i++) {
          const parent = cur.parentElement;
          if (!parent) break;
          cur = parent;
          const cls = (cur.getAttribute("class") || "").toLowerCase();
          const id = (cur.getAttribute("id") || "").toLowerCase();
          if (
            cls.includes("panel") ||
            cls.includes("card") ||
            cls.includes("module") ||
            id.includes("panel")
          ) {
            return cur;
          }
        }
        return el;
      });

      const panel = panelHandle.asElement();
      if (panel) return panel;
    } catch {
      // try next strategy
    }
  }

  return null;
}

async function findSectionByHeading(page, headingText) {
  // Find a heading or label containing the section title, then walk up to a sensible container.
  const candidates = [
    page.getByRole("heading", { name: headingText, exact: false }),
    page.getByText(headingText, { exact: false }),
  ];

  for (const loc of candidates) {
    try {
      await loc.first().waitFor({ state: "attached", timeout: 15_000 });
      const el = await loc.first().elementHandle();
      if (!el) continue;

      const containerHandle = await el.evaluateHandle((node) => {
        const maxHops = 10;
        let cur = node;
        for (let i = 0; i < maxHops && cur; i++) {
          const parent = cur.parentElement;
          if (!parent) break;
          cur = parent;
          const tag = (cur.tagName || "").toLowerCase();
          const cls = (cur.getAttribute("class") || "").toLowerCase();
          const id = (cur.getAttribute("id") || "").toLowerCase();
          const txt = (cur.innerText || "").toLowerCase();

          if (id.includes("adv") || cls.includes("adv") || cls.includes("declin")) return cur;
          if (tag === "section" || tag === "table") return cur;
          if (cls.includes("panel") || cls.includes("box") || cls.includes("module") || cls.includes("content"))
            return cur;
          if (txt.includes("advancers") && txt.includes("decliners") && txt.length < 5000) return cur;
        }
        return node;
      });

      const container = containerHandle.asElement();
      if (container) return container;
    } catch {
      // try next
    }
  }
  return null;
}

async function listDashboardPanelTitles(page) {
  return await page.evaluate(() => {
    const uniq = (arr) => [...new Set(arr)];
    const titles = uniq(
      Array.from(document.querySelectorAll(".panel-grid-title, #header-title"))
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean)
    );
    return titles.slice(0, 50);
  });
}

async function warmUpDashboard(page) {
  // Some panels render lazily when scrolled into view.
  const steps = [0.2, 0.5, 0.8, 0.0];
  for (const p of steps) {
    await page.evaluate((pp) => window.scrollTo(0, document.body.scrollHeight * pp), p).catch(() => {});
    await page.waitForTimeout(350);
  }
}

function clipToViewport(clip, viewport) {
  const x = Math.max(0, clip.x);
  const y = Math.max(0, clip.y);
  const maxW = viewport?.width ?? 1440;
  const maxH = viewport?.height ?? 900;
  const w = Math.max(1, Math.min(clip.width + (clip.x - x), maxW - x));
  const h = Math.max(1, Math.min(clip.height + (clip.y - y), maxH - y));
  return { x, y, width: w, height: h };
}

async function screenshotAllPanelsByTitle(page, title) {
  // On StockCharts dashboard, each panel is typically inside a `div.inner`.
  const titleText = page.getByText(title, { exact: false });
  const panels = page.locator("div.inner").filter({ has: titleText });

  const count = await panels.count();
  if (count === 0) return null;

  // Scroll each panel into view so bounding boxes resolve reliably.
  const boxes = [];
  for (let i = 0; i < count; i++) {
    const p = panels.nth(i);
    await p.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(150);
    const box = await p.boundingBox();
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) return null;

  // Union bounding box of all matched panels.
  const pad = 8;
  const minX = Math.min(...boxes.map((b) => b.x)) - pad;
  const minY = Math.min(...boxes.map((b) => b.y)) - pad;
  const maxX = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
  const maxY = Math.max(...boxes.map((b) => b.y + b.height)) + pad;

  const clip = clipToViewport(
    { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    page.viewportSize()
  );

  await page.waitForTimeout(300);
  return await page.screenshot({ type: "png", clip });
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
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  await page.goto(MARKET_SUMMARY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  await warmUpDashboard(page);

  const section = await findSectionByHeading(page, TARGET_TITLE);
  if (!section) {
    const png = await page.screenshot({ fullPage: true, type: "png" });
    const stamp = nowStampHk();
    await postDiscordWebhook({
      webhookUrl,
      content: `StockCharts market summary (${stamp} HK) — couldn't locate **${TARGET_TITLE}** section. Sending full page.`,
      filename: "stockcharts-marketsummary.png",
      fileBytes: png,
    });
    return;
  }

  await section.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  const png = await section.screenshot({ type: "png" });

  const stamp = nowStampHk();
  await postDiscordWebhook({
    webhookUrl,
    content: `**${TARGET_TITLE}** (${stamp} HK)`,
    filename: "advancers-decliners.png",
    fileBytes: png,
  });

  await browser.close();
}

main().catch((err) => {
  // Make GitHub Actions show a clear failure.
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});

