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

const CATS = { 1: 'Entrée', 2: 'Plat', 3: 'Poisson', 4: 'Dessert', 5: 'Gibier', 6: 'Accompagnement' };
const CAT_COLORS = {
  1: '#b8641e',
  2: '#6e4f8a',
  3: '#1a7a5a',
  4: '#c4923a',
  5: '#7a3a6e',
  6: '#4a7a3a'
};

const LAVENDER_SVG = `<svg width="12" height="16" viewBox="0 0 12 16" fill="none">
  <line x1="6" y1="15" x2="6" y2="2" stroke="rgba(110,79,138,0.55)" stroke-width="1"/>
  <ellipse cx="3.8" cy="5.5" rx="2.2" ry="1.4" fill="rgba(150,115,185,0.6)" transform="rotate(-25 3.8 5.5)"/>
  <ellipse cx="8.2" cy="7.5" rx="2.2" ry="1.4" fill="rgba(150,115,185,0.6)" transform="rotate(25 8.2 7.5)"/>
  <ellipse cx="4"   cy="10"  rx="1.8" ry="1.2" fill="rgba(130,95,165,0.5)"  transform="rotate(-20 4 10)"/>
</svg>`;

// Ornement plus élaboré pour la page de garde
const GARDE_SVG = `<svg width="72" height="46" viewBox="0 0 72 46" fill="none">
  <line x1="36" y1="44" x2="36" y2="5" stroke="rgba(110,79,138,0.38)" stroke-width="1"/>
  <line x1="36" y1="32" x2="16" y2="21" stroke="rgba(110,79,138,0.28)" stroke-width="1"/>
  <line x1="36" y1="32" x2="56" y2="21" stroke="rgba(110,79,138,0.28)" stroke-width="1"/>
  <ellipse cx="33.5" cy="10" rx="3" ry="1.8" fill="rgba(150,115,185,0.6)" transform="rotate(-20 33.5 10)"/>
  <ellipse cx="38.5" cy="14" rx="3" ry="1.8" fill="rgba(150,115,185,0.6)" transform="rotate(20 38.5 14)"/>
  <ellipse cx="33" cy="18.5" rx="2.8" ry="1.6" fill="rgba(130,95,165,0.5)" transform="rotate(-14 33 18.5)"/>
  <ellipse cx="39" cy="22.5" rx="2.8" ry="1.6" fill="rgba(130,95,165,0.5)" transform="rotate(14 39 22.5)"/>
  <ellipse cx="34" cy="27" rx="2.4" ry="1.4" fill="rgba(110,75,145,0.4)" transform="rotate(-8 34 27)"/>
  <ellipse cx="19" cy="17" rx="2.5" ry="1.5" fill="rgba(150,115,185,0.5)" transform="rotate(-35 19 17)"/>
  <ellipse cx="24.5" cy="14" rx="2.2" ry="1.3" fill="rgba(150,115,185,0.44)" transform="rotate(-18 24.5 14)"/>
  <ellipse cx="53" cy="17" rx="2.5" ry="1.5" fill="rgba(150,115,185,0.5)" transform="rotate(35 53 17)"/>
  <ellipse cx="47.5" cy="14" rx="2.2" ry="1.3" fill="rgba(150,115,185,0.44)" transform="rotate(18 47.5 14)"/>
</svg>`;

let allRecipes = [], filteredRecipes = [], currentIndex = -1, isAnimating = false, catFilter = 0;
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

function titleSize(title) {
  const l = title.length;
  if (l > 35) return '44px';
  if (l > 25) return '56px';
  return '72px';
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
  showPage(currentIndex);
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
  return { grouped, groupOrder };
}

function showCover() {
  currentIndex = -1;
  history.replaceState(null, '', location.pathname);

  // ── Page gauche : page de garde ──
  const coverHTML = `
    <div class="garde-frame">
      <div class="garde-corner garde-corner--tl"></div>
      <div class="garde-corner garde-corner--tr"></div>
      <div class="garde-corner garde-corner--bl"></div>
      <div class="garde-corner garde-corner--br"></div>
      <div class="garde-ornament">${GARDE_SVG}</div>
      <div class="garde-eyebrow">Collection</div>
      <div class="garde-title">Le Livre<br>de Recettes</div>
      <div class="garde-rule"></div>
      <div class="garde-subtitle">Recettes de Famille</div>
      <div class="garde-dedication">Transmises de génération en génération</div>
      <span class="garde-page-num">i</span>
    </div>`;

  // ── Page droite : table des matières ──
  const { grouped, groupOrder } = buildTOCGroups(filteredRecipes);

  const tocLinesHTML = groupOrder.map(cat => {
    const { catId, items } = grouped[cat];
    const color = CAT_COLORS[catId] || '#888';
    return `
      <div class="toc-cat-block">
        <div class="toc-cat-head" style="border-left-color:${color}">
          <span class="toc-cat-name" style="color:${color}">${cat}</span>
          <span class="toc-cat-n">${items.length}</span>
        </div>
        ${items.map(({ r, i }) => {
          const src = r.author || r.source || '';
          return `
            <div class="toc-right-line" onclick="goToRecipe(${i})">
              <span class="toc-right-title">${r.title}</span>
              ${src ? `<span class="toc-right-source">${src}</span>` : ''}
              <span class="toc-right-dots"></span>
              <span class="toc-right-page">${i * 2 + 1}</span>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');

  const tocHTML = `
    <div class="toc-page-wrapper">
      <div class="toc-right-header">
        <span>Table des Matières</span>
        <span class="toc-right-total">${filteredRecipes.length} recettes</span>
      </div>
      <div class="toc-right-list">${tocLinesHTML}</div>
      <span class="garde-page-num" style="align-self:flex-end">ii</span>
    </div>`;

  document.getElementById('pageLeft').innerHTML = coverHTML;
  document.getElementById('pageRight').innerHTML = tocHTML;
  updateControls();
}

// ── GALERIE ───────────────────────────────────────────────────────────────────

function toggleGallery() {
  const entering = !document.body.classList.contains('gallery-mode');
  document.body.classList.toggle('gallery-mode', entering);
  document.querySelector('.gallery-btn').classList.toggle('active', entering);
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
          const source = r.author || r.source || '';
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
  document.querySelector('.gallery-btn').classList.remove('active');
  showPage(i);
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

  let ingrHTML = '';
  groupOrder.forEach(g => {
    if (g) ingrHTML += `<div class="ingr-group-label">${g}</div>`;
    groups[g].forEach(i => {
      const qty = [i.quantity, i.unit].filter(Boolean).join('\u202f');
      const prep = i.preparation ? `<span class="ingr-prep">, ${i.preparation}</span>` : '';
      ingrHTML += `<div class="ingr-row">
        <span class="ingr-qty">${qty}</span>
        <span>${i.ingredients?.name || ''}${prep}</span>
      </div>`;
    });
  });

  let stepsHTML = '';
  steps.forEach(s => {
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

  const source = recipe.author || recipe.source || 'recette de famille';

  return `
    <span class="page-num">${currentIndex * 2 + 1}</span>
    <div class="cat-tag">
      <div class="cat-tag-bar"></div>
      <span class="cat-tag-text">${cat}</span>
    </div>
    <div class="recipe-title" style="font-size:${titleSize(recipe.title)}">${recipe.title}</div>
    <div class="recipe-meta-line">
      <div class="recipe-source">${source}</div>
      <div class="souleiado"></div>
    </div>
    ${metaHTML ? `<div class="meta-row">${metaHTML}</div>` : ''}
    <div class="recipe-body">
      <div>
        <div class="col-header">Ingrédients</div>
        ${ingrHTML}
      </div>
      <div>
        <div class="col-header">Préparation</div>
        ${stepsHTML}
      </div>
      ${noteHTML}
    </div>`;
}

function renderRight(recipe) {
  const tags = (recipe.tags || []).slice(0, 6);
  const tagsHTML = tags.map(t => `<span class="tag">${t}</span>`).join('');
  const source = recipe.author || recipe.source || 'recette de famille';
  const isFav = getFavs().includes(recipe.id);

  const photosZone = `
    <div class="divider-r"></div>
    <div class="photos-zone">
      <div class="photos-header">Photos du plat</div>
      <div class="photos-grid">
        ${recipe.photo1_url
          ? `<div class="photo-slot photo-slot--filled"><img src="${recipe.photo1_url}" alt="Photo 1"></div>`
          : `<label class="photo-slot" title="Ajouter une photo">
              <input type="file" accept="image/*" style="display:none" onchange="uploadPhoto(event,${recipe.id},1)">
              <span class="photo-slot-icon">🖼</span>
              <span class="photo-slot-label">Ajouter une photo</span>
            </label>`}
        ${recipe.photo2_url
          ? `<div class="photo-slot photo-slot--filled"><img src="${recipe.photo2_url}" alt="Photo 2"></div>`
          : `<label class="photo-slot" title="Ajouter une photo">
              <input type="file" accept="image/*" style="display:none" onchange="uploadPhoto(event,${recipe.id},2)">
              <span class="photo-slot-icon">🖼</span>
              <span class="photo-slot-label">Ajouter une photo</span>
            </label>`}
      </div>
    </div>`;

  const footer = `
    <div class="right-footer">
      <div class="tags-row">${tagsHTML}</div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="copy-link-btn" onclick="copyRecipeLink(this)" title="Copier le lien vers cette recette" aria-label="Copier le lien vers cette recette">⛓ Copier</button>
        <button class="fav-btn${isFav ? ' fav-btn--active' : ''}" onclick="toggleFav(${recipe.id})" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}" aria-label="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '★' : '☆'}</button>
        <span class="page-num-right">${currentIndex * 2 + 2}</span>
      </div>
    </div>`;

  if (recipe.pdf_url) {
    return `
      <div class="manuscript-zone">
        <div class="manuscript-header">
          <span class="manuscript-label">Manuscrit de famille</span>
          <span class="manuscript-open">cliquer pour ouvrir ↗</span>
        </div>
        <a class="photo-link" href="${recipe.pdf_url}" target="_blank" title="Ouvrir le manuscrit original">
          <div class="photo-shadow"></div>
          <div class="photo-inner">
            <canvas id="pdf-thumb"></canvas>
            <div id="pdf-fallback">
              <span style="font-size:28px">📄</span>
              <span>Recette manuscrite</span>
            </div>
          </div>
        </a>
        <div class="manuscript-caption">${LAVENDER_SVG} ${source}</div>
      </div>
      ${photosZone}
      ${footer}`;
  }

  const cat = CATS[recipe.category_id] || '';
  const metaItems = [];
  if (recipe.prep_time_minutes)  metaItems.push({ label: 'Prép.', val: ft(recipe.prep_time_minutes) });
  if (recipe.cook_time_minutes)  metaItems.push({ label: 'Cuisson', val: ft(recipe.cook_time_minutes) });
  if (recipe.servings)           metaItems.push({ label: 'Personnes', val: recipe.servings });
  if (recipe.difficulty)         metaItems.push({ label: 'Difficulté', val: recipe.difficulty });

  const statsHTML = metaItems.map(m => `
    <div class="meta-item">
      <span class="meta-label">${m.label}</span>
      <span class="meta-value">${m.val}</span>
    </div>`).join('');

  return `
    <div class="no-pdf-zone">
      <div>
        <div class="no-pdf-cat">${cat}</div>
        <div class="no-pdf-title">${recipe.title}</div>
        <div class="no-pdf-souleiado"></div>
      </div>
      ${statsHTML ? `<div class="meta-row no-pdf-stats">${statsHTML}</div>` : ''}
    </div>
    ${photosZone}
    ${footer}`;
}

function renderPDF(url) {
  if (!window.pdfjsLib) return;
  pdfjsLib.getDocument({ url }).promise
    .then(pdf => pdf.getPage(1))
    .then(page => {
      const c = document.getElementById('pdf-thumb');
      if (!c) return;
      const container = c.closest('.photo-inner');
      const availW = container.clientWidth - 8;
      const naturalVp = page.getViewport({ scale: 1 });
      const scale = availW / naturalVp.width;
      const vp = page.getViewport({ scale });
      c.width = vp.width;
      c.height = vp.height;
      return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    })
    .catch(() => {
      const fb = document.getElementById('pdf-fallback');
      const th = document.getElementById('pdf-thumb');
      if (fb) fb.style.display = 'flex';
      if (th) th.style.display = 'none';
    });
}

// ── UPLOAD PHOTOS ─────────────────────────────────────────────────────────────

async function uploadPhoto(event, recipeId, slot) {
  const file = event.target.files[0];
  if (!file) return;
  const label = event.target.closest('.photo-slot');
  if (label) label.innerHTML = '<span class="photo-slot-label">Envoi en cours…</span>';

  try {
    const path = `${recipeId}/${slot}-${Date.now()}.${file.name.split('.').pop()}`;
    const uploadRes = await fetch(`${URL_SB}/storage/v1/object/recipe-photos/${path}`, {
      method: 'POST',
      headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`, 'Content-Type': file.type },
      body: file
    });
    if (!uploadRes.ok) throw new Error('Upload échoué');

    const photoUrl = `${URL_SB}/storage/v1/object/public/recipe-photos/${path}`;
    await fetch(`${URL_SB}/rest/v1/recipes?id=eq.${recipeId}`, {
      method: 'PATCH',
      headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ [`photo${slot}_url`]: photoUrl })
    });

    delete cache['recipes?select=*&order=title'];
    allRecipes = await sb('recipes?select=*&order=title');
    filteredRecipes = applyFilterLogic();
    showPage(currentIndex);
  } catch (err) {
    console.error('Erreur upload photo :', err);
    if (label) label.innerHTML = '<span class="photo-slot-label">Erreur — réessayer</span>';
  }
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────

async function showPage(idx) {
  currentIndex = idx;
  const r = filteredRecipes[idx];
  if (!r) return;

  history.replaceState(null, '', '#' + r.id);

  document.getElementById('pageLeft').innerHTML = `<div class="loading-state">\u2026</div>`;
  document.getElementById('pageRight').innerHTML = `<div class="loading-state"></div>`;

  try {
    const lHTML = await renderLeft(r);
    document.getElementById('pageLeft').innerHTML = lHTML;
    document.getElementById('pageRight').innerHTML = renderRight(r);
    if (r.pdf_url) renderPDF(r.pdf_url);
  } catch (err) {
    console.error('Erreur chargement recette :', err);
    document.getElementById('pageLeft').innerHTML = `<div class="loading-state">Impossible de charger la recette.</div>`;
    document.getElementById('pageRight').innerHTML = `<div class="loading-state"></div>`;
  }
  updateControls();
}

async function changePage(dir) {
  if (isAnimating) return;

  if (currentIndex === -1 && dir === 1) {
    isAnimating = true;
    const animated = document.getElementById('pfcLeft');
    animated.classList.add('flipping-fwd');
    setTimeout(async () => {
      animated.classList.remove('flipping-fwd');
      await showPage(0);
      isAnimating = false;
    }, 720);
    return;
  }

  if (currentIndex === 0 && dir === -1) {
    isAnimating = true;
    const animated = document.getElementById('pfcRight');
    animated.classList.add('flipping-back');
    setTimeout(() => {
      animated.classList.remove('flipping-back');
      showCover();
      isAnimating = false;
    }, 720);
    return;
  }

  const next = currentIndex + dir;
  if (next < 0 || next >= filteredRecipes.length) return;
  isAnimating = true;

  const animated = dir > 0 ? document.getElementById('pfcLeft') : document.getElementById('pfcRight');
  const cls = dir > 0 ? 'flipping-fwd' : 'flipping-back';
  animated.classList.add(cls);

  setTimeout(async () => {
    animated.classList.remove(cls);
    await showPage(next);
    isAnimating = false;
  }, 720);
}

function updateControls() {
  const atCover = currentIndex === -1;
  document.getElementById('prevBtn').disabled = atCover;
  document.getElementById('nextBtn').disabled = currentIndex >= filteredRecipes.length - 1;
  document.getElementById('pageCounter').textContent = atCover
    ? `i\u202f/\u202fii`
    : `${currentIndex + 1}\u202f/\u202f${filteredRecipes.length}`;
}

// ── FILTRES ───────────────────────────────────────────────────────────────────

function applyFilterLogic() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  return allRecipes.filter(r => {
    if (catFilter === 'fav') return getFavs().includes(r.id);
    const catOk = catFilter === 0 || r.category_id === catFilter;
    const qOk = !q
      || r.title.toLowerCase().includes(q)
      || (r.tags || []).some(t => t.toLowerCase().includes(q))
      || (ingrByRecipe.get(r.id) || []).some(n => n.includes(q));
    return catOk && qOk;
  });
}

function applyFilter() {
  filteredRecipes = applyFilterLogic();
  currentIndex = -1;
  if (document.body.classList.contains('gallery-mode')) {
    showGallery();
  } else {
    showCover();
  }
  buildTOC();
}

let searchTimer;
document.getElementById('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 300);
});

document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-btn').forEach(b => {
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

// ── TABLE DES MATIÈRES (overlay) ──────────────────────────────────────────────

function buildTOC() {
  const body = document.getElementById('tocBody');
  const grouped = {};
  filteredRecipes.forEach((r, i) => {
    const cat = CATS[r.category_id] || 'Autre';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ r, i });
  });
  body.innerHTML = Object.entries(grouped).map(([cat, items]) => `
    <div class="toc-section-title">${cat}</div>
    <div class="toc-grid">
      ${items.map(({ r, i }) => `
        <div class="toc-item" onclick="goToRecipe(${i})">
          <span class="toc-dot" style="background:${CAT_COLORS[r.category_id] || '#888'}"></span>
          ${r.title}
        </div>`).join('')}
    </div>`).join('');
}

function goToRecipe(i) { closeTOC(); showPage(i); }
function openTOC() { document.getElementById('tocOverlay').classList.add('open'); }
function closeTOC() { document.getElementById('tocOverlay').classList.remove('open'); }
function closeTOCOutside(e) { if (e.target === document.getElementById('tocOverlay')) closeTOC(); }

// ── SOUMISSION DE RECETTE ─────────────────────────────────────────────────────

function openSubmit() { document.getElementById('submitOverlay').classList.add('open'); }
function closeSubmit() { document.getElementById('submitOverlay').classList.remove('open'); }
function closeSubmitOutside(e) { if (e.target === document.getElementById('submitOverlay')) closeSubmit(); }

async function submitRecipe(e) {
  e.preventDefault();
  const btn = e.target.querySelector('.submit-form-btn');
  const feedback = document.getElementById('submitFeedback');
  btn.disabled = true;
  btn.textContent = 'Envoi…';
  feedback.textContent = '';
  feedback.className = 'submit-feedback';

  const data = {
    title:       document.getElementById('sf-title').value.trim(),
    category_id: parseInt(document.getElementById('sf-cat').value) || null,
    author:      document.getElementById('sf-author').value.trim() || null,
    ingredients: document.getElementById('sf-ingredients').value.trim() || null,
    steps:       document.getElementById('sf-steps').value.trim() || null,
    notes:       document.getElementById('sf-notes').value.trim() || null
  };

  try {
    const r = await fetch(`${URL_SB}/rest/v1/recipe_submissions`, {
      method: 'POST',
      headers: { apikey: KEY_SB, Authorization: `Bearer ${KEY_SB}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`Erreur ${r.status}`);
    feedback.textContent = '✓ Recette envoyée ! Merci, elle sera ajoutée au livre bientôt.';
    feedback.className = 'submit-feedback submit-feedback--ok';
    e.target.reset();
  } catch (err) {
    console.error('Erreur soumission :', err);
    feedback.textContent = '✗ Erreur lors de l\'envoi. Réessaie ou contacte l\'administrateur.';
    feedback.className = 'submit-feedback submit-feedback--err';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Envoyer la recette';
  }
}

// ── CLAVIER ───────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') changePage(1);
  else if (e.key === 'ArrowLeft') changePage(-1);
  else if (e.key === 'Escape') { closeTOC(); closeSubmit(); }
  else if (e.key === 't' || e.key === 'T') openTOC();
  else if (e.key === 'g' || e.key === 'G') toggleGallery();
});

// ── INITIALISATION ────────────────────────────────────────────────────────────

(async () => {
  try {
    const [recipes, ingrsFlat] = await Promise.all([
      sb('recipes?select=*&order=title'),
      sb('recipe_ingredients?select=recipe_id,ingredients(name)')
    ]);

    allRecipes = recipes;
    filteredRecipes = [...allRecipes];

    ingrsFlat.forEach(i => {
      if (!ingrByRecipe.has(i.recipe_id)) ingrByRecipe.set(i.recipe_id, []);
      ingrByRecipe.get(i.recipe_id).push(i.ingredients?.name?.toLowerCase() || '');
    });

    buildTOC();

    const hash = window.location.hash.slice(1);
    if (hash) {
      const id = parseInt(hash);
      const idx = filteredRecipes.findIndex(r => r.id === id);
      if (idx >= 0) {
        await showPage(idx);
        return;
      }
    }

    showCover();
  } catch (err) {
    console.error('Erreur chargement initial :', err);
    document.getElementById('pageLeft').innerHTML = `<div class="loading-state">Impossible de charger les recettes.<br>Vérifie ta connexion et ton config.js.</div>`;
  }
})();
