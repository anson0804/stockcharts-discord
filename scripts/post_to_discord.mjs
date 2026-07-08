import { chromium } from "playwright";

const PANEL_URL = "https://stockcharts.com/panels/";
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

  if (!username || !password) return; // allow public mode (will likely fail for members-only pages)

  // If already logged in, do nothing.
  const alreadyLoggedIn = await page
    .locator("text=/logout/i")
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadyLoggedIn) return;

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Try common form patterns: labels, placeholders, ids/names.
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
  if (!userField || !passField) {
    throw new Error(
      "Could not find login form fields on StockCharts login page. The page layout may have changed."
    );
  }

  await userField.fill(username);
  await passField.fill(password);

  const submitCandidates = [
    page.getByRole("button", { name: /log in|sign in/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];
  const submit = await firstVisible(submitCandidates);
  if (!submit) throw new Error("Could not find login submit button on StockCharts login page.");

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    submit.click(),
  ]);

  // Give the site a moment to establish session and redirect.
  await page.waitForLoadState("networkidle").catch(() => {});

  const loginError = await page
    .locator("text=/invalid|incorrect|failed|error/i")
    .first()
    .isVisible()
    .catch(() => false);
  if (loginError) throw new Error("StockCharts login appears to have failed (error message detected).");
}

async function ensureAdvDeclPanelEnabled(page) {
  // If the panel is already present, nothing to do.
  const alreadyPresent = await page
    .getByText(TARGET_TITLE, { exact: false })
    .first()
    .isVisible()
    .catch(() => false);
  if (alreadyPresent) return;

  // Open settings dropdown (gear icon).
  const settingsBtn = page.locator("#settings-button").first();
  await settingsBtn.waitFor({ state: "visible", timeout: 20_000 });
  await settingsBtn.click();

  // Click "Dashboard Preferences" from the dropdown.
  const dashboardPrefs = page
    .getByRole("menuitem", { name: /dashboard preferences/i })
    .first();
  const dashboardPrefsFallback = page.getByText(/dashboard preferences/i).first();

  if (await dashboardPrefs.isVisible().catch(() => false)) {
    await dashboardPrefs.click();
  } else {
    await dashboardPrefsFallback.waitFor({ state: "visible", timeout: 10_000 });
    await dashboardPrefsFallback.click();
  }

  // Preferences UI is typically a modal/dialog; wait for it to appear.
  const dialog = page
    .getByRole("dialog")
    .first()
    .or(page.locator(".modal-dialog").first());
  await dialog.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  // Go to "Additional Data Panels" section/tab.
  const additionalTabCandidates = [
    page.getByRole("tab", { name: /additional data panels/i }),
    page.getByRole("button", { name: /additional data panels/i }),
    page.getByText(/additional data panels/i),
  ];

  let openedAdditional = false;
  for (const loc of additionalTabCandidates) {
    const l = loc.first();
    if (await l.isVisible().catch(() => false)) {
      await l.click().catch(() => {});
      openedAdditional = true;
      break;
    }
  }
  if (!openedAdditional) {
    throw new Error('Could not find "Additional Data Panels" in Dashboard Preferences.');
  }

  // Find the "Advancers & Decliners" row and enable it.
  const advText = page.getByText(TARGET_TITLE, { exact: false }).first();
  await advText.waitFor({ state: "visible", timeout: 20_000 });

  // Try common enable controls near the row: checkbox/toggle, Add/Enable button.
  const rowContainer = await advText.elementHandle();
  if (!rowContainer) throw new Error(`Found "${TARGET_TITLE}" text but could not access element handle.`);

  const enableHandle = await rowContainer.evaluateHandle((el) => {
    // Walk up to a reasonable row container.
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      const parent = cur.parentElement;
      if (!parent) break;
      cur = parent;
      const txt = (cur.innerText || "").toLowerCase();
      if (txt.includes("advancers") && txt.includes("decliners")) return cur;
      const cls = (cur.getAttribute("class") || "").toLowerCase();
      if (cls.includes("row") || cls.includes("panel") || cls.includes("item")) return cur;
    }
    return el;
  });

  const enableEl = enableHandle.asElement();
  if (!enableEl) throw new Error(`Could not locate container row for "${TARGET_TITLE}".`);

  // Within the row, prefer clicking an unchecked checkbox/toggle; otherwise click a button labeled Add/Enable.
  const enabled = await enableEl.evaluate((row) => {
    const inputs = Array.from(row.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    const checked = inputs.some((i) => (i).checked);
    const hasEnabledText = /enabled|added|on/i.test(row.innerText || "");
    return checked || hasEnabledText;
  });

  if (!enabled) {
    // Try input first
    const clicked = await enableEl.evaluate((row) => {
      const checkbox =
        row.querySelector('input[type="checkbox"]:not(:checked)') ||
        row.querySelector('input[type="checkbox"]');
      if (checkbox) {
        (checkbox).click();
        return true;
      }
      const btn = Array.from(row.querySelectorAll("button,a")).find((b) =>
        /add|enable|show|on/i.test((b.textContent || "").trim())
      );
      if (btn) {
        (btn).click();
        return true;
      }
      // Sometimes the whole row is clickable (toggle).
      (row).click();
      return true;
    });

    if (!clicked) throw new Error(`Could not enable "${TARGET_TITLE}" panel (no toggle/button found).`);
  }

  // Save/apply if there's a save/apply button in the dialog.
  const saveCandidates = [
    page.getByRole("button", { name: /save|apply/i }),
    page.getByRole("button", { name: /done|close/i }),
  ];
  for (const loc of saveCandidates) {
    const l = loc.first();
    if (await l.isVisible().catch(() => false)) {
      await l.click().catch(() => {});
      break;
    }
  }

  // Give dashboard time to re-render.
  await page.waitForTimeout(1200);
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

  await ensureLoggedIn(page);

  await page.goto(PANEL_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Some dashboards require enabling the panel via settings before it appears.
  await ensureAdvDeclPanelEnabled(page);
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

