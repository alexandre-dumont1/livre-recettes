-- ============================================================================
-- Réparation de deux manuscrits introuvables
-- ============================================================================
-- Les recettes #46 et #47 pointaient vers « gratin_courgettes_champignons.pdf »,
-- un nom de fichier qui n'existe pas dans le bucket. Vérifié par HTTP : les
-- deux URLs renvoyaient une erreur 400, donc le manuscrit ne s'affichait pas.
--
-- Le bon fichier est présent sous « gratin_courgettes_champignons_Caro.pdf »
-- (332 kB, HTTP 200). Une copie identique existe sous le suffixe « _copie »,
-- même taille au kilo-octet près, on retient le nom le plus explicite.
--
-- Contrôle inverse effectué au passage : la recette #134 (soupe d'oranges) a une
-- apostrophe encodée en %27 dans son URL. Elle répond bien en HTTP 200, le
-- storage décode correctement. Rien à corriger de ce côté.
-- ============================================================================

do $$
declare
  v_ancien text := 'gratin_courgettes_champignons.pdf';
  v_nouveau text := 'gratin_courgettes_champignons_Caro.pdf';
  v_base text;
  v_taille bigint;
  v_etag text;
begin
  -- On reconstruit l'URL publique à partir d'une URL existante, pour ne pas
  -- coder en dur le domaine du projet dans une migration.
  select regexp_replace(pdf_url, '/[^/]+$', '/') into v_base
  from public.recipes where pdf_url is not null limit 1;

  if v_base is null then
    raise exception 'Aucune URL de référence trouvée pour reconstruire le chemin';
  end if;

  select (metadata ->> 'size')::bigint, metadata ->> 'eTag'
    into v_taille, v_etag
  from storage.objects
  where bucket_id = 'recipes-pdfs' and name = v_nouveau;

  if v_taille is null then
    raise exception 'Le fichier de remplacement % est absent du bucket', v_nouveau;
  end if;

  update public.recipe_documents
     set object_path  = v_nouveau,
         public_url   = v_base || v_nouveau,
         byte_size    = v_taille,
         content_etag = v_etag
   where bucket_id = 'recipes-pdfs' and object_path = v_ancien;

  update public.recipes
     set pdf_url = v_base || v_nouveau
   where pdf_url = v_base || v_ancien;

  raise notice 'Manuscrit réparé : % -> %', v_ancien, v_nouveau;
end $$;
