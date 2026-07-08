import { chromium } from "playwright";

const PANEL_URL = "https://stockcharts.com/panels/";
const TARGET_TITLE = "Advancers & Decliners";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
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

  await page.goto(PANEL_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  const panelEl = await findPanelByHeading(page, TARGET_TITLE);
  if (!panelEl) {
    // Fallback: full-page screenshot so you still get something useful.
    const png = await page.screenshot({ fullPage: true, type: "png" });
    const stamp = nowStampHk();
    await postDiscordWebhook({
      webhookUrl,
      content: `StockCharts panels (${stamp} HK) — couldn't isolate **${TARGET_TITLE}**, sending full page.`,
      filename: "stockcharts-panels.png",
      fileBytes: png,
    });
    return;
  }

  // Ensure the element is in view and stable.
  await panelEl.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);

  const png = await panelEl.screenshot({ type: "png" });
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

