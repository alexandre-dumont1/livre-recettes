"""Mesure chaque titre manuscrit (titres/<id>.png) pour les aligner à l'écran.

Pour chaque titre : la hauteur du corps des lettres (hauteur d'x, sans hampes
ni jambages) et la position de la ligne d'écriture, sur sa DERNIÈRE ligne.
L'affichage met tous les titres à la même hauteur d'x et les pose sur la
même ligne d'écriture. Le soulignement est retiré de la mesure : c'est un trait
horizontal, il fausserait la ligne de base.

Usage : ~/one-dm-manou/.venv/bin/python scripts/mesurer-titres.py
Écrit titres-manifeste.js : id → [largeur, hauteur, hauteur_x, ligne_de_base].
"""
import cv2, numpy as np, json, os

dossier = 'titres'
oeil = json.load(open('scripts/titres-mesures.json'))   # écrit par decouper-titres.py
res = {}
for f in sorted(os.listdir(dossier), key=lambda x: int(x.split('.')[0])):
    i = int(f.split('.')[0])
    a = cv2.imread(f'{dossier}/{f}', cv2.IMREAD_UNCHANGED)[..., 3]
    h, w = a.shape
    m = (a > 70).astype(np.uint8)
    # Le soulignement : on soude ses segments puis on garde les longs traits
    # horizontaux, qu'on retire avant de mesurer (il fausserait tout).
    soude = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(w * .03)), 3)))
    trait = cv2.morphologyEx(soude, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(w * .12)), 1)))
    m[cv2.dilate(trait, np.ones((5, 3), np.uint8)) > 0] = 0
    prof = cv2.blur(m.sum(1).astype(float).reshape(-1, 1), (1, 7)).ravel()
    # Les lignes du titre : on coupe aux creux d'encre (une rangée qui porte
    # moins d'un quart de la plus chargée), entre 15 % et 85 % de l'encre.
    cum = np.cumsum(prof); tot = cum[-1] or 1
    coupes = [0]
    y = int(np.searchsorted(cum, tot * .15)); y_hi = int(np.searchsorted(cum, tot * .85))
    while y < y_hi:
        if prof[y] < prof.max() * .25:
            y0 = y
            while y < y_hi and prof[y] < prof.max() * .25: y += 1
            coupes.append((y0 + y) // 2)
        y += 1
    coupes.append(h)
    lignes = [(a0, a1) for a0, a1 in zip(coupes, coupes[1:]) if prof[a0:a1].sum() > tot * .15]
    def mesure(a0, a1):
        c = np.cumsum(prof[a0:a1]); t = c[-1] or 1
        q = lambda f: int(np.searchsorted(c, t * f))
        return q(.80) - q(.20), a0 + q(.88)
    # La taille des lettres : sur la ligne la plus fournie, l'écart entre 20 %
    # et 80 % de son encre (sur plusieurs mots, hampes et jambages s'équilibrent).
    pleine = max(lignes, key=lambda l: prof[l[0]:l[1]].sum())
    hx = mesure(*pleine)[0]
    # La ligne d'écriture : celle de la DERNIÈRE ligne, c'est elle qui se pose.
    base = mesure(*lignes[-1])[1]
    # La mesure à l'œil l'emporte : aucune formule n'a tenu sur toute son
    # écriture (capitales, feutre, soulignements épais, annotations).
    if str(i) in oeil: hx, base = oeil[str(i)]
    # Empreinte du fichier : ajoutée à l'adresse de l'image (?v=…), pour qu'un
    # navigateur qui a gardé l'ancienne découpe en cache prenne la nouvelle.
    import hashlib
    v = hashlib.md5(open(f'{dossier}/{f}', 'rb').read()).hexdigest()[:8]
    res[i] = [w, h, max(hx, 4), base, v]

open('titres-manifeste.js', 'w').write(
    "// Généré par scripts/mesurer-titres.py depuis titres/*.png.\n"
    "// id de recette → [largeur, hauteur, hauteur d'x, ligne de base, empreinte] du titre\n"
    "// manuscrit, en pixels de l'image. Sert à les mettre tous à la même taille\n"
    "// de lettres et sur la même ligne d'écriture.\n"
    f"window.TITRES_MANUSCRITS = {json.dumps(res)};\n")
hx = sorted(v[2] for v in res.values())
print(len(res), 'titres ; hauteur d\'x min/médiane/max :', hx[0], hx[len(hx)//2], hx[-1])
