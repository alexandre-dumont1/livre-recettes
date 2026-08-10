-- ============================================================================
-- Accès famille : liste blanche + file de relecture des soumissions
-- ============================================================================
-- Contexte : le livre passe en ligne, ouvert sur Internet.
--
-- Principe retenu : la LECTURE reste totalement publique. Personne ne doit
-- avoir à se connecter pour lire une recette reçue par message. Seule
-- l'ÉCRITURE est réservée à la famille.
--
-- Point clé : être connecté avec Google ne suffit pas. N'importe qui sur Terre
-- possède un compte Google. L'autorisation vient de l'appartenance à la table
-- family_members, pas de la simple présence d'une session.
-- ============================================================================


-- ── 1. La liste blanche ─────────────────────────────────────────────────────

create table if not exists public.family_members (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  display_name  text,
  role          text not null default 'member',
  invited_at    timestamptz not null default now(),
  first_seen_at timestamptz,

  constraint family_members_email_unique unique (email),
  -- on stocke toujours en minuscules pour que la comparaison soit fiable
  constraint family_members_email_lowercase check (email = lower(email)),
  constraint family_members_role_valid check (role in ('member', 'editor', 'admin'))
);

comment on table public.family_members is
  'Liste blanche des personnes autorisées à contribuer au livre. Être connecté ne suffit pas, il faut figurer ici.';
comment on column public.family_members.role is
  'member = ajoute photos et propose des recettes. editor = relit les soumissions. admin = gère la liste.';
comment on column public.family_members.first_seen_at is
  'Première connexion effective. Reste NULL tant que la personne n''est jamais venue, ce qui permet de voir qui n''a pas encore ouvert le lien.';

-- RLS activé SANS aucune policy : la table est donc totalement invisible
-- depuis le navigateur. Seul le service_role y accède (donc toi, en local).
alter table public.family_members enable row level security;


-- ── 2. Le test d'appartenance ───────────────────────────────────────────────

-- security definer : la fonction doit pouvoir lire family_members malgré le
-- RLS qui la ferme à tout le monde.
create or replace function public.is_family_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.family_members fm
    where fm.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

comment on function public.is_family_member() is
  'Vrai si l''adresse mail du jeton en cours figure dans la liste blanche. Base de toutes les règles d''écriture.';

revoke all on function public.is_family_member() from public;
grant execute on function public.is_family_member() to authenticated;


-- ── 3. Les soumissions deviennent une vraie file de travail ─────────────────
-- Avant : une boîte aux lettres que personne ne relève.
-- Après : un état, un auteur, un relecteur, et le lien vers la recette créée.

alter table public.recipe_submissions
  add column if not exists submitted_by      uuid references auth.users(id) on delete set null,
  add column if not exists submitter_email   text,
  add column if not exists status            text not null default 'pending',
  add column if not exists document_url      text,
  add column if not exists reviewed_by       uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at       timestamptz,
  add column if not exists review_notes      text,
  add column if not exists created_recipe_id integer references public.recipes(id) on delete set null;

comment on column public.recipe_submissions.document_url is
  'Photo ou PDF déposé par la personne. C''est la vraie porte d''entrée : la famille a ses recettes sur papier, pas en texte.';
comment on column public.recipe_submissions.created_recipe_id is
  'Recette publiée à partir de cette soumission. Garde la trace de l''origine.';

alter table public.recipe_submissions
  drop constraint if exists recipe_submissions_status_valid;

alter table public.recipe_submissions
  add constraint recipe_submissions_status_valid
  check (status in ('pending', 'in_review', 'published', 'rejected'));

create index if not exists recipe_submissions_status_idx
  on public.recipe_submissions (status, submitted_at desc);


-- ── 4. Qui a le droit d'écrire ──────────────────────────────────────────────

-- L'ancienne règle laissait n'importe quel visiteur anonyme insérer une
-- soumission. Acceptable sur un site jamais publié, c'est un canal de spam
-- ouvert dès la mise en ligne.
drop policy if exists anon_insert on public.recipe_submissions;

create policy "famille depose une soumission"
  on public.recipe_submissions
  for insert
  to authenticated
  with check (
    public.is_family_member()
    and submitted_by = auth.uid()
  );

-- Chacun revoit ce qu'il a envoyé. La relecture globale se fait en local avec
-- le service_role, tant qu'il n'y a pas d'écran d'administration.
create policy "chacun relit ses propres soumissions"
  on public.recipe_submissions
  for select
  to authenticated
  using (
    public.is_family_member()
    and submitted_by = auth.uid()
  );


-- ── 5. Vérification ─────────────────────────────────────────────────────────
-- À exécuter après application pour confirmer que la lecture publique du livre
-- n'a pas bougé :
--
--   select tablename, policyname, cmd, roles::text
--   from pg_policies where schemaname = 'public' order by tablename, cmd;
--
-- Attendu : les 6 policies « public read » en SELECT intactes, plus les deux
-- nouvelles sur recipe_submissions, et plus aucune policy pour anon en INSERT.
