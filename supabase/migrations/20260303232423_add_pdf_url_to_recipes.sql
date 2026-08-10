
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS pdf_url TEXT;
COMMENT ON COLUMN recipes.pdf_url IS 'URL publique du PDF source dans Supabase Storage';

