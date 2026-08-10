-- Retour arrière assumé. J'avais ajouté groups_are_variants pour présenter la
-- page « Salades composées » en sous-onglets, une salade à la fois. Ce n'était pas
-- la demande : les sous-onglets sont voulus pour les FEUILLETS qui portent
-- plusieurs recettes distinctes (les deux madeleines, la crème anglaise et les
-- œufs au lait), pas pour les groupes d'ingrédients d'une même page.
--
-- La page des salades reprend donc la présentation choisie : une page, huit
-- groupes d'ingrédients affichés ensemble — ce que fait déjà le livre pour les 54
-- autres recettes à groupes.
--
-- On retire la colonne plutôt que de la laisser à false partout : une colonne que
-- rien ne lit est un piège pour la prochaine lecture du schéma.
alter table public.recipes
  drop column if exists groups_are_variants;

-- Ce que le passage précédent laisse derrière lui, et qui reste juste :
--   · les 47 lignes d'ingrédients de la recette 129, réparties en 8 groupes
--   · le « +/- lardons » du feuillet, marqué is_optional et désormais affiché
--   · la reprise du vocabulaire existant plutôt que des doublons d'index
