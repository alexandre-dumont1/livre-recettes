// Serveur du Livre de Recettes.
//
// Quatre rôles, rien de plus :
//   1. servir les fichiers du site
//   2. générer /config.js à la volée depuis les variables d'environnement, pour
//      que les clés Supabase ne soient jamais écrites dans un fichier du repo
//   3. garder le projet Supabase éveillé (le plan gratuit met en pause après
//      7 jours sans activité, ce qui casserait le site)
//   4. transcrire la photo d'une recette (POST /api/transcrire), parce que la
//      clé du modèle ne doit jamais atteindre le navigateur
//
// Aucune dépendance : Node suffit largement.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('⚠️  SUPABASE_URL ou SUPABASE_ANON_KEY manquante : le site chargera mais restera vide.');
}

// Liste explicite plutôt qu'un dossier entier : les anciennes versions
// (livre_recettes_1.html, _2) et les maquettes de demos/ ne doivent pas être
// accessibles publiquement. Pour en exposer une, il faut l'ajouter ici.
const FICHIERS = {
  '/': { file: 'livre_recettes.html', type: 'text/html; charset=utf-8' },
  '/livre_recettes.html': { file: 'livre_recettes.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/tokens.css': { file: 'tokens.css', type: 'text/css; charset=utf-8' },
};

// Le HTML n'est jamais mis en cache, sinon une correction de recette peut mettre
// des heures à apparaître chez quelqu'un. Le CSS et le JS sont revalidés.
const CACHE = {
  'text/html; charset=utf-8': 'no-cache',
  'text/javascript; charset=utf-8': 'public, max-age=0, must-revalidate',
  'text/css; charset=utf-8': 'public, max-age=0, must-revalidate',
};

function configJs() {
  // JSON.stringify protège contre une valeur contenant un guillemet ou un
  // retour à la ligne, qui casserait le script côté navigateur.
  return `// Généré par le serveur, jamais stocké sur disque.
window.APP_CONFIG = {
  supabaseUrl: ${JSON.stringify(SUPABASE_URL)},
  supabaseKey: ${JSON.stringify(SUPABASE_ANON_KEY)}
};
`;
}

// ── TRANSCRIPTION D'UNE PHOTO DE RECETTE ─────────────────────────────────────
// Le navigateur envoie l'image, le serveur interroge le modèle et rend une
// recette structurée. La clé reste ici : mise dans /config.js elle serait
// lisible par n'importe qui, et facturable par n'importe qui.
//
// Les PDF qui contiennent déjà leur texte ne passent PAS par ici : le navigateur
// les lit tout seul avec pdf.js. Cette route ne sert que ce qu'aucun texte ne
// décrit — les photos et les scans.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const TRANSCRIPTION_MAX_OCTETS = 8 * 1024 * 1024;

// Le quota gratuit se compte à la journée : un seul membre ne doit pas pouvoir
// le vider en tenant une touche. Une fenêtre glissante en mémoire suffit, le
// serveur est unique.
const TRANSCRIPTION_PAR_HEURE = 40;
const compteurs = new Map();

function quotaDepasse(cle) {
  const maintenant = Date.now();
  const recents = (compteurs.get(cle) || []).filter(t => maintenant - t < 3600_000);
  if (recents.length >= TRANSCRIPTION_PAR_HEURE) {
    compteurs.set(cle, recents);
    return true;
  }
  recents.push(maintenant);
  compteurs.set(cle, recents);
  return false;
}

// Le schéma est imposé au modèle : sans lui, il rend du texte libre qu'il
// faudrait deviner. Les champs restent tous facultatifs, une fiche manuscrite ne
// dit presque jamais la difficulté ni le temps de repos.
const SCHEMA_UNE_RECETTE = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    attribution: { type: 'string' },
    category: { type: 'string', enum: ['Entrées', 'Plats', 'Poissons', 'Desserts', 'Gibier', 'Accompagnements'] },
    servings: { type: 'integer' },
    servings_unit: { type: 'string' },
    prep_time_minutes: { type: 'integer' },
    cook_time_minutes: { type: 'integer' },
    rest_time_minutes: { type: 'integer' },
    difficulty: { type: 'string', enum: ['facile', 'moyen', 'difficile'] },
    tags: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          quantity: { type: 'number' },
          unit: { type: 'string' },
          name: { type: 'string' },
          preparation: { type: 'string' },
          group_label: { type: 'string' }
        },
        required: ['name']
      }
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          duration_minutes: { type: 'integer' },
          temperature_celsius: { type: 'integer' }
        },
        required: ['description']
      }
    },
    lisibilite: { type: 'string', enum: ['bonne', 'partielle', 'illisible'] },
    incertitudes: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'lisibilite']
};

// Un feuillet peut porter plusieurs recettes : deux versions des madeleines, la
// crème anglaise à côté des œufs au lait. Quatre documents sont déjà dans ce cas
// en base. Le modèle rend donc TOUJOURS une liste, même à un seul élément.
const SCHEMA_RECETTE = {
  type: 'object',
  properties: { recettes: { type: 'array', items: SCHEMA_UNE_RECETTE } },
  required: ['recettes']
};

const CONSIGNE = `Tu transcris une fiche de recette de cuisine familiale, souvent manuscrite en français, parfois photographiée de travers.

Règles absolues :
- Ne recopie QUE ce qui est écrit. N'invente jamais une quantité, un temps, une étape ou un ingrédient qui ne figure pas sur la fiche. Un champ absent doit rester absent.
- Garde les mots de la fiche, y compris les tournures anciennes ou régionales ("faire revenir", "un verre à moutarde de"). Ne modernise pas, ne reformule pas.
- Découpe les étapes comme la fiche les découpe. Si elle est écrite en un seul paragraphe, rends une seule étape.
- attribution : uniquement si la fiche cite une origine extérieure (un chef, un livre, un magazine, un site). Ne mets jamais un prénom de famille dedans.
- lisibilite : "bonne" si tu es sûr de tout, "partielle" si des passages sont douteux, "illisible" si tu n'as pu lire presque rien.
- incertitudes : la liste des passages dont tu n'es pas sûr, en citant les mots concernés. C'est ce qui permettra à la personne de vérifier les bons endroits.

UNE RECETTE OU PLUSIEURS ? C'est la décision la plus importante. Applique ce test :

Rends PLUSIEURS recettes seulement si la fiche porte des préparations réellement distinctes, chacune avec sa propre méthode ou ses propres quantités. Exemples : deux versions des madeleines côte à côte ; une crème anglaise et des œufs au lait sur la même page.

Rends UNE SEULE recette, avec des groupes d'ingrédients (group_label), quand la fiche est une liste de variantes ou de combinaisons SANS méthode propre à chacune. Exemple typique : une page "Salades composées" avec huit salades nommées, chacune n'étant qu'une liste d'ingrédients. Le titre de chaque variante devient son group_label, et la recette garde le titre de la page.

Utilise aussi group_label à l'intérieur d'une recette quand la fiche sépare elle-même les ingrédients : "Pour la pâte" / "Pour la garniture" / "Marinade".

En cas de doute, rends UNE recette : fusionner deux recettes est un clic dans l'aperçu, alors qu'une page fantôme publiée doit être supprimée à la main en base.

Rends uniquement du JSON conforme au schéma.`;

function litCorps(req, maxOctets) {
  return new Promise((resolve, reject) => {
    let taille = 0;
    const morceaux = [];
    req.on('data', c => {
      taille += c.length;
      // On coupe la connexion au lieu de lire 200 Mo en mémoire.
      if (taille > maxOctets) {
        reject(new Error('trop-gros'));
        req.destroy();
        return;
      }
      morceaux.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(morceaux)));
    req.on('error', reject);
  });
}

// L'appel ne doit être ouvert qu'à un membre approuvé : sinon la route devient un
// accès gratuit au modèle pour qui trouve l'adresse. On vérifie le jeton auprès
// de Supabase, puis le statut du membre — la policy « chacun voit sa propre
// fiche » fait que le jeton ne peut lire que sa propre ligne.
async function membreApprouve(autorisation) {
  if (!autorisation?.startsWith('Bearer ') || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const entetes = { apikey: SUPABASE_ANON_KEY, Authorization: autorisation };
  try {
    const ru = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: entetes });
    if (!ru.ok) return null;
    const utilisateur = await ru.json();
    const rm = await fetch(
      `${SUPABASE_URL}/rest/v1/family_members?select=status&user_id=eq.${utilisateur.id}`,
      { headers: entetes }
    );
    if (!rm.ok) return null;
    const fiches = await rm.json();
    return fiches[0]?.status === 'approved' ? utilisateur.id : null;
  } catch (err) {
    console.error('[transcrire] vérification du membre impossible :', err.message);
    return null;
  }
}

function json(res, code, charge) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(charge));
}

async function transcrire(req, res) {
  if (!GEMINI_API_KEY) {
    // 501 et non 500 : ce n'est pas une panne, c'est une fonctionnalité non
    // configurée. Le navigateur sait alors basculer sur l'aperçu sans
    // transcription au lieu d'afficher une erreur.
    return json(res, 501, { erreur: 'transcription-non-configuree' });
  }

  const membre = await membreApprouve(req.headers.authorization);
  if (!membre) return json(res, 403, { erreur: 'acces-refuse' });
  if (quotaDepasse(membre)) return json(res, 429, { erreur: 'quota-horaire-atteint' });

  let corps;
  try {
    corps = JSON.parse(await litCorps(req, TRANSCRIPTION_MAX_OCTETS));
  } catch (err) {
    return json(res, err.message === 'trop-gros' ? 413 : 400, { erreur: 'corps-illisible' });
  }

  const pages = Array.isArray(corps?.pages) ? corps.pages.slice(0, 12) : [];
  const valides = pages.filter(p =>
    typeof p?.data === 'string' && /^image\/(jpeg|png|webp)$/.test(p?.mime || '')
  );
  // Le texte déjà extrait d'un PDF par le navigateur suffit à lui seul : c'est
  // même le cas le moins cher et le plus fiable, il n'y a plus rien à déchiffrer.
  const texte = typeof corps?.texte === 'string' ? corps.texte.slice(0, 60_000).trim() : '';
  if (!valides.length && !texte) return json(res, 400, { erreur: 'aucune-page-exploitable' });

  const parts = [{ text: CONSIGNE }];
  if (texte) {
    parts.push({ text: `Voici le texte de la fiche, déjà extrait du PDF. Structure-le sans rien inventer :\n\n${texte}` });
  }
  if (valides.length > 1) {
    parts.push({ text: `Ces ${valides.length} images sont les pages successives d'UNE SEULE recette. Transcris-la en un seul objet.` });
  }
  valides.forEach(p => parts.push({ inlineData: { mimeType: p.mime, data: p.data } }));

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: SCHEMA_RECETTE,
            temperature: 0   // on transcrit, on n'imagine pas
          }
        }),
        signal: AbortSignal.timeout(90_000)
      }
    );

    if (!r.ok) {
      const detail = await r.text();
      console.error(`[transcrire] modèle ${r.status} :`, detail.slice(0, 400));
      // 429 chez Google = quota gratuit épuisé pour aujourd'hui. On le dit tel
      // quel, c'est une information utile et pas une panne.
      return json(res, r.status === 429 ? 429 : 502, {
        erreur: r.status === 429 ? 'quota-modele-epuise' : 'modele-injoignable'
      });
    }

    const reponse = await r.json();
    const rendu = reponse?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!rendu) return json(res, 502, { erreur: 'reponse-vide' });

    const analyse = JSON.parse(rendu);
    // On tolère l'ancienne forme (un objet seul) au cas où le modèle l'oublie :
    // mieux vaut une recette que rien du tout.
    const recettes = Array.isArray(analyse?.recettes) ? analyse.recettes
      : analyse?.title ? [analyse] : [];
    if (!recettes.length) return json(res, 502, { erreur: 'aucune-recette-lue' });

    return json(res, 200, { recettes: recettes.slice(0, 10) });
  } catch (err) {
    console.error('[transcrire] échec :', err.message);
    return json(res, 502, { erreur: err.name === 'TimeoutError' ? 'delai-depasse' : 'modele-injoignable' });
  }
}

const server = createServer(async (req, res) => {
  const chemin = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (req.method === 'POST' && chemin === '/api/transcrire') {
    return transcrire(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Méthode non autorisée');
  }

  // Sonde de santé pour Railway
  if (chemin === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (chemin === '/config.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store', // contient une clé : on ne la met jamais en cache
    });
    return res.end(configJs());
  }

  const cible = FICHIERS[chemin];
  if (!cible) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<p>Cette page n\'existe pas. <a href="/">Retour au livre</a></p>');
  }

  try {
    const contenu = await readFile(join(ROOT, cible.file));
    res.writeHead(200, {
      'Content-Type': cible.type,
      'Cache-Control': CACHE[cible.type] || 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(contenu);
  } catch (err) {
    console.error(`Lecture impossible de ${cible.file} :`, err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erreur serveur');
  }
});

// ── Garder Supabase éveillé ───────────────────────────────────────────────────
// Le plan gratuit met un projet en pause après 7 jours sans activité en base.
// Un site de famille passe très facilement une semaine sans visite. Comme ce
// serveur tourne en continu, autant qu'il fasse le ping lui-même : ça évite un
// service externe de plus.

const PING_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h, large marge sur les 7 jours

async function pingSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/recipes?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    console.log(`[ping supabase] ${r.status}`);
  } catch (err) {
    // On ne fait pas tomber le serveur pour un ping raté : le site reste lisible
    // même si Supabase est momentanément injoignable.
    console.error('[ping supabase] échec :', err.message);
  }
}

server.listen(PORT, () => {
  console.log(`Le Livre de Recettes écoute sur le port ${PORT}`);
  pingSupabase();
  setInterval(pingSupabase, PING_INTERVAL_MS);
});

// Railway envoie SIGTERM avant de remplacer une instance.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} reçu, arrêt propre.`);
    server.close(() => process.exit(0));
  });
}
