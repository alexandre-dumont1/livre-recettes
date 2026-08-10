
-- ══════════════════════════════════════════
-- RECIPES DATABASE - Mel Planner 2
-- ══════════════════════════════════════════

-- Categories table
CREATE TABLE recipe_categories (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recipes table (main)
CREATE TABLE recipes (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  category_id INT REFERENCES recipe_categories(id) ON DELETE SET NULL,
  description TEXT,
  source TEXT,                        -- origin: 'famille', 'blog', 'chef', etc.
  author TEXT,                        -- Manou, Véronique, Laurent Saudeau…
  servings INT,
  servings_unit TEXT DEFAULT 'personnes',
  prep_time_minutes INT,
  cook_time_minutes INT,
  rest_time_minutes INT,              -- repos, réfrigération, trempage
  total_time_minutes INT GENERATED ALWAYS AS (
    COALESCE(prep_time_minutes,0) + COALESCE(cook_time_minutes,0) + COALESCE(rest_time_minutes,0)
  ) STORED,
  difficulty TEXT CHECK (difficulty IN ('facile','moyen','difficile')),
  cost_per_person NUMERIC(6,2),       -- coût estimé €/personne
  tags TEXT[],                        -- ['sans gluten', 'végé', 'classique', ...]
  notes TEXT,                         -- conseils, astuces
  season TEXT[],                      -- ['hiver','printemps',...]
  make_ahead BOOLEAN DEFAULT FALSE,   -- peut être préparé à l'avance
  image_url TEXT,
  is_favorite BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ingredients (normalized)
CREATE TABLE ingredients (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  category TEXT,                      -- 'viande', 'légume', 'produit laitier', etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recipe <-> Ingredient junction (with quantity & unit)
CREATE TABLE recipe_ingredients (
  id SERIAL PRIMARY KEY,
  recipe_id INT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INT NOT NULL REFERENCES ingredients(id),
  quantity NUMERIC(10,3),
  unit TEXT,                          -- 'g', 'cl', 'c.s.', 'c.c.', 'pièce', etc.
  preparation TEXT,                   -- 'émincé', 'fondu', 'haché finement'…
  notes TEXT,                         -- '(optionnel)', 'ou spéculoos', etc.
  group_label TEXT,                   -- pour grouper: 'Pour la marinade', 'Pour la pâte'
  display_order INT DEFAULT 0,
  is_optional BOOLEAN DEFAULT FALSE,
  UNIQUE (recipe_id, ingredient_id, group_label)
);

-- Recipe steps
CREATE TABLE recipe_steps (
  id SERIAL PRIMARY KEY,
  recipe_id INT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  step_number INT NOT NULL,
  title TEXT,                         -- résumé court de l'étape
  description TEXT NOT NULL,
  duration_minutes INT,               -- durée de CETTE étape
  temperature_celsius INT,
  technique TEXT,                     -- 'mijoter', 'enfourner', 'monter en neige'...
  tips TEXT,
  UNIQUE (recipe_id, step_number)
);

-- Indexes for performance
CREATE INDEX idx_recipes_category ON recipes(category_id);
CREATE INDEX idx_recipes_tags ON recipes USING GIN(tags);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id);
CREATE INDEX idx_recipe_ingredients_ingredient ON recipe_ingredients(ingredient_id);
CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS (enabled but permissive for now — tighten when auth is added)
ALTER TABLE recipe_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read" ON recipe_categories FOR SELECT USING (true);
CREATE POLICY "public read" ON recipes FOR SELECT USING (true);
CREATE POLICY "public read" ON ingredients FOR SELECT USING (true);
CREATE POLICY "public read" ON recipe_ingredients FOR SELECT USING (true);
CREATE POLICY "public read" ON recipe_steps FOR SELECT USING (true);

