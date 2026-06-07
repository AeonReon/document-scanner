// Live camera capture with real-time document-edge overlay and auto-capture.
// Falls back gracefully: app.js only opens this when supported() is true.
window.DS = window.DS || {};

(() => {
  const { $, haptic, toast } = DS;
  const I = DS.imaging;

  const state = {
    stream: null,
    raf: null,
    timer: null,
    running: false,
    auto: true,
    busy: false,          // capture in progress
    lastCorners: null,
    stableTicks: 0,
    cooldownUntil: 0,
    detectCanvas: null,   // small canvas reused for detection
  };

  const TICK_MS = 160;          // detection cadence
  const STABLE_NEEDED = 7;      // consecutive stable detections before auto-snap
  const MOVE_TOL = 0.03;        // max normalised corner movement to count as "still"
  const COOLDOWN_MS = 1400;     // gap between auto-captures
  const DETECT_W = 360;         // detection working width

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
              window.isSecureContext);
  }

  async function open({ append = false } = {}) {
    // If starting a fresh document, drop any in-progress one first.
    if (!append && DS.app.startNewDoc) DS.app.startNewDoc();
    DS.app.setView('camera');
    updateCount();
    setAutoLabel();
    const video = $('#cam-video');
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (e) {
      console.warn('getUserMedia failed', e);
      toast('Camera blocked — using photo picker');
      DS.app.setView('home');
      $('#file-input-camera').click();
      return;
    }
    video.srcObject = state.stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    try { await video.play(); } catch {}
    state.running = true;
    state.lastCorners = null;
    state.stableTicks = 0;
    state.cooldownUntil = 0;
    loop();
  }

  function close() {
    state.running = false;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
    if (state.stream) {
      state.stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      state.stream = null;
    }
    const video = $('#cam-video');
    if (video) { try { video.pause(); } catch {} video.srcObject = null; }
  }

  // Detection + overlay loop. Uses setTimeout (not rAF) to cap CPU.
  function loop() {
    if (!state.running) return;
    try { detectTick(); } catch (e) { console.warn('detect tick', e); }
    state.timer = setTimeout(loop, TICK_MS);
  }

  function detectTick() {
    const video = $('#cam-video');
    if (!video || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const scale = DETECT_W / vw;
    const dw = DETECT_W, dh = Math.max(1, Math.round(vh * scale));
    if (!state.detectCanvas) state.detectCanvas = document.createElement('canvas');
    const dc = state.detectCanvas;
    dc.width = dw; dc.height = dh;
    dc.getContext('2d').drawImage(video, 0, 0, dw, dh);

    const corners = I.autoDetectCorners(dc);
    const full = I.fullImageCorners();
    const found = !corners.every((p, i) =>
      Math.abs(p[0] - full[i][0]) < 1e-6 && Math.abs(p[1] - full[i][1]) < 1e-6);

    drawOverlay(found ? corners : null);

    if (!found) { state.stableTicks = 0; state.lastCorners = null; setHint('Point at a document…'); return; }

    // Stability: small movement vs previous frame.
    if (state.lastCorners) {
      let move = 0;
      for (let i = 0; i < 4; i++) {
        move = Math.max(move,
          Math.abs(corners[i][0] - state.lastCorners[i][0]),
          Math.abs(corners[i][1] - state.lastCorners[i][1]));
      }
      if (move < MOVE_TOL) state.stableTicks++; else state.stableTicks = 0;
    }
    state.lastCorners = corners;

    if (state.auto && !state.busy && Date.now() > state.cooldownUntil) {
      if (state.stableTicks >= STABLE_NEEDED) { capture(corners); return; }
      setHint('Hold steady…');
    } else {
      setHint('Document detected — tap to capture');
    }
  }

  function drawOverlay(corners) {
    const video = $('#cam-video');
    const svg = $('#cam-overlay');
    const poly = $('#cam-quad');
    if (!video || !svg || !poly) return;
    const rect = video.getBoundingClientRect();
    const stage = $('#cam-stage').getBoundingClientRect();
    svg.style.left = (rect.left - stage.left) + 'px';
    svg.style.top = (rect.top - stage.top) + 'px';
    svg.style.width = rect.width + 'px';
    svg.style.height = rect.height + 'px';
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    if (!corners) { poly.setAttribute('points', ''); return; }
    poly.setAttribute('points',
      corners.map(([u, v]) => `${(u * rect.width).toFixed(1)},${(v * rect.height).toFixed(1)}`).join(' '));
  }

  async function capture(corners) {
    if (state.busy) return;
    state.busy = true;
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    state.stableTicks = 0;
    const video = $('#cam-video');
    flash();
    haptic(12);
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      const cap = document.createElement('canvas');
      cap.width = vw; cap.height = vh;
      cap.getContext('2d').drawImage(video, 0, 0, vw, vh);
      const blob = await new Promise(r => cap.toBlob(r, 'image/jpeg', 0.92));
      const file = new File([blob], 'scan.jpg', { type: 'image/jpeg' });
      await DS.app.addPages([file]);
      updateCount();
      setHint('Captured! Next page, or tap Done');
    } catch (e) {
      console.warn('capture failed', e);
      toast('Capture failed');
    } finally {
      state.busy = false;
    }
  }

  function flash() {
    const f = $('#cam-flash');
    if (!f) return;
    f.classList.remove('go');
    // reflow to restart animation
    void f.offsetWidth;
    f.classList.add('go');
  }

  function updateCount() {
    const n = DS.app.pageCount();
    const el = $('#cam-done');
    if (el) el.textContent = n ? `Done (${n})` : 'Done';
    const c = $('#cam-count');
    if (c) c.textContent = n ? `${n} page${n === 1 ? '' : 's'}` : '';
  }

  function setHint(t) { const el = $('#cam-hint'); if (el) el.textContent = t; }
  function setAutoLabel() { const b = $('#cam-auto'); if (b) { b.textContent = 'Auto-capture: ' + (state.auto ? 'On' : 'Off'); b.setAttribute('aria-pressed', state.auto ? 'true' : 'false'); } }

  function bind() {
    const shutter = $('#cam-shutter');
    if (shutter) shutter.addEventListener('click', () => {
      capture(state.lastCorners || I.fullImageCorners());
    });
    const auto = $('#cam-auto');
    if (auto) auto.addEventListener('click', () => { state.auto = !state.auto; setAutoLabel(); });
    const done = $('#cam-done');
    if (done) done.addEventListener('click', () => {
      close();
      if (DS.app.pageCount()) DS.app.openReview();
      else DS.app.setView('home');
    });
    window.addEventListener('resize', () => { if (state.running) drawOverlay(state.lastCorners); });
    // Stop the camera if the page is hidden (tab switch / lock).
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.running) close();
    });
  }

  DS.camera = { supported, open, close, bind };
})();
