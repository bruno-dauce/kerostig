#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Repare l'echappement du CSV enrichi et ecrit une copie propre dans _tmp/.

Deux defauts a corriger, sans toucher au fichier d'origine :

1. Les titres a virgule ont ete ecrits deux fois. Le generateur a d'abord produit
   la forme CSV correcte, un champ unique entoure de guillemets, puis une seconde
   passe a redecoupe cette chaine sur ses virgules et a requote chaque morceau.
   Un titre en deux morceaux ressort ainsi avec un guillemet triple au debut,
   une virgule hors guillemets au milieu et un guillemet triple a la fin.
   La seconde passe etant elle-meme du CSV valide, on l'inverse exactement : on
   relit la ligne, on recolle les fragments de titre avec une virgule, et on
   deballe la chaine intermediaire.

2. Le champ slug se termine par un retour chariot isole (468 lignes sur 492),
   que la plupart des lecteurs prennent pour une fin de ligne.

Usage : python enrichissement/reparer-csv-enrichi.py
"""

import csv
import io
import os
import re
import sys

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTREE = os.path.join(RACINE, "enrichissement", "kerostig-correspondance-issn-enrichi.csv")
SORTIE = os.path.join(RACINE, "_tmp", "kerostigcorrespondanceissnenrichi_corrige.csv")

COLONNES = [
    "titre", "discipline_code", "discipline", "rang_fnege_2025",
    "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
]

CODES = {
    "ACC", "BUS HIST", "BUS SOC", "EDUC", "FIN", "GEN MAN", "HLTH", "HRM",
    "INNOV", "INT", "LOG", "MIS", "MKG", "ORG STUD", "PUB MAN", "SECTOR", "STRAT",
}
RANGS = {"1*", "1", "2", "3", "4"}
MOTIF_ISSN = re.compile(r"^\d{4}-\d{3}[\dX]$")


def deballer(chaine):
    """Retire les guillemets encadrants et dedouble les guillemets internes."""
    if len(chaine) >= 2 and chaine.startswith('"') and chaine.endswith('"'):
        return chaine[1:-1].replace('""', '"')
    return chaine


def main():
    brut = io.open(ENTREE, "rb").read().decode("utf-8")
    # Decoupage sur le seul \n : les \r isoles sont des donnees parasites,
    # pas des fins de ligne. Aucun champ ne contient de saut de ligne reel.
    lignes = [l for l in brut.split("\n") if l != ""]
    entete, enregistrements = lignes[0], lignes[1:]

    if entete.split(",") != COLONNES:
        sys.exit("En-tete inattendu : " + entete)

    corriges = []
    anomalies = []
    titres_recolles = 0
    cr_retires = 0
    slugs_absents = []
    champs_completes = []
    issn_cle_absents = []

    for numero, ligne in enumerate(enregistrements, start=2):
        cr_retires += ligne.count("\r")
        champs = next(csv.reader([ligne.replace("\r", "")]))

        # Le code discipline sert d'ancre : tout ce qui le precede est le titre.
        bornes = [i for i, c in enumerate(champs) if i >= 1 and c in CODES]
        if not bornes:
            anomalies.append((numero, "aucun code discipline reconnu", ligne[:90]))
            continue
        coupe = bornes[0]

        if coupe > 1:
            titre = deballer(",".join(champs[:coupe]))
            titres_recolles += 1
        else:
            titre = champs[0]

        reste = champs[coupe:]
        # Sur les lignes sans correspondance OpenAlex, le generateur a laisse
        # tomber les champs vides de fin : on les remet.
        if len(reste) < len(COLONNES) - 2:
            reste += [""] * (len(COLONNES) - 2 - len(reste))
            champs_completes.append(titre)
        if len(reste) == len(COLONNES) - 2:
            # Le slug manque sur ces lignes : on insere un champ vide pour
            # conserver l'alignement, sans inventer de valeur.
            reste = reste[:6] + [""] + reste[6:]
            slugs_absents.append((titre, reste[5]))
        elif len(reste) != len(COLONNES) - 1:
            anomalies.append((numero, "%d champs apres le titre" % len(reste), ligne[:90]))
            continue

        ligne_corrigee = dict(zip(COLONNES, [titre] + reste))

        if ligne_corrigee["rang_fnege_2025"] not in RANGS:
            anomalies.append((numero, "rang %r" % ligne_corrigee["rang_fnege_2025"], titre))
        for colonne in ("pissn", "eissn", "issn_cle"):
            valeur = ligne_corrigee[colonne]
            if valeur and not MOTIF_ISSN.match(valeur):
                anomalies.append((numero, "%s %r" % (colonne, valeur), titre))
        identifiant = ligne_corrigee["openalex_id"]
        if identifiant and not identifiant.startswith("https://openalex.org/"):
            anomalies.append((numero, "openalex_id %r" % identifiant, titre))
        if not ligne_corrigee["issn_cle"]:
            issn_cle_absents.append(titre)

        corriges.append(ligne_corrigee)

    os.makedirs(os.path.dirname(SORTIE), exist_ok=True)
    with io.open(SORTIE, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLONNES, lineterminator="\n")
        w.writeheader()
        w.writerows(corriges)

    print("Entree            : %s" % ENTREE)
    print("Enregistrements   : %d" % len(enregistrements))
    print("Titres recolles   : %d" % titres_recolles)
    print("Retours chariot   : %d retires" % cr_retires)
    print("Champs de fin     : %d lignes recompletees" % len(champs_completes))
    print("Slugs absents     : %d" % len(slugs_absents))
    print("issn_cle absents  : %d" % len(issn_cle_absents))
    print("Anomalies         : %d" % len(anomalies))
    print("Sortie            : %d lignes  ->  %s" % (len(corriges), SORTIE))

    for numero, motif, extrait in anomalies:
        print("  ligne %d : %s | %s" % (numero, motif, extrait))
    if slugs_absents:
        print("\nLignes sans slug (champ laisse vide, aucune valeur inventee) :")
        for titre, issn in slugs_absents:
            print("  %-9s %s" % (issn or "(vide)", titre))
    if issn_cle_absents:
        print("\nLignes sans issn_cle :")
        for titre in issn_cle_absents:
            print("  %s" % titre)


if __name__ == "__main__":
    main()
