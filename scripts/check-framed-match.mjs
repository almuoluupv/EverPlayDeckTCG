import { spawn } from 'node:child_process';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';

const port = 43127;
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/static-server.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PORT_WEB: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
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
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

try {
  await ready;
  const page = await browser.newPage();
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => typeof findByPhash === 'function' && typeof settleRecognition === 'function');

  const index = await fetch(origin + '/data/index.json').then((r) => r.json());
  const wanted = ['swsh11-109', 'sv03.5-025', 'sv02-025', 'sv08-025', 'sm12-123'];
  const cards = [];
  for (const id of wanted) {
    const card = index.find((c) => c.id === id);
    if (!card?.image) continue;
    const res = await fetch(card.image);
    if (!res.ok) throw new Error('imagen ' + id + ' ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || 'image/webp';
    cards.push({ id: card.id, name: card.name, dataUrl: `data:${type};base64,${bytes.toString('base64')}` });
  }

  const report = await page.evaluate(async (cards) => {
    function load(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(url.slice(0, 40)));
        img.src = url;
      });
    }
    function frame(img) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * 1.38);
      canvas.height = Math.round(img.naturalHeight * 1.24);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#10141c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, Math.round(canvas.width * 0.07), Math.round(canvas.height * 0.05));
      return canvas;
    }
    const before = state.collection.length;
    const roiBefore = { ...state.scan.roiNum };
    const rows = [];
    for (const card of cards) {
      const img = await load(card.dataUrl);
      const canvas = frame(img);
      const hits = await findByPhash(canvas, 5, 22, '');
      const decision = await settleRecognition({
        numberTexts: ['TEF ruido'],
        nameText: '',
        cardColor: canvas,
        onStatus: () => {},
        missHint: '',
      });
      rows.push({
        id: card.id,
        name: card.name,
        top: hits.map((h) => ({ id: h.card.id, name: h.card.name, d: h.distance })),
        pending: decision.pending ? { id: decision.pending.id, name: decision.pending.name } : null,
        listed: (decision.nameResults || []).map((c) => c.id),
        message: decision.message,
      });
    }
    return {
      before,
      after: state.collection.length,
      roiBefore,
      roiAfter: state.scan.roiNum,
      rows,
    };
  }, cards);

  assert(report.after === report.before, 'la comparación no debe añadir cartas');
  assert(JSON.stringify(report.roiBefore) === JSON.stringify(report.roiAfter), 'el recuadro del número no debe moverse');
  const rock = report.rows.find((row) => row.id === 'swsh11-109');
  assert(rock, 'falta Rockruff swsh11-109');
  assert(rock.top.some((hit) => hit.id === 'swsh11-109'), 'Rockruff no está entre las candidatas: ' + JSON.stringify(rock.top));
  assert(rock.top[0].id === 'swsh11-109', 'Rockruff no es la primera candidata: ' + JSON.stringify(rock.top));
  assert(rock.top[0].d <= 10, 'el parecido de Rockruff quedó fuera de la confirmación: ' + rock.top[0].d);
  assert(!rock.top[1] || rock.top[1].d - rock.top[0].d >= 4, 'Rockruff no destaca sobre la siguiente carta: ' + JSON.stringify(rock.top));
  assert(rock.pending && rock.pending.id === 'swsh11-109', 'la confirmación no es Rockruff: ' + JSON.stringify(rock.pending) + ' ' + rock.message);
  assert(!rock.message.toLowerCase().includes('añad'), 'el mensaje no debe dar la carta por añadida: ' + rock.message);

  for (const row of report.rows) {
    assert(row.top.length, row.id + ' no devolvió candidatas');
    assert(row.top.some((hit) => hit.id === row.id), row.id + ' no sale en las candidatas: ' + JSON.stringify(row.top));
    if (row.top[0].d <= 10) {
      assert(row.top[0].id === row.id || row.top[0].name === row.name, row.id + ' confirmaría una carta distinta: ' + JSON.stringify(row.top[0]));
    }
    assert(!row.pending || row.pending.name === row.name, row.id + ' pide confirmar otra carta: ' + JSON.stringify(row.pending));
  }

  console.log('framed-match-ok', JSON.stringify(report.rows.map((row) => ({
    id: row.id,
    first: row.top[0],
    pending: row.pending && row.pending.id,
  }))));
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit').catch(() => {});
}
