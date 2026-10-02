"""Efface des titres manuscrits les arcs des trous de classeur.

Un trou de classeur scanné laisse un petit croissant (« ◡ ») de 20 à 60 px de
large à 200 dpi, creux, plus large que haut. Un accent fait moins de 15 px, un
morceau de soulignement est plein et très plat : ni l'un ni l'autre ne passe le
filtre. On travaille toujours depuis les découpes d'origine
(~/Documents/livre-manou-titres/titres), jamais sur un fichier déjà nettoyé.

Usage : ~/one-dm-manou/.venv/bin/python scripts/nettoyer-titres.py
"""
import cv2, numpy as np, os, json
SRC = os.path.expanduser('~/Documents/livre-manou-titres/titres')
# Hauteur gardée (en px) pour les titres qui ont des marques parasites dessous.
COUPER_BAS = {58: 66, 94: 160}
total = 0
for f in sorted(os.listdir(SRC), key=lambda x: int(x.split('.')[0])):
    i = int(f.split('.')[0])
    im = cv2.imread(f'{SRC}/{f}', cv2.IMREAD_UNCHANGED)
    if i in COUPER_BAS: im = im[:COUPER_BAS[i]]
    a = im[..., 3]
    m = (a > 40).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    for j in range(1, n):
        x, y, w, h, aire = st[j]
        rempli = aire / max(w * h, 1)
        if not (20 <= w <= 60 and 6 <= h <= 24 and w / h >= 1.8 and rempli < 0.35):
            continue
        # Forme de croissant ouvert vers le haut : au centre, l'encre n'est que
        # dans le bas de la boîte (un « au » ou un « ro » a de l'encre en haut).
        bloc = (lab[y:y + h, x:x + w] == j)
        centre = bloc[:, w // 4: 3 * w // 4]
        haut = centre[: int(h * .5)].sum()
        bord = x < 6 or x + w > im.shape[1] - 6
        # Et placé dans le haut de la découpe, ou collé à un bord : là où tombent
        # les trous, jamais sur la ligne d'écriture.
        if haut == 0 and (y + h < im.shape[0] * .4 or bord):
            a[lab == j] = 0; total += 1
    im[..., 3] = a
    cv2.imwrite(f'titres/{f}', im)
print(total, 'arcs effacés')
