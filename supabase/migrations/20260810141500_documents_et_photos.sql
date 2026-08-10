-- ============================================================================
-- Modèle de documents : manuscrits et photos de plats
-- ============================================================================
-- Trois limites du modèle actuel, toutes constatées dans les données :
--
--   1. `recipes.pdf_url` impose UN seul manuscrit par recette. Or une recette
--      peut avoir un recto verso, ou deux pages de cahier.
--
--   2. `photo1_url` / `photo2_url` que lit app.js N'EXISTENT PAS en base (la
--      colonne réelle est `image_url`), donc la fonctionnalité photo n'a jamais
--      pu marcher, et elle plafonnerait à deux photos de toute façon.
--
--   3. Surtout : quatre pages manuscrites portent DEUX recettes chacune
--      (Banoffee, madeleines, gratins, œufs au lait). Un lien posé sur la
--      recette ne sait pas représenter ça.
--
-- D'où une relation plusieurs à plusieurs entre recettes et documents.
--
-- `recipes.pdf_url` est CONSERVÉE pour que le site actuel continue de
-- fonctionner. Elle sera retirée quand app.js lira les nouvelles tables.
-- ============================================================================


-- ── 1. Les documents ────────────────────────────────────────────────────────

create table public.recipe_documents (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null,
  bucket_id    text not null,
  object_path  text not null,
  public_url   text not null,
  byte_size    bigint,
  content_etag text,
  caption      text,
  uploaded_by  uuid references auth.users(id) on delete set null,
  taken_at     timestamptz,
  created_at   timestamptz not null default now(),

  constraint recipe_documents_kind_valid check (kind in ('manuscript', 'dish_photo')),
  constraint recipe_documents_object_unique unique (bucket_id, object_path)
);

comment on table public.recipe_documents is
  'Un fichier du storage, manuscrit ou photo de plat. Un même document peut servir plusieurs recettes.';
comment on column public.recipe_documents.kind is
  'manuscript = l''écriture d''origine, le coeur du livre. dish_photo = le plat réalisé par un membre.';
comment on column public.recipe_documents.content_etag is
  'Empreinte du fichier fournie par le storage. Permet de refuser un envoi en double.';
comment on column public.recipe_documents.uploaded_by is
  'Qui a envoyé la photo. Permet d''afficher « photo ajoutée par Marie ».';

create index recipe_documents_kind_idx on public.recipe_documents (kind);
create index recipe_documents_etag_idx on public.recipe_documents (content_etag)
  where content_etag is not null;


-- ── 2. Le lien recettes ↔ documents ─────────────────────────────────────────

create table public.recipe_document_links (
  recipe_id     integer not null references public.recipes(id) on delete cascade,
  document_id   uuid    not null references public.recipe_documents(id) on delete cascade,
  display_order integer not null default 0,
  page_label    text,

  primary key (recipe_id, document_id)
);

comment on table public.recipe_document_links is
  'Relation plusieurs à plusieurs. Une page manuscrite portant deux recettes est liée aux deux.';
comment on column public.recipe_document_links.page_label is
  'Repère lisible quand un document couvre plusieurs pages ou plusieurs recettes : recto, verso, « haut de page ».';

create index recipe_document_links_document_idx on public.recipe_document_links (document_id);


-- ── 3. Reprise des 121 manuscrits existants ─────────────────────────────────

insert into public.recipe_documents (kind, bucket_id, object_path, public_url, byte_size, content_etag)
select
  'manuscript',
  'recipes-pdfs',
  s.object_path,
  s.public_url,
  max(s.byte_size),
  max(s.content_etag)
from (
  select
    regexp_replace(r.pdf_url, '^.*/recipes-pdfs/', '') as object_path,
    r.pdf_url                                          as public_url,
    (o.metadata ->> 'size')::bigint                    as byte_size,
    o.metadata ->> 'eTag'                              as content_etag
  from public.recipes r
  left join storage.objects o
    on o.bucket_id = 'recipes-pdfs'
   and o.name = regexp_replace(r.pdf_url, '^.*/recipes-pdfs/', '')
  where r.pdf_url is not null
) s
group by s.object_path, s.public_url
on conflict (bucket_id, object_path) do nothing;

insert into public.recipe_document_links (recipe_id, document_id, display_order)
select r.id, d.id, 0
from public.recipes r
join public.recipe_documents d
  on d.bucket_id = 'recipes-pdfs'
 and d.object_path = regexp_replace(r.pdf_url, '^.*/recipes-pdfs/', '')
where r.pdf_url is not null
on conflict do nothing;

comment on column public.recipes.pdf_url is
  'OBSOLÈTE. Conservée le temps que app.js bascule sur recipe_documents. Ne plus écrire dedans.';


-- ── 4. Qui lit, qui écrit ───────────────────────────────────────────────────

alter table public.recipe_documents      enable row level security;
alter table public.recipe_document_links enable row level security;

-- Lecture publique, comme le reste du livre. Les fichiers sont de toute façon
-- servis par des URLs publiques : les cacher en base n'apporterait rien.
create policy "public read" on public.recipe_documents
  for select using (true);

create policy "public read" on public.recipe_document_links
  for select using (true);

-- Un membre approuvé peut ajouter une photo de plat, et seulement à son nom.
create policy "membre approuve ajoute une photo"
  on public.recipe_documents
  for insert
  to authenticated
  with check (
    public.is_approved_member()
    and kind = 'dish_photo'
    and uploaded_by = auth.uid()
  );

create policy "membre approuve rattache sa photo"
  on public.recipe_document_links
  for insert
  to authenticated
  with check (public.is_approved_member());

-- Chacun peut retirer une photo qu'il a lui même envoyée. Les manuscrits ne
-- sont jamais supprimables depuis le site : c'est le patrimoine.
create policy "chacun retire sa propre photo"
  on public.recipe_documents
  for delete
  to authenticated
  using (
    public.is_approved_member()
    and kind = 'dish_photo'
    and uploaded_by = auth.uid()
  );

-- Un admin corrige les légendes et l'ordre d'affichage.
create policy "les admins amendent les documents"
  on public.recipe_documents
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "les admins amendent les liens"
  on public.recipe_document_links
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ── 5. Le storage : autoriser l'envoi des photos ────────────────────────────
-- C'était le troisième verrou qui empêchait la fonctionnalité photo : aucune
-- règle d'écriture n'existait sur storage.objects.

drop policy if exists "membre approuve envoie une photo" on storage.objects;
create policy "membre approuve envoie une photo"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'recipe-photos'
    and public.is_approved_member()
  );

drop policy if exists "chacun retire son propre fichier" on storage.objects;
create policy "chacun retire son propre fichier"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'recipe-photos'
    and owner_id = auth.uid()::text
  );

-- Le bucket des manuscrits reste en lecture seule pour tout le monde : aucune
-- règle d'écriture n'est créée dessus, volontairement.
