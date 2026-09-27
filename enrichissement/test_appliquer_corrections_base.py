#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests de enrichissement/appliquer-corrections-base.py.

Usage : python enrichissement/test_appliquer_corrections_base.py
"""

import importlib
import io
import os
import tempfile
import unittest

module_appliquer_corrections_base = importlib.import_module("appliquer-corrections-base")
appliquer_sur_fichier = module_appliquer_corrections_base.appliquer_sur_fichier

COLONNES = [
    "titre", "discipline_code", "discipline", "rang_fnege_2025",
    "pissn", "eissn", "issn_cle", "slug", "editeur", "openalex_id", "nom_openalex",
]

CSV_EXEMPLE = (
    ",".join(COLONNES) + "\n"
    + "APPETITE,SECTOR,Sectoriel,3,0092-0703,1095-8304,1095-8304,appetite,Elsevier BV,https://openalex.org/S126804734,Appetite\n"
    + "ABACUS,ACC,Comptabilité,2,0001-3072,1467-6281,1467-6281,abacus,,,\n"
)


class TestAppliquerSurFichier(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.chemin = os.path.join(self.tmpdir.name, "exemple.csv")
        with io.open(self.chemin, "w", encoding="utf-8", newline="") as f:
            f.write(CSV_EXEMPLE)

    def tearDown(self):
        self.tmpdir.cleanup()

    def _lire(self):
        with io.open(self.chemin, encoding="utf-8") as f:
            return f.read()

    def test_corrige_le_pissn_dappetite_dans_le_fichier(self):
        changements = appliquer_sur_fichier(self.chemin)
        self.assertEqual(len(changements), 1)
        contenu = self._lire()
        self.assertIn("0195-6663", contenu)
        self.assertNotIn("0092-0703", contenu)

    def test_ne_touche_pas_une_ligne_sans_correction(self):
        appliquer_sur_fichier(self.chemin)
        self.assertIn("0001-3072", self._lire())

    def test_est_idempotent(self):
        appliquer_sur_fichier(self.chemin)
        changements = appliquer_sur_fichier(self.chemin)
        self.assertEqual(changements, [])

    def test_naugmente_pas_le_nombre_de_lignes(self):
        appliquer_sur_fichier(self.chemin)
        self.assertEqual(len(self._lire().strip().split("\n")), 3)


if __name__ == "__main__":
    unittest.main()
