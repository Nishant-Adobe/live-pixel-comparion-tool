import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { comparePages, openLiveComparison, COMPARE_MODES, VIEWPORTS } from "./comparison.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "..", "public");
const artifactDir = path.join(publicDir, "artifacts");
const storageStateDir = path.join(process.cwd(), ".twinpixel-sessions");
const app = express();
const port = Number.parseInt(process.env.PORT || "4173", 10);
const sessions = new Map();
const loginCaptures = new Map();
const SESSION_RETENTION_MS = 30 * 60 * 1000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));
app.use("/artifacts", express.static(artifactDir));

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }

  return value.trim();
}

function validateUrl(value, name) {
  const normalized = requireString(value, name);
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${name} must use http or https.`);
  }

  return parsed.toString();
}

async function validateStorageStatePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const candidate = value.trim();
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);

  try {
    await fs.access(resolved);
  } catch {
    throw new Error("storageStatePath does not exist or is not readable.");
  }

  return resolved;
}

function sanitizeSessionName(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const cleaned = raw.replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || `session-${Date.now()}`;
}

function artifactFilenamesFromSession(session) {
  const artifacts = session?.artifacts;

  if (!artifacts) {
    return [];
  }

  return [artifacts.leftImage, artifacts.rightImage, artifacts.diffImage]
    .filter(Boolean)
    .map((value) => value.split("?")[0])
    .map((value) => value.replace(/^\/artifacts\//, ""))
    .filter(Boolean);
}

async function deleteArtifactsForSession(session) {
  const filenames = artifactFilenamesFromSession(session);

  await Promise.all(
    filenames.map(async (filename) => {
      try {
        await fs.unlink(path.join(artifactDir, filename));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    })
  );
}

async function cleanupArtifacts() {
  const now = Date.now();
  const activeArtifactNames = new Set();

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_RETENTION_MS) {
      await deleteArtifactsForSession(session);
      sessions.delete(sessionId);
      continue;
    }

    for (const filename of artifactFilenamesFromSession(session)) {
      activeArtifactNames.add(filename);
    }
  }

  try {
    const filenames = await fs.readdir(artifactDir);

    await Promise.all(
      filenames.map(async (filename) => {
        if (activeArtifactNames.has(filename)) {
          return;
        }

        try {
          await fs.unlink(path.join(artifactDir, filename));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }
      })
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

app.get("/api/viewports", (_req, res) => {
  res.json(VIEWPORTS);
});

app.get("/api/modes", (_req, res) => {
  res.json(COMPARE_MODES);
});

app.post("/api/storage-state/start", async (req, res) => {
  try {
    const loginUrl = validateUrl(req.body.loginUrl, "loginUrl");
    const sessionName = sanitizeSessionName(req.body.sessionName);
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const captureId = crypto.randomUUID();
    const outputPath = path.join(storageStateDir, `${sessionName}.json`);
    loginCaptures.set(captureId, { browser, context, outputPath, loginUrl, sessionName });

    res.json({
      captureId,
      outputPath,
      loginUrl,
      sessionName,
      message: "Browser opened. Log in there, then click Save session in TwinPixel."
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to start storage-state capture."
    });
  }
});

app.post("/api/storage-state/complete/:captureId", async (req, res) => {
  const capture = loginCaptures.get(req.params.captureId);

  if (!capture) {
    res.status(404).json({ error: "Capture session not found." });
    return;
  }

  try {
    await fs.mkdir(path.dirname(capture.outputPath), { recursive: true });
    await capture.context.storageState({ path: capture.outputPath });
    await capture.context.close();
    await capture.browser.close();
    loginCaptures.delete(req.params.captureId);

    res.json({
      outputPath: capture.outputPath,
      message: "Storage state saved. TwinPixel can use it for logged-in comparison now."
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to save storage state."
    });
  }
});

app.post("/api/storage-state/cancel/:captureId", async (req, res) => {
  const capture = loginCaptures.get(req.params.captureId);

  if (!capture) {
    res.status(404).json({ error: "Capture session not found." });
    return;
  }

  try {
    await capture.context.close();
    await capture.browser.close();
    loginCaptures.delete(req.params.captureId);
    res.json({ message: "Capture session cancelled." });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to cancel capture session."
    });
  }
});

app.post("/api/compare", async (req, res) => {
  try {
    await cleanupArtifacts();
    const leftUrl = validateUrl(req.body.leftUrl, "leftUrl");
    const rightUrl = validateUrl(req.body.rightUrl, "rightUrl");
    const viewport = typeof req.body.viewport === "string" ? req.body.viewport : "desktop";
    const mode = typeof req.body.mode === "string" ? req.body.mode : "dom";
    const storageStatePath = await validateStorageStatePath(req.body.storageStatePath);
    const session = await comparePages({
      leftUrl,
      rightUrl,
      viewportPreset: viewport,
      mode,
      storageStatePath,
      artifactDir
    });

    sessions.set(session.sessionId, {
      ...session,
      createdAt: Date.now(),
      storageStatePath
    });
    res.json(session);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Comparison failed."
    });
  }
});

app.post("/api/open-live/:sessionId", async (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    res.status(404).json({ error: "Session not found. Run compare first." });
    return;
  }

  try {
    const result = await openLiveComparison(session, session.storageStatePath);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unable to open live comparison."
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Pixcel tool running at http://localhost:${port}`);
});

setInterval(() => {
  cleanupArtifacts().catch((error) => {
    console.error("Artifact cleanup failed:", error);
  });
}, 5 * 60 * 1000);
