#!/usr/bin/env node
/**
 * download_images.js
 * ==================
 * Descarga todas las imágenes de cartas a data/images/
 *
 * Uso:
 *   node download_images.js              -- descarga todo
 *   node download_images.js --set sv05   -- solo una expansión
 *   node download_images.js --resume     -- salta las ya descargadas
 *
 * Requisitos: Node 18+. No necesita npm install.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Ruta del proyecto ────────────────────────────────────────────────────────
// Busca data/index.json en este orden:
//   1. Junto al script (download_images.js y la app están juntos)
//   2. Ruta hardcodeada de tu instalación en Windows
//   3. Directorio actual desde donde se ejecuta el comando
const CANDIDATE_ROOTS = [
  path.dirname(process.argv[1]),   // carpeta del script
  path.join(process.cwd()),        // directorio actual
  // Ruta específica de tu máquina:
  'C:\\Users\\alexm\\Downloads\\album-pokemon-app_v11\\album-pokemon-app_escaner_manual_numero',
];

function findProjectRoot(){
  for(const dir of CANDIDATE_ROOTS){
    const check = path.join(dir, 'data', 'index.json');
    if(fs.existsSync(check)) return dir;
  }
  return null;
}

const ROOT = findProjectRoot();
if(!ROOT){
  console.error('\n❌ No encuentro data/index.json en ninguna ubicación conocida.');
  console.error('\n   Solución: copia download_images.js dentro de la carpeta de la app');
  console.error('   (la que contiene index.html y la carpeta data/)');
  console.error('\n   O edita la variable CANDIDATE_ROOTS al inicio del script');
  console.error('   y añade la ruta completa a tu carpeta del proyecto.\n');
  process.exit(1);
}

console.log(`📂 Proyecto: ${ROOT}`);

const INDEX_PATH  = path.join(ROOT, 'data', 'index.json');
const OUT_DIR     = path.join(ROOT, 'data', 'images');
const CONCURRENCY = 6;
const BATCH_PAUSE = 80;
const RETRY_MAX   = 3;
const RETRY_DELAY = 1500;

const HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Accept'         : 'image/webp,image/avif,image/*,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer'        : 'https://startling-pika-1dd305.netlify.app/',
};

// ── Parsear argumentos ───────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const resume  = args.includes('--resume');
const setFlag = args.indexOf('--set');
const onlySet = setFlag !== -1 ? args[setFlag + 1] : null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function showBar(done, total, errors){
  const pct = ((done/total)*100).toFixed(1).padStart(5);
  const b   = '█'.repeat(Math.floor(done/total*25)).padEnd(25, '░');
  process.stdout.write(`\r[${b}] ${pct}%  ${done}/${total}  errores:${errors}  `);
}

async function downloadOne(url, outPath, attempt = 1){
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if(buf.length < 200) throw new Error(`Respuesta vacía (${buf.length}B)`);
    fs.writeFileSync(outPath, buf);
    return { ok: true };
  } catch(e){
    if(attempt < RETRY_MAX){
      await sleep(RETRY_DELAY * attempt);
      return downloadOne(url, outPath, attempt + 1);
    }
    return { ok: false, err: e.message };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  console.log(`📋 Catálogo: ${index.length} cartas totales`);

  let cards = index.filter(c => c.image);
  console.log(`🖼️  Con imagen: ${cards.length}`);

  if(onlySet){
    cards = cards.filter(c => c.setId === onlySet);
    if(!cards.length){
      const sets = [...new Set(index.map(c => c.setId))].slice(0, 15).join(', ');
      console.error(`\n❌ Set "${onlySet}" no encontrado.`);
      console.error(`   Sets disponibles (muestra): ${sets}`);
      process.exit(1);
    }
    console.log(`🎯 Filtrando set "${onlySet}": ${cards.length} cartas`);
  }

  if(resume){
    const before = cards.length;
    cards = cards.filter(c => {
      const ext = (c.image.split('.').pop() || 'webp').split('?')[0];
      return !fs.existsSync(path.join(OUT_DIR, `${c.id}.${ext}`));
    });
    const skipped = before - cards.length;
    if(skipped > 0) console.log(`⏩ Resume: omitiendo ${skipped} ya descargadas`);
  }

  if(!cards.length){
    console.log('\n✅ Nada que descargar. Todas las imágenes ya están en disco.');
    return;
  }

  const estMB = Math.round(cards.length * 14 / 1024);
  console.log(`\n⬇️  Descargando ${cards.length} imágenes (~${estMB}MB estimado)`);
  console.log(`   Destino: ${OUT_DIR}`);
  console.log(`   Concurrencia: ${CONCURRENCY} simultáneas\n`);

  let done = 0, errors = 0;
  const failedIds = [];

  for(let i = 0; i < cards.length; i += CONCURRENCY){
    const batch = cards.slice(i, i + CONCURRENCY);

    await Promise.all(batch.map(async card => {
      const ext     = (card.image.split('.').pop() || 'webp').split('?')[0];
      const outPath = path.join(OUT_DIR, `${card.id}.${ext}`);
      const result  = await downloadOne(card.image, outPath);
      done++;
      if(!result.ok){
        errors++;
        failedIds.push(`${card.id}: ${result.err}`);
      }
      showBar(done, cards.length, errors);
    }));

    if(i + CONCURRENCY < cards.length) await sleep(BATCH_PAUSE);
  }

  // ── Resumen ──────────────────────────────────────────────────────────────
  let totalBytes = 0;
  try {
    for(const f of fs.readdirSync(OUT_DIR)){
      totalBytes += fs.statSync(path.join(OUT_DIR, f)).size;
    }
  } catch(e){}

  console.log(`\n\n✅ Completado`);
  console.log(`   Descargadas correctamente : ${done - errors}`);
  console.log(`   Errores                   : ${errors}`);
  console.log(`   Total en disco            : ${fs.readdirSync(OUT_DIR).length} archivos`);
  console.log(`   Tamaño total              : ${(totalBytes / 1024 / 1024).toFixed(1)}MB`);

  if(failedIds.length){
    const errPath = path.join(ROOT, 'download_errors.txt');
    fs.writeFileSync(errPath, failedIds.join('\n'), 'utf8');
    console.log(`\n⚠️  ${failedIds.length} errores guardados en: ${errPath}`);
    console.log(`   Reintenta con: node download_images.js --resume`);
  }

  console.log('\n🚀 Siguiente paso: node compute_hashes.js');
}

main().catch(e => {
  console.error('\n💥 Error inesperado:', e.message);
  process.exit(1);
});
