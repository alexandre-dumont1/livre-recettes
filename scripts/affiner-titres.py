"""Agrandit chaque titre trois fois en lissant le trait, pour qu'il reste net en grand.

Ses feuilles ont été scannées à 200 dpi : un petit titre (« Far Breton » fait 3 cm)
n'a que quelques pixels de hauteur de lettre. Affiché en grand sur un écran
Retina, le navigateur l'agrandissait jusqu'à huit fois et on voyait les marches
d'escalier des pixels. Le scan n'a pas plus de détail à donner (vérifié : les
PDF contiennent des images à 200 dpi), alors on redessine le bord du trait :
  1. agrandissement ×3 (bicubique) ;
  2. léger flou, qui transforme les marches en pente douce ;
  3. courbe en S autour de mi-opacité, qui redonne un bord net et lisse.
Réglée pour garder l'épaisseur du trait (+3 % d'encre en moyenne) et ouvrir les
boucles des lettres ; le gris pâle (crayon léger) reste pâle au lieu de disparaître.

Lit scripts/titres-200/<id>.png, écrit titres/<id>.png (servi par le site).
Ordre : decouper → encrer → retoucher → AFFINER → mesurer. Relançable seul.

Usage : ~/one-dm-manou/.venv/bin/python scripts/affiner-titres.py
"""
import os
import cv2
import numpy as np
from PIL import Image

FACTEUR = 3          # repris par mesurer-titres.py
PENTE, SEUIL, FLOU = 12, 0.55, 0.33


def affiner(a):
    a = a.astype(np.float32) / 255
    grand = cv2.resize(a, None, fx=FACTEUR, fy=FACTEUR, interpolation=cv2.INTER_CUBIC).clip(0, 1)
    lisse = cv2.GaussianBlur(grand, (0, 0), FACTEUR * FLOU)
    s = lambda x: 1 / (1 + np.exp(-(x - SEUIL) * PENTE))
    net = (s(lisse) - s(0)) / (s(1) - s(0))
    return (np.maximum(net, lisse * 0.55).clip(0, 1) * 255 + .5).astype(np.uint8)


def enregistrer(alpha, chemin):
    # Une seule encre (#161616, celle du site) et 16 niveaux de transparence :
    # une image à palette de 4 bits, quatre fois plus légère qu'en RGBA, sans
    # différence visible. Les 74 titres pèsent 1,8 Mo au lieu de 7.
    niveaux = np.round(alpha / 17).astype(np.uint8)
    im = Image.fromarray(niveaux, 'P')
    im.putpalette([22, 22, 22] * 16)
    im.save(chemin, 'PNG', optimize=True, bits=4, transparency=bytes(k * 17 for k in range(16)))


if __name__ == '__main__':
    os.makedirs('titres', exist_ok=True)
    fichiers = [f for f in os.listdir('scripts/titres-200') if f.endswith('.png')]
    for f in fichiers:
        a = cv2.imread(f'scripts/titres-200/{f}', cv2.IMREAD_UNCHANGED)[..., 3]
        enregistrer(affiner(a), f'titres/{f}')
    print(len(fichiers), 'titres affinés ×', FACTEUR)
