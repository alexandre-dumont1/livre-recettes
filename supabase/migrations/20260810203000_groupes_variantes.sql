-- ═══════════════════════════════════════════════════════════════════════════
-- DEUX SENS OPPOSÉS POUR LE MÊME group_label
-- ═══════════════════════════════════════════════════════════════════════════
-- 55 recettes se servent de group_label, et pour 54 d'entre elles les groupes
-- sont les PARTIES d'un même plat : Marinade, Aromates, Cuisson, Viande, Sauce.
-- Il faut les avoir toutes sous les yeux pour cuisiner. Les cacher derrière des
-- onglets serait activement nuisible.
--
-- « Idées Salades Composées » est le seul cas inverse : ses 8 groupes sont des
-- ALTERNATIVES. On en cuisine une, jamais huit. Là, des sous-onglets sont la
-- bonne lecture — une variante à la fois, comme sur le feuillet où chaque salade
-- occupe son propre bloc.
--
-- Le même mécanisme porte donc deux sens opposés, et aucune règle automatique ne
-- les sépare de façon fiable : aujourd'hui 129 est la seule sans étapes, mais une
-- future page de variantes pourrait très bien en avoir une commune. D'où une
-- colonne explicite, renseignée à l'import, plutôt qu'une devinette.

alter table public.recipes
  add column if not exists groups_are_variants boolean not null default false;

comment on column public.recipes.groups_are_variants is
  'true : les group_label sont des variantes alternatives, le livre les présente en sous-onglets (on en choisit une). false : les group_label sont les parties d''un même plat, affichées ensemble.';

update public.recipes
   set groups_are_variants = true
 where id = 129;

-- Contrôle : la colonne n'a de sens que s'il y a au moins deux groupes. On ne
-- l'impose pas par contrainte — une recette peut être corrigée dans n'importe
-- quel ordre — mais l'affichage retombe seul sur la présentation normale.
do $$
declare n int;
begin
  select count(*) into n from public.recipes where groups_are_variants;
  raise notice '% recette(s) marquée(s) « groupes = variantes ».', n;
end $$;
