-- ============================================================================
-- Normalisation des chemins encodés en pourcentage
-- ============================================================================
-- Certaines URLs de manuscrits contiennent des séquences encodées (%27 pour une
-- apostrophe). Le storage les décode correctement, donc le fichier s'affiche
-- bien : ce n'est PAS un lien cassé.
--
-- En revanche `recipe_documents.object_path` contenait la forme encodée, qui ne
-- correspond à aucun nom réel dans storage.objects. Conséquence : la taille et
-- l'empreinte restaient vides, et tout contrôle d'intégrité futur signalerait à
-- tort un document manquant.
--
-- Convention posée ici, à respecter par la suite :
--   object_path = le nom RÉEL de l'objet dans le storage (décodé)
--   public_url  = l'URL telle qu'un navigateur doit l'appeler (encodée)
-- ============================================================================

update public.recipe_documents d
   set object_path  = o.name,
       byte_size    = (o.metadata ->> 'size')::bigint,
       content_etag = o.metadata ->> 'eTag'
  from storage.objects o
 where o.bucket_id = d.bucket_id
   -- on compare le chemin décodé au nom réel du fichier
   and o.name = replace(replace(replace(d.object_path, '%27', ''''), '%20', ' '), '%28', '(')
   and d.byte_size is null;

comment on column public.recipe_documents.object_path is
  'Nom réel de l''objet dans le storage, jamais encodé. Voir public_url pour la forme appelable par un navigateur.';

do $$
declare v_restants integer;
begin
  select count(*) into v_restants from public.recipe_documents where byte_size is null;
  if v_restants > 0 then
    raise warning 'Il reste % document(s) sans taille : fichier réellement absent du storage', v_restants;
  else
    raise notice 'Tous les documents sont rattachés à un fichier existant';
  end if;
end $$;
