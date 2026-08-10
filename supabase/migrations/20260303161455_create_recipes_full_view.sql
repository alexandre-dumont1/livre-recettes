
-- Vue complète pour requêtes MCP / apps externes
CREATE VIEW recipes_full AS
SELECT
  r.id,
  r.slug,
  r.title,
  c.slug AS category_slug,
  c.name AS category_name,
  c.emoji AS category_emoji,
  r.description,
  r.source,
  r.author,
  r.servings,
  r.servings_unit,
  r.prep_time_minutes,
  r.cook_time_minutes,
  r.rest_time_minutes,
  r.total_time_minutes,
  r.difficulty,
  r.cost_per_person,
  r.tags,
  r.notes,
  r.make_ahead,
  r.is_favorite,
  -- Ingrédients agrégés en JSON
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'id', ri.id,
        'ingredient', i.name,
        'category', i.category,
        'quantity', ri.quantity,
        'unit', ri.unit,
        'preparation', ri.preparation,
        'notes', ri.notes,
        'group', ri.group_label,
        'order', ri.display_order,
        'is_optional', ri.is_optional
      ) ORDER BY ri.display_order
    )
    FROM recipe_ingredients ri
    JOIN ingredients i ON i.id = ri.ingredient_id
    WHERE ri.recipe_id = r.id
  ), '[]'::json) AS ingredients,
  -- Étapes agrégées en JSON
  COALESCE((
    SELECT json_agg(
      json_build_object(
        'step', rs.step_number,
        'title', rs.title,
        'description', rs.description,
        'duration_minutes', rs.duration_minutes,
        'temperature_celsius', rs.temperature_celsius,
        'technique', rs.technique,
        'tips', rs.tips
      ) ORDER BY rs.step_number
    )
    FROM recipe_steps rs
    WHERE rs.recipe_id = r.id
  ), '[]'::json) AS steps
FROM recipes r
LEFT JOIN recipe_categories c ON c.id = r.category_id;

-- Vue légère pour listes/recherche rapide
CREATE VIEW recipes_summary AS
SELECT
  r.id, r.slug, r.title,
  c.name AS category,
  c.emoji,
  r.servings, r.total_time_minutes,
  r.difficulty, r.tags,
  r.make_ahead, r.is_favorite,
  r.author, r.source
FROM recipes r
LEFT JOIN recipe_categories c ON c.id = r.category_id
ORDER BY c.display_order, r.title;

-- RLS on views
GRANT SELECT ON recipes_full TO anon, authenticated;
GRANT SELECT ON recipes_summary TO anon, authenticated;

