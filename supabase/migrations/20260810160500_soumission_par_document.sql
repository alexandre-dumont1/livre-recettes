-- Une soumission n'est plus un formulaire à remplir : c'est un document déposé.
-- Une recette de famille tient souvent sur deux ou trois feuillets photographiés,
-- et document_url ne pouvait en porter qu'un seul.
alter table public.recipe_submissions
  add column if not exists document_urls text[] not null default '{}';

-- Les soumissions déjà déposées avec un document unique rejoignent le tableau,
-- sinon elles apparaîtraient sans page à la relecture.
update public.recipe_submissions
   set document_urls = array[document_url]
 where document_url is not null
   and document_urls = '{}';

comment on column public.recipe_submissions.document_urls is
  'Pages du feuillet déposé, dans l''ordre de lecture. document_url conserve la première pour compatibilité.';

comment on column public.recipe_submissions.title is
  'Titre provisoire, déduit du nom de fichier au dépôt. L''administrateur le corrige à la relecture : on ne demande plus au contributeur de saisir quoi que ce soit.';
