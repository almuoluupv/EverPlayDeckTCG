import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const port = 43141;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/static-server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT_WEB: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('sin servidor\n' + serverLog)), 8000);
  server.stdout.on('data', () => {
    if (serverLog.includes(String(port))) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.NewScan && window.NewScan.recognize && document.querySelector('.chip[data-engine="new"]'), { timeout: 15000 });
  const ui = await page.evaluate(async () => {
    const manifest = await fetch('./data/scan-manifest.json').then((r) => r.json());
    const model = await fetch('./models/card-embed.onnx').then((r) => r.arrayBuffer());
    const chip = document.querySelector('.chip[data-engine="new"]');
    return {
      engine: state.scan.engine,
      chip: chip && chip.classList.contains('active'),
      classic: !!document.querySelector('.chip[data-engine="classic"]'),
      count: manifest.count,
      modelBytes: model.byteLength,
    };
  });
  if (ui.engine !== 'new' || !ui.chip || !ui.classic) throw new Error('los caminos Nuevo y Clásico no están: ' + JSON.stringify(ui));
  if (ui.count < 14000) throw new Error('índice corto: ' + ui.count);
  if (ui.modelBytes < 1000000) throw new Error('modelo pequeño: ' + ui.modelBytes);

  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 640;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 360, 640);
    for (let y = 70; y < 560; y++) {
      for (let x = 50; x < 300; x++) {
        const n = (x * 13 + y * 7) % 180;
        ctx.fillStyle = `rgb(${40 + n},${20 + (x % 90)},${30 + (y % 80)})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const out = await window.NewScan.recognize(canvas, { ocr: async () => '', ocrIds: async () => [] });
    return { message: out.message, diag: out.diag, model: out.model, bordered: out.bordered, pendingId: out.pendingId };
  });
  if (!result.model) throw new Error('el modelo no cargó en el navegador: ' + JSON.stringify(result) + ' ' + errors.join(' | '));
  if (result.pendingId) throw new Error('confirmó una carta de prueba sin margen real: ' + JSON.stringify(result));
  console.log('embed-browser-ok', JSON.stringify({ ...ui, ...result, errors }));
} finally {
  await browser.close();
  server.kill();
}
