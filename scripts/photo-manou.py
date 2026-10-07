"""Le portrait de Manou en noir et blanc, pour la première page du livre.

Source (hors dépôt) : ~/Documents/livre-manou-titres/photo/manou-original.jpg
Sortie : photos/manou.jpg (grande) et photos/manou-640.jpg (téléphone).

Le traitement, dans l'ordre :
  1. cadrage portrait 4:5 sur elle (l'épaule voisine et le cadre de porte sortent) ;
  2. noir et blanc « filtre rouge » : le canal rouge éclaircit et adoucit la peau,
     comme le filtre orangé des portraitistes argentiques ;
  3. un léger lissage qui garde les contours (pas de peau en plastique) ;
  4. contraste local doux, courbe en S, noirs posés ;
  5. un vignetage léger qui ramène l'œil au visage, puis un grain fin.

Lancer avec ~/one-dm-manou/.venv/bin/python scripts/photo-manou.py
"""
from pathlib import Path
import cv2
import numpy as np

SRC = Path.home() / 'Documents/livre-manou-titres/photo/manou-original.jpg'
OUT = Path(__file__).resolve().parent.parent / 'photos'

im = cv2.imread(str(SRC)).astype(np.float32) / 255.0
x0, y0, x1, y1 = 600, 40, 1800, 1536          # 1200 × 1496, ≈ 4:5
im = im[y0:y1, x0:x1]

b, g, r = cv2.split(im)
gris = np.clip(0.62 * r + 0.30 * g + 0.08 * b, 0, 1)

# Lissage qui garde les contours, mélangé à 45 % seulement.
lisse = cv2.bilateralFilter(gris, d=9, sigmaColor=0.07, sigmaSpace=9)
gris = 0.38 * gris + 0.62 * lisse

# Contraste local doux.
clahe = cv2.createCLAHE(clipLimit=1.15, tileGridSize=(4, 4))
gris = clahe.apply((gris * 65535).astype(np.uint16)).astype(np.float32) / 65535

# Niveaux puis courbe en S.
bas, haut = np.percentile(gris, 0.8), np.percentile(gris, 99.8)
gris = np.clip((gris - bas) / (haut - bas), 0, 1)
gris = gris - 0.12 * np.sin(2 * np.pi * gris) / (2 * np.pi)
gris = np.clip(gris, 0, 1) ** 1.05

# Netteté fine (yeux, cils, mailles du pull).
flou = cv2.GaussianBlur(gris, (0, 0), 0.9)
gris = np.clip(gris + 0.35 * (gris - flou), 0, 1)

# Vignetage centré sur le visage.
h, w = gris.shape
cy, cx = 0.40 * h, 0.50 * w
yy, xx = np.mgrid[0:h, 0:w]
d = np.sqrt(((xx - cx) / w) ** 2 + ((yy - cy) / h) ** 2)
gris = gris * (1 - 0.22 * np.clip((d - 0.28) / 0.45, 0, 1) ** 1.6)

# Grain fin, plus visible dans les gris moyens que dans les blancs.
rng = np.random.default_rng(7)
grain = cv2.GaussianBlur(rng.normal(0, 1, gris.shape).astype(np.float32), (0, 0), 0.7)
gris = np.clip(gris + 0.022 * grain * (1 - np.abs(gris - 0.5) * 1.4), 0, 1)

g8 = (gris * 255 + 0.5).astype(np.uint8)
OUT.mkdir(exist_ok=True)
cv2.imwrite(str(OUT / 'manou.jpg'), cv2.resize(g8, (960, round(960 * h / w)), interpolation=cv2.INTER_AREA),
            [cv2.IMWRITE_JPEG_QUALITY, 86, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
cv2.imwrite(str(OUT / 'manou-640.jpg'), cv2.resize(g8, (640, round(640 * h / w)), interpolation=cv2.INTER_AREA),
            [cv2.IMWRITE_JPEG_QUALITY, 84, cv2.IMWRITE_JPEG_PROGRESSIVE, 1])
# Version brute pour comparer, hors dépôt.
cv2.imwrite(str(SRC.parent / 'comparaison-brut-nb.jpg'), (np.clip(0.3*r+0.59*g+0.11*b,0,1)*255).astype(np.uint8))
print('ok', w, h)
