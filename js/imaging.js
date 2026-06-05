// All canvas / pixel work lives here. No external libs.
window.DS = window.DS || {};

(() => {
  // ---------- helpers ----------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function imgToCanvas(img, maxSide) {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (maxSide && Math.max(w, h) > maxSide) {
      const s = maxSide / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
  }

  function canvasToImageData(c) {
    return c.getContext('2d').getImageData(0, 0, c.width, c.height);
  }

  function imageDataToCanvas(id) {
    const c = makeCanvas(id.width, id.height);
    c.getContext('2d').putImageData(id, 0, 0);
    return c;
  }

  // ---------- corner detection ----------
  // Returns 4 corners in clockwise order from top-left, in *normalised*
  // coordinates (0..1) relative to the source image dimensions.
  function autoDetectCorners(img) {
    const MAX = 480;
    const src = imgToCanvas(img, MAX);
    const W = src.width, H = src.height;
    const id = canvasToImageData(src);
    const px = id.data;
    const N = W * H;

    // Grayscale + light box blur into Uint8
    const grey = new Uint8ClampedArray(N);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      grey[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    }
    const blur = boxBlur(grey, W, H, 1);

    // Sobel magnitude
    const mag = new Float32Array(N);
    let magMax = 0;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx =
          -blur[i - W - 1] - 2 * blur[i - 1] - blur[i + W - 1] +
           blur[i - W + 1] + 2 * blur[i + 1] + blur[i + W + 1];
        const gy =
          -blur[i - W - 1] - 2 * blur[i - W] - blur[i - W + 1] +
           blur[i + W - 1] + 2 * blur[i + W] + blur[i + W + 1];
        const m = Math.sqrt(gx * gx + gy * gy);
        mag[i] = m;
        if (m > magMax) magMax = m;
      }
    }
    if (magMax < 1e-3) {
      return fullImageCorners();
    }
    // Adaptive threshold: keep roughly the strongest ~12% of gradient pixels.
    // A percentile is far more robust than a fixed fraction of the single max
    // value — one bright highlight or specular glint can blow out `magMax` and
    // make a fixed fraction reject every real document edge. We keep a small
    // floor so a noisy, low-contrast frame can't promote noise to "edges".
    const BINS = 256;
    const hist = new Uint32Array(BINS);
    const invStep = (BINS - 1) / magMax;
    for (let i = 0; i < N; i++) hist[(mag[i] * invStep) | 0]++;
    let want = Math.round(N * 0.12), acc = 0, thrBin = BINS - 1;
    for (let b = BINS - 1; b >= 0; b--) { acc += hist[b]; if (acc >= want) { thrBin = b; break; } }
    const thr = Math.max(magMax * 0.10, thrBin / invStep);
    const edge = new Uint8Array(N);
    for (let i = 0; i < N; i++) edge[i] = mag[i] > thr ? 1 : 0;

    // For each side, walk inward and collect first-strong-edge points,
    // then least-squares-fit a line.
    const margin = Math.round(Math.min(W, H) * 0.02);
    const topPts = [], botPts = [], leftPts = [], rightPts = [];

    // Top: for each column, walk down from top edge, find first edge after margin.
    for (let x = margin; x < W - margin; x++) {
      for (let y = margin; y < H * 0.45; y++) {
        if (edge[y * W + x]) { topPts.push([x, y]); break; }
      }
    }
    // Bottom: walk up from bottom.
    for (let x = margin; x < W - margin; x++) {
      for (let y = H - 1 - margin; y > H * 0.55; y--) {
        if (edge[y * W + x]) { botPts.push([x, y]); break; }
      }
    }
    // Left: walk right from left.
    for (let y = margin; y < H - margin; y++) {
      for (let x = margin; x < W * 0.45; x++) {
        if (edge[y * W + x]) { leftPts.push([x, y]); break; }
      }
    }
    // Right: walk left from right.
    for (let y = margin; y < H - margin; y++) {
      for (let x = W - 1 - margin; x > W * 0.55; x--) {
        if (edge[y * W + x]) { rightPts.push([x, y]); break; }
      }
    }

    const minPts = 20;
    if (topPts.length < minPts || botPts.length < minPts ||
        leftPts.length < minPts || rightPts.length < minPts) {
      return fullImageCorners();
    }

    // Fit lines. Top/bot are roughly horizontal (y = m*x + b), so least squares on y vs x.
    // Left/right are roughly vertical (x = m*y + b), so least squares on x vs y.
    const top   = fitLine(topPts,   false);  // y = a*x + b
    const bot   = fitLine(botPts,   false);
    const left  = fitLine(leftPts,  true);   // x = a*y + b
    const right = fitLine(rightPts, true);

    // Intersect top↔left, top↔right, bot↔right, bot↔left.
    const tl = intersect(top, left, false, true);
    const tr = intersect(top, right, false, true);
    const br = intersect(bot, right, false, true);
    const bl = intersect(bot, left, false, true);

    const pts = [tl, tr, br, bl];
    // Sanity: all corners inside (or near) the image, and area reasonable.
    const slack = 0.10;
    for (const p of pts) {
      if (!p ||
          p[0] < -W * slack || p[0] > W * (1 + slack) ||
          p[1] < -H * slack || p[1] > H * (1 + slack)) {
        return fullImageCorners();
      }
    }
    const area = polyArea(pts);
    if (area < W * H * 0.15) return fullImageCorners();

    // Clamp into image bounds.
    for (const p of pts) {
      p[0] = Math.max(0, Math.min(W, p[0]));
      p[1] = Math.max(0, Math.min(H, p[1]));
    }
    return pts.map(([x, y]) => [x / W, y / H]);
  }

  function fullImageCorners() {
    return [[0.02, 0.02], [0.98, 0.02], [0.98, 0.98], [0.02, 0.98]];
  }

  function boxBlur(src, W, H, r) {
    const out = new Uint8ClampedArray(src.length);
    const k = 2 * r + 1;
    // horizontal
    const tmp = new Uint8ClampedArray(src.length);
    for (let y = 0; y < H; y++) {
      let sum = 0;
      const row = y * W;
      for (let x = -r; x <= r; x++) sum += src[row + Math.max(0, Math.min(W - 1, x))];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = (sum / k) | 0;
        const add = src[row + Math.min(W - 1, x + r + 1)];
        const sub = src[row + Math.max(0, x - r)];
        sum += add - sub;
      }
    }
    // vertical
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(H - 1, y)) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = (sum / k) | 0;
        const add = tmp[Math.min(H - 1, y + r + 1) * W + x];
        const sub = tmp[Math.max(0, y - r) * W + x];
        sum += add - sub;
      }
    }
    return out;
  }

  function fitLine(pts, swap) {
    // Robust fit: trim outliers iteratively.
    let xs = pts.map(p => swap ? p[1] : p[0]);
    let ys = pts.map(p => swap ? p[0] : p[1]);
    for (let iter = 0; iter < 2; iter++) {
      const { a, b } = lstsq(xs, ys);
      const residuals = xs.map((x, i) => Math.abs(ys[i] - (a * x + b)));
      const sorted = [...residuals].sort((p, q) => p - q);
      const cutoff = sorted[Math.floor(sorted.length * 0.85)] || 0;
      const kept = [];
      for (let i = 0; i < xs.length; i++) if (residuals[i] <= cutoff + 0.5) kept.push(i);
      if (kept.length < 10) break;
      xs = kept.map(i => xs[i]);
      ys = kept.map(i => ys[i]);
    }
    const { a, b } = lstsq(xs, ys);
    return { a, b, swap };
  }

  function lstsq(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-9) return { a: 0, b: sy / n };
    const a = (n * sxy - sx * sy) / denom;
    const b = (sy - a * sx) / n;
    return { a, b };
  }

  // Lines stored as either y = a*x + b (swap=false) or x = a*y + b (swap=true).
  // Returns [x, y].
  function intersect(L1, L2) {
    // Convert to canonical form: A*x + B*y = C
    function canon(L) {
      if (!L.swap) return { A: -L.a, B: 1, C: L.b };
      else         return { A: 1, B: -L.a, C: L.b };
    }
    const a = canon(L1), b = canon(L2);
    const det = a.A * b.B - b.A * a.B;
    if (Math.abs(det) < 1e-6) return null;
    const x = (a.C * b.B - b.C * a.B) / det;
    const y = (a.A * b.C - b.A * a.C) / det;
    return [x, y];
  }

  function polyArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s) / 2;
  }

  // ---------- perspective dewarp ----------
  // corners: 4 [u,v] in normalised src coords (TL, TR, BR, BL).
  // Returns a canvas at the dewarped size.
  function dewarp(srcImgOrCanvas, normCorners, outMax = 2000) {
    const srcCanvas = (srcImgOrCanvas instanceof HTMLCanvasElement)
      ? srcImgOrCanvas
      : imgToCanvas(srcImgOrCanvas);
    const SW = srcCanvas.width, SH = srcCanvas.height;

    const src = normCorners.map(([u, v]) => [u * SW, v * SH]);
    // Determine output size from the average of opposite sides.
    const wTop = dist(src[0], src[1]);
    const wBot = dist(src[3], src[2]);
    const hLeft = dist(src[0], src[3]);
    const hRight = dist(src[1], src[2]);
    let OW = Math.round((wTop + wBot) / 2);
    let OH = Math.round((hLeft + hRight) / 2);
    if (OW < 32 || OH < 32) return srcCanvas;

    const scale = Math.min(1, outMax / Math.max(OW, OH));
    OW = Math.max(64, Math.round(OW * scale));
    OH = Math.max(64, Math.round(OH * scale));

    // Solve H mapping dst → src (so we can do backward mapping).
    const dst = [[0, 0], [OW, 0], [OW, OH], [0, OH]];
    const H = perspectiveMatrix(dst, src);  // dst → src
    if (!H) return srcCanvas;

    const srcId = srcCanvas.getContext('2d').getImageData(0, 0, SW, SH);
    const srcPx = srcId.data;
    const outId = new ImageData(OW, OH);
    const outPx = outId.data;

    for (let y = 0; y < OH; y++) {
      for (let x = 0; x < OW; x++) {
        const w = H[6] * x + H[7] * y + H[8];
        const sx = (H[0] * x + H[1] * y + H[2]) / w;
        const sy = (H[3] * x + H[4] * y + H[5]) / w;
        const i = (y * OW + x) * 4;
        if (sx < 0 || sy < 0 || sx >= SW - 1 || sy >= SH - 1) {
          outPx[i] = 255; outPx[i + 1] = 255; outPx[i + 2] = 255; outPx[i + 3] = 255;
          continue;
        }
        const x0 = sx | 0, y0 = sy | 0;
        const fx = sx - x0, fy = sy - y0;
        const j00 = (y0 * SW + x0) * 4;
        const j10 = j00 + 4;
        const j01 = j00 + SW * 4;
        const j11 = j01 + 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        outPx[i]     = srcPx[j00]     * w00 + srcPx[j10]     * w10 + srcPx[j01]     * w01 + srcPx[j11]     * w11;
        outPx[i + 1] = srcPx[j00 + 1] * w00 + srcPx[j10 + 1] * w10 + srcPx[j01 + 1] * w01 + srcPx[j11 + 1] * w11;
        outPx[i + 2] = srcPx[j00 + 2] * w00 + srcPx[j10 + 2] * w10 + srcPx[j01 + 2] * w01 + srcPx[j11 + 2] * w11;
        outPx[i + 3] = 255;
      }
    }
    return imageDataToCanvas(outId);
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  // Solve perspective matrix mapping src (4 pts) → dst (4 pts).
  // Returns 9 numbers [h0..h8] (h8=1) or null.
  function perspectiveMatrix(src, dst) {
    // 8 equations, 8 unknowns.
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = solve8(A, b);
    if (!h) return null;
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function solve8(A, b) {
    const n = 8;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-9) return null;
      [M[col], M[piv]] = [M[piv], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n);
    for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
    return x;
  }

  // ---------- filters ----------
  // All filters take an HTMLCanvasElement and return a new canvas.
  function applyFilter(canvas, kind) {
    // 'auto' is the default "looks like a scan" look: shadow/illumination
    // removal + auto white balance + contrast. 'enhance' is kept as an alias so
    // documents saved before this change still resolve to the magic look.
    if (kind === 'auto' || kind === 'enhance' || !kind) return magicColor(canvas);
    if (kind === 'colour' || kind === 'original') return autoLevels(canvas, false);
    // Greyscale / B&W look cleanest when fed the illumination-normalised image,
    // so they build on the same magic-colour base rather than the raw photo.
    if (kind === 'grey') return greyscale(magicColor(canvas));
    if (kind === 'bw') return blackWhite(magicColor(canvas));
    return canvas;
  }

  // ---------- magic colour (shadow / illumination removal) ----------
  // This is the step that makes a phone photo read as a *scan* instead of a
  // snapshot. Real scanner apps (CamScanner "Magic Color", Adobe Scan, Scanner
  // Pro) all do a version of this: estimate the page's background illumination
  // and divide it out, so uneven lighting and shadows flatten to clean white
  // paper while ink stays dark. Doing it per-channel also neutralises colour
  // casts — automatic white balance — for free. A gentle contrast lift around
  // the paper level finishes the "crisp document" look.
  function magicColor(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, W, H);
    const d = id.data;

    // 1. Estimate the background (the paper) at low resolution — fast, and the
    //    downscale + heavy blur naturally smooths sparse dark text into the
    //    surrounding paper level, so the estimate tracks the lighting not the ink.
    const BGMAX = 220;
    const s = Math.min(1, BGMAX / Math.max(W, H));
    const bw = Math.max(1, Math.round(W * s));
    const bh = Math.max(1, Math.round(H * s));
    const small = makeCanvas(bw, bh);
    small.getContext('2d').drawImage(canvas, 0, 0, bw, bh);
    const sd = small.getContext('2d').getImageData(0, 0, bw, bh).data;
    const rC = new Uint8ClampedArray(bw * bh);
    const gC = new Uint8ClampedArray(bw * bh);
    const bC = new Uint8ClampedArray(bw * bh);
    for (let i = 0, j = 0; i < sd.length; i += 4, j++) { rC[j] = sd[i]; gC[j] = sd[i + 1]; bC[j] = sd[i + 2]; }
    const rad = Math.max(2, Math.round(Math.min(bw, bh) / 5));
    // Two box-blur passes approximate a Gaussian background.
    const rB = boxBlur(boxBlur(rC, bw, bh, rad), bw, bh, rad);
    const gB = boxBlur(boxBlur(gC, bw, bh, rad), bw, bh, rad);
    const bB = boxBlur(boxBlur(bC, bw, bh, rad), bw, bh, rad);

    // 2. Divide each full-res pixel by the bilinearly-sampled background, then
    //    lift contrast around the paper pivot so paper goes clean-white and ink
    //    deepens toward black.
    const sx = (bw - 1) / Math.max(1, W - 1);
    const sy = (bh - 1) / Math.max(1, H - 1);
    const CONTRAST = 1.18, PIVOT = 232;
    for (let y = 0; y < H; y++) {
      const fy = y * sy, y0 = fy | 0, y1 = Math.min(bh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = x * sx, x0 = fx | 0, x1 = Math.min(bw - 1, x0 + 1), wx = fx - x0;
        const p00 = y0 * bw + x0, p01 = y0 * bw + x1, p10 = y1 * bw + x0, p11 = y1 * bw + x1;
        const bgR = bilerp(rB, p00, p01, p10, p11, wx, wy);
        const bgG = bilerp(gB, p00, p01, p10, p11, wx, wy);
        const bgB = bilerp(bB, p00, p01, p10, p11, wx, wy);
        const i = (y * W + x) * 4;
        let r = d[i]     * 255 / Math.max(8, bgR);
        let g = d[i + 1] * 255 / Math.max(8, bgG);
        let b = d[i + 2] * 255 / Math.max(8, bgB);
        r = (r - PIVOT) * CONTRAST + PIVOT;
        g = (g - PIVOT) * CONTRAST + PIVOT;
        b = (b - PIVOT) * CONTRAST + PIVOT;
        d[i] = clamp(r); d[i + 1] = clamp(g); d[i + 2] = clamp(b);
      }
    }
    const out = makeCanvas(W, H);
    out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  function bilerp(arr, p00, p01, p10, p11, wx, wy) {
    const top = arr[p00] * (1 - wx) + arr[p01] * wx;
    const bot = arr[p10] * (1 - wx) + arr[p11] * wx;
    return top * (1 - wy) + bot * wy;
  }

  function autoLevels(canvas, strong) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    const N = canvas.width * canvas.height;
    // Per-channel auto-levels: stretch to [p_lo .. p_hi] percentile.
    const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) { histR[d[i]]++; histG[d[i + 1]]++; histB[d[i + 2]]++; }
    const lo = strong ? 0.005 : 0.002, hi = strong ? 0.995 : 0.998;
    function lim(h) {
      let target = N * lo, acc = 0, low = 0;
      for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= target) { low = v; break; } }
      target = N * hi; acc = 0; let high = 255;
      for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= target) { high = v; break; } }
      if (high - low < 8) { low = 0; high = 255; }
      return [low, high];
    }
    const [rLo, rHi] = lim(histR), [gLo, gHi] = lim(histG), [bLo, bHi] = lim(histB);
    const rScale = 255 / (rHi - rLo);
    const gScale = 255 / (gHi - gLo);
    const bScale = 255 / (bHi - bLo);
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = clamp((d[i]     - rLo) * rScale);
      d[i + 1] = clamp((d[i + 1] - gLo) * gScale);
      d[i + 2] = clamp((d[i + 2] - bLo) * bScale);
    }
    const out = makeCanvas(canvas.width, canvas.height);
    out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  function greyscale(canvas) {
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    // Histogram stretch on luminance.
    const hist = new Uint32Array(256);
    const Y = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      Y[j] = y;
      hist[y]++;
    }
    const N = Y.length;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= N * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= N * 0.01) { hi = v; break; } }
    const scale = 255 / Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const v = clamp((Y[j] - lo) * scale);
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
    const out = makeCanvas(canvas.width, canvas.height);
    out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  function blackWhite(canvas) {
    // Adaptive (Bradley) threshold over an integral image. Fast and clean.
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    const id = ctx.getImageData(0, 0, W, H);
    const d = id.data;
    const grey = new Uint8ClampedArray(W * H);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      grey[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    // Integral image (Uint32 is enough for typical scan sizes).
    const ii = new Uint32Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rowSum = 0;
      for (let x = 0; x < W; x++) {
        rowSum += grey[y * W + x];
        ii[(y + 1) * (W + 1) + (x + 1)] = ii[y * (W + 1) + (x + 1)] + rowSum;
      }
    }
    const half = Math.max(8, Math.round(Math.min(W, H) / 64));
    const tFrac = 0.85;
    for (let y = 0; y < H; y++) {
      const y0 = Math.max(0, y - half), y1 = Math.min(H - 1, y + half);
      for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - half), x1 = Math.min(W - 1, x + half);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          ii[(y1 + 1) * (W + 1) + (x1 + 1)]
          - ii[y0     * (W + 1) + (x1 + 1)]
          - ii[(y1 + 1) * (W + 1) + x0]
          + ii[y0     * (W + 1) + x0];
        const mean = sum / area;
        const px = grey[y * W + x];
        const v = (px * 100 < mean * tFrac * 100) ? 0 : 255;
        const i = (y * W + x) * 4;
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
    }
    const out = makeCanvas(W, H);
    out.getContext('2d').putImageData(id, 0, 0);
    return out;
  }

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  // ---------- rotate ----------
  function rotate90(canvas) {
    const W = canvas.width, H = canvas.height;
    const out = makeCanvas(H, W);
    const ctx = out.getContext('2d');
    ctx.translate(H, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(canvas, 0, 0);
    return out;
  }

  // ---------- public ----------
  DS.imaging = {
    makeCanvas,
    imgToCanvas,
    autoDetectCorners,
    fullImageCorners,
    dewarp,
    applyFilter,
    rotate90,
  };
})();
