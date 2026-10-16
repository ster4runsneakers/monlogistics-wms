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
let scanStepShelf = null;  // canonical location code e.g. "Α-14" or "Α-14-Δ2"
let scanLocationType = 'shelf'; // 'shelf' | 'aisle'
let scanAisleRow = null;       // 1..4 when aisle ready, else null
let scanBaseShelf = null;      // base shelf code while picking aisle row
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

// Pick lists state
const PICKLISTS_KEY = 'monlog_picklists_v1';
let pickLists = [];
/** @type {{ productName: string, qtyNeeded: number }[]} */
let pickImportLines = [];
let pickImportMeta = { customer: '', orderRef: '' };
let activePickListId = null;
let firestorePickUnsub = null;
let applyingPickRemoteSnapshot = false;
let pendingPickContext = null; // { listId, lineId, palletId, available, expiry, mode }
let pickScanAwaiting = null; // { listId, lineId } — intercept next pallet QR for picking
let pickModalDelegatedBound = false;

// Firebase / sync state
let cloudEnabled = false;
let db = null;
let firestoreUnsub = null;
let applyingRemoteSnapshot = false;
let firebaseFallbackToastShown = false;

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  loadPalletsFromStorage();
  loadPickListsFromStorage();
  loadSettingsFromStorage();
  const usingCloud = initFirebaseSync();

  // Initialize Lucide Icons if available
  if (window.lucide) {
    lucide.createIcons();
  }

  // Pre-fill initial form auto ID
  generateAutoPalletId();

  // Render initial table & statistics (cloud snapshot may refresh again)
  renderInventoryTable();
  renderProductSearch();
  updateStats();
  populateSimulators();
  updateLinkUI();
  generateShelfGrid();
  initPickTabUI();
  initSettingsUI();

  // Delegated inventory table actions (avoid inline onclick XSS)
  bindInventoryTableActions();
  bindShipModalChrome();
  bindPickModalChrome();
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
  const status = p.status === 'shipped' ? 'shipped' : 'in_stock';
  const shelf = (p.shelf === undefined || p.shelf === "") ? null : p.shelf;
  let locationType = p.locationType === 'aisle' ? 'aisle' : (p.locationType === 'shelf' ? 'shelf' : null);
  if (!locationType && shelf) locationType = 'shelf';
  if (!shelf) locationType = null;
  let aisleRow = (p.aisleRow === undefined || p.aisleRow === null || p.aisleRow === '') ? null : Number(p.aisleRow);
  if (locationType !== 'aisle') aisleRow = null;
  else if (!(aisleRow >= 1 && aisleRow <= 4)) aisleRow = null;
  return {
    customer: p.customer || "",
    shelf,
    locationType,
    aisleRow,
    items: normalizeItems(p.items),
    createdAt: p.createdAt || new Date().toISOString(),
    pairedAt: p.pairedAt == null ? null : p.pairedAt,
    status,
    shippedAt: p.shippedAt || null,
    shippedTo: p.shippedTo || null,
    shippedRef: p.shippedRef || null,
    shippedNote: p.shippedNote || null,
    updatedAt: new Date().toISOString()
  };
}

function sortPalletsByCreatedDesc(list) {
  list.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return list;
}

/** Normalize ship/export + location fields on load. Missing status → in_stock. */
function normalizePallet(p) {
  if (!p || typeof p !== 'object') return p;
  const status = p.status === 'shipped' ? 'shipped' : 'in_stock';
  const shelf = (p.shelf === undefined || p.shelf === '') ? null : p.shelf;
  let locationType = p.locationType === 'aisle' ? 'aisle' : (p.locationType === 'shelf' ? 'shelf' : null);
  // Back-compat: locationType missing + shelf set → assume shelf
  if (!locationType && shelf) locationType = 'shelf';
  if (!shelf) locationType = null;
  let aisleRow = (p.aisleRow === undefined || p.aisleRow === null || p.aisleRow === '') ? null : Number(p.aisleRow);
  if (locationType !== 'aisle') {
    aisleRow = null;
  } else if (!(aisleRow >= 1 && aisleRow <= 4)) {
    const parsed = parseAisleLocationCode(shelf);
    aisleRow = parsed ? parsed.row : null;
  }
  return {
    ...p,
    items: normalizeItems(p.items),
    status,
    shippedAt: p.shippedAt || null,
    shippedTo: (p.shippedTo == null || p.shippedTo === '') ? null : String(p.shippedTo),
    shippedRef: (p.shippedRef == null || p.shippedRef === '') ? null : String(p.shippedRef),
    shippedNote: (p.shippedNote == null || p.shippedNote === '') ? null : String(p.shippedNote),
    shelf,
    locationType,
    aisleRow
  };
}

/** Build aisle location code: Α-14-Δ2 */
function formatAisleLocationCode(baseShelf, row) {
  return `${baseShelf}-Δ${row}`;
}

/** Parse Α-14-Δ2 → { base, row } or null */
function parseAisleLocationCode(code) {
  if (!code) return null;
  const m = String(code).match(/^(.+)-Δ([1-4])$/);
  if (!m) return null;
  return { base: m[1], row: parseInt(m[2], 10) };
}

function locationLabelForPallet(p) {
  if (!p || !p.shelf) return null;
  if (p.locationType === 'aisle') {
    const row = p.aisleRow || (parseAisleLocationCode(p.shelf) || {}).row;
    return row ? `Διάδρομος σειρά ${row} · ${p.shelf}` : `Διάδρομος · ${p.shelf}`;
  }
  return `Ράφι ${p.shelf}`;
}

function isInStock(p) {
  return !p || p.status !== 'shipped';
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
        pallets = sortPalletsByCreatedDesc(parsed.map((p) => normalizePallet(p)));
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
      const data = d.data() || {};
      next.push(normalizePallet({ id: d.id, ...data }));
    });
    pallets = sortPalletsByCreatedDesc(next);
    mirrorPalletsToLocalCache();
    renderInventoryTable();
    renderProductSearch();
    updateStats();
    populateSimulators();
    renderPickTab();
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
    subscribePickLists();
    subscribeSettings();
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
  const stock = pallets.filter(isInStock);
  const total = stock.length;
  const assigned = stock.filter(p => p.shelf !== null && p.shelf !== "").length;
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

  if (tabId === 'tab-picking') {
    renderPickTab();
  }
  if (tabId === 'tab-settings') {
    renderSettingsForm();
  }

  // Re-create icons for freshly visible tab elements
  if (window.lucide) {
    lucide.createIcons();
  }
}


/* ==========================================================================
   PRODUCT LINE HELPERS
   ========================================================================== */
function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    if (!it || typeof it !== 'object') return null;
    const name = String(it.name || '').trim();
    if (!name) return null;
    let qty = it.qty;
    if (qty === '' || qty === undefined || qty === null) qty = null;
    else {
      const n = Number(qty);
      qty = Number.isFinite(n) ? n : null;
    }
    let expiry = it.expiry;
    if (expiry === '' || expiry === undefined || expiry === null) expiry = null;
    else expiry = String(expiry).trim() || null;
    return { name, qty, expiry };
  }).filter(Boolean);
}

function addProductRow(prefill) {
  const container = document.getElementById('productRows');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'product-row';
  const nameVal = prefill && prefill.name ? String(prefill.name) : '';
  const qtyVal = prefill && prefill.qty != null && prefill.qty !== '' ? String(prefill.qty) : '';
  const expVal = prefill && prefill.expiry ? String(prefill.expiry) : '';
  row.innerHTML = `
    <input type="text" class="form-input product-name" placeholder="Όνομα προϊόντος" autocomplete="off" value="${escapeHtml(nameVal)}">
    <input type="number" class="form-input product-qty" placeholder="Ποσ." min="0" step="any" inputmode="decimal" value="${escapeHtml(qtyVal)}">
    <input type="date" class="form-input product-expiry" title="Ημ/νία λήξης" value="${escapeHtml(expVal)}">
    <button type="button" class="btn btn-secondary btn-sm product-remove" onclick="removeProductRow(this)" title="Αφαίρεση">
      <i data-lucide="trash-2" style="width: 14px;"></i>
    </button>
  `;
  container.appendChild(row);
  if (window.lucide) lucide.createIcons();
}

function removeProductRow(btn) {
  const container = document.getElementById('productRows');
  if (!container || !btn) return;
  const row = btn.closest('.product-row');
  if (!row) return;
  row.remove();
  if (container.querySelectorAll('.product-row').length === 0) {
    addProductRow();
  }
}

function collectProductItems() {
  const container = document.getElementById('productRows');
  if (!container) return [];
  const items = [];
  container.querySelectorAll('.product-row').forEach((row) => {
    const nameEl = row.querySelector('.product-name');
    const qtyEl = row.querySelector('.product-qty');
    const expEl = row.querySelector('.product-expiry');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) return;
    let qty = null;
    if (qtyEl && qtyEl.value !== '') {
      const n = Number(qtyEl.value);
      if (Number.isFinite(n)) qty = n;
    }
    const expiry = expEl && expEl.value ? expEl.value : null;
    items.push({ name, qty, expiry });
  });
  return items;
}

function resetProductRows() {
  const container = document.getElementById('productRows');
  if (!container) return;
  container.innerHTML = '';
  addProductRow();
}

function setProductRowsFromItems(items) {
  const container = document.getElementById('productRows');
  if (!container) return;
  container.innerHTML = '';
  const list = normalizeItems(items);
  if (list.length === 0) {
    addProductRow();
    return;
  }
  list.forEach((it) => addProductRow(it));
}

function todayYmdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function expiryStatus(expiry) {
  if (!expiry) return null;
  const today = todayYmdLocal();
  if (expiry < today) return 'expired';
  const t = new Date(today + 'T00:00:00');
  const e = new Date(expiry + 'T00:00:00');
  if (Number.isNaN(e.getTime())) return null;
  const diffDays = Math.round((e - t) / 86400000);
  if (diffDays <= getExpiryWarnDays()) return 'soon';
  return 'ok';
}

function formatExpiryEl(expiry) {
  if (!expiry) return '';
  try {
    const [y, m, d] = expiry.split('-');
    if (y && m && d) return `${d}/${m}/${y}`;
  } catch (_) {}
  return expiry;
}


function inventoryProductsCellHtml(items) {
  const list = normalizeItems(items);
  if (list.length === 0) {
    return '<span class="products-empty" style="color: var(--text-dim);">—</span>';
  }
  const first = list[0];
  let badge = '';
  if (list.some((it) => expiryStatus(it.expiry) === 'expired')) {
    badge = ' <span class="badge-expiry badge-expired">Ληγμένο</span>';
  } else if (list.some((it) => expiryStatus(it.expiry) === 'soon')) {
    badge = ' <span class="badge-expiry badge-soon">Λήγει</span>';
  }
  if (list.length === 1) {
    const exp = first.expiry ? ` <span class="product-exp-meta">${formatExpiryEl(first.expiry)}</span>` : '';
    return `<span class="inv-products" title="${escapeHtml(list.map(i => i.name + (i.expiry ? ' · ' + i.expiry : '')).join(', '))}">${escapeHtml(first.name)}${exp}${badge}</span>`;
  }
  return `<span class="inv-products" title="${escapeHtml(list.map(i => i.name + (i.expiry ? ' · ' + i.expiry : '')).join(', '))}">${escapeHtml(first.name)} <span class="product-more">· ${list.length} είδη</span>${badge}</span>`;
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
  const items = collectProductItems();

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
    pallets[existingIndex].items = items;
    palletObj = pallets[existingIndex];
    showToast(`Ενημερώθηκε η υπάρχουσα παλέτα ${palletIdInput}`, 'success');
  } else {
    // Create new
    palletObj = {
      id: palletIdInput,
      customer: customerInput,
      shelf: null,
      locationType: null,
      aisleRow: null,
      items: items,
      createdAt: new Date().toISOString(),
      pairedAt: null,
      status: 'in_stock',
      shippedAt: null,
      shippedTo: null,
      shippedRef: null,
      shippedNote: null
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

  // Prepare next auto ID for next creation; reset product rows
  generateAutoPalletId();
  resetProductRows();
}

function renderPalletLabel(pallet) {
  document.getElementById('previewCustomer').innerText = pallet.customer;
  document.getElementById('previewPalletId').innerText = pallet.id;

  const dateFormatted = new Date(pallet.createdAt || Date.now()).toLocaleDateString('el-GR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  document.getElementById('previewDate').innerText = `Ημ/νία: ${dateFormatted}`;

  const items = normalizeItems(pallet.items);
  const wrap = document.getElementById('previewProductsWrap');
  const previewProducts = document.getElementById('previewProducts');
  if (wrap && previewProducts) {
    if (items.length === 0) {
      wrap.hidden = true;
      previewProducts.innerHTML = '';
    } else {
      wrap.hidden = false;
      const max = 4;
      const shown = items.slice(0, max);
      const extra = items.length - shown.length;
      const lines = shown.map((it) => {
        const exp = it.expiry ? ` · λήξη ${formatExpiryEl(it.expiry)}` : '';
        const qty = it.qty != null ? ` ×${it.qty}` : '';
        return `<div class="label-product-line">${escapeHtml(it.name)}${qty}${exp}</div>`;
      });
      if (extra > 0) lines.push(`<div class="label-product-more">+${extra} ακόμη</div>`);
      previewProducts.innerHTML = lines.join('');
    }
  }

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
  printLabelsSized([palletToLabelSpec(activePalletForLabel)]);
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
  
  pallets.filter(isInStock).forEach(p => {
    const statusText = p.shelf ? `[${p.locationType === 'aisle' ? 'Διάδρομος' : 'Ράφι'} ${p.shelf}]` : '[Μη τοποθετημένη]';
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

function setScanLocationType(type) {
  const next = type === 'aisle' ? 'aisle' : 'shelf';
  if (scanLocationType === next) {
    updateLinkUI();
    return;
  }
  scanLocationType = next;
  scanStepShelf = null;
  scanAisleRow = null;
  scanBaseShelf = null;
  updateLinkUI();
  showToast(next === 'aisle'
    ? 'Θέση: Διάδρομος — επιλέξτε πρώτα το ράφι μπροστά, μετά τη σειρά 1–4'
    : 'Θέση: Ράφι — επιλέξτε/σκανάρετε κωδικό ραφιού', 'success');
}

function selectAisleRow(row) {
  const n = Number(row);
  if (!(n >= 1 && n <= 4)) return;
  if (!scanStepPallet) {
    showToast('⚠️ Παρακαλώ επιλέξτε/σκανάρετε ΠΡΩΤΑ το QR της Παλέτας (Στάδιο 1)', 'error');
    return;
  }
  if (!scanBaseShelf) {
    showToast('⚠️ Επιλέξτε πρώτα το βασικό ράφι (π.χ. Α-14)', 'error');
    return;
  }
  scanLocationType = 'aisle';
  scanAisleRow = n;
  scanStepShelf = formatAisleLocationCode(scanBaseShelf, n);
  showToast(`👉 Στάδιο 2: Διάδρομος μπροστά από ${scanBaseShelf} · Σειρά ${n}`, 'success');
  updateLinkUI();
}

function applyAisleLocation(baseShelf, row) {
  if (!scanStepPallet) {
    showToast('⚠️ Παρακαλώ επιλέξτε/σκανάρετε ΠΡΩΤΑ το QR της Παλέτας (Στάδιο 1)', 'error');
    return;
  }
  const n = Number(row);
  if (!baseShelf || !(n >= 1 && n <= 4)) {
    showToast('Μη έγκυρη θέση διαδρόμου', 'error');
    return;
  }
  scanLocationType = 'aisle';
  scanBaseShelf = baseShelf;
  scanAisleRow = n;
  scanStepShelf = formatAisleLocationCode(baseShelf, n);
  showToast(`👉 Στάδιο 2: Διάδρομος μπροστά από ${baseShelf} · Σειρά ${n}`, 'success');
  updateLinkUI();
}

function simulateShelfScan(shelfCode) {
  if (!scanStepPallet) {
    showToast('⚠️ Παρακαλώ επιλέξτε/σκανάρετε ΠΡΩΤΑ το QR της Παλέτας (Στάδιο 1)', 'error');
    return;
  }

  const code = String(shelfCode || '').trim();
  if (!code) return;

  // If scanned code already encodes aisle (Α-14-Δ2), treat as aisle
  const parsed = parseAisleLocationCode(code);
  if (parsed) {
    applyAisleLocation(parsed.base, parsed.row);
    return;
  }

  if (scanLocationType === 'aisle') {
    scanBaseShelf = code;
    scanAisleRow = null;
    scanStepShelf = null;
    showToast(`👉 Επιλέχθηκε ράφι ${code} — επιλέξτε Σειρά μπροστά 1–4`, 'success');
    updateLinkUI();
    return;
  }

  scanLocationType = 'shelf';
  scanBaseShelf = null;
  scanAisleRow = null;
  scanStepShelf = code;
  showToast(`👉 Στάδιο 2: Σκαναρίστηκε η θέση ραφιού ${code}`, 'success');
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

  // Location type toggle
  document.querySelectorAll('[data-loc-type]').forEach((btn) => {
    const active = btn.getAttribute('data-loc-type') === scanLocationType;
    btn.classList.toggle('loc-type-btn-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  const aisleRowWrap = document.getElementById('aisleRowPicker');
  const shelfStepLabel = document.getElementById('simShelfStepLabel');
  if (aisleRowWrap) {
    aisleRowWrap.hidden = scanLocationType !== 'aisle';
  }
  if (shelfStepLabel) {
    shelfStepLabel.textContent = scanLocationType === 'aisle'
      ? '2. Βασικό ράφι (μπροστά από):'
      : '2. Σάρωση / Επιλογή Θέσης Ραφιού:';
  }
  document.querySelectorAll('[data-aisle-row]').forEach((btn) => {
    const n = Number(btn.getAttribute('data-aisle-row'));
    const active = scanLocationType === 'aisle' && scanAisleRow === n && !!scanStepShelf;
    btn.classList.toggle('aisle-row-btn-active', active);
    btn.disabled = scanLocationType === 'aisle' && !scanBaseShelf;
  });
  const aisleBaseHint = document.getElementById('aisleBaseHint');
  if (aisleBaseHint) {
    aisleBaseHint.textContent = scanBaseShelf
      ? `Ράφι: ${scanBaseShelf} — επιλέξτε σειρά`
      : 'Επιλέξτε πρώτα ράφι, μετά σειρά 1–4';
  }

  // Step 2 UI
  const cardShelf = document.getElementById('stepCardShelf');
  const valShelf = document.getElementById('stepValShelf');
  const displayShelf = document.getElementById('statusShelfDisplay');
  const btnConfirm = document.getElementById('btnConfirmPair');
  const stepTitleShelf = document.getElementById('stepTitleShelf');
  if (stepTitleShelf) {
    stepTitleShelf.textContent = scanLocationType === 'aisle' ? 'QR Θέσης Διαδρόμου' : 'QR Θέσης Ραφιού';
  }

  if (scanStepShelf) {
    cardShelf.className = 'step-card completed';
    if (scanLocationType === 'aisle') {
      valShelf.innerHTML = `<span style="color: var(--emerald);">✅ Διάδρομος σειρά ${scanAisleRow} · ${escapeHtml(scanStepShelf)}</span>`;
      displayShelf.className = 'badge-aisle';
      displayShelf.innerText = `🛤️ Διάδρομος σειρά ${scanAisleRow} · ${scanStepShelf}`;
    } else {
      valShelf.innerHTML = `<span style="color: var(--emerald);">✅ Ράφι ${escapeHtml(scanStepShelf)}</span>`;
      displayShelf.className = 'badge-shelf';
      displayShelf.innerText = `📍 Ράφι ${scanStepShelf}`;
    }
  } else if (scanLocationType === 'aisle' && scanBaseShelf) {
    cardShelf.className = 'step-card active';
    valShelf.innerText = `Ράφι ${scanBaseShelf} — εκκρεμεί σειρά`;
    displayShelf.className = 'badge-unassigned';
    displayShelf.innerText = `⚠️ Επιλέξτε σειρά για ${scanBaseShelf}`;
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
  scanAisleRow = null;
  scanBaseShelf = null;
  // keep scanLocationType so operator can continue same mode
  if (pickScanAwaiting) {
    cancelPickPalletScan();
  }
  const sel = document.getElementById('simPalletSelect');
  if (sel) sel.value = '';
  updateLinkUI();
  showToast('Επαναφορά διαδικασίας σάρωσης.', 'success');
}

function confirmPairing() {
  if (!scanStepPallet || !scanStepShelf) return;

  const locType = scanLocationType === 'aisle' ? 'aisle' : 'shelf';
  const aisleRow = locType === 'aisle' ? scanAisleRow : null;

  let p = pallets.find(x => x.id === scanStepPallet.id);
  if (!p) {
    // If not existing, create it
    p = {
      id: scanStepPallet.id,
      customer: scanStepPallet.customer || 'Γενικός Πελάτης',
      shelf: scanStepShelf,
      locationType: locType,
      aisleRow,
      items: [],
      createdAt: new Date().toISOString(),
      pairedAt: new Date().toISOString(),
      status: 'in_stock',
      shippedAt: null,
      shippedTo: null,
      shippedRef: null,
      shippedNote: null
    };
    pallets.unshift(p);
  } else {
    p.shelf = scanStepShelf;
    p.locationType = locType;
    p.aisleRow = aisleRow;
    p.pairedAt = new Date().toISOString();
    // Re-shelving restores warehouse presence
    if (p.status === 'shipped') {
      p.status = 'in_stock';
      p.shippedAt = null;
      p.shippedTo = null;
      p.shippedRef = null;
      p.shippedNote = null;
    }
  }

  savePalletsToStorage({ upsertIds: [p.id] });
  renderInventoryTable();
  addRecentPair(p.customer, p.id, p.shelf, p.locationType, p.aisleRow);

  const where = locType === 'aisle'
    ? `Διάδρομο σειρά ${aisleRow} (${p.shelf})`
    : `ράφι ${p.shelf}`;
  showToast(`🎉 Η παλέτα ${p.id} συνδέθηκε επιτυχώς στο ${where}!`, 'success');

  // Reset steps for next scanning
  resetLinkSteps();
}

function addRecentPair(customer, palletId, shelf, locationType, aisleRow) {
  const container = document.getElementById('recentPairsList');
  if (container.children.length === 1 && container.children[0].innerText.includes('Δεν υπάρχουν')) {
    container.innerHTML = '';
  }

  const timeStr = new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
  const isAisle = locationType === 'aisle';
  const badgeClass = isAisle ? 'badge-aisle' : 'badge-shelf';
  const badgeText = isAisle
    ? `🛤️ Δ${aisleRow || '?'} · ${shelf}`
    : `📍 ${shelf}`;
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
      <span class="${badgeClass}" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">${escapeHtml(badgeText)}</span>
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

  // Picking scan mode: only accept pallet QR / id
  if (pickScanAwaiting) {
    try {
      const json = JSON.parse(text);
      if (json.type === 'PALLET' && json.id) {
        handlePickPalletScan(String(json.id));
        return;
      }
      if (json.type === 'SHELF' || json.type === 'AISLE') {
        showToast('Σκανάρετε παλέτα (όχι ράφι/διάδρομο)', 'error');
        return;
      }
    } catch (e) {
      // plain text
    }
    if (String(text).startsWith('SHELF:') || String(text).startsWith('AISLE:')) {
      showToast('Σκανάρετε παλέτα (όχι ράφι/διάδρομο)', 'error');
      return;
    }
    const palletId = String(text).startsWith('PALLET:')
      ? String(text).replace('PALLET:', '').trim()
      : String(text).trim();
    handlePickPalletScan(palletId);
    return;
  }
  
  // Try parsing JSON if structured
  try {
    const json = JSON.parse(text);
    if (json.type === 'PALLET' && json.id) {
      simulatePalletScan(json.id);
      return;
    } else if (json.type === 'AISLE' && json.code && json.row) {
      applyAisleLocation(String(json.code).trim(), Number(json.row));
      return;
    } else if (json.type === 'SHELF' && json.code) {
      simulateShelfScan(json.code);
      return;
    }
  } catch (e) {
    // Plain text payload parsing
  }

  // AISLE:Α-14:2 — preferred aisle QR
  if (text.startsWith('AISLE:')) {
    const rest = text.replace('AISLE:', '').trim();
    const parts = rest.split(':');
    if (parts.length >= 2) {
      const base = parts[0].trim();
      const row = parseInt(parts[1].trim(), 10);
      applyAisleLocation(base, row);
      return;
    }
  }

  // Handle plain text like "PL-1001", "PALLET:PL-1001", "A-14", "SHELF:A-14", "SHELF:Α-14-Δ2"
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
    // If step 1 done, treat scan as Shelf / aisle code
    simulateShelfScan(text);
  }
}

/* ==========================================================================
   TAB 3a: PRODUCT ACROSS-PALLETS SEARCH
   ========================================================================== */

/** Fold Greek/Latin text for search: lowercase, strip diacritics, Greek→Latin (ΤΑΧΙΝΙ ≈ TAXINI). */
function foldSearchText(s) {
  const gr2lat = {
    'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th',
    'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p',
    'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'x', 'ψ': 'ps', 'ω': 'o'
  };
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[α-ω]/g, (ch) => gr2lat[ch] || ch)
    .trim();
}

/** Partial / token match of query against item name (shared with picking). */
function productNamePartialMatch(itemName, query) {
  const a = foldSearchText(itemName);
  const q = foldSearchText(query);
  if (!a || !q) return false;
  if (a.includes(q) || q.includes(a)) return true;
  return itemNameMatchInfo(itemName, query).matches;
}

function locationSortKey(p) {
  if (!p || !p.shelf) return '~~~';
  return String(p.shelf).toLowerCase();
}

/**
 * Find every (pallet, matching item) hit for a product name query.
 * Default: in_stock only. FEFO sort (earliest expiry first), then location, then pallet id.
 */
function findProductAcrossPallets(query, includeShipped) {
  const q = String(query || '').trim();
  if (!q) return [];
  const hits = [];
  for (const p of pallets) {
    if (!includeShipped && !isInStock(p)) continue;
    const items = normalizeItems(p.items);
    for (const it of items) {
      if (!productNamePartialMatch(it.name, q)) continue;
      hits.push({ pallet: p, item: it });
    }
  }
  hits.sort((a, b) => {
    const ea = a.item.expiry || '9999-99-99';
    const eb = b.item.expiry || '9999-99-99';
    if (ea !== eb) return ea < eb ? -1 : 1;
    const la = locationSortKey(a.pallet);
    const lb = locationSortKey(b.pallet);
    if (la !== lb) return la < lb ? -1 : 1;
    const ida = String(a.pallet.id || '');
    const idb = String(b.pallet.id || '');
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
  return hits;
}

function productSearchExpiryBadgeHtml(expiry) {
  if (!expiry) return '';
  const st = expiryStatus(expiry);
  const formatted = formatExpiryEl(expiry);
  if (st === 'expired') {
    return `<span class="badge-expiry badge-expired">Ληγμένο · ${escapeHtml(formatted)}</span>`;
  }
  if (st === 'soon') {
    return `<span class="badge-expiry badge-soon">Λήγει · ${escapeHtml(formatted)}</span>`;
  }
  return `<span class="product-hit-expiry-ok">λήξη ${escapeHtml(formatted)}</span>`;
}

function productSearchLocationHtml(p) {
  if (p.status === 'shipped') {
    return `<span class="badge-shipped">🚚 Εξαχθείσα</span>`;
  }
  if (p.shelf) {
    if (p.locationType === 'aisle') {
      const row = p.aisleRow || (parseAisleLocationCode(p.shelf) || {}).row || '?';
      return `<span class="badge-aisle" title="Διάδρομος">🛤️ Διάδρομος σειρά ${escapeHtml(String(row))} · ${escapeHtml(p.shelf)}</span>`;
    }
    return `<span class="badge-shelf" title="Ράφι">📍 Ράφι ${escapeHtml(p.shelf)}</span>`;
  }
  return `<span class="badge-unassigned">⚠️ Εκτός Ραφιού</span>`;
}

function filterProductSearch() {
  renderProductSearch();
}

function renderProductSearch() {
  const resultsEl = document.getElementById('productSearchResults');
  const metaEl = document.getElementById('productSearchMeta');
  const inputEl = document.getElementById('productSearchInput');
  const includeEl = document.getElementById('productSearchIncludeShipped');
  if (!resultsEl) return;

  const query = inputEl ? inputEl.value : '';
  const includeShipped = !!(includeEl && includeEl.checked);
  const trimmed = String(query || '').trim();

  if (!trimmed) {
    resultsEl.innerHTML = `
      <div class="product-search-hint">
        <i data-lucide="package" style="width: 28px; height: 28px;"></i>
        <span>Πληκτρολογήστε όνομα προϊόντος για αναζήτηση σε όλες τις παλέτες.</span>
      </div>`;
    if (metaEl) {
      metaEl.hidden = true;
      metaEl.textContent = '';
    }
    if (window.lucide) lucide.createIcons();
    return;
  }

  const hits = findProductAcrossPallets(trimmed, includeShipped);

  if (metaEl) {
    metaEl.hidden = false;
    metaEl.textContent = hits.length === 1
      ? 'Βρέθηκε 1 αποτέλεσμα (πρώτα όσα λήγουν νωρίτερα)'
      : `Βρέθηκαν ${hits.length} αποτελέσματα (πρώτα όσα λήγουν νωρίτερα)`;
  }

  if (hits.length === 0) {
    resultsEl.innerHTML = `
      <div class="product-search-empty">
        <i data-lucide="inbox" style="width: 32px; height: 32px;"></i>
        <span>Δεν βρέθηκε προϊόν «${escapeHtml(trimmed)}» σε παλέτες${includeShipped ? '' : ' στην αποθήκη'}.</span>
      </div>`;
    if (window.lucide) lucide.createIcons();
    return;
  }

  resultsEl.innerHTML = hits.map(({ pallet: p, item: it }) => {
    const qtyText = it.qty != null ? String(it.qty) : '—';
    const customer = p.customer ? `<span class="product-hit-customer">${escapeHtml(p.customer)}</span>` : '';
    return `
      <article class="product-hit-card${p.status === 'shipped' ? ' product-hit-shipped' : ''}">
        <div class="product-hit-top">
          <span class="product-hit-id">${escapeHtml(p.id)}</span>
          ${productSearchLocationHtml(p)}
        </div>
        <div class="product-hit-name">${escapeHtml(it.name)}</div>
        <div class="product-hit-meta">
          <span class="product-hit-qty">Ποσότητα: <strong>${escapeHtml(qtyText)}</strong></span>
          ${productSearchExpiryBadgeHtml(it.expiry)}
          ${customer}
        </div>
      </article>`;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

/* ==========================================================================
   TAB 3: INVENTORY TABLE & SEARCH
   ========================================================================== */
function renderInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;

  const searchQuery = document.getElementById('searchInput') ? document.getElementById('searchInput').value.toLowerCase().trim() : '';
  const filterStatus = document.getElementById('filterStatusSelect') ? document.getElementById('filterStatusSelect').value : 'IN_STOCK';

  let filtered = pallets.filter(p => {
    const items = normalizeItems(p.items);
    const productBlob = items.map((it) => [
      it.name || '',
      it.expiry || '',
      formatExpiryEl(it.expiry) || ''
    ].join(' ')).join(' ').toLowerCase();

    const matchesSearch = !searchQuery ||
                          (p.customer || '').toLowerCase().includes(searchQuery) ||
                          (p.id || '').toLowerCase().includes(searchQuery) ||
                          (p.shelf && String(p.shelf).toLowerCase().includes(searchQuery)) ||
                          (p.shippedTo && String(p.shippedTo).toLowerCase().includes(searchQuery)) ||
                          (p.shippedRef && String(p.shippedRef).toLowerCase().includes(searchQuery)) ||
                          (p.shippedNote && String(p.shippedNote).toLowerCase().includes(searchQuery)) ||
                          productBlob.includes(searchQuery);

    if (!matchesSearch) return false;

    const shipped = p.status === 'shipped';
    if (filterStatus === 'IN_STOCK') return !shipped;
    if (filterStatus === 'SHIPPED') return shipped;
    if (filterStatus === 'ASSIGNED') return !shipped && p.shelf !== null && p.shelf !== '';
    if (filterStatus === 'UNASSIGNED') return !shipped && !p.shelf;
    return true; // ALL
  });

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-dim);">
          <i data-lucide="inbox" style="width: 32px; height: 32px; margin-bottom: 0.5rem; display: block; margin: 0 auto;"></i>
          Δεν βρέθηκαν παλέτες που να ταιριάζουν με τα κριτήρια.
        </td>
      </tr>
    `;
    if (window.lucide) lucide.createIcons();
    renderProductSearch();
    return;
  }

  filtered.forEach(p => {
    const tr = document.createElement('tr');
    if (p.status === 'shipped') tr.classList.add('row-shipped');
    const safeId = escapeHtml(p.id);

    let shelfBadgeHtml;
    if (p.status === 'shipped') {
      const shipDate = p.shippedAt ? new Date(p.shippedAt).toLocaleDateString('el-GR', {
        day: '2-digit', month: '2-digit', year: 'numeric'
      }) : '';
      const to = p.shippedTo ? escapeHtml(p.shippedTo) : '';
      const ref = p.shippedRef ? ` · ${escapeHtml(p.shippedRef)}` : '';
      shelfBadgeHtml = `<span class="badge-shipped" title="${escapeHtml(p.shippedNote || '')}">🚚 ΕΞΑΓΩΓΗ${shipDate ? ' · ' + shipDate : ''}${to ? ' → ' + to : ''}${ref}</span>`;
    } else if (p.shelf) {
      if (p.locationType === 'aisle') {
        const row = p.aisleRow || (parseAisleLocationCode(p.shelf) || {}).row || '?';
        shelfBadgeHtml = `<span class="badge-aisle" title="Διάδρομος">🛤️ Διάδρομος σειρά ${escapeHtml(String(row))} · ${escapeHtml(p.shelf)}</span>`;
      } else {
        shelfBadgeHtml = `<span class="badge-shelf" title="Ράφι">📍 Ράφι ${escapeHtml(p.shelf)}</span>`;
      }
    } else {
      shelfBadgeHtml = `<span class="badge-unassigned">⚠️ Εκτός Ραφιού</span>`;
    }

    const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('el-GR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }) : '-';

    const productsHtml = inventoryProductsCellHtml(p.items);

    const shipBtn = p.status === 'shipped'
      ? `<button type="button" class="btn btn-secondary btn-sm" data-action="unship" data-id="${safeId}" title="Επαναφορά στην αποθήκη">
            <i data-lucide="undo-2" style="width: 14px;"></i> <span>Επαναφορά</span>
          </button>`
      : `<button type="button" class="btn btn-emerald btn-sm" data-action="ship" data-id="${safeId}" title="Εξαγωγή παλέτας">
            <i data-lucide="truck" style="width: 14px;"></i> <span>Εξαγωγή</span>
          </button>`;

    const pairBtn = p.status === 'shipped'
      ? ''
      : `<button type="button" class="btn btn-primary btn-sm" data-action="pair" data-id="${safeId}" title="Σύνδεση/Αλλαγή Θέσης">
            <i data-lucide="link" style="width: 14px;"></i>
          </button>`;

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(p.customer)}</td>
      <td>
        <span style="font-family: monospace; font-weight: 700; font-size: 0.95rem; background: rgba(99, 102, 241, 0.15); color: #818cf8; padding: 0.2rem 0.5rem; border-radius: 4px;">
          ${safeId}
        </span>
      </td>
      <td style="font-size: 0.85rem; max-width: 220px;">${productsHtml}</td>
      <td>${shelfBadgeHtml}</td>
      <td style="color: var(--text-muted); font-size: 0.85rem;">${dateStr}</td>
      <td style="text-align: right;">
        <div class="inventory-row-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="print" data-id="${safeId}" title="Εκτύπωση Ετικέτας">
            <i data-lucide="printer" style="width: 14px;"></i>
          </button>
          <button type="button" class="btn btn-secondary btn-sm btn-edit-pallet" data-action="edit" data-id="${safeId}" title="Επεξεργασία">
            <i data-lucide="pencil" style="width: 14px;"></i> <span>Επεξ.</span>
          </button>
          ${shipBtn}
          ${pairBtn}
          <button type="button" class="btn btn-danger btn-sm" data-action="delete" data-id="${safeId}" title="Διαγραφή">
            <i data-lucide="trash-2" style="width: 14px;"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (window.lucide) lucide.createIcons();
  renderProductSearch();
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
    else if (action === 'edit') editPalletRow(palletId);
    else if (action === 'pair') quickPairRow(palletId);
    else if (action === 'ship') shipPalletRow(palletId);
    else if (action === 'unship') unshipPalletRow(palletId);
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

function editPalletRow(palletId) {
  const p = pallets.find(x => x.id === palletId);
  if (!p) {
    showToast('Η παλέτα δεν βρέθηκε', 'error');
    return;
  }
  const customerEl = document.getElementById('customerName');
  const palletEl = document.getElementById('palletId');
  if (customerEl) customerEl.value = p.customer || '';
  if (palletEl) palletEl.value = p.id || '';
  setProductRowsFromItems(p.items);
  switchTab('tab-generate');
  showToast(`Επεξεργασία παλέτας ${p.id} — πρόσθεσε προϊόντα και πάτα Δημιουργία/Αποθήκευση`, 'success');
}

function quickPairRow(palletId) {
  simulatePalletScan(palletId);
  switchTab('tab-link');
}

let pendingShipPalletId = null;

function shipPalletRow(palletId) {
  const p = pallets.find(x => x.id === palletId);
  if (!p) {
    showToast('Η παλέτα δεν βρέθηκε', 'error');
    return;
  }
  if (p.status === 'shipped') {
    showToast('Η παλέτα έχει ήδη εξαχθεί', 'error');
    return;
  }
  pendingShipPalletId = palletId;
  const modal = document.getElementById('shipModal');
  const idLabel = document.getElementById('shipModalPalletId');
  const toInput = document.getElementById('shipToInput');
  const refInput = document.getElementById('shipRefInput');
  const noteInput = document.getElementById('shipNoteInput');
  if (idLabel) idLabel.textContent = `${p.id} · ${p.customer || ''}`;
  if (toInput) toInput.value = '';
  if (refInput) refInput.value = '';
  if (noteInput) noteInput.value = '';
  if (modal) {
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }
  if (window.lucide) lucide.createIcons();
  if (toInput) setTimeout(() => toInput.focus(), 50);
}

function closeShipModal() {
  pendingShipPalletId = null;
  const modal = document.getElementById('shipModal');
  if (modal) {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }
}

function bindShipModalChrome() {
  const modal = document.getElementById('shipModal');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeShipModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) closeShipModal();
  });
}

function confirmShipPallet() {
  const palletId = pendingShipPalletId;
  if (!palletId) return;
  const p = pallets.find(x => x.id === palletId);
  if (!p) {
    showToast('Η παλέτα δεν βρέθηκε', 'error');
    closeShipModal();
    return;
  }
  const toInput = document.getElementById('shipToInput');
  const refInput = document.getElementById('shipRefInput');
  const noteInput = document.getElementById('shipNoteInput');
  const shippedTo = toInput ? toInput.value.trim() : '';
  const shippedRef = refInput ? refInput.value.trim() : '';
  const shippedNote = noteInput ? noteInput.value.trim() : '';
  if (!shippedTo) {
    showToast('Ο παραλήπτης είναι υποχρεωτικός', 'error');
    if (toInput) toInput.focus();
    return;
  }
  p.status = 'shipped';
  p.shippedAt = new Date().toISOString();
  p.shippedTo = shippedTo;
  p.shippedRef = shippedRef || null;
  p.shippedNote = shippedNote || null;
  p.shelf = null;
  p.locationType = null;
  p.aisleRow = null;
  savePalletsToStorage({ upsertIds: [p.id] });
  closeShipModal();
  renderInventoryTable();
  showToast(`Εξήχθη η παλέτα ${p.id} → ${shippedTo}`, 'success');
}

function unshipPalletRow(palletId) {
  const p = pallets.find(x => x.id === palletId);
  if (!p) {
    showToast('Η παλέτα δεν βρέθηκε', 'error');
    return;
  }
  if (p.status !== 'shipped') {
    showToast('Η παλέτα είναι ήδη στην αποθήκη', 'error');
    return;
  }
  if (!confirm(`Επαναφορά της παλέτας ${palletId} στην αποθήκη;`)) return;
  p.status = 'in_stock';
  p.shippedAt = null;
  p.shippedTo = null;
  p.shippedRef = null;
  p.shippedNote = null;
  savePalletsToStorage({ upsertIds: [p.id] });
  renderInventoryTable();
  showToast(`Η παλέτα ${p.id} επανήλθε στην αποθήκη`, 'success');
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
  const aisleCheck = document.getElementById('shelfAisleTagsCheck');

  const zone = (shelfZoneInput && shelfZoneInput.value ? shelfZoneInput.value.trim().toUpperCase() : '') || 'Α';
  const from = parseInt(shelfFromInput && shelfFromInput.value, 10) || 1;
  const to = parseInt(shelfToInput && shelfToInput.value, 10) || 10;
  const includeAisle = !!(aisleCheck && aisleCheck.checked);

  grid.innerHTML = '';

  const appendTagCard = (opts) => {
    const { key, title, subtitle, qrPayload, footer } = opts;
    const card = document.createElement('div');
    card.className = 'shelf-tag-card' + (opts.aisle ? ' shelf-tag-card-aisle' : '');
    card.dataset.shelfCode = key;
    const qrId = `shelf-qr-${escapeHtml(key).replace(/[^a-zA-Z0-9Α-Ωα-ω_-]/g, '_')}`;
    card.innerHTML = `
      <div class="shelf-tag-location">${title}</div>
      ${subtitle ? `<div class="shelf-tag-sub">${subtitle}</div>` : ''}
      <div id="${qrId}" style="margin: 0.5rem 0;"></div>
      <div style="font-size: 0.65rem; color: #555; text-transform: uppercase;">${footer}</div>
      <button type="button" class="btn btn-secondary btn-sm shelf-tag-print-btn no-print" data-shelf-print="${escapeHtml(key)}">Εκτύπωση</button>
    `;
    grid.appendChild(card);
    const tid = setTimeout(() => {
      if (generation !== shelfGridGeneration) return;
      const target = document.getElementById(qrId);
      if (target) renderQRCode(target, qrPayload, 110);
    }, 50);
    shelfGridTimeouts.push(tid);
  };

  for (let i = from; i <= to; i++) {
    const shelfCode = `${zone}-${i < 10 ? '0' + i : i}`;
    appendTagCard({
      key: shelfCode,
      title: `ΘΕΣΗ: ${escapeHtml(shelfCode)}`,
      subtitle: '',
      qrPayload: `SHELF:${shelfCode}`,
      footer: 'MONLOGISTICS WMS - SHELF TAG',
      aisle: false
    });

    if (includeAisle) {
      for (let row = 1; row <= 4; row++) {
        const aisleKey = formatAisleLocationCode(shelfCode, row);
        appendTagCard({
          key: aisleKey,
          title: escapeHtml(aisleKey),
          subtitle: escapeHtml(`ΔΙΑΔΡΟΜΟΣ μπροστά από ${shelfCode} · Σειρά ${row}`),
          qrPayload: `AISLE:${shelfCode}:${row}`,
          footer: 'MONLOGISTICS WMS - AISLE TAG',
          aisle: true
        });
      }
    }
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
  if (!shelfCode) {
    showToast('Δεν βρέθηκε η ετικέτα ραφιού!', 'error');
    return;
  }
  showToast(`Εκτύπωση ετικέτας ${shelfCode}`, 'success');
  printLabelsSized([locationCodeToLabelSpec(shelfCode)]);
}

function printAllShelfTags() {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid || grid.children.length === 0) {
    showToast('Δεν υπάρχουν ετικέτες ραφιών για εκτύπωση!', 'error');
    return;
  }
  const codes = Array.from(grid.querySelectorAll('.shelf-tag-card')).map((el) => el.dataset.shelfCode).filter(Boolean);
  printLabelsSized(codes.map(locationCodeToLabelSpec));
}

/* ==========================================================================
   DEMO SEED DATA
   ========================================================================== */
function seedSampleData(notify = true) {
  const d = (offsetDays) => {
    const x = new Date();
    x.setDate(x.getDate() + offsetDays);
    const y = x.getFullYear();
    const m = String(x.getMonth() + 1).padStart(2, '0');
    const day = String(x.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const samplePallets = [
    {
      id: 'PL-8820', customer: 'ΔΗΜΗΤΡΙΟΥ Α.Ε.', shelf: 'Α-14', locationType: 'shelf', aisleRow: null,
      items: [
        { name: 'Ελαιόλαδο 5L', qty: 48, expiry: d(45) },
        { name: 'Φέτα ΠΟΠ', qty: 20, expiry: d(5) }
      ],
      createdAt: new Date(Date.now() - 3600000 * 24 * 2).toISOString()
    },
    {
      id: 'PL-4410', customer: 'OLYMPIC LOGISTICS', shelf: 'Β-02', locationType: 'shelf', aisleRow: null,
      items: [
        { name: 'Χαρτί Α4', qty: 100, expiry: null }
      ],
      createdAt: new Date(Date.now() - 3600000 * 24).toISOString()
    },
    { id: 'PL-3309', customer: 'ALPHA BETA CORP', shelf: null, items: [], createdAt: new Date(Date.now() - 3600000 * 5).toISOString() },
    {
      id: 'PL-9912', customer: 'MEDITERRANEAN FOODS', shelf: 'Α-15',
      locationType: 'shelf', aisleRow: null,
      items: [
        { name: 'Γιαούρτι στραγγιστό', qty: 60, expiry: d(-3) },
        { name: 'Μέλι θυμαρίσιο', qty: 24, expiry: d(120) }
      ],
      createdAt: new Date(Date.now() - 3600000 * 2).toISOString()
    },
    {
      id: 'PL-7744', customer: 'HELLAS CARGO', shelf: 'Α-14-Δ2',
      locationType: 'aisle', aisleRow: 2,
      items: [
        { name: 'Νερό 1.5L', qty: 72, expiry: d(90) }
      ],
      createdAt: new Date(Date.now() - 3600000).toISOString()
    },
    { id: 'PL-1105', customer: 'TECHNO PACK', shelf: null, items: [], createdAt: new Date().toISOString() }
  ];

  const addedIds = [];
  samplePallets.forEach(sample => {
    if (!pallets.some(p => p.id === sample.id)) {
      pallets.push(normalizePallet(sample));
      addedIds.push(sample.id);
    }
  });

  savePalletsToStorage({ upsertIds: addedIds });
  renderInventoryTable();

  if (notify) {
    showToast(`Προστέθηκαν ${addedIds.length} δείγματα παλετών με επιτυχία!`, 'success');
  }
}

/* ==========================================================================
   TAB 5: PICKING (order lines + FEFO suggestions)
   ========================================================================== */

function generatePickListId() {
  const n = Math.floor(1000 + Math.random() * 9000);
  let id = `PLK-${n}`;
  let guard = 0;
  while (pickLists.some((x) => x.id === id) && guard < 50) {
    id = `PLK-${Math.floor(1000 + Math.random() * 9000)}`;
    guard += 1;
  }
  return id;
}

function generatePickLineId() {
  return `ln-${Date.now().toString(36)}-${Math.floor(Math.random() * 1000)}`;
}

/** Noise tokens from order slips (ΚΙΒΩΤ, Τ/Κ, ΧΓΛ, …) — ignored for matching. */
const PRODUCT_NAME_NOISE = new Set([
  // After foldSearchText (Greek→Latin): ΚΙΒΩΤ→kivot, ΧΓΛ→xgl, Τ/Κ stripped earlier
  'kivot', 'kivotio', 'kibot',
  'tk', 'tem', 'temax', 'temaxia',
  'xgl', 'xondr', 'xondriki'
]);

/** Fold + strip common slip noise before tokenization. */
function prepareProductMatchText(s) {
  let f = foldSearchText(s);
  // Noise after Latin fold: 15Τ/Κ, Τ/Κ, ΚΙΒΩΤ…, ΧΓΛ
  f = f.replace(/\d+\s*t\s*\/\s*k\b/g, ' ');
  f = f.replace(/\bt\s*\/\s*k\b/g, ' ');
  f = f.replace(/\bkivot\w*/g, ' ');
  f = f.replace(/\bxgl\.?\b/g, ' ');
  return f.replace(/\s+/g, ' ').trim();
}

/** Significant tokens: length ≥ 3, skip numbers-only and noise. Keep weight/size like 350γ. */
function significantProductTokens(folded) {
  const parts = String(folded || '').split(/[^a-z0-9]+/i).filter(Boolean);
  const out = [];
  for (const t of parts) {
    if (t.length < 3) continue;
    if (/^\d+$/.test(t)) continue;
    if (/^\d+t$/.test(t)) continue; // pack counts like 15t from 15Τ/Κ
    if (PRODUCT_NAME_NOISE.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Score name similarity for picking / search.
 * tier 3 exact, 2 contains (either way), 1 token-overlap (most tokens), 0 no match.
 * Low-confidence does not auto-pick — callers only preselect when scan resolves a real pallet.
 */
function itemNameMatchInfo(itemName, productName) {
  const a = prepareProductMatchText(itemName);
  const b = prepareProductMatchText(productName);
  if (!a || !b) return { matches: false, score: 0, tier: 0 };

  if (a === b) return { matches: true, score: 100, tier: 3 };
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    const score = 70 + Math.round(20 * (shorter / longer));
    return { matches: true, score, tier: 2 };
  }

  const ta = significantProductTokens(a);
  const tb = significantProductTokens(b);
  if (!ta.length || !tb.length) return { matches: false, score: 0, tier: 0 };

  // Require most tokens from the smaller set to appear in the other string
  const useA = ta.length <= tb.length;
  const needles = useA ? ta : tb;
  const hayStack = useA ? b : a;
  const hayTokens = useA ? tb : ta;
  let hit = 0;
  for (const tok of needles) {
    const found = hayStack.includes(tok) || hayTokens.some((ht) => ht.includes(tok) || tok.includes(ht));
    if (found) hit += 1;
  }
  const need = Math.floor(needles.length / 2) + 1; // most (>50%)
  if (hit < need) return { matches: false, score: hit, tier: 0 };

  const score = 35 + Math.round(40 * (hit / needles.length));
  return { matches: true, score, tier: 1 };
}

function itemNameMatches(itemName, productName) {
  return itemNameMatchInfo(itemName, productName).matches;
}

function locationTypeLabel(type) {
  if (type === 'aisle') return 'Διάδρομος';
  if (type === 'shelf') return 'Ράφι';
  return 'Θέση';
}

function pickStatusLabel(status) {
  const map = {
    open: 'Ανοιχτή',
    in_progress: 'Σε εξέλιξη',
    done: 'Ολοκληρωμένη',
    cancelled: 'Ακυρωμένη',
    pending: 'Εκκρεμεί'
  };
  return map[status] || status;
}

function normalizePickList(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const linesIn = Array.isArray(p.lines) ? p.lines : [];
  const lines = linesIn.map((ln, idx) => {
    const allocations = Array.isArray(ln && ln.allocations) ? ln.allocations.map((a) => ({
      palletId: a && a.palletId != null ? String(a.palletId) : '',
      locationCode: a && a.locationCode != null ? a.locationCode : null,
      qty: Number(a && a.qty),
      at: a && a.at ? String(a.at) : new Date().toISOString(),
      expiry: a && a.expiry != null && a.expiry !== '' ? String(a.expiry) : null
    })).filter((a) => a.palletId && Number.isFinite(a.qty)) : [];
    const qtyNeeded = Number(ln && ln.qtyNeeded);
    const qtyPicked = Number(ln && ln.qtyPicked);
    const needed = Number.isFinite(qtyNeeded) ? qtyNeeded : 0;
    const picked = Number.isFinite(qtyPicked) ? qtyPicked : 0;
    let status = (ln && ln.status === 'done') ? 'done' : 'pending';
    if (picked >= needed && needed > 0) status = 'done';
    return {
      id: (ln && ln.id) ? String(ln.id) : `ln-${idx}-${generatePickLineId()}`,
      productName: String((ln && ln.productName) || '').trim(),
      qtyNeeded: needed,
      qtyPicked: picked,
      status,
      allocations
    };
  }).filter((ln) => ln.productName);

  let status = p.status;
  if (status !== 'open' && status !== 'in_progress' && status !== 'done' && status !== 'cancelled') {
    status = 'open';
  }
  if (status !== 'cancelled' && lines.length > 0 && lines.every((ln) => ln.qtyPicked >= ln.qtyNeeded && ln.qtyNeeded > 0)) {
    status = 'done';
  } else if (status !== 'cancelled' && status !== 'done' && lines.some((ln) => ln.qtyPicked > 0)) {
    status = 'in_progress';
  }

  return {
    id: p.id ? String(p.id) : generatePickListId(),
    customer: String(p.customer || '').trim(),
    orderRef: String(p.orderRef || '').trim(),
    status,
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: p.updatedAt || p.createdAt || new Date().toISOString(),
    lines
  };
}

function pickListToFirestoreDoc(pl) {
  const n = normalizePickList(pl);
  return {
    customer: n.customer,
    orderRef: n.orderRef,
    status: n.status,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    lines: n.lines
  };
}

function sortPickListsByUpdatedDesc(list) {
  return (list || []).slice().sort((a, b) => {
    const ta = a.updatedAt || a.createdAt || '';
    const tb = b.updatedAt || b.createdAt || '';
    return tb.localeCompare(ta);
  });
}

function mirrorPickListsToLocalCache() {
  try {
    localStorage.setItem(PICKLISTS_KEY, JSON.stringify(pickLists));
  } catch (e) {
    console.error('Failed to mirror pickLists to localStorage:', e);
  }
}

function loadPickListsFromStorage() {
  try {
    const raw = localStorage.getItem(PICKLISTS_KEY);
    if (!raw) {
      pickLists = [];
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(PICKLISTS_KEY);
      pickLists = [];
      return;
    }
    pickLists = sortPickListsByUpdatedDesc(parsed.map(normalizePickList));
  } catch (e) {
    console.error('Failed to load pickLists:', e);
    pickLists = [];
  }
}

function subscribePickLists() {
  if (!db) return;
  if (typeof firestorePickUnsub === 'function') {
    try { firestorePickUnsub(); } catch (_) {}
    firestorePickUnsub = null;
  }
  firestorePickUnsub = db.collection('pickLists').onSnapshot((snap) => {
    applyingPickRemoteSnapshot = true;
    const next = [];
    snap.forEach((d) => {
      const data = d.data() || {};
      next.push(normalizePickList({ id: d.id, ...data }));
    });
    pickLists = sortPickListsByUpdatedDesc(next);
    mirrorPickListsToLocalCache();
    renderPickTab();
    applyingPickRemoteSnapshot = false;
  }, (err) => {
    console.error('Firestore pickLists onSnapshot error:', err);
    toastFirebaseFallback('Σφάλμα συγχρονισμού pick lists — τοπική λειτουργία.');
  });
}

function upsertPickListsToCloud(ids) {
  if (!cloudEnabled || !db || applyingPickRemoteSnapshot) return;
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  unique.forEach((id) => {
    const pl = pickLists.find((x) => x.id === id);
    if (!pl) return;
    db.collection('pickLists').doc(id).set(pickListToFirestoreDoc(pl), { merge: true }).catch((err) => {
      console.error('Firestore pickLists set failed:', id, err);
      setSyncStatus('error');
    });
  });
}

function deletePickListsFromCloud(ids) {
  if (!cloudEnabled || !db || applyingPickRemoteSnapshot) return;
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  unique.forEach((id) => {
    db.collection('pickLists').doc(id).delete().catch((err) => {
      console.error('Firestore pickLists delete failed:', id, err);
      setSyncStatus('error');
    });
  });
}

/**
 * Persist pick lists. options: { upsertIds?: string[], deleteIds?: string[] }
 */
function savePickListsToStorage(options) {
  const opts = options || {};
  mirrorPickListsToLocalCache();
  if (cloudEnabled && db && !applyingPickRemoteSnapshot) {
    const hasDelete = Array.isArray(opts.deleteIds);
    const hasUpsert = Array.isArray(opts.upsertIds);
    if (hasDelete && opts.deleteIds.length) {
      deletePickListsFromCloud(opts.deleteIds);
    }
    if (hasUpsert) {
      upsertPickListsToCloud(opts.upsertIds);
    } else if (!hasDelete) {
      upsertPickListsToCloud(pickLists.map((p) => p.id));
    }
  }
}

/**
 * FEFO helper: in_stock pallets with matching item name & qty>0.
 * Sort by expiry ascending (nulls last), then location code.
 * @returns {{ pallet, itemIndex, available, expiry, locationCode, locationType }[]}
 */
function findPickCandidates(productName, qtyRemaining) {
  void qtyRemaining; // reserved for future soft-filter / prioritization
  const candidates = [];
  const name = String(productName || '').trim();
  if (!name) return candidates;

  pallets.forEach((pallet) => {
    if (!isInStock(pallet)) return;
    const items = Array.isArray(pallet.items) ? pallet.items : [];
    items.forEach((item, itemIndex) => {
      const info = itemNameMatchInfo(item && item.name, name);
      if (!info.matches) return;
      if (item.qty == null || item.qty === '') return; // MVP: require numeric qty
      const available = Number(item.qty);
      if (!Number.isFinite(available) || available <= 0) return;
      let locationType = pallet.locationType === 'aisle' ? 'aisle' : (pallet.locationType === 'shelf' ? 'shelf' : null);
      if (!locationType && pallet.shelf) locationType = 'shelf';
      candidates.push({
        pallet,
        itemIndex,
        available,
        expiry: item.expiry || null,
        locationCode: pallet.shelf || null,
        locationType,
        matchTier: info.tier,
        matchScore: info.score
      });
    });
  });

  candidates.sort((a, b) => {
    // Stronger name match first (exact/contains before weak token overlap)
    if (b.matchTier !== a.matchTier) return b.matchTier - a.matchTier;
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    if (a.expiry && b.expiry) {
      if (a.expiry < b.expiry) return -1;
      if (a.expiry > b.expiry) return 1;
    } else if (a.expiry && !b.expiry) {
      return -1;
    } else if (!a.expiry && b.expiry) {
      return 1;
    }
    const la = String(a.locationCode || '\uffff');
    const lb = String(b.locationCode || '\uffff');
    const locCmp = la.localeCompare(lb, 'el');
    if (locCmp !== 0) return locCmp;
    return String(a.pallet.id).localeCompare(String(b.pallet.id), 'el');
  });

  return candidates;
}

function recomputePickListStatus(pl) {
  if (!pl || pl.status === 'cancelled') return;
  const lines = pl.lines || [];
  if (lines.length > 0 && lines.every((ln) => Number(ln.qtyPicked) >= Number(ln.qtyNeeded) && Number(ln.qtyNeeded) > 0)) {
    pl.status = 'done';
    lines.forEach((ln) => { ln.status = 'done'; });
  } else if (lines.some((ln) => Number(ln.qtyPicked) > 0)) {
    pl.status = 'in_progress';
  } else {
    pl.status = 'open';
  }
  lines.forEach((ln) => {
    if (Number(ln.qtyPicked) >= Number(ln.qtyNeeded) && Number(ln.qtyNeeded) > 0) ln.status = 'done';
    else ln.status = 'pending';
  });
}

/**
 * Confirm a pick: decrement pallet item qty, record allocation, bump line progress.
 */
function confirmPick(listId, lineId, palletId, qty) {
  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    showToast('Μη έγκυρη ποσότητα picking', 'error');
    return false;
  }

  const pl = pickLists.find((x) => x.id === listId);
  if (!pl) {
    showToast('Η λίστα picking δεν βρέθηκε', 'error');
    return false;
  }
  if (pl.status === 'cancelled' || pl.status === 'done') {
    showToast('Η λίστα δεν δέχεται άλλα picks', 'error');
    return false;
  }

  const line = (pl.lines || []).find((ln) => ln.id === lineId);
  if (!line) {
    showToast('Η γραμμή δεν βρέθηκε', 'error');
    return false;
  }

  const remaining = Math.max(0, Number(line.qtyNeeded) - Number(line.qtyPicked));
  if (qtyNum > remaining + 1e-9) {
    showToast(`Η ποσότητα υπερβαίνει τα υπόλοιπα (${remaining})`, 'error');
    return false;
  }

  const pallet = pallets.find((p) => p.id === palletId);
  if (!pallet || !isInStock(pallet)) {
    showToast('Η παλέτα δεν είναι διαθέσιμη (in stock)', 'error');
    return false;
  }

  const items = Array.isArray(pallet.items) ? pallet.items : [];
  let itemIndex = -1;
  for (let i = 0; i < items.length; i++) {
    if (!itemNameMatches(items[i] && items[i].name, line.productName)) continue;
    if (items[i].qty == null || items[i].qty === '') {
      showToast('Η ποσότητα στο είδος παλέτας λείπει — ορίστε qty πρώτα', 'error');
      return false;
    }
    const avail = Number(items[i].qty);
    if (!Number.isFinite(avail) || avail <= 0) continue;
    itemIndex = i;
    break;
  }

  // Prefer FEFO-matched index if multiple; fall back to first with enough qty
  const candidates = findPickCandidates(line.productName, remaining);
  const preferred = candidates.find((c) => c.pallet.id === palletId && c.available + 1e-9 >= qtyNum);
  if (preferred) {
    itemIndex = preferred.itemIndex;
  } else if (itemIndex < 0) {
    showToast('Δεν βρέθηκε είδος με αρκετή ποσότητα στην παλέτα', 'error');
    return false;
  }

  const item = pallet.items[itemIndex];
  if (!item || item.qty == null || item.qty === '') {
    showToast('Η ποσότητα στο είδος παλέτας λείπει — ορίστε qty πρώτα', 'error');
    return false;
  }
  const available = Number(item.qty);
  if (!Number.isFinite(available)) {
    showToast('Μη έγκυρη ποσότητα είδους παλέτας', 'error');
    return false;
  }
  if (available + 1e-9 < qtyNum) {
    showToast(`Ανεπαρκές απόθεμα στην παλέτα (διαθέσιμο: ${available})`, 'error');
    return false;
  }

  item.qty = Math.max(0, available - qtyNum);
  const locationCode = pallet.shelf || null;
  const expiry = item.expiry || null;

  if (!Array.isArray(line.allocations)) line.allocations = [];
  line.allocations.push({
    palletId: pallet.id,
    locationCode,
    qty: qtyNum,
    at: new Date().toISOString(),
    expiry
  });
  line.qtyPicked = Number(line.qtyPicked || 0) + qtyNum;
  if (line.qtyPicked >= line.qtyNeeded) line.status = 'done';
  else line.status = 'pending';

  pl.updatedAt = new Date().toISOString();
  recomputePickListStatus(pl);

  savePalletsToStorage({ upsertIds: [pallet.id] });
  savePickListsToStorage({ upsertIds: [pl.id] });
  renderInventoryTable();
  renderPickTab();

  showToast(`Picked ${qtyNum} × ${line.productName} από ${pallet.id}`, 'success');
  return true;
}

function initPickTabUI() {
  resetPickLineRows();
  renderPickTab();
  const fileEl = document.getElementById('pickImportFile');
  if (fileEl && !fileEl.dataset.bound) {
    fileEl.dataset.bound = '1';
    fileEl.addEventListener('change', onPickImportFileChange);
  }
}

function addPickLineRow(prefill) {
  const container = document.getElementById('pickLineRows');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'pick-line-row';
  const nameVal = prefill && prefill.name ? String(prefill.name) : '';
  const qtyVal = prefill && prefill.qty != null && prefill.qty !== '' ? String(prefill.qty) : '';
  row.innerHTML = `
    <input type="text" class="form-input pick-line-name-input" placeholder="Όνομα προϊόντος" autocomplete="off" value="${escapeHtml(nameVal)}">
    <input type="number" class="form-input pick-line-qty-input" placeholder="Ποσ." min="0.01" step="any" inputmode="decimal" value="${escapeHtml(qtyVal)}">
    <button type="button" class="btn btn-secondary btn-sm" onclick="removePickLineRow(this)" title="Αφαίρεση">
      <i data-lucide="trash-2" style="width: 14px;"></i>
    </button>
  `;
  container.appendChild(row);
  if (window.lucide) lucide.createIcons();
}

function removePickLineRow(btn) {
  const container = document.getElementById('pickLineRows');
  if (!container || !btn) return;
  const row = btn.closest('.pick-line-row');
  if (!row) return;
  row.remove();
  if (container.querySelectorAll('.pick-line-row').length === 0) {
    addPickLineRow();
  }
}

function resetPickLineRows() {
  const container = document.getElementById('pickLineRows');
  if (!container) return;
  container.innerHTML = '';
  addPickLineRow();
}

function collectPickLineInputs() {
  const container = document.getElementById('pickLineRows');
  if (!container) return [];
  const lines = [];
  container.querySelectorAll('.pick-line-row').forEach((row) => {
    const nameEl = row.querySelector('.pick-line-name-input');
    const qtyEl = row.querySelector('.pick-line-qty-input');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) return;
    const qty = qtyEl && qtyEl.value !== '' ? Number(qtyEl.value) : NaN;
    if (!Number.isFinite(qty) || qty <= 0) return;
    lines.push({ productName: name, qtyNeeded: qty });
  });
  return lines;
}

function commitNewPickList(customer, orderRef, lineInputs) {
  const now = new Date().toISOString();
  const pl = normalizePickList({
    id: generatePickListId(),
    customer,
    orderRef,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    lines: lineInputs.map((ln) => ({
      id: generatePickLineId(),
      productName: ln.productName,
      qtyNeeded: ln.qtyNeeded,
      qtyPicked: 0,
      status: 'pending',
      allocations: []
    }))
  });

  pickLists.unshift(pl);
  savePickListsToStorage({ upsertIds: [pl.id] });
  activePickListId = pl.id;
  renderPickTab();
  showToast(`Δημιουργήθηκε λίστα ${pl.id}`, 'success');
  return pl;
}

function createPickList() {
  const customerEl = document.getElementById('pickCustomerInput');
  const orderEl = document.getElementById('pickOrderRefInput');
  const customer = customerEl ? customerEl.value.trim() : '';
  const orderRef = orderEl ? orderEl.value.trim() : '';
  const lineInputs = collectPickLineInputs();

  if (!customer || !orderRef) {
    showToast('Συμπληρώστε πελάτη και αρ. παραγγελίας', 'error');
    return;
  }
  if (!lineInputs.length) {
    showToast('Προσθέστε τουλάχιστον μία γραμμή με όνομα και ποσότητα', 'error');
    return;
  }

  commitNewPickList(customer, orderRef, lineInputs);

  if (customerEl) customerEl.value = '';
  if (orderEl) orderEl.value = '';
  resetPickLineRows();
}


/* --------------------------------------------------------------------------
   Excel / CSV import → pick list
   -------------------------------------------------------------------------- */

// Description-like headers win over code-like when both are present (productIdx).
const IMPORT_PRODUCT_DESC_HEADERS = [
  'προϊόν', 'προϊον', 'ειδος', 'είδος', 'περιγραφή', 'περιγραφη',
  'description', 'product', 'item', 'name', 'όνομα', 'ονομα'
];
// Code-only (incl. compound «κωδικός είδος» — must not beat περιγραφή for product name)
const IMPORT_PRODUCT_CODE_HEADERS = [
  'κωδικός είδος', 'κωδικος ειδος', 'κωδικός', 'κωδικος', 'code', 'sku', 'barcode'
];
const IMPORT_PRODUCT_HEADERS = IMPORT_PRODUCT_DESC_HEADERS.concat(IMPORT_PRODUCT_CODE_HEADERS);
const IMPORT_QTY_HEADERS = [
  'ποσότητα', 'ποσοτητα', 'πος', 'ποσ', 'qty', 'quantity', 'τεμ', 'τμχ', 'pcs', 'ποσό', 'ποσο'
];
const IMPORT_CUSTOMER_HEADERS = [
  'πελάτης', 'πελατης', 'customer', 'client', 'πελάτη', 'πελατη', 'επωνυμία', 'επωνυμια'
];
const IMPORT_ORDER_HEADERS = [
  'παραγγελία', 'παραγγελια', 'order', 'αρ.παραγγελίας', 'αρ παραγγελίας', 'αρ. παραγγελίας',
  'document', 'δοκ', 'doc', 'αρ.παραγγελιας', 'orderref', 'order ref', 'ref', 'αριθμός', 'αριθμος'
];

function normalizeImportHeader(h) {
  return String(h == null ? '' : h)
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function headerMatches(normalized, synonyms) {
  if (!normalized) return false;
  const compact = normalized.replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
  return synonyms.some((s) => {
    const syn = normalizeImportHeader(s);
    if (!syn) return false;
    const synCompact = syn.replace(/[.\-_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (compact === synCompact || normalized === syn) return true;
    // Short tokens (item, name, qty, pcs…) must be exact to avoid matching data rows
    if (synCompact.length <= 4) return false;
    // Longer synonyms: allow contains either way (e.g. "αρ παραγγελίας", "ποσότητα")
    if (compact.includes(synCompact) || synCompact.includes(compact)) return true;
    return false;
  });
}

function parseImportQty(raw) {
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  let s = String(raw).trim().replace(/\s/g, '');
  if (!s) return NaN;
  // Greek Excel: 1.234,56 or 12,5
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function detectCsvDelimiter(firstLine) {
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  return semis > commas ? ';' : ',';
}

function parseCsvText(text) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '');
  const firstNL = cleaned.search(/\r?\n/);
  const firstLine = firstNL === -1 ? cleaned : cleaned.slice(0, firstNL);
  const delim = detectCsvDelimiter(firstLine);

  const out = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (inQuotes) {
      if (ch === '"') {
        if (cleaned[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function mapImportColumns(headerRow) {
  const norms = headerRow.map(normalizeImportHeader);
  let descIdx = -1;
  let codeIdx = -1;
  let productCodeIdx = -1;
  let qtyIdx = -1;
  let customerIdx = -1;
  let orderIdx = -1;

  norms.forEach((h, idx) => {
    // Code headers first so «κωδικός είδος» is code-only (not είδος/description)
    if (headerMatches(h, IMPORT_PRODUCT_CODE_HEADERS)) {
      if (codeIdx < 0) codeIdx = idx;
      if (productCodeIdx < 0) productCodeIdx = idx;
    } else if (descIdx < 0 && headerMatches(h, IMPORT_PRODUCT_DESC_HEADERS)) {
      descIdx = idx;
    }
    if (qtyIdx < 0 && headerMatches(h, IMPORT_QTY_HEADERS)) qtyIdx = idx;
    if (customerIdx < 0 && headerMatches(h, IMPORT_CUSTOMER_HEADERS)) customerIdx = idx;
    if (orderIdx < 0 && headerMatches(h, IMPORT_ORDER_HEADERS)) orderIdx = idx;
  });

  // Prefer description over code for product name column
  const productIdx = descIdx >= 0 ? descIdx : codeIdx;
  const looksLikeHeader = productIdx >= 0 || qtyIdx >= 0 || customerIdx >= 0 || orderIdx >= 0;
  return { productIdx, qtyIdx, customerIdx, orderIdx, productCodeIdx, descIdx, codeIdx, looksLikeHeader, norms };
}

function extractLinesFromMatrix(matrix) {
  if (!matrix || !matrix.length) {
    return { lines: [], customer: '', orderRef: '', error: 'Το αρχείο είναι κενό' };
  }

  const headerMap = mapImportColumns(matrix[0]);
  let startRow = 0;
  let productIdx = headerMap.productIdx;
  let qtyIdx = headerMap.qtyIdx;
  let customerIdx = headerMap.customerIdx;
  let orderIdx = headerMap.orderIdx;

  // If product header missing but qty found: use the single remaining text column
  if (qtyIdx >= 0 && productIdx < 0) {
    const used = new Set([qtyIdx, customerIdx, orderIdx].filter((x) => x >= 0));
    const candidates = [];
    headerMap.norms.forEach((h, idx) => {
      if (used.has(idx)) return;
      if (!h) return;
      candidates.push(idx);
    });
    if (candidates.length === 1) productIdx = candidates[0];
  }

  const hasMappedCols = productIdx >= 0 && qtyIdx >= 0;
  if (hasMappedCols) {
    startRow = 1;
  } else {
    // Headers missing / unrecognized — first two columns as product + qty
    productIdx = 0;
    qtyIdx = matrix[0].length > 1 ? 1 : -1;
    customerIdx = -1;
    orderIdx = -1;
    startRow = 0;
  }

  if (productIdx < 0 || qtyIdx < 0) {
    return {
      lines: [],
      customer: '',
      orderRef: '',
      error: 'Δεν βρέθηκαν στήλες προϊόντος / ποσότητας. Χρησιμοποιήστε κεφαλίδες όπως «Προϊόν» και «Ποσότητα».'
    };
  }

  const lines = [];
  let customer = '';
  let orderRef = '';

  for (let r = startRow; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const name = String(row[productIdx] != null ? row[productIdx] : '').trim();
    const qty = parseImportQty(row[qtyIdx]);
    if (!name && (row[qtyIdx] == null || String(row[qtyIdx]).trim() === '')) continue;
    if (!name) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const line = { productName: name, qtyNeeded: qty };
    if (headerMap.productCodeIdx >= 0 && headerMap.productCodeIdx !== productIdx) {
      const code = String(row[headerMap.productCodeIdx] != null ? row[headerMap.productCodeIdx] : '').trim();
      if (code) line.productCode = code;
    }
    lines.push(line);

    if (customerIdx >= 0 && !customer) {
      const c = String(row[customerIdx] != null ? row[customerIdx] : '').trim();
      if (c) customer = c;
    }
    if (orderIdx >= 0 && !orderRef) {
      const o = String(row[orderIdx] != null ? row[orderIdx] : '').trim();
      if (o) orderRef = o;
    }
  }

  // Also try customer/order from header row values if single-value meta columns somehow — skip
  if (!lines.length) {
    return {
      lines: [],
      customer,
      orderRef,
      error: 'Δεν βρέθηκαν έγκυρες γραμμές (προϊόν + θετική ποσότητα)'
    };
  }

  return { lines, customer, orderRef, error: null };
}

function matrixFromExcelArrayBuffer(buf) {
  if (typeof XLSX === 'undefined') {
    throw new Error('Η βιβλιοθήκη SheetJS δεν φορτώθηκε');
  }
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, raw: false });
  const sheetName = wb.SheetNames && wb.SheetNames[0];
  if (!sheetName) throw new Error('Το Excel δεν έχει φύλλα');
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  return matrix;
}

/* --------------------------------------------------------------------------
   PDF import (text layer + OCR for scans) → same matrix / preview flow
   -------------------------------------------------------------------------- */

const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const PDF_TEXT_MIN_CHARS = 40;

function ensurePdfJsReady() {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('Η βιβλιοθήκη pdf.js δεν φορτώθηκε');
  }
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
  }
  return pdfjsLib;
}

async function extractPdfTextLayer(arrayBuffer) {
  const pdfjs = ensurePdfJsReady();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const parts = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const line = (content.items || []).map((it) => (it && it.str != null ? String(it.str) : '')).join(' ');
    if (line.trim()) parts.push(line);
  }
  return parts.join('\n').trim();
}

async function renderPdfPagesToCanvases(arrayBuffer, scale) {
  const pdfjs = ensurePdfJsReady();
  const loadingTask = pdfjs.getDocument({ data: arrayBuffer.slice(0) });
  const pdf = await loadingTask.promise;
  const canvases = [];
  const s = scale || 2.2;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: s });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
  }
  return canvases;
}

async function ocrCanvasesGreekEng(canvases, onStatus) {
  if (typeof Tesseract === 'undefined') {
    throw new Error('Η βιβλιοθήκη Tesseract.js δεν φορτώθηκε');
  }
  if (typeof onStatus === 'function') onStatus('Διαβάζω το PDF…');
  const worker = await Tesseract.createWorker('ell+eng');
  try {
    const parts = [];
    for (let i = 0; i < canvases.length; i++) {
      if (typeof onStatus === 'function' && canvases.length > 1) {
        onStatus(`Διαβάζω το PDF… (${i + 1}/${canvases.length})`);
      }
      const result = await worker.recognize(canvases[i]);
      const t = result && result.data && result.data.text ? result.data.text : '';
      if (t.trim()) parts.push(t);
    }
    return parts.join('\n').trim();
  } finally {
    try { await worker.terminate(); } catch (_) { /* ignore */ }
  }
}

function isSlipHeaderOrTotalLine(line) {
  const n = normalizeImportHeader(line);
  if (!n) return true;
  if (/σύνολο|συνολο|total|υποσυνολο|υποσύνολο|διακινουμενη|διακινούμενη/.test(n)) return true;
  if (/εκδοση|έκδοση|παραλαβη|παραλαβή|camscanner/.test(n)) return true;
  if (/^παραγγελια\b/.test(n) && !/30-\d{6,}/.test(line)) return true;
  if (/(αλφατασκ|alfatask|θεσσαλονικ|αθην|οδος|οδός|τηλ\.|αφμ|ισωνυμ|ισώνυμ)/.test(n)
      && !/30-\d{6,}/.test(line)) {
    return true;
  }
  if (/κωδικος|κωδικός|περιγραφη|περιγραφή|ποσοτητα|ποσότητα|αποθηκευτικη|αποθηκευτική|θεση|θέση/.test(n)
      && !/\d{2}-\d{5,}/.test(line) && !/\d+[.,]\d{2}/.test(line)) {
    // header-ish without product codes / qty decimals
    if (/κωδικος|περιγραφ|ποσοτ|ειδος|είδος|μ\.μ|μμ\b/.test(n)) return true;
  }
  return false;
}

/** Normalize OCR dashes and whitespace for slip parsing. */
function normalizeSlipText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[–—−]/g, '-') // en-dash / em-dash / minus → hyphen
    .replace(/\u00a0/g, ' ');
}

/**
 * From a product segment (text after the 30- code), extract description + qty.
 * Qty prefers trailing 1.00 / 3.00, else last plain integer after ΚΙΒΩΤ / loc.
 */
function extractDescAndQtyFromSlipSegment(segment) {
  let s = String(segment || '').replace(/\s+/g, ' ').trim();
  // Cut trailer / totals that OCR glued onto the last product
  // Avoid \\b — it does not work with Greek letters in JS.
  s = s.replace(/\s+(?:Διακινούμενη|ΔΙΑΚΙΝΟΥΜΕΝΗ|Διακινουμενη|ΕΚΔΟΣΗ|ΈΚΔΟΣΗ|ΠΑΡΑΛΑΒΗ|CamScanner|Σύνολο|ΣΥΝΟΛΟ|TOTAL)(?:\s|$)[\s\S]*$/i, '').trim();

  let qtyRaw = '';
  // Prefer decimal qty at end (1.00, 3.00)
  let qm = s.match(/(\d+[.,]\d{1,3})\s*$/);
  if (qm) {
    qtyRaw = qm[1];
    s = s.slice(0, qm.index).trim();
  } else {
    // Trailing integer after whitespace (packing like 15Τ/Κ does not end the string)
    qm = s.match(/\s(\d{1,4})\s*$/);
    if (qm) {
      qtyRaw = qm[1];
      s = s.slice(0, qm.index).trim();
    }
  }

  // Strip unit + storage location from description (no \\b — Greek-safe)
  s = s.replace(/(?:^|\s)ΚΙΒΩΤ(?:ΙΑ)?(?=\s|$)/gi, ' ');
  s = s.replace(/(?:^|\s)Μ\.?\s*Μ\.?(?=\s|$)/gi, ' ');
  s = s.replace(/(?:^|\s)\d{3,5}(?:-\d{2,4})?\/[A-Za-zΑ-Ωα-ωΆ-ώ]{1,4}(?=\s|$)/g, ' ');
  s = s.replace(/^[-–•·.,;:]+/, '').replace(/\s+/g, ' ').trim();

  return { desc: s, qtyRaw };
}

function extractMetaFromSlipText(text) {
  let customer = '';
  let orderRef = '';
  const raw = normalizeSlipText(text);

  const custRe = /ΕΠΩΝΥΜΙΑ[:\s]*([^\n\r]+?)(?=\s*(?:ΑΦΜ|Α\.?Φ\.?Μ\.?|ΑΡΙΘΜΟΣ|ΗΜΕΡΟΜΗΝΙΑ|ΠΑΡΑΓΓΕΛΙΑ|ΚΩΔΙΚΟΣ|30-)|$)/i;
  const mCust = raw.match(custRe);
  if (mCust) {
    customer = mCust[1].replace(/ΑΦΜ.*$/i, '').replace(/\s{2,}/g, ' ').trim();
  }
  if (!customer) {
    const mCh = raw.match(/\b(ΧΑΙΤΟΓΛΟΥ[^\n\r,]{0,60})/i);
    if (mCh) customer = mCh[1].replace(/\s{2,}/g, ' ').trim();
  }

  const orderRes = [
    /ΑΡΙΘΜΟΣ\s*(?:ΠΑΡΑΓΓΕΛΙΑΣ)?[:\s#]*([0-9]{2,})/i,
    /ΠΑΡΑΓΓΕΛΙΑ[:\s#]*([0-9]{2,})/i,
    /ΠΑΡΑΓΓΕΛΙΑ\s+[^\d\n]{0,30}?([0-9]{2,6})\b/i,
    /ORDER\s*(?:NO|REF|#)?[:\s]*([0-9]{2,})/i
  ];
  for (const re of orderRes) {
    const m = raw.match(re);
    if (m) {
      orderRef = m[1].trim();
      break;
    }
  }
  return { customer, orderRef };
}

/**
 * Parse CamScanner / order-slip OCR text into a matrix compatible with extractLinesFromMatrix.
 * Splits on every product code 30-… (works even when OCR returns one long blob with en-dashes).
 * Rows: code, description (product name), qty — prefer description over code for display.
 */
function parseOrderSlipTextToMatrix(text) {
  const normalized = normalizeSlipText(text);
  const { customer, orderRef } = extractMetaFromSlipText(normalized);
  const matrix = [['ΚΩΔΙΚΟΣ', 'ΠΕΡΙΓΡΑΦΗ', 'ΠΟΣΟΤΗΤΑ', 'ΠΕΛΑΤΗΣ', 'ΠΑΡΑΓΓΕΛΙΑ']];

  const codeRe = /30-\d{6,}/g;
  const matches = Array.from(normalized.matchAll(codeRe));

  if (matches.length) {
    for (let i = 0; i < matches.length; i++) {
      const code = matches[i][0];
      const segStart = matches[i].index + code.length;
      const segEnd = i + 1 < matches.length ? matches[i + 1].index : normalized.length;
      const { desc, qtyRaw } = extractDescAndQtyFromSlipSegment(normalized.slice(segStart, segEnd));

      if (!desc || desc.length < 3) continue;
      if (isSlipHeaderOrTotalLine(desc)) continue;
      if (/^(επωνυμια|αριθμος|ημερομηνια|σελίδα|σελιδα|παραγγελια)/i.test(normalizeImportHeader(desc))) continue;
      if (!/[A-Za-zΑ-Ωα-ωΆ-ώ]/.test(desc)) continue;
      if (!qtyRaw) continue;

      matrix.push([code, desc, qtyRaw, customer, orderRef]);
    }
    return { matrix, customer, orderRef };
  }

  // Fallback only when no 30- codes: line-oriented parse (newline-separated slips)
  const lines = normalized.split(/\n+/);
  const rowRe = /^(?:\s*(30-\d{6,})\s+)?(.+?)\s+(\d+(?:[.,]\d{1,3})?)\s*$/;

  for (const rawLine of lines) {
    let line = String(rawLine || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isSlipHeaderOrTotalLine(line)) continue;
    line = line.replace(/^[-–•·]+\s*/, '');

    const m = line.match(rowRe);
    if (!m) continue;
    let code = (m[1] || '').trim();
    let desc = (m[2] || '').trim();
    const qtyRaw = (m[3] || '').trim();

    if (isSlipHeaderOrTotalLine(desc)) continue;
    if (/^(επωνυμια|αριθμος|ημερομηνια|σελίδα|σελιδα)/i.test(normalizeImportHeader(desc))) continue;

    if (!code) {
      const peel = desc.match(/^(30-\d{6,})\s+(.+)$/);
      if (peel) {
        code = peel[1];
        desc = peel[2].trim();
      }
    }

    const cleaned = extractDescAndQtyFromSlipSegment(desc + (qtyRaw ? ' ' + qtyRaw : ''));
    const finalDesc = cleaned.desc || desc;
    const finalQty = cleaned.qtyRaw || qtyRaw;
    if (!/[A-Za-zΑ-Ωα-ωΆ-ώ]/.test(finalDesc)) continue;
    if (finalDesc.length < 3) continue;
    if (!finalQty) continue;

    matrix.push([code, finalDesc, finalQty, customer, orderRef]);
  }

  return { matrix, customer, orderRef };
}

async function matrixFromPdfFile(file, onStatus) {
  const buf = await file.arrayBuffer();
  // pdf.js may transfer/detach the ArrayBuffer — keep a copy for OCR fallback
  const bufForOcr = buf.slice(0);
  let text = '';
  try {
    text = await extractPdfTextLayer(buf);
  } catch (err) {
    console.warn('PDF text layer failed, will try OCR:', err);
    text = '';
  }

  if (!text || text.replace(/\s/g, '').length < PDF_TEXT_MIN_CHARS) {
    if (typeof onStatus === 'function') onStatus('Διαβάζω το PDF…');
    showToast('Διαβάζω το PDF…', 'success');
    const canvases = await renderPdfPagesToCanvases(bufForOcr, 2.2);
    text = await ocrCanvasesGreekEng(canvases, onStatus);
  }

  if (!text || !text.trim()) {
    throw new Error('Δεν διαβάστηκε κείμενο από το PDF');
  }

  const parsed = parseOrderSlipTextToMatrix(text);
  if (!parsed.matrix || parsed.matrix.length <= 1) {
    throw new Error(
      'Δεν βρέθηκαν γραμμές προϊόντων στο PDF. Ελέγξτε την προεπισκόπηση του κειμένου ή δοκιμάστε εισαγωγή από Excel/CSV.'
    );
  }
  return { matrix: parsed.matrix, customer: parsed.customer, orderRef: parsed.orderRef, rawText: text };
}

function clearPickImport(opts) {
  const keepFile = opts && opts.keepFile;
  pickImportLines = [];
  pickImportMeta = { customer: '', orderRef: '' };
  const meta = document.getElementById('pickImportMeta');
  const wrap = document.getElementById('pickImportPreviewWrap');
  const tbody = document.getElementById('pickImportTbody');
  const count = document.getElementById('pickImportCount');
  const cust = document.getElementById('pickImportCustomer');
  const ord = document.getElementById('pickImportOrderRef');
  if (meta) meta.hidden = true;
  if (wrap) wrap.hidden = true;
  if (tbody) tbody.innerHTML = '';
  if (count) count.textContent = '0';
  if (cust) cust.value = '';
  if (ord) ord.value = '';
  if (!keepFile) {
    const fileEl = document.getElementById('pickImportFile');
    if (fileEl) fileEl.value = '';
  }
}

function renderPickImportPreview() {
  const meta = document.getElementById('pickImportMeta');
  const wrap = document.getElementById('pickImportPreviewWrap');
  const tbody = document.getElementById('pickImportTbody');
  const count = document.getElementById('pickImportCount');
  const cust = document.getElementById('pickImportCustomer');
  const ord = document.getElementById('pickImportOrderRef');
  if (!tbody || !wrap || !meta) return;

  if (cust && document.activeElement !== cust) cust.value = pickImportMeta.customer || '';
  if (ord && document.activeElement !== ord) ord.value = pickImportMeta.orderRef || '';

  meta.hidden = false;
  wrap.hidden = false;
  if (count) count.textContent = String(pickImportLines.length);

  tbody.innerHTML = pickImportLines.map((ln, idx) => `
    <tr data-idx="${idx}">
      <td class="pick-import-idx">${idx + 1}</td>
      <td>
        <input type="text" class="form-input pick-import-name-input" value="${escapeHtml(ln.productName)}" data-idx="${idx}" onchange="updatePickImportLine(${idx}, 'productName', this.value)" oninput="updatePickImportLine(${idx}, 'productName', this.value)">
      </td>
      <td>
        <input type="number" class="form-input pick-import-qty-input" min="0.01" step="any" inputmode="decimal" value="${escapeHtml(String(ln.qtyNeeded))}" data-idx="${idx}" onchange="updatePickImportLine(${idx}, 'qtyNeeded', this.value)" oninput="updatePickImportLine(${idx}, 'qtyNeeded', this.value)">
      </td>
      <td>
        <button type="button" class="btn btn-secondary btn-sm" onclick="removePickImportLine(${idx})" title="Αφαίρεση">
          <i data-lucide="trash-2" style="width: 14px;"></i>
        </button>
      </td>
    </tr>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

function updatePickImportLine(idx, field, value) {
  const ln = pickImportLines[idx];
  if (!ln) return;
  if (field === 'productName') {
    ln.productName = String(value || '').trim();
  } else if (field === 'qtyNeeded') {
    const n = parseImportQty(value);
    ln.qtyNeeded = Number.isFinite(n) ? n : NaN;
  }
}

function removePickImportLine(idx) {
  if (idx < 0 || idx >= pickImportLines.length) return;
  pickImportLines.splice(idx, 1);
  if (!pickImportLines.length) {
    clearPickImport();
    showToast('Δεν απέμειναν γραμμές — καθαρίστηκε η προεπισκόπηση', 'error');
    return;
  }
  renderPickImportPreview();
}

async function onPickImportFileChange(ev) {
  const file = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!file) {
    clearPickImport();
    return;
  }

  const name = (file.name || '').toLowerCase();
  const isCsv = name.endsWith('.csv') || (file.type && file.type.indexOf('csv') >= 0);
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
  const isPdf = name.endsWith('.pdf') || (file.type && file.type.indexOf('pdf') >= 0);

  if (!isCsv && !isExcel && !isPdf) {
    showToast('Μη υποστηριζόμενος τύπος αρχείου. Χρησιμοποιήστε .xlsx, .xls, .csv ή .pdf', 'error');
    clearPickImport();
    return;
  }

  try {
    let matrix;
    let pdfMeta = { customer: '', orderRef: '' };
    if (isCsv) {
      const text = await file.text();
      matrix = parseCsvText(text);
    } else if (isPdf) {
      const pdfResult = await matrixFromPdfFile(file, (msg) => {
        /* status toast already shown once for OCR */
      });
      matrix = pdfResult.matrix;
      pdfMeta = { customer: pdfResult.customer || '', orderRef: pdfResult.orderRef || '' };
    } else {
      const buf = await file.arrayBuffer();
      matrix = matrixFromExcelArrayBuffer(buf);
    }

    const result = extractLinesFromMatrix(matrix);
    if (result.error) {
      clearPickImport({ keepFile: true });
      showToast(result.error, 'error');
      return;
    }

    pickImportLines = result.lines.map((ln) => ({
      productName: ln.productName,
      qtyNeeded: ln.qtyNeeded,
      productCode: ln.productCode || ''
    }));
    pickImportMeta = {
      customer: result.customer || pdfMeta.customer || '',
      orderRef: result.orderRef || pdfMeta.orderRef || ''
    };
    renderPickImportPreview();
    showToast(`Διαβάστηκαν ${pickImportLines.length} γραμμές από το αρχείο`, 'success');
  } catch (err) {
    console.error('Pick import failed:', err);
    clearPickImport({ keepFile: true });
    showToast(err && err.message ? err.message : 'Αποτυχία ανάγνωσης αρχείου', 'error');
  }
}

function createPickListFromImport() {
  const custEl = document.getElementById('pickImportCustomer');
  const ordEl = document.getElementById('pickImportOrderRef');
  const customer = custEl ? custEl.value.trim() : (pickImportMeta.customer || '');
  const orderRef = ordEl ? ordEl.value.trim() : (pickImportMeta.orderRef || '');

  // Sync editable preview rows
  const tbody = document.getElementById('pickImportTbody');
  if (tbody) {
    tbody.querySelectorAll('tr[data-idx]').forEach((tr) => {
      const idx = Number(tr.getAttribute('data-idx'));
      const nameEl = tr.querySelector('.pick-import-name-input');
      const qtyEl = tr.querySelector('.pick-import-qty-input');
      if (!pickImportLines[idx]) return;
      pickImportLines[idx].productName = nameEl ? nameEl.value.trim() : '';
      pickImportLines[idx].qtyNeeded = qtyEl ? parseImportQty(qtyEl.value) : NaN;
    });
  }

  if (!customer || !orderRef) {
    showToast('Συμπληρώστε πελάτη και αρ. παραγγελίας', 'error');
    return;
  }

  const lineInputs = pickImportLines
    .map((ln) => ({
      productName: String(ln.productName || '').trim(),
      qtyNeeded: Number(ln.qtyNeeded)
    }))
    .filter((ln) => ln.productName && Number.isFinite(ln.qtyNeeded) && ln.qtyNeeded > 0);

  if (!lineInputs.length) {
    showToast('Δεν υπάρχουν έγκυρες γραμμές για δημιουργία λίστας', 'error');
    return;
  }

  commitNewPickList(customer, orderRef, lineInputs);
  clearPickImport();
}

function openPickListDetail(listId) {
  activePickListId = listId;
  renderPickTab();
}

function closePickDetail() {
  activePickListId = null;
  renderPickTab();
}

function cancelPickList(listId) {
  const pl = pickLists.find((x) => x.id === listId);
  if (!pl) return;
  if (pl.status === 'done') {
    showToast('Η λίστα είναι ήδη ολοκληρωμένη', 'error');
    return;
  }
  if (!confirm(`Ακύρωση λίστας ${pl.id};`)) return;
  pl.status = 'cancelled';
  pl.updatedAt = new Date().toISOString();
  savePickListsToStorage({ upsertIds: [pl.id] });
  renderPickTab();
  showToast(`Ακυρώθηκε η λίστα ${pl.id}`, 'success');
}

function markPickListDoneIfReady(listId) {
  const pl = pickLists.find((x) => x.id === listId);
  if (!pl) return;
  recomputePickListStatus(pl);
  if (pl.status !== 'done') {
    showToast('Υπάρχουν ακόμα εκκρεμείς γραμμές', 'error');
    return;
  }
  pl.updatedAt = new Date().toISOString();
  savePickListsToStorage({ upsertIds: [pl.id] });
  renderPickTab();
  showToast(`Η λίστα ${pl.id} ολοκληρώθηκε`, 'success');
}

function renderPickTab() {
  renderOpenPickLists();
  renderPickDetail();
  if (window.lucide) lucide.createIcons();
}

function renderOpenPickLists() {
  const el = document.getElementById('pickOpenLists');
  if (!el) return;
  const open = pickLists.filter((p) => p.status === 'open' || p.status === 'in_progress');
  if (!open.length) {
    el.innerHTML = '<p class="pick-empty">Δεν υπάρχουν ανοιχτές λίστες picking.</p>';
    return;
  }
  el.innerHTML = open.map((pl) => {
    const progress = (pl.lines || []).reduce((acc, ln) => {
      acc.needed += Number(ln.qtyNeeded) || 0;
      acc.picked += Number(ln.qtyPicked) || 0;
      return acc;
    }, { needed: 0, picked: 0 });
    const active = activePickListId === pl.id ? ' active-pick' : '';
    return `
      <button type="button" class="pick-list-card${active}" data-pick-open="${escapeHtml(pl.id)}">
        <div class="pick-list-card-top">
          <div class="pick-list-card-title">${escapeHtml(pl.customer)} · ${escapeHtml(pl.orderRef)}</div>
          <span class="pick-status pick-status-${escapeHtml(pl.status)}">${escapeHtml(pickStatusLabel(pl.status))}</span>
        </div>
        <div class="pick-list-card-meta">
          ${escapeHtml(pl.id)} · ${pl.lines.length} γραμμές · picked ${progress.picked}/${progress.needed}
        </div>
      </button>
    `;
  }).join('');

  el.querySelectorAll('[data-pick-open]').forEach((btn) => {
    btn.addEventListener('click', () => openPickListDetail(btn.getAttribute('data-pick-open')));
  });
}

function renderPickDetail() {
  const card = document.getElementById('pickDetailCard');
  const title = document.getElementById('pickDetailTitle');
  const meta = document.getElementById('pickDetailMeta');
  const linesEl = document.getElementById('pickDetailLines');
  const footer = document.getElementById('pickDetailFooter');
  if (!card || !linesEl) return;

  if (!activePickListId) {
    card.hidden = true;
    linesEl.innerHTML = '';
    if (footer) footer.innerHTML = '';
    const printBtnHide = document.getElementById('btnPrintPickList');
    if (printBtnHide) printBtnHide.hidden = true;
    return;
  }

  const pl = pickLists.find((x) => x.id === activePickListId);
  if (!pl) {
    card.hidden = true;
    activePickListId = null;
    return;
  }

  card.hidden = false;
  if (title) title.textContent = `${pl.customer} · ${pl.orderRef}`;
  if (meta) {
    meta.innerHTML = `${escapeHtml(pl.id)} · <span class="pick-status pick-status-${escapeHtml(pl.status)}">${escapeHtml(pickStatusLabel(pl.status))}</span>`;
  }
  const printBtn = document.getElementById('btnPrintPickList');
  if (printBtn) printBtn.hidden = false;

  const canPick = pl.status === 'open' || pl.status === 'in_progress';

  linesEl.innerHTML = (pl.lines || []).map((ln) => {
    const remaining = Math.max(0, Number(ln.qtyNeeded) - Number(ln.qtyPicked));
    const candidates = canPick && remaining > 0 ? findPickCandidates(ln.productName, remaining) : [];
    const doneCls = ln.status === 'done' ? ' done' : '';
    let candHtml = '';
    if (!canPick) {
      candHtml = '<p class="pick-empty">Η λίστα δεν είναι ενεργή για picking.</p>';
    } else if (remaining <= 0) {
      candHtml = '<p class="pick-empty">Η γραμμή ολοκληρώθηκε.</p>';
    } else if (!candidates.length) {
      candHtml = '<p class="pick-empty">Δεν βρέθηκαν παλέτες FEFO με απόθεμα για αυτό το προϊόν.</p>';
    } else {
      candHtml = `<div class="pick-candidates">${candidates.slice(0, 8).map((c) => {
        const loc = c.locationCode
          ? `${locationTypeLabel(c.locationType)}: ${escapeHtml(c.locationCode)}`
          : 'Χωρίς θέση';
        const expBadge = c.expiry
          ? (() => {
              const st = expiryStatus(c.expiry);
              const cls = st === 'expired' ? 'badge-expired' : (st === 'soon' ? 'badge-soon' : '');
              return ` <span class="badge-expiry ${cls}">λήξη ${escapeHtml(formatExpiryEl(c.expiry))}</span>`;
            })()
          : ' <span class="badge-expiry">χωρίς λήξη</span>';
        return `
          <div class="pick-candidate">
            <div class="pick-candidate-info">
              <div class="pick-candidate-id">${escapeHtml(c.pallet.id)}</div>
              <div class="pick-candidate-meta">${loc} · διαθέσιμο <strong>${c.available}</strong>${expBadge}</div>
            </div>
            <div class="pick-candidate-actions">
              <button type="button" class="btn btn-primary btn-sm"
                data-pick-choose="${escapeHtml(pl.id)}"
                data-line-id="${escapeHtml(ln.id)}"
                data-pallet-id="${escapeHtml(c.pallet.id)}"
                data-available="${c.available}"
                data-expiry="${escapeHtml(c.expiry || '')}">
                <i data-lucide="hand" style="width: 14px;"></i>
                Επιλογή παλέτας
              </button>
            </div>
          </div>
        `;
      }).join('')}</div>`;
    }

    const hist = (ln.allocations || []).length
      ? `<div class="pick-alloc-history"><strong>Ιστορικό:</strong><ul>${
          ln.allocations.map((a) => {
            const when = a.at ? new Date(a.at).toLocaleString('el-GR') : '';
            const loc = a.locationCode ? ` @ ${escapeHtml(a.locationCode)}` : '';
            const exp = a.expiry ? ` · λήξη ${escapeHtml(formatExpiryEl(a.expiry))}` : '';
            return `<li>${escapeHtml(String(a.qty))} από ${escapeHtml(a.palletId)}${loc}${exp} · ${escapeHtml(when)}</li>`;
          }).join('')
        }</ul></div>`
      : '';

    return `
      <div class="pick-line-detail${doneCls}">
        <div class="pick-line-detail-top">
          <div class="pick-line-name">${escapeHtml(ln.productName)}</div>
          <div class="pick-line-progress">
            <strong>${ln.qtyPicked}</strong> / ${ln.qtyNeeded}
            <span class="pick-status pick-status-${ln.status === 'done' ? 'done' : 'open'}">${escapeHtml(pickStatusLabel(ln.status))}</span>
          </div>
        </div>
        ${canPick && remaining > 0 ? `
          <button type="button" class="btn btn-primary pick-scan-btn"
            data-pick-scan="${escapeHtml(pl.id)}" data-line-id="${escapeHtml(ln.id)}">
            <i data-lucide="scan-line" style="width: 18px;"></i>
            Σκανάρισμα παλέτας
          </button>
        ` : ''}
        ${candHtml}
        ${hist}
      </div>
    `;
  }).join('');

  linesEl.querySelectorAll('[data-pick-choose]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openPickModal({
        listId: btn.getAttribute('data-pick-choose'),
        lineId: btn.getAttribute('data-line-id'),
        palletId: btn.getAttribute('data-pallet-id'),
        available: Number(btn.getAttribute('data-available')),
        expiry: btn.getAttribute('data-expiry') || null,
        mode: 'direct'
      });
    });
  });

  linesEl.querySelectorAll('[data-pick-scan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      startPickPalletScan(
        btn.getAttribute('data-pick-scan'),
        btn.getAttribute('data-line-id')
      );
    });
  });

  if (footer) {
    const allDone = (pl.lines || []).length > 0 && (pl.lines || []).every((ln) => Number(ln.qtyPicked) >= Number(ln.qtyNeeded));
    footer.innerHTML = `
      ${canPick && allDone ? `
        <button type="button" class="btn btn-emerald" data-pick-mark-done="${escapeHtml(pl.id)}">
          <i data-lucide="check-check" style="width: 16px;"></i>
          Ολοκλήρωση λίστας
        </button>
      ` : ''}
      ${canPick ? `
        <button type="button" class="btn btn-secondary" data-pick-cancel="${escapeHtml(pl.id)}">
          <i data-lucide="ban" style="width: 14px;"></i>
          Ακύρωση λίστας
        </button>
      ` : ''}
    `;
    const doneBtn = footer.querySelector('[data-pick-mark-done]');
    if (doneBtn) doneBtn.addEventListener('click', () => markPickListDoneIfReady(doneBtn.getAttribute('data-pick-mark-done')));
    const cancelBtn = footer.querySelector('[data-pick-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', () => cancelPickList(cancelBtn.getAttribute('data-pick-cancel')));
  }
}


function cancelPickPalletScan() {
  pickScanAwaiting = null;
  const banner = document.getElementById('pickScanBanner');
  if (banner) banner.hidden = true;
}

/**
 * Start camera/QR flow for picking a line. Reuses tab-link scanner (PALLET:id).
 */
function startPickPalletScan(listId, lineId) {
  const pl = pickLists.find((x) => x.id === listId);
  if (!pl) {
    showToast('Η λίστα picking δεν βρέθηκε', 'error');
    return;
  }
  const line = (pl.lines || []).find((ln) => ln.id === lineId);
  if (!line) {
    showToast('Η γραμμή δεν βρέθηκε', 'error');
    return;
  }
  const remaining = Math.max(0, Number(line.qtyNeeded) - Number(line.qtyPicked));
  if (remaining <= 0) {
    showToast('Η γραμμή έχει ήδη ολοκληρωθεί', 'error');
    return;
  }

  // Close confirm modal if open (does not clear pickScanAwaiting)
  const modal = document.getElementById('pickModal');
  if (modal && !modal.hidden) {
    pendingPickContext = null;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }

  pickScanAwaiting = { listId: String(listId), lineId: String(lineId) };
  switchTab('tab-link');
  updatePickScanBanner();
  showToast('Σκανάρετε το QR της παλέτας (PALLET:…)', 'success');
  startCameraScanner().catch(() => {});
}

function updatePickScanBanner() {
  let banner = document.getElementById('pickScanBanner');
  if (!pickScanAwaiting) {
    if (banner) banner.hidden = true;
    return;
  }
  if (!banner) {
    const flow = document.querySelector('#tab-link .scanner-flow');
    if (!flow) return;
    banner = document.createElement('div');
    banner.id = 'pickScanBanner';
    banner.className = 'pick-scan-banner';
    flow.insertBefore(banner, flow.firstChild);
  }
  const pl = pickLists.find((x) => x.id === pickScanAwaiting.listId);
  const line = pl && (pl.lines || []).find((ln) => ln.id === pickScanAwaiting.lineId);
  const name = line ? line.productName : '';
  banner.hidden = false;
  banner.innerHTML = `
    <div class="pick-scan-banner-text">
      <strong>Picking — σκανάρισμα παλέτας</strong>
      <span>${escapeHtml(name)}</span>
    </div>
    <button type="button" class="btn btn-secondary btn-sm" id="btnCancelPickScan">Ακύρωση</button>
  `;
  const btn = document.getElementById('btnCancelPickScan');
  if (btn) {
    btn.addEventListener('click', () => {
      cancelPickPalletScan();
      stopCameraScanner();
      switchTab('tab-picking');
      showToast('Ακυρώθηκε το σκανάρισμα', 'success');
    });
  }
}

/**
 * After QR decode during pick-scan: validate pallet vs active line, open confirm modal.
 * @returns {boolean} true if the scan was consumed by picking (even on error)
 */
function handlePickPalletScan(palletId) {
  if (!pickScanAwaiting) return false;
  const ctx = pickScanAwaiting;
  const id = String(palletId || '').trim();
  if (!id) return false;

  const pl = pickLists.find((x) => x.id === ctx.listId);
  const line = pl && (pl.lines || []).find((ln) => ln.id === ctx.lineId);
  if (!pl || !line) {
    pickScanAwaiting = null;
    updatePickScanBanner();
    showToast('Η γραμμή picking δεν βρέθηκε', 'error');
    switchTab('tab-picking');
    return true;
  }

  const pallet = pallets.find((p) => p.id === id);
  if (!pallet) {
    showToast('Η παλέτα δεν βρέθηκε', 'error');
    return true; // keep awaiting for retry
  }

  const remaining = Math.max(0, Number(line.qtyNeeded) - Number(line.qtyPicked));
  const candidates = findPickCandidates(line.productName, remaining);
  const asCand = candidates.find((c) => c.pallet.id === id);

  let available = null;
  let expiry = null;

  if (asCand) {
    available = asCand.available;
    expiry = asCand.expiry || null;
  } else {
    const items = Array.isArray(pallet.items) ? pallet.items : [];
    let matched = null;
    for (let i = 0; i < items.length; i++) {
      if (!itemNameMatches(items[i] && items[i].name, line.productName)) continue;
      matched = items[i];
      break;
    }
    if (!matched) {
      showToast('Η παλέτα δεν έχει αυτό το προϊόν', 'error');
      return true; // keep awaiting
    }
    if (!isInStock(pallet)) {
      showToast('χωρίς απόθεμα', 'error');
      return true;
    }
    const avail = matched.qty == null || matched.qty === '' ? NaN : Number(matched.qty);
    if (!Number.isFinite(avail) || avail <= 0) {
      showToast('χωρίς απόθεμα', 'error');
      return true;
    }
    available = avail;
    expiry = matched.expiry || null;
  }

  pickScanAwaiting = null;
  updatePickScanBanner();
  stopCameraScanner().catch(() => {});
  switchTab('tab-picking');
  openPickModal({
    listId: ctx.listId,
    lineId: ctx.lineId,
    palletId: id,
    available,
    expiry,
    mode: 'direct'
  });
  showToast(`Επιλέχθηκε παλέτα ${id}`, 'success');
  return true;
}

function printActivePickList() {
  if (!activePickListId) {
    showToast('Ανοίξτε μια λίστα πρώτα', 'error');
    return;
  }
  printPickList(activePickListId);
}

function printPickList(listId) {
  const pl = pickLists.find((x) => x.id === listId);
  if (!pl) {
    showToast('Η λίστα δεν βρέθηκε', 'error');
    return;
  }
  const created = pl.createdAt ? new Date(pl.createdAt) : new Date();
  const dateStr = created.toLocaleString('el-GR');
  const rows = (pl.lines || []).map((ln) => {
    const remaining = Math.max(0, Number(ln.qtyNeeded) - Number(ln.qtyPicked));
    const canSuggest = remaining > 0 && (pl.status === 'open' || pl.status === 'in_progress');
    const top = canSuggest ? (findPickCandidates(ln.productName, remaining)[0] || null) : null;
    let sug = '—';
    if (top && top.locationCode) {
      sug = `${locationTypeLabel(top.locationType)}: ${top.locationCode}`;
    } else if (top) {
      sug = 'Χωρίς θέση';
    }
    return `<tr>
      <td>${escapeHtml(ln.productName)}</td>
      <td class="num">${escapeHtml(String(ln.qtyNeeded))}</td>
      <td class="num">${escapeHtml(String(ln.qtyPicked))}</td>
      <td>${escapeHtml(pickStatusLabel(ln.status))}</td>
      <td>${escapeHtml(sug)}</td>
    </tr>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'print-pick-list';
  wrap.innerHTML = `
    ${companyHeaderHtml()}
    <h1>Λίστα picking</h1>
    <div class="print-pick-meta">
      <div><strong>Πελάτης:</strong> ${escapeHtml(pl.customer)}</div>
      <div><strong>Παραγγελία:</strong> ${escapeHtml(pl.orderRef)}</div>
      <div><strong>Κωδ. λίστας:</strong> ${escapeHtml(pl.id)}</div>
      <div><strong>Ημ/νία:</strong> ${escapeHtml(dateStr)}</div>
      <div><strong>Κατάσταση:</strong> ${escapeHtml(pickStatusLabel(pl.status))}</div>
    </div>
    <table class="print-pick-table">
      <thead>
        <tr>
          <th>Προϊόν</th>
          <th>Χρειάζεται</th>
          <th>Picked</th>
          <th>Κατάσταση</th>
          <th>Προτ. θέση</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5">Χωρίς γραμμές</td></tr>'}</tbody>
    </table>
  `;

  const printArea = document.getElementById('printArea');
  if (!printArea) {
    showToast('Σφάλμα περιοχής εκτύπωσης', 'error');
    return;
  }
  printArea.innerHTML = '';
  printArea.appendChild(wrap);
  printArea.style.display = 'block';
  applyDocumentPrintPage();
  window.print();
  setTimeout(() => {
    printArea.style.display = 'none';
    printArea.innerHTML = '';
  }, 1000);
}

function openPickModal(ctx) {
  const pl = pickLists.find((x) => x.id === ctx.listId);
  if (!pl) return;
  const line = (pl.lines || []).find((ln) => ln.id === ctx.lineId);
  if (!line) return;

  const remaining = Math.max(0, Number(line.qtyNeeded) - Number(line.qtyPicked));
  if (remaining <= 0) {
    showToast('Η γραμμή έχει ήδη ολοκληρωθεί', 'error');
    return;
  }

  pendingPickContext = {
    listId: ctx.listId,
    lineId: ctx.lineId,
    palletId: ctx.palletId || null,
    available: ctx.available != null ? Number(ctx.available) : null,
    expiry: ctx.expiry || null,
    mode: ctx.mode || 'direct'
  };

  const modal = document.getElementById('pickModal');
  const sub = document.getElementById('pickModalSub');
  const candEl = document.getElementById('pickModalCandidates');
  const qtyInput = document.getElementById('pickQtyInput');

  if (sub) {
    sub.textContent = `${line.productName} · υπόλοιπο ${remaining} · λίστα ${pl.id}`;
  }

  const candidates = findPickCandidates(line.productName, remaining);
  if (candEl) {
    if (!candidates.length) {
      candEl.innerHTML = '<p class="pick-empty">Καμία διαθέσιμη παλέτα.</p>';
    } else {
      candEl.innerHTML = candidates.slice(0, 12).map((c) => {
        const selected = pendingPickContext.palletId === c.pallet.id ? ' selected' : '';
        const checked = pendingPickContext.palletId === c.pallet.id ? 'checked' : '';
        const loc = c.locationCode
          ? `${locationTypeLabel(c.locationType)} ${c.locationCode}`
          : 'Χωρίς θέση';
        const exp = c.expiry ? ` · λήξη ${formatExpiryEl(c.expiry)}` : '';
        return `
          <button type="button" class="pick-modal-cand${selected}"
            data-modal-pallet="${escapeHtml(c.pallet.id)}"
            data-modal-avail="${c.available}"
            data-modal-expiry="${escapeHtml(c.expiry || '')}">
            <input type="radio" class="pick-modal-cand-radio" name="pickPalletRadio" ${checked} tabindex="-1">
            <div>
              <div class="pick-candidate-id">${escapeHtml(c.pallet.id)}</div>
              <div class="pick-candidate-meta">${escapeHtml(loc)} · διαθέσιμο ${c.available}${escapeHtml(exp)}</div>
            </div>
          </button>
        `;
      }).join('');

      candEl.querySelectorAll('[data-modal-pallet]').forEach((btn) => {
        btn.addEventListener('click', () => {
          pendingPickContext.palletId = btn.getAttribute('data-modal-pallet');
          pendingPickContext.available = Number(btn.getAttribute('data-modal-avail'));
          pendingPickContext.expiry = btn.getAttribute('data-modal-expiry') || null;
          candEl.querySelectorAll('.pick-modal-cand').forEach((el) => el.classList.remove('selected'));
          btn.classList.add('selected');
          const radio = btn.querySelector('input[type="radio"]');
          if (radio) radio.checked = true;
          if (qtyInput) {
            const maxQ = Math.min(remaining, pendingPickContext.available || remaining);
            qtyInput.value = String(maxQ);
            qtyInput.max = String(maxQ);
          }
        });
      });
    }
  }

  if (qtyInput) {
    const maxQ = Math.min(
      remaining,
      pendingPickContext.available != null && Number.isFinite(pendingPickContext.available)
        ? pendingPickContext.available
        : remaining
    );
    qtyInput.value = pendingPickContext.palletId ? String(maxQ) : '';
    qtyInput.max = String(remaining);
    qtyInput.min = '0.01';
  }

  // Scan CTA inside confirm modal (fallback to camera flow)
  let scanWrap = document.getElementById('pickModalScanWrap');
  if (!scanWrap) {
    const panel = modal && modal.querySelector('.modal-panel');
    const qtyGroup = document.getElementById('pickModalQtyGroup');
    if (panel && qtyGroup) {
      scanWrap = document.createElement('div');
      scanWrap.id = 'pickModalScanWrap';
      scanWrap.className = 'pick-modal-scan-wrap';
      qtyGroup.parentNode.insertBefore(scanWrap, qtyGroup);
    }
  }
  if (scanWrap) {
    scanWrap.innerHTML = `
      <button type="button" class="btn btn-primary pick-scan-btn" id="pickModalScanBtn">
        <i data-lucide="scan-line" style="width: 18px;"></i>
        Σκανάρισμα παλέτας
      </button>
      <p class="pick-empty" style="margin:0.35rem 0 0;">ή επιλέξτε παλέτα χειροκίνητα παραπάνω</p>
    `;
    const scanBtn = document.getElementById('pickModalScanBtn');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => {
        startPickPalletScan(pendingPickContext.listId, pendingPickContext.lineId);
      });
    }
  }

  if (modal) {
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
  }
  if (window.lucide) lucide.createIcons();
  if (qtyInput) setTimeout(() => qtyInput.focus(), 50);
}

function closePickModal() {
  pendingPickContext = null;
  const modal = document.getElementById('pickModal');
  if (modal) {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  }
}

function submitPickConfirm() {
  if (!pendingPickContext || !pendingPickContext.palletId) {
    showToast('Επιλέξτε παλέτα', 'error');
    return;
  }
  const qtyInput = document.getElementById('pickQtyInput');
  const qty = qtyInput ? Number(qtyInput.value) : NaN;
  const ok = confirmPick(
    pendingPickContext.listId,
    pendingPickContext.lineId,
    pendingPickContext.palletId,
    qty
  );
  if (ok) closePickModal();
}

function bindPickModalChrome() {
  const modal = document.getElementById('pickModal');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePickModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) closePickModal();
  });
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

/* ==========================================================================
   TAB 6: SETTINGS (Firestore settings/main + localStorage mirror)
   ========================================================================== */
const SETTINGS_KEY = 'monlog_settings_v1';
const LABEL_PRESETS = {
  '70x42': { w: 70, h: 42, sheet: true },
  '100x50': { w: 100, h: 50 },
  '50x30': { w: 50, h: 30 },
  '62x29': { w: 62, h: 29 },
  '40x30': { w: 40, h: 30 },
  // DYMO LabelWriter (w = label length along feed, h = label width across head; max print width ~56mm)
  'dymo-99014': { w: 101, h: 54, dymo: true, name: 'DYMO 99014 Shipping / Name badge 54×101' },
  'dymo-99012': { w: 89, h: 36, dymo: true, name: 'DYMO 99012 Large Address 36×89' },
  'dymo-99010': { w: 89, h: 28, dymo: true, name: 'DYMO 99010 Standard Address 28×89' },
  'dymo-11354': { w: 57, h: 32, dymo: true, name: 'DYMO 11354 Multi-purpose 32×57' },
  'dymo-11352': { w: 54, h: 25, dymo: true, name: 'DYMO 11352 Return Address 25×54' },
  'dymo-11355': { w: 51, h: 19, dymo: true, name: 'DYMO 11355 Multi-purpose 19×51' },
  'dymo-S0722430': { w: 57, h: 32, dymo: true, name: 'DYMO S0722430 Multi-purpose 32×57' },
  'dymo-99017': { w: 50, h: 12, dymo: true, name: 'DYMO 99017 Suspension file 12×50' }
};
const DYMO_DEFAULT_PRESET = 'dymo-99014';

function defaultZones() {
  return [
    { letter: 'Α', name: 'Αριστερός τοίχος', positions: 19, levels: 2, aisle: false },
    { letter: 'Β', name: 'Νησίδα Β', positions: 24, levels: 2, aisle: false },
    { letter: 'Γ', name: 'Νησίδα Γ', positions: 24, levels: 2, aisle: false },
    { letter: 'Δ', name: 'Νησίδα Δ', positions: 24, levels: 2, aisle: false },
    { letter: 'Ε', name: 'Δεξιός τοίχος', positions: 19, levels: 2, aisle: false },
    { letter: 'Ζ', name: 'Διπλή σειρά κάτω', positions: 24, levels: 2, aisle: false },
    { letter: 'Η', name: 'Μονή σειρά κάτω', positions: 12, levels: 2, aisle: false },
    { letter: 'Χ', name: 'Ελεύθερος χώρος', positions: 10, levels: 1, aisle: false }
  ];
}

function defaultSettings() {
  return {
    printer: { type: 'a4', model: '', labelPreset: '70x42', width: 70, height: 42, showCompany: true },
    zones: defaultZones(),
    company: { name: '', address: '', phone: '', vat: '', logo: '' },
    expiryDays: 7
  };
}

let appSettings = defaultSettings();
let settingsUnsub = null;
let settingsLoadedFromCloud = false;

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeSettings(raw) {
  const d = defaultSettings();
  const r = raw && typeof raw === 'object' ? raw : {};
  const pr = r.printer && typeof r.printer === 'object' ? r.printer : {};
  const preset = (pr.labelPreset === 'custom' || LABEL_PRESETS[pr.labelPreset]) ? pr.labelPreset : d.printer.labelPreset;
  const base = LABEL_PRESETS[preset] || {};
  const printer = {
    type: ['a4', 'thermal', 'dymo', 'other'].includes(pr.type) ? pr.type : d.printer.type,
    model: String(pr.model || '').slice(0, 80),
    labelPreset: preset,
    width: preset === 'custom' ? clampInt(pr.width, 20, 210, 70) : base.w,
    height: preset === 'custom' ? clampInt(pr.height, 15, 297, 42) : base.h,
    showCompany: pr.showCompany !== false,
    orient: pr.orient === 'portrait' ? 'portrait' : 'landscape'
  };
  let zones = Array.isArray(r.zones) ? r.zones : d.zones;
  zones = zones.map((z) => ({
    letter: String((z && z.letter) || '').trim().toUpperCase().slice(0, 3),
    name: String((z && z.name) || '').slice(0, 60),
    positions: clampInt(z && z.positions, 1, 999, 1),
    levels: clampInt(z && z.levels, 1, 9, 1),
    aisle: !!(z && z.aisle)
  })).filter((z) => z.letter);
  if (!Array.isArray(r.zones)) zones = d.zones;
  const c = r.company && typeof r.company === 'object' ? r.company : {};
  const company = {
    name: String(c.name || '').slice(0, 120),
    address: String(c.address || '').slice(0, 200),
    phone: String(c.phone || '').slice(0, 40),
    vat: String(c.vat || '').slice(0, 20),
    logo: typeof c.logo === 'string' && (c.logo.startsWith('data:image/') || /^https?:\/\//.test(c.logo)) ? c.logo : ''
  };
  return { printer, zones, company, expiryDays: clampInt(r.expiryDays, 0, 365, d.expiryDays) };
}

function getExpiryWarnDays() {
  return appSettings && Number.isFinite(appSettings.expiryDays) ? appSettings.expiryDays : 7;
}

function loadSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    appSettings = normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch (e) {
    appSettings = defaultSettings();
  }
}

function mirrorSettingsToLocal() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings)); } catch (e) { /* quota */ }
}

function subscribeSettings() {
  if (!db) return;
  if (settingsUnsub) settingsUnsub();
  settingsUnsub = db.collection('settings').doc('main').onSnapshot((snap) => {
    settingsLoadedFromCloud = true;
    if (snap.exists) {
      appSettings = normalizeSettings(snap.data());
      mirrorSettingsToLocal();
    }
    onSettingsChanged(true);
  }, (err) => {
    console.error('Settings snapshot error:', err);
  });
}

function onSettingsChanged(fromRemote) {
  populateLocationDatalists();
  // Re-render expiry badges with new threshold
  try { renderInventoryTable(); renderProductSearch(); } catch (e) { /* not ready */ }
  const tab = document.getElementById('tab-settings');
  // Avoid clobbering in-progress edits; only re-render form when not visible or local save
  if (tab && (!tab.classList.contains('active') || !fromRemote || !settingsFormDirty)) renderSettingsForm();
  updateSettingsSyncNote();
}

function updateSettingsSyncNote() {
  const el = document.getElementById('settingsSyncNote');
  if (!el) return;
  el.textContent = cloudEnabled ? '(Cloud ενεργό)' : '(Τοπική λειτουργία — μόνο σε αυτή τη συσκευή)';
}

/* ---------- Location codes from zones ---------- */
function pad2(n) { return n < 10 ? '0' + n : String(n); }

function zoneLocationCodes(z) {
  const out = [];
  for (let i = 1; i <= z.positions; i++) {
    const base = `${z.letter}-${pad2(i)}`;
    if (z.levels <= 1) out.push(base);
    else for (let l = 1; l <= z.levels; l++) out.push(`${base}-${l}`);
  }
  return out;
}

function zoneAisleCodes(z) {
  const out = [];
  if (!z.aisle) return out;
  for (let i = 1; i <= z.positions; i++) {
    for (let r = 1; r <= 4; r++) out.push(formatAisleLocationCode(`${z.letter}-${pad2(i)}`, r));
  }
  return out;
}

function allConfiguredLocationCodes() {
  const out = [];
  (appSettings.zones || []).forEach((z) => { out.push(...zoneLocationCodes(z), ...zoneAisleCodes(z)); });
  return out;
}

function populateLocationDatalists() {
  const dl = document.getElementById('locationCodesList');
  if (dl) {
    dl.innerHTML = allConfiguredLocationCodes().map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }
  const zl = document.getElementById('zoneLettersList');
  if (zl) {
    zl.innerHTML = (appSettings.zones || []).map((z) => `<option value="${escapeHtml(z.letter)}">${escapeHtml(z.name)}</option>`).join('');
  }
}

function applyManualLocation() {
  const el = document.getElementById('manualLocationInput');
  const v = el ? String(el.value || '').trim().toUpperCase() : '';
  if (!v) { showToast('Γράψτε μια θέση', 'error'); return; }
  simulateShelfScan(v);
  if (el) el.value = '';
}

function describeLocationCode(code) {
  const aisle = parseAisleLocationCode(code);
  const baseCode = aisle ? aisle.base : code;
  const m = String(baseCode).match(/^([^-]+)-(\d+)(?:-(\d+))?$/);
  if (!m) return { zoneName: '', levelText: '', aisleRow: aisle ? aisle.row : null };
  const z = (appSettings.zones || []).find((x) => x.letter === m[1]);
  let levelText = '';
  if (m[3] && !aisle) {
    const lv = parseInt(m[3], 10);
    const total = z ? z.levels : 0;
    if (total === 2) levelText = lv === 1 ? 'ΚΑΤΩ' : 'ΠΑΝΩ';
    else levelText = `ΥΨΟΣ ${lv}`;
  }
  return { zoneName: z ? z.name : '', levelText, aisleRow: aisle ? aisle.row : null };
}

/* ---------- Sized label printing ---------- */
function getLabelSize() {
  const p = appSettings.printer;
  const thermalLike = p.type === 'thermal' || p.type === 'dymo';
  return { w: p.width, h: p.height, sheet: p.labelPreset === '70x42' && !thermalLike,
    rotate: p.type === 'dymo' && p.orient === 'portrait' };
}

function locationCodeToLabelSpec(code) {
  const aisle = parseAisleLocationCode(code);
  const info = describeLocationCode(code);
  const lines = [];
  if (aisle) lines.push(`ΔΙΑΔΡΟΜΟΣ μπροστά από ${aisle.base} · Σειρά ${aisle.row}`);
  else {
    if (info.levelText) lines.push(info.levelText);
    if (info.zoneName) lines.push(info.zoneName);
  }
  return {
    code,
    lines,
    qr: aisle ? `AISLE:${aisle.base}:${aisle.row}` : `SHELF:${code}`
  };
}

function palletToLabelSpec(p) {
  const items = normalizeItems(p.items);
  const lines = [p.customer || ''];
  items.slice(0, 2).forEach((it) => {
    lines.push(`${it.name}${it.qty != null ? ' ×' + it.qty : ''}${it.expiry ? ' · λήξη ' + formatExpiryEl(it.expiry) : ''}`);
  });
  if (items.length > 2) lines.push(`+${items.length - 2} ακόμη`);
  return { code: p.id, lines: lines.filter(Boolean), qr: `PALLET:${p.id}` };
}

function qrDataUrl(text, px) {
  return new Promise((resolve) => {
    if (typeof QRCode !== 'undefined' && typeof QRCode.toDataURL === 'function') {
      try {
        QRCode.toDataURL(String(text), { width: px, margin: 1, errorCorrectionLevel: 'M' }, (err, url) => {
          resolve(err || !url ? null : url);
        });
        return;
      } catch (e) { /* fall through */ }
    }
    resolve('https://api.qrserver.com/v1/create-qr-code/?size=' + px + 'x' + px + '&margin=1&data=' + encodeURIComponent(text));
  });
}

function setPrintPageCss(css) {
  let st = document.getElementById('mlPrintPageStyle');
  if (!st) {
    st = document.createElement('style');
    st.id = 'mlPrintPageStyle';
    document.head.appendChild(st);
  }
  st.textContent = css;
}

/** A4 page for documents (pick lists). Thermal: label width, long page. */
function applyDocumentPrintPage() {
  document.body.classList.add('ml-printing');
  const p = appSettings.printer;
  if (p.type === 'thermal' || p.type === 'dymo') {
    const pw = p.type === 'dymo' ? Math.min(p.height, 56) : p.width;
    setPrintPageCss(`@media print { @page { size: ${pw}mm auto; margin: 2mm; } #printArea .print-pick-list { font-size: 8pt; } }`);
  } else {
    setPrintPageCss('@media print { @page { size: A4 portrait; margin: 12mm; } }');
  }
  scheduleAfterPrintCleanup();
}

function scheduleAfterPrintCleanup() {
  const done = () => {
    document.body.classList.remove('ml-printing');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(done, 3000);
}

function companyLabelLine() {
  const c = appSettings.company;
  return appSettings.printer.showCompany && c.name ? c.name : '';
}

function companyHeaderHtml() {
  const c = appSettings.company;
  if (!c.name && !c.address && !c.phone && !c.vat && !c.logo) return '';
  const parts = [c.address, c.phone ? 'Τηλ. ' + c.phone : '', c.vat ? 'ΑΦΜ ' + c.vat : ''].filter(Boolean);
  return `<div class="print-company-header">
    ${c.logo ? `<img src="${escapeHtml(c.logo)}" alt="" class="print-company-logo">` : ''}
    <div>
      ${c.name ? `<div class="print-company-name">${escapeHtml(c.name)}</div>` : ''}
      ${parts.length ? `<div class="print-company-meta">${escapeHtml(parts.join(' · '))}</div>` : ''}
    </div>
  </div>`;
}

/** Build label DOM nodes sized in mm. Returns { root, ready: Promise } */
function buildSizedLabels(specs, size) {
  const { w, h } = size;
  const pad = Math.max(1.5, Math.min(3, h * 0.06));
  const qrMm = Math.max(10, Math.min(h - pad * 2, w * 0.48));
  const textW = w - qrMm - pad * 3;
  const company = companyLabelLine();
  const showCompany = company && h >= 28;
  const codeFont = Math.max(3.5, Math.min(h * 0.26, textW / 4.2));
  const lineFont = Math.max(2, Math.min(h * 0.085, 3.4));
  const maxLines = Math.max(1, Math.floor((h - pad * 2 - codeFont * 1.2 - (showCompany ? lineFont * 1.3 : 0)) / (lineFont * 1.25)));
  const root = document.createElement('div');
  root.className = 'ml-label-sheet';
  const jobs = [];
  specs.forEach((sp) => {
    const el = document.createElement('div');
    el.className = 'ml-label';
    el.style.cssText = `width:${w}mm;height:${h}mm;padding:${pad}mm;gap:${pad}mm;`;
    const img = document.createElement('img');
    img.className = 'ml-label-qr';
    img.alt = 'QR';
    img.style.cssText = `width:${qrMm}mm;height:${qrMm}mm;`;
    const txt = document.createElement('div');
    txt.className = 'ml-label-text';
    txt.innerHTML = `${showCompany ? `<div class="ml-label-company" style="font-size:${lineFont}mm">${escapeHtml(company)}</div>` : ''}
      <div class="ml-label-code" style="font-size:${codeFont}mm">${escapeHtml(sp.code)}</div>
      ${(sp.lines || []).slice(0, maxLines).map((l) => `<div class="ml-label-line" style="font-size:${lineFont}mm">${escapeHtml(l)}</div>`).join('')}`;
    el.appendChild(img);
    el.appendChild(txt);
    if (size.rotate) {
      // Portrait page (width × length) with landscape content rotated 90°
      const pg = document.createElement('div');
      pg.className = 'ml-page ml-page-rot';
      pg.style.cssText = `position:relative;overflow:hidden;width:${h}mm;height:${w}mm;`;
      el.style.cssText += `position:absolute;top:0;left:0;transform-origin:0 0;transform:translateX(${h}mm) rotate(90deg);`;
      pg.appendChild(el);
      root.appendChild(pg);
    } else {
      root.appendChild(el);
    }
    jobs.push(qrDataUrl(sp.qr, 300).then((url) => new Promise((res) => {
      if (!url) { res(); return; }
      img.onload = img.onerror = () => res();
      img.src = url;
    })));
  });
  return { root, ready: Promise.all(jobs) };
}

function labelPrintCss(size) {
  const { w, h, sheet } = size;
  const p = appSettings.printer;
  if (sheet) {
    // 70x42 on A4: 3 columns × 7 rows = 210 × 294mm, no margins
    return `@media print {
      @page { size: A4 portrait; margin: 0; }
      #printArea.ml-labels-mode .ml-label-sheet { display:grid !important; grid-template-columns: repeat(3, ${w}mm); grid-auto-rows: ${h}mm; width:210mm; padding: 1.5mm 0 0 0; }
      #printArea.ml-labels-mode .ml-label { border: 0.2mm dashed #bbb !important; }
      #printArea.ml-labels-mode .ml-label:nth-child(21n) { break-after: page; page-break-after: always; }
    }`;
  }
  if (p.type === 'a4') {
    const cols = Math.max(1, Math.floor(200 / w));
    return `@media print {
      @page { size: A4 portrait; margin: 5mm; }
      #printArea.ml-labels-mode .ml-label-sheet { display:grid !important; grid-template-columns: repeat(${cols}, ${w}mm); grid-auto-rows: ${h}mm; gap: 0; }
      #printArea.ml-labels-mode .ml-label { border: 0.2mm dashed #bbb !important; }
    }`;
  }
  // Thermal / DYMO / other: one label per page, page = label size
  const pw = size.rotate ? h : w;
  const ph = size.rotate ? w : h;
  return `@media print {
    @page { size: ${pw}mm ${ph}mm; margin: 0; }
    #printArea.ml-labels-mode .ml-label-sheet { display:block !important; }
    #printArea.ml-labels-mode .ml-label-sheet > * { break-after: page; page-break-after: always; }
    #printArea.ml-labels-mode .ml-label-sheet > *:last-child { break-after: auto; page-break-after: auto; }
    #printArea.ml-labels-mode .ml-label { border: none !important; }
  }`;
}

let labelPrintBusy = false;
async function printLabelsSized(specs) {
  if (!specs || !specs.length) { showToast('Δεν υπάρχουν ετικέτες', 'error'); return; }
  if (labelPrintBusy) return;
  labelPrintBusy = true;
  try {
    const size = getLabelSize();
    const printArea = document.getElementById('printArea');
    if (!printArea) return;
    if (specs.length > 30) showToast(`Προετοιμασία ${specs.length} ετικετών…`, 'success');
    const { root, ready } = buildSizedLabels(specs, size);
    await ready;
    printArea.innerHTML = '';
    printArea.className = 'ml-labels-mode';
    printArea.appendChild(root);
    printArea.style.display = 'block';
    setPrintPageCss(labelPrintCss(size));
    document.body.classList.add('ml-printing');
    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup);
      document.body.classList.remove('ml-printing');
      printArea.style.display = 'none';
      printArea.innerHTML = '';
      printArea.className = '';
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
    // Fallback for browsers without afterprint (print() blocks on most desktop)
    setTimeout(() => { if (!window.__mlKeepPrintArea) cleanup(); }, 1500);
  } finally {
    labelPrintBusy = false;
  }
}

function printAllLocationLabels(zoneIndex) {
  const zones = appSettings.zones || [];
  const list = typeof zoneIndex === 'number' ? [zones[zoneIndex]].filter(Boolean) : zones;
  const codes = [];
  list.forEach((z) => codes.push(...zoneLocationCodes(z), ...zoneAisleCodes(z)));
  if (settingsFormDirty) showToast('Προσοχή: έχεις μη αποθηκευμένες αλλαγές — τυπώνονται οι αποθηκευμένες ρυθμίσεις', 'error');
  printLabelsSized(codes.map(locationCodeToLabelSpec));
}

function printTestLabel() {
  const z = (appSettings.zones || [])[1] || (appSettings.zones || [])[0];
  const code = z ? zoneLocationCodes(z)[Math.min(13, zoneLocationCodes(z).length - 1)] : 'Β-07-2';
  printLabelsSized([locationCodeToLabelSpec(code)]);
}

/* ---------- Settings form ---------- */
let settingsFormDirty = false;
let draftZones = null;
let draftLogo = '';

function initSettingsUI() {
  populateLocationDatalists();
  const tab = document.getElementById('tab-settings');
  if (!tab) return;
  tab.addEventListener('input', () => { settingsFormDirty = true; refreshSettingsDerived(); });
  tab.addEventListener('change', (e) => {
    settingsFormDirty = true;
    if (e.target && e.target.id === 'setLabelPreset') {
      const pr = LABEL_PRESETS[e.target.value];
      if (pr) { setVal('setLabelW', pr.w); setVal('setLabelH', pr.h); }
    }
    if (e.target && e.target.id === 'setPrinterType') {
      const cur = getVal('setLabelPreset');
      const isDymo = e.target.value === 'dymo';
      const curDymo = !!(LABEL_PRESETS[cur] && LABEL_PRESETS[cur].dymo);
      if (isDymo && !curDymo) {
        setVal('setLabelPreset', DYMO_DEFAULT_PRESET);
        const d = LABEL_PRESETS[DYMO_DEFAULT_PRESET]; setVal('setLabelW', d.w); setVal('setLabelH', d.h);
        if (!getVal('setPrinterModel')) setVal('setPrinterModel', 'DYMO LabelWriter 450');
      } else if (!isDymo && curDymo) {
        setVal('setLabelPreset', '70x42'); setVal('setLabelW', 70); setVal('setLabelH', 42);
      }
    }
    if (e.target && e.target.id === 'setCompanyLogoFile') handleLogoFile(e.target);
    refreshSettingsDerived();
  });
  const editor = document.getElementById('zonesEditor');
  if (editor) {
    editor.addEventListener('input', (e) => {
      const row = e.target.closest('[data-zone-idx]');
      if (!row) return;
      const idx = Number(row.getAttribute('data-zone-idx'));
      const f = e.target.getAttribute('data-f');
      if (!draftZones[idx] || !f) return;
      draftZones[idx][f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    });
    editor.addEventListener('click', (e) => {
      const del = e.target.closest('[data-zone-del]');
      if (del) {
        const idx = Number(del.getAttribute('data-zone-del'));
        if (confirm(`Διαγραφή ζώνης ${draftZones[idx].letter || ''};`)) {
          draftZones.splice(idx, 1);
          settingsFormDirty = true;
          renderZonesEditor();
          refreshSettingsDerived();
        }
        return;
      }
      const pr = e.target.closest('[data-zone-print]');
      if (pr) printAllLocationLabels(Number(pr.getAttribute('data-zone-print')));
    });
  }
  renderSettingsForm();
}

function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v == null ? '' : v; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function renderSettingsForm() {
  const s = appSettings;
  setVal('setPrinterType', s.printer.type);
  setVal('setPrinterModel', s.printer.model);
  setVal('setLabelPreset', s.printer.labelPreset);
  setVal('setLabelW', s.printer.width);
  setVal('setLabelH', s.printer.height);
  setVal('setDymoOrient', s.printer.orient);
  const sc = document.getElementById('setShowCompanyOnLabels');
  if (sc) sc.checked = !!s.printer.showCompany;
  setVal('setCompanyName', s.company.name);
  setVal('setCompanyAddress', s.company.address);
  setVal('setCompanyPhone', s.company.phone);
  setVal('setCompanyVat', s.company.vat);
  draftLogo = s.company.logo || '';
  setVal('setExpiryDays', s.expiryDays);
  draftZones = s.zones.map((z) => ({ ...z }));
  settingsFormDirty = false;
  renderZonesEditor();
  renderLogoPreview();
  refreshSettingsDerived();
  updateSettingsSyncNote();
}

function renderZonesEditor() {
  const ed = document.getElementById('zonesEditor');
  if (!ed || !draftZones) return;
  ed.innerHTML = draftZones.map((z, i) => `
    <div class="zone-row" data-zone-idx="${i}">
      <input class="form-input zone-letter" data-f="letter" value="${escapeHtml(z.letter)}" maxlength="3" aria-label="Γράμμα">
      <input class="form-input zone-name" data-f="name" value="${escapeHtml(z.name)}" placeholder="Όνομα" aria-label="Όνομα">
      <label class="zone-num"><span>Θέσεις</span><input class="form-input" type="number" min="1" max="999" inputmode="numeric" data-f="positions" value="${z.positions}"></label>
      <label class="zone-num"><span>Ύψη</span><input class="form-input" type="number" min="1" max="9" inputmode="numeric" data-f="levels" value="${z.levels}"></label>
      <label class="zone-aisle"><input type="checkbox" data-f="aisle" ${z.aisle ? 'checked' : ''}><span>Διάδρ. Δ1–Δ4</span></label>
      <div class="zone-btns">
        <button type="button" class="btn btn-secondary btn-sm" data-zone-print="${i}" title="Εκτύπωση ετικετών ζώνης">🖨️</button>
        <button type="button" class="btn btn-secondary btn-sm zone-del" data-zone-del="${i}" title="Διαγραφή">✕</button>
      </div>
    </div>`).join('');
}

function addZoneRow() {
  if (!draftZones) draftZones = [];
  draftZones.push({ letter: '', name: '', positions: 10, levels: 2, aisle: false });
  settingsFormDirty = true;
  renderZonesEditor();
  const rows = document.querySelectorAll('#zonesEditor .zone-letter');
  if (rows.length) rows[rows.length - 1].focus();
}

function resetZonesToDefault() {
  if (!confirm('Επαναφορά των ζωνών στο αρχικό σχέδιο αποθήκης;')) return;
  draftZones = defaultZones();
  settingsFormDirty = true;
  renderZonesEditor();
  refreshSettingsDerived();
}

function refreshSettingsDerived() {
  const preset = getVal('setLabelPreset');
  const custom = document.querySelector('.settings-custom-size');
  if (custom) custom.classList.toggle('is-custom', preset === 'custom');
  ['setLabelW', 'setLabelH'].forEach((id) => { const el = document.getElementById(id); if (el) el.readOnly = preset !== 'custom'; });
  const type = getVal('setPrinterType');
  const hint = document.getElementById('printModeHint');
  const w = clampInt(getVal('setLabelW'), 20, 210, 70);
  const h = clampInt(getVal('setLabelH'), 15, 297, 42);
  const orient = getVal('setDymoOrient') === 'portrait' ? 'portrait' : 'landscape';
  const isDymo = type === 'dymo';
  document.querySelectorAll('.dymo-only').forEach((el) => { el.style.display = isDymo ? '' : 'none'; });
  const sel = document.getElementById('setLabelPreset');
  if (sel) sel.querySelectorAll('option').forEach((o) => {
    const d = !!(LABEL_PRESETS[o.value] && LABEL_PRESETS[o.value].dymo);
    o.hidden = o.value !== 'custom' && (isDymo ? !d : d);
  });
  if (hint) {
    if (isDymo) {
      const pn = (LABEL_PRESETS[preset] && LABEL_PRESETS[preset].name) || `${h}×${w} mm`;
      hint.textContent = `DYMO: μία ετικέτα ανά σελίδα (${pn}). Στο παράθυρο εκτύπωσης διάλεξε τον DYMO LabelWriter, Κλίμακα 100% / «Πραγματικό μέγεθος», Περιθώρια: Κανένα. Στις «Ρυθμίσεις εκτυπωτή» του οδηγού βάλε χαρτί ${pn.replace(/^DYMO /, '')}. ` + (orient === 'landscape' ? 'Αν βγει στραβά/κομμένη, άλλαξε τον Προσανατολισμό σε «Όρθιο».' : 'Αν βγει κομμένη, δοκίμασε Προσανατολισμό «Οριζόντιο».');
    } else if (preset === '70x42' && type !== 'thermal') hint.textContent = 'Τυπώνει σε φύλλα A4 με 21 αυτοκόλλητα (3×7). Στο παράθυρο εκτύπωσης: Κλίμακα 100% / «Πραγματικό μέγεθος», χωρίς περιθώρια.';
    else if (type === 'a4') hint.textContent = `Τυπώνει πολλές ετικέτες ${w}×${h} mm σε κάθε A4 με γραμμές κοπής.`;
    else hint.textContent = `Κάθε ετικέτα ${w}×${h} mm τυπώνεται σε δική της σελίδα. Στον οδηγό του εκτυπωτή διάλεξε το ίδιο χαρτί ${w}×${h} mm.`;
  }
  // Preview
  const box = document.getElementById('labelPreviewBox');
  if (box && settingsPreviewSize !== `${w}x${h}`) {
    settingsPreviewSize = `${w}x${h}`;  // preview always landscape (how it reads on the label)
    const { root } = buildSizedLabels([locationCodeToLabelSpec('Β-07-2')], { w, h });
    box.innerHTML = '';
    box.appendChild(root);
  }
  const sum = document.getElementById('zonesSummary');
  if (sum && draftZones) {
    let n = 0;
    draftZones.forEach((z) => {
      const nz = normalizeSettings({ zones: [z] }).zones[0];
      if (nz) n += zoneLocationCodes(nz).length + zoneAisleCodes(nz).length;
    });
    sum.textContent = `Σύνολο: ${n} ετικέτες θέσεων.`;
  }
}
let settingsPreviewSize = '';

function handleLogoFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 240;
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * sc));
      c.height = Math.max(1, Math.round(img.height * sc));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      draftLogo = c.toDataURL('image/jpeg', 0.85);
      settingsFormDirty = true;
      renderLogoPreview();
    };
    img.onerror = () => showToast('Μη έγκυρη εικόνα', 'error');
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
}

function removeCompanyLogo() {
  draftLogo = '';
  settingsFormDirty = true;
  const fi = document.getElementById('setCompanyLogoFile');
  if (fi) fi.value = '';
  renderLogoPreview();
}

function renderLogoPreview() {
  const img = document.getElementById('setCompanyLogoPreview');
  const btn = document.getElementById('btnRemoveLogo');
  if (img) { img.hidden = !draftLogo; if (draftLogo) img.src = draftLogo; else img.removeAttribute('src'); }
  if (btn) btn.hidden = !draftLogo;
}

function saveSettingsFromForm() {
  const letters = (draftZones || []).map((z) => String(z.letter || '').trim().toUpperCase()).filter(Boolean);
  const dup = letters.find((l, i) => letters.indexOf(l) !== i);
  if (dup) { showToast(`Η ζώνη ${dup} υπάρχει δύο φορές`, 'error'); return; }
  if (letters.some((l) => /[-:\s]/.test(l))) { showToast('Το γράμμα ζώνης δεν μπορεί να έχει παύλα ή κενό', 'error'); return; }
  const sc = document.getElementById('setShowCompanyOnLabels');
  const next = normalizeSettings({
    printer: {
      type: getVal('setPrinterType'),
      model: getVal('setPrinterModel').trim(),
      labelPreset: getVal('setLabelPreset'),
      width: getVal('setLabelW'),
      height: getVal('setLabelH'),
      showCompany: sc ? sc.checked : true,
      orient: getVal('setDymoOrient')
    },
    zones: draftZones || [],
    company: {
      name: getVal('setCompanyName').trim(),
      address: getVal('setCompanyAddress').trim(),
      phone: getVal('setCompanyPhone').trim(),
      vat: getVal('setCompanyVat').trim(),
      logo: draftLogo
    },
    expiryDays: getVal('setExpiryDays')
  });
  appSettings = next;
  mirrorSettingsToLocal();
  settingsFormDirty = false;
  settingsPreviewSize = '';
  onSettingsChanged(false);
  if (cloudEnabled && db) {
    db.collection('settings').doc('main').set({ ...next, updatedAt: new Date().toISOString() })
      .then(() => showToast('Οι ρυθμίσεις αποθηκεύτηκαν για όλες τις συσκευές', 'success'))
      .catch((err) => {
        console.error('Settings save failed:', err);
        showToast('Αποθηκεύτηκαν μόνο τοπικά — σφάλμα cloud', 'error');
      });
  } else {
    showToast('Οι ρυθμίσεις αποθηκεύτηκαν (τοπικά)', 'success');
  }
}
