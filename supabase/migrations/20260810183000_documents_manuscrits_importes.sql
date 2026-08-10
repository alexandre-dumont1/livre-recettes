-- Le dépôt d'une recette apporte la photo d'un FEUILLET, pas une photo de plat.
-- La règle d'écriture n'autorisait que kind = 'dish_photo' : elle bloquait donc
-- exactement le cas d'usage du livre, où l'on importe l'écriture de quelqu'un.
drop policy if exists "membre approuve ajoute une photo" on public.recipe_documents;
create policy "membre approuve ajoute un document"
  on public.recipe_documents for insert to authenticated
  with check (
    is_approved_member()
    and kind in ('dish_photo', 'manuscript')
    and uploaded_by = auth.uid()
  );

-- Rattacher un document à une recette était ouvert à tout membre approuvé, sur
-- n'importe quelle recette. On le restreint aux siennes, comme les ingrédients
-- et les étapes : sinon on peut coller son feuillet sur la page d'un autre.
drop policy if exists "membre approuve rattache sa photo" on public.recipe_document_links;
create policy "rattache un document a sa propre recette"
  on public.recipe_document_links for insert to authenticated
  with check (
    is_approved_member() and exists (
      select 1 from public.recipes r
       where r.id = recipe_id
         and (r.hand_user_id = auth.uid() or is_admin())
    )
  );

drop policy if exists "retire un lien de sa propre recette" on public.recipe_document_links;
create policy "retire un lien de sa propre recette"
  on public.recipe_document_links for delete to authenticated
  using (
    is_approved_member() and exists (
      select 1 from public.recipes r
       where r.id = recipe_id
         and (r.hand_user_id = auth.uid() or is_admin())
    )
  );
