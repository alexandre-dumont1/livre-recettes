// Les clés sont chargées depuis config.js (non versionné)
// Voir config.example.js pour la structure attendue
const URL_SB = window.APP_CONFIG?.supabaseUrl || '';
const KEY_SB = window.APP_CONFIG?.supabaseKey || '';

if (!URL_SB || !KEY_SB) {
  console.error('⚠️ config.js manquant — copie config.example.js en config.js et remplis tes clés.');
}

// PDF.js
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// Valeurs de repli uniquement : les vrais libellés, emojis et ordres viennent de
// la table recipe_categories. C'est la désynchronisation entre ce tableau et la
// base qui rendait Gibier (1 recette) et Accompagnements (10) invisibles dans
// les filtres, donc introuvables autrement qu'en parcourant « Toutes ».
let CATS = { 1: 'Entrées', 2: 'Plats', 3: 'Poissons', 4: 'Desserts', 5: 'Gibier', 6: 'Accompagnements' };
let CAT_EMOJI = {};
let CAT_ORDER = {};
// La liste brute des catégories, gardée pour pouvoir refaire les filtres après
// la publication d'une recette sans redemander la table.
let CATS_LISTE = [];
const CAT_COLORS = {
  1: '#b8641e',
  2: '#6e4f8a',
  3: '#1a7a5a',
  4: '#c4923a',
  5: '#7a3a6e',
  6: '#4a7a3a'
};

let allRecipes = [], filteredRecipes = [], currentIndex = -1, catFilter = 0;
let ingrByRecipe = new Map();

const cache = {};

async function sb(path) {
  if (cache[path]) return cache[path];
  const r = await fetch(`${URL_SB}/rest/v1/${path}`, {
    headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}` }
  });
  if (!r.ok) throw new Error(`Erreur réseau : ${r.status}`);
  const data = await r.json();
  cache[path] = data;
  return data;
}

function ft(min) {
  if (!min) return null;
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// Une classe et non une taille en dur : la feuille de style décide, et elle
// applique un plancher. En dessous de 1,95rem le marqueur devient illisible, donc
// un titre long prend plus de lignes au lieu de rétrécir indéfiniment.
// ── LA MAIN ET LE « SELON » ───────────────────────────────────────────────────
// Deux questions distinctes, longtemps confondues : QUI a apporté la recette au
// livre, et D'OÙ elle vient. La base mélangeait les deux dans author (« Maman »
// à côté de « Lenôtre ») et source contenait un type, pas un nom (« famille »,
// « presse »), d'où 95 pages sur 122 qui signaient « famille ».
//
// hand et attribution sont les colonnes neuves. Le repli sur author puis source
// garde aux 122 recettes existantes exactement l'affichage qu'elles avaient.

function laMain(r) {
  return (r.hand || r.author || r.source || '').trim();
}

function leSelon(r) {
  return (r.attribution || '').trim();
}

// « de la main d'Alexandre » et non « de la main de Alexandre » : l'élision
// devant une voyelle, sinon la ligne sonne faux dans un livre.
function deLaMainDe(nom) {
  return /^[aeiouyàâäéèêëîïôöùûü]/i.test(nom) ? `de la main d'${nom}` : `de la main de ${nom}`;
}

// La main d'abord, parce que c'est un livre de famille : qui l'a apportée compte
// plus que d'où elle vient. Sans hand, on garde la formule brute d'avant.
function provenance(r) {
  const main = laMain(r), selon = leSelon(r);
  const morceaux = [];
  if (main) morceaux.push(r.hand ? deLaMainDe(main) : main);
  if (selon) morceaux.push(`d'après ${selon}`);
  return morceaux.join(' · ') || 'recette de famille';
}

function titleClass(title) {
  const l = (title || '').length;
  if (l > 40) return ' recipe-title--long';
  if (l > 25) return ' recipe-title--moyen';
  return '';
}

function twoToneTitle(title) {
  const words = title.split(' ');
  if (words.length === 1) return title;

  const total = title.replace(/ /g, '').length;
  const target = total * 0.35;

  let best = words.length - 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const amberLen = words.slice(i).join('').length;
    const diff = Math.abs(amberLen - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }

  const before = words.slice(0, best).join(' ');
  const amber  = words.slice(best).join(' ');
  return `${before} <span class="title-accent">${amber}</span>`;
}

// ── FAVORIS ──────────────────────────────────────────────────────────────────

function getFavs() {
  return JSON.parse(localStorage.getItem('recette-favoris') || '[]');
}

function toggleFav(id) {
  const favs = getFavs();
  const i = favs.indexOf(id);
  if (i === -1) favs.push(id); else favs.splice(i, 1);
  localStorage.setItem('recette-favoris', JSON.stringify(favs));
  // force : c'est la même recette, mais son étoile a changé. Sans ça, le livre
  // verrait la page déjà en place et ne la refabriquerait pas.
  if (currentIndex < 0) remplirCouverture(); else showPage(currentIndex, { force: true });
}

// ── COPIER LE LIEN ────────────────────────────────────────────────────────────

function copyRecipeLink(btn) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(window.location.href).then(() => {
    const original = btn.textContent;
    btn.textContent = '✓ Copié !';
    setTimeout(() => { btn.textContent = original; }, 2000);
  }).catch(() => {});
}

// ── COVER / PAGE DE GARDE ─────────────────────────────────────────────────────

function buildTOCGroups(recipes) {
  const grouped = {};
  const groupOrder = [];
  recipes.forEach((r, i) => {
    const cat = CATS[r.category_id] || 'Autre';
    if (!grouped[cat]) { grouped[cat] = { catId: r.category_id, items: [] }; groupOrder.push(cat); }
    grouped[cat].items.push({ r, i });
  });
  // Sans tri, l'ordre des blocs dépendait de la première recette rencontrée par
  // ordre alphabétique : les desserts pouvaient précéder les entrées.
  groupOrder.sort((a, b) => (CAT_ORDER[grouped[a].catId] ?? 99) - (CAT_ORDER[grouped[b].catId] ?? 99));
  return { grouped, groupOrder };
}

// Fabrique la garde et le menu dans les deux premiers feuillets du livre. Cette
// fonction ne navigue pas : elle pose du papier. C'est arriverA(-1) qui tourne les
// pages jusque-là. Le menu compte les favoris, donc on la rappelle à chaque retour
// au menu plutôt que de garder un décompte périmé.
function remplirCouverture() {
  if (!feuillets.length) return;

  // ── Page gauche : la page de garde ──
  // Un vrai feuillet manuscrit en fond, désaturé et voilé : on voit de quoi le
  // livre est fait avant d'avoir tourné une page.
  //
  // Aucun compteur ici (nombre de recettes, de manuscrits) : ces valeurs bougent
  // à chaque ajout, et une couverture qui se périme est une couverture fausse.
  const coverHTML = `
    <div class="garde-frame">
      <canvas class="garde-fond" id="gardeFond" aria-hidden="true"></canvas>
      <div class="garde-voile" aria-hidden="true"></div>
      <div class="garde-contenu">
        <div class="garde-eyebrow">Recettes de famille</div>
        <h1 class="garde-title">Le livre de recettes<br>des <span class="garde-nom">Dumont</span></h1>
        <p class="garde-dedication">Écrites à la main, recopiées, transmises.</p>
      </div>
      <span class="garde-page-num">i</span>
    </div>`;

  // ── Page droite : LE MENU ──
  // Elle offrait jusqu'ici la liste des 122 recettes, ce qui faisait doublon avec
  // l'index du panneau et obligeait à défiler pour rien. Elle devient le menu
  // principal : quelques portes d'entrée, pas un inventaire.
  const chapitres = [...new Set(allRecipes.map(r => r.category_id).filter(Boolean))]
    .sort((a, b) => (CAT_ORDER[a] ?? 99) - (CAT_ORDER[b] ?? 99))
    .map(id => ({
      id,
      nom: CATS[id] || 'Autre',
      emoji: CAT_EMOJI[id] || '',
      n: allRecipes.filter(r => r.category_id === id).length
    }));

  const nbFavs = getFavs().length;

  const menuHTML = `
    <div class="menu-page">
      <div class="menu-tete">
        <span>Par où commencer</span>
        <span class="menu-tete-n">${allRecipes.length} recettes</span>
      </div>

      <div class="menu-chapitres">
        ${chapitres.map(c => `
          <button class="menu-chapitre" onclick="ouvrirChapitre(${c.id})">
            <span class="menu-emoji" aria-hidden="true">${c.emoji}</span>
            <span class="menu-chapitre-nom">${c.nom}</span>
            <span class="menu-chapitre-n">${c.n}</span>
          </button>`).join('')}
      </div>

      <div class="menu-actions">
        <button class="menu-action menu-action--prim" onclick="ouvrirChapitre(0)">
          <span class="menu-action-t">Commencer la lecture</span>
          <span class="menu-action-d">de la première à la dernière page</span>
        </button>
        <button class="menu-action" onclick="recetteAuHasard()">
          <span class="menu-action-t">Une recette au hasard</span>
          <span class="menu-action-d">pour se laisser surprendre</span>
        </button>
        <button class="menu-action" onclick="openSearch()">
          <span class="menu-action-t">Rechercher</span>
          <span class="menu-action-d">un plat, un ingrédient, un mot-clé</span>
        </button>
        <button class="menu-action" onclick="openTOC()">
          <span class="menu-action-t">L'index complet</span>
          <span class="menu-action-d">par chapitre, alphabétique, par ingrédient, par main, par temps</span>
        </button>
        <button class="menu-action${nbFavs ? '' : ' menu-action--inerte'}" onclick="ouvrirFavoris()" ${nbFavs ? '' : 'disabled'}>
          <span class="menu-action-t">Mes favoris ${nbFavs ? `<span class="menu-badge">${nbFavs}</span>` : ''}</span>
          <span class="menu-action-d">${nbFavs ? 'les recettes que tu as marquées' : 'aucune recette marquée pour l\'instant'}</span>
        </button>
      </div>

      <span class="garde-page-num">ii</span>
    </div>`;

  feuillets[0].innerHTML = coverHTML;
  feuillets[1].innerHTML = menuHTML;
}

// Revenir au menu. Sans animation : on y arrive par le titre du livre, un filtre
// ou une recherche vide, jamais en tournant une page — ça, c'est changePage(-1)
// depuis la première recette, et lui anime.
function showCover() {
  remplirCouverture();
  return arriverA(-1);
}

// Les portes d'entrée du menu. Chacune restreint le livre puis ouvre la première
// page du lot : on entre dans le livre, on ne reste pas devant une liste.
function appliquerFiltre(valeur) {
  catFilter = valeur;
  document.querySelectorAll('#tocFilters .cat-btn').forEach(b => {
    const actif = b.dataset.cat === String(valeur);
    b.classList.toggle('active', actif);
    b.setAttribute('aria-pressed', String(actif));
  });
  majFilteredRecipes();
  buildTOC();
}

function ouvrirChapitre(id) {
  appliquerFiltre(id);
  if (filteredRecipes.length) showPage(0);
}

function ouvrirFavoris() {
  appliquerFiltre('fav');
  if (filteredRecipes.length) showPage(0);
  else showCover();
}

// Le titre du livre en haut de l'écran est le chemin du retour : c'est la
// convention du logo cliquable, et c'était le seul moyen manquant de revenir au
// menu une fois qu'on avait tourné une page.
function retourMenu() {
  closeSubmit();
  closeSearch();
  closeTOC();
  // On rouvre le livre entier : la couverture annonce tous les chapitres, garder
  // un filtre derrière elle rendrait les nombres du menu faux.
  appliquerFiltre(0);
  showCover();
}

function recetteAuHasard() {
  appliquerFiltre(0);
  if (!filteredRecipes.length) return;
  showPage(Math.floor(Math.random() * filteredRecipes.length));
}

// ── GALERIE ───────────────────────────────────────────────────────────────────

// Le mode galerie n'a jamais fonctionné : ni #galleryView ni .gallery-btn
// n'existent dans le HTML, et aucun style de galerie n'a jamais été écrit.
// Presser « G » levait donc une exception. On garde le code en attendant de
// construire la galerie pour de bon, mais on ne plante plus.
function toggleGallery() {
  const vue = document.getElementById('galleryView');
  const bouton = document.querySelector('.gallery-btn');
  if (!vue || !bouton) {
    console.info('Mode galerie non disponible : interface pas encore construite.');
    return;
  }
  const entering = !document.body.classList.contains('gallery-mode');
  document.body.classList.toggle('gallery-mode', entering);
  bouton.classList.toggle('active', entering);
  if (entering) showGallery();
}

function showGallery() {
  const container = document.getElementById('galleryView');
  const { grouped, groupOrder } = buildTOCGroups(filteredRecipes);

  container.innerHTML = groupOrder.map(cat => {
    const { catId, items } = grouped[cat];
    const color = CAT_COLORS[catId] || '#888';
    return `
      <div class="gallery-section-title">${cat} <span class="gallery-section-count">${items.length}</span></div>
      <div class="gallery-grid">
        ${items.map(({ r, i }) => {
          const source = laMain(r);
          const tags = (r.tags || []).slice(0, 3).join(' · ');
          const hasPdf = r.pdf_url ? '<span class="gallery-card-pdf" title="Manuscrit original">✦</span>' : '';
          return `
            <div class="gallery-card" onclick="openFromGallery(${i})">
              <div class="gallery-card-stripe" style="background:${color}"></div>
              <div class="gallery-card-body">
                <div class="gallery-card-title">${r.title}</div>
                ${source ? `<div class="gallery-card-source">${source}</div>` : ''}
              </div>
              <div class="gallery-card-footer">
                <span class="gallery-card-tags">${tags}</span>
                <span class="gallery-card-meta">${hasPdf}<span class="gallery-card-page">p.&thinsp;${i * 2 + 1}</span></span>
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');
}

function openFromGallery(i) {
  document.body.classList.remove('gallery-mode');
  document.querySelector('.gallery-btn')?.classList.remove('active');
  showPage(i);
}

// ── AJUSTEUR DE PORTIONS ──────────────────────────────────────────────────────

// ── PORTIONS ──────────────────────────────────────────────────────────────────
// « ×2 » ne disait jamais pour combien de personnes on cuisine. On règle le
// nombre de convives, les quantités suivent.
// 17 recettes sur 122 n'ont aucun nombre de personnes en base : faute de point de
// départ, celles-là gardent les multiplicateurs.

// L'état vit dans la page, plus dans deux variables globales. Depuis que le livre
// tourne ses feuillets pour de vrai, la double courante n'est plus seule montée :
// ses voisines sont préparées d'avance pour qu'une page qui arrive ne soit jamais
// vide. Un compteur global aurait fait bouger les quantités de la mauvaise
// recette, et le dernier rendu aurait écrasé le réglage en cours.
//
// Le point de départ (data-base) et le choix du lecteur (data-actuel) sont donc
// portés par le bloc lui-même, et tout part du bouton cliqué.

function appliquerEchelle(bloc, mult) {
  const page = bloc.closest('.page') || document;
  page.querySelectorAll('.ingr-qty[data-base]').forEach(el => {
    const base = parseFloat(el.dataset.base);
    const unit = el.dataset.unit || '';
    if (isNaN(base)) return;
    const arrondi = Math.round(base * mult * 100) / 100;
    // Virgule décimale : on écrit en français, « 12,5 » et non « 12.5 ».
    const affichage = String(arrondi).replace('.', ',');
    el.textContent = unit ? affichage + '\u202f' + unit : affichage;
  });
}

function majCompteurPersonnes(bloc) {
  const base = parseFloat(bloc.dataset.base);
  const actuel = parseFloat(bloc.dataset.actuel);
  const compteur = bloc.querySelector('.serving-count');
  if (!compteur || !base) return;
  compteur.textContent = actuel;
  const reset = bloc.querySelector('.serving-reset');
  const moins = bloc.querySelector('.serving-moins');
  if (reset) reset.hidden = (actuel === base);
  if (moins) moins.disabled = (actuel <= 1);
  appliquerEchelle(bloc, actuel / base);
}

function stepServings(d, btn) {
  const bloc = btn.closest('.serving-scaler');
  const base = parseFloat(bloc?.dataset.base);
  if (!base) return;
  bloc.dataset.actuel = String(Math.max(1, Math.min(60, parseFloat(bloc.dataset.actuel) + d)));
  majCompteurPersonnes(bloc);
}

function resetServings(btn) {
  const bloc = btn.closest('.serving-scaler');
  if (!bloc) return;
  bloc.dataset.actuel = bloc.dataset.base;
  majCompteurPersonnes(bloc);
}

// Repli pour les recettes sans nombre de personnes.
function scaleIngredients(mult, btn) {
  const scaler = btn.closest('.serving-scaler');
  scaler.querySelectorAll('.serving-btn').forEach(b => b.classList.remove('serving-btn--active'));
  btn.classList.add('serving-btn--active');
  appliquerEchelle(scaler, mult);
}

// ── VARIANTES EN TUILES ───────────────────────────────────────────────────────
// Une page de variantes (« Salades composées » et ses huit combinaisons) étale
// une tuile par variante sur toute la page. Un clic ouvre une tuile : elle prend
// la largeur, les autres rétrécissent en bandeau. Recliquer referme et tout
// revient à égalité.
//
// Tout est déjà dans le DOM : ouvrir ne redemande rien à la base, et la CSS fait
// la transition de taille. Aucune mesure, aucun calcul de hauteur.

function ouvrirTuile(n, btn) {
  // La grille se trouve depuis le bouton cliqué : plusieurs pages de variantes
  // peuvent être montées à la fois dans le livre.
  const grille = btn?.closest('.variantes-tuiles');
  if (!grille) return;
  const tuiles = [...grille.querySelectorAll('.variante-tuile')];
  const cible = tuiles[n];
  if (!cible) return;

  const dejaOuverte = cible.classList.contains('variante-tuile--ouverte');
  tuiles.forEach(t => {
    t.classList.remove('variante-tuile--ouverte');
    t.querySelector('.variante-tete')?.setAttribute('aria-expanded', 'false');
  });

  // Recliquer sur la tuile ouverte referme : sans ça, une fois une variante
  // choisie on ne pourrait plus revoir les huit à égalité.
  if (dejaOuverte) {
    grille.classList.remove('variantes-tuiles--ouverte');
    return;
  }
  grille.classList.add('variantes-tuiles--ouverte');
  cible.classList.add('variante-tuile--ouverte');
  cible.querySelector('.variante-tete')?.setAttribute('aria-expanded', 'true');
}

// ── RENDER FUNCTIONS ──────────────────────────────────────────────────────────

async function renderLeft(recipe) {
  const [ingrs, steps] = await Promise.all([
    sb(`recipe_ingredients?select=*,ingredients(name)&recipe_id=eq.${recipe.id}&order=display_order`),
    sb(`recipe_steps?select=*&recipe_id=eq.${recipe.id}&order=step_number`)
  ]);

  const cat = CATS[recipe.category_id] || '';

  const groups = {};
  const groupOrder = [];
  ingrs.forEach(i => {
    const g = i.group_label || '';
    if (!groups[g]) { groups[g] = []; groupOrder.push(g); }
    groups[g].push(i);
  });

  function ligneIngredient(i) {
    const qty = [i.quantity, i.unit].filter(Boolean).join('\u202f');
    const prep = i.preparation ? `<span class="ingr-prep">, ${i.preparation}</span>` : '';
    // data-base stocke la partie numérique pour l'ajusteur de portions
    const numericBase = i.quantity !== null && i.quantity !== '' && !isNaN(parseFloat(i.quantity))
      ? parseFloat(i.quantity) : '';
    const dataBase = numericBase !== '' ? ` data-base="${numericBase}" data-unit="${(i.unit || '').replace(/"/g, '&quot;')}"` : '';
    const option = i.is_optional ? `<span class="ingr-option">facultatif</span>` : '';
    return `<div class="ingr-row">
      <span class="ingr-qty"${dataBase}>${qty}</span>
      <span>${i.ingredients?.name || ''}${prep}${option}</span>
    </div>`;
  }

  // Deux sens opposés pour le même group_label, d'où le drapeau en base :
  //   · false (54 recettes) : les groupes sont les PARTIES d'un même plat —
  //     Marinade, Aromates, Cuisson. Affichés ensemble, il faut les avoir toutes
  //     sous les yeux pour cuisiner.
  //   · true : les groupes sont des ALTERNATIVES. On en cuisine une, jamais huit.
  //     Une tuile par variante, dépliable.
  const nomsGroupes = groupOrder.filter(Boolean);
  const variantes = !!recipe.groups_are_variants && nomsGroupes.length >= 2;

  let ingrHTML = '';
  if (!variantes) {
    groupOrder.forEach(g => {
      if (g) ingrHTML += `<div class="ingr-group-label">${g}</div>`;
      ingrHTML += groups[g].map(ligneIngredient).join('');
    });
  }

  // Sur une page de variantes, une étape dont le titre est celui d'une variante
  // n'appartient qu'à elle et vit dans sa tuile. Une étape sans ce titre est
  // commune et reste dans la colonne Préparation.
  function blocEtape(s) {
    const dur = s.duration_minutes ? `<span class="step-badge badge-time">${ft(s.duration_minutes)}</span>` : '';
    const temp = s.temperature_celsius ? `<span class="step-badge badge-temp">${s.temperature_celsius}\u00b0C</span>` : '';
    return `<div class="step-item">
      <span class="step-num">${String(s.step_number).padStart(2, '0')}</span>
      <div class="step-body">
        <div class="step-title-row">
          <span class="step-title">${s.title || ''}</span>
          ${dur}${temp}
        </div>
        <p class="step-desc">${s.description}</p>
      </div>
    </div>`;
  }

  const etapesDeVariante = new Map();
  const etapesCommunes = variantes
    ? steps.filter(st => {
        const nom = (st.title || '').trim();
        if (!nomsGroupes.includes(nom)) return true;
        if (!etapesDeVariante.has(nom)) etapesDeVariante.set(nom, []);
        etapesDeVariante.get(nom).push(st);
        return false;
      })
    : steps;

  // Une tuile par variante : le titre au marqueur, plus petit que celui de la
  // recette, et le contenu qui n'apparaît qu'à l'ouverture.
  const tuilesHTML = variantes ? `
    <div class="variantes-tuiles" role="group" aria-label="Les ${nomsGroupes.length} variantes de cette page">
      ${nomsGroupes.map((g, n) => {
        const lignes = groups[g];
        const propres = etapesDeVariante.get(g) || [];
        return `
        <section class="variante-tuile">
          <button class="variante-tete" onclick="ouvrirTuile(${n}, this)" aria-expanded="false">
            <span class="variante-titre">${g}</span>
            <span class="variante-compte">${lignes.length} ingrédient${lignes.length > 1 ? 's' : ''}</span>
          </button>
          <div class="variante-contenu">
            <div class="variante-ingr">${lignes.map(ligneIngredient).join('')}</div>
            ${propres.length ? `<div class="variante-etapes">${propres.map(blocEtape).join('')}</div>` : ''}
          </div>
        </section>`;
      }).join('')}
    </div>` : '';

  let stepsHTML = '';
  etapesCommunes.forEach(s => {
    const dur = s.duration_minutes ? `<span class="step-badge badge-time">${ft(s.duration_minutes)}</span>` : '';
    const temp = s.temperature_celsius ? `<span class="step-badge badge-temp">${s.temperature_celsius}\u00b0C</span>` : '';
    stepsHTML += `<div class="step-item">
      <span class="step-num">${String(s.step_number).padStart(2, '0')}</span>
      <div class="step-body">
        <div class="step-title-row">
          <span class="step-title">${s.title}</span>
          ${dur}${temp}
        </div>
        <p class="step-desc">${s.description}</p>
      </div>
    </div>`;
  });

  const noteHTML = recipe.notes ? `
    <div class="note-row">
      <span class="note-label">Note</span>
      <span class="note-text">${recipe.notes}</span>
    </div>` : '';

  const metaItems = [];
  if (recipe.servings)           metaItems.push({ label: 'Personnes', val: recipe.servings });
  if (recipe.difficulty)         metaItems.push({ label: 'Difficulté', val: recipe.difficulty });
  if (recipe.prep_time_minutes)  metaItems.push({ label: 'Prép.', val: ft(recipe.prep_time_minutes) });
  if (recipe.cook_time_minutes)  metaItems.push({ label: 'Cuisson', val: ft(recipe.cook_time_minutes) });

  const metaHTML = metaItems.map(m => `
    <div class="meta-item">
      <span class="meta-label">${m.label}</span>
      <span class="meta-value">${m.val}</span>
    </div>`).join('');

  const source = provenance(recipe);

  // Le nombre de personnes pilote l'échelle quand il existe. Le point de départ et
  // le choix du lecteur sont écrits sur le bloc : chaque page porte le sien.
  const personnes = recipe.servings || null;
  const unite = recipe.servings_unit || 'personnes';
  const servingsHTML = personnes
    ? `
    <div class="serving-scaler serving-people" role="group" aria-label="Ajuster le nombre de personnes"
         data-base="${personnes}" data-actuel="${personnes}">
      <span class="serving-word">Pour</span>
      <button class="serving-step serving-moins" onclick="stepServings(-1, this)" aria-label="Une personne de moins">−</button>
      <span class="serving-count" aria-live="polite">${personnes}</span>
      <button class="serving-step" onclick="stepServings(1, this)" aria-label="Une personne de plus">+</button>
      <span class="serving-word">${unite}</span>
      <button class="serving-reset" onclick="resetServings(this)" hidden>revenir à ${personnes}</button>
    </div>`
    : `
    <div class="serving-scaler" role="group" aria-label="Ajuster les portions">
      <span class="serving-label">Portions :</span>
      <button class="serving-btn" data-mult="0.5" onclick="scaleIngredients(0.5, this)">½</button>
      <button class="serving-btn serving-btn--active" data-mult="1" onclick="scaleIngredients(1, this)">×1</button>
      <button class="serving-btn" data-mult="2" onclick="scaleIngredients(2, this)">×2</button>
      <button class="serving-btn" data-mult="3" onclick="scaleIngredients(3, this)">×3</button>
    </div>`;

  // Sur une page de variantes, les ingrédients vivent dans les tuiles : le corps
  // à deux colonnes n'a plus d'objet et laisserait une colonne vide. Il ne
  // réapparaît que s'il reste des étapes communes ou une note.
  const colonneIngredients = `
      <div>
        <div class="col-header">Ingrédients</div>
        ${ingrHTML}
      </div>`;
  const colonnePreparation = `
      <div>
        <div class="col-header">Préparation</div>
        ${stepsHTML}
      </div>`;

  let corpsHTML = '';
  if (!variantes) {
    corpsHTML = `<div class="recipe-body">${colonneIngredients}${colonnePreparation}${noteHTML}</div>`;
  } else if (stepsHTML || noteHTML) {
    corpsHTML = `<div class="recipe-body recipe-body--variantes">${stepsHTML ? colonnePreparation : ''}${noteHTML}</div>`;
  }

  return `
    <span class="page-num">${currentIndex * 2 + 1}</span>
    <div class="cat-tag">
      <div class="cat-tag-bar"></div>
      <span class="cat-tag-text">${cat}</span>
    </div>
    <div class="recipe-title${titleClass(recipe.title)}">${twoToneTitle(recipe.title)}</div>
    <div class="recipe-meta-line">
      <div class="recipe-source">${source}</div>
      <div class="souleiado"></div>
    </div>
    ${recipe.description ? `<p class="recipe-lead">${recipe.description}</p>` : ''}
    ${metaHTML ? `<div class="meta-row">${metaHTML}</div>` : ''}
    ${servingsHTML}
    ${tuilesHTML}
    ${corpsHTML}`;
}

function renderRight(recipe, docs, surLeFeuillet) {
  // Un document ne remonte que par recipe_document_links, donc une page ne peut
  // afficher que SON manuscrit et SES photos, jamais celui d'une autre recette.
  // Les 4 feuillets partagés le sont entre deux variantes du même plat.
  const manuscrit = (docs || []).find(d => d.recipe_documents?.kind === 'manuscript')?.recipe_documents;
  const photos = (docs || [])
    .filter(d => d.recipe_documents?.kind === 'dish_photo')
    .map(d => d.recipe_documents)
    .slice(0, 5);

  const tagsHTML = (recipe.tags || []).slice(0, 6).map(t => `<span class="tag">${t}</span>`).join('');
  const isFav = getFavs().includes(recipe.id);
  // Le bandeau du feuillet est étroit : la main seule, sans le « d'après ».
  const source = laMain(recipe) || 'recette de famille';

  const footer = `
    <div class="right-footer">
      <div class="tags-row">${tagsHTML}</div>
      <button class="copy-link-btn" onclick="copyRecipeLink(this)" title="Copier le lien vers cette recette" aria-label="Copier le lien vers cette recette">Copier le lien</button>
      <button class="${isFav ? 'fav-btn--active' : 'copy-link-btn'}" onclick="toggleFav(${recipe.id})" aria-label="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '★ Favori' : '☆ Favori'}</button>
      <span class="page-num-right">${currentIndex * 2 + 2}</span>
    </div>`;

  // Aucun document du tout : une page sobre plutôt qu'un cadre vide.
  if (!manuscrit && !photos.length) {
    const cat = CATS[recipe.category_id] || '';
    return `
      <div class="no-pdf-zone">
        <div class="no-pdf-cat">${cat}</div>
        <div class="no-pdf-title">${recipe.title}</div>
        <div class="no-pdf-souleiado"></div>
      </div>
      ${footer}`;
  }

  // Les bandeaux sont opaques et leur place est réservée par du padding : la
  // légende ne recouvre jamais l'écriture, contrairement à un dégradé posé
  // par-dessus le document.
  const ko = manuscrit?.byte_size ? Math.round(manuscrit.byte_size / 1024) + ' ko' : '';
  const manuscritHTML = manuscrit ? `
    <a class="tuile tuile--manuscrit" href="${manuscrit.public_url}" target="_blank" rel="noopener"
       aria-label="Ouvrir le manuscrit original de ${recipe.title}">
      <span class="bandeau-haut">
        <span class="etiq-manuscrit">manuscrit</span>
        <span class="tech">${ko}</span>
      </span>
      <span class="photo-inner">
        <canvas class="pdf-thumb"></canvas>
        <div class="pdf-fallback"><span style="font-size:26px">📄</span><span>Recette manuscrite</span></div>
      </span>
      <span class="bandeau-bas">
        <span class="main">${source}</span>
        <span class="lire">agrandir</span>
      </span>
    </a>` : '';

  const photosHTML = photos.map((d, i) => `
    <a class="tuile tuile--p${i + 1}" href="${d.public_url}" target="_blank" rel="noopener"
       aria-label="Agrandir la photo${d.caption ? ' : ' + d.caption : ''}">
      <img src="${d.public_url}" alt="" loading="lazy">
      ${d.caption ? `<span class="tuile-cap">${d.caption}</span>` : ''}
    </a>`).join('');

  // Aucune photo : le manuscrit s'étale. C'est le cas de 121 recettes sur 122
  // aujourd'hui. Pas de case grise, elle ferait passer le vide pour un manque.
  const seul = photos.length === 0 ? ' pele-melee--seul' : '';

  // Les sous-onglets passent AU-DESSUS du pêle-mêle : ils décrivent le feuillet
  // qu'on est en train de regarder, et on doit les voir avant de se demander
  // pourquoi le même manuscrit revient sur deux pages.
  const onglets = (surLeFeuillet || []).length ? `
    <div class="feuillet-recettes">
      <p class="feuillet-tete">Ce feuillet porte ${surLeFeuillet.length} recettes</p>
      <div class="feuillet-onglets" role="tablist" aria-label="Recettes de ce feuillet">
        ${surLeFeuillet.map(v => v.actif
          ? `<span class="feuillet-onglet feuillet-onglet--actif" role="tab" aria-selected="true" aria-current="page">${v.title}</span>`
          : `<button class="feuillet-onglet" role="tab" aria-selected="false" onclick="allerVersRecette(${v.id})">${v.title}</button>`
        ).join('')}
      </div>
    </div>` : '';

  return `${onglets}<div class="pele-melee${seul}">${manuscritHTML}${photosHTML}</div>${footer}`;
}

// Le fond de la page de garde. CSS ne sait pas afficher un PDF en image de
// fond, donc on dessine la première page dans un canvas avec pdf.js, déjà chargé
// pour les vignettes de manuscrit.
let fondsManuscrits = [];

async function renderGardeFond() {
  const c = document.getElementById('gardeFond');
  if (!c || !window.pdfjsLib || !fondsManuscrits.length) return;

  // Un feuillet différent à chaque ouverture du livre : la couverture change,
  // comme une pile de papiers qu'on rebat.
  const url = fondsManuscrits[Math.floor(Math.random() * fondsManuscrits.length)];
  try {
    const pdf = await pdfjsLib.getDocument({ url }).promise;
    const page = await pdf.getPage(1);
    const cadre = c.parentElement;
    // Même précaution que pour les manuscrits : la page de garde peut encore être
    // hors du flux quand on arrive ici, et un fond dessiné à l'échelle zéro est
    // invisible pour toujours.
    quandMesurable(cadre, async () => {
      const l = cadre.clientWidth, h = cadre.clientHeight;
      if (!l || !h) return;

      // On couvre le cadre : on prend la plus grande des deux échelles, quitte à
      // déborder, plutôt que de laisser des bandes vides.
      const vp1 = page.getViewport({ scale: 1 });
      const echelle = Math.max(l / vp1.width, h / vp1.height);
      const vp = page.getViewport({ scale: echelle });
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      c.classList.add('garde-fond--pret');
    });
  } catch (err) {
    // Sans fond, la couverture reste parfaitement lisible : le voile et le
    // papier crème suffisent. On ne casse rien.
    console.info('Fond de couverture indisponible :', err.message);
  }
}

// Attendre qu'un élément ait une largeur avant de le mesurer. Les feuillets sont
// remplis AVANT que la page bouge — c'est ce qui évite qu'une page arrive vide en
// pleine animation — mais à cet instant page-flip garde encore les pages non
// visibles hors du flux : clientWidth vaut 0, et un manuscrit dessiné à cette
// échelle-là est un rectangle blanc.
function quandMesurable(el, faire) {
  if (el.clientWidth > 0) return faire();
  const obs = new ResizeObserver(() => {
    if (el.clientWidth > 0) { obs.disconnect(); faire(); }
  });
  obs.observe(el);
  // Filet : on n'observe pas un élément indéfiniment s'il n'apparaît jamais.
  setTimeout(() => obs.disconnect(), 15000);
}

// La page à dessiner est passée en argument : plusieurs manuscrits sont montés en
// même temps depuis que les feuillets voisins sont préparés d'avance, et un
// getElementById aurait dessiné la recette d'à côté.
function renderPDF(url, racine) {
  if (!window.pdfjsLib || !racine) return;
  pdfjsLib.getDocument({ url }).promise
    .then(pdf => pdf.getPage(1))
    .then(page => {
      const c = racine.querySelector('.pdf-thumb');
      if (!c) return;
      const container = c.closest('.photo-inner');
      quandMesurable(container, () => {
        const availW = container.clientWidth - 8;
        const naturalVp = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: availW / naturalVp.width });
        c.width = vp.width;
        c.height = vp.height;
        page.render({ canvasContext: c.getContext('2d'), viewport: vp });
      });
    })
    .catch(() => {
      const fb = racine.querySelector('.pdf-fallback');
      const th = racine.querySelector('.pdf-thumb');
      if (fb) fb.style.display = 'flex';
      if (th) th.style.display = 'none';
    });
}

// ── DOCUMENTS DE LA RECETTE ───────────────────────────────────────────────────
// Manuscrits et photos passent par recipe_documents + recipe_document_links.
// Les anciennes colonnes photo1_url / photo2_url que lisait ce fichier
// n'existaient pas en base : la fonctionnalité photo n'a jamais pu marcher.

async function loadDocuments(recipeId) {
  try {
    return await sb(`recipe_document_links?select=display_order,page_label,recipe_documents(id,kind,public_url,caption,byte_size)&recipe_id=eq.${recipeId}&order=display_order`);
  } catch (err) {
    console.error('Documents indisponibles :', err.message);
    return [];
  }
}

// Un même feuillet peut porter plusieurs recettes : deux versions des
// madeleines, la crème anglaise à côté des œufs au lait, les deux gratins de
// Caro, les deux Banoffee. Quatre documents sont déjà dans ce cas.
//
// On renvoie TOUTES les recettes du feuillet, la courante comprise : la barre de
// sous-onglets a besoin de savoir laquelle est active. Une liste à un seul
// élément signifie « feuillet non partagé », et rien ne s'affiche.
async function recettesDuFeuillet(docs, recipeId) {
  const ids = [...new Set((docs || []).map(d => d.recipe_documents?.id).filter(Boolean))];
  if (!ids.length) return [];
  try {
    const liens = await sb(`recipe_document_links?select=recipe_id&document_id=in.(${ids.join(',')})`);
    const toutes = [...new Set(liens.map(l => l.recipe_id))]
      .map(id => allRecipes.find(r => r.id === id))
      .filter(Boolean);
    if (toutes.length < 2) return [];
    // Dans l'ordre du livre, pour que les onglets ne changent pas de place selon
    // la page depuis laquelle on les regarde.
    return toutes
      .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
      .map(r => ({ id: r.id, title: r.title, actif: r.id === recipeId }));
  } catch (err) {
    console.info('Recettes du feuillet indisponibles :', err.message);
    return [];
  }
}

// ── UPLOAD PHOTOS ─────────────────────────────────────────────────────────────

async function compressImage(file, maxWidth = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = Math.min(img.naturalWidth, maxWidth);
      const h = img.naturalHeight * (w / img.naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Compression échouée'));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Chargement image échoué')); };
    img.src = url;
  });
}

// L'ancienne fonction d'envoi de photo a été retirée : elle écrivait dans
// photo1_url / photo2_url, colonnes qui n'ont jamais existé en base, et
// déposait dans un bucket sans aucune règle d'écriture. Elle échouait donc en
// silence depuis toujours.
//
// À reconstruire sur les nouvelles tables :
//   1. envoyer le fichier compressé dans le bucket recipe-photos ;
//   2. insérer une ligne dans recipe_documents (kind = 'dish_photo',
//      uploaded_by = auth.uid()) ;
//   3. la rattacher via recipe_document_links.
// La base, les règles RLS et le storage sont prêts depuis la migration
// 20260810141500_documents_et_photos.sql. compressImage reste ci-dessus, elle
// n'a aucune dépendance au schéma et servira telle quelle.


// ── NAVIGATION ────────────────────────────────────────────────────────────────

// ── LE LIVRE ─────────────────────────────────────────────────────────────────
//
// Le tournage de page appartient à page-flip (voir vendor/README.md) : c'est lui
// qui plie la feuille, dessine son ombre et la pose de l'autre côté. Deux
// versions maison ont échoué avant, parce qu'une demi-page rigide qui pivote sur
// une charnière ne ressemble pas à une page de livre, quel que soit l'angle.
//
// Ce qui suit ne fait que le lien entre ses feuillets et nos recettes :
//
//   feuillet 0 → la page de garde        feuillet 1 → le menu
//   feuillet 2 + 2i → recette i, texte   feuillet 3 + 2i → recette i, manuscrit
//
// Une recette occupe donc une double page, et un seul tour de feuille passe d'une
// recette entière à la suivante — exactement la lecture qu'on avait déjà.
//
// En dessous de cette largeur, pas de flipbook du tout : un feuillet a une hauteur
// fixe, ce qui rognerait les recettes sur un téléphone. Le livre reprend alors les
// deux pages empilées et la lecture au défilement (voir styles.css, le mode sans
// data-flip).
const LARGEUR_LIVRE_OUVERT = 900;

let livreFlip = null;        // instance page-flip, ou null en lecture empilée
let feuillets = [];          // les éléments de page, dans l'ordre du livre
let enTrainDeTourner = false;
let arriveeEnCours = false;  // une double est en train d'être posée sur le papier
let livrePerime = true;      // la liste des recettes a changé : il faut remonter

// Un seul endroit pour dire « la liste des recettes affichées vient de changer ».
// Le nombre de feuillets en dépend, donc le livre doit être refabriqué.
function majFilteredRecipes() {
  filteredRecipes = applyFilterLogic();
  livrePerime = true;
}

function pageDuSpread(idx) { return idx < 0 ? 0 : 2 + idx * 2; }
function pagesDe(idx) {
  const n = pageDuSpread(idx);
  return { gauche: feuillets[n], droite: feuillets[n + 1] };
}

// La durée reste un choix de design : elle vit dans le token, on la lui passe.
function dureeTourne() {
  const brut = getComputedStyle(document.documentElement)
    .getPropertyValue('--tourne-duration').trim();
  const n = parseFloat(brut);
  const ms = !n ? 720 : (brut.endsWith('ms') ? n : n * 1000);
  // La règle CSS globale sur prefers-reduced-motion ne peut rien contre une
  // animation dessinée en JavaScript : c'est donc ici qu'on écoute le réglage.
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : ms;
}

// page-flip emporte notre conteneur avec lui quand on le démonte : son destroy()
// finit par un block.remove() sur l'élément qu'on lui avait confié. Sans ça, le
// premier retour au menu après un filtre laissait un livre sans page et une
// erreur « Cannot set properties of null ». On le refabrique donc à l'identique.
function conteneurLivre() {
  const existant = document.getElementById('flipbook');
  if (existant) return existant;
  const livre = document.createElement('div');
  livre.id = 'flipbook';
  livre.className = 'book';
  livre.setAttribute('role', 'region');
  livre.setAttribute('aria-label', 'Pages du livre');
  document.querySelector('.book-cadre').prepend(livre);
  return livre;
}

function construireFeuillets() {
  const livre = conteneurLivre();
  livre.innerHTML = '';
  feuillets = [];
  const ajoute = (balise, classe, aria) => {
    const el = document.createElement(balise);
    el.className = 'page ' + classe;
    el.setAttribute('aria-label', aria);
    livre.appendChild(el);
    feuillets.push(el);
  };
  // Ces deux-là portent un nom : sur téléphone la garde se réduit à un bandeau de
  // titre pour que le menu soit visible à l'ouverture (voir styles.css).
  ajoute('article', 'page-left page--garde', 'Page de garde');
  ajoute('aside', 'page-right page--menu', 'Sommaire du livre');
  filteredRecipes.forEach(r => {
    ajoute('article', 'page-left', `Recette : ${r.title}`);
    ajoute('aside', 'page-right', 'Manuscrit et détails de la recette');
  });
}

// Fabrique le livre puis va au bon endroit. Appelé au démarrage et chaque fois
// qu'un filtre change le nombre de recettes.
async function monterLivre(idx) {
  if (livreFlip) {
    try { livreFlip.destroy(); } catch { /* déjà démonté, rien à faire */ }
    livreFlip = null;
  }
  construireFeuillets();          // refabrique le conteneur si destroy l'a emporté
  const livre = conteneurLivre();
  remplirCouverture();

  if (window.innerWidth < LARGEUR_LIVRE_OUVERT || !window.St?.PageFlip) {
    livre.removeAttribute('data-flip');
    return arriverA(idx, { animer: false });
  }

  livreFlip = new St.PageFlip(livre, {
    width: 600, height: 860,          // proportions de départ, corrigées par size
    size: 'stretch',
    minWidth: 320, maxWidth: 700, minHeight: 420, maxHeight: 1500,
    maxShadowOpacity: 0.4,
    flippingTime: dureeTourne(),
    showCover: false,
    // Jamais une page à la fois : sous LARGEUR_LIVRE_OUVERT on n'arrive pas ici.
    usePortrait: false,
    mobileScrollSupport: false,
    // Un clic sur la page ne doit pas la tourner : elle est pleine de boutons, de
    // liens et de tuiles. On garde en revanche l'attrapage du coin à la souris.
    disableFlipByClick: true,
    clickEventForward: ['a', 'button', 'input', 'label', 'canvas', 'summary'],
  });
  livreFlip.loadFromHTML(feuillets);
  livre.dataset.flip = 'on';

  // On écoute la bibliothèque au lieu de tenir un compteur en double : elle sait
  // où on est, y compris quand le lecteur attrape un coin de page à la souris.
  livreFlip.on('flip', e => surArrivee(Math.floor(e.data / 2) - 1));
  livreFlip.on('changeState', e => { enTrainDeTourner = e.data === 'flipping'; });

  return arriverA(idx, { animer: false });
}

// Le contenu est posé AVANT que la feuille bouge : une page qui arrive vide
// pendant l'animation ruinerait tout l'effet.
async function remplirSpread(idx, force = false) {
  if (idx < 0) return remplirCouverture();
  const r = filteredRecipes[idx];
  const { gauche, droite } = pagesDe(idx);
  if (!r || !gauche || !droite) return;
  if (!force && gauche.dataset.recette === String(r.id)) return;

  gauche.dataset.recette = String(r.id);
  droite.dataset.recette = String(r.id);
  gauche.innerHTML = `<div class="loading-state">…</div>`;
  droite.innerHTML = `<div class="loading-state"></div>`;
  try {
    const [lHTML, docs] = await Promise.all([renderLeft(r), loadDocuments(r.id)]);
    const surLeFeuillet = await recettesDuFeuillet(docs, r.id);
    gauche.innerHTML = lHTML;
    droite.innerHTML = renderRight(r, docs, surLeFeuillet);
    const manuscrit = docs.find(d => d.recipe_documents?.kind === 'manuscript')?.recipe_documents;
    if (manuscrit) renderPDF(manuscrit.public_url, droite);
  } catch (err) {
    console.error('Erreur chargement recette :', err);
    gauche.innerHTML = `<div class="loading-state">Impossible de charger la recette.</div>`;
    droite.innerHTML = `<div class="loading-state"></div>`;
    delete gauche.dataset.recette;   // pour réessayer au prochain passage
    delete droite.dataset.recette;
  }
}

// Les doubles d'à côté sont montées d'avance : le lecteur peut attraper un coin
// de page à tout moment, et il ne doit jamais tomber sur du papier blanc.
function preparerVoisines(idx) {
  [idx - 1, idx + 1].forEach(v => {
    if (v < 0 || v >= filteredRecipes.length) return;
    remplirSpread(v).catch(() => {});
    const r = filteredRecipes[v];
    sb(`recipe_ingredients?select=*,ingredients(name)&recipe_id=eq.${r.id}&order=display_order`).catch(() => {});
    sb(`recipe_steps?select=*&recipe_id=eq.${r.id}&order=step_number`).catch(() => {});
  });
}

// Sans page-flip, c'est une classe qui décide de la double visible.
function marquerCourante(idx) {
  const n = pageDuSpread(idx);
  feuillets.forEach((el, i) => el.classList.toggle('page--courante', i === n || i === n + 1));
}

// Tout ce qui suit une arrivée, quelle qu'en soit la cause : nos flèches, le
// clavier, le sommaire, ou un coin de page attrapé à la souris.
function surArrivee(idx) {
  currentIndex = idx;
  const r = filteredRecipes[idx];
  // Le slug plutôt que l'identifiant : un lien envoyé par message devient
  // lisible (#choucroute-denise au lieu de #9).
  if (idx < 0) history.replaceState(null, '', location.pathname);
  else if (r) history.replaceState(null, '', '#' + (r.slug || r.id));
  if (!livreFlip) marquerCourante(idx);
  updateControls();
  if (idx < 0) renderGardeFond();
  preparerVoisines(idx);
}

async function arriverA(idx, { animer = false, force = false } = {}) {
  if (livrePerime) { livrePerime = false; return monterLivre(idx); }
  // Le contenu est chargé depuis le réseau : sans ce verrou, deux clics rapprochés
  // lanceraient deux arrivées, et la seconde tournerait la page avant que la
  // première ait fini d'écrire dessus.
  if (arriveeEnCours) return;
  arriveeEnCours = true;
  try {
    await remplirSpread(idx, force);
    if (livreFlip) {
      const n = pageDuSpread(idx);
      if (animer) livreFlip.flip(n); else livreFlip.turnToPage(n);
    }
    surArrivee(idx);
  } finally {
    arriveeEnCours = false;
  }
}

// Franchir la largeur charnière change de mode de lecture : au-dessus le livre se
// feuillette, en dessous il se déroule. On remonte alors, sans quoi on resterait
// avec des feuillets à hauteur fixe sur un écran étroit — ou l'inverse.
window.matchMedia(`(min-width: ${LARGEUR_LIVRE_OUVERT}px)`).addEventListener('change', () => {
  if (!feuillets.length) return;
  monterLivre(currentIndex);
});

// Le nom d'avant, gardé : une quinzaine d'endroits l'appellent pour sauter à une
// recette (sommaire, recherche, hasard, favoris). Un saut ne s'anime pas — on ne
// va pas tourner soixante feuilles pour aller de la première à la dernière.
function showPage(idx, options) { return arriverA(idx, options); }

// Feuilleter d'une double à la suivante. La couverture est la double -1 : ouvrir
// le livre et revenir au menu sont donc le même geste que tourner une page, et
// il n'y a plus de cas particulier à écrire.
function changePage(dir) {
  if (enTrainDeTourner) return;
  const suivant = currentIndex + dir;
  if (suivant < -1 || suivant >= filteredRecipes.length) return;
  if (suivant < 0) remplirCouverture();   // le menu compte les favoris : on le refait
  return arriverA(suivant, { animer: true });
}

function updateControls() {
  const atCover = currentIndex === -1;
  document.getElementById('prevBtn').disabled = atCover;
  document.getElementById('nextBtn').disabled = currentIndex >= filteredRecipes.length - 1;

  // Le nom de la recette d'à côté. Sur téléphone les flèches sont devenues une
  // barre en fin de recette : « Suivante » seul ne dit pas où l'on va, alors que
  // le titre donne une raison de tourner la page. Masqué sur grand écran, où les
  // flèches restent deux pastilles sur les bords.
  const nomVoisin = i => (i === -1 ? 'Le menu du livre' : (filteredRecipes[i]?.title || ''));
  document.getElementById('prevTitre').textContent = atCover ? '' : nomVoisin(currentIndex - 1);
  document.getElementById('nextTitre').textContent = nomVoisin(currentIndex + 1);
  document.getElementById('pageCounter').textContent = atCover
    ? `i\u202f/\u202fii`
    : `${currentIndex + 1}\u202f/\u202f${filteredRecipes.length}`;
}

// ── FILTRES ───────────────────────────────────────────────────────────────────

// Les filtres restreignent le livre. La recherche, elle, ne le touche plus :
// elle ouvre un panneau de résultats et fait sauter à une recette. Mélanger les
// deux obligeait à devinerce qui avait disparu du livre et pourquoi.
function applyFilterLogic() {
  return allRecipes.filter(r => {
    if (catFilter === 'fav') return getFavs().includes(r.id);
    return catFilter === 0 || r.category_id === catFilter;
  });
}

function applyFilter() {
  majFilteredRecipes();
  currentIndex = -1;
  if (document.body.classList.contains('gallery-mode')) {
    showGallery();
  } else {
    showCover();
  }
  buildTOC();
}

// ── RECHERCHE ─────────────────────────────────────────────────────────────────

function openSearch() {
  document.getElementById('searchOverlay').classList.add('open');
  const champ = document.getElementById('search');
  champ.focus();
  champ.select();
  runSearch();
}
function closeSearch() { document.getElementById('searchOverlay').classList.remove('open'); }
function closeSearchOutside(e) { if (e.target === document.getElementById('searchOverlay')) closeSearch(); }

function surligne(texte, q) {
  const i = texte.toLowerCase().indexOf(q);
  if (i < 0) return texte;
  return texte.slice(0, i) + '<mark>' + texte.slice(i, i + q.length) + '</mark>' + texte.slice(i + q.length);
}

// Renvoie la RAISON de la correspondance, pas seulement un booléen : c'est tout
// l'intérêt du panneau. La recherche par ingrédient existait déjà mais restait
// invisible.
function correspondance(r, q) {
  if (r.title.toLowerCase().includes(q)) return { type: 'titre', libelle: 'dans le titre' };
  const tag = (r.tags || []).find(t => t.toLowerCase().includes(q));
  if (tag) return { type: 'tag', libelle: `mot-clé · ${tag}` };
  const ingr = (ingrByRecipe.get(r.id) || []).find(n => n.toLowerCase().includes(q));
  if (ingr) return { type: 'ingredient', libelle: `ingrédient · ${ingr}` };
  return null;
}

function runSearch() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  const hote = document.getElementById('searchResults');
  const compteur = document.getElementById('searchCount');

  if (q.length < 2) {
    compteur.textContent = '';
    hote.innerHTML = '<p class="search-empty">Tape au moins deux lettres. La recherche regarde les titres, les mots-clés et les ingrédients.</p>';
    return;
  }

  const trouves = [];
  allRecipes.forEach((r, i) => {
    const c = correspondance(r, q);
    if (c) trouves.push({ r, i, ...c });
  });

  compteur.textContent = trouves.length + (trouves.length > 1 ? ' résultats' : ' résultat');

  if (!trouves.length) {
    hote.innerHTML = `<p class="search-empty">Rien pour « ${q} ». Essaie un ingrédient, ou un mot du titre.</p>`;
    return;
  }

  // Groupés par catégorie, dans l'ordre du livre.
  const parCat = new Map();
  trouves.forEach(t => {
    const k = t.r.category_id || 0;
    if (!parCat.has(k)) parCat.set(k, []);
    parCat.get(k).push(t);
  });
  const cles = [...parCat.keys()].sort((a, b) => (CAT_ORDER[a] ?? 99) - (CAT_ORDER[b] ?? 99));

  hote.innerHTML = cles.map(k => {
    const titre = `${CAT_EMOJI[k] || ''} ${CATS[k] || 'Autre'}`.trim();
    const lignes = parCat.get(k).map(t => {
      const src = laMain(t.r);
      return `
        <button class="search-item" onclick="goToResult(${t.i})">
          <span class="search-item-title">${t.type === 'titre' ? surligne(t.r.title, q) : t.r.title}</span>
          ${src ? `<span class="search-item-src">${src}</span>` : ''}
          <span class="search-why">${t.libelle}</span>
        </button>`;
    }).join('');
    return `<div class="search-group">${titre}</div>${lignes}`;
  }).join('');
}

// Un résultat peut être hors du filtre courant : on élargit plutôt que de faire
// semblant que la recette n'existe pas.
function goToResult(indexGlobal) {
  const r = allRecipes[indexGlobal];
  closeSearch();
  let idx = filteredRecipes.findIndex(x => x.id === r.id);
  if (idx < 0) {
    catFilter = 0;
    document.querySelectorAll('#tocFilters .cat-btn').forEach(b => {
      const actif = b.dataset.cat === '0';
      b.classList.toggle('active', actif);
      b.setAttribute('aria-pressed', String(actif));
    });
    majFilteredRecipes();
    buildTOC();
    idx = filteredRecipes.findIndex(x => x.id === r.id);
  }
  if (idx >= 0) showPage(idx);
}

let searchTimer;
document.getElementById('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});

// Les boutons de filtre sont construits depuis recipe_categories. Les six
// catégories existaient en base avec leur emoji et leur ordre, mais le HTML n'en
// affichait que quatre en dur : 11 recettes (Gibier, Accompagnements) n'étaient
// atteignables que par « Toutes ».
function brancherFiltres() {
  const nav = document.getElementById('tocFilters');
  if (!nav) return;
  nav.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      nav.querySelectorAll('.cat-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      const val = btn.dataset.cat;
      catFilter = val === 'fav' ? 'fav' : parseInt(val);
      applyFilter();
    });
  });
}

function construireFiltres(cats) {
  CATS_LISTE = cats || [];
  const nav = document.getElementById('tocFilters');
  if (!nav) return;
  if (!cats.length) return brancherFiltres();

  cats.forEach(c => {
    CATS[c.id] = c.name;
    CAT_ORDER[c.id] = c.display_order ?? c.id;
    if (c.emoji) CAT_EMOJI[c.id] = c.emoji;
  });

  // L'effectif derrière chaque filtre : c'est ce qui rend visible qu'il n'y a
  // qu'une seule recette de gibier, et 48 desserts.
  const compte = id => allRecipes.filter(r => r.category_id === id).length;
  const nbFavs = getFavs().length;

  nav.innerHTML = [
    `<button class="cat-btn active" data-cat="0" aria-pressed="true">Toutes <span class="cat-n">${allRecipes.length}</span></button>`,
    ...cats
      // Une catégorie vide n'a pas de raison d'occuper un bouton.
      .filter(c => compte(c.id) > 0)
      .map(c => `<button class="cat-btn" data-cat="${c.id}" aria-pressed="false">${c.emoji || ''} ${c.name} <span class="cat-n">${compte(c.id)}</span></button>`),
    `<button class="cat-btn" data-cat="fav" aria-pressed="false">★ Favoris${nbFavs ? ` <span class="cat-n">${nbFavs}</span>` : ''}</button>`
  ].join('');

  brancherFiltres();
}

// ── TABLE DES MATIÈRES (overlay) ──────────────────────────────────────────────

// ── L'INDEX ───────────────────────────────────────────────────────────────────
// Un livre de cuisine sert deux publics : celui qui cherche une recette précise
// et celui qui a un ingrédient sous la main et veut une idée. C'est la raison
// pour laquelle les livres imprimés mettent un sommaire par chapitre devant et
// un ou plusieurs index derrière. On fait pareil, avec un sélecteur d'axe.
//
// Cinq axes possibles, vérifiés contre les données :
//   chapitre 122/122 · alpha 122/122 · ingrédient 122/122
//   main 117/122 · temps 120/122
// L'axe « saison » est impossible : la colonne existe mais elle est vide.

let axeIndex = 'chapitre';

// Deux seuils PLUTÔT qu'une liste d'exclusion tenue à la main. Les indexeurs
// professionnels excluent les ingrédients « non substantiels » ; ici la donnée
// décide, et le réglage se corrige tout seul quand la collection grandit.
const INGR_MIN_RECETTES = 2;    // un ingrédient qui ne sert qu'une fois n'indexe rien
const INGR_MAX_PART = 0.25;     // au-delà d'un quart du livre, c'est un fond de placard

function indexParChapitre() {
  const groupes = new Map();
  filteredRecipes.forEach((r, i) => {
    const k = r.category_id || 0;
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push({ r, i });
  });
  return [...groupes.keys()]
    .sort((a, b) => (CAT_ORDER[a] ?? 99) - (CAT_ORDER[b] ?? 99))
    .map(k => ({
      titre: `${CAT_EMOJI[k] || ''} ${CATS[k] || 'Autre'}`.trim(),
      compte: groupes.get(k).length,
      items: groupes.get(k)
    }));
}

function indexAlpha() {
  const groupes = new Map();
  filteredRecipes.forEach((r, i) => {
    // Sans accents : sinon « Épaule » et « Escalope » se retrouvent séparés.
    const lettre = (r.title || '?').normalize('NFD').replace(/[\u0300-\u036f]/g, '')[0].toUpperCase();
    if (!groupes.has(lettre)) groupes.set(lettre, []);
    groupes.get(lettre).push({ r, i });
  });
  return [...groupes.keys()].sort().map(l => ({
    titre: l, compte: groupes.get(l).length,
    items: groupes.get(l).sort((a, b) => a.r.title.localeCompare(b.r.title, 'fr'))
  }));
}

function indexParIngredient() {
  const parIngr = new Map();
  filteredRecipes.forEach((r, i) => {
    const vus = new Set();
    (ingrByRecipe.get(r.id) || []).forEach(nom => {
      const cle = nom.toLowerCase().trim();
      if (!cle || vus.has(cle)) return;   // un ingrédient listé deux fois dans la même recette ne compte qu'une
      vus.add(cle);
      if (!parIngr.has(cle)) parIngr.set(cle, { nom, items: [] });
      parIngr.get(cle).items.push({ r, i });
    });
  });
  const plafond = Math.max(3, Math.floor(filteredRecipes.length * INGR_MAX_PART));
  return [...parIngr.values()]
    .filter(g => g.items.length >= INGR_MIN_RECETTES && g.items.length <= plafond)
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
    .map(g => ({
      titre: g.nom, compte: g.items.length,
      items: g.items.sort((a, b) => a.r.title.localeCompare(b.r.title, 'fr'))
    }));
}

function indexParMain() {
  const groupes = new Map();
  filteredRecipes.forEach((r, i) => {
    const main = laMain(r) || 'Sans provenance';
    if (!groupes.has(main)) groupes.set(main, []);
    groupes.get(main).push({ r, i });
  });
  return [...groupes.entries()]
    // Les plus fournies d'abord : c'est ce qui montre qui a le plus nourri le livre.
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'fr'))
    .map(([main, items]) => ({ titre: main, compte: items.length, items }));
}

const TRANCHES_TEMPS = [
  { max: 30,       titre: 'Moins de 30 minutes' },
  { max: 60,       titre: 'De 30 minutes à 1 heure' },
  { max: 120,      titre: "D'une heure à deux heures" },
  { max: Infinity, titre: 'Plus de deux heures' }
];

function indexParTemps() {
  const groupes = TRANCHES_TEMPS.map(t => ({ titre: t.titre, items: [] }));
  const sans = [];
  filteredRecipes.forEach((r, i) => {
    const t = (r.prep_time_minutes || 0) + (r.cook_time_minutes || 0);
    if (!t) return sans.push({ r, i });
    groupes[TRANCHES_TEMPS.findIndex(x => t <= x.max)].items.push({ r, i });
  });
  // Les 2 recettes sans durée sont montrées à part plutôt qu'escamotées.
  if (sans.length) groupes.push({ titre: 'Durée non renseignée', items: sans });
  return groupes.filter(g => g.items.length).map(g => ({ ...g, compte: g.items.length }));
}

function buildTOC() {
  const corps = document.getElementById('tocBody');
  if (!corps) return;

  const constructeurs = {
    chapitre: indexParChapitre, alpha: indexAlpha,
    ingredient: indexParIngredient, main: indexParMain, temps: indexParTemps
  };
  const groupes = (constructeurs[axeIndex] || indexParChapitre)();

  if (!groupes.length) {
    corps.innerHTML = '<p class="index-vide">Rien à afficher pour ce filtre.</p>';
    return;
  }

  // L'axe ingrédient mérite un mot d'explication : ses seuils écartent
  // volontairement des entrées, et un index silencieusement tronqué mentirait.
  let entete = '';
  if (axeIndex === 'ingredient') {
    const plafond = Math.max(3, Math.floor(filteredRecipes.length * INGR_MAX_PART));
    entete = `<p class="index-aide">${groupes.length} ingrédients retenus : ceux qui apparaissent dans au moins ${INGR_MIN_RECETTES} recettes et dans moins de ${plafond}. Le sel, le beurre ou le poivre sont dans presque tout, ils n'aident pas à choisir.</p>`;
  }

  corps.innerHTML = entete + groupes.map(g => `
    <div class="index-groupe">
      <div class="index-tete">
        <span class="index-titre">${g.titre}</span>
        <span class="index-n">${g.compte}</span>
      </div>
      <div class="index-liste">
        ${g.items.map(({ r, i }) => `
          <button class="index-item" onclick="goToRecipe(${i})">
            <span class="index-dot" style="background:${CAT_COLORS[r.category_id] || 'var(--color-rule)'}"></span>
            <span class="index-item-t">${r.title}</span>
          </button>`).join('')}
      </div>
    </div>`).join('');
}

// Le sélecteur d'axe. Délégation sur le document : le panneau est reconstruit.
document.addEventListener('click', e => {
  const b = e.target.closest('.axe-btn');
  if (!b) return;
  document.querySelectorAll('.axe-btn').forEach(x => {
    const actif = x === b;
    x.classList.toggle('active', actif);
    x.setAttribute('aria-selected', String(actif));
  });
  axeIndex = b.dataset.axe;
  buildTOC();
});

function goToRecipe(i) { closeTOC(); showPage(i); }

// Sauter vers une recette par son identifiant, en élargissant le filtre si elle
// en est exclue : un renvoi qui ne mène nulle part serait pire que pas de renvoi.
function allerVersRecette(id) {
  let idx = filteredRecipes.findIndex(r => r.id === id);
  if (idx < 0) {
    appliquerFiltre(0);
    idx = filteredRecipes.findIndex(r => r.id === id);
  }
  if (idx >= 0) showPage(idx);
}
function openTOC() { document.getElementById('tocOverlay').classList.add('open'); }
function closeTOC() { document.getElementById('tocOverlay').classList.remove('open'); }
function closeTOCOutside(e) { if (e.target === document.getElementById('tocOverlay')) closeTOC(); }

// ── DÉPÔT D'UNE RECETTE ───────────────────────────────────────────────────────
// L'ancien formulaire demandait de retaper le titre, la catégorie, les
// ingrédients et les étapes. Personne ne recopie à la main une fiche qu'il a déjà
// sous les yeux : c'est exactement le travail que le livre est censé éviter.
//
// On ne demande donc plus rien. On prend le document — la photo du feuillet ou
// son PDF — et c'est l'administrateur qui le transcrit à la relecture. Le titre
// provisoire vient du nom de fichier, l'auteur du compte connecté.

const DEPOT_MAX_PAGES = 12;
const DEPOT_MAX_OCTETS = 15 * 1024 * 1024;
const DEPOT_TYPES_OK = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/i;

let depot = [];          // [{ cle, file, apercu }]
let depotEnCours = false;

function openSubmit() {
  document.getElementById('submitOverlay').classList.add('open');
  reprendreDepot();
}

// Un envoi en cours ne doit pas pouvoir être interrompu par une touche Échap ou
// un clic à côté : les fichiers seraient perdus en vol. Le garde est ici, dans la
// seule fonction que tous les chemins de fermeture traversent.
function closeSubmit() {
  if (depotEnCours) return;
  document.getElementById('submitOverlay').classList.remove('open');
}
function closeSubmitOutside(e) {
  if (e.target === document.getElementById('submitOverlay')) closeSubmit();
}

function ouvrirSelecteur(id) { document.getElementById(id).click(); }

function fichiersChoisis(input) {
  ajouterAuDepot(input.files);
  // Sans ça, rechoisir le même fichier après l'avoir retiré ne déclenche
  // aucun évènement : le navigateur considère que la valeur n'a pas changé.
  input.value = '';
}

function messageDepot(texte, type) {
  const zone = document.getElementById('submitFeedback');
  if (!zone) return;
  zone.textContent = texte;
  zone.className = 'submit-feedback' + (type ? ' submit-feedback--' + type : '');
}

function poids(octets) {
  return octets >= 1024 * 1024
    ? (octets / (1024 * 1024)).toFixed(1).replace('.', ',') + ' Mo'
    : Math.max(1, Math.round(octets / 1024)) + ' ko';
}

// Le nom de fichier fait un titre provisoire honnête : « tarte-tatin-mamie.jpg »
// devient « Tarte tatin mamie ». Un « IMG_4821 » restera moche, mais il sera
// corrigé à la relecture, et c'est toujours mieux qu'une ligne sans nom.
function titreDepuisNom(nom) {
  const base = nom.replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return 'Recette sans titre';
  return (base[0].toUpperCase() + base.slice(1)).slice(0, 120);
}

// Une vraie vignette, pas une icône de type de fichier : elle permet de voir
// avant d'envoyer que la photo est nette et que la page n'est pas coupée.
async function apercuDe(file) {
  if (file.type === 'application/pdf') {
    if (!window.pdfjsLib) return null;
    try {
      const donnees = new Uint8Array(await file.arrayBuffer());
      const pdf = await pdfjsLib.getDocument({ data: donnees }).promise;
      const page = await pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      const vp = page.getViewport({ scale: 220 / vp1.width });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      return canvas.toDataURL('image/jpeg', 0.7);
    } catch (err) {
      console.info('Aperçu PDF indisponible :', err.message);
      return null;
    }
  }
  // Les images passent par une URL d'objet : rien n'est décodé deux fois.
  return URL.createObjectURL(file);
}

async function ajouterAuDepot(liste) {
  const refuses = [];
  const candidats = [];

  for (const file of liste) {
    if (!DEPOT_TYPES_OK.test(file.type)) { refuses.push(`${file.name} n'est ni une image ni un PDF`); continue; }
    if (file.size > DEPOT_MAX_OCTETS)    { refuses.push(`${file.name} pèse ${poids(file.size)}, la limite est 15 Mo`); continue; }
    const cle = `${file.name}|${file.size}`;
    if (depot.some(d => d.cle === cle) || candidats.some(c => c.cle === cle)) continue;  // déposé deux fois
    if (depot.length + candidats.length >= DEPOT_MAX_PAGES) { refuses.push(`${file.name} : ${DEPOT_MAX_PAGES} pages au maximum par recette`); continue; }
    candidats.push({ cle, file });
  }

  for (const c of candidats) {
    depot.push({ ...c, apercu: await apercuDe(c.file), etat: 'attente' });
    majDepot();
  }

  if (refuses.length) messageDepot('✗ ' + refuses.join('. ') + '.', 'err');
  else if (candidats.length) messageDepot('');
}

function retirerDuDepot(cle) {
  const i = depot.findIndex(d => d.cle === cle);
  if (i < 0) return;
  // Libérer l'URL d'objet, sinon le fichier reste en mémoire tant que l'onglet
  // est ouvert.
  if (depot[i].apercu?.startsWith('blob:')) URL.revokeObjectURL(depot[i].apercu);
  // Cas d'un échec partiel : la page était déjà partie. On la reprend au
  // stockage, sinon elle y resterait sans jamais être rattachée à une recette —
  // le livre a déjà 18 Mo de fichiers orphelins, on n'en ajoute pas.
  if (depot[i].chemin) {
    sbClient?.storage.from('recipe-photos').remove([depot[i].chemin])
      .catch(err => console.info('Fichier orphelin non retiré :', err.message));
  }
  depot.splice(i, 1);
  majDepot();
}

function viderDepot() {
  oublierBrouillon();
  depot.forEach(d => { if (d.apercu?.startsWith('blob:')) URL.revokeObjectURL(d.apercu); });
  depot = [];
  majDepot();
}

const DEPOT_ETATS = { attente: '', envoi: 'envoi…', ok: '✓ envoyée' };

function majDepot() {
  sauverBrouillon();
  const hote = document.getElementById('depotListe');
  const envoi = document.getElementById('depotEnvoi');
  const zone = document.getElementById('depotZone');
  if (!hote || !envoi) return;

  hote.innerHTML = depot.map((d, i) => `
    <div class="depot-page${d.etat === 'ok' ? ' depot-page--ok' : ''}">
      <span class="depot-vignette">
        ${d.apercu
          ? `<img src="${d.apercu}" alt="">`
          : `<span class="depot-vignette-vide" aria-hidden="true">PDF</span>`}
      </span>
      <span class="depot-page-info">
        <span class="depot-page-rang">Page ${i + 1}</span>
        <span class="depot-page-nom">${d.file.name}</span>
        <span class="depot-page-poids">${poids(d.file.size)}</span>
      </span>
      ${depotEnCours
        // Pendant l'envoi, l'avancement de CHAQUE page remplace le bouton
        // Retirer : retirer une page à moitié partie n'aurait aucun sens, et sur
        // huit feuillets on veut voir où on en est.
        ? `<span class="depot-page-etat">${DEPOT_ETATS[d.etat] || ''}</span>`
        : `<button class="depot-retirer" onclick="retirerDuDepot('${d.cle.replace(/'/g, "\\'")}')"
                   aria-label="Retirer ${d.file.name}">Retirer</button>`}
    </div>`).join('');

  // Le bouton disparaît quand il n'y a rien à envoyer, au lieu de rester gris.
  // Un bouton principal désactivé sans explication est le symptôme d'une
  // interface qui a l'air en panne.
  envoi.hidden = depot.length === 0;
  envoi.disabled = depotEnCours;
  if (!depotEnCours) {
    envoi.textContent = depot.length > 1
      ? `Envoyer au livre — ${depot.length} pages`
      : 'Envoyer au livre';
  }

  // Pendant l'envoi, la zone de dépôt ne doit plus inviter à ajouter des pages
  // qui ne partiraient pas avec le lot.
  if (zone) zone.classList.toggle('depot--muet', depotEnCours);
}

// ── L'ÉTAT D'APRÈS-ENVOI ──────────────────────────────────────────────────────
// Le panneau restait sur la zone de dépôt vidée, avec un bouton principal gris et
// pour seule sortie la croix en haut à droite : rien ne disait que c'était fini,
// ni ce qui allait se passer, ni comment continuer. Une confirmation remplace
// donc le dépôt, et elle porte les deux suites possibles.

function afficherConfirmation(pages) {
  const vue = document.getElementById('depotVue');
  const fini = document.getElementById('depotFini');
  if (!vue || !fini) return;

  fini.innerHTML = `
    <div class="depot-fini-marque" aria-hidden="true">✓</div>
    <p class="depot-fini-titre">${pages > 1 ? `${pages} pages reçues` : 'Recette reçue'}</p>
    <p class="depot-fini-texte">
      Le feuillet est en sécurité dans le livre. Il sera transcrit à la main, puis
      la recette apparaîtra à sa place dans le chapitre qui lui revient.
    </p>
    <div class="depot-fini-actions">
      <button class="submit-form-btn" onclick="reprendreDepot()">Ajouter une autre recette</button>
      <button class="bar-btn" onclick="closeSubmit()">Retourner au livre</button>
    </div>`;

  vue.hidden = true;
  fini.hidden = false;
  // Le lecteur d'écran doit annoncer la confirmation, et le clavier repartir
  // d'ici et non du haut du panneau.
  fini.focus();
}

function reprendreDepot() {
  const vue = document.getElementById('depotVue');
  const fini = document.getElementById('depotFini');
  if (fini) { fini.hidden = true; fini.innerHTML = ''; }
  if (vue) vue.hidden = false;
  messageDepot('');
  majDepot();
}

// ── ÉTAPE 2 : LIRE LE DOCUMENT ────────────────────────────────────────────────
// Un aperçu de la page du livre suppose un titre, des ingrédients, des étapes.
// Depuis une photo, il faut donc transcrire — sinon « corriger » redeviendrait
// « saisir », ce qu'on vient justement d'enlever.
//
// Deux chemins, du moins cher au plus cher :
//   1. un PDF qui contient déjà son texte est lu ici même, par pdf.js, sans
//      réseau et sans modèle. C'est le cas de tout ce qui vient d'un site ou
//      d'un export de traitement de texte ;
//   2. une photo ou un scan part vers /api/transcrire, où le serveur interroge
//      le modèle. La clé reste sur le serveur.
// Si le serveur n'a pas de clé, un analyseur local prend le relais sur le texte
// et l'aperçu s'ouvre quand même : on ne bloque jamais le dépôt.

// Un feuillet peut porter plusieurs recettes : on relit une LISTE, et l'onglet
// courant dit laquelle est à l'écran. brouillon reste la recette affichée, pour
// que la saisie déléguée n'ait pas à savoir qu'il y en a d'autres.
let brouillons = [];
let apercuIndex = 0;
let brouillon = null;

async function texteDuPdf(file) {
  if (!window.pdfjsLib) return '';
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let texte = '';
    for (let n = 1; n <= Math.min(pdf.numPages, 8); n++) {
      const contenu = await (await pdf.getPage(n)).getTextContent();
      // Les éléments arrivent morceau par morceau : on recompose les lignes en
      // regardant la position verticale, sinon tout se retrouve sur une ligne.
      let ligneY = null, ligne = [];
      const lignes = [];
      contenu.items.forEach(it => {
        const y = Math.round(it.transform[5]);
        if (ligneY !== null && Math.abs(y - ligneY) > 3) { lignes.push(ligne.join('')); ligne = []; }
        ligneY = y;
        ligne.push(it.str);
      });
      if (ligne.length) lignes.push(ligne.join(''));
      texte += lignes.join('\n') + '\n';
    }
    return texte.trim();
  } catch (err) {
    console.info('Texte du PDF illisible :', err.message);
    return '';
  }
}

// Une page de PDF rendue en JPEG, pour les scans qui n'ont aucun texte.
async function pdfEnImage(file) {
  if (!window.pdfjsLib) return null;
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, 1600 / vp1.width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  } catch (err) {
    console.info('Rendu du PDF impossible :', err.message);
    return null;
  }
}

function enBase64(blob) {
  return new Promise((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result).split(',')[1]);
    lecteur.onerror = () => reject(new Error('lecture impossible'));
    lecteur.readAsDataURL(blob);
  });
}

// Repli sans modèle : on devine la structure d'un texte déjà extrait. Une ligne
// qui commence par un nombre ou une unité est un ingrédient, une phrase longue
// est une étape. C'est grossier, mais l'aperçu reste corrigeable, ce qui vaut
// mieux qu'une page vide.
const UNITES = /^(\d+[\d,./ ]*)?\s*(g|kg|mg|l|cl|dl|ml|c\.? ?[às]\.? ?[cs]\.?|cuill[eè]res?|cuill[eè]re|pinc[ée]es?|sachets?|gousses?|tranches?|verres?|tasses?|feuilles?|branches?|brins?|boîtes?|pots?|noix|zeste)\b/i;

function structurerTexte(texte) {
  const lignes = texte.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const recette = { ingredients: [], steps: [], lisibilite: 'partielle', incertitudes: [] };
  if (!lignes.length) return recette;

  recette.title = lignes[0].slice(0, 120);
  lignes.slice(1).forEach(l => {
    const estIngredient = UNITES.test(l) || (/^\d/.test(l) && l.length < 60);
    if (estIngredient && l.length < 90) {
      const m = l.match(/^([\d,./]+)?\s*([^\d]*)$/);
      recette.ingredients.push({
        quantity: m?.[1] ? parseFloat(m[1].replace(',', '.')) : null,
        name: (m?.[2] || l).trim()
      });
    } else if (l.length > 25) {
      recette.steps.push({ description: l });
    }
  });
  recette.incertitudes.push('Découpage fait sans transcription automatique : vérifie chaque ligne.');
  return recette;
}

function recetteVide(nom) {
  return {
    title: titreDepuisNom(nom),
    ingredients: [], steps: [],
    lisibilite: 'illisible',
    incertitudes: ['Rien n\'a pu être lu automatiquement : la page est à remplir à la main.']
  };
}

async function analyserDepot() {
  if (!depot.length || depotEnCours) return;
  if (!isApproved()) return messageDepot('✗ Ton accès doit être validé avant d\'ajouter une recette.', 'err');

  depotEnCours = true;
  const bouton = document.getElementById('depotEnvoi');
  bouton.textContent = 'Lecture…';
  majDepot();
  messageDepot('Lecture du document…');

  try {
    // 1. Le texte déjà présent dans les PDF, gratuitement.
    let texte = '';
    for (const d of depot) {
      if (d.file.type === 'application/pdf') texte += (await texteDuPdf(d.file)) + '\n';
    }
    texte = texte.trim();

    // 2. Ce qu'aucun texte ne décrit part au modèle.
    const pages = [];
    for (const d of depot) {
      if (d.file.type.startsWith('image/')) {
        let blob = d.file, mime = d.file.type;
        try { blob = await compressImage(d.file, 1600, 0.85); mime = 'image/jpeg'; }
        catch { /* format non décodable : on tente l'original */ }
        if (/^image\/(jpeg|png|webp)$/.test(mime)) pages.push({ mime, data: await enBase64(blob) });
      } else if (d.file.type === 'application/pdf' && !texte) {
        const data = await pdfEnImage(d.file);
        if (data) pages.push({ mime: 'image/jpeg', data });
      }
    }

    let lues = null;
    if (texte || pages.length) {
      const { data: { session } } = await sbClient.auth.getSession();
      const r = await fetch('/api/transcrire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ texte: texte || undefined, pages })
      });

      if (r.ok) {
        lues = (await r.json()).recettes;
      } else {
        const { erreur } = await r.json().catch(() => ({}));
        // Chaque cas dit ce qui s'est passé ET ce qu'on fait à la place : une
        // erreur muette laisserait croire que le dépôt a échoué.
        const explication = {
          'transcription-non-configuree': 'La lecture automatique n\'est pas encore branchée',
          'quota-modele-epuise':          'Le quota gratuit de lecture est épuisé pour aujourd\'hui',
          'quota-horaire-atteint':        'Trop de lectures dans l\'heure',
          'delai-depasse':                'La lecture a pris trop de temps',
          'acces-refuse':                 'Ton accès n\'autorise pas la lecture automatique'
        }[erreur] || 'La lecture automatique a échoué';
        lues = [texte ? structurerTexte(texte) : recetteVide(depot[0].file.name)];
        messageDepot(`${explication} — la page s'ouvre à corriger à la main.`, 'err');
      }
    } else {
      lues = [recetteVide(depot[0].file.name)];
    }

    ouvrirApercu(lues);
  } catch (err) {
    console.error('Lecture impossible :', err);
    messageDepot('✗ ' + err.message + '. Tu peux réessayer, les pages restent en place.', 'err');
  } finally {
    depotEnCours = false;
    majDepot();
  }
}

// ── ÉTAPE 3 : L'APERÇU CORRIGEABLE ────────────────────────────────────────────
// L'aperçu n'est pas un formulaire déguisé : c'est la page telle qu'elle sera
// dans le livre, avec les mêmes polices, la même mise en page, les mêmes
// colonnes. Chaque élément est modifiable sur place. On corrige ce qu'on voit.

// Rapprocher un nom de chapitre de son identifiant. C'était une égalité stricte,
// et le serveur envoyait des noms abrégés (« Desserts ») qui ne correspondaient à
// aucun chapitre réel (« Desserts & Pâtisseries ») : quatre chapitres sur six
// retombaient à vide. Le serveur envoie maintenant les vrais noms, mais on tolère
// quand même l'à-peu-près — accents, casse, et le premier mot avant le « & » —
// pour qu'un renommage de chapitre ne re-casse pas le rangement en silence.
function chapitreId(nom) {
  if (!nom) return null;
  const propre = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                       .toLowerCase().split('&')[0].replace(/[^a-z]/g, '');
  const cible = propre(String(nom));
  if (!cible) return null;
  const trouve = Object.keys(CATS).find(id => propre(CATS[id]) === cible);
  return trouve ? parseInt(trouve, 10) : null;
}

// Pas de classement automatique du chapitre sans modèle : mesuré, et écarté.
// Idée testée : comparer la nouvelle recette aux 122 déjà classées et lui donner le
// chapitre de celles qui lui ressemblent. Évalué « une contre toutes les autres »
// sur tout le livre, en faisant varier le signal (ingrédients communs, mots du
// titre, les deux) et le seuil de décision :
//
//   ingrédients seuls  38 % de justes,  6 % de FAUX, 57 % laissés vides
//   titre + ingrédients 51 % de justes, 11 % de FAUX
//   titre seul          52 % de justes, 20 % de FAUX
//
// Et les erreurs sont précisément celles qu'un humain ne fait pas : « Coques à la
// Meunière » rangé en Plats au lieu de Poissons, « Faisan Farci » en Plats au lieu
// de Gibier. La ressemblance d'ingrédients ne voit pas ce qui fonde un chapitre —
// le rôle du plat dans le repas et sa famille — elle ne voit que du contenu.
//
// Le calcul est asymétrique : remplir juste économise UN clic sur un menu déroulant
// déjà sous les yeux dans l'aperçu, tandis que remplir faux range une recette dans
// le mauvais chapitre sans que personne aille le vérifier. Un champ vide se voit,
// un champ faux ne se voit pas. On laisse donc la personne choisir.

function normaliserRecette(r) {
  return {
    title:              r.title || '',
    description:        r.description || '',
    // Idempotente : un brouillon repris depuis IndexedDB porte déjà category_id,
    // et plus le nom de chapitre rendu par le modèle. Sans ce ?? la reprise
    // effaçait le chapitre choisi.
    category_id:        r.category_id ?? chapitreId(r.category),
    attribution:        r.attribution || '',
    servings:           r.servings || null,
    servings_unit:      r.servings_unit || 'personnes',
    prep_time_minutes:  r.prep_time_minutes || null,
    cook_time_minutes:  r.cook_time_minutes || null,
    rest_time_minutes:  r.rest_time_minutes || null,
    difficulty:         r.difficulty || null,
    notes:              r.notes || '',
    tags:               Array.isArray(r.tags) ? r.tags : [],
    ingredients:        (r.ingredients || []).map(i => ({
                          quantity: i.quantity ?? null, unit: i.unit || '',
                          name: i.name || '', preparation: i.preparation || '',
                          group_label: i.group_label || ''
                        })),
    steps:              (r.steps || []).map(s => ({
                          title: s.title || '', description: s.description || '',
                          duration_minutes: s.duration_minutes || null
                        })),
    // Les groupes sont-ils des variantes alternatives (tuiles, une seule ouverte)
    // ou les parties d'un même plat (affichées ensemble) ? Le modèle le dit
    // désormais : il a lu la fiche, il sait si chaque nom de groupe désigne un plat
    // entier. C'était forcé à false, donc une page de salades composées importée
    // perdait sa présentation en tuiles. L'aperçu garde la bascule pour arbitrer,
    // et la valeur survit à la reprise d'un brouillon.
    groups_are_variants: !!r.groups_are_variants,
    lisibilite:         r.lisibilite || 'partielle',
    incertitudes:       r.incertitudes || []
  };
}

function ouvrirApercu(lues) {
  brouillons = (Array.isArray(lues) ? lues : [lues]).map(normaliserRecette);
  if (!brouillons.length) brouillons = [normaliserRecette({})];
  apercuIndex = 0;
  brouillon = brouillons[0];
  document.getElementById('depotVue').hidden = true;
  document.getElementById('depotFini').hidden = true;
  document.getElementById('submitPanel').classList.add('submit-panel--large');
  dessinerApercu();
  document.getElementById('depotApercu').hidden = false;
}

function fermerApercu() {
  document.getElementById('depotApercu').hidden = true;
  document.getElementById('submitPanel').classList.remove('submit-panel--large');
  brouillons = [];
  brouillon = null;
  reprendreDepot();
}

function allerRecette(i) {
  if (!brouillons[i]) return;
  apercuIndex = i;
  brouillon = brouillons[i];
  dessinerApercu();
}

// Jeter une recette que le modèle a vue là où il n'y en avait pas : un sous-titre
// pris pour un titre, une note de bas de feuillet.
function jeterRecette() {
  if (brouillons.length <= 1) return;
  brouillons.splice(apercuIndex, 1);
  allerRecette(Math.max(0, apercuIndex - 1));
}

// L'inverse : le modèle a découpé ce qui n'est qu'une liste de variantes. On
// verse la recette courante dans la précédente, et son titre devient le nom du
// groupe d'ingrédients — c'est exactement la forme d'une page « Salades
// composées ». Rien n'est perdu, mais l'opération ne se défait pas d'un clic.
function fusionnerDansPrecedente() {
  if (apercuIndex === 0) return;
  const cible = brouillons[apercuIndex - 1];
  const source = brouillons[apercuIndex];
  const nomGroupe = source.title.trim() || 'Variante';

  // La cible n'avait pas de groupes : ses ingrédients prennent son propre titre,
  // sinon les deux listes se mélangeraient en une seule bouillie.
  if (!cible.ingredients.some(i => i.group_label)) {
    const sien = cible.title.trim() || 'Base';
    cible.ingredients.forEach(i => { i.group_label = sien; });
  }
  source.ingredients.forEach(i => cible.ingredients.push({ ...i, group_label: i.group_label || nomGroupe }));
  source.steps.forEach(st => cible.steps.push({ ...st, title: st.title || nomGroupe }));
  cible.incertitudes = [...cible.incertitudes, ...source.incertitudes];
  // Fusionner deux recettes en groupes, c'est par définition fabriquer des
  // variantes : la page se lira en tuiles.
  cible.groups_are_variants = true;

  brouillons.splice(apercuIndex, 1);
  allerRecette(apercuIndex - 1);
}

const LISIBILITE = {
  bonne:     { mot: 'Lecture nette',        ton: 'ok' },
  partielle: { mot: 'Lecture incertaine',   ton: 'attention' },
  illisible: { mot: 'Presque rien n\'a été lu', ton: 'err' }
};

function dessinerApercu() {
  // Toute retouche structurelle passe ici : c'est le bon endroit pour graver.
  sauverBrouillon();
  const hote = document.getElementById('depotApercu');
  if (!hote || !brouillon) return;
  const b = brouillon;
  const main = currentMember?.display_name || currentUser?.email || '';
  const l = LISIBILITE[b.lisibilite] || LISIBILITE.partielle;

  const chapitres = Object.keys(CATS)
    .sort((x, y) => (CAT_ORDER[x] ?? 99) - (CAT_ORDER[y] ?? 99))
    .map(id => `<option value="${id}"${String(b.category_id) === id ? ' selected' : ''}>${CAT_EMOJI[id] || ''} ${CATS[id]}</option>`)
    .join('');

  // Les incertitudes du modèle sont montrées telles quelles : elles disent où
  // regarder. Un aperçu qui aurait l'air sûr de lui serait pire qu'aucun aperçu.
  const doutes = b.incertitudes.length ? `
    <details class="apercu-doutes" open>
      <summary>${b.incertitudes.length} passage${b.incertitudes.length > 1 ? 's' : ''} à vérifier</summary>
      <ul>${b.incertitudes.map(i => `<li>${echapper(i)}</li>`).join('')}</ul>
    </details>` : '';

  // Un feuillet peut porter plusieurs recettes. Les onglets ne s'affichent que
  // dans ce cas : un onglet unique serait une décoration trompeuse.
  const onglets = brouillons.length > 1 ? `
    <div class="apercu-multi">
      <p class="apercu-multi-t">Ce feuillet porte ${brouillons.length} recettes. Vérifie-les une par une : elles partageront le même feuillet dans le livre.</p>
      <div class="apercu-onglets" role="tablist">
        ${brouillons.map((x, i) => `
          <button class="apercu-onglet${i === apercuIndex ? ' apercu-onglet--actif' : ''}"
                  role="tab" aria-selected="${i === apercuIndex}" onclick="allerRecette(${i})">
            <span class="apercu-onglet-n">${i + 1}</span>
            <span class="apercu-onglet-t">${echapper(x.title || 'sans titre')}</span>
          </button>`).join('')}
      </div>
    </div>` : '';

  hote.innerHTML = `
    <div class="apercu-tete">
      <div>
        <p class="apercu-tete-t">Voilà la page telle qu'elle entrera dans le livre</p>
        <p class="apercu-tete-d">Tout est modifiable ici. Rien n'est publié avant que tu le décides.</p>
      </div>
      <span class="apercu-etat apercu-etat--${l.ton}">${l.mot}</span>
    </div>
    ${onglets}
    ${doutes}

    <div class="apercu-spread">
      <div class="apercu-page">
        <select class="apercu-cat" data-champ="category_id" aria-label="Chapitre">
          <option value="">— chapitre —</option>${chapitres}
        </select>

        <input class="apercu-titre" data-champ="title" value="${echapper(b.title)}"
               placeholder="Nom de la recette" aria-label="Nom de la recette">

        <p class="apercu-provenance">
          <span class="apercu-main">de la main de ${echapper(main)}</span>
          <span class="apercu-sep">·</span>
          <input class="apercu-selon" data-champ="attribution" value="${echapper(b.attribution)}"
                 placeholder="d'après Bocuse, un site, un magazine…" aria-label="D'après">
        </p>

        <textarea class="apercu-desc" data-champ="description" rows="2"
                  placeholder="Une phrase de présentation, si la fiche en donne une">${echapper(b.description)}</textarea>

        <div class="apercu-meta">
          <label>Pour <input type="number" min="1" max="60" data-champ="servings" value="${b.servings ?? ''}" placeholder="?"></label>
          <input class="apercu-unite" data-champ="servings_unit" value="${echapper(b.servings_unit)}" aria-label="Unité de portion">
          <label>Prép. <input type="number" min="0" max="999" data-champ="prep_time_minutes" value="${b.prep_time_minutes ?? ''}" placeholder="?"> min</label>
          <label>Cuisson <input type="number" min="0" max="999" data-champ="cook_time_minutes" value="${b.cook_time_minutes ?? ''}" placeholder="?"> min</label>
          <label>Repos <input type="number" min="0" max="9999" data-champ="rest_time_minutes" value="${b.rest_time_minutes ?? ''}" placeholder="?"> min</label>
        </div>

        <div class="apercu-colonnes">
          <div>
            <div class="col-header">Ingrédients</div>
            ${groupesIngredients(b).filter(g => g.nom).length >= 2 ? `
              <label class="apercu-bascule">
                <input type="checkbox" data-champ="groups_are_variants" ${b.groups_are_variants ? 'checked' : ''}>
                <span>
                  Ces groupes sont des <strong>variantes</strong> : on en cuisine une seule.
                  <span class="apercu-bascule-d">${b.groups_are_variants
                    ? 'Dans le livre, la page étalera une tuile par variante ; cliquer sur l\'une l\'agrandit et rétrécit les autres. Ici tout reste visible pour que tu puisses corriger.'
                    : 'Laisse décoché si les groupes sont les parties d\'un même plat — Marinade, Pâte, Garniture — à afficher ensemble.'}</span>
                </span>
              </label>` : ''}
            ${groupesIngredients(b).map(bloc => `
              <div class="apercu-groupe">
                ${bloc.nom || groupesIngredients(b).length > 1 ? `
                  <input class="apercu-groupe-nom" data-groupe="${echapper(bloc.nom)}"
                         value="${echapper(bloc.nom)}" placeholder="Nom du groupe"
                         aria-label="Nom du groupe d'ingrédients">` : ''}
                <div class="apercu-lignes">
                  ${bloc.lignes.map(({ ing, i }) => `
                    <div class="apercu-ingr">
                      <input class="apercu-q" data-liste="ingredients" data-i="${i}" data-cle="quantity"
                             value="${ing.quantity ?? ''}" placeholder="—" aria-label="Quantité">
                      <input data-liste="ingredients" data-i="${i}" data-cle="unit"
                             value="${echapper(ing.unit)}" placeholder="unité" aria-label="Unité">
                      <input data-liste="ingredients" data-i="${i}" data-cle="name"
                             value="${echapper(ing.name)}" placeholder="ingrédient" aria-label="Ingrédient">
                      <button class="apercu-moins" onclick="retirerLigne('ingredients', ${i})" aria-label="Retirer cet ingrédient">✕</button>
                    </div>`).join('')}
                </div>
                <button class="apercu-plus" onclick="ajouterLigne('ingredients', '${echapper(bloc.nom).replace(/'/g, "\\'")}')">+ un ingrédient</button>
              </div>`).join('')}
            <button class="apercu-plus apercu-plus--groupe" onclick="ajouterGroupe()">+ un groupe</button>
          </div>

          <div>
            <div class="col-header">Préparation</div>
            <div class="apercu-lignes">
              ${b.steps.map((s, i) => `
                <div class="apercu-etape">
                  <span class="apercu-rang">${i + 1}</span>
                  <div class="apercu-etape-corps">
                    <input class="apercu-etape-t" data-liste="steps" data-i="${i}" data-cle="title"
                           value="${echapper(s.title)}" placeholder="Titre de l'étape (facultatif)" aria-label="Titre de l'étape">
                    <textarea class="apercu-etape-d" data-liste="steps" data-i="${i}" data-cle="description"
                              rows="3" placeholder="Ce qu'il faut faire">${echapper(s.description)}</textarea>
                  </div>
                  <button class="apercu-moins" onclick="retirerLigne('steps', ${i})" aria-label="Retirer cette étape">✕</button>
                </div>`).join('')}
            </div>
            <button class="apercu-plus" onclick="ajouterLigne('steps')">+ une étape</button>
          </div>
        </div>

        <textarea class="apercu-notes" data-champ="notes" rows="2"
                  placeholder="Notes, variantes, souvenirs — facultatif">${echapper(b.notes)}</textarea>
      </div>

      <div class="apercu-feuillets">
        <p class="apercu-feuillets-t">${depot.length > 1 ? depot.length + ' feuillets' : 'Le feuillet'} sur la page de droite</p>
        ${depot.map(d => `
          <span class="apercu-feuillet">
            ${d.apercu ? `<img src="${d.apercu}" alt="">` : '<span class="depot-vignette-vide">PDF</span>'}
          </span>`).join('')}
        <p class="apercu-feuillets-d">L'écriture d'origine reste dans le livre, à côté de la recette recopiée.</p>
      </div>
    </div>

    <div class="apercu-actions">
      <button class="bar-btn" onclick="fermerApercu()">Revenir au dépôt</button>
      ${brouillons.length > 1 ? `
        <button class="bar-btn" onclick="jeterRecette()">Jeter cette recette</button>
        ${apercuIndex > 0 ? `<button class="bar-btn" onclick="fusionnerDansPrecedente()"
          title="Ses ingrédients rejoignent la recette précédente, sous son nom">Fusionner dans la précédente</button>` : ''}` : ''}
      <button class="submit-form-btn" id="apercuPublier" onclick="publierRecette()">
        ${brouillons.length > 1 ? `Ajouter les ${brouillons.length} recettes au livre` : 'Ajouter au livre'}
      </button>
    </div>
    <div id="apercuMessage" class="submit-feedback" aria-live="polite"></div>`;
}

// Le texte vient d'un modèle et d'un nom de fichier : sans échappement, un
// guillemet coupe l'attribut et un chevron injecte du balisage.
function echapper(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Saisie déléguée : on écrit dans le brouillon sans redessiner, sinon le champ
// perdrait le curseur à chaque frappe.
document.addEventListener('input', e => {
  const el = e.target;
  if (!brouillon || !el.closest('#depotApercu')) return;

  // Les noms de groupe sont traités sur « change », pas ici.
  if (el.dataset.groupe !== undefined) return;

  const nombre = el.type === 'number';
  if (el.dataset.liste) {
    const ligne = brouillon[el.dataset.liste][el.dataset.i];
    if (!ligne) return;
    ligne[el.dataset.cle] = el.dataset.cle === 'quantity'
      ? (parseFloat(String(el.value).replace(',', '.')) || null)
      : el.value;
    return;
  }
  if (el.dataset.champ) {
    if (el.type === 'checkbox') {
      brouillon[el.dataset.champ] = el.checked;
      dessinerApercu();   // l'explication sous la case change de sens
      return;
    }
    brouillon[el.dataset.champ] = nombre || el.dataset.champ === 'category_id'
      ? (parseInt(el.value, 10) || null)
      : el.value;
  }
  sauverBrouillon();
});

// La donnée reste plate, comme en base : une liste d'ingrédients qui portent
// chacun leur group_label. Le regroupement est fait à l'affichage, dans l'ordre
// de première apparition — c'est l'ordre du feuillet.
function groupesIngredients(b) {
  const blocs = [];
  b.ingredients.forEach((ing, i) => {
    const nom = ing.group_label || '';
    let bloc = blocs.find(x => x.nom === nom);
    if (!bloc) { bloc = { nom, lignes: [] }; blocs.push(bloc); }
    bloc.lignes.push({ ing, i });
  });
  if (!blocs.length) blocs.push({ nom: '', lignes: [] });
  return blocs;
}

function ajouterLigne(liste, groupe) {
  brouillon[liste].push(liste === 'ingredients'
    ? { quantity: null, unit: '', name: '', preparation: '', group_label: groupe || '' }
    : { title: '', description: '', duration_minutes: null });
  dessinerApercu();
  // Le curseur va dans la ligne qu'on vient de créer : sans ça il faut viser à
  // la souris après chaque ajout.
  const dernier = brouillon[liste].length - 1;
  const cle = liste === 'ingredients' ? 'quantity' : 'description';
  document.querySelector(`#depotApercu [data-liste="${liste}"][data-i="${dernier}"][data-cle="${cle}"]`)?.focus();
}

// « Pour la pâte » / « Pour la garniture », ou les huit salades d'une page de
// variantes. Un groupe n'existe que s'il a au moins une ligne, la donnée étant
// plate : on en crée donc une, vide.
function ajouterGroupe() {
  const n = groupesIngredients(brouillon).filter(g => g.nom).length + 1;
  const nom = `Groupe ${n}`;
  brouillon.ingredients.push({ quantity: null, unit: '', name: '', preparation: '', group_label: nom });
  dessinerApercu();
  const champ = document.querySelector(`#depotApercu [data-groupe="${nom}"]`);
  champ?.focus();
  champ?.select();
}

// Renommer un groupe renomme toutes ses lignes. Sur « change » et non « input » :
// à chaque frappe, l'ancien nom servant de clé, le groupe se scinderait.
document.addEventListener('change', e => {
  const el = e.target;
  if (!brouillon || !el.dataset || el.dataset.groupe === undefined) return;
  if (!el.closest('#depotApercu')) return;
  const avant = el.dataset.groupe;
  const apres = el.value.trim();
  brouillon.ingredients.forEach(i => { if ((i.group_label || '') === avant) i.group_label = apres; });
  dessinerApercu();
});

function retirerLigne(liste, i) {
  brouillon[liste].splice(i, 1);
  dessinerApercu();
}

// ── ÉTAPE 4 : LA PUBLICATION ──────────────────────────────────────────────────
// Publication directe : les quinze membres sont approuvés un par un à la main,
// la confiance est donc accordée à l'entrée du livre. La correction se fait
// après coup, par la main de la recette ou par un administrateur.
//
// Cinq écritures, dans cet ordre, parce que chacune dépend de la précédente :
//   recipes → ingredients (vocabulaire) → recipe_ingredients → recipe_steps
//   → recipe_documents + recipe_document_links

function messageApercu(texte, type) {
  const zone = document.getElementById('apercuMessage');
  if (!zone) return;
  zone.textContent = texte;
  zone.className = 'submit-feedback' + (type ? ' submit-feedback--' + type : '');
}

// ── LE BROUILLON SURVIT À LA FERMETURE ───────────────────────────────────────
// Tout vivait dans la mémoire de la page : un onglet fermé, un téléphone qui
// recycle l'onglet, un rechargement par réflexe, et la photo comme les
// corrections disparaissaient. Il fallait reprendre la photo du feuillet.
//
// IndexedDB et pas localStorage : une photo de feuillet fait plusieurs mégaoctets
// et ferait sauter le quota de localStorage, qui ne stocke d'ailleurs que du
// texte. IndexedDB accepte les fichiers tels quels.
//
// Rien ne part sur le réseau : c'est un brouillon, il reste sur l'appareil de la
// personne jusqu'à ce qu'elle publie.

const BROUILLON_BASE = 'livre-recettes-brouillon';
const BROUILLON_MAGASIN = 'depots';
const BROUILLON_CLE = 'courant';

function ouvrirBaseBrouillon() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error('IndexedDB indisponible'));
    const requete = indexedDB.open(BROUILLON_BASE, 1);
    requete.onupgradeneeded = () => {
      const base = requete.result;
      if (!base.objectStoreNames.contains(BROUILLON_MAGASIN)) base.createObjectStore(BROUILLON_MAGASIN);
    };
    requete.onsuccess = () => resolve(requete.result);
    requete.onerror = () => reject(requete.error);
  });
}

function transactionBrouillon(mode, action) {
  return ouvrirBaseBrouillon().then(base => new Promise((resolve, reject) => {
    const tx = base.transaction(BROUILLON_MAGASIN, mode);
    const r = action(tx.objectStore(BROUILLON_MAGASIN));
    tx.oncomplete = () => { base.close(); resolve(r?.result); };
    tx.onerror = () => { base.close(); reject(tx.error); };
  }));
}

// Écriture groupée : la saisie déclenche un événement par touche, on ne va pas
// réécrire les photos à chaque lettre.
let sauvegardeEnAttente = null;

function sauverBrouillon() {
  if (!brouillons.length && !depot.length) return;
  clearTimeout(sauvegardeEnAttente);
  sauvegardeEnAttente = setTimeout(async () => {
    try {
      await transactionBrouillon('readwrite', magasin => magasin.put({
        enregistreLe: Date.now(),
        apercuIndex,
        brouillons,
        // Les fichiers partent tels quels ; l'aperçu se régénère à la reprise.
        depot: depot.map(p => ({
          cle: p.cle, file: p.file, chemin: p.chemin, url: p.url, taille: p.taille
        }))
      }, BROUILLON_CLE));
    } catch (err) {
      // Un brouillon non sauvé ne doit jamais empêcher de continuer à saisir.
      console.info('Brouillon non sauvegardé :', err.message);
    }
  }, 400);
}

function oublierBrouillon() {
  clearTimeout(sauvegardeEnAttente);
  return transactionBrouillon('readwrite', m => m.delete(BROUILLON_CLE)).catch(() => {});
}

// Au démarrage : s'il reste un brouillon, on le PROPOSE, on ne le rouvre pas de
// force. Quelqu'un qui vient lire une recette ne doit pas retomber sur son dépôt
// de la semaine dernière.
async function proposerBrouillon() {
  let garde;
  try { garde = await transactionBrouillon('readonly', m => m.get(BROUILLON_CLE)); }
  catch { return; }
  const aDesRecettes = !!garde?.brouillons?.length;
  if (!aDesRecettes && !garde?.depot?.length) return;

  const titre = aDesRecettes
    ? (garde.brouillons[0].title?.trim() || 'une recette sans nom')
    : (garde.depot.length > 1 ? `${garde.depot.length} feuillets` : 'un feuillet');
  const quand = new Date(garde.enregistreLe);
  const jour = quand.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

  const barre = document.createElement('div');
  barre.className = 'reprise';
  barre.setAttribute('role', 'status');
  barre.innerHTML = `
    <span class="reprise-t">Tu avais commencé « ${echapper(titre)} » le ${jour}.</span>
    <button class="reprise-oui" type="button">Reprendre</button>
    <button class="reprise-non" type="button">Jeter</button>`;
  document.body.appendChild(barre);

  barre.querySelector('.reprise-non').onclick = async () => {
    await oublierBrouillon();
    barre.remove();
  };
  barre.querySelector('.reprise-oui').onclick = () => {
    barre.remove();
    depot = (garde.depot || []).map(p => ({
      ...p,
      // L'aperçu est une URL de mémoire : elle ne survit pas au rechargement, on
      // la refabrique depuis le fichier conservé.
      apercu: p.file ? URL.createObjectURL(p.file) : null
    }));
    apercuIndex = garde.apercuIndex || 0;
    openSubmit();
    majDepot();
    // Sans recette lue, on rouvre à l'étape du dépôt : la personne relance la
    // lecture elle-même, ce qui évite de consommer une lecture sans l'avoir voulu.
    if (aDesRecettes) ouvrirApercu(garde.brouillons);
  };
}

async function publierRecette() {
  if (!brouillons.length || depotEnCours) return;

  // Le titre est la seule chose vraiment obligatoire : c'est lui qui porte le
  // permalien, l'index alphabétique et le sommaire. On saute sur la recette
  // fautive plutôt que de laisser deviner laquelle bloque.
  const sansTitre = brouillons.findIndex(b => !b.title.trim());
  if (sansTitre >= 0) {
    allerRecette(sansTitre);
    return messageApercu('✗ Il manque le nom de cette recette.', 'err');
  }

  depotEnCours = true;
  const bouton = document.getElementById('apercuPublier');
  if (bouton) { bouton.disabled = true; bouton.textContent = 'Publication…'; }

  // Ce qui vient d'être envoyé dans le bucket pendant CET essai. Si la suite
  // échoue, on le retire : sans ça, chaque tentative ratée laisse un fichier
  // orphelin dans le Storage — c'est l'origine des 18 Mo déjà présents.
  const deposesMaintenant = [];

  try {
    // 1. Les feuillets montent d'abord : un fichier ne peut pas vivre dans une
    // transaction SQL. Un feuillet déjà monté lors d'un essai précédent n'est pas
    // renvoyé — c'est la seule partie qui survit à un échec, volontairement.
    for (let i = 0; i < depot.length; i++) {
      if (depot[i].url) continue;
      messageApercu(depot.length > 1 ? `Feuillet ${i + 1} / ${depot.length}…` : 'Le feuillet…');
      await envoyerFeuillet(depot[i], i);
      deposesMaintenant.push(depot[i].chemin);
    }

    // 2. Puis TOUT le reste en une seule transaction, côté base : la page, les
    // ingrédients, les étapes, les liens vers les feuillets, pour chaque recette
    // du lot. Soit l'ensemble existe, soit rien n'existe. C'est ce qui rend un
    // nouvel essai sans danger : avant, réessayer après un échec à mi-chemin
    // republiait ce qui avait déjà réussi.
    messageApercu(brouillons.length > 1
      ? `Création des ${brouillons.length} pages…` : 'Création de la page…');

    const { data: identifiants, error } = await sbClient.rpc('publier_feuillet', {
      feuillets: depot.map(p => ({
        kind: 'manuscript', bucket_id: 'recipe-photos',
        object_path: p.chemin, public_url: p.url,
        byte_size: String(p.taille ?? p.file.size)
      })),
      recettes: brouillons.map(b => ({
        title: b.title, category_id: b.category_id, description: b.description,
        attribution: b.attribution, hand: currentMember?.display_name || currentUser.email,
        servings: b.servings, servings_unit: b.servings_unit,
        prep_time_minutes: b.prep_time_minutes, cook_time_minutes: b.cook_time_minutes,
        rest_time_minutes: b.rest_time_minutes, difficulty: b.difficulty,
        tags: b.tags, notes: b.notes, groups_are_variants: !!b.groups_are_variants,
        ingredients: b.ingredients, steps: b.steps
      }))
    });
    if (error) throw new Error(error.message);
    if (!identifiants?.length) throw new Error('la base n\'a créé aucune page');

    // Publié : le brouillon sauvegardé n'a plus de raison d'être.
    // L'ORDRE COMPTE. viderDepot() appelle majDepot(), qui appelle
    // sauverBrouillon() : si les brouillons étaient encore en mémoire à cet
    // instant, la sauvegarde repartait juste après avoir été effacée, et la
    // prochaine ouverture du site aurait proposé de reprendre une recette déjà
    // publiée. On vide donc la mémoire AVANT, et on efface le disque APRÈS.
    depotEnCours = false;
    brouillons = [];
    brouillon = null;
    viderDepot();
    await oublierBrouillon();
    document.getElementById('depotApercu').hidden = true;
    document.getElementById('submitPanel').classList.remove('submit-panel--large');
    // Le livre se recharge et s'ouvre sur la première page créée. C'est la
    // récompense : on voit sa recette prendre sa place, indexée partout.
    await rechargerLivre(identifiants[0]);
  } catch (err) {
    console.error('Publication impossible :', err);

    // Rien n'a été écrit en base — la fonction est tout-ou-rien. On retire donc
    // les fichiers montés à l'instant, pour que le bucket reste propre et qu'un
    // nouvel essai reparte de zéro.
    for (const chemin of deposesMaintenant) {
      const page = depot.find(p => p.chemin === chemin);
      try {
        await sbClient.storage.from('recipe-photos').remove([chemin]);
        if (page) { delete page.url; delete page.chemin; delete page.taille; }
      } catch (menage) {
        console.info('Feuillet non retiré du bucket :', menage.message);
      }
    }

    messageApercu('✗ ' + err.message + '. Rien n\'a été enregistré, ta saisie est intacte : tu peux réessayer.', 'err');
    depotEnCours = false;
    if (bouton) {
      bouton.disabled = false;
      bouton.textContent = brouillons.length > 1
        ? `Ajouter les ${brouillons.length} recettes au livre` : 'Ajouter au livre';
    }
  }
}

async function envoyerFeuillet(page, i) {
  let corps = page.file, type = page.file.type;
  let ext = (page.file.name.match(/\.[^.]+$/) || ['.bin'])[0];
  if (type.startsWith('image/')) {
    try { corps = await compressImage(page.file, 1600, 0.85); type = 'image/jpeg'; ext = '.jpg'; }
    catch (err) { console.info('Compression impossible, envoi de l\'original :', err.message); }
  }
  const chemin = `feuillets/${currentUser.id}/${Date.now()}-${i + 1}${ext}`;
  const { error } = await sbClient.storage.from('recipe-photos')
    .upload(chemin, corps, { contentType: type, upsert: false });
  if (error) throw new Error(`${page.file.name} : ${error.message}`);
  page.chemin = chemin;
  page.taille = corps.size ?? page.file.size;
  page.url = sbClient.storage.from('recipe-photos').getPublicUrl(chemin).data.publicUrl;
}

// Après une publication, tout doit se recalculer : les compteurs du menu, les
// cinq axes de l'index, les filtres. Le plus simple et le plus sûr est de
// reprendre la liste des recettes depuis la base.
async function rechargerLivre(idCible) {
  delete cache['recipes?select=*&order=title'];
  try {
    const [recettes, ingrs] = await Promise.all([
      sb('recipes?select=*&order=title'),
      sb('recipe_ingredients?select=recipe_id,ingredients(name)')
    ]);
    allRecipes = recettes;
    ingrByRecipe = new Map();
    ingrs.forEach(i => {
      const nom = i.ingredients?.name;
      if (!nom) return;
      if (!ingrByRecipe.has(i.recipe_id)) ingrByRecipe.set(i.recipe_id, []);
      ingrByRecipe.get(i.recipe_id).push(nom);
    });
    // Les compteurs des filtres et du menu comptent les recettes : ils doivent
    // être refaits, sinon le nouveau chapitre affiche encore l'ancien total.
    catFilter = 0;
    construireFiltres(CATS_LISTE);
    majFilteredRecipes();
    buildTOC();
    const idx = filteredRecipes.findIndex(r => r.id === idCible);
    closeSubmit();
    if (idx >= 0) showPage(idx); else showCover();
  } catch (err) {
    console.error('Rechargement impossible :', err);
    // La recette EST publiée : on ne laisse pas croire le contraire.
    messageApercu('La recette est bien dans le livre, mais l\'affichage n\'a pas pu se rafraîchir. Recharge la page.', 'err');
  }
}

// Glisser-déposer sur la zone. Sans les preventDefault, le navigateur ouvre le
// fichier dans l'onglet et quitte le livre.
(function () {
  const zone = document.getElementById('depotZone');
  if (!zone) return;
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault();
    zone.classList.add('depot--survol');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault();
    zone.classList.remove('depot--survol');
  }));
  zone.addEventListener('drop', e => ajouterAuDepot(e.dataTransfer.files));
})();

// ── SWIPE TACTILE ─────────────────────────────────────────────────────────────

(function () {
  let touchStartX = 0, touchStartY = 0;
  const target = document.querySelector('.book-outer');
  if (!target) return;

  target.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
  }, { passive: true });

  target.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Ignorer les swipes verticaux et les mouvements trop courts
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
    changePage(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

// ── CLAVIER ───────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  // Échap doit fonctionner partout, y compris depuis un champ de saisie.
  if (e.key === 'Escape') { closeTOC(); closeSubmit(); closeSearch(); return; }

  // Sinon, aucun raccourci pendant la saisie : taper « t » dans la recherche
  // ouvrait le sommaire, et une flèche faisait tourner la page sous les doigts.
  const saisie = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (saisie) return;

  // Ni pendant qu'une surcouche est ouverte : les flèches ne doivent pas
  // feuilleter le livre derrière un panneau.
  const surcouche = document.querySelector('.search-overlay.open, .toc-overlay.open, .submit-overlay.open');
  if (surcouche) return;

  if (e.key === 'ArrowRight') changePage(1);
  else if (e.key === 'ArrowLeft') changePage(-1);
  else if (e.key === '/') { e.preventDefault(); openSearch(); }
  else if (e.key === 't' || e.key === 'T') openTOC();
  else if (e.key === 'g' || e.key === 'G') toggleGallery();
});

// ── AUTHENTIFICATION ──────────────────────────────────────────────────────────
// Lire le livre ne demande JAMAIS de compte : quelqu'un qui reçoit un lien doit
// pouvoir lire la recette immédiatement. La connexion sert uniquement à
// contribuer (ajouter une photo, proposer une recette), et l'accès en écriture
// doit en plus être approuvé par un administrateur.

// flowType 'pkce' : le retour de Google arrive dans « ?code=… » et non dans le
// fragment « #… ». Sans ça, le jeton écraserait le permalien de recette qui
// utilise déjà le hash (voir plus bas #id).
const sbClient = window.supabase?.createClient
  ? window.supabase.createClient(URL_SB, KEY_SB, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true }
    })
  : null;

let currentUser = null;   // compte Google
let currentMember = null; // fiche family_members correspondante

function isApproved() {
  return currentMember?.status === 'approved';
}

async function signIn() {
  if (!sbClient) return;
  const { error } = await sbClient.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) console.error('Connexion impossible :', error.message);
}

async function signOut() {
  if (!sbClient) return;
  await sbClient.auth.signOut();
  currentUser = null;
  currentMember = null;
  renderAuth();
}

async function loadMember(user) {
  // La policy « chacun voit sa propre fiche » limite la lecture à sa ligne.
  const { data, error } = await sbClient
    .from('family_members')
    .select('display_name, avatar_url, status, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.error('Lecture de la fiche membre :', error.message);
    return null;
  }
  return data;
}

function firstName(fullName, fallback) {
  if (!fullName) return fallback;
  return fullName.trim().split(/\s+/)[0];
}

function renderAuth() {
  const zone = document.getElementById('authZone');
  const submitBtn = document.getElementById('submitBtn');
  if (!zone) return;

  // Le bouton « + Recette » n'a de sens que pour un membre approuvé.
  if (submitBtn) submitBtn.hidden = !isApproved();

  if (!sbClient) { zone.innerHTML = ''; return; }

  if (!currentUser) {
    zone.innerHTML = `
      <button class="auth-btn" onclick="signIn()" title="Se connecter pour contribuer">
        Se connecter
      </button>`;
    return;
  }

  const prenom = firstName(currentMember?.display_name, currentUser.email);
  const avatar = currentMember?.avatar_url
    ? `<img class="auth-avatar" src="${currentMember.avatar_url}" alt="" referrerpolicy="no-referrer">`
    : `<span class="auth-avatar auth-avatar--vide">${(prenom || '?')[0].toUpperCase()}</span>`;

  let etat = '';
  if (currentMember?.status === 'pending') {
    etat = `<span class="auth-state auth-state--attente" title="Un administrateur doit valider ton accès avant que tu puisses contribuer">en attente</span>`;
  } else if (currentMember?.status === 'rejected') {
    etat = `<span class="auth-state auth-state--refuse">accès refusé</span>`;
  } else if (currentMember?.role === 'admin' || currentMember?.role === 'editor') {
    etat = `<span class="auth-state auth-state--admin">${currentMember.role}</span>`;
  }

  zone.innerHTML = `
    <div class="auth-me">
      ${avatar}
      <span class="auth-name">${prenom}</span>
      ${etat}
      <button class="auth-signout" onclick="signOut()" title="Se déconnecter" aria-label="Se déconnecter">⏏</button>
    </div>`;
}

async function initAuth() {
  if (!sbClient) {
    console.warn('supabase-js absent : la connexion est désactivée, la lecture reste possible.');
    renderAuth();
    return;
  }

  const { data: { session } } = await sbClient.auth.getSession();
  currentUser = session?.user || null;
  if (currentUser) currentMember = await loadMember(currentUser);
  renderAuth();

  sbClient.auth.onAuthStateChange(async (event, session) => {
    currentUser = session?.user || null;
    currentMember = currentUser ? await loadMember(currentUser) : null;
    renderAuth();
  });
}

// ── INITIALISATION ────────────────────────────────────────────────────────────

(async () => {
  // L'authentification tourne en parallèle du chargement du livre : elle ne doit
  // jamais retarder l'affichage des recettes.
  initAuth();

  try {
    const [recipes, ingrsFlat, cats] = await Promise.all([
      sb('recipes?select=*&order=title'),
      sb('recipe_ingredients?select=recipe_id,ingredients(name)'),
      sb('recipe_categories?select=id,name,emoji,display_order&order=display_order,id').catch(() => [])
    ]);

    allRecipes = recipes;
    filteredRecipes = [...allRecipes];
    livrePerime = true;

    // Après l'affectation, pas avant : construireFiltres compte les recettes de
    // chaque catégorie et aurait affiché « Toutes 0 ».
    construireFiltres(cats);

    // Quelques feuillets pour le fond de la page de garde. En arrière-plan : la
    // couverture s'affiche sans attendre, le fond arrive quand il arrive.
    sb('recipe_documents?select=public_url&kind=eq.manuscript&limit=40')
      .then(docs => {
        fondsManuscrits = docs.map(d => d.public_url).filter(Boolean);
        if (currentIndex === -1) renderGardeFond();
      })
      .catch(() => {});

    // On garde la casse d'origine : le panneau de recherche affiche le nom tel
    // qu'il est écrit (« ingrédient · confiture de lait »), la comparaison se
    // fait en minuscules au moment du besoin.
    ingrsFlat.forEach(i => {
      const nom = i.ingredients?.name;
      if (!nom) return;
      if (!ingrByRecipe.has(i.recipe_id)) ingrByRecipe.set(i.recipe_id, []);
      ingrByRecipe.get(i.recipe_id).push(nom);
    });

    buildTOC();

    // Un dépôt laissé en route se propose à la reprise, sans bloquer l'ouverture
    // du livre. Voir proposerBrouillon() : la photo et les corrections sont
    // gardées sur l'appareil, pas envoyées.
    setTimeout(() => proposerBrouillon().catch(() => {}), 1200);

    // On accepte les deux formes : le slug (#choucroute-denise) et l'ancien
    // identifiant (#9), pour que les liens déjà partagés continuent de marcher.
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash) {
      let idx = filteredRecipes.findIndex(r => r.slug === hash);
      if (idx < 0 && /^\d+$/.test(hash)) {
        idx = filteredRecipes.findIndex(r => r.id === parseInt(hash, 10));
      }
      if (idx >= 0) {
        await showPage(idx);
        return;
      }
    }

    showCover();
  } catch (err) {
    console.error('Erreur chargement initial :', err);
    // Le livre n'a même pas pu être fabriqué : on écrit dans son conteneur, qui
    // existe toujours, plutôt que dans un feuillet qui n'a jamais été créé.
    document.getElementById('flipbook').innerHTML = `<div class="loading-state">Impossible de charger les recettes.<br>Vérifie ta connexion et ton config.js.</div>`;
  }
})();
