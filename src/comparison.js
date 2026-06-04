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

    // Key uses only semantic/content attributes so elements match across different
    // DOM structures and CSS class conventions (e.g. AEM live vs EDS local).
    const keyParts = [
      element.tagName.toLowerCase(),
      element.id || "",
      testId,
      role,
      ariaLabel,
      text
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

function normalizeViewportKey(label) {
  return String(label || "custom")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "custom";
}

function clampViewportDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function getViewport(preset, customViewport = null) {
  if (customViewport) {
    const width = clampViewportDimension(customViewport.width, 1280, 320, 2560);
    const height = clampViewportDimension(customViewport.height, 800, 320, 1800);
    const rawLabel = typeof customViewport.label === "string" ? customViewport.label.trim() : "";
    const label = rawLabel || `Custom ${width} x ${height}`;

    return {
      key: `custom-${normalizeViewportKey(label)}-${width}x${height}`,
      width,
      height,
      label,
      isCustom: true
    };
  }

  const presetViewport = VIEWPORTS[preset] || VIEWPORTS.desktop;
  return {
    key: preset,
    ...presetViewport,
    isCustom: false
  };
}

// ── Overlay / consent dismissal ───────────────────────────────────────────────
// Priority-ordered list of selectors to click.
// AbbVie.com uses OneTrust's "notice + close" style banner — it has NO accept
// button, only a × close button (#onetrust-close-btn-container button).
// We try close/dismiss buttons BEFORE accept buttons so that style is handled.
const CONSENT_SELECTORS = [
  // ── OneTrust: close (×) button — AbbVie, most pharma ──
  '#onetrust-close-btn-container button',
  '#onetrust-close-btn-container .ot-close-icon',
  '.onetrust-close-btn-handler',
  'button.ot-close-icon',
  '#onetrust-banner-sdk .ot-close-icon',
  // ── OneTrust: accept / allow all button (other sites) ──
  '#onetrust-accept-btn-handler',
  '#accept-recommended-btn-handler',
  'button#onetrust-accept-btn-handler',
  // ── Cookiebot ──
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  // ── TrustArc / Evidon ──
  '#truste-consent-button',
  '.truste-button1',
  // ── Generic GDPR accept ──
  'button[id*="cookie"][id*="accept" i]',
  'button[class*="cookie"][class*="accept" i]',
  'button[class*="accept"][class*="cookie" i]',
  '[data-testid="cookie-accept"]',
  '[data-testid="accept-all-cookies"]',
  '[aria-label="Accept all cookies" i]',
  '[aria-label="Accept cookies" i]',
  '[aria-label="Allow all cookies" i]',
  // ── Generic modal / popup / banner close ──
  '[id*="onetrust"] button[aria-label="Close" i]',
  '[id*="cookie"] button[aria-label="Close" i]',
  '[id*="consent"] button[aria-label="Close" i]',
  '[class*="cookie"] button[aria-label="Close" i]',
  '[class*="consent"] button[aria-label="Close" i]',
  '[class*="banner"] button[aria-label="Close" i]',
  '[class*="modal"] button[aria-label="Close" i]',
  '[class*="popup"] button[aria-label="Close" i]',
  'button[aria-label="Dismiss" i]',
];

async function tryClick(locatorOrHandle, page, waitMs = 600) {
  try {
    await locatorOrHandle.click({ force: true, timeout: 3000 });
    await page.waitForTimeout(waitMs);
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function dismissOverlays(page) {
  // Give dynamic banners (OneTrust injects after DOMContentLoaded) time to appear
  await page.waitForTimeout(1200);

  // ── Phase 1: wait specifically for OneTrust banner then close it ──
  try {
    await page.waitForSelector('#onetrust-banner-sdk', { state: 'visible', timeout: 5000 });
    // Try close (×) button first — AbbVie style
    const closers = [
      '#onetrust-close-btn-container button',
      '#onetrust-close-btn-container .ot-close-icon',
      '.onetrust-close-btn-handler',
      'button.ot-close-icon',
    ];
    for (const sel of closers) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        const clicked = await tryClick(el, page);
        if (clicked) {
          // Wait for banner to disappear
          await page.waitForSelector('#onetrust-banner-sdk', { state: 'hidden', timeout: 3000 }).catch(() => {});
          break;
        }
      }
    }
    // If no close button, try accept
    const acceptEl = page.locator('#onetrust-accept-btn-handler').first();
    if (await acceptEl.isVisible({ timeout: 400 }).catch(() => false)) {
      await tryClick(acceptEl, page);
      await page.waitForSelector('#onetrust-banner-sdk', { state: 'hidden', timeout: 3000 }).catch(() => {});
    }
  } catch {
    // OneTrust not present — fall through to generic handling
  }

  // ── Phase 2: generic selectors sweep ──
  for (const selector of CONSENT_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
        await tryClick(el, page, 500);
        break; // one dismiss per pass is enough
      }
    } catch {}
  }

  // ── Phase 3: iframes (OneTrust GTM variant wraps in an iframe) ──
  try {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      for (const sel of CONSENT_SELECTORS.slice(0, 10)) {
        try {
          const el = frame.locator(sel).first();
          if (await el.isVisible({ timeout: 300 }).catch(() => false)) {
            await el.click({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(500);
            break;
          }
        } catch {}
      }
    }
  } catch {}

  // ── Phase 4: Escape key dismisses many remaining modals ──
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);

  // ── Phase 5: force-hide any lingering overlay/banner via JS ──
  await page.evaluate(() => {
    const bannerIds = ['onetrust-banner-sdk', 'onetrust-consent-sdk', 'onetrust-pc-sdk',
                       'CybotCookiebotDialog', 'truste-consent-track'];
    for (const id of bannerIds) {
      const el = document.getElementById(id);
      if (el) el.style.setProperty('display', 'none', 'important');
    }
    // Also hide by class patterns
    const patterns = ['onetrust', 'cookie-banner', 'cookie-consent', 'cookiebot',
                      'truste-overlay', 'consent-banner', 'gdpr-banner'];
    for (const p of patterns) {
      document.querySelectorAll(`[id*="${p}"], [class*="${p}"]`).forEach(el => {
        const tag = el.tagName.toLowerCase();
        if (!['html','body','header','main','footer','nav'].includes(tag)) {
          el.style.setProperty('display', 'none', 'important');
        }
      });
    }
  }).catch(() => {});

  await page.waitForTimeout(300);
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
  style.setAttribute("data-pixcel-stabilize", "true");
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
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  } catch (error) {
    throw new Error(`Could not load ${url}: ${error.message}`);
  }

  if (!response) {
    throw new Error(`Could not load ${url}: no browser response was returned.`);
  }

  // Follow any redirect — use the final response URL
  const status = response.status();

  // Dismiss cookie consent banners, popups, and overlays before collecting DOM
  await dismissOverlays(page);

  // Extra settle time for any dismiss animations / reflows
  await page.waitForTimeout(500);

  // Re-stabilize after overlay removal (animations may have restarted during popup close)
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

/**
 * Parse an rgba/rgb CSS color string into [r, g, b, a] array, or null.
 */
function parseColor(value) {
  if (!value) return null;
  const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), m[4] !== undefined ? parseFloat(m[4]) : 1];
}

/** Treat any color with alpha=0 as identical (both are fully transparent). */
function colorsVisiblyDifferent(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca && cb && ca[3] === 0 && cb[3] === 0) return false;
  return a !== b;
}

/**
 * Compute the median Y delta and X delta across all matched element pairs.
 * These represent global layout shifts (e.g. different header heights) that
 * should not be reported as per-element issues.
 */
function computeGlobalOffsets(leftSnapshot, rightSnapshot) {
  const rightMap = new Map(rightSnapshot.elements.map((el) => [el.key, el]));
  const xDeltas = [];
  const yDeltas = [];
  for (const le of leftSnapshot.elements) {
    const re = rightMap.get(le.key);
    if (!re) continue;
    xDeltas.push(re.rect.x - le.rect.x);
    yDeltas.push(re.rect.y - le.rect.y);
  }
  const median = (arr) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  return { x: median(xDeltas), y: median(yDeltas) };
}

/** Assign a severity level based on how many and what kinds of issues an element has. */
function computeSeverity(reasons) {
  const hasLayout = reasons.some(r => /offset|delta/.test(r));
  const hasColor = reasons.some(r => /color|background/.test(r));
  const hasFont = reasons.some(r => /font size/.test(r));
  const count = reasons.length;
  if (count >= 3 || (hasLayout && (hasColor || hasFont))) return 'critical';
  if (count === 2 || hasLayout) return 'high';
  if (hasColor || hasFont) return 'medium';
  return 'low';
}

function buildDiffReasons(left, right, globalOffset = { x: 0, y: 0 }) {
  const reasons = [];
  const isMedia = ["img", "picture"].includes(left.tag) || ["img", "picture"].includes(right.tag);

  const rawXDelta = right.rect.x - left.rect.x;
  const rawYDelta = right.rect.y - left.rect.y;
  // Subtract global offset so we only report element-specific position drift
  const xDiff = Math.abs(rawXDelta - globalOffset.x);
  const yDiff = Math.abs(rawYDelta - globalOffset.y);

  const deltas = {
    width: Math.abs(left.rect.width - right.rect.width),
    height: Math.abs(left.rect.height - right.rect.height),
    fontSize: Math.abs(parseFloat(left.metrics.fontSize) - parseFloat(right.metrics.fontSize))
  };

  // Raised thresholds to 8px to suppress sub-pixel and minor browser rendering noise
  if (xDiff > 8) {
    reasons.push(`x offset ${clampNumber(xDiff)}px`);
  }

  if (yDiff > 8) {
    reasons.push(`y offset ${clampNumber(yDiff)}px`);
  }

  if (deltas.width > 8) {
    reasons.push(`width delta ${clampNumber(deltas.width)}px`);
  }

  if (deltas.height > 8) {
    reasons.push(`height delta ${clampNumber(deltas.height)}px`);
  }

  if (!isMedia && deltas.fontSize > 1) {
    reasons.push(`font size delta ${clampNumber(deltas.fontSize)}px`);
  }

  if (!isMedia && colorsVisiblyDifferent(left.metrics.color, right.metrics.color)) {
    reasons.push("text color differs");
  }

  if (colorsVisiblyDifferent(left.metrics.backgroundColor, right.metrics.backgroundColor)) {
    reasons.push("background differs");
  }

  return reasons;
}

function numericCssValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildFixSuggestions(left, right, globalOffset = { x: 0, y: 0 }) {
  const suggestions = [];
  const isMedia = ["img", "picture"].includes(left.tag) || ["img", "picture"].includes(right.tag);
  const xDelta = (right.rect.x - left.rect.x) - globalOffset.x;
  const yDelta = (right.rect.y - left.rect.y) - globalOffset.y;
  const widthDelta = right.rect.width - left.rect.width;
  const heightDelta = right.rect.height - left.rect.height;
  const fontSizeDelta =
    (numericCssValue(right.metrics.fontSize) ?? 0) - (numericCssValue(left.metrics.fontSize) ?? 0);
  const lineHeightDelta =
    (numericCssValue(right.metrics.lineHeight) ?? 0) - (numericCssValue(left.metrics.lineHeight) ?? 0);
  const borderRadiusDelta =
    (numericCssValue(right.metrics.borderRadius) ?? 0) - (numericCssValue(left.metrics.borderRadius) ?? 0);

  if (Math.abs(xDelta) > 8) {
    suggestions.push(
      xDelta > 0
        ? `Move the left element about ${clampNumber(xDelta)}px to the right or reduce left-side horizontal spacing.`
        : `Move the left element about ${clampNumber(Math.abs(xDelta))}px to the left or increase left-side horizontal spacing.`
    );
  }

  if (Math.abs(yDelta) > 8) {
    suggestions.push(
      yDelta > 0
        ? `Push the left element down about ${clampNumber(yDelta)}px or reduce top spacing on the right reference.`
        : `Pull the left element up about ${clampNumber(Math.abs(yDelta))}px or increase its top spacing.`
    );
  }

  if (Math.abs(widthDelta) > 8) {
    suggestions.push(
      widthDelta > 0
        ? `Increase the left element width by about ${clampNumber(widthDelta)}px or relax its max-width constraint.`
        : `Reduce the left element width by about ${clampNumber(Math.abs(widthDelta))}px or tighten its container width.`
    );
  }

  if (Math.abs(heightDelta) > 8) {
    suggestions.push(
      heightDelta > 0
        ? `Increase the left element height by about ${clampNumber(heightDelta)}px by checking ${isMedia ? "image aspect ratio or media sizing" : "padding, line-height, or media sizing"}.`
        : `Reduce the left element height by about ${clampNumber(Math.abs(heightDelta))}px by checking ${isMedia ? "image aspect ratio or media sizing" : "padding, line-height, or media sizing"}.`
    );
  }

  if (!isMedia && Math.abs(fontSizeDelta) > 1) {
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

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function compareElements(leftSnapshot, rightSnapshot) {
  const globalOffset = computeGlobalOffsets(leftSnapshot, rightSnapshot);
  const rightMap = new Map(rightSnapshot.elements.map((element) => [element.key, element]));
  const leftKeys = new Set(leftSnapshot.elements.map((el) => el.key));
  const mismatches = [];

  // Matched elements — report only element-specific differences
  for (const leftElement of leftSnapshot.elements) {
    const rightElement = rightMap.get(leftElement.key);

    if (!rightElement) {
      // Present on left, missing on right
      mismatches.push({
        key: leftElement.key,
        label: buildMismatchLabel(leftElement),
        reasons: ['missing on migrated page'],
        suggestions: ['Add the corresponding element on the migrated page.'],
        severity: 'critical',
        left: leftElement,
        right: null,
        score: 10
      });
      continue;
    }

    const reasons = buildDiffReasons(leftElement, rightElement, globalOffset);

    if (reasons.length === 0) {
      continue;
    }

    const severity = computeSeverity(reasons);

    mismatches.push({
      key: leftElement.key,
      label: buildMismatchLabel(leftElement),
      reasons,
      suggestions: buildFixSuggestions(leftElement, rightElement, globalOffset),
      severity,
      left: leftElement,
      right: rightElement,
      score: reasons.length
    });
  }

  // Elements present on right but not on left
  for (const rightElement of rightSnapshot.elements) {
    if (!leftKeys.has(rightElement.key)) {
      mismatches.push({
        key: rightElement.key,
        label: buildMismatchLabel(rightElement),
        reasons: ['extra element on migrated page (not in original)'],
        suggestions: ['Verify this element is intentional; remove if not present in the original.'],
        severity: 'medium',
        left: null,
        right: rightElement,
        score: 2
      });
    }
  }

  // Sort: severity first, then score (issue count), then element area
  return mismatches.sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4);
    if (sevDiff !== 0) return sevDiff;
    if (b.score !== a.score) return b.score - a.score;
    const aArea = a.left ? a.left.rect.width * a.left.rect.height : 0;
    const bArea = b.left ? b.left.rect.width * b.left.rect.height : 0;
    return bArea - aArea;
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

function mergeNearbyRegions(regions, gap = 60) {
  let current = regions.slice();
  let changed = true;

  while (changed) {
    changed = false;
    const next = [];
    const used = new Array(current.length).fill(false);

    for (let i = 0; i < current.length; i++) {
      if (used[i]) continue;
      let r = { ...current[i] };

      for (let j = i + 1; j < current.length; j++) {
        if (used[j]) continue;
        const o = current[j];
        const proximity =
          r.x - gap <= o.x + o.width &&
          o.x - gap <= r.x + r.width &&
          r.y - gap <= o.y + o.height &&
          o.y - gap <= r.y + r.height;

        if (proximity) {
          const x0 = Math.min(r.x, o.x);
          const y0 = Math.min(r.y, o.y);
          const x1 = Math.max(r.x + r.width, o.x + o.width);
          const y1 = Math.max(r.y + r.height, o.y + o.height);
          r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, pixelCount: r.pixelCount + o.pixelCount };
          used[j] = true;
          changed = true;
        }
      }

      next.push(r);
    }

    current = next;
  }

  return current;
}

function detectDiffRegions(diffPng, minPixels = 80) {
  const { width, height, data } = diffPng;
  const visited = new Uint8Array(width * height);
  const regions = [];
  const PADDING = 12;

  const isDiff = (idx) => {
    const p = idx * 4;
    return data[p] > 200 && data[p + 1] < 160;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (visited[idx] || !isDiff(idx)) continue;
      const stack = [idx];
      visited[idx] = 1;
      let x0 = x, x1 = x, y0 = y, y1 = y, count = 0;
      while (stack.length) {
        const cur = stack.pop();
        const cy = Math.floor(cur / width);
        const cx = cur % width;
        count++;
        if (cx < x0) x0 = cx;
        if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy;
        if (cy > y1) y1 = cy;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (visited[ni] || !isDiff(ni)) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }
      if (count >= minPixels) {
        const rx = Math.max(0, x0 - PADDING);
        const ry = Math.max(0, y0 - PADDING);
        regions.push({
          x: rx,
          y: ry,
          width: Math.min(width - rx, x1 - x0 + 1 + PADDING * 2),
          height: Math.min(height - ry, y1 - y0 + 1 + PADDING * 2),
          pixelCount: count
        });
      }
    }
  }

  return mergeNearbyRegions(regions)
    .sort((a, b) => a.y - b.y)
    .slice(0, 30);
}

async function writeDiffArtifacts({ artifactDir, sessionId, leftPage, rightPage }) {
  await ensureArtifactDir(artifactDir);

  const leftFile = `${sessionId}-left.png`;
  const rightFile = `${sessionId}-right.png`;
  const diffFile = `${sessionId}-diff.png`;
  const leftPath = path.join(artifactDir, leftFile);
  const rightPath = path.join(artifactDir, rightFile);
  const diffPath = path.join(artifactDir, diffFile);

  // Scroll to top on both pages before full-page screenshot
  await Promise.all([
    leftPage.evaluate(() => window.scrollTo(0, 0)),
    rightPage.evaluate(() => window.scrollTo(0, 0)),
  ]);
  await leftPage.waitForTimeout(400);

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

  const diffRegions = detectDiffRegions(diffPng);

  return {
    leftImage: `/artifacts/${leftFile}`,
    rightImage: `/artifacts/${rightFile}`,
    diffImage: `/artifacts/${diffFile}`,
    width,
    height,
    mismatchPixels,
    mismatchPercent: clampNumber((mismatchPixels / (width * height)) * 100),
    diffRegions
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
  customViewport = null,
  mismatchLimit = 40,
  mode = "dom",
  artifactDir,
  storageStatePath = null
}) {
  const viewport = getViewport(viewportPreset, customViewport);
  const fixedTimestamp = Date.UTC(2026, 0, 1, 0, 0, 0);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ]
  });
  const contextOptions = {
    ...buildContextOptions(viewport, storageStatePath),
    // Realistic user-agent so sites don't serve bot-detection pages
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
    ignoreHTTPSErrors: true,
  };
  const context = await browser.newContext(contextOptions);
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
        requestedMode: mode,
        fallbackReason: null,
        viewport: viewport.key,
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
      requestedMode: mode,
      fallbackReason: null,
      viewport: viewport.key,
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

  const viewport = getViewport(session.viewport, session.viewportSize);
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

  // Dismiss cookie/consent overlays in live windows before highlighting
  await Promise.all([
    dismissOverlays(leftPage),
    dismissOverlays(rightPage)
  ]);

  await Promise.all([
    leftPage.evaluate(STABILIZE_PAGE_SCRIPT),
    rightPage.evaluate(STABILIZE_PAGE_SCRIPT)
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
