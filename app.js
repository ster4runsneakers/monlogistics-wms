const STATE_KEY = 'monlog_pallets_v1';
let pallets = [];
let activePalletForLabel = null;
let scanStepPallet = null;
let scanStepShelf = null;
let html5QrcodeScanner = null;
let isCameraActive = false;

document.addEventListener('DOMContentLoaded', () => {
  loadPalletsFromStorage();
  if (window.lucide) lucide.createIcons();
  generateAutoPalletId();
  renderInventoryTable();
  updateStats();
  populateSimulators();
  generateShelfGrid();
});

function loadPalletsFromStorage() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    pallets = raw ? JSON.parse(raw) : [];
  } catch (e) {
    pallets = [];
  }
}

function savePalletsToStorage() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(pallets));
  } catch (e) {
    console.error(e);
  }
  updateStats();
  populateSimulators();
}

function updateStats() {
  const total = pallets.length;
  const assigned = pallets.filter(p => p.shelf).length;
  document.getElementById('statTotalPallets').innerText = total;
  document.getElementById('statAssignedPallets').innerText = assigned;
  document.getElementById('statUnassignedPallets').innerText = total - assigned;
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  
  const btns = document.querySelectorAll('.nav-tab');
  btns.forEach(b => {
    if (b.getAttribute('onclick') && b.getAttribute('onclick').includes(tabId)) {
      b.classList.add('active');
    }
  });
  if (window.lucide) lucide.createIcons();
}

function generateAutoPalletId() {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  const input = document.getElementById('palletId');
  if (input) input.value = `PL-${randomNum}`;
}

function handleCreatePallet(e) {
  e.preventDefault();
  const customerInput = document.getElementById('customerName').value.trim();
  const palletIdInput = document.getElementById('palletId').value.trim().toUpperCase();

  if (!customerInput || !palletIdInput) {
    showToast('Συμπληρώστε όλα τα πεδία!', 'error');
    return;
  }

  let existingIndex = pallets.findIndex(p => p.id === palletIdInput);
  let palletObj;

  if (existingIndex >= 0) {
    pallets[existingIndex].customer = customerInput;
    palletObj = pallets[existingIndex];
  } else {
    palletObj = {
      id: palletIdInput,
      customer: customerInput,
      shelf: null,
      createdAt: new Date().toISOString()
    };
    pallets.unshift(palletObj);
  }

  savePalletsToStorage();
  renderInventoryTable();
  renderPalletLabel(palletObj);
  activePalletForLabel = palletObj;
  
  showToast(`Αποθηκεύτηκε: ${palletIdInput}`);
  generateAutoPalletId();
}

function renderPalletLabel(pallet) {
  document.getElementById('previewCustomer').innerText = pallet.customer;
  document.getElementById('previewPalletId').innerText = pallet.id;
  const dateFormatted = new Date(pallet.createdAt || Date.now()).toLocaleDateString('el-GR');
  document.getElementById('previewDate').innerText = `Ημ/νία: ${dateFormatted}`;

  const qrContainer = document.getElementById('qrcodeCanvas');
  qrContainer.innerHTML = '';

  const payload = JSON.stringify({ type: 'PALLET', id: pallet.id, customer: pallet.customer });

  if (window.QRCode) {
    new QRCode(qrContainer, {
      text: payload,
      width: 120,
      height: 120,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  }
}

function printActiveLabel() {
  if (!activePalletForLabel) {
    showToast('Δημιουργήστε πρώτα ετικέτα!', 'error');
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

function populateSimulators() {
  const select = document.getElementById('simPalletSelect');
  if (!select) return;
  select.innerHTML = '<option value="">-- Επιλέξτε Παλέτα --</option>';
  pallets.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.innerText = `${p.id} - ${p.customer}`;
    select.appendChild(opt);
  });
}

function simulatePalletScan(palletId) {
  if (!palletId) { scanStepPallet = null; updateLinkUI(); return; }
  const p = pallets.find(x => x.id === palletId);
  scanStepPallet = p ? { id: p.id, customer: p.customer } : { id: palletId, customer: 'Άγνωστος' };
  updateLinkUI();
}

function simulateShelfScan(shelfCode) {
  if (!scanStepPallet) {
    showToast('Επιλέξτε πρώτα παλέτα!', 'error');
    return;
  }
  scanStepShelf = shelfCode;
  updateLinkUI();
}

function updateLinkUI() {
  const valPallet = document.getElementById('stepValPallet');
  const displayPallet = document.getElementById('statusPalletDisplay');
  const displayCustomer = document.getElementById('statusCustomerDisplay');

  if (scanStepPallet) {
    valPallet.innerText = scanStepPallet.id;
    displayPallet.innerText = scanStepPallet.id;
    displayCustomer.innerText = scanStepPallet.customer;
  } else {
    valPallet.innerText = 'Εκκρεμεί';
    displayPallet.innerText = 'Δεν επιλέχθηκε';
    displayCustomer.innerText = '-';
  }

  const valShelf = document.getElementById('stepValShelf');
  const displayShelf = document.getElementById('statusShelfDisplay');
  const btnConfirm = document.getElementById('btnConfirmPair');

  if (scanStepShelf) {
    valShelf.innerText = scanStepShelf;
    displayShelf.innerHTML = `<span class="badge-shelf">📍 ${scanStepShelf}</span>`;
  } else {
    valShelf.innerText = 'Εκκρεμεί';
    displayShelf.innerHTML = `<span class="badge-unassigned">⚠️ Καμία</span>`;
  }

  btnConfirm.disabled = !(scanStepPallet && scanStepShelf);
}

function resetLinkSteps() {
  scanStepPallet = null;
  scanStepShelf = null;
  const sim = document.getElementById('simPalletSelect');
  if (sim) sim.value = '';
  updateLinkUI();
}

function confirmPairing() {
  if (!scanStepPallet || !scanStepShelf) return;
  let p = pallets.find(x => x.id === scanStepPallet.id);
  if (p) {
    p.shelf = scanStepShelf;
  } else {
    pallets.unshift({
      id: scanStepPallet.id,
      customer: scanStepPallet.customer || 'Γενικός',
      shelf: scanStepShelf,
      createdAt: new Date().toISOString()
    });
  }
  savePalletsToStorage();
  renderInventoryTable();
  showToast(`Συνδέθηκε: ${scanStepPallet.id} -> ${scanStepShelf}`);
  resetLinkSteps();
}

function renderInventoryTable() {
  const tbody = document.getElementById('inventoryTableBody');
  if (!tbody) return;
  const searchQuery = (document.getElementById('searchInput')?.value || '').toLowerCase();
  const filterStatus = document.getElementById('filterStatusSelect')?.value || 'ALL';

  let filtered = pallets.filter(p => {
    const match = p.customer.toLowerCase().includes(searchQuery) ||
                  p.id.toLowerCase().includes(searchQuery) ||
                  (p.shelf && p.shelf.toLowerCase().includes(searchQuery));
    if (!match) return false;
    if (filterStatus === 'ASSIGNED') return !!p.shelf;
    if (filterStatus === 'UNASSIGNED') return !p.shelf;
    return true;
  });

  tbody.innerHTML = '';
  filtered.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(p.customer)}</strong></td>
      <td><code>${escapeHtml(p.id)}</code></td>
      <td>${p.shelf ? `<span class="badge-shelf">${p.shelf}</span>` : `<span class="badge-unassigned">Εκτός</span>`}</td>
      <td style="text-align: right;">
        <button class="btn btn-danger btn-sm" onclick="deletePalletRow('${p.id}')">X</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function filterInventoryTable() { renderInventoryTable(); }

function deletePalletRow(palletId) {
  pallets = pallets.filter(x => x.id !== palletId);
  savePalletsToStorage();
  renderInventoryTable();
}

function generateShelfGrid() {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid) return;
  const zone = (document.getElementById('shelfZoneInput')?.value || 'Α').trim().toUpperCase();
  const from = parseInt(document.getElementById('shelfFromInput')?.value) || 1;
  const to = parseInt(document.getElementById('shelfToInput')?.value) || 5;

  grid.innerHTML = '';
  for (let i = from; i <= to; i++) {
    const code = `${zone}-${i < 10 ? '0' + i : i}`;
    const card = document.createElement('div');
    card.className = 'shelf-tag-card';
    const qrContainerId = `shelf-qr-${code}`;
    card.innerHTML = `
      <div class="shelf-tag-location">${code}</div>
      <div id="${qrContainerId}" style="margin: 0.3rem auto; display: flex; justify-content: center;"></div>
    `;
    grid.appendChild(card);

    if (window.QRCode) {
      new QRCode(document.getElementById(qrContainerId), {
        text: `SHELF:${code}`,
        width: 90,
        height: 90,
        colorDark: "#000000",
        colorLight: "#ffffff"
      });
    }
  }
}

function toggleCameraScanner() {
  const container = document.getElementById('cameraScannerContainer');
  if (isCameraActive) {
    if (html5QrcodeScanner) html5QrcodeScanner.stop();
    container.style.display = 'none';
    isCameraActive = false;
  } else {
    container.style.display = 'block';
    isCameraActive = true;
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 150, height: 150 } },
      text => {
        if (text.startsWith('SHELF:')) {
          simulateShelfScan(text.replace('SHELF:', '').trim());
        } else {
          simulatePalletScan(text);
        }
      }
    ).catch(() => showToast('Σφάλμα κάμερας', 'error'));
  }
}

function showToast(msg) {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerText = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function escapeHtml(str) {
  return str ? str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m])) : '';
}
