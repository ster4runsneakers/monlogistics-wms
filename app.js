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
let html5QrcodeScanner = null;
let isCameraActive = false;

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  loadPalletsFromStorage();
  
  // Initialize Lucide Icons if available
  if (window.lucide) {
    lucide.createIcons();
  }

  // Pre-fill initial form auto ID
  generateAutoPalletId();
  
  // Render initial table & statistics
  renderInventoryTable();
  updateStats();
  populateSimulators();
  generateShelfGrid();

  // If empty, suggest sample data
  if (pallets.length === 0) {
    seedSampleData(false);
  }
});

/* ==========================================================================
   STORAGE ENGINE
   ========================================================================== */
function loadPalletsFromStorage() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      pallets = JSON.parse(raw);
    } else {
      pallets = [];
    }
  } catch (e) {
    console.error('Failed to load local storage data:', e);
    pallets = [];
  }
}

function savePalletsToStorage() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(pallets));
  } catch (e) {
    console.error('Failed to save to local storage:', e);
  }
  updateStats();
  populateSimulators();
}

function updateStats() {
  const total = pallets.length;
  const assigned = pallets.filter(p => p.shelf !== null && p.shelf !== '').length;
  const unassigned = total - assigned;

  document.getElementById('statTotalPallets').innerText = total;
  document.getElementById('statAssignedPallets').innerText = assigned;
  document.getElementById('statUnassignedPallets').innerText = unassigned;
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

  savePalletsToStorage();
  renderInventoryTable();
  
  // Render label
  renderPalletLabel(palletObj);
  activePalletForLabel = palletObj;

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

  // Clear QR Container
  const qrContainer = document.getElementById('qrcodeCanvas');
  qrContainer.innerHTML = '';

  // QR Payload: JSON containing Pallet metadata
  const payload = JSON.stringify({
    type: 'PALLET',
    id: pallet.id,
    customer: pallet.customer
  });

  // Render QR Code using QRCode library or fallback canvas
  if (window.QRCode) {
    new QRCode(qrContainer, {
      text: payload,
      width: 140,
      height: 140,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  } else {
    // Fallback simple Canvas rendering if library missing
    renderFallbackQR(qrContainer, payload);
  }
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
  updateLinkUI();
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
    valPallet.innerHTML = `<span style="color: var(--emerald);">✅ ${scanStepPallet.id}</span>`;
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
    valShelf.innerHTML = `<span style="color: var(--emerald);">✅ Ράφι ${scanStepShelf}</span>`;
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

  savePalletsToStorage();
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
      <span style="font-weight: 700; color: var(--text-main);">${palletId}</span>
      <span style="color: var(--text-muted); font-size: 0.75rem;"> (${customer})</span>
    </div>
    <div style="display: flex; align-items: center; gap: 0.5rem;">
      <span class="badge-shelf" style="font-size: 0.75rem; padding: 0.2rem 0.5rem;">📍 ${shelf}</span>
      <span style="font-size: 0.7rem; color: var(--text-dim);">${timeStr}</span>
    </div>
  `;
  container.prepend(item);

  // Keep max 4 recent
  if (container.children.length > 4) {
    container.removeChild(container.lastChild);
  }
}

/* CAMERA SCANNER ENGINE */
function toggleCameraScanner() {
  const container = document.getElementById('cameraScannerContainer');
  const btnText = document.getElementById('btnCamText');

  if (isCameraActive) {
    stopCameraScanner();
    container.style.display = 'none';
    btnText.innerText = 'Ενεργοποίηση Κάμερας';
    isCameraActive = false;
  } else {
    container.style.display = 'block';
    btnText.innerText = 'Aπενεργοποίηση Κάμερας';
    isCameraActive = true;
    startCameraScanner();
  }
}

function startCameraScanner() {
  if (!window.Html5Qrcode) {
    showToast('Το module κάμερας φορτώνει... Παρακαλώ δοκιμάστε τον Γρήγορο Προσομοιωτή!', 'error');
    return;
  }

  html5QrcodeScanner = new Html5Qrcode("reader");
  html5QrcodeScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 200, height: 200 } },
    (decodedText) => {
      onQrScanned(decodedText);
    },
    (errorMessage) => {
      // Scanning errors can be ignored
    }
  ).catch(err => {
    console.error('Camera access error:', err);
    showToast('Δεν βρέθηκε διαθέσιμη κάμερα. Χρησιμοποιήστε τον Γρήγορο Προσομοιωτή!', 'error');
  });
}

function stopCameraScanner() {
  if (html5QrcodeScanner) {
    html5QrcodeScanner.stop().then(() => {
      html5QrcodeScanner.clear();
    }).catch(err => console.error(err));
  }
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

  // Handle plain text like "PL-1001" or "A-14" or "SHELF:A-14"
  if (text.startsWith('SHELF:')) {
    const shelf = text.replace('SHELF:', '').trim();
    simulateShelfScan(shelf);
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

    const shelfBadgeHtml = p.shelf ? 
      `<span class="badge-shelf">📍 ${p.shelf}</span>` : 
      `<span class="badge-unassigned">⚠️ Εκτός Ραφιού</span>`;

    const dateStr = p.createdAt ? new Date(p.createdAt).toLocaleDateString('el-GR', {
      day: '2-digit', month: '2-digit', year: 'numeric'
    }) : '-';

    tr.innerHTML = `
      <td style="font-weight: 700; color: var(--text-main);">${escapeHtml(p.customer)}</td>
      <td>
        <span style="font-family: monospace; font-weight: 700; font-size: 0.95rem; background: rgba(99, 102, 241, 0.15); color: #818cf8; padding: 0.2rem 0.5rem; border-radius: 4px;">
          ${escapeHtml(p.id)}
        </span>
      </td>
      <td>${shelfBadgeHtml}</td>
      <td style="color: var(--text-muted); font-size: 0.85rem;">${dateStr}</td>
      <td style="text-align: right;">
        <div style="display: flex; gap: 0.4rem; justify-content: flex-end;">
          <button class="btn btn-secondary btn-sm" onclick="printRowLabel('${p.id}')" title="Εκτύπωση Ετικέτας">
            <i data-lucide="printer" style="width: 14px;"></i>
          </button>
          <button class="btn btn-primary btn-sm" onclick="quickPairRow('${p.id}')" title="Σύνδεση/Αλλαγή Θέσης">
            <i data-lucide="link" style="width: 14px;"></i>
          </button>
          <button class="btn btn-danger btn-sm" onclick="deletePalletRow('${p.id}')" title="Διαγραφή">
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
    savePalletsToStorage();
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

  const zone = document.getElementById('shelfZoneInput').value.trim().toUpperCase() || 'Α';
  const from = parseInt(document.getElementById('shelfFromInput').value) || 1;
  const to = parseInt(document.getElementById('shelfToInput').value) || 10;

  grid.innerHTML = '';

  for (let i = from; i <= to; i++) {
    const shelfCode = `${zone}-${i < 10 ? '0' + i : i}`;
    const card = document.createElement('div');
    card.className = 'shelf-tag-card';

    const qrId = `shelf-qr-${shelfCode}`;

    card.innerHTML = `
      <div class="shelf-tag-location">ΘΕΣΗ: ${shelfCode}</div>
      <div id="${qrId}" style="margin: 0.5rem 0;"></div>
      <div style="font-size: 0.65rem; color: #555; text-transform: uppercase;">MONLOGISTICS WMS - SHELF TAG</div>
    `;

    grid.appendChild(card);

    // Generate QR for Shelf Tag
    setTimeout(() => {
      const target = document.getElementById(qrId);
      if (target) {
        if (window.QRCode) {
          new QRCode(target, {
            text: `SHELF:${shelfCode}`,
            width: 110,
            height: 110,
            colorDark: "#000000",
            colorLight: "#ffffff"
          });
        } else {
          renderFallbackQR(target, `SHELF:${shelfCode}`);
        }
      }
    }, 50);
  }
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

  samplePallets.forEach(sample => {
    if (!pallets.some(p => p.id === sample.id)) {
      pallets.push(sample);
    }
  });

  savePalletsToStorage();
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

function renderFallbackQR(container, text) {
  // Simple Fallback Canvas SVG Matrix for offline rendering
  container.innerHTML = `
    <div style="background: #fff; padding: 10px; border: 2px solid #000; display: inline-block;">
      <svg width="120" height="120" viewBox="0 0 100 100" style="display: block;">
        <rect width="100" height="100" fill="white"/>
        <rect x="10" y="10" width="30" height="30" fill="black"/>
        <rect x="15" y="15" width="20" height="20" fill="white"/>
        <rect x="20" y="20" width="10" height="10" fill="black"/>
        
        <rect x="60" y="10" width="30" height="30" fill="black"/>
        <rect x="65" y="15" width="20" height="20" fill="white"/>
        <rect x="70" y="20" width="10" height="10" fill="black"/>

        <rect x="10" y="60" width="30" height="30" fill="black"/>
        <rect x="15" y="65" width="20" height="20" fill="white"/>
        <rect x="20" y="70" width="10" height="10" fill="black"/>
        
        <rect x="50" y="50" width="15" height="15" fill="black"/>
        <rect x="70" y="70" width="15" height="15" fill="black"/>
        <rect x="50" y="75" width="10" height="10" fill="black"/>
      </svg>
      <div style="font-size: 8px; color: #000; text-align: center; margin-top: 4px; font-weight: bold;">${escapeHtml(text.substring(0, 18))}</div>
    </div>
  `;
}
