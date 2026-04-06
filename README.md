# Pixel tool

Local comparison tool for opening two URLs side by side, running either a DOM-based pixel audit or a screenshot diff across one or more common or custom viewport sizes, and launching a live inspection session with mismatch overlays injected into both pages when DOM mode is available.

## What it does

- Opens two target URLs in a side-by-side controller UI.
- Runs one viewport or a batch of desktop, laptop, tablet, mobile, and optional custom viewport checks in sequence.
- Compares visible DOM blocks and common interactive/content elements with Playwright.
- Supports screenshot diff mode that saves left, right, and diff images for image-level review.
- Accepts an optional Playwright `storageState` JSON file so you can reuse a legitimate authenticated session you already own.
- Flags layout, sizing, font, and color differences that cross the built-in thresholds.
- Suggests likely fixes for common mismatch types such as spacing, font sizing, width, height, and border radius drift.
- Opens live Chromium windows side by side with red and blue highlights over mismatched DOM regions.

## Setup

```bash
npm install
npx playwright install chromium
npm start
```

Then open [http://localhost:4173](http://localhost:4173).

## Workflow

1. Enter the left and right URLs.
2. Pick one or more viewport presets.
3. Choose `DOM audit` or `Screenshot diff`.
4. Optionally enter a custom viewport width and height for exact design QA.
5. Optionally provide a Playwright `storageState` JSON path if the site requires a legitimate logged-in session.
6. Run comparison.
7. Review the mismatch list or diff images.
8. If you ran multiple viewport checks, switch between result chips to inspect each viewport session.
9. In `DOM audit` mode, click `Open live inspection` to open both pages with overlays injected directly into the DOM for the selected viewport.

## Logged-in sites

If the pages require login, you can now do this directly in the UI:

1. Open the `Login Capture` section.
2. Enter the login URL and an optional session name.
3. Click `Open login browser`.
4. Sign in manually in the browser window that opens.
5. Return to Pixcel tool and click `Save session`.
6. Pixcel tool fills the `Storage state JSON` field automatically.

You can also still use the helper script if you prefer the terminal:

```bash
npm run capture:storage -- https://example.com/login ./storage-state.json
```

That command opens a real Chromium window. Log in manually, return to the terminal, press Enter, and the script will save `storage-state.json`.

Then paste that saved path into the `Storage state JSON` field in the app before running comparison.

## Notes

- Many production websites block embedding with `X-Frame-Options` or `frame-ancestors`. When that happens, the preview iframe may not render, but the Playwright comparison and live inspection mode still work.
- For protected sites, do not bypass anti-bot controls. Instead, use an allowlisted environment or a valid Playwright `storageState` file captured from a legitimate session.
- Screenshot diff artifacts are written under `public/artifacts/` at runtime and are ignored by git.
- The comparison logic assumes the two pages are structurally related, such as production vs staging or design variant A vs B.
- Thresholds and tracked style metrics live in [`src/comparison.js`](/Users/nissingh/Documents/New%20project/src/comparison.js).
- The storage-state capture helper lives in [`scripts/capture-storage-state.js`](/Users/nissingh/Documents/New project/scripts/capture-storage-state.js).
