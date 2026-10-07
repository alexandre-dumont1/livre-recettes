// Le livre dans la cuisine, même quand le wifi ne passe pas.
//
// Ce qui est gardé sur le téléphone :
//   - le livre lui-même (page, scripts, styles, portrait), à l'installation ;
//   - la liste des recettes et chaque recette déjà ouverte (lecture Supabase) ;
//   - ses titres manuscrits, ses feuilles et les photos déjà vues ;
//   - pdf.js et les polices.
// Ce qui ne l'est jamais : ce qui demande d'être connecté (dépôt, photo,
// demandes d'accès), et tout ce qui n'est pas une lecture (GET).
//
// Règle : on essaie toujours le réseau d'abord pour ce qui peut changer (la
// page, les recettes), et on ne tombe sur la copie que hors ligne. Ce qui ne
// change jamais (un titre versionné, une feuille, une police) se sert de la
// copie directement.

const VERSION = 'livre-v2';
const SOCLE = [
  '/', '/nouveau.js', '/nouveau.css', '/tokens.css', '/contribuer.js', '/contribuer.css',
  '/titres-manifeste.js', '/feuilles-manifeste.js', '/config.js', '/photos/manou-640.jpg', '/photos/manou.jpg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SOCLE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Un wifi de cuisine qui « passe à moitié » est pire qu'aucun réseau : on
// n'attend le réseau que 4 secondes quand on a déjà une copie à montrer.
async function reseauDabord(req) {
  const cache = await caches.open(VERSION);
  const reseau = fetch(req).then(rep => {
    if (rep.ok) cache.put(req, rep.clone());
    return rep;
  });
  const copie = await cache.match(req);
  if (!copie) return reseau;
  return Promise.race([
    reseau.catch(() => copie),
    new Promise(ok => setTimeout(() => ok(copie), 4000)),
  ]);
}

async function copieDabord(req) {
  const cache = await caches.open(VERSION);
  const copie = await cache.match(req);
  if (copie) return copie;
  const rep = await fetch(req);
  // Une police de Google arrive « opaque » (statut 0) : on la garde quand même.
  if (rep.ok || rep.type === 'opaque') cache.put(req, rep.clone());
  return rep;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Une page du livre : réseau, sinon le livre gardé (les recettes sont derrière le #).
  if (req.mode === 'navigate' && url.origin === location.origin) {
    e.respondWith(reseauDabord(req).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
    if (/^\/(titres|partage|icones|feuilles)\//.test(url.pathname)) { e.respondWith(copieDabord(req)); return; }
    e.respondWith(reseauDabord(req));
    return;
  }

  // Supabase : seulement les lectures publiques. Une requête qui porte le jeton
  // d'un membre connecté (son nom, ses droits) ne finit jamais dans le cache.
  if (url.hostname.endsWith('.supabase.co')) {
    if (url.pathname.startsWith('/storage/v1/object/public/')) { e.respondWith(copieDabord(req)); return; }
    if (url.pathname.startsWith('/rest/v1/')) {
      const cle = req.headers.get('apikey');
      if (cle && req.headers.get('Authorization') === `Bearer ${cle}`) e.respondWith(reseauDabord(req));
    }
    return;
  }

  // pdf.js, supabase-js, polices : fixés par leur numéro de version.
  if (['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
    e.respondWith(copieDabord(req));
  }
});
