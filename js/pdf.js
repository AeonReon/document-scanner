// Minimal multi-page image PDF builder.
// Each page is a single JPEG XObject drawn full-page. Zero dependencies.
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
  // paper: 'fit' | key from PAPER
  async function buildPdf(pages, { paper = 'fit', title = 'Scan' } = {}) {
    if (!pages || !pages.length) throw new Error('No pages');

    // Build objects.
    // Object 1: Catalog
    // Object 2: Pages
    // Then for each page: image XObject, content stream, page node (3 objects/page)
    // Plus object N+1: Info
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

    // Now we know total object count. Patch Catalog and Pages.
    objs[0] = { type: 'catalog' };                         // obj 1
    objs[1] = { type: 'pagesRoot', kids: pageObjNums };    // obj 2

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
        push(`<< /Title ${pdfString(o.title)} /Producer ${pdfString('Private Document Scanner')} /Creator ${pdfString('Private Document Scanner')} >>\n`);
      } else if (o.type === 'page') {
        push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${o.mediaW.toFixed(4)} ${o.mediaH.toFixed(4)}] ` +
             `/Resources << /XObject << /Im0 ${o.imgNum} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> ` +
             `/Contents ${o.contentNum} 0 R >>\n`);
      } else if (o.type === 'content') {
        const s = o.stream;
        push(`<< /Length ${s.length} >>\nstream\n${s}endstream\n`);
      } else if (o.type === 'image') {
        push(`<< /Type /XObject /Subtype /Image /Width ${o.widthPx} /Height ${o.heightPx} ` +
             `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${o.jpeg.length} >>\n`);
        push('stream\n');
        push(o.jpeg);
        push('\nendstream\n');
      }
      push('endobj\n');
    }

    const xrefOffset = offset;
    push(`xref\n0 ${objs.length + 1}\n`);
    push('0000000000 65535 f \n');
    for (const xo of xref) {
      push(`${String(xo).padStart(10, '0')} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\n`);
    push(`startxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(parts, { type: 'application/pdf' });
  }

  function computePageDims(page, paper) {
    // 200 DPI assumption — gives sensibly-sized "fit" pages.
    if (paper === 'fit' || !PAPER[paper]) {
      const pageW = page.widthPx * 72 / 200;
      const pageH = page.heightPx * 72 / 200;
      return { pageW, pageH, imgW: pageW, imgH: pageH, imgX: 0, imgY: 0 };
    }
    const { w: pageW, h: pageH } = PAPER[paper];
    // Fit image inside page preserving aspect ratio.
    const pageAr = pageW / pageH;
    const imgAr = page.widthPx / page.heightPx;
    let imgW, imgH;
    if (imgAr > pageAr) {
      imgW = pageW;
      imgH = pageW / imgAr;
    } else {
      imgH = pageH;
      imgW = pageH * imgAr;
    }
    const imgX = (pageW - imgW) / 2;
    const imgY = (pageH - imgH) / 2;
    return { pageW, pageH, imgW, imgH, imgX, imgY };
  }

  function encodeLatin1(s) {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  function pdfString(s) {
    // Escape paren / backslash / non-ASCII for PDF literal string.
    const safe = String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    let out = '';
    for (let i = 0; i < safe.length; i++) {
      const code = safe.charCodeAt(i);
      if (code < 128) out += safe[i];
      else out += '?';
    }
    return `(${out})`;
  }

  async function canvasToJpegBytes(canvas, quality = 0.86) {
    const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  }

  DS.pdf = {
    buildPdf,
    canvasToJpegBytes,
    PAPER_KEYS: Object.keys(PAPER),
  };
})();
