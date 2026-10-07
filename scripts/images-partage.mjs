// Les images d'aperçu (WhatsApp, Messages…) et les icônes de l'appli.
//
//   partage/<id>.jpg   1200 × 630, une par recette : son titre de sa main (ou en
//                      caractères pour une fiche imprimée), et son portrait sur
//                      l'orange, comme la première page du livre
//   partage/livre.jpg  l'aperçu de l'accueil
//   icones/*.png       l'icône de l'écran d'accueil du téléphone
//
// Lancer avec le serveur local démarré (il fournit les recettes, les titres et
// le portrait) :
//   LIVRE=http://localhost:3079 node scripts/images-partage.mjs
// playwright-core est pris dans PLAYWRIGHT_DIR (par défaut le node_modules de
// ~/automation-mapper) : pas de dépendance ajoutée au site pour un outil hors ligne.
// À relancer après l'ajout d'une recette, ou d'un titre manuscrit.

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVRE = process.env.LIVRE || 'http://localhost:3079';
const require = createRequire(join(process.env.PLAYWRIGHT_DIR || join(homedir(), 'automation-mapper'), 'node_modules/'));
const { chromium } = require('playwright-core');

const CHAPITRES = { 1: 'Les entrées', 2: 'Les plats', 3: 'Les poissons', 4: 'Les desserts', 5: 'Le gibier', 6: 'Les légumes' };
const echapper = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
  <base href="${LIVRE}/">
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700;9..144,800&family=Archivo:wght@600&display=block" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; overflow: hidden; background: #fff; color: #161616;
      display: grid; grid-template-columns: 1fr 400px; box-shadow: inset 16px 0 0 #F1591E; }
    .texte { display: flex; flex-direction: column; justify-content: center; gap: 34px; padding: 56px 56px 56px 84px; min-width: 0; }
    .sur { font: 600 20px/1 Archivo, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #555; }
    .main { display: block; max-width: 100%; }
    .tape { font: 800 64px/1.05 Fraunces, serif; letter-spacing: -.01em; text-wrap: balance; }
    .grand { font: 800 84px/1 Fraunces, serif; letter-spacing: -.02em; }
    .chapeau { font: 700 26px/1.4 Fraunces, serif; max-width: 34ch; }
    .orange { background: #F1591E; display: grid; place-items: center; }
    .orange img { width: 270px; height: auto; background: #fff; padding: 10px 10px 34px; transform: rotate(-2.5deg);
      box-shadow: 0 22px 34px -16px rgba(60,20,0,.6), 0 2px 5px rgba(60,20,0,.25); }
    .icone { width: 100vw; height: 100vh; background: #F1591E; display: grid; place-items: center; box-shadow: none; }
    .icone span { font: 800 calc(var(--t) * 1px)/1 Fraunces, serif; color: #fff; transform: translateY(-3%); }
  </style>`;

const portrait = `<div class="orange"><img src="photos/manou.jpg" alt=""></div>`;

function carteRecette(r, dim) {
  let titre;
  if (dim) {
    const [w, h, hx] = dim;
    // Au-delà de 1,6 fois sa taille, un petit titre découpé devient pixelisé :
    // mieux vaut un titre un peu plus petit et net.
    const s = Math.min(50 / hx, 660 / w, 330 / h, 1.6);
    titre = `<img class="main" src="titres/${r.id}.png?v=${dim[4]}" style="width:${Math.round(w * s)}px;height:${Math.round(h * s)}px" alt="">`;
  } else {
    titre = `<h1 class="tape">${echapper(r.title)}</h1>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLE}</head><body>
    <div class="texte"><p class="sur">Les recettes de Manou · ${echapper(CHAPITRES[r.category_id] || '')}</p>${titre}</div>
    ${portrait}</body></html>`;
}

function carteLivre(n, nMain) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLE}</head><body>
    <div class="texte"><p class="sur">Le livre de famille</p><h1 class="grand">Les recettes de Manou</h1>
    <p class="chapeau">${n} recettes, dont ${nMain} écrites de sa main.</p></div>
    ${portrait}</body></html>`;
}

// L'icône : un M blanc sur l'orange. La version « masque » garde la lettre dans
// la zone sûre (80 % du centre), que le téléphone peut rogner en rond.
const icone = (taille, part) => `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLE}
  <style>body{width:${taille}px;height:${taille}px;display:block}</style></head>
  <body class="icone" style="--t:${Math.round(taille * part)}"><span>M</span></body></html>`;

const navigateur = await chromium.launch({ channel: 'chrome' });
const page = await navigateur.newPage({ viewport: { width: 1200, height: 630 } });

async function photographier(html, fichier, l = 1200, h = 630, type = 'jpeg') {
  await page.setViewportSize({ width: l, height: h });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(ROOT, fichier), type, ...(type === 'jpeg' ? { quality: 86 } : {}) });
}

// Les recettes et les titres, lus comme le livre les lit.
await page.goto(LIVRE + '/', { waitUntil: 'networkidle' });
const { recettes, titres } = await page.evaluate(() => ({ recettes: etat.recettes, titres: window.TITRES_MANUSCRITS }));
if (!recettes?.length) throw new Error('Aucune recette lue : le serveur local a-t-il ses clés ?');

await mkdir(join(ROOT, 'partage'), { recursive: true });
await mkdir(join(ROOT, 'icones'), { recursive: true });
for (const r of recettes) await photographier(carteRecette(r, titres[r.id]), `partage/${r.id}.jpg`);
await photographier(carteLivre(recettes.length, recettes.filter(r => titres[r.id]).length), 'partage/livre.jpg');

for (const [fichier, taille, part] of [
  ['icones/icone-192.png', 192, .62], ['icones/icone-512.png', 512, .62],
  ['icones/icone-masque-512.png', 512, .46], ['icones/apple-touch-icon.png', 180, .62], ['icones/favicon-64.png', 64, .78],
]) await photographier(icone(taille, part), fichier, taille, taille, 'png');

await navigateur.close();
console.log(`${recettes.length} aperçus de recettes, l'aperçu du livre et 5 icônes.`);
