/**
 * Reconocedor nuevo: valida el fotograma, endereza la carta y busca un
 * embedding. No toca el elemento de vídeo ni la sesión de cámara.
 * Se carga como módulo y también expone window.NewScan.
 */
const CANON_W = 504;
const CANON_H = 704;
const EMBED_DIM = 128;

let worker = null;
let workerReady = null;
let indexPromise = null;
let phashPromise = null;
let lastRejectFp = null;

function grayOf(image) {
  const { width, height, data } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

function resizeGray(image, tw, th) {
  const src = grayOf(image);
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = (y + 0.5) * image.height / th - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = (x + 0.5) * image.width / tw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const v00 = src[y0 * image.width + x0];
      const v10 = src[y0 * image.width + x1];
      const v01 = src[y1 * image.width + x0];
      const v11 = src[y1 * image.width + x1];
      out[y * tw + x] = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
    }
  }
  return out;
}

function fingerprint(gray, width, height) {
  const cells = 4;
  const fp = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let sum = 0;
      let n = 0;
      const x0 = Math.floor(cx * width / cells);
      const x1 = Math.floor((cx + 1) * width / cells);
      const y0 = Math.floor(cy * height / cells);
      const y1 = Math.floor((cy + 1) * height / cells);
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          sum += gray[y * width + x];
          n++;
        }
      }
      fp[cy * cells + cx] = n ? sum / n : 0;
    }
  }
  return fp;
}

function sameFrame(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max < 4;
}

export function laplacianVariance(gray, width, height) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v = gray[i] * 4 - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** Rechaza bandeja vacía, fogonazo, desenfoque y el mismo fallo repetido. */
export function validateFrame(image, previousReject = lastRejectFp) {
  const tw = 160;
  const th = Math.max(1, Math.round(image.height * tw / image.width));
  const gray = resizeGray(image, tw, th);
  let sum = 0;
  const x0 = Math.floor(tw * 0.3);
  const x1 = Math.floor(tw * 0.7);
  const y0 = Math.floor(th * 0.3);
  const y1 = Math.floor(th * 0.7);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += gray[y * tw + x];
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const sharp = laplacianVariance(gray, tw, th);
  const fp = fingerprint(gray, tw, th);
  if (previousReject && sameFrame(fp, previousReject)) {
    return { ok: false, message: 'No hay una carta quieta en el marco.', fp, mean, sharp };
  }
  if (mean < 18 || mean > 245) {
    return { ok: false, message: 'No hay una carta quieta en el marco.', fp, mean, sharp };
  }
  if (sharp < 18) {
    return { ok: false, message: 'No hay una carta quieta en el marco.', fp, mean, sharp };
  }
  return { ok: true, fp, mean, sharp };
}

function largestBlob(mask, width, height) {
  const seen = new Uint8Array(width * height);
  let best = null;
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    const edge = [];
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const neighbors = [i - 1, i + 1, i - width, i + width];
      let border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (const n of neighbors) {
        if (n < 0 || n >= mask.length) continue;
        const nx = n % width;
        if (Math.abs(nx - x) > 1) continue;
        if (!mask[n]) border = true;
        else if (!seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
      if (border) edge.push(x, y);
    }
    if (!best || count > best.count) best = { count, minX, minY, maxX, maxY, edge };
  }
  return best;
}

function orderCorners(pts) {
  if (pts.length < 4) return null;
  const tl = pts.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y))[0];
  const br = pts.slice().sort((a, b) => (b.x + b.y) - (a.x + a.y))[0];
  const tr = pts.slice().sort((a, b) => (b.x - b.y) - (a.x - a.y))[0];
  const bl = pts.slice().sort((a, b) => (a.x - a.y) - (b.x - b.y))[0];
  const quad = [tl, tr, br, bl];
  const keys = new Set(quad.map((p) => `${p.x},${p.y}`));
  if (keys.size < 4) return null;
  return quad;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function detectQuad(image) {
  const maxW = 480;
  const scale = Math.min(1, maxW / image.width);
  const w = Math.max(8, Math.round(image.width * scale));
  const h = Math.max(8, Math.round(image.height * scale));
  const gray = resizeGray(image, w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] > 36 ? 1 : 0;
  const fg = mask.reduce((sum, v) => sum + v, 0);
  if (fg < w * h * 0.08 || fg > w * h * 0.92) return null;
  const blob = largestBlob(mask, w, h);
  if (!blob || blob.count < w * h * 0.08) return null;
  const pts = [];
  for (let i = 0; i < blob.edge.length; i += 2) pts.push({ x: blob.edge[i], y: blob.edge[i + 1] });
  if (pts.length < 4) return null;
  const picks = [
    pts.reduce((best, p) => (p.x + p.y < best.x + best.y ? p : best)),
    pts.reduce((best, p) => (p.x - p.y > best.x - best.y ? p : best)),
    pts.reduce((best, p) => (p.x + p.y > best.x + best.y ? p : best)),
    pts.reduce((best, p) => (p.y - p.x > best.y - best.x ? p : best)),
  ];
  const quad = orderCorners(picks);
  if (!quad) return null;
  const width = (dist(quad[0], quad[1]) + dist(quad[3], quad[2])) / 2;
  const height = (dist(quad[0], quad[3]) + dist(quad[1], quad[2])) / 2;
  if (height < width) return null;
  const ratio = width / height;
  if (ratio < 0.66 || ratio > 0.78) return null;
  return quad.map((p) => ({ x: p.x / scale, y: p.y / scale }));
}

function solve8(a, b) {
  const n = 8;
  const m = a.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-8) return null;
    const tmp = m[col];
    m[col] = m[pivot];
    m[pivot] = tmp;
    const div = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

function homography(from, to) {
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const x = from[i].x;
    const y = from[i].y;
    const X = to[i].x;
    const Y = to[i].y;
    a.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    a.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  return solve8(a, b);
}

function applyH(h, x, y) {
  const X = h[0] * x + h[1] * y + h[2];
  const Y = h[3] * x + h[4] * y + h[5];
  const W = h[6] * x + h[7] * y + 1;
  return [X / W, Y / W];
}

function sampleRgba(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const at = (xx, yy) => {
    const i = (yy * image.width + xx) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  const a = at(x0, y0);
  const b = at(x1, y0);
  const c = at(x0, y1);
  const d = at(x1, y1);
  return [0, 1, 2].map((k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (c[k] * (1 - fx) + d[k] * fx) * fy);
}

export function warpCanonical(image, quad) {
  const dest = [
    { x: 0, y: 0 },
    { x: CANON_W - 1, y: 0 },
    { x: CANON_W - 1, y: CANON_H - 1 },
    { x: 0, y: CANON_H - 1 },
  ];
  const h = homography(dest, quad);
  if (!h) return null;
  const data = new Uint8ClampedArray(CANON_W * CANON_H * 4);
  for (let y = 0; y < CANON_H; y++) {
    for (let x = 0; x < CANON_W; x++) {
      const [sx, sy] = applyH(h, x, y);
      const rgb = sampleRgba(image, sx, sy);
      const i = (y * CANON_W + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return { width: CANON_W, height: CANON_H, data };
}

export function cropFraction(image, x, y, w, h) {
  const sx = Math.max(0, Math.floor(x * image.width));
  const sy = Math.max(0, Math.floor(y * image.height));
  const sw = Math.max(1, Math.min(image.width - sx, Math.ceil(w * image.width)));
  const sh = Math.max(1, Math.min(image.height - sy, Math.ceil(h * image.height)));
  const data = new Uint8ClampedArray(sw * sh * 4);
  for (let row = 0; row < sh; row++) {
    const src = ((sy + row) * image.width + sx) * 4;
    data.set(image.data.subarray(src, src + sw * 4), row * sw * 4);
  }
  return { width: sw, height: sh, data };
}

export function centerCard(image) {
  return cropFraction(image, 0.15, 0.12, 0.7, 0.76);
}

/**
 * Carta a sangre: no hay mesa alrededor, así que el cuadrilátero de borde
 * no existe. Recorta el bloque claro y lo deja en la proporción 63/88.
 */
export function axisAlignedCard(image) {
  const maxW = 320;
  const scale = Math.min(1, maxW / image.width);
  const w = Math.max(8, Math.round(image.width * scale));
  const h = Math.max(8, Math.round(image.height * scale));
  // Vecino más cercano para no fundir un texto fino con el borde.
  // Si alrededor hay gris de la interfaz, la carta se separa por el color.
  // En el visor el alrededor es negro y basta con la luminancia.
  const mask = new Uint8Array(w * h);
  const { data } = image;
  let grayUi = 0;
  const samples = w * h;
  const pix = new Uint8Array(samples * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / w));
      const i = (sy * image.width + sx) * 4;
      const p = (y * w + x) * 3;
      pix[p] = data[i];
      pix[p + 1] = data[i + 1];
      pix[p + 2] = data[i + 2];
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (luma > 18 && luma < 48 && max - min < 12) grayUi++;
    }
  }
  const useColor = grayUi > samples * 0.12;
  for (let p = 0, i = 0; p < samples; p++, i += 3) {
    const r = pix[i];
    const g = pix[i + 1];
    const b = pix[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    if (useColor) {
      if (luma > 24 && (max - min > 18 || luma > 150)) mask[p] = 1;
    } else if (luma > 28) mask[p] = 1;
  }
  const blob = largestBlob(mask, w, h);
  if (!blob || blob.count < w * h * 0.2) return null;
  // Una línea de texto suelta (el aviso del escáner) no es el borde de la carta.
  const rowFill = (y) => {
    let n = 0;
    for (let x = blob.minX; x <= blob.maxX; x++) if (mask[y * w + x]) n++;
    return n;
  };
  const colFill = (x) => {
    let n = 0;
    for (let y = blob.minY; y <= blob.maxY; y++) if (mask[y * w + x]) n++;
    return n;
  };
  let minX = blob.minX;
  let minY = blob.minY;
  let maxX = blob.maxX;
  let maxY = blob.maxY;
  const minRow = Math.max(8, (blob.maxX - blob.minX) * 0.45);
  const minCol = Math.max(8, (blob.maxY - blob.minY) * 0.45);
  while (minY < maxY && rowFill(minY) < minRow) minY++;
  while (maxY > minY && rowFill(maxY) < minRow) maxY--;
  while (minX < maxX && colFill(minX) < minCol) minX++;
  while (maxX > minX && colFill(maxX) < minCol) maxX--;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < 8 || bh < 8 || bh < bw) return null;
  const target = 63 / 88;
  let x0 = minX;
  let y0 = minY;
  let x1 = maxX + 1;
  let y1 = maxY + 1;
  const ratio = bw / bh;
  if (ratio > target) {
    const nw = target * bh;
    const pad = (bw - nw) / 2;
    x0 = minX + pad;
    x1 = maxX + 1 - pad;
  } else if (ratio < target) {
    const nh = bw / target;
    const pad = (bh - nh) / 2;
    y0 = minY + pad;
    y1 = maxY + 1 - pad;
  }
  const boxW = (x1 - x0) / scale;
  const boxH = (y1 - y0) / scale;
  if (boxW * boxH < image.width * image.height * 0.28) return null;
  const left = x0 / scale;
  const top = y0 / scale;
  const right = x1 / scale;
  const bottom = y1 / scale;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

const ART_W = 8;
const ART_H = 10;
const ART_DIM = ART_W * ART_H * 3;

/** Rejilla de color del dibujo. Misma ventana que data/art-grid.bin. */
export function artVector(image) {
  const vals = new Float32Array(ART_DIM);
  const x0 = 0.08 * image.width;
  const y0 = 0.12 * image.height;
  const cw = 0.84 * image.width;
  const ch = 0.38 * image.height;
  let mean = 0;
  let p = 0;
  for (let y = 0; y < ART_H; y++) {
    const sy = y0 + (y + 0.5) * ch / ART_H - 0.5;
    const yA = Math.max(0, Math.min(image.height - 1, Math.floor(sy)));
    const yB = Math.max(0, Math.min(image.height - 1, yA + 1));
    const fy = Math.min(1, Math.max(0, sy - yA));
    for (let x = 0; x < ART_W; x++) {
      const sx = x0 + (x + 0.5) * cw / ART_W - 0.5;
      const xA = Math.max(0, Math.min(image.width - 1, Math.floor(sx)));
      const xB = Math.max(0, Math.min(image.width - 1, xA + 1));
      const fx = Math.min(1, Math.max(0, sx - xA));
      for (let c = 0; c < 3; c++) {
        const pick = (xx, yy) => image.data[(yy * image.width + xx) * 4 + c];
        const v = (pick(xA, yA) * (1 - fx) + pick(xB, yA) * fx) * (1 - fy)
          + (pick(xA, yB) * (1 - fx) + pick(xB, yB) * fx) * fy;
        vals[p++] = v;
        mean += v;
      }
    }
  }
  mean /= ART_DIM;
  let varSum = 0;
  for (let i = 0; i < ART_DIM; i++) {
    const d = vals[i] - mean;
    vals[i] = d;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / ART_DIM) || 1;
  let norm = 0;
  for (let i = 0; i < ART_DIM; i++) {
    vals[i] /= std;
    norm += vals[i] * vals[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < ART_DIM; i++) vals[i] /= norm;
  return vals;
}

function imageToTensor(image) {
  const cropped = cropFraction(image, 0.06, 0.06, 0.88, 0.88);
  const size = 224;
  const data = new Float32Array(3 * size * size);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let y = 0; y < size; y++) {
    const sy = (y + 0.5) * cropped.height / size - 0.5;
    const y0 = Math.max(0, Math.min(cropped.height - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(cropped.height - 1, y0 + 1));
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < size; x++) {
      const sx = (x + 0.5) * cropped.width / size - 0.5;
      const x0 = Math.max(0, Math.min(cropped.width - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(cropped.width - 1, x0 + 1));
      const fx = Math.min(1, Math.max(0, sx - x0));
      for (let c = 0; c < 3; c++) {
        const pick = (xx, yy) => cropped.data[(yy * cropped.width + xx) * 4 + c] / 255;
        const v = (pick(x0, y0) * (1 - fx) + pick(x1, y0) * fx) * (1 - fy)
          + (pick(x0, y1) * (1 - fx) + pick(x1, y1) * fx) * fy;
        data[c * size * size + y * size + x] = (v - mean[c]) / std[c];
      }
    }
  }
  return data;
}

function loadIndex() {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const manifestRes = await fetch('./data/scan-manifest.json');
    if (!manifestRes.ok) throw new Error('sin manifiesto');
    const manifest = await manifestRes.json();
    const [buf, idsRes] = await Promise.all([
      fetch('./' + manifest.indexFile).then((r) => { if (!r.ok) throw new Error('sin índice'); return r.arrayBuffer(); }),
      fetch('./' + manifest.idsFile).then((r) => { if (!r.ok) throw new Error('sin ids'); return r.json(); }),
    ]);
    const bytes = new Int8Array(buf);
    if (bytes.length !== idsRes.length * manifest.dim) throw new Error('índice incompleto');
    let artBytes = null;
    const artDim = manifest.artGridDim || ART_DIM;
    if (manifest.artGridFile) {
      const artRes = await fetch('./' + manifest.artGridFile);
      if (artRes.ok) {
        const art = new Int8Array(await artRes.arrayBuffer());
        if (art.length === idsRes.length * artDim) artBytes = art;
      }
    }
    return { manifest, ids: idsRes, bytes, artBytes, artDim };
  })();
  return indexPromise;
}

function loadPhash() {
  if (phashPromise) return phashPromise;
  phashPromise = fetch('./data/phash-canon.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return phashPromise;
}

function ensureWorker() {
  if (workerReady) return workerReady;
  workerReady = new Promise((resolve) => {
    try {
      worker = new Worker('./scanner/embed-worker.js');
    } catch (err) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 45000);
    worker.onmessage = (event) => {
      if (event.data.type === 'ready') {
        clearTimeout(timer);
        resolve(true);
      } else if (event.data.type === 'error') {
        clearTimeout(timer);
        resolve(false);
      }
    };
    worker.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const modelUrl = new URL('../models/card-embed.onnx', import.meta.url).href;
    worker.postMessage({ type: 'init', modelUrl });
  });
  return workerReady;
}

function embedWithWorker(tensor) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.type === 'emb') {
        worker.removeEventListener('message', onMessage);
        resolve(event.data.data);
      } else if (event.data.type === 'run-error') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(event.data.message || 'embedding'));
      }
    };
    worker.addEventListener('message', onMessage);
    const copy = new Float32Array(tensor);
    worker.postMessage({ type: 'run', data: copy }, [copy.buffer]);
  });
}

export function searchTop(query, bytes, ids, dim = EMBED_DIM, limit = 8) {
  const n = ids.length;
  const q = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += query[i] * query[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) q[i] = query[i] / norm;
  const scored = [];
  for (let row = 0; row < n; row++) {
    let dot = 0;
    const base = row * dim;
    for (let i = 0; i < dim; i++) dot += q[i] * bytes[base + i];
    // La consulta ya está normalizada. Cada fila int8 es el vector unitario
    // por 127, así que el coseno es el producto partido por 127. Partir otra
    // vez por 127 aplasta un acierto (1) hasta ~0,008 y nunca pasa el umbral.
    scored.push({ id: ids[row], score: dot / 127 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

function unitQuery(query, dim) {
  const q = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += query[i] * query[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) q[i] = query[i] / norm;
  return q;
}

/**
 * El embedding de arte oficial queda casi igual de cerca de cualquier carta
 * cuando la foto es de un teléfono. La rejilla de color del dibujo separa
 * esa foto; el embedding solo desempata.
 */
export function searchFused(embedQuery, embedBytes, artQuery, artBytes, ids, embedDim = EMBED_DIM, artDim = ART_DIM, limit = 8) {
  const n = ids.length;
  const eq = unitQuery(embedQuery, embedDim);
  const aq = artQuery && artBytes ? unitQuery(artQuery, artDim) : null;
  const best = [];
  const consider = (row) => {
    let place = best.length;
    while (place > 0 && row.score > best[place - 1].score) place--;
    if (place >= limit) return;
    best.splice(place, 0, row);
    if (best.length > limit) best.pop();
  };
  for (let row = 0; row < n; row++) {
    let edot = 0;
    const eb = row * embedDim;
    for (let i = 0; i < embedDim; i++) edot += eq[i] * embedBytes[eb + i];
    const embed = edot / 127;
    let score = embed;
    let art = null;
    if (aq) {
      let adot = 0;
      const ab = row * artDim;
      for (let i = 0; i < artDim; i++) adot += aq[i] * artBytes[ab + i];
      art = adot / 127;
      score = art + 0.05 * embed;
    }
    consider({ id: ids[row], score, embed, art });
  }
  return best;
}

function dct1d(sig) {
  const n = sig.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += sig[i] * Math.cos(Math.PI * k * (2 * i + 1) / (2 * n));
    out[k] = s;
  }
  return out;
}

export function phashFromRgba(image) {
  const small = resizeGray(image, 32, 32);
  const dctRows = [];
  for (let r = 0; r < 32; r++) dctRows.push(dct1d(small.slice(r * 32, (r + 1) * 32)));
  const block = new Float64Array(64);
  for (let c = 0; c < 8; c++) {
    const col = new Float64Array(32);
    for (let r = 0; r < 32; r++) col[r] = dctRows[r][c];
    const d = dct1d(col);
    for (let r = 0; r < 8; r++) block[r * 8 + c] = d[r];
  }
  const nodc = Array.from(block.slice(1)).sort((a, b) => a - b);
  const mid = Math.floor(nodc.length / 2);
  const median = nodc.length % 2 === 0 ? (nodc[mid - 1] + nodc[mid]) / 2 : nodc[mid];
  let hash = 0n;
  for (let i = 0; i < 64; i++) if (block[i] > median) hash |= 1n << BigInt(63 - i);
  return hash.toString(16).padStart(16, '0');
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let d = 0;
  while (x) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

async function phashTop(image, limit = 5) {
  const table = await loadPhash();
  const query = phashFromRgba(image);
  const rows = [];
  for (const [id, hash] of Object.entries(table)) {
    const distance = hamming(query, hash);
    if (distance <= 18) rows.push({ id, distance, score: 1 - distance / 64 });
  }
  rows.sort((a, b) => a.distance - b.distance);
  return rows.slice(0, limit);
}

/**
 * Confirma una sola carta solo con borde y un margen claro.
 * Sin borde, o con un coseno tibio, devuelve lista. Nunca añade la carta.
 */
export function decideMatch({ top, bordered, model, ocrIds }) {
  if (!top.length) {
    return { pendingId: null, suggestionIds: [], message: 'No la reconozco.' };
  }
  if (!model) {
    const best = top[0];
    const next = top[1];
    const gap = next ? next.distance - best.distance : 99;
    if (bordered && best.distance <= 8 && gap >= 6) {
      return { pendingId: best.id, suggestionIds: [], message: '¿Es esta?' };
    }
    if (best.distance <= 18) {
      return { pendingId: null, suggestionIds: top.slice(0, 5).map((row) => row.id), message: 'Candidatas por imagen. ¿Cuál es?' };
    }
    return { pendingId: null, suggestionIds: [], message: 'No la reconozco.' };
  }
  const best = top[0];
  const second = top[1];
  const gap = best.score - (second ? second.score : 0);
  const ocrHit = (ocrIds || []).find((id) => top.slice(0, 8).some((row) => row.id === id));
  if (bordered && ocrHit && best.score >= 0.8) {
    return { pendingId: ocrHit, suggestionIds: top.filter((row) => row.id !== ocrHit).slice(0, 4).map((row) => row.id), message: 'El número coincide. ¿Es esta?' };
  }
  // 0,74 es un acierto claro de la rejilla de color más un poco de embedding.
  // El margen evita confirmar cuando las primeras están empatadas.
  if (bordered && best.score >= 0.74 && gap >= 0.05) {
    return { pendingId: best.id, suggestionIds: top.filter((row) => row.id !== best.id).slice(0, 4).map((row) => row.id), message: '¿Es esta?' };
  }
  if (best.score >= 0.45) {
    return { pendingId: null, suggestionIds: top.slice(0, 5).map((row) => row.id), message: best.score >= 0.72 ? 'Varias parecidas. ¿Cuál es?' : 'No estoy seguro. ¿Es alguna de estas?' };
  }
  return { pendingId: null, suggestionIds: [], message: 'No la reconozco.' };
}

function canvasFromImage(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

export async function recognize(canvas, hooks = {}) {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const image = {
    width: canvas.width,
    height: canvas.height,
    data: canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data,
  };
  const gate = validateFrame(image);
  if (!gate.ok) {
    lastRejectFp = gate.fp;
    return { ok: false, message: gate.message, diag: `borde no · nitidez ${gate.sharp.toFixed(0)}` };
  }
  lastRejectFp = null;
  const perspective = detectQuad(image);
  const fitted = perspective || axisAlignedCard(image);
  const bordered = !!fitted;
  const canonical = fitted ? warpCanonical(image, fitted) : centerCard(image);
  if (!canonical) {
    return { ok: false, message: 'No veo el borde de la carta.', diag: 'borde no' };
  }
  let ocrText = '';
  if (bordered && hooks.ocr) {
    const number = cropFraction(canonical, 0, 0.86, 0.46, 0.11);
    try { ocrText = await hooks.ocr(canvasFromImage(number)) || ''; }
    catch { ocrText = ''; }
  }
  let top = [];
  let model = false;
  let modelError = '';
  try {
    const ready = await ensureWorker();
    if (!ready) throw new Error('modelo no disponible');
    const tensor = imageToTensor(canonical);
    const raw = await embedWithWorker(tensor);
    const index = await loadIndex();
    const art = bordered ? artVector(canonical) : null;
    top = searchFused(raw, index.bytes, art, index.artBytes, index.ids, EMBED_DIM, index.artDim);
    model = true;
  } catch (err) {
    modelError = err && err.message ? err.message : 'sin modelo';
    top = await phashTop(canonical);
    model = false;
  }
  const ocrIds = hooks.ocrIds ? await hooks.ocrIds(ocrText) : [];
  const decision = decideMatch({ top, bordered, model, ocrIds });
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
  const best = top[0];
  const scoreText = !best ? '—' : (model ? best.score.toFixed(2) : `d=${best.distance}`);
  const diag = [
    perspective ? 'borde sí' : (bordered ? 'carta a sangre' : 'borde no'),
    `${ms} ms`,
    model ? `coseno ${scoreText}` : `phash ${scoreText}`,
    ocrText ? `número ${ocrText.replace(/\s+/g, ' ').trim().slice(0, 24)}` : 'número —',
    best ? `top ${best.id}` : '',
    modelError ? 'modelo no' : '',
  ].filter(Boolean).join(' · ');
  return {
    ok: true,
    bordered,
    model,
    quad: fitted || null,
    message: decision.message,
    pendingId: decision.pendingId,
    suggestionIds: decision.suggestionIds,
    diag,
    ocrText,
    top: top.slice(0, 5).map((row) => ({
      id: row.id,
      score: row.score,
      art: row.art,
      embed: row.embed,
      distance: row.distance,
    })),
  };
}

export const NewScan = {
  validateFrame,
  detectQuad,
  warpCanonical,
  laplacianVariance,
  searchTop,
  searchFused,
  axisAlignedCard,
  artVector,
  decideMatch,
  phashFromRgba,
  recognize,
  rememberReject(fp) { lastRejectFp = fp; },
};

if (typeof window !== 'undefined') window.NewScan = NewScan;
