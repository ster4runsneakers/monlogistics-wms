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
let pendingPickContext = null; // { listId, lineId, palletId, available, expiry }
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
  if (diffDays <= 7) return 'soon';
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

/** Fold Greek/Latin text for search: lowercase + strip diacritics (φέτα ≈ φετα). */
function foldSearchText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ς/g, 'σ')
    .trim();
}

/** Partial, case-insensitive match of query against item name */
function productNamePartialMatch(itemName, query) {
  const a = foldSearchText(itemName);
  const q = foldSearchText(query);
  if (!a || !q) return false;
  return a.includes(q);
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

function itemNameMatches(itemName, productName) {
  const a = String(itemName || '').trim().toLowerCase();
  const b = String(productName || '').trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
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
      if (!itemNameMatches(item && item.name, name)) return;
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
        locationType
      });
    });
  });

  candidates.sort((a, b) => {
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
  if (/σύνολο|συνολο|total|υποσυνολο|υποσύνολο/.test(n)) return true;
  if (/κωδικος|κωδικός|περιγραφη|περιγραφή|ποσοτητα|ποσότητα|αποθηκευτικη|αποθηκευτική|θεση|θέση/.test(n)
      && !/\d{2}-\d{5,}/.test(line) && !/\d+[.,]\d{2}/.test(line)) {
    // header-ish without product codes / qty decimals
    if (/κωδικος|περιγραφ|ποσοτ|ειδος|είδος|μ\.μ|μμ\b/.test(n)) return true;
  }
  return false;
}

function extractMetaFromSlipText(text) {
  let customer = '';
  let orderRef = '';
  const raw = String(text || '');

  const custRe = /ΕΠΩΝΥΜΙΑ[:\s]*([^\n\r]+)/i;
  const mCust = raw.match(custRe);
  if (mCust) {
    customer = mCust[1].replace(/ΑΦΜ.*$/i, '').replace(/\s{2,}/g, ' ').trim();
  }

  const orderRes = [
    /ΑΡΙΘΜΟΣ\s*(?:ΠΑΡΑΓΓΕΛΙΑΣ)?[:\s#]*([0-9]{2,})/i,
    /ΠΑΡΑΓΓΕΛΙΑ[:\s#]*([0-9]{2,})/i,
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
 * Rows: optional code 30-…, description, qty like 1.00 / 3.00 — product name = description.
 */
function parseOrderSlipTextToMatrix(text) {
  const { customer, orderRef } = extractMetaFromSlipText(text);
  const matrix = [['ΚΩΔΙΚΟΣ', 'ΠΕΡΙΓΡΑΦΗ', 'ΠΟΣΟΤΗΤΑ', 'ΠΕΛΑΤΗΣ', 'ΠΑΡΑΓΓΕΛΙΑ']];
  const lines = String(text || '').replace(/\r/g, '').split(/\n+/);
  const rowRe = /^(?:\s*(30-\d{6,})\s+)?(.+?)\s+(\d+(?:[.,]\d{1,3})?)\s*$/;

  for (const rawLine of lines) {
    let line = String(rawLine || '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isSlipHeaderOrTotalLine(line)) continue;

    // Drop leading junk bullets
    line = line.replace(/^[-–•·]+\s*/, '');

    const m = line.match(rowRe);
    if (!m) continue;
    const code = (m[1] || '').trim();
    let desc = (m[2] || '').trim();
    const qtyRaw = (m[3] || '').trim();

    // Skip if description is clearly a label/meta
    if (isSlipHeaderOrTotalLine(desc)) continue;
    if (/^(επωνυμια|αριθμος|ημερομηνια|σελίδα|σελιδα)/i.test(normalizeImportHeader(desc))) continue;

    // Prefer description; if OCR glued code into desc without capture, peel it
    if (!code) {
      const peel = desc.match(/^(30-\d{6,})\s+(.+)$/);
      if (peel) {
        matrix.push([peel[1], peel[2].trim(), qtyRaw, customer, orderRef]);
        continue;
      }
    }

    // Description must look like a product (letters), not just a number
    if (!/[A-Za-zΑ-Ωα-ωΆ-ώ]/.test(desc)) continue;
    if (desc.length < 3) continue;

    matrix.push([code, desc, qtyRaw, customer, orderRef]);
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
    // Fallback: try treating OCR lines as CSV-ish single column dump
    const loose = parseCsvText(text);
    if (loose && loose.length) {
      return { matrix: loose, customer: parsed.customer || '', orderRef: parsed.orderRef || '', rawText: text };
    }
    throw new Error('Δεν βρέθηκαν γραμμές προϊόντων στο PDF');
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
          <button type="button" class="btn btn-secondary btn-sm" style="margin-bottom:0.5rem;"
            data-pick-scan="${escapeHtml(pl.id)}" data-line-id="${escapeHtml(ln.id)}">
            <i data-lucide="scan-line" style="width: 14px;"></i>
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
      openPickModal({
        listId: btn.getAttribute('data-pick-scan'),
        lineId: btn.getAttribute('data-line-id'),
        palletId: null,
        available: null,
        expiry: null,
        mode: 'scan'
      });
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
