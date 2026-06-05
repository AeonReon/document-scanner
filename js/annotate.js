// Annotation overlay: pen strokes + text labels.
// Annotations stored as { strokes: [...], texts: [...] } in normalised coords (0..1).
// Rendered live as SVG, baked into a canvas before export.
window.DS = window.DS || {};

(() => {
  const { $, $$, toast, uid } = DS;

  const COLORS = [
    { id: 'ink',    hex: '#1c1924', label: 'Ink' },
    { id: 'blue',   hex: '#3b82f6', label: 'Blue' },
    { id: 'red',    hex: '#e36363', label: 'Red' },
    { id: 'yellow', hex: 'rgba(255, 220, 80, 0.55)', label: 'Highlight' },
  ];

  const state = {
    page: null,
    tool: 'pen',
    color: 'ink',
    activeStroke: null,
    pointerId: null,
    dims: { w: 0, h: 0 },
  };

  function ensureAnnotations(page) {
    if (!page.annotations) page.annotations = { strokes: [], texts: [] };
    return page.annotations;
  }

  function colorFor(id) {
    return (COLORS.find(c => c.id === id) || COLORS[0]).hex;
  }
  // Stroke widths stored as a fraction of the page height (0..1) so they
  // scale identically at preview and at full-res bake time.
  function widthForColor(id) {
    return id === 'yellow' ? 0.025 : 0.005;
  }

  function open(page) {
    state.page = page;
    ensureAnnotations(page);
    DS.app.setView('annotate');
    requestAnimationFrame(() => render());
  }

  function render() {
    const page = state.page;
    if (!page) return;
    const stage = $('#annotate-stage');
    const canvas = $('#annotate-canvas');
    const overlay = $('#annotate-overlay');

    const stageRect = stage.getBoundingClientRect();
    const padding = 12;
    const availW = stageRect.width - padding * 2;
    const availH = Math.min(window.innerHeight * 0.55, stageRect.height - padding * 2);
    const src = page.processed || page.sourceCanvas;
    const arSrc = src.width / src.height;
    let dw = availW, dh = availW / arSrc;
    if (dh > availH) { dh = availH; dw = availH * arSrc; }
    canvas.width = Math.round(dw); canvas.height = Math.round(dh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, dw, dh);

    const cRect = canvas.getBoundingClientRect();
    const sRect = stage.getBoundingClientRect();
    overlay.style.left = (cRect.left - sRect.left) + 'px';
    overlay.style.top  = (cRect.top  - sRect.top)  + 'px';
    overlay.style.width  = dw + 'px';
    overlay.style.height = dh + 'px';
    overlay.setAttribute('viewBox', `0 0 ${dw} ${dh}`);
    state.dims = { w: dw, h: dh };

    redrawOverlay();
    updateToolbar();
  }

  function redrawOverlay() {
    const overlay = $('#annotate-overlay');
    overlay.innerHTML = '';
    const ann = ensureAnnotations(state.page);
    const { w, h } = state.dims;

    for (const s of ann.strokes) {
      const pts = s.points.map(([u, v]) => `${(u * w).toFixed(1)},${(v * h).toFixed(1)}`).join(' ');
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      el.setAttribute('points', pts);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', colorFor(s.color));
      el.setAttribute('stroke-width', s.width * h);
      el.setAttribute('stroke-linecap', 'round');
      el.setAttribute('stroke-linejoin', 'round');
      el.dataset.kind = 'stroke';
      el.dataset.id = s.id;
      overlay.appendChild(el);
    }
    for (const t of ann.texts) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.setAttribute('x', (t.x * w).toFixed(1));
      el.setAttribute('y', (t.y * h).toFixed(1));
      el.setAttribute('fill', colorFor(t.color));
      el.setAttribute('font-size', t.size * h);
      el.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      el.setAttribute('font-weight', '600');
      el.textContent = t.text;
      el.dataset.kind = 'text';
      el.dataset.id = t.id;
      overlay.appendChild(el);
    }
  }

  function updateToolbar() {
    $$('#annotate-tools .tool').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.tool === state.tool ? 'true' : 'false');
    });
    $$('#annotate-colors .swatch-btn').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.color === state.color ? 'true' : 'false');
    });
  }

  function pointerPos(e) {
    const rect = $('#annotate-overlay').getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height)),
    ];
  }

  function handlePointerDown(e) {
    if (!state.page) return;
    const target = e.target;
    if (state.tool === 'erase') {
      if (target.dataset.kind === 'stroke') {
        const ann = ensureAnnotations(state.page);
        ann.strokes = ann.strokes.filter(s => s.id !== target.dataset.id);
        redrawOverlay();
      } else if (target.dataset.kind === 'text') {
        const ann = ensureAnnotations(state.page);
        ann.texts = ann.texts.filter(t => t.id !== target.dataset.id);
        redrawOverlay();
      }
      return;
    }
    if (state.tool === 'text') {
      const [u, v] = pointerPos(e);
      const txt = prompt('Text:');
      if (txt && txt.trim()) {
        ensureAnnotations(state.page).texts.push({
          id: uid(),
          x: u, y: v,
          text: txt.trim(),
          color: state.color,
          size: 0.03,
        });
        redrawOverlay();
      }
      return;
    }
    if (state.tool === 'pen') {
      const [u, v] = pointerPos(e);
      state.activeStroke = {
        id: uid(),
        color: state.color,
        width: widthForColor(state.color),
        points: [[u, v]],
      };
      state.pointerId = e.pointerId;
      $('#annotate-overlay').setPointerCapture(e.pointerId);
      ensureAnnotations(state.page).strokes.push(state.activeStroke);
      redrawOverlay();
      e.preventDefault();
    }
  }

  function handlePointerMove(e) {
    if (state.tool !== 'pen' || !state.activeStroke || state.pointerId !== e.pointerId) return;
    const [u, v] = pointerPos(e);
    state.activeStroke.points.push([u, v]);
    // Light decimation: skip if too close to previous.
    const pts = state.activeStroke.points;
    if (pts.length > 2) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const dx = (a[0] - b[0]) * state.dims.w, dy = (a[1] - b[1]) * state.dims.h;
      if (dx * dx + dy * dy < 1.5) pts.pop();
    }
    redrawOverlay();
  }

  function handlePointerUp(e) {
    if (state.pointerId === e.pointerId) {
      try { $('#annotate-overlay').releasePointerCapture(e.pointerId); } catch {}
      state.pointerId = null;
      state.activeStroke = null;
    }
  }

  function selectTool(tool) {
    state.tool = tool;
    updateToolbar();
  }
  function selectColor(color) {
    state.color = color;
    updateToolbar();
  }

  function clearAll() {
    if (!state.page) return;
    if (!confirm('Clear all annotations on this page?')) return;
    state.page.annotations = { strokes: [], texts: [] };
    redrawOverlay();
  }

  function done() {
    DS.app.setView('review');
    DS.app.renderReview();
    if (DS.app.persist) DS.app.persist();
  }

  // Bake annotations onto a canvas (used at export time).
  function bake(page, canvas) {
    const ann = page.annotations;
    if (!ann || (!ann.strokes.length && !ann.texts.length)) return canvas;
    const W = canvas.width, H = canvas.height;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    for (const s of ann.strokes) {
      ctx.strokeStyle = colorFor(s.color);
      ctx.lineWidth = s.width * H;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i++) {
        const x = s.points[i][0] * W;
        const y = s.points[i][1] * H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (const t of ann.texts) {
      ctx.fillStyle = colorFor(t.color);
      const fontSize = Math.round(t.size * H);
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(t.text, t.x * W, t.y * H);
    }
    return out;
  }

  function bind() {
    const overlay = $('#annotate-overlay');
    overlay.addEventListener('pointerdown', handlePointerDown);
    overlay.addEventListener('pointermove', handlePointerMove);
    overlay.addEventListener('pointerup', handlePointerUp);
    overlay.addEventListener('pointercancel', handlePointerUp);

    $$('#annotate-tools .tool').forEach(b => {
      b.addEventListener('click', () => selectTool(b.dataset.tool));
    });
    $$('#annotate-colors .swatch-btn').forEach(b => {
      b.addEventListener('click', () => selectColor(b.dataset.color));
    });
    $('#btn-annotate-clear').addEventListener('click', clearAll);
    $('#btn-annotate-done').addEventListener('click', done);

    window.addEventListener('resize', () => {
      if (DS.app.currentView() === 'annotate' && state.page) render();
    });
  }

  DS.annotate = {
    bind, open, bake, COLORS,
  };
})();
