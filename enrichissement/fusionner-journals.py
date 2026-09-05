#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fusionne le CSV enrichi corrige (rangs 1* a 3) et les revues de rang 4.

Sortie : _tmp/journals_rang4.csv, trie par rang FNEGE (1*, 1, 2, 3, 4) puis
par titre alphabetique, accents ignores.

Le CSV corrige garde les trous du fichier d'origine : 23 slugs et 2 issn_cle
absents sur les revues dont le titre contient une virgule. Ils sont completes
ici depuis www/_data/journals.json, qui fait autorite pour le site puisque les
routes /journal/:slug en ligne en sortent. La jointure suit la regle du projet,
issn_cle puis eISSN puis pISSN, jamais le nom de revue.

Le script est idempotent : il ne remplit que les champs vides et ne remplace
jamais une valeur en place.

Usage : python enrichissement/fusionner-journals.py
"""

import csv
import io
import json
import os
import re
import sys
import unicodedata
from collections import Counter

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORRIGE = os.path.join(RACINE, "_tmp", "kerostigcorrespondanceissnenrichi_corrige.csv")
RANG4 = os.path.join(RACINE, "enrichissement", "rang4_enrichi_openalex.csv")
JOURNALS = os.path.join(RACINE, "www", "_data", "journals.json")
SORTIE = os.path.join(RACINE, "_tmp", "journals_rang4.csv")

COLONNES = [
    "titre", "discipline_code", "discipline", "rang_fnege_2025",
    "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
]

ORDRE_RANGS = {"1*": 0, "1": 1, "2": 2, "3": 3, "4": 4}


def cle_titre(titre):
    """Tri alphabetique insensible aux accents et a la casse."""
    sans_accent = unicodedata.normalize("NFKD", titre)
    sans_accent = "".join(c for c in sans_accent if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", sans_accent.upper()).strip()


def lire(chemin):
    if not os.path.exists(chemin):
        sys.exit("Fichier introuvable : " + chemin)
    with io.open(chemin, encoding="utf-8", newline="") as f:
        lignes = list(csv.DictReader(f))
    if lignes and list(lignes[0].keys()) != COLONNES:
        sys.exit("Colonnes inattendues dans %s : %s" % (chemin, list(lignes[0].keys())))
    return lignes


def indexer_journals(chemin):
    """ISSN -> entree de journals.json. L'issn_cle prime, puis l'eISSN, puis le pISSN."""
    if not os.path.exists(chemin):
        sys.exit("Fichier introuvable : " + chemin)
    index = {}
    for cle, entree in json.load(io.open(chemin, encoding="utf-8")).items():
        for issn in (entree.get("issn_cle"), cle, entree.get("eissn"), entree.get("pissn")):
            if issn:
                index.setdefault(issn, entree)
    return index


def completer(lignes, index):
    """Remplit les slugs et issn_cle vides. Renvoie (slugs, issn, refus, non resolus)."""
    slugs, issns, refus, non_resolus = [], [], [], []

    for ligne in lignes:
        if ligne["slug"] and ligne["issn_cle"]:
            continue

        entree = None
        for issn in (ligne["issn_cle"], ligne["eissn"], ligne["pissn"]):
            if issn and issn in index:
                entree = index[issn]
                break
        if entree is None:
            non_resolus.append(ligne["titre"])
            continue

        # Garde-fou : un ISSN errone joindrait la mauvaise revue en silence.
        if entree.get("titre_fnege") != ligne["titre"]:
            refus.append((ligne["titre"], entree.get("titre_fnege")))
            continue

        if not ligne["issn_cle"] and entree.get("issn_cle"):
            ligne["issn_cle"] = entree["issn_cle"]
            issns.append((ligne["titre"], entree["issn_cle"]))
        if not ligne["slug"] and entree.get("slug"):
            ligne["slug"] = entree["slug"]
            slugs.append((ligne["titre"], entree["slug"]))

    return slugs, issns, refus, non_resolus


def main():
    base = lire(CORRIGE)
    rang4 = lire(RANG4)
    fusion = base + rang4

    inconnus = {r["rang_fnege_2025"] for r in fusion} - set(ORDRE_RANGS)
    if inconnus:
        sys.exit("Rangs inconnus : %s" % sorted(inconnus))

    fusion.sort(key=lambda r: (ORDRE_RANGS[r["rang_fnege_2025"]], cle_titre(r["titre"])))

    slugs, issns, refus, non_resolus = completer(fusion, indexer_journals(JOURNALS))

    with io.open(SORTIE, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLONNES, lineterminator="\n")
        w.writeheader()
        w.writerows(fusion)

    print("Rangs 1* a 3      : %d" % len(base))
    print("Rang 4            : %d" % len(rang4))
    print("Total             : %d  ->  %s" % (len(fusion), SORTIE))

    print("\nCompletion depuis journals.json :")
    print("  slugs completes    : %d" % len(slugs))
    print("  issn_cle completes : %d" % len(issns))
    for titre, valeur in issns:
        print("    issn_cle %-9s %s" % (valeur, titre))
    for _titre, valeur in slugs:
        print("    slug     %s" % valeur)
    for titre, autre in refus:
        print("    REFUS : %r joint sur %r" % (titre, autre))
    for titre in non_resolus:
        print("    NON RESOLU : %s" % titre)

    print("\nRepartition par rang :")
    par_rang = Counter(r["rang_fnege_2025"] for r in fusion)
    for rang in sorted(par_rang, key=lambda x: ORDRE_RANGS[x]):
        print("  %-3s %d" % (rang, par_rang[rang]))

    # Controles de coherence : on signale, on ne corrige pas.
    doublons_issn = [k for k, n in Counter(r["issn_cle"] for r in fusion if r["issn_cle"]).items() if n > 1]
    doublons_slug = [k for k, n in Counter(r["slug"] for r in fusion if r["slug"]).items() if n > 1]
    sans_slug = [r["titre"] for r in fusion if not r["slug"]]
    sans_issn = [r["titre"] for r in fusion if not r["issn_cle"]]
    sans_oa = [r["titre"] for r in fusion if not r["openalex_id"]]

    print("\nControles :")
    print("  issn_cle en double : %d %s" % (len(doublons_issn), doublons_issn or ""))
    print("  slug en double     : %d %s" % (len(doublons_slug), doublons_slug or ""))
    print("  sans slug          : %d" % len(sans_slug))
    print("  sans issn_cle      : %d" % len(sans_issn))
    print("  sans openalex_id   : %d" % len(sans_oa))


if __name__ == "__main__":
    main()
