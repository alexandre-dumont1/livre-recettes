"""Ses feuilles en images, préparées à l'avance, pour qu'elles s'ouvrent tout de suite.

Avant, le téléphone chargeait pdf.js (1,4 Mo), téléchargeait le PDF, dessinait
chaque page puis la recadrait : plusieurs secondes sur un téléphone moyen. Ici on
fait ce travail une fois pour toutes :
  - chaque page de chaque feuille (recipe_documents, kind = manuscript) est rendue
    à la résolution du scan (200 dpi) ;
  - recadrée sur la feuille comme le faisait le site (recadrer() dans nouveau.js :
    on enlève la grande marge blanche de la vitre du scanner) ;
  - écrite en deux tailles : feuilles/<id>-<page>.webp (pleine, pour la loupe) et
    feuilles/<id>-<page>-900.webp (pour la page de la recette).
feuilles-manifeste.js dit au site quelles feuilles existent, et pour quelle
adresse de PDF : si la feuille change d'adresse, le site retombe sur le PDF.

Une feuille ajoutée depuis le site (dépôt d'une recette) s'affiche en PDF tant
qu'on n'a pas relancé ce script.

Usage : ~/one-dm-manou/.venv/bin/python scripts/feuilles-images.py
(lit l'adresse et la clé publique de Supabase dans config.js, jamais affichées)
"""
import hashlib, io, json, os, re, urllib.request
import numpy as np
import pymupdf
from PIL import Image

PETITE = 900

conf = open('config.js').read()
URL = re.search(r"supabaseUrl:\s*['\"]([^'\"]+)", conf)[1]
CLE = re.search(r"supabaseKey:\s*['\"]([^'\"]+)", conf)[1]


def lire(adresse, entetes=None):
    return urllib.request.urlopen(urllib.request.Request(adresse, headers=entetes or {}), timeout=60).read()


def recadrer(g):
    """Même règle que recadrer() du site : ce qui est plus foncé que 225, avec une marge de 2 %."""
    h, w = g.shape
    fonce = g < 225
    lignes, colonnes = fonce.sum(1), fonce.sum(0)
    mini = 3 * max(1, min(w, h) // 500)       # le site échantillonne un point sur « pas »
    ys, xs = np.where(lignes >= mini)[0], np.where(colonnes >= mini)[0]
    if not len(ys) or not len(xs):
        return g
    marge = round(min(w, h) * 0.02)
    x0, y0 = max(0, xs[0] - marge), max(0, ys[0] - marge)
    x1, y1 = min(w, xs[-1] + marge + 1), min(h, ys[-1] + marge + 1)
    cw, ch = x1 - x0, y1 - y0
    if cw * ch > w * h * 0.92 or cw < w * 0.25 or ch < h * 0.25:
        return g
    return g[y0:y1, x0:x1]


docs = json.loads(lire(f'{URL}/rest/v1/recipe_documents?select=id,public_url&kind=eq.manuscript&order=id',
                       {'apikey': CLE, 'Authorization': f'Bearer {CLE}'}))
os.makedirs('feuilles', exist_ok=True)
manifeste, gardes = {}, set()
for d in docs:
    if not d['public_url'].lower().endswith('.pdf'):
        continue
    pdf = pymupdf.open(stream=lire(d['public_url']), filetype='pdf')
    pages = []
    for n, page in enumerate(pdf, 1):
        pix = page.get_pixmap(dpi=200, colorspace=pymupdf.csGRAY)
        g = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, :pix.width]
        g = recadrer(g)
        im = Image.fromarray(g)
        for suffixe, largeur in (('', None), ('-900', PETITE)):
            sortie = im if not largeur or im.width <= largeur else im.resize((largeur, round(im.height * largeur / im.width)), Image.LANCZOS)
            b = io.BytesIO()
            sortie.save(b, 'WEBP', quality=74, method=6)
            nom = f"feuilles/{d['id']}-{n}{suffixe}.webp"
            open(nom, 'wb').write(b.getvalue())
            gardes.add(os.path.basename(nom))
            if not suffixe:
                v = hashlib.md5(b.getvalue()).hexdigest()[:8]
        pages.append([im.width, im.height, v])
    manifeste[d['id']] = {'pdf': d['public_url'], 'pages': pages}
    print(d['id'][:8], len(pages), 'page(s)')

# Les images d'une feuille qui n'existe plus partent avec elle.
for f in os.listdir('feuilles'):
    if f not in gardes:
        os.remove(f'feuilles/{f}')

open('feuilles-manifeste.js', 'w').write(
    "// Généré par scripts/feuilles-images.py : ses feuilles déjà rendues en images.\n"
    "// id du document → { pdf : l'adresse rendue, pages : [[largeur, hauteur, empreinte], …] }\n"
    f"window.FEUILLES = {json.dumps(manifeste, ensure_ascii=False)};\n")
print(len(manifeste), 'feuilles')
