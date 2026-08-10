#!/usr/bin/env python3
"""
Génère tokens.css depuis tokens.json en PRÉSERVANT les chaînes de var().

Pourquoi ce script plutôt que generate-tokens.cjs du skill design-system :
ce dernier résout les références {primitive.color.encre.900} en valeur brute
(#14120e) dans les couches sémantique et composant. Résultat, une couche
sémantique décorative : changer --color-ink ne se propagerait à aucun composant,
alors que c'est précisément la raison d'être des trois couches.

Ici, une référence devient var(--nom-cible), donc :
    --primitive-color-encre-900: #14120e;
    --color-ink: var(--primitive-color-encre-900);
    --titre-recette-fg: var(--color-ink);
Un seul point de changement se propage partout.

Usage : python3 design-system/build-tokens.py
"""
import json
import re
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / "design-system" / "tokens.json"
CIBLE = RACINE / "tokens.css"

# Convention de nommage, alignée sur celle du skill : la couche primitive garde
# son préfixe, les couches sémantique et composant le perdent (elles sont déjà
# non ambiguës).
PREFIXES = {"primitive": "primitive-", "semantic": "", "component": ""}


def aplatir(noeud, chemin=()):
    """Parcourt l'arbre et renvoie [(chemin, valeur)] pour chaque feuille $value."""
    if isinstance(noeud, dict):
        if "$value" in noeud:
            yield chemin, noeud["$value"]
            return
        for cle, valeur in noeud.items():
            if cle.startswith("$") or cle.startswith("_"):
                continue
            yield from aplatir(valeur, chemin + (cle,))


def kebab(fragment):
    """fontSize -> font-size. Les variables CSS étant sensibles à la casse,
    mélanger camelCase et kebab-case fabrique des fautes de frappe silencieuses."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", fragment).lower()


def nom_css(couche, chemin):
    return "--" + PREFIXES[couche] + "-".join(kebab(f) for f in chemin)


def construire():
    if not SOURCE.exists():
        sys.exit(f"Introuvable : {SOURCE}")
    doc = json.loads(SOURCE.read_text(encoding="utf-8"))

    # Table de correspondance chemin JSON -> nom de variable CSS, pour résoudre
    # les références de la forme {semantic.color.ink}.
    index = {}
    couches = {}
    for couche in ("primitive", "semantic", "component"):
        feuilles = list(aplatir(doc.get(couche, {})))
        couches[couche] = feuilles
        for chemin, _ in feuilles:
            index[f"{couche}." + ".".join(chemin)] = nom_css(couche, chemin)

    ref = re.compile(r"^\{([a-zA-Z0-9_.-]+)\}$")
    inconnues = []

    lignes = [
        "/* ============================================================",
        "   Le Livre de Recettes — tokens de design",
        "   GÉNÉRÉ par design-system/build-tokens.py. Ne pas éditer à la main :",
        "   modifier design-system/tokens.json puis relancer le script.",
        "",
        "   Trois couches, chacune ne référençant que la précédente :",
        "     primitive  valeurs brutes, jamais utilisées dans un composant",
        "     semantic   intention (page, ink, accent, rule)",
        "     component  usage précis (titre-recette, tuile, bouton)",
        "   ============================================================ */",
        "",
    ]

    titres = {
        "primitive": "PRIMITIVE — valeurs brutes",
        "semantic": "SEMANTIC — intentions",
        "component": "COMPONENT — usages",
    }

    for couche in ("primitive", "semantic", "component"):
        lignes.append(f"/* === {titres[couche]} === */")
        lignes.append(":root {")
        for chemin, valeur in couches[couche]:
            brut = str(valeur)
            m = ref.match(brut.strip())
            if m:
                cible = index.get(m.group(1))
                if cible is None:
                    inconnues.append((nom_css(couche, chemin), m.group(1)))
                    rendu = brut
                else:
                    rendu = f"var({cible})"
            else:
                rendu = brut
            lignes.append(f"  {nom_css(couche, chemin)}: {rendu};")
        lignes.append("}")
        lignes.append("")

    CIBLE.write_text("\n".join(lignes), encoding="utf-8")

    total = sum(len(v) for v in couches.values())
    print(f"écrit {CIBLE.relative_to(RACINE)} — {total} tokens")
    for couche in ("primitive", "semantic", "component"):
        print(f"  {couche:10} {len(couches[couche])}")

    if inconnues:
        print("\nRÉFÉRENCES INTROUVABLES :")
        for nom, cible in inconnues:
            print(f"  {nom} -> {{{cible}}}")
        sys.exit(1)
    print("\ntoutes les références sont résolues")


if __name__ == "__main__":
    construire()
