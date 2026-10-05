// Contribuer au livre : se connecter, déposer une recette (photo ou PDF), la
// relire, la publier, et valider les demandes d'accès.
//
// Partagé par les deux versions du livre (livre_recettes.html et nouveau.html),
// qui le chargent AVANT leur propre script. Ce fichier ne connaît pas la mise en
// page : après une publication il appelle window.LIVRE.apresPublication(id),
// que chaque version définit. Il compte aussi sur sb(), cache, CATS et
// CAT_EMOJI, déclarés par la version qui le charge.

// Les panneaux eux-mêmes : une seule copie, insérée dans la page qui charge ce
// fichier (avant que le glisser-déposer plus bas ne cherche sa zone).
document.body.insertAdjacentHTML('beforeend', `
<div class="submit-overlay" id="submitOverlay" role="dialog" aria-modal="true" aria-label="Ajouter une recette au livre" onclick="closeSubmitOutside(event)">
  <div class="submit-panel" id="submitPanel">
    <div class="submit-panel-header">
      <div>
        <div class="submit-panel-title">Ajouter une recette</div>
        <div class="submit-panel-subtitle">Photographie la fiche, ou dépose son PDF. Rien à recopier.</div>
      </div>
      <button class="submit-close" onclick="closeSubmit()" aria-label="Fermer">Fermer ✕</button>
    </div>

    <div id="depotVue">
      <div class="depot" id="depotZone">
        <input type="file" id="depotInput" accept="image/*,application/pdf" multiple hidden onchange="fichiersChoisis(this)">
        <input type="file" id="depotCamera" accept="image/*" capture="environment" multiple hidden onchange="fichiersChoisis(this)">
        <p class="depot-titre">Dépose ici la photo ou le PDF de la recette</p>
        <p class="depot-aide">Plusieurs feuillets pour la même recette ? Ajoute-les tous, ils resteront ensemble.</p>
        <div class="depot-boutons">
          <button class="bar-btn bar-btn--prim" onclick="ouvrirSelecteur('depotInput')">Choisir un fichier</button>
          <button class="bar-btn depot-camera" onclick="ouvrirSelecteur('depotCamera')">Prendre une photo</button>
        </div>
        <p class="depot-tech">Photos et PDF, jusqu'à 15 Mo par page.</p>
      </div>

      <div class="depot-liste" id="depotListe"></div>

      <div id="submitFeedback" class="submit-feedback" aria-live="polite"></div>
      <button class="submit-form-btn" id="depotEnvoi" onclick="analyserDepot()" hidden>Lire la recette</button>
    </div>

    <div class="apercu" id="depotApercu" hidden></div>

    <div class="depot-fini" id="depotFini" role="status" tabindex="-1" hidden></div>
  </div>
</div>

<!-- Les demandes d'accès. Le lien du livre se partage, donc n'importe qui peut
     se connecter en Google : la fiche se crée en « pending » et n'ouvre rien.
     Cette surcouche est le seul endroit où un administrateur approuve, sans
     passer par le SQL. Elle n'existe que pour lui (voir renderAuth). -->
<div class="membres-overlay" id="membresOverlay" role="dialog" aria-modal="true"
     aria-label="Demandes d'accès au livre" onclick="closeMembresOutside(event)">
  <div class="membres-panel">
    <div class="membres-panel-header">
      <div>
        <div class="membres-panel-title">Qui entre dans le livre</div>
        <div class="membres-panel-subtitle">Tout le monde peut lire. Une approbation ouvre le droit d'ajouter une recette.</div>
      </div>
      <button class="membres-close" onclick="closeMembres()" aria-label="Fermer les demandes d'accès">Fermer ✕</button>
    </div>
    <div id="membresCorps" aria-live="polite"></div>
  </div>
</div>
`);

const URL_SB_CONTRIB = window.APP_CONFIG?.supabaseUrl || '';
const KEY_SB_CONTRIB = window.APP_CONFIG?.supabaseKey || '';

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
    await window.LIVRE?.apresPublication?.(identifiants[0]);
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

// ── AUTHENTIFICATION ──────────────────────────────────────────────────────────
// Lire le livre ne demande JAMAIS de compte : quelqu'un qui reçoit un lien doit
// pouvoir lire la recette immédiatement. La connexion sert uniquement à
// contribuer (ajouter une photo, proposer une recette), et l'accès en écriture
// doit en plus être approuvé par un administrateur.

// flowType 'pkce' : le retour de Google arrive dans « ?code=… » et non dans le
// fragment « #… ». Sans ça, le jeton écraserait le permalien de recette qui
// utilise déjà le hash (voir plus bas #id).
const sbClient = window.supabase?.createClient
  ? window.supabase.createClient(URL_SB_CONTRIB, KEY_SB_CONTRIB, {
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

  // Le bouton des demandes n'existe que pour un administrateur, et le nombre
  // n'apparaît que s'il y a vraiment quelqu'un à approuver : un badge à zéro
  // appellerait un clic pour rien.
  const demandes = estAdmin()
    ? `<button class="auth-demandes" onclick="openMembres()" title="Les demandes d'accès au livre">
         Demandes${nbEnAttente ? `<span class="auth-demandes-n">${nbEnAttente}</span>` : ''}
       </button>`
    : '';

  zone.innerHTML = `
    <div class="auth-me">
      ${avatar}
      <span class="auth-name">${prenom}</span>
      ${etat}
      ${demandes}
      <button class="auth-signout" onclick="signOut()" title="Se déconnecter" aria-label="Se déconnecter">⏏</button>
    </div>`;
}

// ── LES DEMANDES D'ACCÈS ──────────────────────────────────────────────────────
// Tout le monde lit le livre sans compte. Se connecter en Google crée une fiche
// « en attente » qui n'ouvre rien ; l'approbation donne le droit d'AJOUTER une
// recette. Les policies font le vrai travail (« les admins voient toutes les
// fiches », « les admins valident les demandes ») : ce panneau n'est qu'une main
// posée dessus, pour ne pas ouvrir le SQL à chaque parent qui arrive.

let membres = [];
let nbEnAttente = 0;

// Les noms et les adresses viennent des comptes Google de gens qui se sont
// connectés : ils ne sont pas de nous, donc ils passent par echapper() avant
// d'entrer dans la page.

function estAdmin() {
  return currentMember?.role === 'admin' && currentMember?.status === 'approved';
}

// Compter les demandes sans ouvrir le panneau : le badge doit être là dès l'arrivée.
async function compterDemandes() {
  if (!estAdmin()) { nbEnAttente = 0; return; }
  const { count, error } = await sbClient
    .from('family_members')
    .select('email', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (error) { console.error('Comptage des demandes :', error.message); return; }
  nbEnAttente = count ?? 0;
}

const QUAND = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function ligneMembre(m, actions) {
  const initiale = (m.display_name || m.email || '?').trim()[0].toUpperCase();
  const avatar = m.avatar_url
    ? `<img class="membre-avatar" src="${echapper(m.avatar_url)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="membre-avatar">${echapper(initiale)}</span>`;
  const date = m.requested_at ? QUAND.format(new Date(m.requested_at)) : '';
  return `
    <div class="membre">
      ${avatar}
      <span class="membre-qui">
        <span class="membre-nom">${echapper(m.display_name || m.email)}</span>
        <span class="membre-mail">${echapper(m.email)}</span>
        ${date ? `<span class="membre-quand">arrivé le ${date}</span>` : ''}
      </span>
      <span class="membre-actions">${actions}</span>
    </div>`;
}

function dessinerMembres() {
  const corps = document.getElementById('membresCorps');
  if (!corps) return;

  // Le bouton porte l'INDICE de la fiche, pas son adresse : une apostrophe dans
  // un attribut onclick casserait la chaîne JavaScript, et l'échappement HTML ne
  // répare pas ça — il la restituerait justement telle quelle.
  const bouton = (m, statut, classe, libelle) =>
    `<button class="membre-btn ${classe}" onclick="changerStatutMembre(${membres.indexOf(m)}, '${statut}')">${libelle}</button>`;

  const attente = membres.filter(m => m.status === 'pending');
  const approuves = membres.filter(m => m.status === 'approved');
  const refuses = membres.filter(m => m.status === 'rejected');
  const moi = currentUser?.email?.toLowerCase();

  const bloc = (titre, aide, lignes) => `
    <div class="membres-groupe">
      <h3 class="panel-titre">${titre}</h3>
      ${aide ? `<p class="panel-aide">${aide}</p>` : ''}
      ${lignes || '<p class="membres-vide">Personne.</p>'}
    </div>`;

  corps.innerHTML = [
    bloc(`En attente${attente.length ? ` · ${attente.length}` : ''}`,
      'Ces personnes lisent déjà le livre. Approuver leur ouvre le droit d\'y ajouter une recette.',
      attente.map(m => ligneMembre(m,
        bouton(m, 'approved', 'membre-btn--oui', 'Approuver') +
        bouton(m, 'rejected', 'membre-btn--non', 'Refuser'))).join('')),

    bloc('Approuvés', '',
      approuves.map(m => ligneMembre(m,
        `<span class="membre-role">${echapper(m.role)}</span>` +
        // On ne se retire jamais soi-même : ce serait fermer la porte de l'intérieur,
        // plus personne ne pourrait approuver personne.
        (m.email.toLowerCase() === moi
          ? '<span class="membre-moi">c\'est toi</span>'
          : bouton(m, 'pending', 'membre-btn--non', 'Retirer')))).join('')),

    refuses.length ? bloc('Refusés', '',
      refuses.map(m => ligneMembre(m,
        bouton(m, 'approved', 'membre-btn--oui', 'Approuver quand même'))).join('')) : '',
  ].join('');
}

async function chargerMembres() {
  const corps = document.getElementById('membresCorps');
  if (corps) corps.innerHTML = '<div class="loading-state">…</div>';
  const { data, error } = await sbClient
    .from('family_members')
    .select('email, display_name, avatar_url, status, role, requested_at')
    .order('requested_at', { ascending: true });
  if (error) {
    console.error('Lecture des fiches famille :', error.message);
    if (corps) corps.innerHTML = `<p class="membres-vide">Impossible de lire les demandes : ${echapper(error.message)}</p>`;
    return;
  }
  membres = data || [];
  nbEnAttente = membres.filter(m => m.status === 'pending').length;
  dessinerMembres();
  renderAuth();
}

async function changerStatutMembre(indice, statut) {
  const fiche = membres[indice];
  if (!fiche) return;
  const email = fiche.email;
  // On désactive toute la ligne pendant l'écriture : deux clics sur « Approuver »
  // partiraient deux fois et le second écrirait par-dessus une réponse déjà reçue.
  document.querySelectorAll('#membresCorps .membre-btn').forEach(b => { b.disabled = true; });
  const { error } = await sbClient
    .from('family_members')
    .update({ status: statut, approved_at: statut === 'approved' ? new Date().toISOString() : null })
    .eq('email', email);
  if (error) {
    console.error('Changement de statut :', error.message);
    alert(`Impossible de changer l'accès de ${email} : ${error.message}`);
  }
  await chargerMembres();
}

function openMembres() {
  document.getElementById('membresOverlay').classList.add('open');
  chargerMembres();
}
function closeMembres() { document.getElementById('membresOverlay').classList.remove('open'); }
function closeMembresOutside(e) { if (e.target === document.getElementById('membresOverlay')) closeMembres(); }

async function initAuth() {
  if (!sbClient) {
    console.warn('supabase-js absent : la connexion est désactivée, la lecture reste possible.');
    renderAuth();
    return;
  }

  const { data: { session } } = await sbClient.auth.getSession();
  currentUser = session?.user || null;
  if (currentUser) currentMember = await loadMember(currentUser);
  await compterDemandes();
  renderAuth();

  sbClient.auth.onAuthStateChange(async (event, session) => {
    currentUser = session?.user || null;
    currentMember = currentUser ? await loadMember(currentUser) : null;
    await compterDemandes();
    renderAuth();
  });
}

// ── « JE L'AI REFAITE » : LA PHOTO DU PLAT ───────────────────────────────────
// Un membre approuvé ajoute la photo du plat qu'il a refait. La base, les règles
// et le stockage sont prêts depuis 20260810141500_documents_et_photos.sql :
//   1. le fichier compressé part dans le bucket recipe-photos ;
//   2. une ligne recipe_documents (kind = 'dish_photo', uploaded_by = soi) ;
//   3. le lien vers la recette dans recipe_document_links.
// Les fiches family_members ne sont lisibles que par leur propriétaire : le
// prénom de qui a refait le plat est donc écrit dans la légende, à l'envoi.

async function ajouterPhotoDuPlat(recetteId, fichier) {
  if (!sbClient || !currentUser || !isApproved()) throw new Error('Il faut être membre approuvé du livre pour ajouter une photo.');
  if (!/^image\//i.test(fichier.type)) throw new Error(`${fichier.name} n'est pas une photo.`);
  if (fichier.size > DEPOT_MAX_OCTETS) throw new Error(`${fichier.name} pèse ${poids(fichier.size)}, la limite est 15 Mo.`);

  let corps = fichier, type = fichier.type;
  try { corps = await compressImage(fichier, 1600, 0.85); type = 'image/jpeg'; }
  catch (err) { console.info('Compression impossible, envoi de l\'original :', err.message); }

  const chemin = `plats/${currentUser.id}/${recetteId}-${Date.now()}.jpg`;
  const { error: errEnvoi } = await sbClient.storage.from('recipe-photos')
    .upload(chemin, corps, { contentType: type, upsert: false });
  if (errEnvoi) throw new Error(/row-level security|unauthorized|403/i.test(errEnvoi.message)
    ? 'Ton accès ne permet pas encore d\'ajouter une photo : un administrateur doit le valider.'
    : `L'envoi de la photo a échoué : ${errEnvoi.message}`);
  const url = sbClient.storage.from('recipe-photos').getPublicUrl(chemin).data.publicUrl;

  const prenom = firstName(currentMember?.display_name, '');
  const mois = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date());
  const { data: doc, error: errDoc } = await sbClient.from('recipe_documents').insert({
    kind: 'dish_photo', bucket_id: 'recipe-photos', object_path: chemin, public_url: url,
    byte_size: corps.size ?? fichier.size, uploaded_by: currentUser.id,
    caption: prenom ? `Refaite par ${prenom}, ${mois}` : `Refaite en ${mois}`,
  }).select('id').single();
  if (errDoc) {
    // Rien ne doit rester orphelin dans le stockage : on retire le fichier.
    await sbClient.storage.from('recipe-photos').remove([chemin]).catch(() => {});
    throw new Error(`La photo n'a pas pu être enregistrée : ${errDoc.message}`);
  }
  const { error: errLien } = await sbClient.from('recipe_document_links')
    .insert({ recipe_id: recetteId, document_id: doc.id, display_order: 100 });
  if (errLien) {
    // Le constructeur de requête n'a pas de .catch : c'est un « thenable ».
    try { await sbClient.from('recipe_documents').delete().eq('id', doc.id); } catch { /* déjà parti */ }
    await sbClient.storage.from('recipe-photos').remove([chemin]).catch(() => {});
    throw new Error(`La photo n'a pas pu être rattachée à la recette : ${errLien.message}`);
  }
  return { id: doc.id, url };
}

// Chacun retire les photos qu'il a lui-même envoyées (règle « chacun retire sa
// propre photo ») ; le lien part avec, par cascade.
async function retirerPhotoDuPlat(documentId, objectPath) {
  if (!sbClient || !currentUser) throw new Error('Connecte-toi pour retirer ta photo.');
  const { error } = await sbClient.from('recipe_documents').delete()
    .eq('id', documentId).eq('uploaded_by', currentUser.id);
  if (error) throw new Error(`La photo n'a pas pu être retirée : ${error.message}`);
  if (objectPath) await sbClient.storage.from('recipe-photos').remove([objectPath]).catch(() => {});
}
