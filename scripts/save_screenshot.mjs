import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function saveScreenshotToRepo(fileBytes, { cwd = process.cwd(), dateKey } = {}) {
  if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error(`Invalid screenshot dateKey: ${dateKey}`);
  }
  const dir = path.join(cwd, "screenshots");
  await mkdir(dir, { recursive: true });
  const datedPath = path.join(dir, `${dateKey}.png`);
  const latestPath = path.join(dir, "latest.png");
  await writeFile(datedPath, fileBytes);
  await writeFile(latestPath, fileBytes);
  console.log(`Saved screenshot to ${datedPath} and ${latestPath}`);
  return { datedPath, latestPath };
}
