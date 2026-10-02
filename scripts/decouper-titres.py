"""Découpe ses titres manuscrits sur les feuilles, en ne gardant QUE le titre.

Entrées :
  ~/Documents/livre-manou-titres/hi/<id>.png  la feuille rendue à 200 dpi
  scripts/titres-boites.json                  la zone du titre, repérée à l'œil
                                               (en % de la page : x0, x1, y0, y1)
  scripts/titres-mesures-oeil.json            hauteur d'x et ligne de base, à l'œil
Sortie : titres/<id>.png (encre en noir sur fond transparent), et
scripts/titres-mesures.json (les mesures recalées sur la nouvelle découpe).

Deux défauts corrigés le 02/10 : des titres COUPÉS (zone trop serrée) et des
titres qui emportaient des BOUTS DES LIGNES VOISINES. On découpe donc large,
puis on ne garde que les traits qui traversent la bande où s'écrit le titre,
plus ses accents et son soulignement.

Usage : ~/one-dm-manou/.venv/bin/python scripts/decouper-titres.py [ids…]
"""
import cv2, numpy as np, json, os, sys

HI = os.path.expanduser('~/Documents/livre-manou-titres/hi')
B = json.load(open('scripts/titres-boites.json'))
M = json.load(open('scripts/titres-mesures-oeil.json'))
seuls = set(sys.argv[1:])

def encre(g, x0, x1, y0, y1):
    """La zone en alpha d'encre 0-255, quadrillage pâle retiré."""
    H, W = g.shape
    Y0, Y1, X0, X1 = int(H * y0 / 100), int(H * y1 / 100), int(W * x0 / 100), int(W * x1 / 100)
    c = g[Y0:Y1, X0:X1].astype(float)
    bg = np.percentile(c, 75); lo = np.percentile(c, 0.8)
    a = np.clip(((bg - c) / max(bg - lo, 1) - 0.28) / 0.5, 0, 1) * 255
    h, w = a.shape; m = (a > 40).astype(np.uint8) * 255
    v = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(3, int(h * .85)))))
    hz = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(w * .3)), 1)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(hz)
    for j in range(1, n):
        z = lab == j
        if a[z].mean() >= 150 and st[j, 3] >= 3: hz[z] = 0      # soulignement sombre : gardé
    a[cv2.dilate(cv2.bitwise_or(v, hz), np.ones((3, 3), np.uint8)) > 0] = 0
    return a, Y0, X0

def serrer(a):
    ys, xs = np.nonzero(a > 90)
    if not len(xs): return a, 0, 0
    oy, ox = max(ys.min() - 6, 0), max(xs.min() - 6, 0)
    return a[oy:ys.max() + 6, ox:xs.max() + 6], oy, ox

nouvelles = {'_note': 'Généré par decouper-titres.py : [hauteur d’x, ligne de base] dans titres/<id>.png.'}
for k, (x0, x1, y0, y1) in B.items():
    if seuls and k not in seuls: continue
    g = cv2.imread(f'{HI}/{k}.png', cv2.IMREAD_GRAYSCALE)
    H, W = g.shape
    hx, base = M[k]
    # 1. L'ancienne découpe, seulement pour savoir où tombaient les mesures à l'œil
    a_old, Y0o, X0o = encre(g, x0, x1, y0, y1)
    _, oy, _ = serrer(a_old)
    base_page = Y0o + oy + base                     # la ligne d'écriture, en pixels de la page
    # 2. Découpe large : plus rien de coupé
    a, Y0, X0 = encre(g, max(0, x0 - 3), min(100, x1 + 3), max(0, y0 - 1.6), min(100, y1 + 1.6))
    h, w = a.shape
    m = (a > 40).astype(np.uint8)
    # 3. La bande du titre : le corps de ses lettres, sur ses lignes. Les rangées
    #    les plus encrées DANS la zone repérée (les bouts d'autres lignes sont fins).
    zy0, zy1 = int(H * y0 / 100) - Y0, int(H * y1 / 100) - Y0
    sans_trait = m.copy()
    soude = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(w * .03)), 3)))
    trait = cv2.morphologyEx(soude, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(w * .12)), 1)))
    sans_trait[trait > 0] = 0
    prof = cv2.blur(sans_trait.sum(1).astype(float).reshape(-1, 1), (1, 5)).ravel()
    dans = np.zeros(h, bool); dans[max(zy0, 0):min(zy1, h)] = True
    pic = prof[dans].max() if dans.any() else prof.max()
    coeur = dans & (prof >= pic * .3)
    b_loc = base_page - Y0
    coeur[max(0, b_loc - hx):min(h, b_loc)] = True     # la dernière ligne, sûre (mesure à l'œil)
    rangs = np.nonzero(coeur)[0]
    bas_coeur = rangs.max()
    # 4. Garder les traits qui traversent la bande, puis accents et soulignement
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    garde = np.zeros(n, bool)
    for j in range(1, n):
        x, y, cw, ch, aire = st[j]
        if coeur[y:y + ch].any() and aire >= 12: garde[j] = True
    for j in range(1, n):
        if garde[j]: continue
        x, y, cw, ch, aire = st[j]
        dessus = [i for i in range(1, n) if garde[i] and st[i, 0] < x + cw and x < st[i, 0] + st[i, 2]
                  and 0 <= st[i, 1] - (y + ch) <= hx * 1.6]
        # accent, point sur un i : petit, et pas plus large qu'une lettre (un arc
        # de trou de classeur, lui, fait deux à trois lettres de large)
        if aire < 400 and cw <= hx * 1.1 and dessus: garde[j] = True
        elif cw > w * .2 and ch < hx * .8 and 0 <= y - bas_coeur <= hx * 1.9: garde[j] = True   # soulignement
    a[~garde[lab]] = 0
    # 5. Les arcs des trous de classeur (croissant ouvert vers le haut, en haut ou au bord)
    m2 = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m2, connectivity=8)
    for j in range(1, n):
        x, y, cw, ch, aire = st[j]
        if not (12 <= cw <= 110 and 4 <= ch <= 34 and cw / ch >= 1.8 and aire / (cw * ch) < .4): continue
        centre = (lab[y:y + ch, x:x + cw] == j)[:, cw // 4: 3 * cw // 4]
        # au-dessus du corps de la dernière ligne (un trou n'est jamais sur la
        # ligne d'écriture), ou collé à un bord
        lignes_c = np.nonzero(centre.any(1))[0]
        # isolé : aucune autre masse d'encre dans sa colonne (un « u » a ses voisines)
        isole = not any(st[i, 4] >= 60 and i != j and st[i, 0] < x + cw and x < st[i, 0] + st[i, 2] for i in range(1, n))
        if len(lignes_c) and lignes_c.min() >= ch * .35 and (y + ch < b_loc - hx * .5 or x < 6 or x + cw > w - 6 or isole):
            a[lab == j] = 0
    # 6. Serrer sur ce qui reste, et recaler la ligne de base
    a, oy2, _ = serrer(a)
    rgba = np.zeros(a.shape + (4,), np.uint8); rgba[..., :3] = 20; rgba[..., 3] = a.astype(np.uint8)
    cv2.imwrite(f'titres/{k}.png', rgba)
    nouvelles[k] = [hx, int(base_page - Y0 - oy2)]

# Fichier SÉPARÉ : titres-mesures-oeil.json reste la mesure d'origine (relative
# aux anciennes découpes) ; le relancer ne décale donc rien.
json.dump(nouvelles, open('scripts/titres-mesures.json', 'w'), ensure_ascii=False, indent=0)
print('découpés :', len(seuls) if seuls else len(B))
