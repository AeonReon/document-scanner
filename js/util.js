// Tiny shared helpers. Global namespace `DS`.
window.DS = window.DS || {};

DS.uid = () => 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

DS.$ = (sel, root = document) => root.querySelector(sel);
DS.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

DS.toast = (msg, ms = 1800) => {
  const t = DS.$('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(DS.toast._t);
  DS.toast._t = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 250);
  }, ms);
};

DS.fileToImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
  img.decoding = 'async';
  img.src = url;
});

DS.dataUrlToImage = (dataUrl) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = dataUrl;
});

DS.canvasToBlob = (canvas, type = 'image/jpeg', quality = 0.88) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

DS.blobToArrayBuffer = (blob) => blob.arrayBuffer();

DS.downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
};

DS.shareBlob = async (blob, filename, title = 'Scan') => {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; }
    catch (e) {
      if (e && e.name === 'AbortError') return false;
      console.warn('share failed', e);
    }
  }
  DS.downloadBlob(blob, filename);
  return true;
};

DS.formatDate = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

DS.safeFilename = (name) => {
  return (name || 'scan').replace(/[^\w\s.-]/g, '').replace(/\s+/g, '_').slice(0, 80) || 'scan';
};

// Vibrate softly on important taps where supported.
DS.haptic = (ms = 8) => { if (navigator.vibrate) try { navigator.vibrate(ms); } catch {} };
