# stockcharts-discord

每天香港時間 10:00，自動從 `https://stockcharts.com/freecharts/marketsummary.html` 擷取 **Market Factors** 與 **Breadth（Adv/Dec + Sector）** 面板，橫向拼成一張圖，透過 Discord Webhook 發到指定頻道（**只發圖片、不發文字**）。

排程使用 [cron-job.org](https://console.cron-job.org/dashboard) 觸發 GitHub Actions。

## 你需要準備的東西

### 1) Discord Webhook URL

- 在 Discord：目標頻道 → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**

### 2) GitHub Secrets

在你的 GitHub repo → Settings → Secrets and variables → Actions：

- `DISCORD_WEBHOOK_URL`
- `STOCKCHARTS_USERNAME`
- `STOCKCHARTS_PASSWORD`

### 3) GitHub Personal Access Token（給 cron-job.org 用）

建立一個 PAT（Fine-grained 或 classic），權限需能觸發 Actions：`actions:write`（或 repo 範圍內 workflow 權限）。

## cron-job.org 設定

在 [cron-job.org Dashboard](https://console.cron-job.org/dashboard) 新增 **Cronjob**：

| 欄位 | 值 |
|------|-----|
| **Title** | StockCharts Market Summary |
| **URL** | `https://api.github.com/repos/anson0804/stockcharts-discord/dispatches` |
| **Method** | `POST` |
| **Schedule** | 每天 **10:00**，時區選 **Asia/Hong_Kong**，星期 **二–六**（`2-6`） |
| **Request body** | `{"event_type":"cron-post"}` |
| **Header** | `Accept: application/vnd.github+json` |
| **Header** | `Authorization: Bearer <你的_GITHUB_PAT>` |
| **Content-Type** | `application/json` |

腳本會自動跳過「美國股市假期隔天」。若要強制執行，在 GitHub Actions 手動 Run workflow 並在 env 設 `FORCE_RUN=1`（可選）。

## 手動觸發（測試）

GitHub → **Actions** → `Post StockCharts Advancers & Decliners` → **Run workflow**

## 本機測試（可選）

```powershell
$env:DISCORD_WEBHOOK_URL="你的Webhook"
$env:STOCKCHARTS_USERNAME="你的帳號"
$env:STOCKCHARTS_PASSWORD="你的密碼"
npm install
npm run post
```
