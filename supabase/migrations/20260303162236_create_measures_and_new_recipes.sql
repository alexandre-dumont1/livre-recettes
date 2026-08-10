
-- ══════════════════════════════════════════
-- TABLE : Équivalences poids/mesures/épices
-- ══════════════════════════════════════════
CREATE TABLE measurement_equivalences (
  id SERIAL PRIMARY KEY,
  product TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('cuillere_soupe','cuillere_cafe','poids_unitaire','verre_20cl','tasse_15cl','salage_kg','liquide')),
  value_grams NUMERIC(8,2),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_measures_product ON measurement_equivalences(product);

ALTER TABLE measurement_equivalences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read" ON measurement_equivalences FOR SELECT USING (true);

-- Nouvelles catégories pour les recettes
INSERT INTO recipe_categories (slug, name, emoji, display_order) VALUES
  ('gibier', 'Gibier & Volaille festive', '🦆', 5)
ON CONFLICT (slug) DO NOTHING;

