#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Applique corrections_issn.CORRECTIONS au CSV de base (rangs 1* a 3).

Ce CSV (kerostig-correspondance-issn.csv) n'a pas de script d'extraction
depuis le xlsx FNEGE comme extraire-rang4.py pour le rang 4 : il a ete
constitue a la main avant que ce pipeline existe. La table corrections_issn
doit neanmoins s'y appliquer par script, jamais par retouche manuelle du CSV.

Usage :
  python enrichissement/appliquer-corrections-base.py
  python enrichissement/appliquer-corrections-base.py chemin/vers/fichier.csv

Idempotent : sans correction a appliquer (deja faite, ou valeur d'origine deja
differente de "ancien"), le fichier n'est pas reecrit.
"""

import csv
import io
import os
import sys

from corrections_issn import appliquer_corrections_lignes

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_BASE = os.path.join(RACINE, "enrichissement", "kerostig-correspondance-issn.csv")

COLONNES = [
    "titre", "discipline_code", "discipline", "rang_fnege_2025",
    "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
]


def appliquer_sur_fichier(chemin):
    """Applique les corrections connues au CSV a `chemin` (colonnes COLONNES).

    Renvoie la liste des corrections effectivement appliquees. Ne reecrit le
    fichier que si au moins une correction a change une valeur.
    """
    with io.open(chemin, encoding="utf-8", newline="") as f:
        lignes = list(csv.DictReader(f))

    corrigees, changements = appliquer_corrections_lignes(lignes)

    if changements:
        with io.open(chemin, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=COLONNES, lineterminator="\n")
            w.writeheader()
            w.writerows(corrigees)

    return changements


def main():
    chemin = sys.argv[1] if len(sys.argv) > 1 else CSV_BASE
    if not os.path.exists(chemin):
        sys.exit("Fichier introuvable : " + chemin)

    changements = appliquer_sur_fichier(chemin)

    print("Fichier              : %s" % chemin)
    print("Corrections appliquees : %d" % len(changements))
    for c in changements:
        print("  %-9s %s : %s -> %s" % (c["champ"], c["titre_fnege"], c["ancien"], c["nouveau"]))
    if not changements:
        print("  (rien a corriger : soit deja fait, soit aucune ligne concernee)")


if __name__ == "__main__":
    main()
