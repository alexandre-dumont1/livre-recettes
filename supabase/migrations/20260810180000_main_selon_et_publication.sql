-- ═══════════════════════════════════════════════════════════════════════════
-- LA MAIN, LE « SELON », ET LE DROIT D'ÉCRIRE DANS LE LIVRE
-- ═══════════════════════════════════════════════════════════════════════════
-- Jusqu'ici le livre affichait « author sinon source » comme provenance. Or les
-- deux colonnes ne portent pas la même chose : source contient un TYPE (famille
-- 55, presse 10, blog 9, chef 3) et author un NOM, mais un nom qui mélange les
-- mains de la famille (Maman, Caro, Manou) et les chefs (Lenôtre, Pierre Hermé).
-- Résultat, 95 pages sur 122 signaient « famille ».
--
-- On ne touche pas à l'existant : deux colonnes neuves séparent enfin les deux
-- questions, et l'affichage retombe sur l'ancien comportement quand elles sont
-- vides. Les 122 recettes actuelles rendent donc exactement comme avant.

alter table public.recipes
  add column if not exists hand         text,
  add column if not exists hand_user_id uuid references auth.users(id) on delete set null,
  add column if not exists attribution  text;

comment on column public.recipes.hand is
  'La main : qui a apporté cette recette au livre. Renseignée automatiquement au nom du membre qui importe.';
comment on column public.recipes.hand_user_id is
  'Le compte derrière la main. Sert aussi de droit de correction : sa main peut corriger sa recette.';
comment on column public.recipes.attribution is
  'Le « selon » : origine extérieure au livre (un chef, un livre, un site). Affichée « d''après Bocuse ».';

-- L'index par main lit cette expression à chaque ouverture du panneau : sans
-- index dédié, il fait un balayage complet, ce qui reste sans conséquence à 122
-- lignes mais coûtera dès quelques milliers.
create index if not exists recipes_hand_idx on public.recipes (hand) where hand is not null;

-- ── LE DROIT D'ÉCRIRE ──────────────────────────────────────────────────────
-- Choix retenu : publication directe. Les quinze membres sont approuvés un par
-- un à la main, la confiance est donc déjà accordée à l'entrée du livre ; une
-- file d'attente ne protégerait de rien et ferait attendre une semaine une
-- recette déposée un dimanche. La correction se fait après coup.
--
-- Deux garde-fous quand même : on ne peut publier qu'en son propre nom
-- (hand_user_id = auth.uid()), et on ne peut corriger que sa propre recette,
-- sauf pour un administrateur.

drop policy if exists "membre approuve ajoute une recette" on public.recipes;
create policy "membre approuve ajoute une recette"
  on public.recipes for insert to authenticated
  with check (is_approved_member() and hand_user_id = auth.uid());

drop policy if exists "sa main ou un admin corrige la recette" on public.recipes;
create policy "sa main ou un admin corrige la recette"
  on public.recipes for update to authenticated
  using (is_approved_member() and (hand_user_id = auth.uid() or is_admin()))
  with check (is_approved_member() and (hand_user_id = auth.uid() or is_admin()));

-- Le vocabulaire des ingrédients est commun à tout le livre : on peut y ajouter
-- un mot, jamais renommer ni supprimer celui d'un autre, sinon une correction
-- innocente déplacerait des recettes dans l'index par ingrédient.
drop policy if exists "membre approuve enrichit le vocabulaire" on public.ingredients;
create policy "membre approuve enrichit le vocabulaire"
  on public.ingredients for insert to authenticated
  with check (is_approved_member());

-- Ingrédients et étapes suivent la recette : on écrit dans les siennes.
-- Sans le exists(), n'importe quel membre pourrait glisser une ligne dans la
-- recette de quelqu'un d'autre.
do $$
declare t text;
begin
  foreach t in array array['recipe_ingredients', 'recipe_steps'] loop
    execute format($f$
      drop policy if exists "ecrit dans sa propre recette" on public.%1$I;
      create policy "ecrit dans sa propre recette"
        on public.%1$I for insert to authenticated
        with check (
          is_approved_member() and exists (
            select 1 from public.recipes r
             where r.id = recipe_id
               and (r.hand_user_id = auth.uid() or is_admin())
          )
        );
      drop policy if exists "corrige dans sa propre recette" on public.%1$I;
      create policy "corrige dans sa propre recette"
        on public.%1$I for update to authenticated
        using (
          is_approved_member() and exists (
            select 1 from public.recipes r
             where r.id = recipe_id
               and (r.hand_user_id = auth.uid() or is_admin())
          )
        );
      drop policy if exists "retire dans sa propre recette" on public.%1$I;
      create policy "retire dans sa propre recette"
        on public.%1$I for delete to authenticated
        using (
          is_approved_member() and exists (
            select 1 from public.recipes r
             where r.id = recipe_id
               and (r.hand_user_id = auth.uid() or is_admin())
          )
        );
    $f$, t);
  end loop;
end $$;

-- ── LE SLUG ────────────────────────────────────────────────────────────────
-- slug est UNIQUE et NOT NULL, sans valeur par défaut ni trigger : jusqu'ici il
-- était écrit à la main. Une publication depuis le site ne peut pas dépendre de
-- ça, et deux « Tarte aux pommes » finiraient en collision.
create or replace function public.slug_libre(titre text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  base text;
  essai text;
  n int := 1;
begin
  -- Sans accents, en minuscules, tout le reste en tirets.
  base := lower(translate(coalesce(nullif(trim(titre), ''), 'recette'),
                          'àâäáãåçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÅÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ',
                          'aaaaaaceeeeiiiinooooouuuuyyAAAAAACEEEEIIIINOOOOOUUUUY'));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  if base = '' then base := 'recette'; end if;
  base := left(base, 80);

  essai := base;
  while exists (select 1 from public.recipes where slug = essai) loop
    n := n + 1;
    essai := base || '-' || n;
  end loop;
  return essai;
end $$;

comment on function public.slug_libre(text) is
  'Renvoie un slug disponible pour ce titre. Suffixe -2, -3… en cas d''homonyme.';

grant execute on function public.slug_libre(text) to authenticated;
