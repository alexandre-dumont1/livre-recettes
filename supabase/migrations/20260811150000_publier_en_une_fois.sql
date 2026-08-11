-- ═══════════════════════════════════════════════════════════════════════════
-- PUBLIER UNE RECETTE : TOUT OU RIEN
-- ═══════════════════════════════════════════════════════════════════════════
-- La publication faisait cinq écritures enchaînées depuis le navigateur :
-- recipe_documents, recipes, ingredients, recipe_ingredients, recipe_steps,
-- recipe_document_links. Chacune pouvait réussir alors que la suivante échouait,
-- et rien ne revenait en arrière. Deux conséquences vues pour de vrai :
--
--   · une page créée sans ses ingrédients reste dans le livre, muette et
--     introuvable par l'index ;
--   · réessayer republie ce qui avait déjà réussi. Sur un feuillet à trois
--     recettes dont la deuxième échoue, un second clic duplique la première.
--
-- Le corps d'une fonction plpgsql est UNE transaction : tout est écrit, ou rien
-- ne l'est. On y déplace donc l'ensemble.
--
-- security INVOKER (le défaut, laissé explicite) : la fonction s'exécute avec les
-- droits de l'appelant, donc les règles RLS s'appliquent à chaque insertion
-- exactement comme avant. On gagne l'atomicité sans rien lâcher sur les
-- autorisations — c'est le point à ne pas rater : en security definer, n'importe
-- quel membre aurait pu publier au nom d'un autre.

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

  -- ── Les feuillets ──
  -- Le fichier lui-même est déjà dans le Storage : on ne peut pas le mettre dans
  -- une transaction SQL. Ce qui est atomique ici, c'est tout le reste ; le
  -- navigateur retire l'objet du bucket si cet appel échoue.
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

  -- ── Chaque recette ──
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

    -- ── Les ingrédients ──
    -- Le vocabulaire est commun à tout le livre : on réutilise le mot existant
    -- sans tenir compte de la casse, sinon « Beurre » viendrait doubler
    -- « beurre » et couperait l'index par ingrédient en deux.
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

    -- ── Les étapes ──
    rang := 0;
    for etape in select value from jsonb_array_elements(coalesce(recette->'steps', '[]'::jsonb)) loop
      continue when coalesce(btrim(etape->>'description'), '') = '';
      rang := rang + 1;
      insert into public.recipe_steps
        (recipe_id, step_number, title, description, duration_minutes)
      values (
        id_recette, rang,
        nullif(btrim(coalesce(etape->>'title', '')), ''),
        btrim(etape->>'description'),
        nullif(etape->>'duration_minutes', '')::int
      );
    end loop;

    -- ── Le rattachement aux feuillets ──
    -- Toutes les recettes du lot partagent les mêmes feuillets : c'est le cas
    -- d'une page qui porte deux recettes, et quatre feuillets sont déjà dans ce
    -- cas dans le livre.
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

-- Retirer un objet du Storage quand la publication a échoué demande le droit de
-- supprimer ses propres dépôts. Sans lui, un échec laisserait le fichier orphelin
-- dans le bucket — c'est l'origine des 18 Mo déjà présents.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'objects') then
    execute $p$
      drop policy if exists "retire son propre depot" on storage.objects;
      create policy "retire son propre depot"
        on storage.objects for delete to authenticated
        using (bucket_id = 'recipe-photos' and owner = auth.uid());
    $p$;
  end if;
end $$;
