# Code venu d'ailleurs

Le site n'a pas d'étape de construction : pas de `npm install`, pas de bundler. Une
bibliothèque tierce est donc **figée ici telle quelle**, et servie comme un fichier du
site. Pour la mettre à jour, on remplace le fichier et on recopie l'empreinte.

## page-flip 2.0.7 — le tournage de page

| | |
|---|---|
| Source | https://github.com/Nodlik/StPageFlip |
| Paquet | https://unpkg.com/page-flip@2.0.7/dist/js/page-flip.browser.js |
| Licence | MIT |
| Dépendances | aucune |
| Poids | 43 ko, ~10 ko compressé |
| Empreinte SHA-256 | `bbaca0bbef57a22bb66a3fc69d67baf9a17fb9a9c89ec9ed35e2b91abe4bd1e7` |

Elle expose un objet global `St`, d'où `new St.PageFlip(...)` dans `app.js`.

**Pourquoi elle est là.** La version maison était une demi-page rigide qui pivotait sur
une charnière et s'effaçait. Une page de livre se **plie** : elle se cambre, projette une
ombre sur celle du dessous, et se pose de l'autre côté. Deux tentatives de correction
maison n'y sont pas arrivées, parce qu'aucun angle de rotation ne produit une flexion.

**Ce qu'elle impose en échange.** Les pages ont une taille **fixe** — c'est la condition
d'un tournage crédible. Une recette plus longue que la page défile donc à l'intérieur de
la page, au lieu de faire grandir le livre comme avant.

**Où elle n'agit pas.** En dessous de 900 px de large, le livre reste ce qu'il était :
les deux pages empilées et la lecture au défilement. Un flipbook à hauteur fixe sur un
téléphone rognerait les recettes. La bibliothèque n'est donc instanciée qu'au-delà de
cette largeur — voir `LARGEUR_LIVRE_OUVERT` dans `app.js`.

**Vérifier la mise à jour.** Ce fichier n'est pas couvert par des tests. Après
remplacement : ouvrir le livre, tourner en avant puis en arrière, sauter depuis le
sommaire, appliquer un filtre, revenir au menu par le titre. Les captures d'écran de
contrôle se font avec Chrome piloté ; recette dans la mémoire projet
(`gotcha_rotatey_signe_sens_page.md`).
