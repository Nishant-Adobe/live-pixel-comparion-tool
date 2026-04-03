import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, label: "Desktop" },
  laptop: { width: 1280, height: 800, label: "Laptop" },
  tablet: { width: 834, height: 1112, label: "Tablet" },
  mobile: { width: 390, height: 844, label: "Mobile" }
};

const COMPARE_MODES = {
  dom: { value: "dom", label: "DOM audit" },
  screenshot: { value: "screenshot", label: "Screenshot diff" }
};

const TARGET_SELECTOR = [
  "main",
  "header",
  "footer",
  "nav",
  "section",
  "article",
  "aside",
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "img",
  "picture",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "span",
  "label",
  "[role='button']",
  "[role='link']",
  "[data-testid]",
  "[aria-label]"
].join(",");

const BOT_PROTECTION_PATTERNS = [
  "captcha",
  "verify you are human",
  "verify you're human",
  "press and hold",
  "enable javascript and cookies",
  "security check",
  "bot protection",
  "attention required",
  "cf-challenge",
  "cloudflare",
  "perimeterx",
  "datadome",
  "akamai",
  "access denied",
  "request unsuccessful"
];

const COLLECT_SCRIPT = ({ selector }) => {
  const normalizeText = (value) => (value || "").replace(/\s+/g, " ").trim().slice(0, 80);

  const pathFor = (element) => {
    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      const name = current.tagName.toLowerCase();
      let part = name;

      if (current.id) {
        part += `#${current.id}`;
        parts.unshift(part);
        break;
      }

      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children).filter(
          (child) => child.tagName === current.tagName
        );
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }

      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  };

  const nodes = Array.from(document.querySelectorAll(selector));
  const elements = [];

  for (const element of nodes) {
    const rect = element.getBoundingClientRect();

    if (rect.width < 4 || rect.height < 4) {
      continue;
    }

    const computed = window.getComputedStyle(element);

    if (computed.visibility === "hidden" || computed.display === "none" || Number(computed.opacity) === 0) {
      continue;
    }

    const text = normalizeText(element.innerText || element.textContent);
    const role = element.getAttribute("role") || "";
    const testId = element.getAttribute("data-testid") || "";
    const ariaLabel = element.getAttribute("aria-label") || "";
    const className = (element.className || "")
      .toString()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(".");

    const keyParts = [
      element.tagName.toLowerCase(),
      element.id || "",
      testId,
      role,
      ariaLabel,
      text,
      className,
      pathFor(element)
    ];

    elements.push({
      key: keyParts.join("|"),
      tag: element.tagName.toLowerCase(),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      metrics: {
        fontSize: computed.fontSize,
        fontWeight: computed.fontWeight,
        lineHeight: computed.lineHeight,
        color: computed.color,
        backgroundColor: computed.backgroundColor,
        borderRadius: computed.borderRadius
      },
      descriptor: {
        id: element.id || "",
        testId,
        role,
        ariaLabel,
        text,
        path: pathFor(element)
      }
    });
  }

  return {
    title: document.title,
    url: window.location.href,
    bodyText: normalizeText(document.body ? document.body.innerText : ""),
    page: {
      width: Math.max(document.documentElement.scrollWidth, window.innerWidth),
      height: Math.max(document.documentElement.scrollHeight, window.innerHeight)
    },
    elements
  };
};

function clampNumber(value) {
  return Number.parseFloat(value.toFixed(2));
}

function getViewport(preset) {
  return VIEWPORTS[preset] || VIEWPORTS.desktop;
}

const STABILIZE_INIT_SCRIPT = ({ fixedTimestamp }) => {
  const OriginalDate = Date;
  const fixedTime = fixedTimestamp;
  const randomValue = 0.123456789;

  class FrozenDate extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedTime);
        return;
      }

      super(...args);
    }

    static now() {
      return fixedTime;
    }
  }

  Object.setPrototypeOf(FrozenDate, OriginalDate);
  window.Date = FrozenDate;
  Math.random = () => randomValue;
};

const STABILIZE_PAGE_SCRIPT = () => {
  const style = document.createElement("style");
  style.setAttribute("data-twinpixel-stabilize", "true");
  style.textContent = `
    *,
    *::before,
    *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
      scroll-behavior: auto !important;
    }
  `;
  document.head.appendChild(style);

  for (const media of document.querySelectorAll("video, audio")) {
    media.pause?.();
    media.currentTime = 0;
  }

  for (const animatedImage of document.querySelectorAll('img[src$=".gif"]')) {
    animatedImage.style.visibility = "hidden";
  }

  window.scrollTo(0, 0);
};

function buildContextOptions(viewport, storageStatePath) {
  const options = {
    viewport: {
      width: viewport.width,
      height: viewport.height
    },
    deviceScaleFactor: 1,
    reducedMotion: "reduce"
  };

  if (storageStatePath) {
    options.storageState = storageStatePath;
  }

  return options;
}

function detectBotProtection(snapshot) {
  const haystack = [snapshot.title || "", snapshot.bodyText || "", snapshot.url || ""].join(" ").toLowerCase();
  return BOT_PROTECTION_PATTERNS.find((pattern) => haystack.includes(pattern)) || null;
}

async function inspectPage(page, url) {
  let response;

  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  } catch (error) {
    throw new Error(`Could not load ${url}: ${error.message}`);
  }

  if (!response) {
    throw new Error(`Could not load ${url}: no browser response was returned.`);
  }

  const status = response.status();
  await page.evaluate(STABILIZE_PAGE_SCRIPT);
  await page.evaluate(async () => {
    await document.fonts?.ready?.catch?.(() => {});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const snapshot = await page.evaluate(COLLECT_SCRIPT, { selector: TARGET_SELECTOR });
  const issues = [];

  if (status >= 400) {
    issues.push(`HTTP ${status}`);
  }

  const botProtectionSignal = detectBotProtection(snapshot);
  if (botProtectionSignal) {
    issues.push(`bot protection detected (${botProtectionSignal})`);
  }

  if (snapshot.elements.length === 0) {
    issues.push("no comparable DOM elements found");
  }

  return {
    ...snapshot,
    status,
    issues
  };
}

function buildDiffReasons(left, right) {
  const reasons = [];
  const isMedia = ["img", "picture"].includes(left.tag) || ["img", "picture"].includes(right.tag);
  const deltas = {
    x: Math.abs(left.rect.x - right.rect.x),
    y: Math.abs(left.rect.y - right.rect.y),
    width: Math.abs(left.rect.width - right.rect.width),
    height: Math.abs(left.rect.height - right.rect.height),
    fontSize: Math.abs(parseFloat(left.metrics.fontSize) - parseFloat(right.metrics.fontSize))
  };

  if (deltas.x > 4) {
    reasons.push(`x offset ${clampNumber(deltas.x)}px`);
  }

  if (deltas.y > 4) {
    reasons.push(`y offset ${clampNumber(deltas.y)}px`);
  }

  if (deltas.width > 4) {
    reasons.push(`width delta ${clampNumber(deltas.width)}px`);
  }

  if (deltas.height > 4) {
    reasons.push(`height delta ${clampNumber(deltas.height)}px`);
  }

  if (!isMedia && deltas.fontSize > 0.5) {
    reasons.push(`font size delta ${clampNumber(deltas.fontSize)}px`);
  }

  if (!isMedia && left.metrics.color !== right.metrics.color) {
    reasons.push("text color differs");
  }

  if (left.metrics.backgroundColor !== right.metrics.backgroundColor) {
    reasons.push("background differs");
  }

  return reasons;
}

function numericCssValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildFixSuggestions(left, right) {
  const suggestions = [];
  const isMedia = ["img", "picture"].includes(left.tag) || ["img", "picture"].includes(right.tag);
  const xDelta = right.rect.x - left.rect.x;
  const yDelta = right.rect.y - left.rect.y;
  const widthDelta = right.rect.width - left.rect.width;
  const heightDelta = right.rect.height - left.rect.height;
  const fontSizeDelta =
    (numericCssValue(right.metrics.fontSize) ?? 0) - (numericCssValue(left.metrics.fontSize) ?? 0);
  const lineHeightDelta =
    (numericCssValue(right.metrics.lineHeight) ?? 0) - (numericCssValue(left.metrics.lineHeight) ?? 0);
  const borderRadiusDelta =
    (numericCssValue(right.metrics.borderRadius) ?? 0) - (numericCssValue(left.metrics.borderRadius) ?? 0);

  if (Math.abs(xDelta) > 4) {
    suggestions.push(
      xDelta > 0
        ? `Move the left element about ${clampNumber(xDelta)}px to the right or reduce left-side horizontal spacing.`
        : `Move the left element about ${clampNumber(Math.abs(xDelta))}px to the left or increase left-side horizontal spacing.`
    );
  }

  if (Math.abs(yDelta) > 4) {
    suggestions.push(
      yDelta > 0
        ? `Push the left element down about ${clampNumber(yDelta)}px or reduce top spacing on the right reference.`
        : `Pull the left element up about ${clampNumber(Math.abs(yDelta))}px or increase its top spacing.`
    );
  }

  if (Math.abs(widthDelta) > 4) {
    suggestions.push(
      widthDelta > 0
        ? `Increase the left element width by about ${clampNumber(widthDelta)}px or relax its max-width constraint.`
        : `Reduce the left element width by about ${clampNumber(Math.abs(widthDelta))}px or tighten its container width.`
    );
  }

  if (Math.abs(heightDelta) > 4) {
    suggestions.push(
      heightDelta > 0
        ? `Increase the left element height by about ${clampNumber(heightDelta)}px by checking ${isMedia ? "image aspect ratio or media sizing" : "padding, line-height, or media sizing"}.`
        : `Reduce the left element height by about ${clampNumber(Math.abs(heightDelta))}px by checking ${isMedia ? "image aspect ratio or media sizing" : "padding, line-height, or media sizing"}.`
    );
  }

  if (!isMedia && Math.abs(fontSizeDelta) > 0.5) {
    suggestions.push(
      fontSizeDelta > 0
        ? `Increase the left font size by about ${clampNumber(fontSizeDelta)}px to match the right reference.`
        : `Reduce the left font size by about ${clampNumber(Math.abs(fontSizeDelta))}px to match the right reference.`
    );
  }

  if (!isMedia && Math.abs(lineHeightDelta) > 1) {
    suggestions.push(
      lineHeightDelta > 0
        ? `Increase the left line-height by about ${clampNumber(lineHeightDelta)}px to match vertical rhythm.`
        : `Reduce the left line-height by about ${clampNumber(Math.abs(lineHeightDelta))}px to avoid extra text height.`
    );
  }

  if (!isMedia && left.metrics.color !== right.metrics.color) {
    suggestions.push("Match the text color token or computed color value between both versions.");
  }

  if (left.metrics.backgroundColor !== right.metrics.backgroundColor) {
    suggestions.push("Check the background token, overlay, or parent surface color for this element.");
  }

  if (Math.abs(borderRadiusDelta) > 0.5) {
    suggestions.push(
      borderRadiusDelta > 0
        ? `Increase the left border radius by about ${clampNumber(borderRadiusDelta)}px.`
        : `Reduce the left border radius by about ${clampNumber(Math.abs(borderRadiusDelta))}px.`
    );
  }

  return suggestions.slice(0, 3);
}

function buildMismatchLabel(element) {
  if (element.descriptor.text) {
    return element.descriptor.text;
  }

  if (element.descriptor.ariaLabel) {
    return element.descriptor.ariaLabel;
  }

  if (element.descriptor.id) {
    return `#${element.descriptor.id}`;
  }

  if (element.descriptor.testId) {
    return `[data-testid="${element.descriptor.testId}"]`;
  }

  if (["img", "picture"].includes(element.tag)) {
    return "Image block";
  }

  return `${element.tag} element`;
}

function compareElements(leftSnapshot, rightSnapshot) {
  const rightMap = new Map(rightSnapshot.elements.map((element) => [element.key, element]));
  const mismatches = [];

  for (const leftElement of leftSnapshot.elements) {
    const rightElement = rightMap.get(leftElement.key);

    if (!rightElement) {
      continue;
    }

    const reasons = buildDiffReasons(leftElement, rightElement);

    if (reasons.length === 0) {
      continue;
    }

    mismatches.push({
      key: leftElement.key,
      label: buildMismatchLabel(leftElement),
      reasons,
      suggestions: buildFixSuggestions(leftElement, rightElement),
      left: leftElement,
      right: rightElement,
      score: reasons.length
    });
  }

  return mismatches.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return b.left.rect.width * b.left.rect.height - a.left.rect.width * a.left.rect.height;
  });
}

async function ensureArtifactDir(artifactDir) {
  await fs.mkdir(artifactDir, { recursive: true });
}

function normalizePngDimensions(sourcePng, width, height) {
  const normalized = new PNG({ width, height });

  for (let index = 0; index < normalized.data.length; index += 4) {
    normalized.data[index] = 255;
    normalized.data[index + 1] = 255;
    normalized.data[index + 2] = 255;
    normalized.data[index + 3] = 255;
  }

  PNG.bitblt(sourcePng, normalized, 0, 0, sourcePng.width, sourcePng.height, 0, 0);
  return normalized;
}

async function writeDiffArtifacts({ artifactDir, sessionId, leftPage, rightPage }) {
  await ensureArtifactDir(artifactDir);

  const leftFile = `${sessionId}-left.png`;
  const rightFile = `${sessionId}-right.png`;
  const diffFile = `${sessionId}-diff.png`;
  const leftPath = path.join(artifactDir, leftFile);
  const rightPath = path.join(artifactDir, rightFile);
  const diffPath = path.join(artifactDir, diffFile);

  await Promise.all([
    leftPage.screenshot({ path: leftPath, fullPage: true }),
    rightPage.screenshot({ path: rightPath, fullPage: true })
  ]);

  const [leftBuffer, rightBuffer] = await Promise.all([fs.readFile(leftPath), fs.readFile(rightPath)]);
  const leftPng = PNG.sync.read(leftBuffer);
  const rightPng = PNG.sync.read(rightBuffer);

  const width = Math.max(leftPng.width, rightPng.width);
  const height = Math.max(leftPng.height, rightPng.height);
  const normalizedLeft = normalizePngDimensions(leftPng, width, height);
  const normalizedRight = normalizePngDimensions(rightPng, width, height);
  const diffPng = new PNG({ width, height });

  const mismatchPixels = pixelmatch(
    normalizedLeft.data,
    normalizedRight.data,
    diffPng.data,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: false
    }
  );

  await fs.writeFile(diffPath, PNG.sync.write(diffPng));

  return {
    leftImage: `/artifacts/${leftFile}`,
    rightImage: `/artifacts/${rightFile}`,
    diffImage: `/artifacts/${diffFile}`,
    width,
    height,
    mismatchPixels,
    mismatchPercent: clampNumber((mismatchPixels / (width * height)) * 100)
  };
}

const HIGHLIGHT_SCRIPT = ({ mismatches, pane }) => {
  const overlayId = "__pixcel_overlay__";
  const existing = document.getElementById(overlayId);

  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement("div");
  overlay.id = overlayId;
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = `${Math.max(document.documentElement.scrollWidth, window.innerWidth)}px`;
  overlay.style.height = `${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`;
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";

  const hue = pane === "left" ? "#ef4444" : "#2563eb";

  for (const mismatch of mismatches) {
    const data = mismatch[pane];
    if (!data) {
      continue;
    }

    const rect = data.rect;
    const box = document.createElement("div");
    box.style.position = "absolute";
    box.style.left = `${rect.x}px`;
    box.style.top = `${rect.y}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.outline = `2px solid ${hue}`;
    box.style.outlineOffset = "1px";
    box.style.background = `${hue}1a`;
    box.style.boxSizing = "border-box";

    const tag = document.createElement("div");
    tag.textContent = mismatch.label || mismatch.key;
    tag.style.position = "absolute";
    tag.style.left = "0";
    tag.style.top = "-20px";
    tag.style.maxWidth = "280px";
    tag.style.padding = "2px 6px";
    tag.style.background = hue;
    tag.style.color = "#fff";
    tag.style.font = "12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace";
    tag.style.whiteSpace = "nowrap";
    tag.style.overflow = "hidden";
    tag.style.textOverflow = "ellipsis";

    box.appendChild(tag);
    overlay.appendChild(box);
  }

  document.body.appendChild(overlay);
};

function buildWarnings(leftSnapshot, rightSnapshot) {
  return [
    ...leftSnapshot.issues.map((issue) => `Left: ${issue}`),
    ...rightSnapshot.issues.map((issue) => `Right: ${issue}`)
  ];
}

function assertInspectableSnapshot(snapshot, sideLabel) {
  if (snapshot.issues.includes("no comparable DOM elements found") && snapshot.issues.length === 1) {
    throw new Error(`${sideLabel} page loaded but no comparable DOM elements were found at ${snapshot.url}.`);
  }
}

export async function comparePages({
  leftUrl,
  rightUrl,
  viewportPreset = "desktop",
  mismatchLimit = 40,
  mode = "dom",
  artifactDir,
  storageStatePath = null
}) {
  const viewport = getViewport(viewportPreset);
  const fixedTimestamp = Date.UTC(2026, 0, 1, 0, 0, 0);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(buildContextOptions(viewport, storageStatePath));
  await context.addInitScript(STABILIZE_INIT_SCRIPT, { fixedTimestamp });
  const leftPage = await context.newPage();
  const rightPage = await context.newPage();

  try {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      inspectPage(leftPage, leftUrl),
      inspectPage(rightPage, rightUrl)
    ]);

    const sessionId = crypto.randomUUID();
    const warnings = buildWarnings(leftSnapshot, rightSnapshot);

    if (!artifactDir) {
      throw new Error("artifactDir is required for preview generation.");
    }

    const artifacts = await writeDiffArtifacts({
      artifactDir,
      sessionId,
      leftPage,
      rightPage
    });

    if (mode === "screenshot") {

      return {
        sessionId,
        mode,
        viewport: viewportPreset,
        viewportSize: viewport,
        left: leftSnapshot,
        right: rightSnapshot,
        warnings,
        mismatches: [],
        artifacts
      };
    }

    assertInspectableSnapshot(leftSnapshot, "Left");
    assertInspectableSnapshot(rightSnapshot, "Right");

    const mismatches = compareElements(leftSnapshot, rightSnapshot).slice(0, mismatchLimit);

    return {
      sessionId,
      mode,
      viewport: viewportPreset,
      viewportSize: viewport,
      left: leftSnapshot,
      right: rightSnapshot,
      warnings,
      mismatches,
      artifacts
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function openLiveComparison(session, storageStatePath = null) {
  if (session.mode !== "dom") {
    throw new Error("Live inspection is only available for DOM audit mode.");
  }

  const blockedIssues = [...session.left.issues, ...session.right.issues].filter((issue) =>
    issue.startsWith("bot protection detected")
  );

  if (blockedIssues.length > 0) {
    throw new Error("Live inspection is blocked because one of the pages is behind bot protection.");
  }

  const viewport = getViewport(session.viewport);
  const mismatchPayload = session.mismatches.map((mismatch) => ({
    key: mismatch.key,
    label: mismatch.label,
    left: { rect: mismatch.left.rect },
    right: { rect: mismatch.right.rect }
  }));

  const leftBrowser = await chromium.launch({
    headless: false,
    args: [`--window-size=${viewport.width},${viewport.height + 120}`, "--window-position=40,80"]
  });
  const rightBrowser = await chromium.launch({
    headless: false,
    args: [`--window-size=${viewport.width},${viewport.height + 120}`, `--window-position=${viewport.width + 80},80`]
  });

  const leftContext = await leftBrowser.newContext(buildContextOptions(viewport, storageStatePath));
  const rightContext = await rightBrowser.newContext(buildContextOptions(viewport, storageStatePath));
  const leftPage = await leftContext.newPage();
  const rightPage = await rightContext.newPage();

  await Promise.all([
    leftPage.goto(session.left.url, { waitUntil: "networkidle", timeout: 45000 }),
    rightPage.goto(session.right.url, { waitUntil: "networkidle", timeout: 45000 })
  ]);

  await Promise.all([
    leftPage.evaluate(HIGHLIGHT_SCRIPT, { mismatches: mismatchPayload, pane: "left" }),
    rightPage.evaluate(HIGHLIGHT_SCRIPT, { mismatches: mismatchPayload, pane: "right" })
  ]);

  return {
    message: "Live comparison windows opened in Chromium.",
    viewport
  };
}

export { COMPARE_MODES, VIEWPORTS };
