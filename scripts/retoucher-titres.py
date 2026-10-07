"""Efface à la main les dernières traces qui ne sont pas de son écriture.

Après le découpage automatique, il restait quelques marques sur certains titres :
un trou de perforateur, le trait de la marge, des bouts de la ligne d'en dessous.
Pour chaque titre, on donne des zones (en pixels de scripts/titres-200/<id>.png) ;
on efface chaque tache d'encre ENTIÈREMENT contenue dans une zone. Une lettre qui
déborde de la zone n'est jamais touchée : on ne coupe jamais un trait.

Ensuite on resserre l'image à gauche et à droite (une trace effacée au bord
laisserait un vide). Jamais en haut ni en bas : la ligne d'écriture mesurée à
l'œil (scripts/titres-mesures.json) se compte depuis le haut de l'image.

Ordre du pipeline : decouper → encrer → RETOUCHER → affiner → mesurer.
Les zones sont en pixels de la sortie d'encrer-titres.py, AVANT le resserrage :
ne jamais le relancer seul sur ses propres sorties (comme encrer, qui épaissirait
deux fois), toujours repartir de decouper.

Usage : ~/one-dm-manou/.venv/bin/python scripts/retoucher-titres.py
"""
import cv2
import numpy as np

ZONES = {
    23: [(188, 0, 214, 16)],                          # point égaré au-dessus de « Crumble »
    39: [(575, 0, 647, 96)],                          # rond pointé après « abricots »
    45: [(878, 0, 896, 182)],                         # trait de marge après « Véro »
    56: [(44, 74, 72, 105), (456, 76, 492, 105)],     # bouts de la ligne d'en dessous
    58: [(0, 52, 34, 114)],                           # tirets devant « Lasagnes »
    70: [(424, 0, 445, 30)],                          # trace en haut à droite
    93: [(0, 0, 60, 40), (600, 0, 660, 40)],          # arcs des trous de perforateur
    96: [(140, 0, 160, 15)],                          # point au-dessus de « Reine »
    114: [(125, 62, 140, 82)],                        # coche entre « Tajine » et « de »
    119: [(236, 42, 265, 68)],                        # croix après « Breton »
    134: [(0, 145, 210, 163), (335, 150, 347, 163)],  # bouts de la ligne d'en dessous
}

for i, zones in ZONES.items():
    chemin = f'scripts/titres-200/{i}.png'
    im = cv2.imread(chemin, cv2.IMREAD_UNCHANGED)
    a = im[..., 3]
    n, lab, st, _ = cv2.connectedComponentsWithStats((a > 40).astype(np.uint8), 8)
    efface = np.zeros(a.shape, np.uint8)
    nb = 0
    for k in range(1, n):
        x, y, w, h = st[k, :4]
        if any(x >= x0 and y >= y0 and x + w <= x1 and y + h <= y1 for x0, y0, x1, y1 in zones):
            efface[lab == k] = 1
            nb += 1
    # Le halo pâle autour de la tache part avec elle, sans mordre sur une autre tache.
    halo = cv2.dilate(efface, np.ones((5, 5), np.uint8)) > 0
    a[halo & ((lab == 0) | (efface > 0))] = 0
    # Resserrer à gauche et à droite.
    cols = np.where((a > 40).any(0))[0]
    x0, x1 = max(0, cols[0] - 4), min(a.shape[1], cols[-1] + 5)
    im[..., 3] = a
    cv2.imwrite(chemin, im[:, x0:x1])
    print(f'{i} : {nb} trace(s) effacée(s), largeur {a.shape[1]} → {x1 - x0}')
