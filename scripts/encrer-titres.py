"""Rend ses titres plus lisibles sans toucher à leur forme : même encre noire
pour tous, qu'ils aient été écrits au feutre ou au crayon pâle.

1. Normalise l'encre : le 92e centile de l'opacité des traits devient opaque,
   puis une courbe (gamma 0,6) fonce les gris sans boucher les blancs.
2. Épaissit d'un pixel les traits fins (crayon) et amincit les très épais (feutre).

Travaille sur titres/*.png tout juste sortis de decouper-titres.py : NE PAS le
relancer seul sur des titres déjà encrés (il épaissirait une seconde fois).
Toujours : decouper-titres.py, puis encrer-titres.py, puis mesurer-titres.py.

Usage : ~/one-dm-manou/.venv/bin/python scripts/encrer-titres.py
"""
import cv2, numpy as np, os

for f in sorted(os.listdir('titres')):
    if not f.endswith('.png'): continue
    im = cv2.imread(f'titres/{f}', cv2.IMREAD_UNCHANGED)
    a = im[..., 3].astype(float)
    trait = a[a > 40]
    if not len(trait): continue
    haut = np.percentile(trait, 92)
    a = np.clip(a / max(haut, 1), 0, 1) ** 0.6 * 255
    # épaisseur typique du trait : transformée de distance sur le masque
    m = (a > 110).astype(np.uint8)
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    epaisseur = 2 * np.percentile(dist[dist > 0], 75) if (dist > 0).any() else 0
    if epaisseur < 3.2:
        a = np.maximum(a, cv2.dilate(a, np.ones((2, 2), np.uint8)) * 0.85)
    elif epaisseur > 6:
        # Feutre très épais (Granité, Tatin) : on l'allège pour qu'il ne pèse pas
        # deux fois plus que les titres au crayon voisins.
        a = cv2.erode(a, np.ones((3, 3), np.uint8))
    im[..., 3] = a.astype(np.uint8)
    im[..., :3] = 18
    cv2.imwrite(f'titres/{f}', im)
print('titres encrés')
