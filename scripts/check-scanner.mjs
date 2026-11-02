import { spawn } from 'node:child_process';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';

const port = 43123;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/static-server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT_WEB: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (chunk) => {
  serverLog += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  serverLog += chunk.toString();
});

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('el servidor estático no arrancó\n' + serverLog)), 8000);
  server.stdout.on('data', () => {
    if (serverLog.includes(String(port))) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error('servidor estático cerrado ' + code + '\n' + serverLog));
  });
});

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  await ready;
  const secretProbe = await fetch(origin + '/.env');
  if (secretProbe.status !== 404) throw new Error('/.env no debe servirse');
  const localConfig = await fetch(origin + '/config.local.js');
  const localText = await localConfig.text();
  if (!localConfig.ok) throw new Error('config.local.js no está disponible en local');
  if (localText.includes('sk_test_') || localText.includes('CLERK_SECRET')) {
    throw new Error('config.local.js contiene la clave secreta');
  }
  if (!localText.includes('pk_test_')) throw new Error('falta la clave publicable en config.local.js');

  const page = await browser.newPage();
  const apiCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/collection')) apiCalls.push(req.url());
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => {
    const slot = document.querySelector('#authSlot');
    return slot && /Entrar|dispositivo|Login no disponible/.test(slot.textContent || '');
  }, { timeout: 15000 });

  const authText = await page.$eval('#authSlot', (el) => el.textContent.trim());
  await page.click('nav.tabs button[data-tab="search"]');
  await page.waitForSelector('#searchInput');
  await page.type('#searchInput', 'Pikachu');
  await page.click('#searchBtn');
  await page.waitForSelector('#searchResults .result-card', { timeout: 20000 });
  const name = await page.$eval('#searchResults .rname', (el) => el.textContent);
  if (!/pikachu/i.test(name)) throw new Error('la búsqueda no encontró Pikachu: ' + name);
  await page.click('#searchResults .result-card');
  await page.click('nav.tabs button[data-tab="collection"]');
  await page.waitForFunction(() => {
    const count = document.querySelector('#collectionCount')?.textContent || '';
    const main = document.querySelector('#main')?.textContent || '';
    return count.includes('1 carta') && /pikachu/i.test(main);
  }, { timeout: 10000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#collectionCount')?.textContent?.includes('1 carta'), { timeout: 15000 });
  await page.click('nav.tabs button[data-tab="collection"]');
  const stored = await page.evaluate(() => localStorage.getItem('pokemon_album_collection_v1'));
  if (!stored || !stored.includes('Pikachu')) throw new Error('localStorage no guardó la carta');
  const html = await page.content();
  if (html.includes('sk_test_')) throw new Error('la página muestra la clave secreta');
  if (apiCalls.length) throw new Error('el álbum llamó a la API sin sesión');
  console.log('scanner-ok', JSON.stringify({ authText, apiCalls: apiCalls.length }));
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit').catch(() => {});
}
