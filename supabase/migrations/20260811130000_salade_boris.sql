-- « Salade Bonis » → « Salade Boris ».
--
-- Le feuillet des salades composées est manuscrit, et ce nom-là avait été lu de
-- travers à la transcription : d'abord « Bons », corrigé en « Bonis » après avoir
-- rouvert le PDF, mais toujours faux. La famille tranche : c'est **Boris**, un
-- prénom — ce qui explique la majuscule et pourquoi aucun mot du dictionnaire ne
-- collait.
--
-- Leçon pour les prochaines transcriptions : sur un manuscrit de famille, un mot
-- qui ne ressemble à rien est souvent un prénom. Le déchiffrer à la loupe ne sert
-- à rien, il faut demander.

update public.recipe_ingredients
   set group_label = 'Salade Boris'
 where recipe_id = 129
   and group_label = 'Salade Bonis';

-- La note de la recette portait le doute sur ce nom. Le doute est levé, on le
-- retire — laisser « lecture incertaine » sur une lecture désormais confirmée
-- ferait douter d'une donnée juste. L'autre incertitude reste : un mot illisible
-- subsiste après « salade colorée » dans la salade italienne.
update public.recipes
   set notes = 'Un mot reste illisible après « salade colorée » dans la salade italienne.'
 where id = 129;

do $$
declare n int; reste int;
begin
  select count(*) into n from public.recipe_ingredients
   where recipe_id = 129 and group_label = 'Salade Boris';
  select count(*) into reste from public.recipe_ingredients
   where group_label ~* 'bonis';
  raise notice '% ligne(s) sous « Salade Boris », % reste(nt) en « Bonis ».', n, reste;
  if reste > 0 then
    raise exception 'Il reste des « Bonis » : correction incomplète.';
  end if;
end $$;
