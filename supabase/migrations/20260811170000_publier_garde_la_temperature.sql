-- publier_feuillet() perdait la température de cuisson des étapes.
--
-- Le schéma imposé au modèle demande temperature_celsius, la table recipe_steps a
-- la colonne, mais l'insertion ne la reprenait pas : une étape « Cuire à 150 °C »
-- arrivait sans sa température, silencieusement. Constaté en préparant l'import des
-- six granolas, qui cuisent tous à 150 °C.
--
-- C'est le défaut classique d'une insertion écrite à la main colonne par colonne :
-- rien ne signale la colonne oubliée.

create or replace function public.publier_feuillet(feuillets jsonb, recettes jsonb)
returns int[]
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  docs        uuid[] := '{}';
  ids         int[]  := '{}';
  doc         jsonb;
  recette     jsonb;
  ligne       jsonb;
  etape       jsonb;
  id_doc      uuid;
  id_recette  int;
  id_ingr     int;
  rang        int;
  nom_propre  text;
begin
  if recettes is null or jsonb_array_length(recettes) = 0 then
    raise exception 'Aucune recette à publier.';
  end if;

  for doc in select value from jsonb_array_elements(coalesce(feuillets, '[]'::jsonb)) loop
    insert into public.recipe_documents
      (kind, bucket_id, object_path, public_url, byte_size, uploaded_by)
    values (
      coalesce(doc->>'kind', 'manuscript'),
      doc->>'bucket_id',
      doc->>'object_path',
      doc->>'public_url',
      nullif(doc->>'byte_size', '')::bigint,
      auth.uid()
    )
    returning id into id_doc;
    docs := docs || id_doc;
  end loop;

  for recette in select value from jsonb_array_elements(recettes) loop
    if coalesce(btrim(recette->>'title'), '') = '' then
      raise exception 'Une recette sans nom ne peut pas être publiée.';
    end if;

    -- total_time_minutes est une colonne générée : la remplir fait échouer
    -- l'insertion entière. Elle n'apparaît donc pas ici.
    insert into public.recipes (
      title, slug, category_id, description, attribution,
      hand, hand_user_id,
      servings, servings_unit,
      prep_time_minutes, cook_time_minutes, rest_time_minutes,
      difficulty, tags, notes, groups_are_variants
    ) values (
      btrim(recette->>'title'),
      public.slug_libre(recette->>'title'),
      nullif(recette->>'category_id', '')::int,
      nullif(btrim(coalesce(recette->>'description', '')), ''),
      nullif(btrim(coalesce(recette->>'attribution', '')), ''),
      nullif(btrim(coalesce(recette->>'hand', '')), ''),
      auth.uid(),
      nullif(recette->>'servings', '')::int,
      nullif(btrim(coalesce(recette->>'servings_unit', '')), ''),
      nullif(recette->>'prep_time_minutes', '')::int,
      nullif(recette->>'cook_time_minutes', '')::int,
      nullif(recette->>'rest_time_minutes', '')::int,
      nullif(btrim(coalesce(recette->>'difficulty', '')), ''),
      case when jsonb_typeof(recette->'tags') = 'array' and jsonb_array_length(recette->'tags') > 0
           then array(select jsonb_array_elements_text(recette->'tags')) end,
      nullif(btrim(coalesce(recette->>'notes', '')), ''),
      coalesce((recette->>'groups_are_variants')::boolean, false)
    )
    returning id into id_recette;
    ids := ids || id_recette;

    rang := 0;
    for ligne in select value from jsonb_array_elements(coalesce(recette->'ingredients', '[]'::jsonb)) loop
      nom_propre := btrim(coalesce(ligne->>'name', ''));
      continue when nom_propre = '';
      rang := rang + 1;

      select i.id into id_ingr from public.ingredients i
       where lower(btrim(i.name)) = lower(nom_propre) limit 1;
      if id_ingr is null then
        insert into public.ingredients (name) values (nom_propre) returning id into id_ingr;
      end if;

      insert into public.recipe_ingredients
        (recipe_id, ingredient_id, quantity, unit, preparation, group_label, display_order)
      values (
        id_recette, id_ingr,
        nullif(ligne->>'quantity', '')::numeric,
        nullif(btrim(coalesce(ligne->>'unit', '')), ''),
        nullif(btrim(coalesce(ligne->>'preparation', '')), ''),
        nullif(btrim(coalesce(ligne->>'group_label', '')), ''),
        rang
      );
      id_ingr := null;
    end loop;

    rang := 0;
    for etape in select value from jsonb_array_elements(coalesce(recette->'steps', '[]'::jsonb)) loop
      continue when coalesce(btrim(etape->>'description'), '') = '';
      rang := rang + 1;
      insert into public.recipe_steps
        (recipe_id, step_number, title, description, duration_minutes, temperature_celsius)
      values (
        id_recette, rang,
        nullif(btrim(coalesce(etape->>'title', '')), ''),
        btrim(etape->>'description'),
        nullif(etape->>'duration_minutes', '')::int,
        nullif(etape->>'temperature_celsius', '')::int   -- était oubliée
      );
    end loop;

    if array_length(docs, 1) is not null then
      insert into public.recipe_document_links (recipe_id, document_id, display_order, page_label)
      select id_recette, docs[n], n - 1,
             case when array_length(docs, 1) > 1 then 'Page ' || n end
        from generate_subscripts(docs, 1) as n;
    end if;
  end loop;

  return ids;
end $$;

comment on function public.publier_feuillet(jsonb, jsonb) is
  'Publie un feuillet et les recettes qu''il porte en une seule transaction : tout est écrit ou rien ne l''est. Renvoie les identifiants créés. S''exécute avec les droits de l''appelant, donc les règles RLS s''appliquent inchangées.';

grant execute on function public.publier_feuillet(jsonb, jsonb) to authenticated;
