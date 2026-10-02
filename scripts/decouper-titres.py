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

def encre(g, x0, x1, y0, y1, verticales=True):
    """La zone en alpha d'encre 0-255, quadrillage pâle retiré."""
    H, W = g.shape
    Y0, Y1, X0, X1 = int(H * y0 / 100), int(H * y1 / 100), int(W * x0 / 100), int(W * x1 / 100)
    c = g[Y0:Y1, X0:X1].astype(float)
    bg = np.percentile(c, 75); lo = np.percentile(c, 0.8)
    a = np.clip(((bg - c) / max(bg - lo, 1) - 0.28) / 0.5, 0, 1) * 255
    h, w = a.shape; m = (a > 40).astype(np.uint8) * 255
    v = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(3, int(h * .85)))))
    if not verticales: v[:] = 0
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

# On COMPLÈTE le fichier existant : relancer sur quelques titres seulement ne
# doit pas effacer les mesures des autres (vécu le 02/10).
# Réglages titre par titre, décidés à l'œil sur la planche de vérification.
OPTIONS = {
    '2': {'traits': True}, '56': {'traits': True}, '76': {'traits': True},
    '85': {'brut': True}, '93': {'brut': True}, '106': {'brut': True}, '96': {'brut': True},
}
nouvelles = json.load(open('scripts/titres-mesures.json')) if os.path.exists('scripts/titres-mesures.json') else {}
nouvelles['_note'] = 'Généré par decouper-titres.py : [hauteur d’x, ligne de base] dans titres/<id>.png.'
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
    a, Y0, X0 = encre(g, max(0, x0 - 3), min(100, x1 + 3), max(0, y0 - 1.6), min(100, y1 + 1.6),
                      verticales=not OPTIONS.get(k, {}).get('sans_verticales'))
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
    # Mode « brut » : pour les feuilles où le nettoyage abîme des lettres (lettres
    # posées sur le trait, crayon très pâle), on garde l'encre de la zone repérée
    # telle quelle, quadrillage pâle retiré seulement.
    if OPTIONS.get(k, {}).get('brut'):
        a, Y0, X0 = encre(g, x0, x1, y0, y1, verticales=False)
        a, oy2, _ = serrer(a)
        rgba = np.zeros(a.shape + (4,), np.uint8); rgba[..., :3] = 20; rgba[..., 3] = a.astype(np.uint8)
        cv2.imwrite(f'titres/{k}.png', rgba)
        nouvelles[k] = [hx, int(base_page - Y0 - oy2)]
        continue
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
    # 6. Dernier nettoyage, demandé le 02/10 (« sois sûr que chaque titre soit
    #    propre ») : les lettres sont les masses d'au moins 0,6 hauteur d'x.
    #    · tout ce qui est plat et long part : restes de quadrillage ET
    #      soulignements (l'index n'en a pas besoin, et ils laissaient des traînées)
    #    · tout ce qui est loin de toute lettre part : points, arcs, bord de feuille
    m3 = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m3, connectivity=8)
    plat = lambda x, y, cw, ch: ch < hx * .5 and cw > hx * 1.5 and cw / max(ch, 1) > 4
    lettres = [j for j in range(1, n) if st[j, 3] >= hx * .6 and not plat(*st[j, :4])
               and not (st[j, 2] <= 6 and (st[j, 0] <= 4 or st[j, 0] + st[j, 2] >= w - 4))]
    def distance(j, i):
        x, y, cw, ch = st[j, :4]; X, Y, CW, CH = st[i, :4]
        dx = max(X - (x + cw), x - (X + CW), 0); dy = max(Y - (y + ch), y - (Y + CH), 0)
        return max(dx, dy)
    for j in range(1, n):
        if j in lettres: continue
        x, y, cw, ch, aire = st[j]
        loin = not lettres or min(distance(j, i) for i in lettres) > hx * .9
        if plat(x, y, cw, ch) or loin: a[lab == j] = 0
    # un bord de feuille vertical collé au côté de la découpe
    for j in range(1, n):
        x, y, cw, ch, aire = st[j]
        if cw <= 8 and (x <= 4 or x + cw >= w - 4): a[lab == j] = 0
    #    · les fragments PÂLES : restes de quadrillage et de soulignement au
    #      crayon. Mesuré : ses lettres ont une encre moyenne de 140-210, ces
    #      fragments 40-110. On compare à la médiane des vraies lettres de CE titre
    #      (un titre au crayon clair a tout plus pâle). Les accents et les points
    #      sur les i, petits mais foncés, restent.
    m4 = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m4, connectivity=8)
    moy = np.array([a[lab == j].mean() if j else 0 for j in range(n)])
    gros = [j for j in range(1, n) if st[j, 4] >= hx * hx * .5]
    if gros:
        ref = float(np.median(moy[gros]))
        for j in range(1, n):
            x, y, cw, ch, aire = st[j]
            if aire <= 4 or (ch < hx * .45 and moy[j] < ref * .65):
                a[lab == j] = 0
    #    · sous la dernière ligne d'écriture, un trait plat est un soulignement
    #      ou une traînée de crayon (les jambages, eux, tiennent à leur lettre)
    #    · un arc de trou tout en haut de la découpe, à l'écart des lettres, même
    #      quand il est plus haut que large (mesuré : 41 × 33 px sur le n° 51)
    m5 = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m5, connectivity=8)
    lettres = [j for j in range(1, n) if st[j, 3] >= hx * .6]
    for j in range(1, n):
        x, y, cw, ch, aire = st[j]
        if y >= b_loc - hx * .1 and cw > ch * 3 and ch < hx * .8:
            a[lab == j] = 0; continue
        if y <= h * .12 and aire / max(cw * ch, 1) < .25:
            centre = (lab[y:y + ch, x:x + cw] == j)[:, cw // 4: 3 * cw // 4]
            rc = np.nonzero(centre.any(1))[0]
            autres = [i for i in lettres if i != j]
            if len(rc) and rc.min() >= ch * .35 and (not autres or min(distance(j, i) for i in autres) > hx * .5):
                a[lab == j] = 0
    #    · sous la ligne d'écriture, les traînées de crayon soudées à un jambage
    #      (« g » de Lasagnes) : on efface au pixel ce qui est PÂLE ; le jambage,
    #      tracé franchement, est plus foncé et reste.
    if gros:
        sous = slice(min(h, int(b_loc + hx * .15)), h)
        z = a[sous]; z[z < ref * .7] = 0; a[sous] = z
    #    · les soulignements, au pixel : aucune lettre n'a un trait horizontal
    #      droit de 4 hauteurs d'x. (À 2,5, des lettres épaisses y passaient.)
    trait = cv2.morphologyEx((a > 40).astype(np.uint8), cv2.MORPH_OPEN,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (int(hx * 4), 1)))
    a[trait > 0] = 0
    #    · les soulignements épais collés aux lettres, par longueur de passage,
    #      SEULEMENT pour les titres listés dans OPTIONS : appliqué à tous, ce
    #      passage a mangé des lettres (Tiramisu, « aux ») le 02/10.
    if OPTIONS.get(k, {}).get('traits'):
      mm = cv2.morphologyEx((a > 40).astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 1)))
      efface = np.zeros_like(mm)
      for yy in range(max(0, int(b_loc - hx * .25)), h):
          ligne = mm[yy]; xx = 0
          while xx < w:
              if ligne[xx]:
                  x0_ = xx
                  while xx < w and ligne[xx]: xx += 1
                  if xx - x0_ > hx * 2.2: efface[yy, x0_:xx] = 1
              xx += 1
      efface = cv2.dilate(efface, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)))
      a[efface > 0] = 0
    #    · les miettes, avec prudence (une règle plus large avait mangé des
    #      lettres le 02/10) : des POINTS minuscules sous la ligne d'écriture, et
    #      près d'un bord, en haut, un petit arc creux.
    m6 = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m6, connectivity=8)
    for j in range(1, n):
        x, y, cw, ch, aire = st[j]
        bord = x + cw < w * .08 or x > w * .92
        if aire < hx * hx * .08 and y > b_loc:
            a[lab == j] = 0
        elif bord and y + ch < h * .35 and aire / max(cw * ch, 1) < .3 and aire < hx * hx * .6:
            a[lab == j] = 0
    # 7. Serrer sur ce qui reste, et recaler la ligne de base
    a, oy2, _ = serrer(a)
    rgba = np.zeros(a.shape + (4,), np.uint8); rgba[..., :3] = 20; rgba[..., 3] = a.astype(np.uint8)
    cv2.imwrite(f'titres/{k}.png', rgba)
    nouvelles[k] = [hx, int(base_page - Y0 - oy2)]

# Fichier SÉPARÉ : titres-mesures-oeil.json reste la mesure d'origine (relative
# aux anciennes découpes) ; le relancer ne décale donc rien.
json.dump(nouvelles, open('scripts/titres-mesures.json', 'w'), ensure_ascii=False, indent=0)
print('découpés :', len(seuls) if seuls else len(B))
