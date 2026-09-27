#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Corrections ISSN et fusions connues du classement FNEGE.

Les donnees vivent dans corrections-issn.json (a cote de ce fichier), pas en
dur ici : c'est la table versionnee unique, lue aussi bien par ce module que
par les scripts Node (reenrichissement d'une revue, synchronisation des rangs
en conflit dans www/_data/journals.json). Le fichier FNEGE d'origine (xlsx)
n'est lui jamais modifie.

Les scripts qui extraient des lignes du xlsx (extraire-rang4.py notamment)
appellent `appliquer_corrections` avant de calculer `issn_cle` (= eISSN ou
pISSN), puis `verifier_collisions` sur l'ensemble des lignes retenues pour
detecter toute collision d'issn_cle qui ne serait pas une fusion deja
repertoriee dans corrections-issn.json. `appliquer_corrections_lignes` fait de
meme directement sur des lignes de CSV deja extraites (titre/pissn/eissn),
pour les chaines qui partent d'un CSV plutot que du xlsx (ex. le CSV de base
des rangs 1* a 3, qui n'a pas de script d'extraction depuis le xlsx).

Chaque valeur corrigee a ete verifiee sur le portail ISSN
(https://portal.issn.org) avant d'etre inscrite dans le JSON.
"""

import json
import os

CHEMIN_DONNEES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corrections-issn.json")

with open(CHEMIN_DONNEES, encoding="utf-8") as _f:
    _DONNEES = json.load(_f)

# Une entree par champ corrige. `ancien` est la valeur telle qu'elle apparait
# dans le xlsx FNEGE (ou dans un CSV qui en derive) : la correction ne
# s'applique que si elle correspond encore exactement, pour ne jamais ecraser
# une valeur deja differente.
CORRECTIONS = _DONNEES["corrections"]

# Deux lignes distinctes du classement FNEGE qui designent la meme revue. La
# cle est l'issn_cle partage ; `titres` liste exactement les titres FNEGE
# attendus sur cet issn_cle (ni plus, ni moins). `rang_retenu` est le rang a
# garder quand il ne fait pas debat ; null (None) signifie une decision
# humaine encore en attente, auquel cas `rangs_affiches` et `note_publique`
# donnent respectivement les rangs et le texte a afficher sur le site tant
# que la decision n'est pas prise (voir enrichissement/appliquer-conflits-rang.mjs).
FUSIONS_CONNUES = _DONNEES["fusions_connues"]


def appliquer_corrections(titre_fnege, pissn, eissn):
    """Applique les corrections connues pour ce titre a (pissn, eissn).

    Ne modifie un champ que si sa valeur actuelle correspond exactement a
    l'"ancien" attendu, pour ne jamais ecraser une valeur deja differente.
    Renvoie (pissn, eissn, corrections_appliquees).
    """
    appliquees = []
    for correction in CORRECTIONS:
        if correction["titre_fnege"] != titre_fnege:
            continue
        if correction["champ"] == "pissn" and pissn == correction["ancien"]:
            pissn = correction["nouveau"]
            appliquees.append(correction)
        elif correction["champ"] == "eissn" and eissn == correction["ancien"]:
            eissn = correction["nouveau"]
            appliquees.append(correction)
    return pissn, eissn, appliquees


def appliquer_corrections_lignes(lignes):
    """Applique les corrections connues a une liste de lignes de CSV deja
    extraites (dict avec au moins les cles 'titre', 'pissn', 'eissn').

    Ne modifie pas `lignes` en place : renvoie (lignes_corrigees, changements),
    ou lignes_corrigees est une nouvelle liste de dicts et changements la liste
    des entrees de CORRECTIONS effectivement appliquees.
    """
    corrigees = []
    changements = []
    for ligne in lignes:
        pissn, eissn, appliquees = appliquer_corrections(
            ligne.get("titre", ""), ligne.get("pissn") or None, ligne.get("eissn") or None
        )
        nouvelle = dict(ligne)
        if appliquees:
            nouvelle["pissn"] = pissn or ""
            nouvelle["eissn"] = eissn or ""
            changements.extend(appliquees)
        corrigees.append(nouvelle)
    return corrigees, changements


class CollisionIssnInconnue(Exception):
    """Deux lignes FNEGE de titres differents partagent un issn_cle qui ne
    figure pas dans FUSIONS_CONNUES."""


def verifier_collisions(lignes):
    """Verifie qu'aucun issn_cle n'est partage par des titres non repertories.

    `lignes` : iterable de (titre_fnege, issn_cle). Les issn_cle absents ou
    vides sont ignores. Leve CollisionIssnInconnue si un issn_cle est partage
    par un ensemble de titres qui ne correspond pas exactement a une fusion
    connue. Renvoie la liste des fusions connues effectivement rencontrees,
    sous forme de tuples (issn_cle, entree_fusion), pour alimenter un bilan.
    """
    titres_par_issn = {}
    for titre_fnege, issn_cle in lignes:
        if not issn_cle:
            continue
        titres_par_issn.setdefault(issn_cle, set()).add(titre_fnege)

    fusions_rencontrees = []
    for issn_cle, titres in titres_par_issn.items():
        if len(titres) <= 1:
            continue
        fusion = FUSIONS_CONNUES.get(issn_cle)
        if not fusion or set(fusion["titres"]) != titres:
            raise CollisionIssnInconnue(
                "issn_cle %s partage par des titres non repertories dans "
                "FUSIONS_CONNUES : %s" % (issn_cle, sorted(titres))
            )
        fusions_rencontrees.append((issn_cle, fusion))
    return fusions_rencontrees
