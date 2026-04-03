/**
 * SVG Viewer — main.js
 * Features: load SVG (file / drag-drop / paste / URL), pan, zoom (wheel / pinch / buttons)
 */

(() => {
  'use strict';

  /* ── DOM refs ─────────────────────────────────────────────── */
  const canvasWrapper  = document.getElementById('canvas-wrapper');
  const svgContainer   = document.getElementById('svg-container');
  const fileInput      = document.getElementById('file-input');
  const fileNameEl     = document.getElementById('file-name');
  const dropOverlay    = document.getElementById('drop-overlay');
  const emptyHint      = document.getElementById('empty-hint');
  const zoomDisplay    = document.getElementById('zoom-display');
  const statusZoom     = document.getElementById('status-zoom');
  const statusPos      = document.getElementById('status-pos');
  const statusDim      = document.getElementById('status-dim');
  const statusMsg      = document.getElementById('status-msg');
  const infoPanel      = document.getElementById('info-panel');
  const toast          = document.getElementById('toast');

  // Info panel fields
  const infoWidth      = document.getElementById('info-width');
  const infoHeight     = document.getElementById('info-height');
  const infoViewBox    = document.getElementById('info-viewbox');
  const infoFileName   = document.getElementById('info-filename');
  const infoFileSize   = document.getElementById('info-filesize');
  const infoElementCount = document.getElementById('info-element-count');

  /* ── State ────────────────────────────────────────────────── */
  const state = {
    scale: 1,
    minScale: 0.05,
    maxScale: 50,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    svgLoaded: false,
    svgNativeW: 0,
    svgNativeH: 0,
    // pinch
    lastPinchDist: 0,
    isPinching: false,
  };

  /* ── Transform helpers ────────────────────────────────────── */
  function applyTransform() {
    svgContainer.style.transform =
      `translate(calc(-50% + ${state.translateX}px), calc(-50% + ${state.translateY}px)) scale(${state.scale})`;
    const pct = Math.round(state.scale * 100);
    zoomDisplay.textContent = pct + '%';
    statusZoom.textContent  = pct + '%';
  }

  function clampScale(s) {
    return Math.min(state.maxScale, Math.max(state.minScale, s));
  }

  /** Zoom toward a specific canvas-relative point (px, py). */
  function zoomAt(newScale, px, py) {
    newScale = clampScale(newScale);
    const ratio = newScale / state.scale;
    state.translateX = px + ratio * (state.translateX - px);
    state.translateY = py + ratio * (state.translateY - py);
    state.scale = newScale;
    applyTransform();
  }

  /* ── Load SVG ─────────────────────────────────────────────── */
  function loadSVGText(svgText, fileName, fileSize) {
    // Sanitise: remove script tags
    svgText = svgText.replace(/<script[\s\S]*?<\/script>/gi, '');

    svgContainer.innerHTML = svgText;
    const svgEl = svgContainer.querySelector('svg');
    if (!svgEl) { showToast('无效的 SVG 文件'); return; }

    // Ensure SVG fills its natural size
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.width  = '';
    svgEl.style.height = '';

    // Get dimensions
    let w = svgEl.viewBox.baseVal.width  || svgEl.getBoundingClientRect().width  || 400;
    let h = svgEl.viewBox.baseVal.height || svgEl.getBoundingClientRect().height || 300;

    // Set explicit px size so it renders predictably
    svgEl.setAttribute('width',  w);
    svgEl.setAttribute('height', h);

    state.svgNativeW = w;
    state.svgNativeH = h;
    state.svgLoaded  = true;

    resetView();
    emptyHint.classList.add('hidden');
    canvasWrapper.classList.remove('empty-state');

    // Update info panel
    const viewBox = svgEl.getAttribute('viewBox') || '—';
    const elCount = svgEl.querySelectorAll('*').length;
    infoWidth.textContent        = w + 'px';
    infoHeight.textContent       = h + 'px';
    infoViewBox.textContent      = viewBox;
    infoFileName.textContent     = fileName || '—';
    infoFileSize.textContent     = fileSize ? formatBytes(fileSize) : '—';
    infoElementCount.textContent = elCount;
    statusDim.textContent        = `${w} × ${h}`;
    fileNameEl.textContent       = fileName || '';

    showToast('SVG 加载成功');
    setStatus('加载完成');
  }

  function loadSVGFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.svg')) {
      showToast('请选择 .svg 文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = e => loadSVGText(e.target.result, file.name, file.size);
    reader.readAsText(file);
  }

  /* ── Fit / reset view ─────────────────────────────────────── */
  function resetView() {
    if (!state.svgLoaded) return;
    const { width: cw, height: ch } = canvasWrapper.getBoundingClientRect();
    const padding = 40;
    const scaleX = (cw - padding * 2) / state.svgNativeW;
    const scaleY = (ch - padding * 2) / state.svgNativeH;
    state.scale      = clampScale(Math.min(scaleX, scaleY, 1));
    state.translateX = 0;
    state.translateY = 0;
    applyTransform();
  }

  function zoomToActual() {
    state.scale      = 1;
    state.translateX = 0;
    state.translateY = 0;
    applyTransform();
  }

  /* ── Wheel zoom ───────────────────────────────────────────── */
  canvasWrapper.addEventListener('wheel', e => {
    if (!state.svgLoaded) return;
    e.preventDefault();

    const rect = canvasWrapper.getBoundingClientRect();
    // pointer position relative to canvas center
    const px = e.clientX - rect.left - rect.width  / 2;
    const py = e.clientY - rect.top  - rect.height / 2;

    const delta    = e.deltaY < 0 ? 1 : -1;
    const factor   = e.ctrlKey ? 0.05 : 0.12; // fine-grained with ctrl
    const newScale = state.scale * (1 + delta * factor);
    zoomAt(newScale, px, py);
  }, { passive: false });

  /* ── Mouse pan ────────────────────────────────────────────── */
  canvasWrapper.addEventListener('mousedown', e => {
    if (!state.svgLoaded || e.button !== 0) return;
    state.isDragging = true;
    state.dragStartX = e.clientX - state.translateX;
    state.dragStartY = e.clientY - state.translateY;
    canvasWrapper.classList.add('dragging');
  });

  window.addEventListener('mousemove', e => {
    if (!state.isDragging) return;
    state.translateX = e.clientX - state.dragStartX;
    state.translateY = e.clientY - state.dragStartY;
    const rect = canvasWrapper.getBoundingClientRect();
    statusPos.textContent =
      `${Math.round(e.clientX - rect.left)}, ${Math.round(e.clientY - rect.top)}`;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    state.isDragging = false;
    canvasWrapper.classList.remove('dragging');
  });

  /* ── Touch pan & pinch ────────────────────────────────────── */
  let touchStartX = 0, touchStartY = 0;

  canvasWrapper.addEventListener('touchstart', e => {
    if (!state.svgLoaded) return;
    if (e.touches.length === 2) {
      state.isPinching    = true;
      state.lastPinchDist = pinchDist(e.touches);
    } else if (e.touches.length === 1) {
      state.isPinching = false;
      touchStartX = e.touches[0].clientX - state.translateX;
      touchStartY = e.touches[0].clientY - state.translateY;
    }
  }, { passive: true });

  canvasWrapper.addEventListener('touchmove', e => {
    if (!state.svgLoaded) return;
    e.preventDefault();
    if (e.touches.length === 2 && state.isPinching) {
      const dist   = pinchDist(e.touches);
      const ratio  = dist / state.lastPinchDist;
      const rect   = canvasWrapper.getBoundingClientRect();
      const midX   = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left - rect.width  / 2;
      const midY   = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top  - rect.height / 2;
      zoomAt(state.scale * ratio, midX, midY);
      state.lastPinchDist = dist;
    } else if (e.touches.length === 1 && !state.isPinching) {
      state.translateX = e.touches[0].clientX - touchStartX;
      state.translateY = e.touches[0].clientY - touchStartY;
      applyTransform();
    }
  }, { passive: false });

  canvasWrapper.addEventListener('touchend', () => {
    if (!state.isPinching) return;
    state.isPinching = false;
  }, { passive: true });

  function pinchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  /* ── Drag-drop file ───────────────────────────────────────── */
  canvasWrapper.addEventListener('dragover', e => {
    e.preventDefault();
    dropOverlay.classList.add('active');
  });

  canvasWrapper.addEventListener('dragleave', e => {
    if (!canvasWrapper.contains(e.relatedTarget))
      dropOverlay.classList.remove('active');
  });

  canvasWrapper.addEventListener('drop', e => {
    e.preventDefault();
    dropOverlay.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file) loadSVGFile(file);
  });

  /* ── File input ───────────────────────────────────────────── */
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadSVGFile(fileInput.files[0]);
    fileInput.value = '';
  });

  /* ── Paste from clipboard ─────────────────────────────────── */
  document.addEventListener('paste', async e => {
    // Try text/plain SVG
    const text = e.clipboardData.getData('text/plain');
    if (text.trim().startsWith('<svg') || text.trim().startsWith('<?xml')) {
      loadSVGText(text, 'clipboard.svg', null);
      return;
    }
    // Try image file
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/svg')) {
        const file = item.getAsFile();
        if (file) { loadSVGFile(file); return; }
      }
    }
  });

  /* ── Toolbar buttons ──────────────────────────────────────── */
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    zoomAt(state.scale * 1.25, 0, 0);
  });

  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    zoomAt(state.scale / 1.25, 0, 0);
  });

  document.getElementById('btn-fit').addEventListener('click', resetView);

  document.getElementById('btn-actual').addEventListener('click', zoomToActual);

  document.getElementById('btn-toggle-panel').addEventListener('click', () => {
    infoPanel.classList.toggle('hidden');
  });

  /* ── Keyboard shortcuts ───────────────────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.key) {
      case '=': case '+': zoomAt(state.scale * 1.2, 0, 0); break;
      case '-': case '_': zoomAt(state.scale / 1.2, 0, 0); break;
      case '0':           resetView();      break;
      case '1':           zoomToActual();   break;
    }
  });

  /* ── Export ───────────────────────────────────────────────── */
  document.getElementById('btn-export-svg').addEventListener('click', () => {
    const svgEl = svgContainer.querySelector('svg');
    if (!svgEl) { showToast('请先加载 SVG'); return; }
    const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml' });
    downloadBlob(blob, 'exported.svg');
    showToast('SVG 已导出');
  });

  document.getElementById('btn-export-png').addEventListener('click', async () => {
    const svgEl = svgContainer.querySelector('svg');
    if (!svgEl) { showToast('请先加载 SVG'); return; }

    setStatus('正在导出 PNG…');
    const w = state.svgNativeW;
    const h = state.svgNativeH;
    const scale = 2; // retina

    const canvas = document.createElement('canvas');
    canvas.width  = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const xml  = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([xml], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        downloadBlob(b, 'exported.png');
        showToast('PNG 已导出 (@2x)');
        setStatus('导出完成');
      });
    };
    img.src = url;
  });

  /* ── Utilities ────────────────────────────────────────────── */
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }

  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function setStatus(msg) {
    statusMsg.textContent = msg;
    setTimeout(() => { statusMsg.textContent = ''; }, 3000);
  }

  /* ── Init ─────────────────────────────────────────────────── */
  canvasWrapper.classList.add('empty-state');
  applyTransform();

})();
