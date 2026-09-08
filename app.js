function generateShelfGrid() {
  const grid = document.getElementById('shelfTagGrid');
  if (!grid) return;
  
  const zone = (document.getElementById('shelfZoneInput')?.value || 'Α').trim().toUpperCase();
  const from = parseInt(document.getElementById('shelfFromInput')?.value) || 1;
  const to = parseInt(document.getElementById('shelfToInput')?.value) || 5;

  // 1. Καθαρισμός του Grid
  grid.innerHTML = '';

  // 2. Δημιουργία όλων των DOM elements πρώτα
  const shelfCodes = [];
  for (let i = from; i <= to; i++) {
    const code = `${zone}-${i < 10 ? '0' + i : i}`;
    shelfCodes.push(code);

    const card = document.createElement('div');
    card.className = 'shelf-tag-card';
    const qrContainerId = `shelf-qr-${code}`;
    
    card.innerHTML = `
      <div class="shelf-tag-location">${code}</div>
      <div id="${qrContainerId}" class="qr-target" style="margin: 0.5rem auto; display: flex; justify-content: center; min-height: 90px; width: 90px;"></div>
    `;
    grid.appendChild(card);
  }

  // 3. Ασύγχρονο Rendering (requestAnimationFrame + setTimeout) 
  // Εξασφαλίζει ότι το DOM έχει σχεδιαστεί στην οθόνη πριν τη σχεδίαση του Canvas
  requestAnimationFrame(() => {
    setTimeout(() => {
      shelfCodes.forEach(code => {
        const targetEl = document.getElementById(`shelf-qr-${code}`);
        if (!targetEl) return;
        
        targetEl.innerHTML = ''; // Καθαρισμός τυχόν υπολειμμάτων

        // Έλεγχος διαθεσιμότητας βιβλιοθήκης με Canvas Fallback
        if (window.QRCode) {
          try {
            new QRCode(targetEl, {
              text: `SHELF:${code}`,
              width: 90,
              height: 90,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.M
            });
          } catch (e) {
            console.error(`Σφάλμα δημιουργίας QR για ${code}:`, e);
            renderFallbackQR(targetEl, `SHELF:${code}`);
          }
        } else {
          renderFallbackQR(targetEl, `SHELF:${code}`);
        }
      });
    }, 100);
  });
}
