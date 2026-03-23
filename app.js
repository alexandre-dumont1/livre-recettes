// Les clés sont chargées depuis config.js (non versionné)
// Voir config.example.js pour la structure attendue
const URL_SB = window.APP_CONFIG?.supabaseUrl || '';
const KEY_SB = window.APP_CONFIG?.supabaseKey || '';

if (!URL_SB || !KEY_SB) {
  console.error('⚠️ config.js manquant — copie config.example.js en config.js et remplis tes clés.');
}

const CATS = { 1: 'Entrée', 2: 'Plat', 3: 'Poisson', 4: 'Dessert', 5: 'Gibier', 6: 'Accompagnement' };
const CAT_COLORS = { 1: '#c8603a', 2: '#3a6ab0', 3: '#1a8a6a', 4: '#b07a1a', 5: '#7a3ab0', 6: '#3a8a3a' };

let allRecipes = [], filteredRecipes = [], currentIndex = 0, isAnimating = false, catFilter = 0;

// Cache en mémoire pour éviter de refetcher ingrédients/étapes à chaque page
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
  const h = Math.floor(min/60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2,'0')}` : `${h}h`;
}

async function renderLeft(recipe) {
  const [ingrs, steps] = await Promise.all([
    sb(`recipe_ingredients?select=*,ingredients(name)&recipe_id=eq.${recipe.id}&order=display_order`),
    sb(`recipe_steps?select=*&recipe_id=eq.${recipe.id}&order=step_number`)
  ]);

  const cat = CATS[recipe.category_id] || '';
  const groups = {};
  ingrs.forEach(i => {
    const g = i.group_label || '';
    if (!groups[g]) groups[g] = [];
    groups[g].push(i);
  });

  let ingrHTML = '';
  Object.entries(groups).forEach(([g, items]) => {
    if (g) ingrHTML += `<span class="ingr-group-title">${g}</span>`;
    ingrHTML += `<ul class="ingr-list">`;
    items.forEach(i => {
      const qty = [i.quantity, i.unit].filter(Boolean).join('\u202f');
      const prep = i.preparation ? `<span class="ingr-prep">, ${i.preparation}</span>` : '';
      ingrHTML += `<li class="ingr-item">
        <span class="ingr-qty">${qty}</span>
        <span class="ingr-name">${i.ingredients?.name || ''}${prep}</span>
      </li>`;
    });
    ingrHTML += `</ul>`;
  });

  let stepsHTML = '';
  steps.forEach(s => {
    const dur = s.duration_minutes ? `<span class="step-duration">${ft(s.duration_minutes)}</span>` : '';
    const temp = s.temperature_celsius ? `<span class="step-temp">${s.temperature_celsius}\u00b0C</span>` : '';
    stepsHTML += `<li class="step-item">
      <span class="step-number">${s.step_number}</span>
      <div class="step-body">
        <div class="step-head"><span>${s.title}</span>${dur}${temp}</div>
        <div class="step-text">${s.description}</div>
      </div>
    </li>`;
  });

  const notesHTML = recipe.notes ? `
    <div class="notes-block">
      <span class="notes-label">Note</span>
      <span class="notes-text">${recipe.notes}</span>
    </div>` : '';

  const servingsMeta = [
    recipe.servings ? `${recipe.servings} ${recipe.servings_unit || 'personnes'}` : null,
    recipe.difficulty || null
  ].filter(Boolean).map(v => `<span class="meta-pill">${v}</span>`).join('');

  return `
    <div class="page-left-header">
      <span class="recipe-category">${cat}</span>
      <span class="recipe-title-modern">${recipe.title}</span>
      <div class="recipe-servings">${servingsMeta}</div>
    </div>
    <div class="page-left-body">
      ${ingrs.length ? `<span class="section-tag">Ingr\u00e9dients</span>${ingrHTML}` : ''}
      ${steps.length ? `<span class="section-tag">Pr\u00e9paration</span><ol class="steps-list">${stepsHTML}</ol>` : ''}
      ${notesHTML}
    </div>
    <span class="page-num-left">${currentIndex + 1}</span>`;
}

function renderRight(recipe) {
  const cat = CATS[recipe.category_id] || '';
  const tags = (recipe.tags || []).slice(0, 6);

  const stats = [];
  if (recipe.prep_time_minutes) stats.push({ label: 'Pr\u00e9paration', val: ft(recipe.prep_time_minutes) });
  if (recipe.cook_time_minutes) stats.push({ label: 'Cuisson', val: ft(recipe.cook_time_minutes) });
  if (recipe.rest_time_minutes) stats.push({ label: 'Repos', val: ft(recipe.rest_time_minutes) });
  if (recipe.servings) stats.push({ label: 'Personnes', val: recipe.servings });
  while (stats.length > 0 && stats.length % 2 !== 0) stats.push(null);

  const statsHTML = stats.length ? `
    <div class="recipe-stats">
      ${stats.map(s => s ? `
        <div class="stat-item">
          <span class="stat-label">${s.label}</span>
          <span class="stat-value">${s.val}</span>
        </div>` : '<div class="stat-item"></div>'
      ).join('')}
    </div>` : '';

  const tagsHTML = tags.length ? `
    <div class="tags-block">
      ${tags.map(t => `<span class="tag-pill">${t}</span>`).join('')}
    </div>` : '';

  const sourceHTML = recipe.source ? `
    <div class="source-block">
      <span class="source-text">Source\u202f: ${recipe.author ? recipe.author + ', ' : ''}${recipe.source}</span>
    </div>` : '';

  if (recipe.pdf_url) {
    return `
      <div class="pdf-full">
        <div class="pdf-topbar">
          <span class="pdf-topbar-title">Recette originale</span>
          <a href="${recipe.pdf_url}" target="_blank" class="pdf-open-link">Ouvrir \u2197</a>
        </div>
        <iframe class="pdf-iframe" src="${recipe.pdf_url}" title="PDF recette"></iframe>
      </div>
      <span class="page-num-right">${currentIndex + 2}</span>`;
  }

  return `
    <div class="no-pdf-zone">
      <div>
        <span class="no-pdf-cat">${cat}</span>
        <div class="no-pdf-title">${recipe.title}</div>
        <div class="deco-line"></div>
        ${tagsHTML}
      </div>
      ${statsHTML}
      ${sourceHTML}
    </div>
    <span class="page-num-right">${currentIndex + 2}</span>`;
}

async function showPage(idx) {
  currentIndex = idx;
  const r = filteredRecipes[idx];
  if (!r) return;

  document.getElementById('pageLeft').innerHTML = `<div class="loading-state">\u2026</div>`;
  document.getElementById('pageRight').innerHTML = `<div class="loading-state"></div>`;

  try {
    const lHTML = await renderLeft(r);
    document.getElementById('pageLeft').innerHTML = lHTML;
    document.getElementById('pageRight').innerHTML = renderRight(r);
  } catch (err) {
    console.error('Erreur chargement recette :', err);
    document.getElementById('pageLeft').innerHTML = `<div class="loading-state">Impossible de charger la recette.</div>`;
    document.getElementById('pageRight').innerHTML = `<div class="loading-state"></div>`;
  }
  updateControls();
}

async function changePage(dir) {
  if (isAnimating) return;
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
  document.getElementById('prevBtn').disabled = currentIndex <= 0;
  document.getElementById('nextBtn').disabled = currentIndex >= filteredRecipes.length - 1;
  document.getElementById('pageCounter').textContent = `${currentIndex + 1}\u202f/\u202f${filteredRecipes.length}`;
}

function applyFilter() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  filteredRecipes = allRecipes.filter(r => {
    const catOk = catFilter === 0 || r.category_id === catFilter;
    const qOk = !q || r.title.toLowerCase().includes(q) || (r.tags||[]).some(t => t.toLowerCase().includes(q));
    return catOk && qOk;
  });
  currentIndex = 0;
  showPage(0);
  buildTOC();
}

// Debounce : attend 300ms après la dernière frappe avant de filtrer
let searchTimer;
document.getElementById('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 300);
});

document.querySelectorAll('.cat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    catFilter = parseInt(btn.dataset.cat);
    applyFilter();
  });
});

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
      ${items.map(({r, i}) => `
        <div class="toc-item" onclick="goToRecipe(${i})">
          <span class="toc-dot" style="background:${CAT_COLORS[r.category_id]||'#888'}"></span>
          ${r.title}
        </div>`).join('')}
    </div>`).join('');
}

function goToRecipe(i) { closeTOC(); showPage(i); }
function openTOC() { document.getElementById('tocOverlay').classList.add('open'); }
function closeTOC() { document.getElementById('tocOverlay').classList.remove('open'); }
function closeTOCOutside(e) { if (e.target === document.getElementById('tocOverlay')) closeTOC(); }

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') changePage(1);
  else if (e.key === 'ArrowLeft') changePage(-1);
  else if (e.key === 'Escape') closeTOC();
  else if (e.key === 't' || e.key === 'T') openTOC();
});

(async () => {
  try {
    allRecipes = await sb('recipes?select=*&order=title');
    filteredRecipes = [...allRecipes];
    buildTOC();
    await showPage(0);
  } catch (err) {
    console.error('Erreur chargement initial :', err);
    document.getElementById('pageLeft').innerHTML = `<div class="loading-state">Impossible de charger les recettes.<br>Vérifie ta connexion et ton config.js.</div>`;
  }
})();
