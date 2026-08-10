-- ═══════════════════════════════════════════════════════════════════════════
-- « SALADES COMPOSÉES » : HUIT SALADES SORTIES DU CHAMP NOTES
-- ═══════════════════════════════════════════════════════════════════════════
-- Le feuillet (salades_composees_copie.pdf) porte huit salades, chacune avec un
-- nom souligné et une liste d'ingrédients, sans quantités ni cuisson. La
-- transcription d'origine avait tout empilé dans recipes.notes : la recette 129
-- n'avait donc AUCUN ingrédient, et n'apparaissait sous aucune entrée de l'index
-- par ingrédient. Le magret, la morteau, le comté, la mozzarella qui y figurent
-- étaient introuvables autrement qu'en lisant la page.
--
-- Choix retenu : UNE page, huit groupes d'ingrédients. group_label existe déjà et
-- 55 recettes s'en servent (Marinade, Farce, Pâte…), le livre sait l'afficher.
-- Huit pages séparées auraient ajouté huit squelettes sans préparation, puisque
-- le feuillet n'en donne aucune.
--
-- Deux écarts relevés en comparant au manuscrit :
--   · le feuillet écrit « +/- lardons » pour les haricots verts. La recopie avait
--     perdu le « +/- » : un ingrédient facultatif était devenu obligatoire.
--     Il repasse en is_optional.
--   · le feuillet dit « Salade Bonis », la recopie disait « Bons ». L'écriture est
--     difficile ; on garde Bonis et on le signale dans les notes.

do $$
declare
  cible int := 129;
  ligne int := 0;
  groupe text;
  nom text;
  prep text;
  facultatif boolean;
  ing_id int;
  -- nom d'ingrédient | préparation | facultatif
  salades text[][] := array[
    -- Colonne gauche et droite du feuillet, lues par rangées comme l'œil les suit
    array['Salade verte',            'concombre',                '',                    'f'],
    array['Salade verte',            'magret de canard',         '',                    'f'],
    array['Salade verte',            'melon',                    '',                    'f'],
    array['Salade verte',            'feta',                     'ou parmesan',         'f'],
    array['Salade verte',            'pignons',                  '',                    'f'],

    array['Salade de pâtes',         'pâtes',                    '',                    'f'],
    array['Salade de pâtes',         'avocat',                   '',                    'f'],
    array['Salade de pâtes',         'saumon fumé',              '',                    'f'],
    array['Salade de pâtes',         'tomate',                   '',                    'f'],
    array['Salade de pâtes',         'basilic',                  '',                    'f'],

    array['Pommes de terre',         'pomme de terre',           '',                    'f'],
    array['Pommes de terre',         'lardons',                  'ou thon',             'f'],
    array['Pommes de terre',         'cornichon',                '',                    'f'],
    array['Pommes de terre',         'œuf',                      'dur',                 'f'],
    array['Pommes de terre',         'tomate',                   '',                    'f'],

    array['Riz',                     'riz',                      '',                    'f'],
    array['Riz',                     'poulet',                   'en lamelles',         'f'],
    array['Riz',                     'cornichon',                '',                    'f'],
    array['Riz',                     'tomate',                   '',                    'f'],
    array['Riz',                     'avocat',                   '',                    'f'],

    array['Salade Bonis',            'pâtes',                    '',                    'f'],
    array['Salade Bonis',            'jambon serrano',           '',                    'f'],
    array['Salade Bonis',            'aubergine',                'grillée',             'f'],
    array['Salade Bonis',            'tomate cerise',            '',                    'f'],
    array['Salade Bonis',            'pignons',                  '',                    'f'],
    array['Salade Bonis',            'pesto',                    '',                    'f'],
    array['Salade Bonis',            'parmesan',                 '',                    'f'],
    array['Salade Bonis',            'vinaigre balsamique',      'au dernier moment',   'f'],

    array['Salade italienne',        'mozzarella',               '',                    'f'],
    array['Salade italienne',        'tomates confites',         '',                    'f'],
    array['Salade italienne',        'cœur d''artichaut',        '',                    'f'],
    array['Salade italienne',        'salade colorée',           '',                    'f'],
    array['Salade italienne',        'courgette',                'en dés, revenue',     'f'],
    array['Salade italienne',        'poivron',                  'en dés, revenu',      'f'],
    array['Salade italienne',        'jambon italien',           '',                    'f'],
    array['Salade italienne',        'vinaigre balsamique',      '',                    'f'],

    array['Haricots verts',          'haricot vert',             '',                    'f'],
    array['Haricots verts',          'tomate',                   '',                    'f'],
    array['Haricots verts',          'œuf',                      'dur',                 'f'],
    array['Haricots verts',          'pomme de terre',           'sautée',              'f'],
    array['Haricots verts',          'lardons',                  '',                    't'],
    array['Haricots verts',          'champignon',               '',                    'f'],

    array['Salade verte à la morteau', 'morteau',                'en rondelles',        'f'],
    array['Salade verte à la morteau', 'pomme de terre',         '',                    'f'],
    array['Salade verte à la morteau', 'tomate cerise',          '',                    'f'],
    array['Salade verte à la morteau', 'comté',                  '',                    'f'],
    array['Salade verte à la morteau', 'cornichon',              '',                    'f']
  ];
  i int;
begin
  if not exists (select 1 from recipes where id = cible) then
    raise exception 'La recette % est introuvable, migration annulée.', cible;
  end if;

  -- Idempotence : on repart de zéro sur cette recette seulement.
  delete from recipe_ingredients where recipe_id = cible;

  for i in 1 .. array_length(salades, 1) loop
    groupe     := salades[i][1];
    nom        := salades[i][2];
    prep       := nullif(salades[i][3], '');
    facultatif := salades[i][4] = 't';

    -- Résolution insensible à la casse, sinon on crée « Tomate » à côté de
    -- « tomate » et l'index par ingrédient se coupe en deux.
    select id into ing_id from ingredients
     where lower(trim(name)) = lower(trim(nom)) limit 1;
    if ing_id is null then
      insert into ingredients (name) values (nom) returning id into ing_id;
    end if;

    ligne := ligne + 1;
    insert into recipe_ingredients
      (recipe_id, ingredient_id, quantity, unit, preparation, group_label, display_order, is_optional)
    values (cible, ing_id, null, null, prep, groupe, ligne, facultatif);
  end loop;

  -- Le pavé de notes n'a plus de raison d'être : son contenu est devenu de la
  -- donnée. On garde uniquement ce que la donnée ne peut pas porter, c'est-à-dire
  -- l'aveu d'incertitude sur une lecture.
  update recipes
     set description = 'Huit combinaisons de salades, telles qu''elles sont notées sur le feuillet : ni quantités, ni cuisson.',
         notes = 'Le nom « Salade Bonis » est une lecture incertaine du manuscrit. Un mot reste illisible après « salade colorée » dans la salade italienne.',
         servings_unit = coalesce(servings_unit, 'personnes')
   where id = cible;

  raise notice 'Recette % : % lignes d''ingrédients réparties en % groupes.',
    cible, ligne, (select count(distinct group_label) from recipe_ingredients where recipe_id = cible);
end $$;
