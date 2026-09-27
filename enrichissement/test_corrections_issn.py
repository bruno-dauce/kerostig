#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de enrichissement/corrections_issn.py.

Usage : python enrichissement/test_corrections_issn.py
"""

import json
import os
import unittest

from corrections_issn import (
    CHEMIN_DONNEES,
    CollisionIssnInconnue,
    appliquer_corrections,
    appliquer_corrections_lignes,
    verifier_collisions,
)


class TestAppliquerCorrections(unittest.TestCase):
    def test_corrige_le_pissn_et_leissn_de_dsjie(self):
        pissn, eissn, appliquees = appliquer_corrections(
            "DECISION SCIENCES JOURNAL OF INNOVATIVE EDUCATION", "1540-4609", "1552-6763"
        )
        self.assertEqual(pissn, "1540-4595")
        self.assertEqual(eissn, "1540-4609")
        self.assertEqual(len(appliquees), 2)

    def test_corrige_le_pissn_dappetite(self):
        pissn, eissn, appliquees = appliquer_corrections("APPETITE", "0092-0703", "1095-8304")
        self.assertEqual(pissn, "0195-6663")
        self.assertEqual(eissn, "1095-8304")
        self.assertEqual(len(appliquees), 1)

    def test_ne_touche_pas_une_ligne_sans_correction(self):
        pissn, eissn, appliquees = appliquer_corrections("ABACUS", "0001-3072", "1467-6281")
        self.assertEqual(pissn, "0001-3072")
        self.assertEqual(eissn, "1467-6281")
        self.assertEqual(appliquees, [])

    def test_ignore_une_correction_si_la_valeur_dorigine_a_deja_change(self):
        # Le champ ne correspond plus a la valeur "ancien" attendue : la
        # correction ne doit pas s'appliquer en aveugle sur une autre valeur.
        pissn, eissn, appliquees = appliquer_corrections(
            "APPETITE", "0195-6663", "1095-8304"
        )
        self.assertEqual(pissn, "0195-6663")
        self.assertEqual(appliquees, [])


class TestDonneesPartagees(unittest.TestCase):
    def test_les_donnees_viennent_du_json_partage(self):
        # corrections_issn.py ne doit pas coder les corrections en dur : Node
        # (reenrichissement, sync des rangs en conflit) doit pouvoir lire la
        # meme table. CHEMIN_DONNEES doit pointer vers ce fichier JSON.
        self.assertTrue(os.path.basename(CHEMIN_DONNEES) == "corrections-issn.json")
        with open(CHEMIN_DONNEES, encoding="utf-8") as f:
            donnees = json.load(f)
        self.assertIn("corrections", donnees)
        self.assertIn("fusions_connues", donnees)


class TestAppliquerCorrectionsLignes(unittest.TestCase):
    def test_corrige_une_ligne_de_csv_par_titre(self):
        lignes = [
            {"titre": "APPETITE", "pissn": "0092-0703", "eissn": "1095-8304"},
            {"titre": "ABACUS", "pissn": "0001-3072", "eissn": "1467-6281"},
        ]
        corrigees, changements = appliquer_corrections_lignes(lignes)
        self.assertEqual(corrigees[0]["pissn"], "0195-6663")
        self.assertEqual(corrigees[1]["pissn"], "0001-3072")
        self.assertEqual(len(changements), 1)

    def test_ne_modifie_pas_les_lignes_dorigine(self):
        lignes = [{"titre": "APPETITE", "pissn": "0092-0703", "eissn": "1095-8304"}]
        appliquer_corrections_lignes(lignes)
        self.assertEqual(lignes[0]["pissn"], "0092-0703")

    def test_conserve_les_autres_champs_de_la_ligne(self):
        lignes = [{"titre": "APPETITE", "pissn": "0092-0703", "eissn": "1095-8304", "slug": "appetite"}]
        corrigees, _ = appliquer_corrections_lignes(lignes)
        self.assertEqual(corrigees[0]["slug"], "appetite")


class TestVerifierCollisions(unittest.TestCase):
    def test_leve_sur_une_collision_non_repertoriee(self):
        lignes = [("REVUE A", "1234-5678"), ("REVUE B", "1234-5678")]
        with self.assertRaises(CollisionIssnInconnue):
            verifier_collisions(lignes)

    def test_accepte_une_fusion_connue(self):
        lignes = [
            ("LEARNING ORGANIZATION", "1758-7905"),
            ("THE LEARNING ORGANIZATION", "1758-7905"),
        ]
        fusions = verifier_collisions(lignes)
        self.assertEqual(len(fusions), 1)
        self.assertEqual(fusions[0][0], "1758-7905")

    def test_naccepte_pas_un_titre_supplementaire_sur_une_fusion_connue(self):
        # Une fusion connue attend exactement ses deux titres : un troisieme
        # titre inattendu sur le meme issn_cle doit rester une alerte.
        lignes = [
            ("LEARNING ORGANIZATION", "1758-7905"),
            ("THE LEARNING ORGANIZATION", "1758-7905"),
            ("UNE AUTRE REVUE", "1758-7905"),
        ]
        with self.assertRaises(CollisionIssnInconnue):
            verifier_collisions(lignes)

    def test_ignore_les_lignes_sans_issn_cle(self):
        lignes = [("REVUE SANS ISSN", None), ("AUTRE REVUE SANS ISSN", "")]
        self.assertEqual(verifier_collisions(lignes), [])

    def test_ignore_deux_lignes_du_meme_titre_sur_le_meme_issn(self):
        # Pas une collision entre titres differents : rien a signaler.
        lignes = [("REVUE A", "1234-5678"), ("REVUE A", "1234-5678")]
        self.assertEqual(verifier_collisions(lignes), [])


if __name__ == "__main__":
    unittest.main()
