#!/usr/bin/env node
/**
 * compute_hashes.js
 * =================
 * Lee las imágenes descargadas por download_images.js y genera un índice de
 * hashes perceptuales (pHash DCT-64) en data/phash.json
 *
 * Uso:
 *   node compute_hashes.js               # procesa todo
 *   node compute_hashes.js --set sv05    # solo una expansión
 *   node compute_hashes.js --resume      # salta los ya hasheados
 *
 * Requisitos:
 *   npm install -g sharp      (para leer/redimensionar webp)
 *
 * Salida: data/phash.json
 *   { "A1-001": "a3f2e1b4c5d6e7f8", ... }
 *   Cada valor es un hex de 16 chars = 64 bits = pHash DCT estándar.
 *
 * Cómo funciona pHash DCT:
 *   1. Redimensionar imagen a 32×32 píxeles en escala de grises
 *   2. Aplicar Transformada Coseno Discreta (DCT) 2D
 *   3. Tomar la submatriz 8×8 superior-izquierda (las 64 frecuencias bajas)
 *   4. Comparar cada valor con la mediana: 1 si > mediana, 0 si ≤
 *   5. Los 64 bits resultantes son el hash
 *
 * Distancia de Hamming < 10 → misma carta (umbral empírico estándar)
 * Distancia < 20 → probablemente mismo Pokémon, variante diferente
 *
 * Una vez generado phash.json, la app puede:
 *   - Calcular el pHash del frame de cámara en canvas (JS puro, sin servidor)
 *   - Comparar contra todos los hashes del índice en <50ms
 *   - Mostrar las 3-5 cartas más similares visualmente
 */

const fs   = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch(e){
  console.error('❌ sharp no está instalado.');
  console.error('   Ejecuta: npm install -g sharp');
  process.exit(1);
}

// ── Configuración ────────────────────────────────────────────────────────────

const CANDIDATE_ROOTS = [
  path.dirname(process.argv[1]),
  process.cwd(),
  'C:\\Users\\alexm\\Downloads\\album-pokemon-app_v11\\album-pokemon-app_escaner_manual_numero',
];
function findProjectRoot(){
  for(const dir of CANDIDATE_ROOTS){
    if(require('fs').existsSync(require('path').join(dir,'data','index.json'))) return dir;
  }
  return null;
}
const ROOT = findProjectRoot();
if(!ROOT){
  console.error('\n❌ No encuentro data/index.json. Copia el script dentro de la carpeta del proyecto.');
  process.exit(1);
}
console.log(`📂 Proyecto: ${ROOT}`);
const INDEX_PATH  = path.join(ROOT, 'data', 'index.json');
const IMAGES_DIR  = path.join(ROOT, 'data', 'images');
const OUT_PATH    = path.join(ROOT, 'data', 'phash.json');
const HASH_SIZE   = 8;   // 8×8 DCT → 64 bits
const DCT_SIZE    = 32;  // redimensionar a 32×32 antes del DCT
const CONCURRENCY = 8;   // imágenes paralelas (sharp es muy rápido)

// ── Parsear argumentos ───────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const resume  = args.includes('--resume');
const setFlag = args.indexOf('--set');
const onlySet = setFlag !== -1 ? args[setFlag + 1] : null;

// ── Algoritmo pHash DCT ───────────────────────────────────────────────────────

/**
 * DCT-II 1D sobre un array de N valores.
 * Devuelve array de N coeficientes.
 */
function dct1d(signal){
  const N   = signal.length;
  const out = new Float64Array(N);
  const pi  = Math.PI;
  for(let k = 0; k < N; k++){
    let sum = 0;
    for(let n = 0; n < N; n++){
      sum += signal[n] * Math.cos(pi * k * (2*n + 1) / (2*N));
    }
    out[k] = sum;
  }
  return out;
}

/**
 * DCT-II 2D separable: aplica DCT 1D por filas, luego por columnas.
 * input: Float64Array de N×N valores en row-major
 * Devuelve Float64Array de N×N coeficientes DCT
 */
function dct2d(input, N){
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);

  // Filas
  for(let r = 0; r < N; r++){
    const row = input.slice(r * N, (r + 1) * N);
    const d   = dct1d(row);
    for(let c = 0; c < N; c++) tmp[r * N + c] = d[c];
  }

  // Columnas
  for(let c = 0; c < N; c++){
    const col = new Float64Array(N);
    for(let r = 0; r < N; r++) col[r] = tmp[r * N + c];
    const d = dct1d(col);
    for(let r = 0; r < N; r++) out[r * N + c] = d[r];
  }

  return out;
}

/**
 * Calcula el pHash DCT-64 de un buffer de imagen.
 * @param {Buffer} imgBuf  Buffer de la imagen (cualquier formato soportado por sharp)
 * @returns {Promise<string>}  Hash hex de 16 chars (64 bits)
 */
async function pHash(imgBuf){
  // 1. Redimensionar a DCT_SIZE × DCT_SIZE en escala de grises
  const raw = await sharp(imgBuf)
    .resize(DCT_SIZE, DCT_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  // 2. Convertir a Float64 normalizado 0-255
  const pixels = new Float64Array(DCT_SIZE * DCT_SIZE);
  for(let i = 0; i < raw.length; i++) pixels[i] = raw[i];

  // 3. DCT 2D
  const dct = dct2d(pixels, DCT_SIZE);

  // 4. Tomar bloque 8×8 superior-izquierdo (excluyendo [0,0] = DC component)
  const block = new Float64Array(HASH_SIZE * HASH_SIZE);
  for(let r = 0; r < HASH_SIZE; r++){
    for(let c = 0; c < HASH_SIZE; c++){
      block[r * HASH_SIZE + c] = dct[r * DCT_SIZE + c];
    }
  }
  // Excluir el componente DC (índice 0,0) del cálculo de mediana
  const blockNodc = block.slice(1);

  // 5. Mediana del bloque (sin DC)
  const sorted  = Float64Array.from(blockNodc).sort();
  const mid     = Math.floor(sorted.length / 2);
  const median  = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  // 6. Binarizar: 1 si > mediana, 0 si ≤
  //    Producir 64 bits como BigInt → hex de 16 chars
  let hash = 0n;
  for(let i = 0; i < 64; i++){
    if(block[i] > median) hash |= (1n << BigInt(63 - i));
  }

  return hash.toString(16).padStart(16, '0');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function progress(done, total, errors){
  const pct = ((done / total) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(done/total*30)).padEnd(30,'░');
  process.stdout.write(`\r[${bar}] ${pct}% ${done}/${total}  errores:${errors}  `);
}

function hammingDistance(a, b){
  // Calcula la distancia de Hamming entre dos hashes hex de 16 chars
  const ai = BigInt('0x' + a);
  const bi = BigInt('0x' + b);
  let x = ai ^ bi;
  let dist = 0;
  while(x){ dist += Number(x & 1n); x >>= 1n; }
  return dist;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(){
  // Verificar carpeta de imágenes
  if(!fs.existsSync(IMAGES_DIR)){
    console.error(`❌ No existe la carpeta de imágenes: ${IMAGES_DIR}`);
    console.error(`   Ejecuta primero: node download_images.js`);
    process.exit(1);
  }

  // Cargar catálogo
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));

  // Cargar hashes existentes (para resume)
  let existing = {};
  if(resume && fs.existsSync(OUT_PATH)){
    existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    console.log(`⏩ Resume: ${Object.keys(existing).length} hashes ya calculados`);
  }

  // Construir lista de trabajos: [{ id, imgPath }]
  const files = new Set(fs.readdirSync(IMAGES_DIR));
  let jobs = index
    .filter(c => {
      if(!c.image) return false;
      if(onlySet && c.setId !== onlySet) return false;
      if(resume && existing[c.id]) return false;
      // Buscar el archivo descargado (puede ser .webp, .jpg, .png...)
      const ext = (c.image.split('.').pop() || 'webp').split('?')[0];
      return files.has(`${c.id}.${ext}`);
    })
    .map(c => {
      const ext = (c.image.split('.').pop() || 'webp').split('?')[0];
      return { id: c.id, imgPath: path.join(IMAGES_DIR, `${c.id}.${ext}`) };
    });

  if(!jobs.length){
    if(Object.keys(existing).length > 0){
      console.log('✅ Todos los hashes ya están calculados.');
      console.log(`   ${OUT_PATH}`);
    } else {
      console.log('⚠️  No hay imágenes que procesar.');
      console.log('   Ejecuta primero: node download_images.js');
    }
    return;
  }

  if(onlySet) console.log(`🎯 Solo set "${onlySet}": ${jobs.length} imágenes`);
  console.log(`\n🔢 Calculando pHash de ${jobs.length} imágenes...`);
  console.log(`   DCT: ${DCT_SIZE}×${DCT_SIZE} → bloque ${HASH_SIZE}×${HASH_SIZE} = 64 bits\n`);

  const hashes = { ...existing };
  let done = 0, errors = 0;
  const errorLog = [];

  // Procesar en lotes paralelos
  for(let i = 0; i < jobs.length; i += CONCURRENCY){
    const batch = jobs.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ({ id, imgPath }) => {
      try {
        const buf  = fs.readFileSync(imgPath);
        const hash = await pHash(buf);
        hashes[id] = hash;
      } catch(err){
        errors++;
        errorLog.push(`${id}: ${err.message}`);
      }
      done++;
      progress(done, jobs.length, errors);
    }));

    // Guardar progreso cada 500 cartas por si se interrumpe
    if((i + CONCURRENCY) % 500 === 0 || i + CONCURRENCY >= jobs.length){
      fs.writeFileSync(OUT_PATH, JSON.stringify(hashes, null, 0));
    }
  }

  // Guardar resultado final
  fs.writeFileSync(OUT_PATH, JSON.stringify(hashes, null, 0));

  console.log(`\n\n✅ Completado: ${done - errors} hashes OK, ${errors} errores`);
  console.log(`📄 Índice guardado: ${OUT_PATH}`);
  console.log(`   Tamaño: ${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)}KB`);
  console.log(`   Total hashes: ${Object.keys(hashes).length}`);

  if(errorLog.length){
    const errFile = path.join(__dirname, 'hash_errors.txt');
    fs.writeFileSync(errFile, errorLog.join('\n'));
    console.log(`⚠️  Errores: ${errFile}`);
  }

  // ── Test de distancias: verificar que el hash tiene calidad suficiente ──────
  console.log('\n🧪 Test de calidad del índice (muestra):');
  const ids    = Object.keys(hashes);
  const sample = ids.slice(0, Math.min(5, ids.length));
  for(const id of sample){
    // Buscar las 3 cartas más similares
    let nearest = [];
    for(const id2 of ids){
      if(id2 === id) continue;
      const d = hammingDistance(hashes[id], hashes[id2]);
      nearest.push({ id: id2, d });
    }
    nearest.sort((a,b) => a.d - b.d);
    const top3 = nearest.slice(0,3).map(x => `${x.id}(d=${x.d})`).join(' ');
    const card = index.find(c => c.id === id);
    console.log(`  ${id} [${card?.name}] → más similares: ${top3}`);
  }
  console.log('\n💡 Distancia < 10 = misma carta. Distancia < 20 = misma especie.');
}

main().catch(e => { console.error('\n💥 Error fatal:', e.message); process.exit(1); });
