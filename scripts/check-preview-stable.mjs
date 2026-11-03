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
    const settings = { width: 1280, height: 720, zoom: 1, focusMode: 'continuous' };
    track.applyConstraints = (constraints) => {
      window.__constraintCalls.push(constraints);
      const requested = constraints && constraints.advanced && constraints.advanced[0] && constraints.advanced[0].zoom;
      const direct = constraints && constraints.zoom;
      if (requested != null) settings.zoom = requested;
      else if (direct != null) settings.zoom = direct;
      return Promise.resolve();
    };
    track.getCapabilities = () => ({
      zoom: { min: 1, max: 8, step: 0.1 },
      focusMode: ['manual', 'continuous'],
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
    });
    track.getSettings = () => ({ ...settings });
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.__gumCalls += 1;
      window.__gumConstraints = constraints;
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
    const box = window.__preview.getBoundingClientRect();
    const css = getComputedStyle(window.__preview);
    return {
      width: window.__preview.videoWidth,
      height: window.__preview.videoHeight,
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      fit: css.objectFit,
      transform: css.transform,
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
    const box = video.getBoundingClientRect();
    const css = getComputedStyle(video);
    return {
      sameNode: video === window.__preview,
      sameStream: video.srcObject === window.__stream,
      width: video.videoWidth,
      height: video.videoHeight,
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      fit: css.objectFit,
      transform: css.transform,
      inlineZoom: video.style.getPropertyValue('--camera-display-zoom'),
      layerZoom: document.getElementById('previewZoom').style.getPropertyValue('--camera-display-zoom'),
      layerTransform: getComputedStyle(document.getElementById('previewZoom')).transform,
      hardware: state.scan.hardwareZoom,
      constraints: window.__constraintCalls,
      gum: window.__gumCalls,
      open: window.__gumConstraints,
    };
  });

  assert(after.gum === 1, 'la cámara se abrió más de una vez: ' + after.gum);
  assert(after.open && after.open.video && after.open.video.width && after.open.video.width.ideal === 3840 && after.open.video.height.ideal === 2160, 'la apertura no pidió 3840×2160: ' + JSON.stringify(after.open));
  assert(after.constraints[0].width.exact === 1920 && after.constraints[0].height.exact === 1080, 'no se pidió el máximo del track: ' + JSON.stringify(after.constraints[0]));
  assert(!after.constraints[0].advanced, 'la resolución no debe mezclarse con el zoom');
  assert(after.constraints[1] && after.constraints[1].advanced[0].zoom === 3, 'el zoom de apertura no acerca: ' + JSON.stringify(after.constraints[1]));
  const zoomCalls = after.constraints.slice(1);
  assert(zoomCalls.every((call) => !call.width && !call.height && call.advanced && call.advanced[0].zoom), 'el deslizador cambió la resolución: ' + JSON.stringify(zoomCalls));
  assert(zoomCalls.some((call) => call.advanced[0].zoom === 2) && zoomCalls.some((call) => call.advanced[0].zoom === 1.5), 'el deslizador no movió el zoom del track: ' + JSON.stringify(zoomCalls));
  assert(after.sameNode, 'Ajustar zona sustituyó el elemento de vídeo');
  assert(after.sameStream, 'el vídeo dejó de usar el mismo stream');
  assert(after.width === before.width && after.height === before.height, 'cambió la resolución: ' + JSON.stringify({ before, after }));
  assert(after.fit === before.fit && after.fit === 'cover', 'cambió object-fit: ' + after.fit);
  assert(after.transform === 'none' && before.transform === 'none', 'el vídeo sigue teniendo transform: ' + after.transform);
  assert(after.inlineZoom === '', 'el zoom volvió a escribir estilo en el vídeo');
  assert(after.hardware === true, 'no usó el zoom del track');
  assert(after.layerZoom === '1', 'el marco se escaló además del zoom del track: ' + after.layerZoom);
  await page.click('#resetZoomBtn');
  const resetZoom = await page.evaluate(() => window.__constraintCalls.at(-1).advanced[0].zoom);
  assert(resetZoom === 3, 'restablecer no volvió al acercamiento inicial: ' + resetZoom);

  const plain = await browser.newPage();
  await plain.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await plain.waitForSelector('#startLiveBtn', { timeout: 15000 });
  await plain.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    canvas.getContext('2d').fillRect(0, 0, 640, 480);
    const stream = canvas.captureStream(8);
    const track = stream.getVideoTracks()[0];
    window.__constraintCalls = [];
    track.applyConstraints = (constraints) => {
      window.__constraintCalls.push(constraints);
      return Promise.resolve();
    };
    track.getCapabilities = () => ({ width: { max: 1280 }, height: { max: 720 } });
    navigator.mediaDevices.getUserMedia = async () => stream;
    ensureOcrWorker = async () => ({});
  });
  await plain.click('#startLiveBtn');
  await plain.waitForFunction(() => document.getElementById('previewZoom'), { timeout: 10000 });
  await plain.evaluate(() => applyCameraZoom(4));
  const fallback = await plain.evaluate(() => ({
    scale: document.getElementById('previewZoom').style.getPropertyValue('--camera-display-zoom'),
    transform: getComputedStyle(document.getElementById('previewZoom')).transform,
    videoTransform: getComputedStyle(document.getElementById('liveVideo')).transform,
    hardware: state.scan.hardwareZoom,
    calls: window.__constraintCalls,
  }));
  assert(fallback.hardware === false, 'usó zoom de hardware sin capacidad');
  assert(fallback.scale === '4', 'el deslizador no actualizó la escala: ' + fallback.scale);
  assert(fallback.transform.includes('4'), 'la escala no se aplicó al marco: ' + fallback.transform);
  assert(fallback.videoTransform === 'none', 'se escaló el elemento de vídeo');
  assert(fallback.calls.every((call) => !call.advanced), 'sin zoom de track no debe pedir zoom: ' + JSON.stringify(fallback.calls));
  console.log('preview-stable-ok', JSON.stringify({ openZoom: 3, slider: zoomCalls.map((call) => call.advanced[0].zoom), fallback: fallback.scale }));
} finally {
  await browser.close();
  server.kill();
  await once(server, 'exit').catch(() => {});
}
