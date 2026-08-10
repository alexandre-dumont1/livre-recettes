-- On remet la colonne, cette fois pour la bonne présentation.
--
-- Historique honnête de ce va-et-vient : je l'avais ajoutée pour des sous-onglets
-- en barre, ce n'était pas la demande ; je l'ai retirée ; la demande précisée est
-- une TUILE par variante sur toute la page, chacune avec le titre au marqueur en
-- plus petit, et un clic qui agrandit la tuile choisie en rétrécissant les autres.
-- Le besoin d'un marqueur explicite reste le même.
--
-- Pourquoi ce marqueur et pas une devinette : 55 recettes utilisent group_label,
-- et pour 54 d'entre elles les groupes sont les PARTIES d'un même plat (Marinade,
-- Aromates, Cuisson, Sauce). Il faut les avoir toutes sous les yeux pour cuisiner :
-- les mettre en tuiles refermées rendrait la daube inutilisable. Seule « Idées
-- Salades Composées » a des groupes ALTERNATIFS — on cuisine une salade, pas huit.

alter table public.recipes
  add column if not exists groups_are_variants boolean not null default false;

comment on column public.recipes.groups_are_variants is
  'true : les group_label sont des variantes alternatives, la page les présente en tuiles dépliables (on en ouvre une). false : les group_label sont les parties d''un même plat, affichées ensemble.';

update public.recipes
   set groups_are_variants = true
 where id = 129;

do $$
declare n int; g int;
begin
  select count(*) into n from public.recipes where groups_are_variants;
  select count(distinct group_label) into g from public.recipe_ingredients where recipe_id = 129;
  raise notice '% recette(s) en tuiles, dont la 129 avec % variantes.', n, g;
end $$;
