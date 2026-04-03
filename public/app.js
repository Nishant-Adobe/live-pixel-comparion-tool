const form = document.getElementById("compare-form");
const viewportSelect = document.getElementById("viewport");
const modeSelect = document.getElementById("mode");
const leftUrlInput = document.getElementById("left-url");
const rightUrlInput = document.getElementById("right-url");
const loginComparisonToggle = document.getElementById("login-comparison-toggle");
const capturePanel = document.getElementById("capture-panel");
const storageStatePathInput = document.getElementById("storage-state-path");
const captureSessionNameInput = document.getElementById("capture-session-name");
const startLeftCaptureButton = document.getElementById("start-left-capture-button");
const startRightCaptureButton = document.getElementById("start-right-capture-button");
const saveCaptureButton = document.getElementById("save-capture-button");
const cancelCaptureButton = document.getElementById("cancel-capture-button");
const captureStatusNode = document.getElementById("capture-status");
const statusNode = document.getElementById("status");
const openLiveButton = document.getElementById("open-live-button");
const summaryNode = document.getElementById("summary");
const warningsList = document.getElementById("warnings-list");
const artifactSummary = document.getElementById("artifact-summary");
const diffImage = document.getElementById("diff-image");
const findingsList = document.getElementById("findings-list");
const workspace = document.querySelector(".workspace");
const leftImage = document.getElementById("left-image");
const rightImage = document.getElementById("right-image");
const leftPlaceholder = document.getElementById("left-placeholder");
const rightPlaceholder = document.getElementById("right-placeholder");
const leftOverlay = document.getElementById("left-overlay");
const rightOverlay = document.getElementById("right-overlay");
const leftFrameWrap = document.getElementById("left-frame-wrap");
const rightFrameWrap = document.getElementById("right-frame-wrap");
const leftMeta = document.getElementById("left-meta");
const rightMeta = document.getElementById("right-meta");

let currentSessionId = null;
let lastResult = null;
let activeCaptureId = null;
let activeMismatchIndex = null;

function setCaptureStatus(message, isError = false) {
  captureStatusNode.textContent = message;
  captureStatusNode.style.color = isError ? "var(--red)" : "var(--muted)";
}

function syncCaptureButtons() {
  const hasActiveCapture = Boolean(activeCaptureId);
  startLeftCaptureButton.disabled = hasActiveCapture;
  startRightCaptureButton.disabled = hasActiveCapture;
  saveCaptureButton.disabled = !hasActiveCapture;
  cancelCaptureButton.disabled = !hasActiveCapture;
}

function syncLoginComparisonUi() {
  const enabled = loginComparisonToggle.checked;
  capturePanel.style.display = enabled ? "block" : "none";

  if (!enabled && !activeCaptureId) {
    captureStatusNode.textContent = "No login capture in progress.";
  }
}

function setPreviewState(side, state, message = "") {
  const image = side === "left" ? leftImage : rightImage;
  const placeholder = side === "left" ? leftPlaceholder : rightPlaceholder;

  if (state === "ready") {
    image.style.display = "block";
    placeholder.style.display = "none";
    return;
  }

  image.style.display = "none";
  placeholder.style.display = "grid";
  placeholder.textContent = message;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.style.color = isError ? "var(--red)" : "var(--muted)";
}

function resetOverlays() {
  leftOverlay.innerHTML = "";
  rightOverlay.innerHTML = "";
}

function renderWarnings(warnings = []) {
  warningsList.innerHTML = "";

  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    warningsList.appendChild(item);
  }
}

function renderArtifacts(result) {
  if (!result.artifacts) {
    leftImage.removeAttribute("src");
    rightImage.removeAttribute("src");
    diffImage.removeAttribute("src");
    setPreviewState("left", "empty", "Run a comparison to load the left preview.");
    setPreviewState("right", "empty", "Run a comparison to load the right preview.");
    artifactSummary.style.display = "none";
    artifactSummary.textContent = "";
    diffImage.style.display = "none";
    return;
  }

  setPreviewState("left", "loading", "Loading left preview...");
  setPreviewState("right", "loading", "Loading right preview...");
  leftImage.src = `${result.artifacts.leftImage}?v=${result.sessionId}`;
  rightImage.src = `${result.artifacts.rightImage}?v=${result.sessionId}`;

  if (result.mode === "screenshot") {
    diffImage.src = `${result.artifacts.diffImage}?v=${result.sessionId}`;
    diffImage.style.display = "block";
    artifactSummary.style.display = "block";
    artifactSummary.textContent =
      `${result.artifacts.mismatchPixels.toLocaleString()} differing pixels ` +
      `(${result.artifacts.mismatchPercent}% of ${result.artifacts.width} x ${result.artifacts.height})`;
  } else {
    diffImage.removeAttribute("src");
    diffImage.style.display = "none";
    artifactSummary.style.display = "none";
    artifactSummary.textContent = "";
  }
}

function renderBoxes(target, mismatches, side, scale, activeIndex = null) {
  target.innerHTML = "";

  mismatches.forEach((mismatch, index) => {
    const data = mismatch[side];

    if (!data) {
      return;
    }

    const box = document.createElement("div");
    box.className = `overlay-box ${side}`;
    if (index === activeIndex) {
      box.classList.add("active");
    }
    box.style.left = `${data.rect.x * scale}px`;
    box.style.top = `${data.rect.y * scale}px`;
    box.style.width = `${data.rect.width * scale}px`;
    box.style.height = `${data.rect.height * scale}px`;

    const label = document.createElement("span");
    label.textContent = mismatch.label || "Mismatch";
    box.appendChild(label);
    target.appendChild(box);
  });
}

function setActiveFinding(index) {
  activeMismatchIndex = index;
  findingsList.querySelectorAll(".finding-button").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.index) === index);
  });

  if (lastResult) {
    updateOverlayScale(lastResult);
  }
}

function focusMismatch(index) {
  if (!lastResult || !lastResult.mismatches[index]) {
    return;
  }

  const mismatch = lastResult.mismatches[index];
  const leftScale = lastResult.artifacts?.width ? leftImage.clientWidth / lastResult.artifacts.width : 1;
  const rightScale = lastResult.artifacts?.width ? rightImage.clientWidth / lastResult.artifacts.width : 1;
  const leftTarget =
    mismatch.left?.rect?.y != null ? leftFrameWrap.offsetTop + mismatch.left.rect.y * leftScale : Number.MAX_SAFE_INTEGER;
  const rightTarget =
    mismatch.right?.rect?.y != null
      ? rightFrameWrap.offsetTop + mismatch.right.rect.y * rightScale
      : Number.MAX_SAFE_INTEGER;
  const targetY = Math.max(0, Math.min(leftTarget, rightTarget) - 32);

  setActiveFinding(index);
  workspace?.scrollTo({
    top: targetY,
    behavior: "smooth"
  });
}

function renderFindings(result) {
  findingsList.innerHTML = "";

  if (result.mode === "screenshot") {
    findingsList.innerHTML =
      '<li class="hint">Screenshot diff mode shows an image-level diff instead of DOM mismatch rows.</li>';
    return;
  }

  if (!result.mismatches.length) {
    findingsList.innerHTML = '<li class="hint">No mismatches crossed the current thresholds.</li>';
    return;
  }

  result.mismatches.forEach((mismatch, index) => {
    const item = document.createElement("li");
    const suggestionMarkup = (mismatch.suggestions || [])
      .map((suggestion) => `<li>${suggestion}</li>`)
      .join("");

    item.innerHTML = `
      <button type="button" class="finding-button" data-index="${index}">
        ${mismatch.label || "Unnamed element"}
      </button>
      <div>${mismatch.reasons.join(", ")}</div>
      <div class="hint">${mismatch.left.descriptor.path}</div>
      ${
        suggestionMarkup
          ? `<ul class="suggestions-list">${suggestionMarkup}</ul>`
          : '<div class="hint">No concrete fix suggestion generated for this mismatch.</div>'
      }
    `;
    item.querySelector(".finding-button")?.addEventListener("click", () => focusMismatch(index));
    findingsList.appendChild(item);
  });
}

function updatePreviewMeta(result) {
  const width = result.viewportSize.width;
  const height = result.viewportSize.height;
  const leftIssues = result.left.issues || [];
  const rightIssues = result.right.issues || [];

  leftMeta.textContent = leftIssues.length ? `${width} x ${height} • ${leftIssues.join(", ")}` : `${width} x ${height}`;
  rightMeta.textContent = rightIssues.length
    ? `${width} x ${height} • ${rightIssues.join(", ")}`
    : `${width} x ${height}`;
}

function updateOverlayScale(result) {
  resetOverlays();

  if (result.mode !== "dom" || !result.artifacts || !leftImage.naturalWidth || !rightImage.naturalWidth) {
    return;
  }

  const leftScale = leftImage.clientWidth / result.artifacts.width;
  const rightScale = rightImage.clientWidth / result.artifacts.width;

  renderBoxes(leftOverlay, result.mismatches, "left", leftScale, activeMismatchIndex);
  renderBoxes(rightOverlay, result.mismatches, "right", rightScale, activeMismatchIndex);

  leftFrameWrap.style.minHeight = `${leftImage.clientHeight}px`;
  rightFrameWrap.style.minHeight = `${rightImage.clientHeight}px`;
}

function updateActionState(result) {
  const warnings = result.warnings || [];
  const hasBotProtection = warnings.some((warning) => warning.includes("bot protection detected"));
  const canOpenLive = result.mode === "dom" && !hasBotProtection;
  openLiveButton.disabled = !canOpenLive;

  if (result.mode === "screenshot") {
    setStatus("Screenshot diff complete. Use the shared preview scroller to inspect both sides together.");
    return;
  }

  setStatus(
    hasBotProtection
      ? "DOM comparison completed with bot-protection warnings. Preview images are available, but live inspection is disabled."
      : "Comparison complete. Use the shared preview scroller, or open live inspection for real pages."
  );
}

async function loadViewports() {
  const response = await fetch("/api/viewports");
  const viewports = await response.json();

  Object.entries(viewports).forEach(([value, viewport]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${viewport.label} (${viewport.width} x ${viewport.height})`;
    viewportSelect.appendChild(option);
  });

  viewportSelect.value = "desktop";
}

async function loadModes() {
  const response = await fetch("/api/modes");
  const modes = await response.json();

  Object.entries(modes).forEach(([value, mode]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = mode.label;
    modeSelect.appendChild(option);
  });

  modeSelect.value = "dom";
}

async function handleCompare(event) {
  event.preventDefault();
  resetOverlays();
  renderWarnings();
  renderArtifacts({});
  openLiveButton.disabled = true;
  setStatus("Running browser comparison...");

  try {
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    if (!loginComparisonToggle.checked || !payload.storageStatePath) {
      delete payload.storageStatePath;
    }

    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Comparison failed.");
    }

    currentSessionId = result.sessionId;
    lastResult = result;
    activeMismatchIndex = null;
    summaryNode.textContent =
      result.mode === "screenshot"
        ? `Screenshot diff at ${result.viewportSize.width} x ${result.viewportSize.height}`
        : `${result.mismatches.length} mismatches at ${result.viewportSize.width} x ${result.viewportSize.height}`;
    renderWarnings(result.warnings || []);
    renderArtifacts(result);
    renderFindings(result);
    updatePreviewMeta(result);
    updateActionState(result);
    if (result.mismatches.length > 0) {
      setActiveFinding(0);
    }

    if (leftImage.complete && rightImage.complete) {
      updateOverlayScale(result);
    }
  } catch (error) {
    currentSessionId = null;
    lastResult = null;
    summaryNode.textContent = "Comparison failed.";
    renderWarnings();
    renderArtifacts({});
    setStatus(error.message || "Comparison failed.", true);
  }
}

async function handleLiveOpen() {
  if (!currentSessionId) {
    return;
  }

  setStatus("Opening live highlighted browser windows...");

  try {
    const response = await fetch(`/api/open-live/${currentSessionId}`, { method: "POST" });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to open live inspection.");
    }

    setStatus(result.message);
  } catch (error) {
    setStatus(error.message || "Unable to open live inspection.", true);
  }
}

async function handleStartCapture(loginUrl) {
  setCaptureStatus("Opening a login browser...");

  try {
    const sessionName = captureSessionNameInput.value || "twinpixel-login";
    const response = await fetch("/api/storage-state/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginUrl, sessionName })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to start login capture.");
    }

    activeCaptureId = result.captureId;
    syncCaptureButtons();
    storageStatePathInput.value = result.outputPath;
    setCaptureStatus(result.message);
  } catch (error) {
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus(error.message || "Unable to start login capture.", true);
  }
}

async function handleSaveCapture() {
  if (!activeCaptureId) {
    return;
  }

  setCaptureStatus("Saving storage state from the login browser...");

  try {
    const response = await fetch(`/api/storage-state/complete/${activeCaptureId}`, {
      method: "POST"
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Unable to save login session.");
    }

    storageStatePathInput.value = result.outputPath;
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus(result.message);
  } catch (error) {
    setCaptureStatus(error.message || "Unable to save login session.", true);
  }
}

async function handleCancelCapture() {
  if (!activeCaptureId) {
    return;
  }

  try {
    await fetch(`/api/storage-state/cancel/${activeCaptureId}`, { method: "POST" });
  } finally {
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus("No login capture in progress.");
  }
}

form.addEventListener("submit", handleCompare);
openLiveButton.addEventListener("click", handleLiveOpen);
startLeftCaptureButton.addEventListener("click", () => handleStartCapture(leftUrlInput.value));
startRightCaptureButton.addEventListener("click", () => handleStartCapture(rightUrlInput.value));
saveCaptureButton.addEventListener("click", handleSaveCapture);
cancelCaptureButton.addEventListener("click", handleCancelCapture);
loginComparisonToggle.addEventListener("change", syncLoginComparisonUi);
leftImage.addEventListener("load", () => {
  setPreviewState("left", "ready");
  if (lastResult) {
    updateOverlayScale(lastResult);
  }
});
rightImage.addEventListener("load", () => {
  setPreviewState("right", "ready");
  if (lastResult) {
    updateOverlayScale(lastResult);
  }
});
leftImage.addEventListener("error", () => {
  setPreviewState("left", "error", "Left preview could not be loaded. Run the comparison again.");
});
rightImage.addEventListener("error", () => {
  setPreviewState("right", "error", "Right preview could not be loaded. Run the comparison again.");
});
window.addEventListener("resize", () => {
  if (lastResult) {
    updateOverlayScale(lastResult);
  }
});
modeSelect.addEventListener("change", () => {
  openLiveButton.textContent = modeSelect.value === "dom" ? "Open live inspection" : "Live inspection unavailable";
  openLiveButton.disabled = true;
});

Promise.all([loadViewports(), loadModes()]).catch((error) => {
  setStatus(error.message || "Unable to load tool presets.", true);
});

syncCaptureButtons();
syncLoginComparisonUi();
