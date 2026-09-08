/**
 * MonLogistics - Warehouse Pallet & Shelf Manager (MVP)
 * Core Logic: LocalStorage Data Store, QR Code Generation, Scanning & Link Engine
 */

// Application State
const STATE_KEY = 'monlog_pallets_v1';
let pallets = [];
let activePalletForLabel = null;

// Scanner Step State
let scanStepPallet = null; // Object { id, customer }
let scanStepShelf = null;  // String e.g. "Α-14"
let mediaStream = null;
let scanRafId = null;
let scanIntervalId = null;
let barcodeDetectorInstance = null;
let isCameraActive = false;
let isCameraToggling = false;
let cameraScanPauseUntil = 0;
let shelfGridTimeouts = [];
let shelfGridGeneration = 0;
let inventoryDelegatedBound = false;
let shelfTagDelegatedBound = false;

// Firebase / sync state
let cloudEnabled = false;
let db = null;
let firestoreUnsub = null;
let applyingRemoteSnapshot = false;
let firebaseFallbackToastShown = false;

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  loadPalletsFromStorage();
  const usingCloud = initFirebaseSync();

  // Initialize Lucide Icons if available
  if (window.lucide) {
    lucide.createIcons();
  }

  // Pre-fill initial form auto ID
  generateAutoPalletId();

  // Render initial table & statistics (cloud snapshot may refresh again)
  renderInventoryTable();
  updateStats();
  populateSimulators();
  generateShelfGrid();

  // Delegated inventory table actions (avoid inline onclick XSS)
  bindInventoryTableActions();
  bindShelfTagPrintActions();
  bindScanFileFallback();

  // Seed only in local mode when empty (cloud is shared source of truth)
  if (!usingCloud && pallets.length === 0) {
    seedSampleData(false);
  }
});

/* ==========================================================================
   STORAGE ENGINE (localStorage + optional Firestore realtime)
   ========================================================================== */
function isFirebaseConfigReady(cfg) {
  return !!(cfg && typeof cfg.apiKey === "string" && cfg.apiKey.trim() &&
    typeof cfg.projectId === "string" && cfg.projectId.trim());
}

function setSyncStatus(state) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.classList.remove("sync-online", "sync-local", "sync-error", "sync-connecting");
  const map = {
    online: { text: "Cloud: συνδεδεμένο", cls: "sync-online" },
    local: { text: "Τοπικά", cls: "sync-local" },
    error: { text: "Σφάλμα", cls: "sync-error" },
    connecting: { text: "Cloud: σύνδεση…", cls: "sync-connecting" }
  };
  const m = map[state] || map.local;
  el.textContent = m.text;
  el.classList.add(m.cls);
}

function toastFirebaseFallback(msg) {
  if (firebaseFallbackToastShown) return;
  firebaseFallbackToastShown = true;
  try { showToast(msg || "Firebase μη διαθέσιμο — τοπική λειτουργία.", "error"); } catch (_) {}
}

function palletToFirestoreDoc(p) {
  return {
    customer: p.customer || "",
    shelf: (p.shelf === undefined || p.shelf === "") ? null : p.shelf,
    createdAt: p.createdAt || new Date().toISOString(),
    pairedAt: p.pairedAt == null ? null : p.pairedAt,
    updatedAt: new Date().toISOString()
  };
}

function sortPalletsByCreatedDesc(list) {
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return list;
}

function mirrorPalletsToLocalCache() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(pallets));
  } catch (e) {
    console.error("Failed to mirror pallets to localStorage:", e);
  }
}

function loadPalletsFromStorage() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        pallets = sortPalletsByCreatedDesc(parsed);
      } else {
        console.warn("Invalid pallets storage shape; resetting to []");
        pallets = [];
        localStorage.removeItem(STATE_KEY);
      }
    } else {
      pallets = [];
    }
  } catch (e) {
    console.error("Failed to load local storage data:", e);
    pallets = [];
  }
}

function subscribePallets() {
  if (!db) return;
  setSyncStatus("connecting");
  if (typeof firestoreUnsub === "function") {
    try { firestoreUnsub(); } catch (_) {}
    firestoreUnsub = null;
  }
  firestoreUnsub = db.collection("pallets").onSnapshot((snap) => {
    applyingRemoteSnapshot = true;
    const next = [];
    snap.forEach((d) => {
      next.push({ id: d.id, ...d.data() });
    });
    pallets = sortPalletsByCreatedDesc(next);
    mirrorPalletsToLocalCache();
    renderInventoryTable();
    updateStats();
    populateSimulators();
    setSyncStatus("online");
    applyingRemoteSnapshot = false;
  }, (err) => {
    console.error("Firestore onSnapshot error:", err);
    setSyncStatus("error");
    toastFirebaseFallback("Σφάλμα συγχρονισμού Firebase — τοπική λειτουργία.");
    cloudEnabled = false;
  });
}

function initFirebaseSync() {
  try {
    const cfg = window.MONLOG_FIREBASE_CONFIG;
    if (!isFirebaseConfigReady(cfg)) {
      cloudEnabled = false;
      setSyncStatus("local");
      return false;
    }
    if (typeof firebase === "undefined" || !firebase.initializeApp || !firebase.firestore) {
      cloudEnabled = false;
      setSyncStatus("error");
      toastFirebaseFallback("Λείπουν τα scripts Firebase — τοπική λειτουργία.");
      return false;
    }
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(cfg);
    }
    db = firebase.firestore();
    cloudEnabled = true;
    subscribePallets();
    return true;
  } catch (e) {
    console.error("Firebase init failed:", e);
    cloudEnabled = false;
    db = null;
    setSyncStatus("error");
    toastFirebaseFallback("Αποτυχία αρχικοποίησης Firebase — τοπική λειτουργία.");
    return false;
  }
}

function upsertPalletsToCloud(ids) {
  if (!cloudEnabled || !db || applyingRemoteSnapshot) return;
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  unique.forEach((id) => {
    const p = pallets.find((x) => x.id === id);
    if (!p) return;
    db.collection("pallets").doc(id).set(palletToFirestoreDoc(p), { merge: true }).catch((err) => {
      console.error("Firestore set failed:", id, err);
      setSyncStatus("error");
    });
  });
}

function deletePalletsFromCloud(ids) {
  if (!cloudEnabled || !db || applyingRemoteSnapshot) return;
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  unique.forEach((id) => {
    db.collection("pallets").doc(id).delete().catch((err) => {
      console.error("Firestore delete failed:", id, err);
      setSyncStatus("error");
    });
  });
}

/**
 * Persist pallets. options: { upsertIds?: string[], deleteIds?: string[] }
 * Always mirrors to localStorage. When cloud enabled, upserts/deletes changed docs.
 */
function savePalletsToStorage(options) {
  const opts = options || {};
  mirrorPalletsToLocalCache();

  if (cloudEnabled && db && !applyingRemoteSnapshot) {
    const hasDelete = Array.isArray(opts.deleteIds);
    const hasUpsert = Array.isArray(opts.upsertIds);
    if (hasDelete && opts.deleteIds.length) {
      deletePalletsFromCloud(opts.deleteIds);
    }
    if (hasUpsert) {
      upsertPalletsToCloud(opts.upsertIds);
    } else if (!hasDelete) {
      // Neither specified: upsert all (legacy / bulk)
      upsertPalletsToCloud(pallets.map((p) => p.id));
    }
  }

  updateStats();
  populateSimulators();
}

function updateStats() {
  const total = pallets.length;
  const assigned = pallets.filter(p => p.shelf !== null && p.shelf !== "").length;
  const unassigned = total - assigned;

  const elTotal = document.getElementById("statTotalPallets");
  const elAssigned = document.getElementById("statAssignedPallets");
  const elUnassigned = document.getElementById("statUnassignedPallets");
  if (elTotal) elTotal.innerText = total;
  if (elAssigned) elAssigned.innerText = assigned;
  if (elUnassigned) elUnassigned.innerText = unassigned;
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */
function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(tabId);
  if (targetTab) {
    targetTab.classList.add('active');
  }

  const activeBtn = Array.from(document.querySelectorAll('.nav-tab')).find(btn => 
    btn.getAttribute('onclick') && btn.getAttribute('onclick').includes(tabId)
  );
  if (activeBtn) {
    activeBtn.classList.add('active');
  }

  // Re-create icons for freshly visible tab elements
  if (window.lucide) {
    lucide.createIcons();
  }
}

/* ==========================================================================
   TAB 1: PALLET QR GENERATION & PRINT LABEL
   ========================================================================== */
function generateAutoPalletId() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  document.getElementById('palletId').value = `PL-${randomNum}`;
}

function quickFillPallet(customer, palletId) {
  document.getElementById('customerName').value = customer;
  document.getElementById('palletId').value = palletId;
  showToast(`Επιλέχθηκαν στοιχεία: ${customer}`, 'success');
}

function handleCreatePallet(e) {
  e.preventDefault();
  const customerInput = document.getElementById('customerName').value.trim();
  const palletIdInput = document.getElementById('palletId').value.trim().toUpperCase();

  if (!customerInput || !palletIdInput) {
    showToast('Παρακαλώ συμπληρώστε όλα τα πεδία!', 'error');
    return;
  }

  // Check if pallet ID exists
  let existingIndex = pallets.findIndex(p => p.id === palletIdInput);
  let palletObj;

  if (existingIndex >= 0) {
    // Update existing
    pallets[existingIndex].customer = customerInput;
    palletObj = pallets[existingIndex];
    showToast(`Ενημερώθηκε η υπάρχουσα παλέτα ${palletIdInput}`, 'success');
  } else {
    // Create new
    palletObj = {
      id: palletIdInput,
      customer: customerInput,
      shelf: null,
      createdAt: new Date().toISOString(),
      pairedAt: null
    };
    pallets.unshift(palletObj);
    showToast(`Δημιουργήθηκε επιτυχώς η παλέτα ${palletIdInput}`, 'success');
  }

  savePalletsToStorage({ upsertIds: [palletIdInput] });
  renderInventoryTable();
  activePalletForLabel = palletObj;

  // Render label (QR must never block create/update success)
  try {
    renderPalletLabel(palletObj);
  } catch (err) {
    console.error('Pallet label render failed:', err);
    showToast('Η παλέτα αποθηκεύτηκε, αλλά η ετικέτα QR απέτυχε. Δοκιμάστε ξανά την εκτύπωση.', 'error');
  }

  // Prepare next auto ID for next creation
  generateAutoPalletId();
}

function renderPalletLabel(pallet) {
  document.getElementById('previewCustomer').innerText = pallet.customer;
  document.getElementById('previewPalletId').innerText = pallet.id;

  const dateFormatted = new Date(pallet.createdAt || Date.now()).toLocaleDateString('el-GR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  document.getElementById('previewDate').innerText = `Ημ/νία: ${dateFormatted}`;

  const qrContainer = document.getElementById('qrcodeCanvas');
  // Compact payload — never embed long customer names (causes QR code length overflow)
  const payload = `PALLET:${pallet.id}`;
  renderQRCode(qrContainer, payload, 140);
}

function printActiveLabel() {
  if (!activePalletForLabel) {
    showToast('Παρακαλώ δημιουργήστε πρώτα μια ετικέτα!', 'error');
    return;
  }
  const labelElement = document.getElementById('printableLabel').cloneNode(true);
  const printArea = document.getElementById('printArea');
  printArea.innerHTML = '';
  printArea.appendChild(labelElement);
  printArea.style.display = 'flex';
  
  window.print();
  
  setTimeout(() => {
    printArea.style.display = 'none';
    printArea.innerHTML = '';
  }, 1000);
}

function goToLinkWithCurrentPallet() {
  if (!activePalletForLabel) {
    showToast('Δεν έχει επιλεγεί παλέτα.', 'error');
    return;
  }
  simulatePalletScan(activePalletForLabel.id);
  switchTab('tab-link');
}

/* ==========================================================================
   TAB 2: LINK PALLET TO SHELF (SCAN & PAIR ENGINE)
   ========================================================================== */
function populateSimulators() {
  const select = document.getElementById('simPalletSelect');
  if (!select) return;

  select.innerHTML = '<option value="">-- Επιλέξτε Παλέτα --</option>';
  
  pallets.forEach(p => {
    const statusText = p.shelf ? `[Στο Ράφι ${p.shelf}]` : '[Μη τοποθετημένη]';
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.innerText = `${p.id} - ${p.customer} ${statusText}`;
    select.appendChild(opt);
  });
}

function simulatePalletScan(palletId) {
  if (!palletId) {
    scanStepPallet = null;
    updateLinkUI();
    return;
  }

  const p = pallets.find(x => x.id === palletId);
  if (p) {
    scanStepPallet = { id: p.id, customer: p.customer };
    showToast(`👉 Σταδιο 1: Σκαναρίστηκε η παλέτα ${p.id} (${p.customer})`, 'success');
  } else {
    scanStepPallet = { id: palletId, customer: 'Άγνωστος Πελάτης' };
    showToast(`👉 Σταδιο 1: Σκαναρίστηκε ο ακανόνιστος κωδικός ${palletId}`, 'success');
  }
  syncSimPalletSelect(palletId);
  updateLinkUI();
}

function syncSimPalletSelect(palletId) {
  const select = document.getElementById('simPalletSelect');
  if (!select || !palletId) return;
  const exists = Array.from(select.options).some(o => o.value === palletId);
  if (exists) {
    select.value = palletId;
  }
}

function simulateShelfScan(shelfCode) {
  if (!scanStepPallet) {
    showToast('⚠️ Παρακαλώ επιλέξτε/σκανάρετε ΠΡΩΤΑ το QR της Παλέτας (Στάδιο 1)', 'error');
    return;
  }

  scanStepShelf = shelfCode;
  showToast(`👉 Στάδιο 2: Σκαναρίστηκε η θέση ραφιού ${shelfCode}`, 'success');
  updateLinkUI();
}

function updateLinkUI() {
  // Step 1 UI
  const cardPallet = document.getElementById('stepCardPallet');
  const valPallet = document.getElementById('stepValPallet');
  const displayPallet = document.getElementById('statusPalletDisplay');
  const displayCustomer = document.getElementById('statusCustomerDisplay');

  if (scanStepPallet) {
    cardPallet.className = 'step-card completed';
    valPallet.innerHTML = `<span style="color: var(--emerald);">✅ ${escapeHtml(scanStepPallet.id)}</span>`;
    displayPallet.innerText = scanStepPallet.id;
    displayCustomer.innerText = scanStepPallet.customer;
  } else {
    cardPallet.className = 'step-card active';
    valPallet.innerText = 'Εκκρεμεί Σάρωση';
    displayPallet.innerText = 'Δεν έχει επιλεγεί';
    displayCustomer.innerText = '-';
  }

  // Step 2 UI
  const cardShelf = document.getElementById('stepCardShelf');
  const valShelf = document.getElementById('stepValShelf');
  const displayShelf = document.getElementById('statusShelfDisplay');
  const btnConfirm = document.getElementById('btnConfirmPair');

  if (scanStepShelf) {
    cardShelf.className = 'step-card completed';
    valShelf.innerHTML = `<span style="color: var(--emerald);">✅ Ράφι ${escapeHtml(scanStepShelf)}</span>`;
    displayShelf.className = 'badge-shelf';
    displayShelf.innerText = `📍 Θέση ${scanStepShelf}`;
  } else {
    cardShelf.className = scanStepPallet ? 'step-card active' : 'step-card';
    valShelf.innerText = 'Εκκρεμεί Σάρωση';
    displayShelf.className = 'badge-unassigned';
    displayShelf.innerText = '⚠️ Καμία Θέση';
  }

  // Enable Confirm Button if both steps ready
  btnConfirm.disabled = !(scanStepPallet && scanStepShelf);
}

function resetLinkSteps() {
  scanStepPallet = null;
  scanStepShelf = null;
  document.getElementById('simPalletSelect').value = '';
  updateLinkUI();
  showToast('Επαναφορά διαδικασίας σάρωσης.', 'success');
}

function confirmPairing() {
  if (!scanStepPallet || !scanStepShelf) return;

  let p = pallets.find(x => x.id === scanStepPallet.id);
  if (!p) {
    // If not existing, create it
    p = {
      id: scanStepPallet.id,
      customer: scanStepPallet.customer || 'Γενικός Πελάτης',
      shelf: scanStepShelf,
      createdAt: new Date().toISOString(),
      pairedAt: new Date().toISOString()
    };
    pallets.unshift(p);
  } else {
    p.shelf = scanStepShelf;
    p.pairedAt = new Date().toISOString();
  }

  savePalletsToStorage({ upsertIds: [p.id] });
  renderInventoryTable();
  addRecentPair(p.customer, p.id, p.shelf);

  showToast(`🎉 Η παλέτα ${p.id} συνδέθηκε επιτυχώς στη θέση ${p.shelf}!`, 'success');

  // Reset steps for next scanning
  resetLinkSteps();
}

function addRecentPair(customer, palletId, shelf) {
  const container = document.getElementById('recentPairsList');
  if (container.children.length === 1 && container.children[0].innerText.includes('Δεν υπάρχουν')) {
    container.innerHTML = '';
  }

  const timeStr = new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
  const item = document.createElement('div');
  item.style.cssText = `
    background: rgba(30, 41, 59, 0.6);
    border: 1px solid var(--border-color);
    padding: 0.6rem 0.8rem;
    border-radius: var(--radius-sm);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.85rem;
  `;
  item.innerHTML = `
    <div>
      <span style="font-weight: 700; color: var(--text-main);">${escapeHtml(palletId)}</span>
      <span style="color: var(--text-muted); font-size: 0.75rem;"> (${escapeHtml(customer)})</span>
    </div>
    <div style="display: flex; align-items: center; gap: 0.5rem;">
      <span class="badge-shelf" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">📍 ${escapeHtml(shelf)}</span>
      <span style="font-size: 0.7rem; color: var(--text-dim);">${escapeHtml(timeStr)}</span>
    </div>
  `;
  container.prepend(item);

  // Keep max 4 recent
  if (container.children.length > 4) {
    container.removeChild(container.lastChild);
  }
}

/* CAMERA SCANNER ENGINE — getUserMedia + video + BarcodeDetector/jsQR */
async function toggleCameraScanner() {
  if (isCameraToggling) return;
  isCameraToggling = true;

  const container = document.getElementById('cameraScannerContainer');
  const btnText = document.getElementById('btnCamText');

  try {
    if (isCameraActive) {
      await stopCameraScanner();
      if (container) container.hidden = true;
      if (btnText) btnText.innerText = 'Ενεργοποίηση Κάμερας';
      isCameraActive = false;
    } else {
      await startCameraScanner();
    }
  } finally {
    isCameraToggling = false;
  }
}

async function requestCameraStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('getUserMedia not supported');
  }
  const attempts = [
    { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: { facingMode: 'user' } },
    { audio: false, video: true }
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      console.warn('getUserMedia attempt failed:', constraints, err);
    }
  }
  throw lastErr || new Error('Camera unavailable');
}

async function startCameraScanner() {
  const container = document.getElementById('cameraScannerContainer');
  const btnText = document.getElementById('btnCamText');
  const video = document.getElementById('scanVideo');

  if (!container || !video) {
    showToast('Σφάλμα UI κάμερας.', 'error');
    return;
  }

  // Unhide FIRST so the viewport is visible while permission prompt appears
  container.hidden = false;
  if (btnText) btnText.innerText = 'Άνοιγμα κάμερας…';

  try {
    // Stop any previous stream/loop cleanly
    await stopCameraScanner(false);

    container.hidden = false;
    const stream = await requestCameraStream();
    mediaStream = stream;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;

    try {
      await video.play();
    } catch (playErr) {
      console.warn('video.play() error (may still work):', playErr);
    }

    isCameraActive = true;
    if (btnText) btnText.innerText = 'Απενεργοποίηση Κάμερας';
    startScanLoop();
  } catch (err) {
    console.error('Camera access error:', err);
    await stopCameraScanner(false);
    container.hidden = false; // keep file fallback visible
    isCameraActive = false;
    if (btnText) btnText.innerText = 'Ενεργοποίηση Κάμερας';
    showToast(
      'Αποτυχία ανοίγματος κάμερας. Ελέγξτε τα δικαιώματα (Permissions) και δοκιμάστε «Φωτογραφία / Αρχείο QR».',
      'error'
    );
  }
}

async function stopCameraScanner(updateUi = true) {
  if (scanRafId) {
    cancelAnimationFrame(scanRafId);
    scanRafId = null;
  }
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }

  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach(t => {
        try { t.stop(); } catch (_) {}
      });
    } catch (_) {}
    mediaStream = null;
  }

  const video = document.getElementById('scanVideo');
  if (video) {
    try { video.pause(); } catch (_) {}
    try { video.srcObject = null; } catch (_) {}
  }

  isCameraActive = false;

  if (updateUi) {
    const container = document.getElementById('cameraScannerContainer');
    const btnText = document.getElementById('btnCamText');
    if (container) container.hidden = true;
    if (btnText) btnText.innerText = 'Ενεργοποίηση Κάμερας';
  }
}

function startScanLoop() {
  if (scanRafId) {
    cancelAnimationFrame(scanRafId);
    scanRafId = null;
  }
  if (scanIntervalId) {
    clearInterval(scanIntervalId);
    scanIntervalId = null;
  }

  // Prefer rAF; fall back to interval if needed
  let lastTick = 0;
  const tick = async (ts) => {
    if (!isCameraActive) return;
    if (!ts || ts - lastTick >= 200) {
      lastTick = ts || performance.now();
      try {
        await scanCurrentVideoFrame();
      } catch (e) {
        // Ignore transient decode errors
      }
    }
    if (isCameraActive) {
      scanRafId = requestAnimationFrame(tick);
    }
  };

  if (typeof requestAnimationFrame === 'function') {
    scanRafId = requestAnimationFrame(tick);
  } else {
    scanIntervalId = setInterval(() => {
      if (!isCameraActive) return;
      scanCurrentVideoFrame().catch(() => {});
    }, 200);
  }
}

async function scanCurrentVideoFrame() {
  if (!isCameraActive) return;
  if (Date.now() < cameraScanPauseUntil) return;

  const video = document.getElementById('scanVideo');
  const canvas = document.getElementById('scanCanvas');
  if (!video || !canvas) return;
  if (video.readyState < 2) return;

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, w, h);

  const decoded = await decodeQrFromCanvas(canvas);
  if (decoded) {
    handleCameraDecode(decoded);
  }
}

async function decodeQrFromCanvas(canvas) {
  // Prefer native BarcodeDetector when available (Chrome/Android)
  if (window.BarcodeDetector) {
    try {
      if (!barcodeDetectorInstance) {
        barcodeDetectorInstance = new BarcodeDetector({ formats: ['qr_code'] });
      }
      const codes = await barcodeDetectorInstance.detect(canvas);
      if (codes && codes.length && codes[0].rawValue) {
        return String(codes[0].rawValue);
      }
    } catch (e) {
      // Fall through to jsQR
    }
  }

  if (typeof window.jsQR === 'function') {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert'
      });
      if (result && result.data) return String(result.data);
    } catch (e) {
      console.warn('jsQR decode error:', e);
    }
  }
  return null;
}

function handleCameraDecode(decodedText) {
  const now = Date.now();
  if (now < cameraScanPauseUntil) return;
  cameraScanPauseUntil = now + 2000;
  onQrScanned(decodedText);
}

function bindScanFileFallback() {
  const btn = document.getElementById('btnScanFile');
  const input = document.getElementById('scanFileInput');
  if (!btn || !input || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', () => {
    input.value = '';
    input.click();
  });

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const decoded = await decodeQrFromImageFile(file);
      if (decoded) {
        handleCameraDecode(decoded);
      } else {
        showToast('Δεν βρέθηκε QR στην εικόνα. Δοκιμάστε ξανά με καλύτερο φωτισμό.', 'error');
      }
    } catch (e) {
      console.error('File QR decode failed:', e);
      showToast('Αποτυχία ανάγνωσης εικόνας QR.', 'error');
    }
  });
}

async function decodeQrFromImageFile(file) {
  const bitmapOrImg = await loadImageForDecode(file);
  const canvas = document.getElementById('scanCanvas') || document.createElement('canvas');
  const w = bitmapOrImg.width || bitmapOrImg.naturalWidth;
  const h = bitmapOrImg.height || bitmapOrImg.naturalHeight;
  if (!w || !h) return null;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmapOrImg, 0, 0, w, h);
  if (bitmapOrImg.close) {
    try { bitmapOrImg.close(); } catch (_) {}
  }
  return decodeQrFromCanvas(canvas);
}

function loadImageForDecode(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function onQrScanned(text) {
  console.log('Decoded QR Text:', text);
  let parsedPayload = text;
  
  // Try parsing JSON if structured
  try {
    const json = JSON.parse(text);
    if (json.type === 'PALLET' && json.id) {
      simulatePalletScan(json.id);
      return;
    } else if (json.type === 'SHELF' && json.code) {
      simulateShelfScan(json.code);
      return;
    }
  } catch (e) {
    // Plain text payload parsing
  }

  // Handle plain text like "PL-1001", "PALLET:PL-1001", "A-14", or "SHELF:A-14"
  if (text.startsWith('SHELF:')) {
    const shelf = text.replace('SHELF:', '').trim();
    simulateShelfScan(shelf);
  } else if (text.startsWith('PALLET:')) {
    const palletId = text.replace('PALLET:', '').trim();
    simulatePalletScan(palletId);
  } else if (!scanStepPallet) {
    // If step 1 not done, treat scan as Pallet ID
    simulatePalletScan(text);
  } else {
    // If step 1 done, treat scan as Shelf code
    simulateShelfScan(text);
  }
}

/* ==========================================================================
   TAB 3: INVENTORY TABLE & SEARCH
   ========================================================================== */
function renderInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;

  const searchQuery = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase().trim() : '';
  const filterStatus = document.getElementById('filterStatusSelect') ? document.getElementById('filterStatusSelect').value : 'ALL';

  let filtered = pallets.filter(p => {
    const matchesSearch = p.customer.toLowerCase().includes(searchQuery) ||
                          p.id.toLowerCase().includes(searchQuery) ||
                          (p.shelf && p.shelf.toLowerCase().includes(searchQuery));

    if (!matchesSearch) return false;

    if (filterStatus === 'ASSIGNED') return p.shelf !== null && p.shelf !== '';
    if (filterStatus === 'UNASSIGNED') return !p.shelf;
    return true;
  });

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-dim);">
          <i data-lucide="inbox" style="width: 32px; height: 32px; margin-bottom: 0.5rem; display: block; margin: 0 auto;"></i>
          Δεν βρέθηκαν παλέτες που να ταιριάζουν με τα κριτήρια.
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  filtered.forEach(p => {
    const tr = document.createElement('tr');
    const safeId = escapeHtml(p.id);

    const shelfBadgeHtml = p.shelf ? 
      `<span class="badge-shelf">📍 ${escapeHtml(p.shelf)}</span>` : 
      `<span class="badge-unassigned">⚠️ Εκτός Ραφιού</span>`;

    const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('el-GR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }) : '-';

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(p.customer)}</td>
      <td>
        <span style="font-family: monospace; font-weight: 700; font-size: 0.95rem; background: rgba(99, 102, 241, 0.15); color: #818cf8; padding: 0.2rem 0.5rem; border-radius: 4px;">
          ${safeId}
        </span>
      </td>
      <td>${shelfBadgeHtml}</td>
      <td style="color: var(--text-muted); font-size: 0.85rem;">${dateStr}</td>
      <td style="text-align: right;">
        <div style="display: flex; gap: 0.4rem; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary btn-sm" data-action="print" data-id="${safeId}" title="Εκτύπωση Ετικέτας">
            <i data-lucide="printer" style="width: 14px;"></i>
          </button>
          <button type="button" class="btn btn-primary btn-sm" data-action="pair" data-id="${safeId}" title="Σύνδεση/Αλλαγή Θέσης">
            <i data-lucide="link" style="width: 14px;"></i>
          </button>
          <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${safeId}" title="Διαγραφή">
            <i data-lucide="trash-2" style="width: 14px;"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
}

function filterInventoryTable() {
  renderInventoryTable();
}

function bindInventoryTableActions() {
  if (inventoryDelegatedBound) return;
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;
  inventoryDelegatedBound = true;
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !tbody.contains(btn)) return;
    const action = btn.getAttribute('data-action');
    const palletId = btn.getAttribute('data-id');
    if (!palletId) return;
    if (action === 'print') printRowLabel(palletId);
    else if (action === 'pair') quickPairRow(palletId);
    else if (action === 'delete') deletePalletRow(palletId);
  });
}

function printRowLabel(palletId) {
  const p = pallets.find(x => x.id === palletId);
  if (p) {
    renderPalletLabel(p);
    activePalletForLabel = p;
    switchTab('tab-generate');
    showToast(`Έτοιμη προς εκτύπωση η ετικέτα ${p.id}`, 'success');
  }
}

function quickPairRow(palletId) {
  simulatePalletScan(palletId);
  switchTab('tab-link');
}

function deletePalletRow(palletId) {
  if (confirm(`Είστε σίγουροι ότι θέλετε να διαγράψετε την παλέτα ${palletId};`)) {
    pallets = pallets.filter(x => x.id !== palletId);
    savePalletsToStorage({ deleteIds: [palletId] });
    renderInventoryTable();
    showToast(`Διαγράφηκε η παλέτα ${palletId}`, 'success');
  }
}

/* ==========================================================================
   TAB 4: SHELF TAG GENERATOR
   ========================================================================== */
function generateShelfGrid() {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid) return;

  // Clear pending QR timeouts from a previous run
  shelfGridTimeouts.forEach(id => clearTimeout(id));
  shelfGridTimeouts = [];
  const generation = ++shelfGridGeneration;

  const shelfZoneInput = document.getElementById('shelfZoneInput');
  const shelfFromInput = document.getElementById('shelfFromInput');
  const shelfToInput = document.getElementById('shelfToInput');

  const zone = (shelfZoneInput && shelfZoneInput.value ? shelfZoneInput.value.trim().toUpperCase() : '') || 'Α';
  const from = parseInt(shelfFromInput && shelfFromInput.value, 10) || 1;
  const to = parseInt(shelfToInput && shelfToInput.value, 10) || 10;

  grid.innerHTML = '';

  for (let i = from; i <= to; i++) {
    const shelfCode = `${zone}-${i < 10 ? '0' + i : i}`;
    const card = document.createElement('div');
    card.className = 'shelf-tag-card';
    card.dataset.shelfCode = shelfCode;

    const qrId = `shelf-qr-${escapeHtml(shelfCode)}`;

    card.innerHTML = `
      <div class="shelf-tag-location">ΘΕΣΗ: ${escapeHtml(shelfCode)}</div>
      <div id="${qrId}" style="margin: 0.5rem 0;"></div>
      <div style="font-size: 0.65rem; color: #555; text-transform: uppercase;">MONLOGISTICS WMS - SHELF TAG</div>
      <button type="button" class="btn btn-secondary btn-sm shelf-tag-print-btn no-print" data-shelf-print="${escapeHtml(shelfCode)}">Εκτύπωση</button>
    `;

    grid.appendChild(card);

    // Generate QR for Shelf Tag
    const tid = setTimeout(() => {
      if (generation !== shelfGridGeneration) return;
      const target = document.getElementById(qrId);
      if (target) {
        renderQRCode(target, `SHELF:${shelfCode}`, 110);
      }
    }, 50);
    shelfGridTimeouts.push(tid);
  }
}

function bindShelfTagPrintActions() {
  if (shelfTagDelegatedBound) return;
  const grid = document.getElementById('shelfTagGrid');
  if (!grid) return;
  shelfTagDelegatedBound = true;
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-shelf-print]');
    if (!btn || !grid.contains(btn)) return;
    const shelfCode = btn.getAttribute('data-shelf-print');
    if (!shelfCode) return;
    printSingleShelfTag(shelfCode);
  });
}

function printSingleShelfTag(shelfCode) {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid) {
    showToast('Δεν βρέθηκε η ετικέτα ραφιού!', 'error');
    return;
  }
  const card = Array.from(grid.querySelectorAll('.shelf-tag-card')).find(
    (el) => el.dataset.shelfCode === shelfCode
  );
  if (!card) {
    showToast('Δεν βρέθηκε η ετικέτα ραφιού!', 'error');
    return;
  }

  const printArea = document.getElementById('printArea');
  printArea.innerHTML = '';
  const clone = card.cloneNode(true);
  clone.querySelectorAll('.no-print').forEach((el) => el.remove());
  printArea.appendChild(clone);
  printArea.style.display = 'flex';

  showToast(`Εκτύπωση ετικέτας ${shelfCode}`, 'success');
  window.print();

  setTimeout(() => {
    printArea.style.display = 'none';
    printArea.innerHTML = '';
  }, 1000);
}

function printAllShelfTags() {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid || grid.children.length === 0) {
    showToast('Δεν υπάρχουν ετικέτες ραφιών για εκτύπωση!', 'error');
    return;
  }
  const printArea = document.getElementById('printArea');
  printArea.innerHTML = '';
  const clone = grid.cloneNode(true);
  clone.querySelectorAll('.no-print').forEach((el) => el.remove());
  printArea.appendChild(clone);
  printArea.style.display = 'flex';

  window.print();

  setTimeout(() => {
    printArea.style.display = 'none';
    printArea.innerHTML = '';
  }, 1000);
}

/* ==========================================================================
   DEMO SEED DATA
   ========================================================================== */
function seedSampleData(notify = true) {
  const samplePallets = [
    { id: 'PL-8820', customer: 'ΔΗΜΗΤΡΙΟΥ Α.Ε.', shelf: 'Α-14', createdAt: new Date(Date.now() - 3600000 * 24 * 2).toISOString() },
    { id: 'PL-4410', customer: 'OLYMPIC LOGISTICS', shelf: 'Β-02', createdAt: new Date(Date.now() - 3600000 * 24).toISOString() },
    { id: 'PL-3309', customer: 'ALPHA BETA CORP', shelf: null, createdAt: new Date(Date.now() - 3600000 * 5).toISOString() },
    { id: 'PL-9912', customer: 'MEDITERRANEAN FOODS', shelf: 'Α-15', createdAt: new Date(Date.now() - 3600000 * 2).toISOString() },
    { id: 'PL-1105', customer: 'TECHNO PACK', shelf: null, createdAt: new Date().toISOString() }
  ];

  const addedIds = [];
  samplePallets.forEach(sample => {
    if (!pallets.some(p => p.id === sample.id)) {
      pallets.push(sample);
      addedIds.push(sample.id);
    }
  });

  savePalletsToStorage({ upsertIds: addedIds });
  renderInventoryTable();

  if (notify) {
    showToast('Προστέθηκαν 5 δείγματα παλετών με επιτυχία!', 'success');
  }
}

/* ==========================================================================
   UTILITY FUNCTIONS
   ========================================================================== */
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-triangle'}" style="width: 20px; color: ${type === 'success' ? 'var(--emerald)' : 'var(--rose)'};"></i>
    <span>${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);
  if (window.lucide) lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });
}

/**
 * Safe QR renderer — unique real QR per payload.
 * Prefers local QRCode.toDataURL; falls back to api.qrserver.com with payload cache-buster.
 * Never uses the old identical SVG matrix. On total failure, shows red error + payload.
 */
function renderQRCode(container, text, size) {
  if (!container) return;
  container.innerHTML = '';
  const qrSize = size || 140;
  const payload = String(text == null ? '' : text);

  function showQrError() {
    container.innerHTML = '';
    const err = document.createElement('div');
    err.style.cssText = 'color:#ef4444;font-size:11px;text-align:center;padding:8px;word-break:break-all;line-height:1.35;';
    err.innerHTML = 'QR error<br>' + escapeHtml(payload);
    container.appendChild(err);
  }

  function appendQrImg(src, onFail) {
    container.innerHTML = '';
    const img = document.createElement('img');
    img.alt = 'QR';
    img.style.cssText = 'display:block;margin:0 auto;width:' + qrSize + 'px;height:' + qrSize + 'px;';
    img.src = src;
    img.onerror = function () {
      if (typeof onFail === 'function') onFail();
      else showQrError();
    };
    container.appendChild(img);
  }

  function useRemoteApi() {
    const encoded = encodeURIComponent(payload);
    // Cache-buster includes the full payload so each code gets a distinct URL
    const src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + qrSize + 'x' + qrSize +
      '&ecc=M&margin=2&data=' + encoded + '&cb=' + encoded;
    appendQrImg(src, showQrError);
  }

  if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
    try {
      QRCode.toDataURL(payload, {
        width: qrSize,
        margin: 2,
        errorCorrectionLevel: 'M'
      }, function (err, dataURL) {
        if (err || !dataURL) {
          useRemoteApi();
          return;
        }
        appendQrImg(dataURL, useRemoteApi);
      });
    } catch (e) {
      console.error('QRCode.toDataURL failed:', e);
      useRemoteApi();
    }
  } else {
    useRemoteApi();
  }
}

function renderFallbackQR(container, text, size) {
  renderQRCode(container, text, size);
}
