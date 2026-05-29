// Minimal multi-page image PDF builder with optional password (RC4-128).
// No dependencies. All algorithms straight from the PDF 1.7 spec.
window.DS = window.DS || {};

(() => {
  const PAPER = {
    a4:      { w: 595, h: 842 },
    a5:      { w: 420, h: 595 },
    letter:  { w: 612, h: 792 },
    legal:   { w: 612, h: 1008 },
    receipt: { w: 227, h: 800 },
    id:      { w: 242, h: 153 },
  };

  // pages: [{ jpeg: Uint8Array, widthPx, heightPx }]
  // opts: { paper, title, password }
  async function buildPdf(pages, opts = {}) {
    if (!pages || !pages.length) throw new Error('No pages');
    const { paper = 'fit', title = 'Scan', password = '' } = opts;
    const encrypted = !!password;

    // Build object list. Layout:
    //   1: Catalog
    //   2: Pages root
    //   3..N: per-page (image, content, page)
    //   N+1: Info
    //   N+2 (if encrypted): Encrypt
    const objs = [];
    objs.push(null); // 1
    objs.push(null); // 2

    const pageObjNums = [];
    for (const p of pages) {
      const dims = computePageDims(p, paper);
      const imgNum = objs.length + 1;
      objs.push({
        type: 'image',
        widthPx: p.widthPx,
        heightPx: p.heightPx,
        jpeg: p.jpeg,
      });
      const contentNum = objs.length + 1;
      const drawW = dims.imgW.toFixed(4);
      const drawH = dims.imgH.toFixed(4);
      const drawX = dims.imgX.toFixed(4);
      const drawY = dims.imgY.toFixed(4);
      const stream = `q\n${drawW} 0 0 ${drawH} ${drawX} ${drawY} cm\n/Im0 Do\nQ\n`;
      objs.push({ type: 'content', stream });
      const pageNum = objs.length + 1;
      objs.push({
        type: 'page',
        mediaW: dims.pageW,
        mediaH: dims.pageH,
        imgNum,
        contentNum,
      });
      pageObjNums.push(pageNum);
    }
    const infoNum = objs.length + 1;
    objs.push({ type: 'info', title });

    let encryptNum = 0;
    let security = null;
    if (encrypted) {
      security = setupSecurity(password);
      encryptNum = objs.length + 1;
      objs.push({ type: 'encrypt', security });
    }

    objs[0] = { type: 'catalog' };
    objs[1] = { type: 'pagesRoot', kids: pageObjNums };

    // Serialise.
    const parts = [];
    let offset = 0;
    const xref = [];
    function push(bytes) {
      if (typeof bytes === 'string') bytes = encodeLatin1(bytes);
      parts.push(bytes);
      offset += bytes.length;
    }

    push('%PDF-1.4\n%\xff\xff\xff\xff\n');

    for (let i = 0; i < objs.length; i++) {
      xref.push(offset);
      const o = objs[i];
      const num = i + 1;
      push(`${num} 0 obj\n`);
      if (o.type === 'catalog') {
        push(`<< /Type /Catalog /Pages 2 0 R >>\n`);
      } else if (o.type === 'pagesRoot') {
        push(`<< /Type /Pages /Kids [${o.kids.map(k => `${k} 0 R`).join(' ')}] /Count ${o.kids.length} >>\n`);
      } else if (o.type === 'info') {
        push(`<< /Title ${pdfStr(o.title, num, security)} /Producer ${pdfStr('Private Document Scanner', num, security)} /Creator ${pdfStr('Private Document Scanner', num, security)} >>\n`);
      } else if (o.type === 'page') {
        push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${o.mediaW.toFixed(4)} ${o.mediaH.toFixed(4)}] ` +
             `/Resources << /XObject << /Im0 ${o.imgNum} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> ` +
             `/Contents ${o.contentNum} 0 R >>\n`);
      } else if (o.type === 'content') {
        const raw = encodeLatin1(o.stream);
        const data = security ? rc4(perObjectKey(security.key, num, 0), raw) : raw;
        push(`<< /Length ${data.length} >>\nstream\n`);
        push(data);
        push('\nendstream\n');
      } else if (o.type === 'image') {
        const data = security ? rc4(perObjectKey(security.key, num, 0), o.jpeg) : o.jpeg;
        push(`<< /Type /XObject /Subtype /Image /Width ${o.widthPx} /Height ${o.heightPx} ` +
             `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\n`);
        push('stream\n');
        push(data);
        push('\nendstream\n');
      } else if (o.type === 'encrypt') {
        const s = o.security;
        push(`<< /Filter /Standard /V 2 /R 3 /Length 128 ` +
             `/P ${s.P} ` +
             `/O <${bytesToHex(s.O)}> ` +
             `/U <${bytesToHex(s.U)}> >>\n`);
      }
      push('endobj\n');
    }

    const xrefOffset = offset;
    push(`xref\n0 ${objs.length + 1}\n`);
    push('0000000000 65535 f \n');
    for (const xo of xref) {
      push(`${String(xo).padStart(10, '0')} 00000 n \n`);
    }
    const idHex = security ? bytesToHex(security.fileId) : randomHex(16);
    let trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNum} 0 R `;
    if (encrypted) trailer += `/Encrypt ${encryptNum} 0 R `;
    trailer += `/ID [<${idHex}> <${idHex}>] >>\n`;
    push(trailer);
    push(`startxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(parts, { type: 'application/pdf' });
  }

  function computePageDims(page, paper) {
    if (paper === 'fit' || !PAPER[paper]) {
      const pageW = page.widthPx * 72 / 200;
      const pageH = page.heightPx * 72 / 200;
      return { pageW, pageH, imgW: pageW, imgH: pageH, imgX: 0, imgY: 0 };
    }
    const { w: pageW, h: pageH } = PAPER[paper];
    const pageAr = pageW / pageH;
    const imgAr = page.widthPx / page.heightPx;
    let imgW, imgH;
    if (imgAr > pageAr) { imgW = pageW; imgH = pageW / imgAr; }
    else { imgH = pageH; imgW = pageH * imgAr; }
    const imgX = (pageW - imgW) / 2;
    const imgY = (pageH - imgH) / 2;
    return { pageW, pageH, imgW, imgH, imgX, imgY };
  }

  function encodeLatin1(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  function pdfStr(s, objNum, security) {
    // If encrypted, write hex string of encrypted bytes; otherwise PDF literal.
    if (security && objNum) {
      const raw = encodeLatin1(asciiSafe(s));
      const enc = rc4(perObjectKey(security.key, objNum, 0), raw);
      return `<${bytesToHex(enc)}>`;
    }
    const safe = asciiSafe(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    return `(${safe})`;
  }

  function asciiSafe(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += (c >= 32 && c < 127) ? s[i] : '?';
    }
    return out;
  }

  function bytesToHex(b) {
    let h = '';
    for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
    return h;
  }

  function randomHex(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return bytesToHex(a);
  }

  // ---------- Standard Security Handler (R=3, RC4-128) ----------
  const PWPAD = new Uint8Array([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41,
    0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
    0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
  ]);

  function padPassword(pw) {
    const enc = new TextEncoder().encode(pw || '');
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++) out[i] = i < enc.length ? enc[i] : PWPAD[i - enc.length];
    return out;
  }

  function setupSecurity(password) {
    // P = -3904 → all rights granted; bits 7-8 reserved set per R>=3.
    // Simpler: all-1s low bits = -4. We'll use -4 (all rights).
    const P = -4;
    const fileId = new Uint8Array(16);
    crypto.getRandomValues(fileId);

    // Algorithm 3 — owner password = user password (we set them equal).
    const O = computeOValue(password, password);
    // Algorithm 2 — encryption key.
    const key = computeEncryptionKey(password, O, P, fileId);
    // Algorithm 5 — U entry.
    const U = computeUValue(key, fileId);

    return { P, O, U, key, fileId };
  }

  function computeOValue(ownerPw, userPw) {
    let k = md5(padPassword(ownerPw));
    for (let i = 0; i < 50; i++) k = md5(k);
    k = k.slice(0, 16);
    let val = padPassword(userPw);
    val = rc4(k, val);
    for (let i = 1; i <= 19; i++) {
      const k2 = new Uint8Array(16);
      for (let j = 0; j < 16; j++) k2[j] = k[j] ^ i;
      val = rc4(k2, val);
    }
    return val;
  }

  function computeEncryptionKey(userPw, oVal, P, fileId) {
    const input = new Uint8Array(32 + 32 + 4 + fileId.length);
    input.set(padPassword(userPw), 0);
    input.set(oVal, 32);
    input[64] = P & 0xFF;
    input[65] = (P >>> 8) & 0xFF;
    input[66] = (P >>> 16) & 0xFF;
    input[67] = (P >>> 24) & 0xFF;
    input.set(fileId, 68);
    let h = md5(input).slice(0, 16);
    for (let i = 0; i < 50; i++) h = md5(h.slice(0, 16));
    return h.slice(0, 16);
  }

  function computeUValue(key, fileId) {
    const input = new Uint8Array(32 + fileId.length);
    input.set(PWPAD, 0);
    input.set(fileId, 32);
    const h = md5(input);
    let out = rc4(key, h);
    for (let i = 1; i <= 19; i++) {
      const k = new Uint8Array(16);
      for (let j = 0; j < 16; j++) k[j] = key[j] ^ i;
      out = rc4(k, out);
    }
    const out32 = new Uint8Array(32);
    out32.set(out.slice(0, 16), 0);
    // Bytes 16-31 are arbitrary padding per spec.
    crypto.getRandomValues(out32.subarray(16, 32));
    return out32;
  }

  function perObjectKey(masterKey, objNum, gen) {
    const k = new Uint8Array(masterKey.length + 5);
    k.set(masterKey, 0);
    k[masterKey.length]     =  objNum        & 0xFF;
    k[masterKey.length + 1] = (objNum >>> 8) & 0xFF;
    k[masterKey.length + 2] = (objNum >>> 16) & 0xFF;
    k[masterKey.length + 3] =  gen           & 0xFF;
    k[masterKey.length + 4] = (gen    >>> 8) & 0xFF;
    const hash = md5(k);
    return hash.slice(0, Math.min(masterKey.length + 5, 16));
  }

  // ---------- RC4 ----------
  function rc4(key, data) {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key[i % key.length]) & 0xFF;
      const t = S[i]; S[i] = S[j]; S[j] = t;
    }
    const out = new Uint8Array(data.length);
    let a = 0, b = 0;
    for (let n = 0; n < data.length; n++) {
      a = (a + 1) & 0xFF;
      b = (b + S[a]) & 0xFF;
      const t = S[a]; S[a] = S[b]; S[b] = t;
      out[n] = data[n] ^ S[(S[a] + S[b]) & 0xFF];
    }
    return out;
  }

  // ---------- MD5 ----------
  // Pure JS MD5 returning Uint8Array(16).
  function md5(bytes) {
    const len = bytes.length;
    const nBlocks = ((len + 8) >>> 6) + 1;
    const total = nBlocks * 64;
    const padded = new Uint8Array(total);
    padded.set(bytes, 0);
    padded[len] = 0x80;
    const bitLen = len * 8;
    padded[total - 8] =  bitLen         & 0xFF;
    padded[total - 7] = (bitLen >>> 8)  & 0xFF;
    padded[total - 6] = (bitLen >>> 16) & 0xFF;
    padded[total - 5] = (bitLen >>> 24) & 0xFF;
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const M = new Int32Array(16);
    for (let blk = 0; blk < nBlocks; blk++) {
      for (let i = 0; i < 16; i++) {
        const o = blk * 64 + i * 4;
        M[i] = padded[o] | (padded[o + 1] << 8) | (padded[o + 2] << 16) | (padded[o + 3] << 24);
      }
      let A = a, B = b, C = c, D = d;
      // Round 1
      A = ff(A,B,C,D, M[0],  7, -680876936);
      D = ff(D,A,B,C, M[1], 12, -389564586);
      C = ff(C,D,A,B, M[2], 17,  606105819);
      B = ff(B,C,D,A, M[3], 22, -1044525330);
      A = ff(A,B,C,D, M[4],  7, -176418897);
      D = ff(D,A,B,C, M[5], 12,  1200080426);
      C = ff(C,D,A,B, M[6], 17, -1473231341);
      B = ff(B,C,D,A, M[7], 22, -45705983);
      A = ff(A,B,C,D, M[8],  7,  1770035416);
      D = ff(D,A,B,C, M[9], 12, -1958414417);
      C = ff(C,D,A,B, M[10],17, -42063);
      B = ff(B,C,D,A, M[11],22, -1990404162);
      A = ff(A,B,C,D, M[12], 7,  1804603682);
      D = ff(D,A,B,C, M[13],12, -40341101);
      C = ff(C,D,A,B, M[14],17, -1502002290);
      B = ff(B,C,D,A, M[15],22,  1236535329);
      // Round 2
      A = gg(A,B,C,D, M[1],  5, -165796510);
      D = gg(D,A,B,C, M[6],  9, -1069501632);
      C = gg(C,D,A,B, M[11],14,  643717713);
      B = gg(B,C,D,A, M[0], 20, -373897302);
      A = gg(A,B,C,D, M[5],  5, -701558691);
      D = gg(D,A,B,C, M[10], 9,  38016083);
      C = gg(C,D,A,B, M[15],14, -660478335);
      B = gg(B,C,D,A, M[4], 20, -405537848);
      A = gg(A,B,C,D, M[9],  5,  568446438);
      D = gg(D,A,B,C, M[14], 9, -1019803690);
      C = gg(C,D,A,B, M[3], 14, -187363961);
      B = gg(B,C,D,A, M[8], 20,  1163531501);
      A = gg(A,B,C,D, M[13], 5, -1444681467);
      D = gg(D,A,B,C, M[2],  9, -51403784);
      C = gg(C,D,A,B, M[7], 14,  1735328473);
      B = gg(B,C,D,A, M[12],20, -1926607734);
      // Round 3
      A = hh(A,B,C,D, M[5],  4, -378558);
      D = hh(D,A,B,C, M[8], 11, -2022574463);
      C = hh(C,D,A,B, M[11],16,  1839030562);
      B = hh(B,C,D,A, M[14],23, -35309556);
      A = hh(A,B,C,D, M[1],  4, -1530992060);
      D = hh(D,A,B,C, M[4], 11,  1272893353);
      C = hh(C,D,A,B, M[7], 16, -155497632);
      B = hh(B,C,D,A, M[10],23, -1094730640);
      A = hh(A,B,C,D, M[13], 4,  681279174);
      D = hh(D,A,B,C, M[0], 11, -358537222);
      C = hh(C,D,A,B, M[3], 16, -722521979);
      B = hh(B,C,D,A, M[6], 23,  76029189);
      A = hh(A,B,C,D, M[9],  4, -640364487);
      D = hh(D,A,B,C, M[12],11, -421815835);
      C = hh(C,D,A,B, M[15],16,  530742520);
      B = hh(B,C,D,A, M[2], 23, -995338651);
      // Round 4
      A = ii(A,B,C,D, M[0],  6, -198630844);
      D = ii(D,A,B,C, M[7], 10,  1126891415);
      C = ii(C,D,A,B, M[14],15, -1416354905);
      B = ii(B,C,D,A, M[5], 21, -57434055);
      A = ii(A,B,C,D, M[12], 6,  1700485571);
      D = ii(D,A,B,C, M[3], 10, -1894986606);
      C = ii(C,D,A,B, M[10],15, -1051523);
      B = ii(B,C,D,A, M[1], 21, -2054922799);
      A = ii(A,B,C,D, M[8],  6,  1873313359);
      D = ii(D,A,B,C, M[15],10, -30611744);
      C = ii(C,D,A,B, M[6], 15, -1560198380);
      B = ii(B,C,D,A, M[13],21,  1309151649);
      A = ii(A,B,C,D, M[4],  6, -145523070);
      D = ii(D,A,B,C, M[11],10, -1120210379);
      C = ii(C,D,A,B, M[2], 15,  718787259);
      B = ii(B,C,D,A, M[9], 21, -343485551);
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    const out = new Uint8Array(16);
    [a, b, c, d].forEach((w, i) => {
      out[i * 4]     =  w        & 0xFF;
      out[i * 4 + 1] = (w >>> 8) & 0xFF;
      out[i * 4 + 2] = (w >>> 16)& 0xFF;
      out[i * 4 + 3] = (w >>> 24)& 0xFF;
    });
    return out;
  }
  function add(a, b) { return (a + b) | 0; }
  function rol(x, n) { return (x << n) | (x >>> (32 - n)); }
  function ff(a,b,c,d,x,s,t) { return add(rol(add(add(a, (b & c) | (~b & d)), add(x, t)), s), b); }
  function gg(a,b,c,d,x,s,t) { return add(rol(add(add(a, (b & d) | (c & ~d)), add(x, t)), s), b); }
  function hh(a,b,c,d,x,s,t) { return add(rol(add(add(a, b ^ c ^ d),         add(x, t)), s), b); }
  function ii(a,b,c,d,x,s,t) { return add(rol(add(add(a, c ^ (b | ~d)),       add(x, t)), s), b); }

  // ---------- public ----------
  async function canvasToJpegBytes(canvas, quality = 0.86) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  }

  DS.pdf = {
    buildPdf,
    canvasToJpegBytes,
    PAPER_KEYS: Object.keys(PAPER),
    // Exposed for self-test only.
    _internal: { md5, rc4 },
  };
})();
