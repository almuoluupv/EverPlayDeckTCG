import { spawn } from 'node:child_process';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';

const port = 43129;
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
  await page.waitForSelector('#startLiveBtn', { timeout: 15000 });
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d86a1f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(12);
    const track = stream.getVideoTracks()[0];
    window.__constraintCalls = [];
    window.__gumCalls = 0;
    track.applyConstraints = (constraints) => {
      window.__constraintCalls.push(constraints);
      return Promise.resolve();
    };
    track.getCapabilities = () => ({
      zoom: { min: 1, max: 8, step: 0.1 },
      focusMode: ['manual', 'continuous'],
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
    });
    track.getSettings = () => ({ width: 1280, height: 720, zoom: 1, focusMode: 'continuous' });
    navigator.mediaDevices.getUserMedia = async () => {
      window.__gumCalls += 1;
      return stream;
    };
    ensureOcrWorker = async () => ({});
  });

  await page.click('#startLiveBtn');
  await page.waitForFunction(() => {
    const video = document.getElementById('liveVideo');
    return video && video.videoWidth === 1280 && video.videoHeight === 720;
  }, { timeout: 10000 });

  const before = await page.evaluate(() => {
    window.__preview = document.getElementById('liveVideo');
    window.__stream = window.__preview.srcObject;
    return {
      width: window.__preview.videoWidth,
      height: window.__preview.videoHeight,
    };
  });

  await page.evaluate(() => applyCameraZoom(2));
  await page.click('#adjustAgainBtn');
  await page.waitForSelector('#beginScanBtn');
  await page.evaluate(() => applyCameraZoom(1.5));
  await page.click('#beginScanBtn');
  await page.waitForSelector('#adjustAgainBtn');

  const after = await page.evaluate(() => {
    const video = document.getElementById('liveVideo');
    return {
      sameNode: video === window.__preview,
      sameStream: video.srcObject === window.__stream,
      width: video.videoWidth,
      height: video.videoHeight,
      zoom: video.style.getPropertyValue('--camera-display-zoom'),
      hardware: state.scan.hardwareZoom,
      constraints: window.__constraintCalls,
      gum: window.__gumCalls,
    };
  });

  assert(after.gum === 1, 'la cámara se abrió más de una vez: ' + after.gum);
  assert(after.constraints.length === 0, 'se cambiaron constraints a mitad de encuadre: ' + JSON.stringify(after.constraints));
  assert(after.sameNode, 'Ajustar zona sustituyó el elemento de vídeo');
  assert(after.sameStream, 'el vídeo dejó de usar el mismo stream');
  assert(after.width === before.width && after.height === before.height, 'cambió la resolución: ' + JSON.stringify({ before, after }));
  assert(after.zoom === '1.5', 'el zoom visual no se aplicó: ' + after.zoom);
  assert(after.hardware === false, 'el zoom volvió a pedir zoom de hardware');
  console.log('preview-stable-ok', JSON.stringify({ before, after: { ...after, constraints: after.constraints.length } }));
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit').catch(() => {});
}
