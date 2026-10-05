// Le livre de Manou, nouvelle version « façon Whoogy's ».
//
// Deux écrans, rien de plus :
//   #/                    le mur de ses titres, par chapitre
//   #/recette/<slug>      une recette en double page : à gauche le texte, à
//                         droite sa feuille posée sur l'orange
//
// Mêmes données que l'ancienne version (lecture publique Supabase, aucune
// écriture). Les titres manuscrits sont des découpes de ses feuilles, dans
// titres/<id>.png ; titres-manifeste.js dit lesquelles existent.

const URL_SB = window.APP_CONFIG?.supabaseUrl || '';
const KEY_SB = window.APP_CONFIG?.supabaseKey || '';
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
const TITRES = window.TITRES_MANUSCRITS || {};

// Les noms affichés des chapitres. La table recipe_categories garde l'ordre ;
// les libellés sont réécrits ici parce que le livre parle « des plats », pas
// d'une catégorie « Plats ».
const NOMS_CHAPITRES = {
  1: 'Les entrées', 2: 'Les plats', 3: 'Les poissons',
  4: 'Les desserts', 5: 'Le gibier', 6: 'Les légumes',
};

// Lus par contribuer.js (le menu des chapitres de l'aperçu à relire).
let CATS = {}, CAT_EMOJI = {};

const etat = { recettes: [], chapitres: [], ingredientsParRecette: new Map(), recherche: '' };
const cache = {};

async function sb(chemin) {
  if (cache[chemin]) return cache[chemin];
  const r = await fetch(`${URL_SB}/rest/v1/${chemin}`, {
    headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}` },
  });
  if (!r.ok) throw new Error(`Erreur réseau : ${r.status}`);
  cache[chemin] = await r.json();
  return cache[chemin];
}

function echapper(t) {
  return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function duree(min) {
  if (!min) return null;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// Pour la recherche : sans accents ni majuscules, « creme » trouve « Crème ».
function plier(t) {
  return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function titreHTML(r, classe) {
  const dim = TITRES[r.id];
  if (!dim) return `<span class="titre-tape ${classe}-tape">${echapper(r.title)}</span>`;
  // Tous les titres à la même taille de lettres et posés sur la même ligne
  // d'écriture : --k = hauteur de l'image en hauteurs d'x, --d = ce qui dépasse
  // sous la ligne d'écriture (jambages, soulignement). Mesuré par
  // scripts/mesurer-titres.py. Le plafond évite qu'une mesure ratée fasse
  // exploser un titre.
  const [w, h, hx, base, v] = dim;
  const k = Math.min(h / hx, 9), d = Math.min((h - base) / hx, 4);
  return `<img class="titre-main ${classe}" src="titres/${r.id}.png?v=${v}" width="${w}" height="${h}"
    style="--k:${k.toFixed(3)};--d:${d.toFixed(3)}" alt="${echapper(r.title)}" decoding="async">`;
}

// ── CHARGEMENT ───────────────────────────────────────────────────────────────

async function chargerLivre() {
  const [recettes, chapitres, ingr] = await Promise.all([
    sb('recipes?select=id,slug,title,category_id,description,servings,servings_unit,prep_time_minutes,cook_time_minutes,rest_time_minutes,difficulty,notes,groups_are_variants,hand,author,attribution&order=title'),
    sb('recipe_categories?select=id,name,emoji,display_order&order=display_order,id').catch(() => []),
    sb('recipe_ingredients?select=recipe_id,ingredients(name)').catch(() => []),
  ]);
  etat.recettes = recettes;
  etat.ingredientsParRecette = new Map();   // rechargé après une publication
  for (const c of chapitres) { CATS[c.id] = c.name; CAT_EMOJI[c.id] = c.emoji || ''; }
  etat.chapitres = chapitres.length
    ? chapitres
    : [...new Set(recettes.map(r => r.category_id))].map(id => ({ id }));
  for (const l of ingr) {
    const n = l.ingredients?.name;
    if (!n) continue;
    if (!etat.ingredientsParRecette.has(l.recipe_id)) etat.ingredientsParRecette.set(l.recipe_id, []);
    etat.ingredientsParRecette.get(l.recipe_id).push(n);
  }
}

// ── LE MUR ───────────────────────────────────────────────────────────────────

function correspond(r, q) {
  if (!q) return true;
  const foin = plier([r.title, ...(etat.ingredientsParRecette.get(r.id) || [])].join(' '));
  return plier(q).split(/\s+/).every(m => foin.includes(m));
}

function dessinerMur() {
  const q = etat.recherche;
  const blocs = etat.chapitres.map(c => {
    const toutes = etat.recettes.filter(r => r.category_id === c.id);
    const vues = toutes.filter(r => correspond(r, q));
    if (!vues.length) return '';
    // Ses titres d'abord, les fiches imprimées ensuite : sur le mur, c'est elle
    // qu'on voit en premier.
    // L'index d'un livre : un titre par ligne, points de conduite, numéro de la
    // recette dans le chapitre. Ses titres d'abord ; les fiches imprimées, qui
    // n'ont pas de titre de sa main, suivent en caractères.
    const ordre = [...vues.filter(r => TITRES[r.id]), ...vues.filter(r => !TITRES[r.id])];
    const numero = r => String(toutes.indexOf(r) + 1).padStart(2, '0');
    const nom = NOMS_CHAPITRES[c.id] || c.name || 'Autres';
    return `
      <section class="chapitre" aria-labelledby="chap-${c.id}">
        <div class="chapitre-tete">
          <h2 id="chap-${c.id}">${echapper(nom)}</h2>
          <span class="pastille">${q ? `${vues.length} sur ${toutes.length}` : `${toutes.length} recettes`}</span>
        </div>
        <ol class="index" role="list">
          ${ordre.map(r => `<li><a class="index-ligne${TITRES[r.id] ? '' : ' index-ligne--tape'}" href="#/recette/${encodeURIComponent(r.slug)}">
            ${TITRES[r.id] ? titreHTML(r, 'mur-img') : `<span class="index-tape">${echapper(r.title)}</span>`}
            <span class="index-points" aria-hidden="true"></span>
            <span class="index-num">${numero(r)}</span></a></li>`).join('')}
        </ol>
      </section>`;
  }).join('');
  return blocs || `<p class="vide">Aucune recette ne contient « ${echapper(q)} ». Essaie un ingrédient, par exemple « chocolat ».</p>`;
}

function afficherAccueil() {
  const nbMain = etat.recettes.filter(r => TITRES[r.id]).length;
  document.title = 'Les recettes de Manou';
  main().innerHTML = `
    <div class="accueil">
      <header class="accueil-tete">
        <p class="sur-titre">Le livre de famille</p>
        <h1 class="accueil-titre">Les recettes de Manou</h1>
        <p class="accueil-chapeau">${etat.recettes.length} recettes, dont ${nbMain} écrites de sa main. Chaque titre ouvre sa recette, avec sa feuille à côté.</p>
        <label class="recherche">
          <span class="sr-only">Chercher une recette ou un ingrédient</span>
          <input type="search" id="recherche" placeholder="Chercher une recette, un ingrédient…" value="${echapper(etat.recherche)}" autocomplete="off">
        </label>
      </header>
      <div class="mur" id="mur">${dessinerMur()}</div>
    </div>`;
  const champ = document.getElementById('recherche');
  champ.addEventListener('input', () => {
    etat.recherche = champ.value.trim();
    document.getElementById('mur').innerHTML = dessinerMur();
  });
}

// ── UNE RECETTE ──────────────────────────────────────────────────────────────

// Une quantité mise à l'échelle des portions : jamais « 0,33333 » dans un livre.
// Ce qui se compte à l'unité ne se coupe pas : 1,3 pincée ou 2,7 œufs n'existent
// pas en cuisine. On arrondit à l'entier, jamais en dessous d'un.
const UNITES_ENTIERES = /^(pi[eè]ces?|pinc[ée]es?|gousses?|tranches?|feuilles?|branches?|brins?|sachets?|bottes?|bouquets?|bo[iî]tes?|pots?|c\.?\s?[àa]\s?[sc]\.?|cuill[eè]res?.*)$/i;
// « pièce » n'apporte rien à l'écrit : « 4 œufs », pas « 4 pièce œuf ».
const UNITES_MUETTES = /^pi[eè]ces?$/i;

function formaterQte(n, unite = '') {
  if (!isFinite(n)) return '';
  if (UNITES_ENTIERES.test(unite.trim())) return String(Math.max(1, Math.round(n)));
  const arrondi = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(arrondi).replace('.', ',');
}

function ligneIngredient(i) {
  // Une unité seule (« g », « ml ») ne dit rien : beaucoup de ses recettes n'ont
  // pas de quantité, et l'import a quand même rempli l'unité. On ne l'affiche
  // qu'accompagnée d'un nombre.
  const aQte = i.quantity !== null && i.quantity !== '';
  const nombre = aQte && !isNaN(parseFloat(i.quantity)) ? parseFloat(i.quantity) : null;
  const unite = i.unit && !UNITES_MUETTES.test(i.unit.trim()) ? `\u202f${echapper(i.unit)}` : '';
  const qte = !aQte ? ''
    : nombre !== null ? `<span class="qte" data-base="${nombre}" data-unite="${echapper(i.unit || '')}"><span class="qte-n">${formaterQte(nombre, i.unit || '')}</span>${unite}</span> `
    : `<span class="qte">${echapper(i.quantity)}${unite}</span> `;
  return `<li><label class="ingr"><input type="checkbox" class="ingr-coche"><span>${qte}${echapper(i.ingredients?.name || '')}${i.preparation ? `<span class="prep">, ${echapper(i.preparation)}</span>` : ''}${i.is_optional ? ' <span class="prep">(facultatif)</span>' : ''}</span></label></li>`;
}

// Deux sens pour les groupes, comme dans l'ancienne version : les PARTIES d'un
// même plat (Marinade, Cuisson…), ou des VARIANTES dont on n'en cuisine qu'une.
function blocIngredients(ingrs, variantes) {
  const groupes = [];
  for (const i of ingrs) {
    const g = i.group_label || '';
    let gr = groupes.find(x => x.nom === g);
    if (!gr) groupes.push(gr = { nom: g, lignes: [] });
    gr.lignes.push(i);
  }
  return groupes.map((g, n) => `
    ${variantes && n > 0 ? '<p class="ou">ou</p>' : ''}
    ${g.nom && groupes.length > 1 ? `<span class="boite">${variantes ? 'Variante · ' : ''}${echapper(g.nom)}</span>` : ''}
    <ul class="ingredients">${g.lignes.map(ligneIngredient).join('')}</ul>`).join('');
}

function blocEtapes(etapes) {
  return etapes.map(s => {
    const reperes = [duree(s.duration_minutes), s.temperature_celsius ? `${s.temperature_celsius} °C` : null].filter(Boolean);
    return `<section class="etape">
      <h3>${echapper(s.title || `Étape ${s.step_number}`)}${reperes.length ? ` <span class="repere">${reperes.join(' · ')}</span>` : ''}</h3>
      <p>${echapper(s.description)}</p>
    </section>`;
  }).join('');
}

// Qui l'a apportée et d'où elle vient. « source » n'est qu'un type (famille,
// presse…), on ne l'affiche pas ; hand, author et attribution sont des noms.
function provenance(r) {
  const nom = (r.hand || r.author || '').trim();
  const morceaux = [];
  if (nom) morceaux.push(r.hand ? (/^[aeiouyàâéèêîôû]/i.test(nom) ? `de la main d'${nom}` : `de la main de ${nom}`) : `recette ${/^[aeiouyàâéèêîôû]/i.test(nom) ? "d'" : 'de '}${nom}`);
  if ((r.attribution || '').trim()) morceaux.push(`d'après ${r.attribution.trim()}`);
  return morceaux.join(' · ');
}

function pastilles(r) {
  const p = [];
  const prep = duree(r.prep_time_minutes), cuis = duree(r.cook_time_minutes), repos = duree(r.rest_time_minutes);
  if (prep) p.push(`préparation ${prep}`);
  if (cuis) p.push(`cuisson ${cuis}`);
  if (repos) p.push(`repos ${repos}`);
  if (r.difficulty) p.push(r.difficulty);
  const portions = r.servings ? `
    <span class="portions" role="group" aria-label="Nombre de portions">
      <button class="portions-btn" data-pas="-1" aria-label="Une portion de moins">−</button>
      <span class="pastille portions-n" aria-live="polite"><span id="nbPortions">${r.servings}</span> ${echapper(r.servings_unit || 'pers.')}</span>
      <button class="portions-btn" data-pas="1" aria-label="Une portion de plus">+</button>
    </span>` : '';
  return portions + p.map(t => `<span class="note-chiffre">${echapper(t)}</span>`).join('');
}

function blocPhotos(r, photos) {
  const moi = typeof currentUser !== 'undefined' ? currentUser : null;
  const peut = typeof isApproved === 'function' && isApproved();
  const action = peut
    ? `<label class="photo-ajout"><input type="file" accept="image/*" id="photoPlat" hidden>J'ai refait ce plat : ajouter ma photo</label>`
    : moi ? `<p class="photo-aide">Ton accès doit être validé avant d'ajouter une photo.</p>`
    : `<button class="photo-ajout" onclick="signIn()">Tu l'as refait ? Connecte-toi pour ajouter ta photo</button>`;
  return `
    <section class="photos-plat" aria-labelledby="titrePhotos">
      <h2 class="col-titre" id="titrePhotos">${photos.length ? 'Refaite par la famille' : 'Personne ne l\'a encore photographiée'}</h2>
      ${photos.length ? `<ul class="photos-grille" role="list">${photos.map(ph => `
        <li><figure>
          <img src="${echapper(ph.public_url)}" alt="${echapper(ph.caption || 'Le plat refait')}" loading="lazy">
          <figcaption>${echapper(ph.caption || '')}${moi && ph.uploaded_by === moi.id ? ` <button class="photo-retirer" data-id="${ph.id}" data-chemin="${echapper(ph.object_path)}">Retirer</button>` : ''}</figcaption>
        </figure></li>`).join('')}</ul>` : ''}
      ${action}
      <p class="photo-message" id="photoMessage" aria-live="polite"></p>
    </section>`;
}

async function afficherRecette(slug) {
  const i = etat.recettes.findIndex(r => r.slug === slug);
  if (i < 0) { main().innerHTML = `<p class="vide">Cette recette n'existe pas, ou plus. <a href="#/">Retour à toutes les recettes</a></p>`; return; }
  const r = etat.recettes[i];
  document.title = `${r.title} · Les recettes de Manou`;
  main().innerHTML = `<p class="chargement">Chargement…</p>`;

  const cleDocs = `recipe_document_links?select=display_order,page_label,recipe_documents(id,kind,public_url,caption,uploaded_by,object_path)&recipe_id=eq.${r.id}&order=display_order`;
  const [ingrs, etapes, docs] = await Promise.all([
    sb(`recipe_ingredients?select=*,ingredients(name)&recipe_id=eq.${r.id}&order=display_order`).catch(() => []),
    sb(`recipe_steps?select=*&recipe_id=eq.${r.id}&order=step_number`).catch(() => []),
    sb(cleDocs).catch(() => []),
  ]);
  const feuilles = docs.map(d => d.recipe_documents).filter(d => d?.kind === 'manuscript' && /\.pdf$/i.test(d.public_url));
  const photos = docs.map(d => d.recipe_documents).filter(d => d?.kind === 'dish_photo');
  const variantes = !!r.groups_are_variants;

  // Précédente / suivante dans le même chapitre, comme quand on feuillette.
  const memeChap = etat.recettes.filter(x => x.category_id === r.category_id);
  const k = memeChap.indexOf(r);
  const prec = memeChap[k - 1], suiv = memeChap[k + 1];
  const chap = NOMS_CHAPITRES[r.category_id] || '';
  const prov = provenance(r);

  main().innerHTML = `
    <article class="double" id="recette">
      <div class="page-texte">
        <a class="rubrique" href="#/">${echapper(chap)}</a>
        <h1 class="recette-titre">${titreHTML(r, 'recette-img')}</h1>
        ${prov ? `<p class="provenance">${echapper(prov)}</p>` : ''}
        <div class="pastilles">${pastilles(r)}</div>
        ${r.description ? `<p class="chapeau">${echapper(r.description)}</p>` : ''}
        <button class="mode-cuisine" id="modeCuisine" aria-pressed="false">Mode cuisine</button>
        <div class="colonnes">
          <div class="col-ingr">
            <h2 class="col-titre">Ingrédients</h2>
            ${ingrs.length ? blocIngredients(ingrs, variantes) : '<p class="prep">Pas de liste : tout est sur sa feuille.</p>'}
          </div>
          <div class="col-etapes">${etapes.length ? blocEtapes(etapes) : ''}</div>
        </div>
        ${r.notes ? `<aside class="sa-note"><h2 class="col-titre">Sa note</h2><p>${echapper(r.notes)}</p></aside>` : ''}
        <nav class="folio" aria-label="Recettes voisines">
          ${prec ? `<a href="#/recette/${encodeURIComponent(prec.slug)}" rel="prev">‹ ${echapper(prec.title)}</a>` : '<span></span>'}
          <span class="folio-chap">${echapper(chap)} · ${k + 1} / ${memeChap.length}</span>
          ${suiv ? `<a href="#/recette/${encodeURIComponent(suiv.slug)}" rel="next">${echapper(suiv.title)} ›</a>` : '<span></span>'}
        </nav>
      </div>
      <div class="page-feuille">
        <div class="feuilles" id="feuilles">
          ${feuilles.length ? '' : `<p class="sans-feuille">Cette recette vient d'un livre ou d'un magazine : pas de feuille de sa main.</p>`}
        </div>
        ${blocPhotos(r, photos)}
      </div>
    </article>`;
  window.scrollTo(0, 0);
  main().focus({ preventScroll: true });

  // Ses feuilles, toutes leurs pages (dix PDF en ont deux).
  const zone = document.getElementById('feuilles');
  for (const f of feuilles) await poserFeuilles(zone, f.public_url);

  brancherRecette(r, cleDocs, slug);
}

function brancherRecette(r, cleDocs, slug) {
  // Portions : les quantités chiffrées suivent le nombre de personnes.
  let n = r.servings || 0;
  document.querySelectorAll('.portions-btn').forEach(b => b.addEventListener('click', () => {
    n = Math.max(1, n + Number(b.dataset.pas));
    document.getElementById('nbPortions').textContent = n;
    const facteur = n / r.servings;
    document.querySelectorAll('.qte[data-base]').forEach(q => {
      q.querySelector('.qte-n').textContent = formaterQte(parseFloat(q.dataset.base) * facteur, q.dataset.unite);
    });
  }));

  // Mode cuisine : texte plus grand, ingrédients à cocher, écran qui reste allumé.
  const bouton = document.getElementById('modeCuisine');
  bouton.addEventListener('click', () => basculerCuisine(bouton));

  // Photo du plat refait.
  document.getElementById('photoPlat')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const msg = document.getElementById('photoMessage');
    msg.textContent = 'Envoi de la photo…'; msg.className = 'photo-message';
    try {
      await ajouterPhotoDuPlat(r.id, f);
      delete cache[cleDocs];
      await afficherRecette(slug);
      document.getElementById('photoMessage').textContent = 'Merci ! Ta photo est dans le livre.';
    } catch (err) {
      msg.textContent = err.message; msg.className = 'photo-message photo-message--err';
    }
  });
  document.querySelectorAll('.photo-retirer').forEach(b => b.addEventListener('click', async () => {
    const msg = document.getElementById('photoMessage');
    try {
      await retirerPhotoDuPlat(b.dataset.id, b.dataset.chemin);
      delete cache[cleDocs];
      await afficherRecette(slug);
    } catch (err) { msg.textContent = err.message; msg.className = 'photo-message photo-message--err'; }
  }));
}

let verrouEcran = null;
async function basculerCuisine(bouton) {
  const article = document.getElementById('recette');
  const actif = article.classList.toggle('cuisine');
  bouton.setAttribute('aria-pressed', String(actif));
  bouton.textContent = actif ? 'Quitter le mode cuisine' : 'Mode cuisine';
  try {
    if (actif && 'wakeLock' in navigator) verrouEcran = await navigator.wakeLock.request('screen');
    else { await verrouEcran?.release(); verrouEcran = null; }
  } catch { /* refusé (batterie faible, onglet caché) : le reste du mode marche */ }
  if (actif) article.querySelector('.col-ingr')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// Un écran qui revient au premier plan perd son verrou : on le redemande.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && document.querySelector('.cuisine') && 'wakeLock' in navigator) {
    try { verrouEcran = await navigator.wakeLock.request('screen'); } catch { /* tant pis */ }
  }
});

// Changer de page en mode cuisine relâche le verrou.
window.addEventListener('hashchange', () => { verrouEcran?.release().catch(() => {}); verrouEcran = null; });

// ── SA FEUILLE ───────────────────────────────────────────────────────────────
// pdf.js n'est chargé qu'ici : l'accueil n'en a pas besoin (1,4 Mo).

let pdfjsPret = null;
function pdfjs() {
  if (!pdfjsPret) pdfjsPret = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    s.onerror = ko;
    document.head.appendChild(s);
  });
  return pdfjsPret;
}

// Rendue à la densité réelle de l'écran : à l'échelle 1, sur un écran Retina,
// son crayon devenait une bouillie grise (constat de la revue du 22/09).
// Rendue à la densité réelle de l'écran : à l'échelle 1, sur un écran Retina,
// son crayon devenait une bouillie grise (constat de la revue du 22/09).
async function dessinerPage(canvas, page, largeurCSS) {
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const vp = page.getViewport({ scale: (largeurCSS / base.width) * dpr });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  canvas.style.aspectRatio = `${vp.width} / ${vp.height}`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  recadrer(canvas);
}

// Une feuille par page du PDF, posée sur l'orange, chacune agrandissable.
async function poserFeuilles(zone, url) {
  try {
    const lib = await pdfjs();
    const doc = await lib.getDocument(url).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const b = document.createElement('button');
      b.className = 'feuille';
      b.setAttribute('aria-label', `Agrandir sa feuille${doc.numPages > 1 ? `, page ${p} sur ${doc.numPages}` : ''}`);
      b.innerHTML = '<canvas></canvas><span class="feuille-loupe">Agrandir</span>';
      zone.appendChild(b);
      b.addEventListener('click', () => ouvrirLoupe(url, p));
      await dessinerPage(b.querySelector('canvas'), await doc.getPage(p), b.clientWidth || 420);
    }
  } catch (e) {
    zone.appendChild(Object.assign(document.createElement('p'), { className: 'sans-feuille', textContent: "Sa feuille n'a pas pu être chargée." }));
  }
}

// Ses feuilles ont été scannées sur une vitre A4 : la vraie feuille, plus petite,
// flotte au milieu d'une grande marge blanche. On recadre sur ce qui n'est pas
// blanc (son trait ET le bord de la feuille), avec une petite marge, pour que la
// feuille posée sur l'orange soit la sienne et pas une feuille dans une feuille.
function recadrer(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const px = ctx.getImageData(0, 0, w, h).data;
  const pas = Math.max(1, Math.floor(Math.min(w, h) / 500));
  const seuil = 225, mini = 3;      // gris assez foncé, et au moins quelques points
  const lignes = new Uint16Array(h), colonnes = new Uint16Array(w);
  for (let y = 0; y < h; y += pas) {
    for (let x = 0; x < w; x += pas) {
      const k = (y * w + x) * 4;
      if ((px[k] + px[k + 1] + px[k + 2]) / 3 < seuil) { lignes[y]++; colonnes[x]++; }
    }
  }
  const premier = (t, n) => { for (let i = 0; i < n; i++) if (t[i] >= mini) return i; return 0; };
  const dernier = (t, n) => { for (let i = n - 1; i >= 0; i--) if (t[i] >= mini) return i; return n - 1; };
  const marge = Math.round(Math.min(w, h) * 0.02);
  const x0 = Math.max(0, premier(colonnes, w) - marge), y0 = Math.max(0, premier(lignes, h) - marge);
  const x1 = Math.min(w - 1, dernier(colonnes, w) + marge), y1 = Math.min(h - 1, dernier(lignes, h) + marge);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  // Rien à gagner (déjà serré) ou résultat absurde (page presque vide) : on laisse.
  if (cw * ch > w * h * 0.92 || cw < w * 0.25 || ch < h * 0.25) return;
  const morceau = ctx.getImageData(x0, y0, cw, ch);
  canvas.width = cw; canvas.height = ch;
  canvas.style.aspectRatio = `${cw} / ${ch}`;
  ctx.putImageData(morceau, 0, 0);
}

let dernierFocus = null;
function ouvrirLoupe(url, numero = 1) {
  const loupe = document.getElementById('loupe');
  const corps = document.getElementById('loupeCorps');
  dernierFocus = document.activeElement;
  corps.innerHTML = '<canvas></canvas>';
  loupe.hidden = false;
  document.body.classList.add('loupe-ouverte');
  pdfjs().then(lib => lib.getDocument(url).promise).then(doc => doc.getPage(numero))
    .then(page => dessinerPage(corps.querySelector('canvas'), page, Math.min(window.innerWidth - 32, 1100)))
    .catch(() => { corps.innerHTML = '<p class="sans-feuille">Sa feuille n\'a pas pu être chargée.</p>'; });
  document.getElementById('loupeFermer').focus();
}
function fermerLoupe() {
  document.getElementById('loupe').hidden = true;
  document.body.classList.remove('loupe-ouverte');
  dernierFocus?.focus();
}
document.getElementById('loupeFermer').addEventListener('click', fermerLoupe);
document.getElementById('loupe').addEventListener('click', e => { if (e.target.id === 'loupe') fermerLoupe(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.getElementById('loupe').hidden) fermerLoupe();
});

// ── CONTRIBUER ───────────────────────────────────────────────────────────────
// Connexion, dépôt et demandes d'accès viennent de contribuer.js. pdf.js n'est
// chargé qu'à l'ouverture du dépôt : c'est lui qui lit un PDF déposé.

async function ouvrirDepot() {
  try { await pdfjs(); } catch { /* sans pdf.js, le serveur lit le document */ }
  openSubmit();
}

// Après une publication : on recharge la liste et on ouvre la recette publiée.
window.LIVRE = {
  async apresPublication(id) {
    for (const k of Object.keys(cache)) delete cache[k];
    await chargerLivre();
    closeSubmit();
    const r = etat.recettes.find(x => x.id === id);
    location.hash = r ? `#/recette/${encodeURIComponent(r.slug)}` : '#/';
  },
};

// ── ROUTAGE ──────────────────────────────────────────────────────────────────

function main() { return document.getElementById('contenu'); }

function router() {
  // Les liens partagés avec l'ancienne version (« /#choucroute-denise », ou
  // l'identifiant « /#9 ») doivent continuer d'ouvrir leur recette.
  const ancien = decodeURIComponent(location.hash.slice(1));
  if (ancien && !ancien.startsWith('/')) {
    const r = etat.recettes.find(x => x.slug === ancien) || (/^\d+$/.test(ancien) && etat.recettes.find(x => x.id === Number(ancien)));
    if (r) { history.replaceState(null, '', `#/recette/${encodeURIComponent(r.slug)}`); return afficherRecette(r.slug); }
  }
  const m = location.hash.match(/^#\/recette\/(.+)$/);
  if (m) afficherRecette(decodeURIComponent(m[1]));
  else afficherAccueil();
}

(async () => {
  try {
    initAuth();   // en parallèle : ne retarde jamais la lecture
    await chargerLivre();
    window.addEventListener('hashchange', router);
    setTimeout(() => proposerBrouillon().catch(() => {}), 1200);
    router();
  } catch (e) {
    main().innerHTML = `<p class="vide">Le livre n'a pas pu être chargé (${echapper(e.message)}). Recharge la page dans un instant.</p>`;
  }
})();
