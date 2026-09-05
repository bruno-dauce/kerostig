#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Extrait les revues de rang FNEGE 4 absentes du CSV enrichi.

Lit le classement FNEGE 2025 (xlsx), filtre FNEGE_2025 = 4, ecarte les revues
deja presentes dans kerostig-correspondance-issn-enrichi.csv (jointure par ISSN),
et produit rang4_brut.csv aux memes colonnes que le CSV enrichi.

Les colonnes editeur, openalex_id et nom_openalex sont laissees vides :
elles sont remplies par enrichir-rang4-openalex.mjs.

Usage : python enrichissement/extraire-rang4.py [chemin/vers/Classement-FNEGE-2025.xlsx]
"""

import csv
import io
import os
import re
import sys
import unicodedata
from collections import Counter

import openpyxl

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_ENRICHI = os.path.join(RACINE, "enrichissement", "kerostig-correspondance-issn-enrichi.csv")
SORTIE = os.path.join(RACINE, "enrichissement", "rang4_brut.csv")
XLSX_DEFAUT = r"C:\Users\bruno\Nextcloud\&A-New\2-LAB\Classement-FNEGE-2025.xlsx"

COLONNES = [
    "titre", "discipline_code", "discipline", "rang_fnege_2025",
    "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
]

# Libelles repris tels quels du CSV enrichi : ce sont eux qui alimentent
# /discipline/:slug, un libelle different creerait une page en double.
DISCIPLINES = {
    "ACC": "Comptabilité",
    "BUS HIST": "Histoire des affaires",
    "BUS SOC": "Entreprise et société",
    "EDUC": "Enseignement",
    "FIN": "Finance",
    "GEN MAN": "Management général",
    "HLTH": "Santé",
    "HRM": "GRH",
    "INNOV": "Innovation",
    "INT": "International",
    "LOG": "Logistique",
    "MIS": "Systèmes d information",  # sans apostrophe : conforme au CSV existant
    "MKG": "Marketing",
    "ORG STUD": "Études organisationnelles",
    "PUB MAN": "Management public",
    "SECTOR": "Sectoriel",
    "STRAT": "Stratégie",
}

MOTIF_ISSN = re.compile(r"^\d{4}-\d{3}[\dX]$")


def nettoyer_issn(valeur):
    """Renvoie un ISSN normalise, ou None si la cellule n'en contient pas.

    Le xlsx contient des espaces fines invisibles (U+200B), des espaces au milieu
    du numero, la mention « en cours », et des ISSN convertis en nombres par Excel
    (17511577, voire 9050167 dont le zero de tete a saute).
    """
    if valeur is None:
        return None
    if isinstance(valeur, (int, float)):
        chiffres = str(int(valeur)).zfill(8)
        valeur = chiffres[:4] + "-" + chiffres[4:]
    texte = str(valeur).replace("\u200b", "").replace("\u00a0", "")
    texte = re.sub(r"\s+", "", texte).upper()
    if not texte or not MOTIF_ISSN.match(texte):
        return None
    return texte


def creer_slug(titre):
    """Minuscules, sans accents, & devient and, le reste en tirets."""
    sans_accent = unicodedata.normalize("NFKD", titre)
    sans_accent = "".join(c for c in sans_accent if not unicodedata.combining(c))
    texte = sans_accent.lower().replace("&amp", " and ").replace("&", " and ")
    texte = re.sub(r"[^a-z0-9]+", "-", texte)
    return texte.strip("-")


def issn_du_csv_enrichi(chemin):
    """Tous les ISSN deja couverts, extraits au motif.

    Le CSV enrichi est mal echappe (titres a virgule non quotes, retour chariot
    isole en fin de slug) : un csv.reader le decoupe de travers. Un balayage au
    motif est ici plus sur, on ne cherche que l'ensemble des ISSN.
    """
    texte = io.open(chemin, encoding="utf-8").read()
    return {m.upper() for m in re.findall(r"\d{4}-\d{3}[\dXx]", texte)}


def slugs_du_csv_enrichi(chemin):
    texte = io.open(chemin, encoding="utf-8").read()
    return {m for m in re.findall(r",([a-z0-9]+(?:-[a-z0-9]+)+)\r?,", texte)}


def main():
    chemin_xlsx = sys.argv[1] if len(sys.argv) > 1 else XLSX_DEFAUT
    if not os.path.exists(chemin_xlsx):
        sys.exit("Classeur introuvable : " + chemin_xlsx)

    feuille = openpyxl.load_workbook(chemin_xlsx, data_only=True, read_only=True).worksheets[0]
    lignes = [r for r in feuille.iter_rows(min_row=2, values_only=True) if r[0]]

    deja_couverts = issn_du_csv_enrichi(CSV_ENRICHI)
    slugs_pris = slugs_du_csv_enrichi(CSV_ENRICHI)

    rang4 = [r for r in lignes if str(r[6]).strip() == "4"]

    retenues, ecartees_csv, doublons_internes, sans_issn = [], [], [], []
    codes_inconnus = Counter()
    vus = {}

    for titre, code, pissn_brut, eissn_brut, _a, _b, _c, _fr in (r[:8] for r in rang4):
        titre = str(titre).strip()
        code = (str(code).strip() if code else "")
        pissn = nettoyer_issn(pissn_brut)
        eissn = nettoyer_issn(eissn_brut)
        issn_cle = eissn or pissn

        if not issn_cle:
            sans_issn.append((titre, pissn_brut, eissn_brut))
            continue
        if (eissn and eissn in deja_couverts) or (pissn and pissn in deja_couverts):
            ecartees_csv.append((titre, issn_cle))
            continue
        if issn_cle in vus:
            doublons_internes.append((titre, issn_cle, vus[issn_cle]))
            continue
        vus[issn_cle] = titre

        if code not in DISCIPLINES:
            codes_inconnus[code] += 1

        slug = creer_slug(titre)
        base, n = slug, 2
        while slug in slugs_pris:
            slug = "%s-%d" % (base, n)
            n += 1
        slugs_pris.add(slug)

        retenues.append({
            "titre": titre,
            "discipline_code": code,
            "discipline": DISCIPLINES.get(code, ""),
            "rang_fnege_2025": "4",
            "pissn": pissn or "",
            "eissn": eissn or "",
            "issn_cle": issn_cle,
            "slug": slug,
            "editeur": "",
            "openalex_id": "",
            "nom_openalex": "",
        })

    with io.open(SORTIE, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLONNES, lineterminator="\n")
        w.writeheader()
        w.writerows(retenues)

    print("Classeur           : %s" % chemin_xlsx)
    print("Lignes lues        : %d" % len(lignes))
    print("Rang 4             : %d" % len(rang4))
    print("Deja dans le CSV   : %d" % len(ecartees_csv))
    print("Doublons internes  : %d" % len(doublons_internes))
    print("Sans ISSN valide   : %d" % len(sans_issn))
    print("Retenues           : %d  ->  %s" % (len(retenues), SORTIE))

    for titre, issn in ecartees_csv:
        print("  ecartee (deja couverte) : %s  %s" % (issn, titre))
    for titre, issn, garde in doublons_internes:
        print("  doublon interne         : %s  %s  (garde : %s)" % (issn, titre, garde))
    for titre, p, e in sans_issn:
        print("  sans ISSN               : %s  (pISSN=%r eISSN=%r)" % (titre, p, e))
    for code, n in codes_inconnus.items():
        print("  code discipline inconnu : %r sur %d revue(s), colonne discipline laissee vide" % (code, n))

    repartition = Counter(r["discipline_code"] for r in retenues)
    print("\nRepartition par discipline :")
    for code, n in sorted(repartition.items(), key=lambda kv: -kv[1]):
        print("  %-9s %-30s %d" % (code, DISCIPLINES.get(code, "?"), n))


if __name__ == "__main__":
    main()
