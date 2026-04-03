import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const targetUrl = process.argv[2];
const outputPathArg = process.argv[3] || "storage-state.json";

if (!targetUrl) {
  console.error("Usage: node scripts/capture-storage-state.js <login-url> [output-path]");
  process.exit(1);
}

async function main() {
  const outputPath = path.isAbsolute(outputPathArg)
    ? outputPathArg
    : path.resolve(process.cwd(), outputPathArg);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

  console.log("");
  console.log(`Login in the opened browser, then press Enter here to save storage state to:`);
  console.log(outputPath);
  console.log("");

  process.stdin.resume();
  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await context.storageState({ path: outputPath });

  console.log(`Saved storage state to ${outputPath}`);

  await context.close();
  await browser.close();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
