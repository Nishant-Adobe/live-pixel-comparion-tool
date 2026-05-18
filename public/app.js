/* =========================================================
   Pixcel — Applitools-inspired Visual QA frontend
   ========================================================= */

// ── DOM refs ───────────────────────────────────────────────────────────────
const form                   = document.getElementById('compare-form');
const viewportSelect         = document.getElementById('viewport');
const viewportOptions        = document.getElementById('viewport-options');
const customWidthInput       = document.getElementById('custom-width');
const customHeightInput      = document.getElementById('custom-height');
const customLabelInput       = document.getElementById('custom-label');
const modeSelect             = document.getElementById('mode');
const leftUrlInput           = document.getElementById('left-url');
const rightUrlInput          = document.getElementById('right-url');
const loginComparisonToggle  = document.getElementById('login-comparison-toggle');
const capturePanel           = document.getElementById('capture-panel');
const storageStatePathInput  = document.getElementById('storage-state-path');
const captureSessionNameInput= document.getElementById('capture-session-name');
const startLeftCaptureButton = document.getElementById('start-left-capture-button');
const startRightCaptureButton= document.getElementById('start-right-capture-button');
const saveCaptureButton      = document.getElementById('save-capture-button');
const cancelCaptureButton    = document.getElementById('cancel-capture-button');
const captureStatusNode      = document.getElementById('capture-status');
const statusNode             = document.getElementById('status');
const openLiveButton         = document.getElementById('open-live-button');

// Toolbar
const configToggle  = document.getElementById('config-toggle');
const configDrawer  = document.getElementById('config-drawer');
const statusChip    = document.getElementById('status-chip');
const statusDetail  = document.getElementById('status-detail');
const viewSwitcher  = document.getElementById('view-switcher');

// Workspace columns
const leftCol       = document.getElementById('left-col');
const rightCol      = document.getElementById('right-col');
const diffCol       = document.getElementById('diff-col');
const leftScroll    = document.getElementById('left-scroll');
const rightScroll   = document.getElementById('right-scroll');
const leftCanvas    = document.getElementById('left-canvas');
const rightCanvas   = document.getElementById('right-canvas');
const leftImage     = document.getElementById('left-image');
const rightImage    = document.getElementById('right-image');
const leftOverlay   = document.getElementById('left-overlay');
const rightOverlay  = document.getElementById('right-overlay');
const leftPlaceholder   = document.getElementById('left-placeholder');
const rightPlaceholder  = document.getElementById('right-placeholder');
const leftMeta      = document.getElementById('left-meta');
const rightMeta     = document.getElementById('right-meta');
const leftUrlLabel  = document.getElementById('left-url-label');
const rightUrlLabel = document.getElementById('right-url-label');
const artifactSummary = document.getElementById('artifact-summary');
const diffImage     = document.getElementById('diff-image');
const diffPlaceholder = document.getElementById('diff-placeholder');

// Sidebar
const sessionList      = document.getElementById('session-list');
const warningsList     = document.getElementById('warnings-list');
const findingsList     = document.getElementById('findings-list');
const sidebarBadge     = document.getElementById('sidebar-badge');
const resetIgnoreBtn   = document.getElementById('reset-ignore-btn');

// ── State ──────────────────────────────────────────────────────────────────
let currentResults      = [];
let selectedResultIndex = -1;
let activeRegionIndex   = -1;
let currentViewMode     = 'split';
let activeCaptureId     = null;
let currentSessionId    = null;
let isSyncing           = false;
let ignoredRegions      = new Set(); // indices of dismissed diff regions

let resizeTimer = null;

// ── Ignore persistence (localStorage) ─────────────────────────────────────
function ignoreStorageKey(leftUrl, rightUrl) {
  return `pixcel:ignored:${encodeURIComponent(leftUrl)}|||${encodeURIComponent(rightUrl)}`;
}

function regionCoordKey(r) {
  return `${r.x},${r.y},${r.width},${r.height}`;
}

function loadPersistedIgnores(leftUrl, rightUrl, regions) {
  try {
    const raw = localStorage.getItem(ignoreStorageKey(leftUrl, rightUrl));
    if (!raw) return new Set();
    const coordSet = new Set(JSON.parse(raw));
    const result = new Set();
    regions.forEach((r, i) => { if (coordSet.has(regionCoordKey(r))) result.add(i); });
    return result;
  } catch { return new Set(); }
}

function savePersistedIgnores(leftUrl, rightUrl, regions) {
  try {
    const coords = [...ignoredRegions].map(i => regionCoordKey(regions[i])).filter(Boolean);
    if (coords.length === 0) {
      localStorage.removeItem(ignoreStorageKey(leftUrl, rightUrl));
    } else {
      localStorage.setItem(ignoreStorageKey(leftUrl, rightUrl), JSON.stringify(coords));
    }
  } catch {}
}

function clearPersistedIgnores(leftUrl, rightUrl) {
  try { localStorage.removeItem(ignoreStorageKey(leftUrl, rightUrl)); } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────
function getSelectedResult() {
  return currentResults[selectedResultIndex] ?? null;
}

// ── Config drawer toggle ───────────────────────────────────────────────────
configToggle.addEventListener('click', () => {
  const expanded = configToggle.getAttribute('aria-expanded') === 'true';
  configToggle.setAttribute('aria-expanded', String(!expanded));
  configDrawer.hidden = expanded;
});

// ── View mode ──────────────────────────────────────────────────────────────
function setViewMode(mode) {
  currentViewMode = mode;

  // Update toolbar buttons
  viewSwitcher.querySelectorAll('.view-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === mode);
  });

  // Show/hide columns
  switch (mode) {
    case 'split':
      leftCol.style.display  = '';
      rightCol.style.display = '';
      diffCol.style.display  = 'none';
      break;
    case 'left':
      leftCol.style.display  = '';
      rightCol.style.display = 'none';
      diffCol.style.display  = 'none';
      break;
    case 'right':
      leftCol.style.display  = 'none';
      rightCol.style.display = '';
      diffCol.style.display  = 'none';
      break;
    case 'diff':
      leftCol.style.display  = 'none';
      rightCol.style.display = 'none';
      diffCol.style.display  = '';
      break;
  }

  updateOverlays();
}

viewSwitcher.querySelectorAll('.view-btn').forEach((btn) => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.view));
});

// ── Synchronized scrolling ─────────────────────────────────────────────────
leftScroll.addEventListener('scroll', () => {
  if (isSyncing || currentViewMode !== 'split') return;
  isSyncing = true;
  rightScroll.scrollTop  = leftScroll.scrollTop;
  rightScroll.scrollLeft = leftScroll.scrollLeft;
  isSyncing = false;
});

rightScroll.addEventListener('scroll', () => {
  if (isSyncing || currentViewMode !== 'split') return;
  isSyncing = true;
  leftScroll.scrollTop  = rightScroll.scrollTop;
  leftScroll.scrollLeft = rightScroll.scrollLeft;
  isSyncing = false;
});

// ── Status helpers ─────────────────────────────────────────────────────────
function setStatus(msg, isError = false) {
  statusNode.textContent = msg;
  statusNode.style.color = isError ? '#dc2626' : '';
  statusDetail.textContent = msg;
}

function setChipState(state, label) {
  statusChip.className = `status-chip status-${state}`;
  statusChip.textContent = label;
}

// ── Overlay rendering ──────────────────────────────────────────────────────
/**
 * Render numbered region boxes onto a layer element.
 * @param {HTMLElement} target   - the .region-layer div
 * @param {Array}       regions  - [{x, y, width, height}]
 * @param {number}      scale    - clientWidth / naturalWidth
 * @param {number}      activeIdx
 */
function renderRegionLayer(target, regions, scale, activeIdx) {
  target.innerHTML = '';

  regions.forEach((region, i) => {
    if (ignoredRegions.has(i)) return;

    const box = document.createElement('div');
    box.className = 'region-box' + (i === activeIdx ? ' active' : '');
    box.dataset.index = String(i);
    box.style.left   = `${region.x * scale}px`;
    box.style.top    = `${region.y * scale}px`;
    box.style.width  = `${region.width * scale}px`;
    box.style.height = `${region.height * scale}px`;

    const num = document.createElement('span');
    num.className = 'region-num';
    num.textContent = String(i + 1);
    box.appendChild(num);

    target.appendChild(box);
  });
}

/**
 * Update overlays based on current result and view mode.
 */
function updateOverlays() {
  const result = getSelectedResult();
  leftOverlay.innerHTML  = '';
  rightOverlay.innerHTML = '';

  if (!result) return;

  const mode = result.mode;
  const diffRegions = result.artifacts?.diffRegions ?? [];

  // Screenshot mode — use pixel diff regions
  if (mode === 'screenshot' || diffRegions.length > 0) {
    if (currentViewMode !== 'diff') {
      if (leftImage.naturalWidth && currentViewMode !== 'right') {
        const scale = leftImage.clientWidth / leftImage.naturalWidth;
        renderRegionLayer(leftOverlay, diffRegions, scale, activeRegionIndex);
      }
      if (rightImage.naturalWidth && currentViewMode !== 'left') {
        const scale = rightImage.clientWidth / rightImage.naturalWidth;
        renderRegionLayer(rightOverlay, diffRegions, scale, activeRegionIndex);
      }
    }
    return;
  }

  // DOM mode — fall back to mismatch rects
  const mismatches = result.mismatches ?? [];
  if (mismatches.length === 0) return;

  if (leftImage.naturalWidth && currentViewMode !== 'right') {
    const scale = leftImage.clientWidth / leftImage.naturalWidth;
    const regions = mismatches.map((m) => m.left?.rect).filter(Boolean);
    renderRegionLayer(leftOverlay, regions, scale, activeRegionIndex);
  }

  if (rightImage.naturalWidth && currentViewMode !== 'left') {
    const scale = rightImage.clientWidth / rightImage.naturalWidth;
    const regions = mismatches.map((m) => m.right?.rect).filter(Boolean);
    renderRegionLayer(rightOverlay, regions, scale, activeRegionIndex);
  }
}

// ── Scroll to region ───────────────────────────────────────────────────────
function scrollToRegion(index) {
  const result = getSelectedResult();
  if (!result) return;

  activeRegionIndex = index;

  // Update sidebar card active state
  findingsList.querySelectorAll('.region-card').forEach((card) => {
    card.classList.toggle('active', Number(card.dataset.index) === index);
  });

  updateOverlays();

  // Determine the y position in the image
  const diffRegions = result.artifacts?.diffRegions ?? [];
  const mismatches  = result.mismatches ?? [];

  let region = null;
  if (diffRegions.length > 0) {
    region = diffRegions[index];
  } else if (mismatches.length > 0) {
    region = mismatches[index]?.left?.rect;
  }

  if (!region) return;

  // Scroll both panels to bring the region into view
  const scrollInPanel = (scrollEl, imageEl) => {
    if (!imageEl.naturalWidth) return;
    const scale = imageEl.clientWidth / imageEl.naturalWidth;
    const targetY = region.y * scale;
    const panelH  = scrollEl.clientHeight;
    scrollEl.scrollTo({ top: Math.max(0, targetY - panelH / 3), behavior: 'smooth' });
  };

  scrollInPanel(leftScroll, leftImage);
  scrollInPanel(rightScroll, rightImage);
}

function focusDomMismatch(index) {
  scrollToRegion(index);
}

// ── Ignore / restore regions ───────────────────────────────────────────────
function toggleIgnoreRegion(index) {
  if (ignoredRegions.has(index)) {
    ignoredRegions.delete(index);
  } else {
    ignoredRegions.add(index);
    if (activeRegionIndex === index) activeRegionIndex = -1;
  }
  const result = getSelectedResult();
  if (result) {
    const regions = result.artifacts?.diffRegions ?? result.mismatches ?? [];
    savePersistedIgnores(result.left?.url ?? '', result.right?.url ?? '', regions);
  }
  updateOverlays();
  renderSidebar(result);
}

function resetIgnored() {
  ignoredRegions.clear();
  const result = getSelectedResult();
  if (result) clearPersistedIgnores(result.left?.url ?? '', result.right?.url ?? '');
  updateOverlays();
  renderSidebar(result);
}

resetIgnoreBtn.addEventListener('click', resetIgnored);

// ── Region analysis helpers ────────────────────────────────────────────────
function describeRegion(region, totalW, totalH) {
  const area    = region.width * region.height;
  const density = area > 0 ? region.pixelCount / area : 0;
  const aspect  = region.height > 0 ? region.width / region.height : 1;

  let changeType;
  if (density > 0.65) {
    if (aspect > 6)        changeType = 'Full-width band replaced';
    else if (aspect > 2.5) changeType = 'Wide element replaced';
    else                   changeType = 'Block content replaced';
  } else if (density > 0.25) {
    if (aspect > 6)        changeType = 'Horizontal content shifted';
    else if (aspect < 0.3) changeType = 'Vertical element changed';
    else                   changeType = 'Partial content change';
  } else if (density > 0.05) {
    if (aspect > 8)        changeType = 'Text or border changed';
    else                   changeType = 'Style or color change';
  } else {
    changeType = 'Subtle pixel difference';
  }

  const densityPct = Math.round(density * 100);
  return { changeType, densityPct };
}

function buildRegionThumbs(region, leftUrl, rightUrl, totalW, totalH) {
  if (!leftUrl || !rightUrl || !totalW || !totalH) return '';

  const THUMB_W = 118;
  const THUMB_H = 68;
  const PAD     = 24;

  const rx = Math.max(0, region.x - PAD);
  const ry = Math.max(0, region.y - PAD);
  const rw = Math.min(region.width  + PAD * 2, totalW - rx);
  const rh = Math.min(region.height + PAD * 2, totalH - ry);

  const scale   = Math.min(THUMB_W / rw, THUMB_H / rh);
  const bgW     = Math.round(totalW * scale);
  const bgH     = Math.round(totalH * scale);
  const bgX     = Math.round(-rx * scale);
  const bgY     = Math.round(-ry * scale);
  const actualW = Math.round(rw * scale);
  const actualH = Math.round(rh * scale);

  const thumbStyle = (url) =>
    `width:${actualW}px;height:${actualH}px;` +
    `background-image:url('${url}');` +
    `background-size:${bgW}px ${bgH}px;` +
    `background-position:${bgX}px ${bgY}px;` +
    `background-repeat:no-repeat;`;

  return `
    <div class="region-thumbs">
      <div class="region-thumb-wrap">
        <span class="region-thumb-label baseline-label">Before</span>
        <div class="region-thumb baseline-thumb" style="${thumbStyle(leftUrl)}"></div>
      </div>
      <div class="region-thumb-arrow">→</div>
      <div class="region-thumb-wrap">
        <span class="region-thumb-label checkpoint-label">After</span>
        <div class="region-thumb checkpoint-thumb" style="${thumbStyle(rightUrl)}"></div>
      </div>
    </div>`;
}

// ── Sidebar rendering ──────────────────────────────────────────────────────
function renderSidebar(result) {
  findingsList.innerHTML = '';

  if (!result) {
    sidebarBadge.textContent = '—';
    sidebarBadge.classList.remove('has-diffs');
    findingsList.innerHTML = '<li class="empty-hint">Run a comparison to see results here.</li>';
    return;
  }

  const diffRegions = result.artifacts?.diffRegions ?? [];
  const mismatches  = result.mismatches ?? [];

  // Prefer pixel diff regions
  if (diffRegions.length > 0) {
    const activeCount = diffRegions.length - ignoredRegions.size;
    sidebarBadge.textContent = String(activeCount);
    sidebarBadge.classList.toggle('has-diffs', activeCount > 0);
    resetIgnoreBtn.hidden = ignoredRegions.size === 0;

    const totalW      = result.artifacts?.width  ?? 0;
    const totalH      = result.artifacts?.height ?? 0;
    const leftImgUrl  = result.artifacts?.leftImage  ?? '';
    const rightImgUrl = result.artifacts?.rightImage ?? '';

    diffRegions.forEach((region, i) => {
      const ignored = ignoredRegions.has(i);
      const { changeType, densityPct } = describeRegion(region, totalW, totalH);
      const thumbsHtml = buildRegionThumbs(region, leftImgUrl, rightImgUrl, totalW, totalH);

      const li = document.createElement('li');
      li.className = 'region-card' + (ignored ? ' ignored' : '');
      li.dataset.index = String(i);
      li.innerHTML = `
        <div class="region-card-header">
          <span class="region-card-num">${i + 1}</span>
          <span class="region-card-title">${changeType}</span>
          <button class="ignore-btn" type="button" data-index="${i}" title="${ignored ? 'Restore this region' : 'Ignore this region'}">
            ${ignored ? 'Restore' : 'Ignore'}
          </button>
        </div>
        <div class="region-card-meta">${region.width} × ${region.height} at (${region.x}, ${region.y}) · ${region.pixelCount.toLocaleString()} px</div>
        <div class="density-bar" title="${densityPct}% of area changed">
          <div class="density-fill" style="width:${densityPct}%"></div>
        </div>
        ${thumbsHtml}
      `;
      li.querySelector('.region-card-header').addEventListener('click', (e) => {
        if (!e.target.classList.contains('ignore-btn')) scrollToRegion(i);
      });
      li.querySelector('.ignore-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleIgnoreRegion(i);
      });
      findingsList.appendChild(li);
    });
    return;
  }

  // DOM mode mismatches
  if (mismatches.length > 0) {
    const activeCount = mismatches.length - ignoredRegions.size;
    sidebarBadge.textContent = String(activeCount);
    sidebarBadge.classList.toggle('has-diffs', activeCount > 0);
    resetIgnoreBtn.hidden = ignoredRegions.size === 0;

    mismatches.forEach((mismatch, i) => {
      const ignored = ignoredRegions.has(i);
      const li = document.createElement('li');
      li.className = 'region-card' + (ignored ? ' ignored' : '');
      li.dataset.index = String(i);

      const reasons = (mismatch.reasons ?? []).join(', ');
      const suggestions = (mismatch.suggestions ?? [])
        .map((s) => `<li>${s}</li>`)
        .join('');

      li.innerHTML = `
        <div class="region-card-header">
          <span class="region-card-num">${i + 1}</span>
          <span class="region-card-title">${mismatch.label || 'Element'}</span>
          <button class="ignore-btn" type="button" data-index="${i}" title="${ignored ? 'Restore' : 'Ignore'}">
            ${ignored ? 'Restore' : 'Ignore'}
          </button>
        </div>
        ${reasons ? `<div class="region-card-reasons">${reasons}</div>` : ''}
        ${suggestions ? `<ul class="region-card-suggestions">${suggestions}</ul>` : ''}
      `;
      li.querySelector('.region-card-header').addEventListener('click', (e) => {
        if (!e.target.classList.contains('ignore-btn')) focusDomMismatch(i);
      });
      li.querySelector('.ignore-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleIgnoreRegion(i);
      });
      findingsList.appendChild(li);
    });
    return;
  }

  // No diffs
  resetIgnoreBtn.hidden = true;
  sidebarBadge.textContent = '0';
  sidebarBadge.classList.remove('has-diffs');
  findingsList.innerHTML = '<li class="empty-hint">No differences found — looks good!</li>';
}

// ── Viewport tabs (session list) ───────────────────────────────────────────
function renderSessionList() {
  sessionList.innerHTML = '';

  if (currentResults.length <= 1) {
    sessionList.style.display = 'none';
    return;
  }

  sessionList.style.display = 'flex';
  sessionList.style.flexDirection = 'column';
  sessionList.style.gap = '6px';

  currentResults.forEach((result, index) => {
    const diffRegions = result.artifacts?.diffRegions ?? [];
    const mismatches  = result.mismatches ?? [];
    const count = diffRegions.length > 0 ? diffRegions.length : mismatches.length;
    const countLabel = result.mode === 'screenshot'
      ? `${diffRegions.length} regions`
      : `${count} issues`;

    const li = document.createElement('li');
    li.style.listStyle = 'none';
    const btn = document.createElement('button');
    btn.className = 'viewport-tab-btn' + (index === selectedResultIndex ? ' active' : '');
    btn.dataset.index = String(index);
    btn.innerHTML = `
      <span>${result.viewportSize.label} (${result.viewportSize.width}×${result.viewportSize.height})</span>
      <span class="vp-label">${countLabel}</span>
    `;
    btn.addEventListener('click', () => applySelectedResult(index));
    li.appendChild(btn);
    sessionList.appendChild(li);
  });
}

// ── Warnings ───────────────────────────────────────────────────────────────
function renderWarnings(warnings = []) {
  warningsList.innerHTML = '';
  for (const warning of warnings) {
    const li = document.createElement('li');
    li.textContent = warning;
    warningsList.appendChild(li);
  }
}

// ── Apply selected result ──────────────────────────────────────────────────
function applySelectedResult(index) {
  const result = currentResults[index];
  if (!result) return;

  selectedResultIndex = index;
  currentSessionId    = result.sessionId;
  activeRegionIndex   = -1;

  // Reload persisted ignores for this URL pair + region set
  const allRegions = result.artifacts?.diffRegions ?? result.mismatches ?? [];
  ignoredRegions = loadPersistedIgnores(result.left?.url ?? '', result.right?.url ?? '', allRegions);

  // Update viewport select to match
  ensureViewportOption(result.viewport,
    `${result.viewportSize.label} (${result.viewportSize.width} x ${result.viewportSize.height})`);
  viewportSelect.value = result.viewport;

  // URL labels
  leftUrlLabel.textContent  = result.left?.url  ?? '';
  rightUrlLabel.textContent = result.right?.url ?? '';

  // Column meta
  const leftIssues  = result.left?.issues  ?? [];
  const rightIssues = result.right?.issues ?? [];
  leftMeta.textContent  = leftIssues.length  ? leftIssues.join(', ')  : '';
  rightMeta.textContent = rightIssues.length ? rightIssues.join(', ') : '';

  // Images
  const hasArtifacts = Boolean(result.artifacts);

  if (hasArtifacts) {
    leftImage.style.display  = 'block';
    rightImage.style.display = 'block';
    leftImage.src  = `${result.artifacts.leftImage}?v=${result.sessionId}`;
    rightImage.src = `${result.artifacts.rightImage}?v=${result.sessionId}`;
    // placeholders hidden by the image load handlers below
  } else {
    leftImage.style.display  = 'none';
    rightImage.style.display = 'none';
    leftImage.removeAttribute('src');
    rightImage.removeAttribute('src');
    leftPlaceholder.style.display  = '';
    rightPlaceholder.style.display = '';
  }

  // Diff image
  if (hasArtifacts && result.artifacts.diffImage) {
    diffImage.src = `${result.artifacts.diffImage}?v=${result.sessionId}`;
    diffImage.style.display  = 'block';
    diffPlaceholder.style.display = 'none';
    const px = result.artifacts.mismatchPixels?.toLocaleString() ?? '?';
    const pct = result.artifacts.mismatchPercent ?? '?';
    artifactSummary.textContent = `${px} differing pixels (${pct}% of ${result.artifacts.width}×${result.artifacts.height})`;
  } else {
    diffImage.removeAttribute('src');
    diffImage.style.display  = 'none';
    diffPlaceholder.style.display = '';
    artifactSummary.textContent = '';
  }

  // Status chip
  const diffRegions = result.artifacts?.diffRegions ?? [];
  const mismatches  = result.mismatches ?? [];
  const hasDiffs    = diffRegions.length > 0 || mismatches.length > 0;

  if (hasDiffs) {
    const n = diffRegions.length > 0 ? diffRegions.length : mismatches.length;
    setChipState('fail', `${n} difference${n !== 1 ? 's' : ''}`);
    setStatus(`${n} difference${n !== 1 ? 's' : ''} found at ${result.viewportSize.width}×${result.viewportSize.height}`);
  } else {
    setChipState('pass', 'Pass');
    setStatus(`No differences at ${result.viewportSize.width}×${result.viewportSize.height}`);
  }

  // Live button
  const hasBotProtection = (result.warnings ?? []).some((w) => w.includes('bot protection detected'));
  openLiveButton.disabled = result.mode !== 'dom' || hasBotProtection;

  renderSessionList();
  renderWarnings(result.warnings ?? []);
  renderSidebar(result);
  updateOverlays();

  // Auto-scroll to first region
  if (activeRegionIndex === -1 && (diffRegions.length > 0 || mismatches.length > 0)) {
    setTimeout(() => scrollToRegion(0), 100);
  }
}

// ── Viewport select helpers ────────────────────────────────────────────────
function ensureViewportOption(value, label) {
  const existing = Array.from(viewportSelect.options).find((o) => o.value === value);
  if (existing) { existing.textContent = label; return; }
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  viewportSelect.appendChild(option);
}

// ── Handle compare ─────────────────────────────────────────────────────────
async function handleCompare(event) {
  event.preventDefault();

  // Reset state (ignoredRegions reloaded from storage in applySelectedResult)
  currentResults      = [];
  selectedResultIndex = -1;
  activeRegionIndex   = -1;
  currentSessionId    = null;

  leftImage.removeAttribute('src');
  rightImage.removeAttribute('src');
  diffImage.removeAttribute('src');
  leftImage.style.display  = 'none';
  rightImage.style.display = 'none';
  diffImage.style.display  = 'none';
  leftPlaceholder.style.display  = '';
  rightPlaceholder.style.display = '';
  leftOverlay.innerHTML  = '';
  rightOverlay.innerHTML = '';
  findingsList.innerHTML = '';
  warningsList.innerHTML = '';
  sessionList.innerHTML  = '';
  sessionList.style.display = 'none';
  sidebarBadge.textContent = '—';
  sidebarBadge.classList.remove('has-diffs');
  resetIgnoreBtn.hidden = true;
  openLiveButton.disabled = true;

  setChipState('running', 'Running…');
  setStatus('Running viewport comparison…');

  try {
    const formData = new FormData(form);
    const payload  = Object.fromEntries(formData.entries());

    // Collect checked batch viewports
    const checkedViewports = Array.from(
      viewportOptions.querySelectorAll('input[name="viewports"]:checked'),
      (input) => input.value
    );
    payload.viewports = checkedViewports.length > 0 ? checkedViewports : [viewportSelect.value];

    if (!payload.customWidth)  delete payload.customWidth;
    if (!payload.customHeight) delete payload.customHeight;
    if (!payload.customLabel)  delete payload.customLabel;
    if (!loginComparisonToggle.checked || !payload.storageStatePath) {
      delete payload.storageStatePath;
    }

    const response = await fetch('/api/compare/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Comparison failed.');
    }

    currentResults = Array.isArray(result.results) ? result.results : [];
    if (currentResults.length === 0) {
      throw new Error('No results returned from the server.');
    }

    applySelectedResult(0);
  } catch (error) {
    setChipState('idle', 'Error');
    setStatus(error.message || 'Comparison failed.', true);
    findingsList.innerHTML = '<li class="empty-hint">Comparison failed. Check the URLs and try again.</li>';
  }
}

// ── Live inspection ────────────────────────────────────────────────────────
async function handleLiveOpen() {
  if (!currentSessionId) return;
  setStatus('Opening live browser windows…');

  try {
    const response = await fetch(`/api/open-live/${currentSessionId}`, { method: 'POST' });
    const result   = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Unable to open live inspection.');
    }
    setStatus(result.message);
  } catch (error) {
    setStatus(error.message || 'Unable to open live inspection.', true);
  }
}

// ── Login capture ──────────────────────────────────────────────────────────
function setCaptureStatus(message, isError = false) {
  captureStatusNode.textContent = message;
  captureStatusNode.style.color = isError ? '#dc2626' : '';
}

function syncCaptureButtons() {
  const active = Boolean(activeCaptureId);
  startLeftCaptureButton.disabled  = active;
  startRightCaptureButton.disabled = active;
  saveCaptureButton.disabled       = !active;
  cancelCaptureButton.disabled     = !active;
}

function syncLoginComparisonUi() {
  capturePanel.style.display = loginComparisonToggle.checked ? 'block' : 'none';
  if (!loginComparisonToggle.checked && !activeCaptureId) {
    captureStatusNode.textContent = 'No capture in progress.';
  }
}

async function handleStartCapture(loginUrl) {
  setCaptureStatus('Opening a login browser…');
  try {
    const sessionName = captureSessionNameInput.value || 'pixcel-login';
    const response    = await fetch('/api/storage-state/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginUrl, sessionName })
    });
    const result = await response.json();

    if (!response.ok) throw new Error(result.error || 'Unable to start login capture.');

    activeCaptureId = result.captureId;
    syncCaptureButtons();
    storageStatePathInput.value = result.outputPath;
    setCaptureStatus(result.message);
  } catch (error) {
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus(error.message || 'Unable to start login capture.', true);
  }
}

async function handleSaveCapture() {
  if (!activeCaptureId) return;
  setCaptureStatus('Saving storage state…');
  try {
    const response = await fetch(`/api/storage-state/complete/${activeCaptureId}`, { method: 'POST' });
    const result   = await response.json();

    if (!response.ok) throw new Error(result.error || 'Unable to save login session.');

    storageStatePathInput.value = result.outputPath;
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus(result.message);
  } catch (error) {
    setCaptureStatus(error.message || 'Unable to save login session.', true);
  }
}

async function handleCancelCapture() {
  if (!activeCaptureId) return;
  try {
    await fetch(`/api/storage-state/cancel/${activeCaptureId}`, { method: 'POST' });
  } finally {
    activeCaptureId = null;
    syncCaptureButtons();
    setCaptureStatus('No capture in progress.');
  }
}

// ── Load viewports & modes ─────────────────────────────────────────────────
async function loadViewports() {
  const response  = await fetch('/api/viewports');
  const viewports = await response.json();

  Object.entries(viewports).forEach(([value, vp]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = `${vp.label} (${vp.width} x ${vp.height})`;
    viewportSelect.appendChild(option);

    const label = document.createElement('label');
    label.innerHTML = `
      <input type="checkbox" name="viewports" value="${value}" ${value === 'desktop' ? 'checked' : ''} />
      <span>${vp.label}</span>
      <small>${vp.width} × ${vp.height}</small>
    `;
    viewportOptions.appendChild(label);
  });

  viewportSelect.value = 'desktop';
}

async function loadModes() {
  const response = await fetch('/api/modes');
  const modes    = await response.json();

  Object.entries(modes).forEach(([value, mode]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = mode.label;
    modeSelect.appendChild(option);
  });

  modeSelect.value = 'dom';
}

// ── Event wiring ───────────────────────────────────────────────────────────
form.addEventListener('submit', handleCompare);
openLiveButton.addEventListener('click', handleLiveOpen);

startLeftCaptureButton.addEventListener('click',  () => handleStartCapture(leftUrlInput.value));
startRightCaptureButton.addEventListener('click', () => handleStartCapture(rightUrlInput.value));
saveCaptureButton.addEventListener('click',   handleSaveCapture);
cancelCaptureButton.addEventListener('click', handleCancelCapture);
loginComparisonToggle.addEventListener('change', syncLoginComparisonUi);

modeSelect.addEventListener('change', () => {
  openLiveButton.disabled = true;
});

viewportSelect.addEventListener('change', () => {
  const idx = currentResults.findIndex((r) => r.viewport === viewportSelect.value);
  if (idx >= 0) applySelectedResult(idx);
});

// Image load/error
leftImage.addEventListener('load', () => {
  leftPlaceholder.style.display = 'none';
  updateOverlays();
});
rightImage.addEventListener('load', () => {
  rightPlaceholder.style.display = 'none';
  updateOverlays();
});
leftImage.addEventListener('error', () => {
  leftPlaceholder.textContent = 'Baseline image could not be loaded.';
  leftPlaceholder.style.display = '';
});
rightImage.addEventListener('error', () => {
  rightPlaceholder.textContent = 'Checkpoint image could not be loaded.';
  rightPlaceholder.style.display = '';
});

// Debounced resize
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateOverlays, 120);
});

// ── Boot ───────────────────────────────────────────────────────────────────
Promise.all([loadViewports(), loadModes()]).catch((error) => {
  setStatus(error.message || 'Unable to load tool presets.', true);
});

syncCaptureButtons();
syncLoginComparisonUi();
