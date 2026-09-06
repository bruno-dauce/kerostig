# Notes

Anomalies connues des données sources, et raisons de ne pas les corriger tout de suite.

## ISSN faux : Ecological Economics indexée sous 1989-2021

**Constat.** Dans le classement FNEGE 2025, ECOLOGICAL ECONOMICS (rang 2, discipline Sectoriel) porte `eISSN = 1989-2021`. Ce n'est pas un ISSN : c'est une plage d'années saisie dans la colonne eISSN.

| Champ | Valeur enregistrée | Valeur correcte |
| --- | --- | --- |
| `pissn` | 1873-6106 | 0921-8009 (papier) |
| `eissn` | 1989-2021 | 1873-6106 (électronique) |
| `issn_cle` | 1989-2021 | 1873-6106 |

Le pISSN enregistré est en réalité l'eISSN de la revue : les deux colonnes sont décalées, et la seconde a reçu une plage d'années.

**Portée.** `issn_cle` sert de clé de jointure dans tout le projet. `www/_data/journals.json` indexe donc cette revue sous `1989-2021`, et c'est cette valeur que doit porter un appel pour lui être rattaché. Le pipeline est cohérent avec lui-même — la revue est correctement enrichie par OpenAlex, DOAJ, Open Policy Finder et Mir@bel, toutes atteintes par le repli sur `pissn` — mais la clé est fausse.

**Pourquoi ce n'est pas détecté.** `1989-2021` a la forme d'un ISSN et satisfait le motif `\d{4}-\d{3}[\dX]` utilisé partout dans le pipeline. Seule la clé de contrôle le rejette, et aucune des vérifications en place ne la calcule.

**Comment il a été trouvé.** Par l'API Mir@bel, le 2026-09-05, qui répond `HTTP 400 — Cet ISSN n'est pas valide` là où DOAJ et OpenAlex renvoient un résultat vide sans rien signaler. Mir@bel est la seule des quatre sources à valider la clé de contrôle.

**Pourquoi ne pas corriger tout de suite.** Changer `issn_cle` change le slug et donc l'URL `/journal/...` d'une revue de rang 2 déjà en ligne et indexée, et rompt le rattachement des appels déjà collectés. C'est une migration, pas une correction ponctuelle :

1. corriger les deux colonnes dans le CSV de correspondance ISSN ;
2. régénérer `journals.json` ;
3. réassocier les appels portant l'ancienne clé ;
4. poser une redirection de l'ancien slug vers le nouveau.

**À faire au passage.** Passer les 884 ISSN à la clé de contrôle donnerait la liste complète des cas de ce type. Un seul est connu à ce jour, mais le contrôle n'a porté que sur les revues effectivement interrogées par Mir@bel.

## Rejouer marquer-francophones.mjs

`enrichissement/marquer-francophones.mjs` dérive le champ `francophone` de
`www/_data/journals.json` du marqueur `Fr` du classement FNEGE 2025.

**Le classeur source n'est pas versionné.** Le script l'attend en
`_tmp/Classement-FNEGE-2025.xlsx`, un répertoire ignoré par git. Sans ce
fichier, le script s'arrête avec un message explicite plutôt que de produire un
marquage vide. Le chemin se surcharge avec `--xlsx`.

C'est voulu : cette passe est manuelle, comme celle de Mir@bel, et n'a pas à
être rejouable en intégration continue. Le classeur contient le classement
FNEGE intégral, que le projet ne republie pas.

**Ordre de rejeu.** Trois passes s'appliquent successivement à
`journals.json`, et les deux dernières sont additives — `enrichir-revues.mjs`
reconstruit chaque entrée de zéro dans `construireRevue` et effacerait les
champs ajoutés après lui. Si une régénération complète devient nécessaire :

1. `node enrichissement/enrichir-revues.mjs --input <csv> --output www/_data/journals.json`
2. `node enrichissement/enrichir-mirabel.mjs` — rétablit le bloc `mirabel`
3. `node enrichissement/marquer-francophones.mjs` — rétablit le champ `francophone`

Les deux dernières s'appuient sur le cache disque `.cache-enrichissement/` et
ne réinterrogent pas le réseau inutilement.
