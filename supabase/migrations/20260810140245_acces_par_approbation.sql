-- ============================================================================
-- Révision du modèle d'accès : approbation après première connexion
-- ============================================================================
-- La migration précédente supposait une liste blanche remplie à l'avance. En
-- pratique on ne connaît pas les adresses Google exactes de 15 personnes.
--
-- Nouveau fonctionnement, calqué sur Normus :
--   1. la personne se connecte avec Google
--   2. sa fiche est créée automatiquement en statut « pending »
--   3. elle peut lire le livre (comme tout le monde) mais rien écrire
--   4. l'administrateur l'approuve depuis une page dédiée
--
-- La table était vide et aucun compte n'existait au moment de cette migration,
-- donc on la reconstruit proprement plutôt que d'empiler des ALTER.
-- ============================================================================


-- ── 1. Remise à plat de la table ────────────────────────────────────────────

-- Les policies de la migration précédente appellent is_family_member(), il faut
-- donc les retirer AVANT la fonction, sinon Postgres refuse la suppression.
drop policy if exists "famille depose une soumission" on public.recipe_submissions;
drop policy if exists "chacun relit ses propres soumissions" on public.recipe_submissions;

drop function if exists public.is_family_member();
drop table if exists public.family_members cascade;

create table public.family_members (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  avatar_url    text,
  status        text not null default 'pending',
  role          text not null default 'member',
  requested_at  timestamptz not null default now(),
  approved_at   timestamptz,
  approved_by   uuid references auth.users(id) on delete set null,
  last_seen_at  timestamptz,

  constraint family_members_email_unique unique (email),
  constraint family_members_email_lowercase check (email = lower(email)),
  constraint family_members_status_valid check (status in ('pending', 'approved', 'rejected')),
  constraint family_members_role_valid check (role in ('member', 'editor', 'admin'))
);

comment on table public.family_members is
  'Membres de la famille. Une fiche est créée automatiquement à la première connexion Google, en statut pending. Seul un admin peut la passer à approved.';
comment on column public.family_members.status is
  'pending = a demandé l''accès, peut seulement lire. approved = peut contribuer. rejected = refusé explicitement.';

alter table public.family_members enable row level security;

create index family_members_status_idx on public.family_members (status, requested_at desc);


-- ── 2. Les trois tests d'autorisation ───────────────────────────────────────
-- security definer : ces fonctions doivent lire family_members malgré le RLS.
-- C'est aussi ce qui évite une récursion infinie quand une policy POSÉE SUR
-- family_members appelle une fonction qui LIT family_members.

create or replace function public.current_member_status()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select fm.status
  from public.family_members fm
  where fm.user_id = auth.uid()
$$;

create or replace function public.is_approved_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.family_members fm
    where fm.user_id = auth.uid() and fm.status = 'approved'
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.family_members fm
    where fm.user_id = auth.uid()
      and fm.status = 'approved'
      and fm.role in ('admin', 'editor')
  )
$$;

comment on function public.is_admin() is
  'Vrai pour un admin ou un editor approuvé. Sert à autoriser la relecture des soumissions et la validation des membres.';

revoke all on function public.current_member_status() from public;
revoke all on function public.is_approved_member()   from public;
revoke all on function public.is_admin()             from public;
grant execute on function public.current_member_status() to authenticated;
grant execute on function public.is_approved_member()    to authenticated;
grant execute on function public.is_admin()              to authenticated;


-- ── 3. Création automatique de la fiche à la première connexion ─────────────
-- Le tout premier compte devient admin approuvé, sinon personne ne pourrait
-- approuver personne (problème de l'amorçage). Conséquence pratique : la
-- première connexion au site doit être la TIENNE, avant de partager le lien.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bootstrap boolean;
begin
  select not exists (
    select 1 from public.family_members where role = 'admin' and status = 'approved'
  ) into v_bootstrap;

  insert into public.family_members (
    user_id, email, display_name, avatar_url, status, role, approved_at
  )
  values (
    new.id,
    lower(new.email),
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url',
    case when v_bootstrap then 'approved' else 'pending' end,
    case when v_bootstrap then 'admin'    else 'member'  end,
    case when v_bootstrap then now()      else null      end
  )
  on conflict (email) do update
    set user_id      = excluded.user_id,
        avatar_url   = excluded.avatar_url,
        display_name = coalesce(public.family_members.display_name, excluded.display_name);

  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Crée la fiche famille à la première connexion. Le premier compte devient admin approuvé pour amorcer le système.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();


-- ── 4. Qui voit quoi dans family_members ────────────────────────────────────

-- Chacun doit pouvoir lire SA fiche, pour que le site puisse afficher
-- « ta demande est en attente de validation » plutôt qu'une erreur muette.
create policy "chacun voit sa propre fiche"
  on public.family_members
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "les admins voient toutes les fiches"
  on public.family_members
  for select
  to authenticated
  using (public.is_admin());

-- Seul un admin approuve ou refuse. Personne ne peut s'auto-approuver.
create policy "les admins valident les demandes"
  on public.family_members
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ── 5. Les soumissions suivent le nouveau modèle ────────────────────────────

drop policy if exists "famille depose une soumission" on public.recipe_submissions;
drop policy if exists "chacun relit ses propres soumissions" on public.recipe_submissions;

create policy "membre approuve depose une soumission"
  on public.recipe_submissions
  for insert
  to authenticated
  with check (
    public.is_approved_member()
    and submitted_by = auth.uid()
  );

create policy "chacun relit ses propres soumissions"
  on public.recipe_submissions
  for select
  to authenticated
  using (
    public.is_approved_member()
    and submitted_by = auth.uid()
  );

-- Un admin voit et traite toutes les soumissions : c'est l'atelier de relecture.
create policy "les admins voient toutes les soumissions"
  on public.recipe_submissions
  for select
  to authenticated
  using (public.is_admin());

create policy "les admins traitent les soumissions"
  on public.recipe_submissions
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
