import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const port = 43147;
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (/clerk|onrender\.com|\/api\/collection|data\/index\.json/i.test(url)) return;
    req.continue();
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const first = await page.evaluate(() => {
    const btn = document.getElementById('startLiveBtn');
    if (!btn) return null;
    const box = btn.getBoundingClientRect();
    return { text: btn.textContent, top: box.top, height: box.height, width: box.width };
  });
  assert(first && first.text.includes('Iniciar cámara'), 'el primer render de Escanear no tiene el botón: ' + JSON.stringify(first));
  assert(first.height > 30 && first.width > 80, 'el botón no se ve: ' + JSON.stringify(first));
  assert(first.top < 844, 'el botón queda fuera de la primera pantalla: ' + JSON.stringify(first));
  await page.evaluate(() => document.querySelector('nav.tabs button[data-tab="account"]').click());
  await page.waitForFunction(() => !document.getElementById('startLiveBtn') && document.getElementById('main').textContent.length > 0);
  await page.evaluate(() => document.querySelector('nav.tabs button[data-tab="scan"]').click());
  const back = await page.evaluate(() => {
    const btn = document.getElementById('startLiveBtn');
    return btn ? btn.textContent : '';
  });
  assert(back.includes('Iniciar cámara'), 'al volver de Cuenta desaparece el botón');
  const chips = await page.evaluate(() => ({
    nuevo: !!document.querySelector('.chip[data-engine="new"]'),
    clasico: !!document.querySelector('.chip[data-engine="classic"]'),
  }));
  assert(chips.nuevo && chips.clasico, 'faltan Nuevo o Clásico');
  console.log('scan-first-paint-ok', JSON.stringify(first));
} finally {
  await browser.close();
  server.kill();
}
