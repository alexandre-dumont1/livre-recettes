#!/usr/bin/env python3
"""
Propose des illustrations libres de droits pour chaque recette, via Pexels.

POURQUOI un écran de validation à la fin, et pas un téléchargement direct :
la pertinence d'une photo de plat ne se vérifie qu'à l'œil. Pexels cherche
large — « Soupe d'Oranges aux Fruits Rouges » remonte de la soupe de cerise et
du gaspacho de pastèque. Un script qui téléchargerait le premier résultat
mettrait des plats qui ne sont pas les tiens sur tes recettes, exactement ce que
tu as demandé d'éviter.

Donc : la machine propose, tu tranches. Même principe que la relecture des
manuscrits extraits par IA.

Sortie :
  illustrations/propositions.json   les candidats, avec description et crédits
  illustrations/revue.html          la planche de validation à ouvrir

Usage :
  python3 scripts/illustrations-proposer.py            # toutes les recettes
  python3 scripts/illustrations-proposer.py --limite 20
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SORTIE = RACINE / "illustrations"
CANDIDATS = 3


def env():
    """Lit le .env sans dépendance externe."""
    valeurs = {}
    fichier = RACINE / ".env"
    if not fichier.exists():
        sys.exit("Aucun .env trouvé")
    for ligne in fichier.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if not ligne or ligne.startswith("#") or "=" not in ligne:
            continue
        cle, _, val = ligne.partition("=")
        valeurs[cle.strip()] = val.strip()
    return valeurs


def recettes(database_url):
    """Les recettes, hors fiches pratiques sans ingrédients ni étapes."""
    sql = """
    select r.id, r.title, r.slug, coalesce(r.category_id, 0),
           coalesce(replace(replace(r.description, '|', ' '), chr(10), ' '), ''),
           coalesce(array_to_string(r.tags, ','), ''),
           (select count(*) from recipe_ingredients ri where ri.recipe_id = r.id),
           (select count(*) from recipe_steps rs where rs.recipe_id = r.id)
    from recipes r order by r.id
    """
    psql = "/opt/homebrew/opt/libpq/bin/psql"
    if not Path(psql).exists():
        psql = "psql"
    out = subprocess.run([psql, database_url, "-Atc", sql],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit("psql a échoué : " + out.stderr[:300])
    liste = []
    for ligne in out.stdout.strip().split("\n"):
        if not ligne:
            continue
        rid, titre, slug, cat, desc, tags, nb_i, nb_e = ligne.split("|")
        liste.append({"id": int(rid), "titre": titre, "slug": slug,
                      "categorie": int(cat), "description": desc,
                      "tags": [t for t in tags.split(",") if t],
                      "ingredients": int(nb_i), "etapes": int(nb_e)})
    return liste


LEXIQUE = json.loads((Path(__file__).parent / "lexique-culinaire.json").read_text(encoding="utf-8"))
ARTICLES = {"de","du","des","la","le","les","un","une","au","aux","a","à","en","et","sur","pour","avec","sans"}
# Au-delà de 4 termes utiles, Pexels dilue la recherche au lieu de l'affiner.
MAX_TERMES = 4
manquants = {}


def requete(titre):
    """Traduit un intitulé français en requête anglaise de photographie culinaire.

    Stratégie B, retenue après comparaison : les photographes professionnels
    étiquettent leur travail en anglais, et les termes du métier
    (« food photography ») ciblent leurs images plutôt que celles d'amateurs.

    Trois filtres avant traduction :
      - les parenthèses partent (elles contiennent des noms de famille) ;
      - les noms propres et le bruit (« maison », « version », « facile ») partent ;
      - ce qui est déjà international (tajine, risotto, cassoulet) passe tel quel.
    """
    t = re.sub(r"\([^)]*\)", " ", titre)
    t = re.sub(r'[«»"“”]', " ", t)
    t = t.replace("Œ", "Oe").replace("œ", "oe")
    t = re.sub(r"\b[dlnjcmts]['’]", " ", t, flags=re.I)
    t = re.sub(r"['’]", " ", t)

    ecarter = set(LEXIQUE["ecarter_noms_propres"]) | set(LEXIQUE["ecarter_bruit"]) | ARTICLES
    passe = set(LEXIQUE["laisser_passer"])
    lex = LEXIQUE["lexique"]

    termes = []
    for mot in re.findall(r"[A-Za-zÀ-ÿ]+", t):
        bas = mot.lower()
        if bas in ecarter or len(bas) < 3:
            continue
        if bas in lex:
            trad = lex[bas].strip()
            if trad and trad not in termes:
                termes.append(trad)
        elif bas in passe:
            if bas not in termes:
                termes.append(bas)
        else:
            # On le signale au lieu de le glisser tel quel dans une requête
            # anglaise : un mot français non traduit fait dérailler la recherche.
            manquants[bas] = manquants.get(bas, 0) + 1

    termes = termes[:MAX_TERMES]
    if not termes:
        return ""
    return " ".join(termes) + " " + LEXIQUE["suffixe_requete"]


def cherche(cle, q, n=CANDIDATS):
    url = "https://api.pexels.com/v1/search?" + urllib.parse.urlencode(
        {"query": q, "per_page": n, "locale": "fr-FR"})
    out = subprocess.run(["curl", "-sS", "--max-time", "20",
                          "-H", f"Authorization: {cle}", url],
                         capture_output=True, text=True).stdout
    try:
        d = json.loads(out)
    except Exception:
        return None, []
    photos = []
    for p in d.get("photos", []):
        photos.append({
            "pexels_id": p["id"],
            "description": p.get("alt") or "",
            "photographe": p.get("photographer", ""),
            "page": p.get("url", ""),
            "vignette": p["src"]["medium"],
            "grande": p["src"]["large2x"],
            "largeur": p["width"], "hauteur": p["height"],
        })
    return d.get("total_results", 0), photos


def page_revue(propositions):
    """Planche de validation. Les choix sont gardés en localStorage et
    exportables par un bouton, pour être recollés dans la conversation."""
    lignes = []
    for p in propositions:
        cands = "".join(f"""
        <label class="cand">
          <input type="radio" name="r{p['id']}" value="{c['pexels_id']}">
          <img loading="lazy" src="{c['vignette']}" alt="">
          <span class="desc">{c['description'][:110]}</span>
          <span class="credit">{c['photographe']}</span>
        </label>""" for c in p["candidats"])
        aucun = f"""
        <label class="cand cand--aucun">
          <input type="radio" name="r{p['id']}" value="aucun" checked>
          <span class="rien">aucune<br>ne convient</span>
        </label>"""
        alerte = "" if p["candidats"] else '<p class="vide">Aucun résultat pour cette requête.</p>'
        lignes.append(f"""
      <section class="recette" data-id="{p['id']}">
        <header>
          <span class="rid">#{p['id']}</span>
          <h2>{p['titre']}</h2>
          <span class="req">requête : « {p['requete']} » · {p['total']} résultats</span>
        </header>
        {alerte}
        <div class="cands">{cands}{aucun}</div>
      </section>""")

    return f"""<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Validation des illustrations</title>
<style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{ background: #ddd7c8; color: #14120e; font-family: system-ui, sans-serif; font-size: 16px; line-height: 1.55; }}
.barre {{ position: sticky; top: 0; z-index: 10; background: #14120e; color: #f4f0e6; padding: 1rem 1.6rem;
  display: flex; align-items: center; gap: 1.2rem; flex-wrap: wrap; }}
.barre h1 {{ font-size: 1.05rem; }}
.barre p {{ font-size: 0.88rem; color: #a09889; }}
.barre button {{ margin-left: auto; min-height: 44px; padding: 0 1.1rem; cursor: pointer;
  font: inherit; font-weight: 700; background: #d1500f; color: #fff; border: 0; }}
#compteur {{ font-size: 0.88rem; color: #e8a06a; font-weight: 700; }}
.corps {{ max-width: 1180px; margin: 0 auto; padding: 1.6rem; }}
.recette {{ background: #f4f0e6; border: 1px solid #cfc7b4; padding: 1.1rem 1.3rem; margin-bottom: 1.2rem; }}
.recette header {{ display: flex; align-items: baseline; gap: 0.7rem; flex-wrap: wrap; margin-bottom: 0.9rem;
  border-bottom: 1.5px solid #14120e; padding-bottom: 0.4rem; }}
.rid {{ font-weight: 700; color: #a83d08; }}
.recette h2 {{ font-size: 1.08rem; }}
.req {{ margin-left: auto; font-size: 0.78rem; color: #6b6459; }}
.vide {{ font-size: 0.9rem; color: #9b2c1e; margin-bottom: 0.6rem; }}
.cands {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 0.8rem; }}
.cand {{ display: block; cursor: pointer; background: #fff; border: 3px solid #fff; padding-bottom: 0.4rem; }}
.cand:has(input:checked) {{ border-color: #a83d08; }}
.cand input {{ position: absolute; opacity: 0; }}
.cand img {{ width: 100%; aspect-ratio: 4/3; object-fit: cover; display: block; }}
.desc {{ display: block; font-size: 0.76rem; color: #4a453c; padding: 0.35rem 0.45rem 0; }}
.credit {{ display: block; font-size: 0.68rem; color: #6b6459; padding: 0.1rem 0.45rem 0; font-style: italic; }}
.cand--aucun {{ display: flex; align-items: center; justify-content: center; background: transparent;
  border: 2px dashed #cfc7b4; min-height: 150px; }}
.rien {{ font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.1em; color: #6b6459;
  font-weight: 700; text-align: center; }}
.cand:focus-within {{ outline: 3px solid #a83d08; outline-offset: 2px; }}
</style></head><body>

<div class="barre">
  <div>
    <h1>Validation des illustrations</h1>
    <p>Clique la photo qui correspond vraiment au plat. « Aucune ne convient » est la valeur par défaut.</p>
  </div>
  <span id="compteur">0 validée(s)</span>
  <button onclick="exporter()">Copier ma sélection</button>
</div>

<div class="corps">{''.join(lignes)}</div>

<script>
const CLE = 'illustrations-selection';
const etat = JSON.parse(localStorage.getItem(CLE) || '{{}}');

// On restaure les choix précédents : la planche fait 122 recettes, personne ne
// la remplit d'une seule traite.
for (const [id, val] of Object.entries(etat)) {{
  const el = document.querySelector(`input[name="r${{id}}"][value="${{val}}"]`);
  if (el) el.checked = true;
}}
majCompteur();

document.addEventListener('change', e => {{
  if (e.target.type !== 'radio') return;
  const id = e.target.name.slice(1);
  if (e.target.value === 'aucun') delete etat[id];
  else etat[id] = e.target.value;
  localStorage.setItem(CLE, JSON.stringify(etat));
  majCompteur();
}});

function majCompteur() {{
  const n = Object.keys(etat).length;
  document.getElementById('compteur').textContent = n + ' validée(s)';
}}

function exporter() {{
  const texte = JSON.stringify(etat, null, 1);
  navigator.clipboard.writeText(texte).then(
    () => alert(Object.keys(etat).length + ' sélection(s) copiées. Colle-les dans la conversation.'),
    () => prompt('Copie ce texte à la main :', texte)
  );
}}
</script>
</body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limite", type=int, default=0, help="nombre de recettes à traiter")
    args = ap.parse_args()

    conf = env()
    cle = conf.get("PEXELS_API_KEY")
    if not cle:
        sys.exit("PEXELS_API_KEY absente du .env")

    SORTIE.mkdir(exist_ok=True)
    liste = recettes(conf["DATABASE_URL"])
    if args.limite:
        liste = liste[:args.limite]

    propositions, sans_resultat, fiches = [], [], []
    for i, r in enumerate(liste, 1):
        # Les fiches pratiques (ni ingrédients ni étapes) ne sont pas des plats.
        if r["ingredients"] == 0 and r["etapes"] == 0:
            fiches.append(r["titre"])
            continue
        q = requete(r["titre"])
        # Certains titres ne décrivent pas le plat : « La Grande Duchesse » est un
        # entremets au chocolat, mais son intitulé ne le dit pas. La description,
        # elle, le dit. On la traduit avec le même lexique.
        if not q and r.get("description"):
            q = requete(" ".join(r["description"].split()[:10]))
            if q:
                print(f"       repli sur la description pour « {r['titre']} »")
        total, cands = cherche(cle, q) if q else (0, [])
        if not cands:
            sans_resultat.append(r["titre"])
        propositions.append({**r, "requete": q, "total": total or 0, "candidats": cands})
        print(f"  [{i}/{len(liste)}] #{r['id']:<4} {q[:40]:42} {total or 0:>5} résultats")
        time.sleep(0.12)  # on reste courtois avec l'API

    (SORTIE / "propositions.json").write_text(
        json.dumps(propositions, ensure_ascii=False, indent=1), encoding="utf-8")
    (SORTIE / "revue.html").write_text(page_revue(propositions), encoding="utf-8")

    print(f"\n{len(propositions)} recettes proposées")
    print(f"{len(fiches)} fiches pratiques écartées : {', '.join(fiches) or '—'}")
    if sans_resultat:
        print(f"{len(sans_resultat)} sans aucun résultat : {', '.join(sans_resultat)}")
    if manquants:
        top = sorted(manquants.items(), key=lambda x: -x[1])
        print(f"\n{len(manquants)} mots absents du lexique (à ajouter si utiles) :")
        for mot, n in top[:30]:
            print(f"   {n:>3}  {mot}")
    print(f"\nÀ ouvrir : {(SORTIE / 'revue.html').relative_to(RACINE)}")


if __name__ == "__main__":
    main()
