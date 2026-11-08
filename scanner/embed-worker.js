/* Un solo hilo: Safari no admite workers anidados y se queda colgado si ONNX los pide. */
self.importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js');

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

let session = null;

async function openSession(modelUrl) {
  try {
    return await ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  } catch (err) {
    ort.env.wasm.simd = false;
    return ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] });
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    try {
      session = await openSession(msg.modelUrl);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }
  if (msg.type === 'run') {
    try {
      const tensor = new ort.Tensor('float32', msg.data, [1, 3, 224, 224]);
      const out = await session.run({ pixel_values: tensor });
      const data = out.embedding.data;
      self.postMessage({ type: 'emb', data }, [data.buffer]);
    } catch (err) {
      self.postMessage({ type: 'run-error', message: String(err && err.message || err) });
    }
  }
};
