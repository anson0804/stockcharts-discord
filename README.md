# stockcharts-discord

每天香港時間 10:00，自動從 `https://stockcharts.com/panels/` 擷取 **Advancers & Decliners** 區塊截圖，並透過 Discord Webhook 發到指定頻道（使用 GitHub Actions 排程）。

## 你需要準備的東西

### 1) Discord Webhook URL

- 在 Discord：目標頻道 → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**

### 2) StockCharts 會員帳號（用來登入 panels）

因為 `https://stockcharts.com/panels/` 需要會員登入，這個 workflow 會先自動登入再截圖。

### 3) GitHub Secrets

在你的 GitHub repo：

- Settings → Secrets and variables → Actions → **New repository secret**
- `DISCORD_WEBHOOK_URL`：貼上你的 Discord Webhook URL
- `STOCKCHARTS_USERNAME`：你的 StockCharts 登入帳號（或 email）
- `STOCKCHARTS_PASSWORD`：你的 StockCharts 密碼

## 觸發方式

- **自動排程**：每天香港時間 10:00（GitHub Actions cron：`0 2 * * *`，UTC 02:00）
- **手動觸發**：GitHub Actions → `Post StockCharts Advancers & Decliners` → Run workflow

## 本機測試（可選）

```bash
npm install
npm run install-browsers
set DISCORD_WEBHOOK_URL=你的Webhook && npm run post
```

（Windows PowerShell 也可以用）

```powershell
$env:DISCORD_WEBHOOK_URL="你的Webhook"
npm run post
```

## 備註

- 這個腳本會嘗試只截「Advancers & Decliners」那張卡片；如果網站 DOM 結構變動導致找不到，會退回改發整頁截圖，避免完全沒訊息。

