// App orchestrator: state, view routing, capture, crop UI, filter, export.
window.DS = window.DS || {};

(() => {
  const { $, $$, toast, uid, fileToImage, canvasToBlob, shareBlob, downloadBlob,
          formatDate, safeFilename, haptic } = DS;
  const I = DS.imaging;
  const P = DS.pdf;
  const DB = DS.db;

  // Human-readable build number shown in the corner pill. Bump on each ship.
  const APP_VERSION = 'v6';

  // Auto-save the current scan to "My Scans" so nothing is ever lost when the
  // user navigates away. Cheap enough to call after each edit (not per stroke).
  async function persist() {
    try {
      if (state.doc && state.doc.pages.length) await saveDocToLibrary();
    } catch (e) { console.warn('autosave failed', e); }
  }

  // ---------- state ----------
  const state = {
    view: 'home',
    doc: null,           // { id, name, createdAt, updatedAt, pages: [...] }
    pageIdx: 0,
    pendingFilter: null, // for the filter pane
    drag: null,          // active corner drag
  };

  // page = {
  //   id, sourceBlob, sourceCanvas (display-sized),
  //   sourceFullCanvas (original-size for dewarp),
  //   corners: [[u,v]] normalised,
  //   filter: 'colour'|'grey'|'bw'|'enhance',
  //   processed: HTMLCanvasElement (dewarp + filter applied),
  // }

  // ---------- view routing ----------
  const VIEWS = ['home', 'review', 'crop', 'filter', 'annotate', 'export', 'library'];

  function setView(name) {
    state.view = name;
    for (const v of VIEWS) {
      const el = $(`#view-${v}`);
      if (el) el.hidden = (v !== name);
    }
    const showBack = (name !== 'home');
    $('#back-btn').hidden = !showBack;
    $('#library-btn').hidden = (name === 'library');
    $('#page-title').textContent = {
      home: 'Scanner',
      review: state.doc ? (state.doc.name || 'Untitled') : 'Review',
      crop: 'Crop & Align',
      filter: 'Filter',
      annotate: 'Annotate',
      export: 'Export',
      library: 'My Scans',
    }[name] || 'Scanner';
    window.scrollTo(0, 0);
  }

  async function back() {
    if (state.view === 'review') {
      // Scans auto-save to "My Scans", so backing out never loses anything.
      await persist();
      state.doc = null;
      await renderHome();
      setView('home');
      return;
    }
    if (state.view === 'crop' || state.view === 'filter' || state.view === 'annotate' || state.view === 'export') {
      setView('review');
      renderReview();
      return;
    }
    if (state.view === 'library') {
      setView('home');
      renderHome();
      return;
    }
  }

  // ---------- doc / page lifecycle ----------
  function newDoc() {
    state.doc = {
      id: 'd_' + Date.now().toString(36),
      name: defaultDocName(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pages: [],
    };
    state.pageIdx = 0;
  }

  function defaultDocName() {
    const d = new Date();
    return 'Scan ' + d.toISOString().slice(0, 10) + ' ' + d.toTimeString().slice(0, 5);
  }

  async function addPagesFromFiles(files) {
    if (!files || !files.length) return;
    if (!state.doc) newDoc();
    const list = Array.from(files);
    for (const f of list) {
      try {
        const page = await pageFromFile(f);
        state.doc.pages.push(page);
      } catch (e) {
        console.warn('skip file', f.name, e);
      }
    }
    state.pageIdx = state.doc.pages.length - 1;
    state.doc.updatedAt = Date.now();
    setView('review');
    renderReview();
    await persist();
  }

  async function pageFromFile(file) {
    const img = await fileToImage(file);
    const fullCanvas = I.imgToCanvas(img, 2400);
    const displayCanvas = I.imgToCanvas(img, 1200);
    const corners = I.autoDetectCorners(img);
    const full = I.fullImageCorners();
    const foundEdges = !corners.every((p, i) =>
      Math.abs(p[0] - full[i][0]) < 1e-6 && Math.abs(p[1] - full[i][1]) < 1e-6);
    const page = {
      id: uid(),
      sourceBlob: file,
      sourceFullCanvas: fullCanvas,
      sourceCanvas: displayCanvas,
      corners,
      autoEdges: foundEdges,
      filter: 'auto',
      annotations: { strokes: [], texts: [] },
      processed: null,
    };
    page.processed = await processPage(page);
    return page;
  }

  async function processPage(page) {
    let c = I.dewarp(page.sourceFullCanvas, page.corners, 2000);
    c = I.applyFilter(c, page.filter);
    return c;
  }

  // ---------- HOME ----------
  async function renderHome() {
    await renderLibraryGrid($('#library-grid'), 8);
  }

  async function renderLibraryGrid(container, limit, query = '') {
    const items = await DB.listAll();
    $('#scan-count').textContent = `${items.length}`;
    const q = (query || '').trim().toLowerCase();
    const filtered = q ? items.filter(r => (r.name || '').toLowerCase().includes(q)) : items;
    if (!filtered.length) {
      container.innerHTML = q
        ? `<div class="empty-hint"><p>No matches for <strong>${escapeHtml(query)}</strong>.</p></div>`
        : `<div class="empty-hint">
            <p>No scans yet. Tap <strong>Take a Photo</strong> to start.</p>
            <p class="small muted">Every scan is saved here, private to this device. Nothing is uploaded.</p>
          </div>`;
      return;
    }
    const list = limit ? filtered.slice(0, limit) : filtered;
    container.innerHTML = '';
    for (const rec of list) {
      const card = document.createElement('div');
      card.className = 'library-card';
      card.dataset.id = rec.id;
      const thumbUrl = rec.thumbBlob ? URL.createObjectURL(rec.thumbBlob) : '';
      card.innerHTML = `
        <button class="del-btn" aria-label="Delete">×</button>
        <img alt="" src="${thumbUrl}" />
        <div class="meta">
          <div class="name">${escapeHtml(rec.name || 'Untitled')}</div>
          <div class="sub">${rec.pages?.length || 0} page${(rec.pages?.length || 0) === 1 ? '' : 's'} · ${formatDate(rec.updatedAt)}</div>
        </div>`;
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('del-btn')) return;
        openLibraryItem(rec.id);
      });
      card.querySelector('.del-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${rec.name || 'Untitled'}"? This cannot be undone.`)) return;
        await DB.remove(rec.id);
        toast('Deleted');
        const search = $('#library-search')?.value || '';
        await renderLibraryGrid(container, limit, search);
        const cnt = await DB.count();
        if ($('#library-count')) $('#library-count').textContent = `${cnt} scan${cnt === 1 ? '' : 's'}`;
      });
      container.appendChild(card);
    }
  }

  async function openLibraryItem(id) {
    const rec = await DB.get(id);
    if (!rec) return;
    const doc = {
      id: rec.id,
      name: rec.name,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      pages: [],
    };
    for (const sp of rec.pages) {
      const sourceImg = await blobToImage(sp.sourceBlob);
      const fullCanvas = I.imgToCanvas(sourceImg, 2400);
      const displayCanvas = I.imgToCanvas(sourceImg, 1200);
      const processed = sp.processedBlob ? await blobToCanvas(sp.processedBlob) : null;
      doc.pages.push({
        id: sp.id || uid(),
        sourceBlob: sp.sourceBlob,
        sourceFullCanvas: fullCanvas,
        sourceCanvas: displayCanvas,
        corners: sp.corners || I.fullImageCorners(),
        filter: sp.filter || 'colour',
        annotations: sp.annotations || { strokes: [], texts: [] },
        processed,
      });
    }
    state.doc = doc;
    state.pageIdx = 0;
    setView('review');
    renderReview();
  }

  function blobToImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
      img.src = url;
    });
  }
  async function blobToCanvas(blob) {
    const img = await blobToImage(blob);
    return I.imgToCanvas(img);
  }

  // ---------- REVIEW ----------
  function renderReview() {
    if (!state.doc || !state.doc.pages.length) {
      setView('home'); renderHome(); return;
    }
    const idx = Math.max(0, Math.min(state.pageIdx, state.doc.pages.length - 1));
    state.pageIdx = idx;
    const page = state.doc.pages[idx];
    const stageCanvas = $('#review-canvas');
    drawCanvasInto(stageCanvas, page.processed || page.sourceCanvas);

    const note = $('#review-note');
    if (note) {
      const n = state.doc.pages.length;
      const filterLabel = { auto: 'Auto-cleaned', grey: 'Greyscale', bw: 'B&W', colour: 'Original', enhance: 'Auto-cleaned' }[page.filter] || 'Auto-cleaned';
      const edgeMsg = page.autoEdges === false ? 'no edges found — tap Crop' : 'cropped to page';
      note.textContent = `✨ ${filterLabel} · ${edgeMsg} · ${n} page${n === 1 ? '' : 's'} saved`;
    }

    const strip = $('#page-strip');
    strip.innerHTML = '';
    state.doc.pages.forEach((p, i) => {
      const t = document.createElement('button');
      t.className = 'page-thumb' + (i === idx ? ' active' : '');
      t.type = 'button';
      const src = (p.processed || p.sourceCanvas).toDataURL('image/jpeg', 0.6);
      t.innerHTML = `<span class="idx">${i + 1}</span><img alt="page ${i + 1}" src="${src}" />`;
      t.addEventListener('click', () => { state.pageIdx = i; renderReview(); });
      strip.appendChild(t);
    });
  }

  function drawCanvasInto(targetCanvas, srcCanvas) {
    // Fit srcCanvas into a sensible display size while keeping aspect ratio.
    const maxW = Math.min(1100, srcCanvas.width);
    const ratio = srcCanvas.height / srcCanvas.width;
    const W = maxW;
    const H = Math.round(W * ratio);
    targetCanvas.width = W;
    targetCanvas.height = H;
    const ctx = targetCanvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(srcCanvas, 0, 0, W, H);
  }

  // ---------- CROP ----------
  let cropDisplayDims = { dx: 0, dy: 0, dw: 0, dh: 0 };

  function openCrop() {
    const page = currentPage();
    if (!page) return;
    setView('crop');
    // Defer to next frame so the stage has real layout measurements.
    requestAnimationFrame(() => renderCrop(page));
  }

  function renderCrop(page) {
    const stage = $('#crop-stage');
    const canvas = $('#crop-canvas');
    const overlay = $('#crop-overlay');
    const poly = $('#crop-poly');
    const handles = $$('.handle', overlay);

    // Fit the source display canvas inside the stage.
    const padding = 12;
    const stageRect = stage.getBoundingClientRect();
    const availW = stageRect.width - padding * 2;
    const availH = Math.min(window.innerHeight * 0.60, stageRect.height - padding * 2);
    const src = page.sourceCanvas;
    const arSrc = src.width / src.height;
    let dw = availW, dh = availW / arSrc;
    if (dh > availH) { dh = availH; dw = availH * arSrc; }
    canvas.width = Math.round(dw);
    canvas.height = Math.round(dh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dw, dh);

    // Position SVG overlay to match canvas exactly.
    const cRect = canvas.getBoundingClientRect();
    const sRect = stage.getBoundingClientRect();
    overlay.style.left   = (cRect.left - sRect.left) + 'px';
    overlay.style.top    = (cRect.top - sRect.top) + 'px';
    overlay.style.width  = dw + 'px';
    overlay.style.height = dh + 'px';
    overlay.setAttribute('viewBox', `0 0 ${dw} ${dh}`);
    cropDisplayDims = { dw, dh };

    drawCropOverlay(page);
  }

  function drawCropOverlay(page) {
    const overlay = $('#crop-overlay');
    const poly = $('#crop-poly');
    const handles = $$('.handle', overlay);
    const { dw, dh } = cropDisplayDims;
    const pts = page.corners.map(([u, v]) => [u * dw, v * dh]);
    poly.setAttribute('points', pts.map(p => `${p[0]},${p[1]}`).join(' '));
    handles.forEach((h, i) => {
      h.setAttribute('cx', pts[i][0]);
      h.setAttribute('cy', pts[i][1]);
    });
  }

  function bindCropDrag() {
    const overlay = $('#crop-overlay');
    overlay.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (!target.classList || !target.classList.contains('handle')) return;
      const i = parseInt(target.dataset.i, 10);
      state.drag = { i, pointerId: e.pointerId };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!state.drag || state.drag.pointerId !== e.pointerId) return;
      const page = currentPage();
      if (!page) return;
      const rect = overlay.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width,  e.clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
      page.corners[state.drag.i] = [x / rect.width, y / rect.height];
      drawCropOverlay(page);
    });
    function endDrag(e) {
      if (state.drag && state.drag.pointerId === e.pointerId) {
        try { overlay.releasePointerCapture(e.pointerId); } catch {}
        state.drag = null;
      }
    }
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);
  }

  async function applyCrop() {
    const page = currentPage();
    if (!page) return;
    haptic();
    page.processed = await processPage(page);
    setView('review'); renderReview();
    await persist();
    toast('Cropped');
  }

  async function autoDetectAgain() {
    const page = currentPage();
    if (!page) return;
    // Use the display-size source for speed.
    const c = I.autoDetectCorners(page.sourceCanvas);
    page.corners = c;
    drawCropOverlay(page);
    toast('Auto-detected');
  }

  function useFullPage() {
    const page = currentPage();
    if (!page) return;
    page.corners = [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]];
    drawCropOverlay(page);
  }

  // ---------- FILTER ----------
  function openFilter() {
    const page = currentPage();
    if (!page) return;
    state.pendingFilter = page.filter || 'auto';
    setView('filter');
    drawCanvasInto($('#filter-canvas'), page.processed || page.sourceCanvas);
    $$('#view-filter .filter-chip').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.filter === state.pendingFilter ? 'true' : 'false');
    });
  }

  async function previewFilter(kind) {
    const page = currentPage();
    if (!page) return;
    state.pendingFilter = kind;
    $$('#view-filter .filter-chip').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.filter === kind ? 'true' : 'false');
    });
    const baseCanvas = I.dewarp(page.sourceFullCanvas, page.corners, 1400);
    const filtered = I.applyFilter(baseCanvas, kind);
    drawCanvasInto($('#filter-canvas'), filtered);
  }

  async function applyFilterChoice() {
    const page = currentPage();
    if (!page) return;
    page.filter = state.pendingFilter || 'auto';
    page.processed = await processPage(page);
    setView('review'); renderReview();
    await persist();
    toast('Filter applied');
  }

  // ---------- EXPORT ----------
  function openExport() {
    if (!state.doc) return;
    setView('export');
    $('#export-name').value = state.doc.name || 'Scan';
    $('#export-summary').textContent =
      `${state.doc.pages.length} page${state.doc.pages.length === 1 ? '' : 's'}`;
  }

  async function exportPdf({ share = false } = {}) {
    if (!state.doc) return;
    const name = ($('#export-name').value || 'Scan').trim();
    state.doc.name = name;
    const paper = $('#export-paper').value;
    const password = ($('#export-password').value || '').trim();
    const pages = [];
    for (const p of state.doc.pages) {
      const baseCanvas = p.processed || I.dewarp(p.sourceFullCanvas, p.corners);
      const baked = DS.annotate.bake(p, baseCanvas);
      const jpeg = await P.canvasToJpegBytes(baked, 0.86);
      pages.push({ jpeg, widthPx: baked.width, heightPx: baked.height });
    }
    const blob = await P.buildPdf(pages, { paper, title: name, password });
    await saveDocToLibrary();
    const filename = safeFilename(name) + (password ? '-locked' : '') + '.pdf';
    if (share) {
      await shareBlob(blob, filename, name);
    } else {
      downloadBlob(blob, filename);
    }
    toast(share ? 'Shared' : (password ? 'PDF saved (locked)' : 'PDF saved'));
  }

  async function exportJpgs({ share = false } = {}) {
    if (!state.doc) return;
    const name = ($('#export-name').value || 'Scan').trim();
    state.doc.name = name;
    if (state.doc.pages.length === 1) {
      const p = state.doc.pages[0];
      const baseCanvas = p.processed || I.dewarp(p.sourceFullCanvas, p.corners);
      const baked = DS.annotate.bake(p, baseCanvas);
      const blob = await canvasToBlob(baked, 'image/jpeg', 0.9);
      await saveDocToLibrary();
      const fn = safeFilename(name) + '.jpg';
      if (share) await shareBlob(blob, fn, name);
      else downloadBlob(blob, fn);
      toast(share ? 'Shared' : 'Saved');
      return;
    }
    for (let i = 0; i < state.doc.pages.length; i++) {
      const p = state.doc.pages[i];
      const baseCanvas = p.processed || I.dewarp(p.sourceFullCanvas, p.corners);
      const baked = DS.annotate.bake(p, baseCanvas);
      const blob = await canvasToBlob(baked, 'image/jpeg', 0.9);
      downloadBlob(blob, `${safeFilename(name)}-${String(i + 1).padStart(2, '0')}.jpg`);
    }
    await saveDocToLibrary();
    toast('Saved JPGs');
  }

  async function shareDoc() {
    // Default to PDF share for multi-page, JPG share for single.
    if (!state.doc) return;
    if (state.doc.pages.length === 1) await exportJpgs({ share: true });
    else await exportPdf({ share: true });
  }

  async function saveDocToLibrary() {
    if (!state.doc) return;
    state.doc.updatedAt = Date.now();
    state.doc.name = ($('#export-name').value || state.doc.name || 'Scan').trim();
    const pages = [];
    for (const p of state.doc.pages) {
      const procBlob = p.processed
        ? await canvasToBlob(p.processed, 'image/jpeg', 0.86)
        : null;
      pages.push({
        id: p.id,
        sourceBlob: p.sourceBlob,
        processedBlob: procBlob,
        corners: p.corners,
        filter: p.filter,
        annotations: p.annotations || { strokes: [], texts: [] },
      });
    }
    // Thumb from first processed page.
    const first = state.doc.pages[0];
    const firstCanvas = first.processed || first.sourceCanvas;
    const thumb = I.makeCanvas(240, Math.round(240 * firstCanvas.height / firstCanvas.width));
    thumb.getContext('2d').drawImage(firstCanvas, 0, 0, thumb.width, thumb.height);
    const thumbBlob = await canvasToBlob(thumb, 'image/jpeg', 0.75);
    await DB.save({
      id: state.doc.id,
      name: state.doc.name,
      createdAt: state.doc.createdAt,
      updatedAt: state.doc.updatedAt,
      pages,
      thumbBlob,
    });
  }

  // ---------- helpers ----------
  function currentPage() {
    if (!state.doc) return null;
    return state.doc.pages[state.pageIdx] || null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- bindings ----------
  function bind() {
    $('#back-btn').addEventListener('click', back);
    $('#library-btn').addEventListener('click', async () => {
      setView('library');
      $('#library-search').value = '';
      await renderLibraryGrid($('#library-grid-full'), 0, '');
      const items = await DB.count();
      $('#library-count').textContent = `${items} scan${items === 1 ? '' : 's'}`;
    });

    $('#btn-camera').addEventListener('click', () => $('#file-input-camera').click());
    $('#btn-library-pick').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', (e) => addPagesFromFiles(e.target.files));
    $('#file-input-camera').addEventListener('change', (e) => addPagesFromFiles(e.target.files));
    $('#file-input').multiple = true;

    $('#btn-add-page').addEventListener('click', () => $('#file-input-camera').click());
    $('#btn-done').addEventListener('click', openExport);

    $('#act-crop').addEventListener('click', openCrop);
    $('#act-filter').addEventListener('click', openFilter);
    $('#act-annotate').addEventListener('click', () => {
      const p = currentPage();
      if (p) DS.annotate.open(p);
    });
    $('#act-rotate').addEventListener('click', rotateCurrent);
    $('#act-delete').addEventListener('click', deleteCurrent);
    if (DS.annotate && DS.annotate.bind) DS.annotate.bind();

    $('#library-search').addEventListener('input', async (e) => {
      await renderLibraryGrid($('#library-grid-full'), 0, e.target.value);
    });

    $('#btn-auto-detect').addEventListener('click', autoDetectAgain);
    $('#btn-full-page').addEventListener('click', useFullPage);
    $('#btn-apply-crop').addEventListener('click', applyCrop);

    $$('#view-filter .filter-chip').forEach(b => {
      b.addEventListener('click', () => previewFilter(b.dataset.filter));
    });
    $('#btn-apply-filter').addEventListener('click', applyFilterChoice);

    $('#btn-export-pdf').addEventListener('click', () => exportPdf({ share: false }));
    $('#btn-export-jpg').addEventListener('click', () => exportJpgs({ share: false }));
    $('#btn-share').addEventListener('click', shareDoc);
    $('#btn-save-only').addEventListener('click', async () => {
      await saveDocToLibrary();
      toast('Saved to Library');
      state.doc = null;
      await renderHome();
      setView('home');
    });

    bindCropDrag();

    window.addEventListener('resize', () => {
      if (state.view === 'crop' && currentPage()) renderCrop(currentPage());
    });
  }

  async function rotateCurrent() {
    const page = currentPage();
    if (!page) return;
    page.sourceFullCanvas = I.rotate90(page.sourceFullCanvas);
    page.sourceCanvas = I.rotate90(page.sourceCanvas);
    // Rotate corners: (u, v) → (1 - v, u)
    page.corners = page.corners.map(([u, v]) => [1 - v, u]);
    // After rotating 4 points the order may need cycling so that index 0 stays
    // top-left. Rotate90 turns the previous bottom-left into the new top-left,
    // so shift the array.
    page.corners = [page.corners[3], page.corners[0], page.corners[1], page.corners[2]];
    page.processed = await processPage(page);
    renderReview();
    await persist();
  }

  async function deleteCurrent() {
    if (!state.doc) return;
    if (state.doc.pages.length <= 1) {
      if (!confirm('Delete this scan? This removes it from My Scans.')) return;
      try { await DB.remove(state.doc.id); } catch {}
      state.doc = null;
      await renderHome();
      setView('home');
      toast('Deleted');
      return;
    }
    if (!confirm('Delete this page?')) return;
    state.doc.pages.splice(state.pageIdx, 1);
    state.pageIdx = Math.max(0, state.pageIdx - 1);
    renderReview();
    await persist();
  }

  // ---------- build stamp ----------
  let initialStamp = null;
  async function readStamp() {
    try {
      const r = await fetch('/build-stamp.json', { cache: 'no-store' });
      const j = await r.json();
      return j.stamp;
    } catch { return null; }
  }
  async function checkStamp() {
    const s = await readStamp();
    if (s == null) return;
    if (initialStamp == null) {
      initialStamp = s;
      return;
    }
    if (s !== initialStamp && !$('#update-banner')) {
      const b = document.createElement('div');
      b.id = 'update-banner';
      b.textContent = '🔄 New version available — tap to reload';
      b.addEventListener('click', () => location.reload());
      document.body.appendChild(b);
    }
  }

  // ---------- boot ----------
  function boot() {
    bind();
    const pill = $('#version-pill');
    if (pill) pill.textContent = APP_VERSION;
    setView('home');
    renderHome();
    setTimeout(checkStamp, 1500);
    setInterval(checkStamp, 60000);
  }

  DS.app = {
    setView,
    renderReview,
    persist,
    currentView: () => state.view,
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
