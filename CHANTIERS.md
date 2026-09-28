# Chantiers en cours

Suivi des chantiers ouverts pendant la séance du 2026-09-28 (doublons,
topics, libellés d'interface). Mis à jour au fil des PR ; ce fichier
documente l'état et les décisions prises, pas le détail technique
(qui vit dans les commits et les PR elles-mêmes).

## Fait (2026-09-28)

- Priorité 1 (doublons) : bug de slug instable corrigé, cartes de
  jointure ISSN/URL, dédoublonnage Wiley — PR #16.
- Priorité 1-2 : 13 doublons confirmés fusionnés, cas Wiley
  open-innovation, redirections `_redirects`, liens conjoints calculés
  au build — PR #17.
- ISSN attribué aux 41 fiches héritées restantes — PR #18.
- Priorité 3 : description retirée sur 84 fiches archivées sans
  source fiable (44 héritées sans jumeau, 38 disparues, 2 sans URL) —
  PR #19.
- Correctif scraper INFORMS : ne plus retenir une adresse `mailto:`
  comme URL source — PR #20.
- Garde-fou de longueur sur les topics (100 caractères) — PR #21.
- Libellés d'interface traduits, redirection rétroactive du doublon
  Elsevier du 2026-08-23 — PR #22.

## En attente, dans l'ordre

### 1. Raccourcissement des topics déjà en base (priorité 2b)

Script prêt (`_tmp/raccourcir-topics.mjs`, non versionné, non lancé) :
raccourcit chaque topic de plus de 100 caractères à partir du seul
texte déjà stocké dans `calls.json` (pas de nouvelle collecte).

Règles, dans cet ordre :
1. Ne jamais remplacer un topic par une version plus longue (ou de
   même longueur) que l'original.
2. Une relance si la première tentative dépasse encore 100
   caractères ; entre les deux tentatives, la plus courte l'emporte —
   seulement si elle respecte déjà la règle 1.

Validé sur un échantillon de 20 topics (18/20 sous 100 caractères).
**Préalable : PR #21 fusionnée** (le garde-fou de prompt doit être en
place avant toute réextraction ou retouche de données, pour ne pas
recréer le problème qu'on corrige).

**À faire** : lancer le script sur toute la base, puis PR de données
avec le journal avant/après.

### 2. Réextraction des appels archivés (priorité 2c)

Trois lots, une fois le point 1 terminé :
- Les 144 appels archivés confirmés « vivants » lors de la
  vérification en direct du 2026-09-28 (source répond, contenu
  contrôlé).
- Les 9 fiches « douteuses » (redirections ScienceDirect vers un code
  court, contenu non confirmable par une requête brute) : à recharger
  dans un vrai navigateur pour trancher vivante/disparue.
- Les 6 fiches à suffixe `-2` sans jumeau (reste du bug de slug
  corrigé en PR #16, confirmé par l'historique Git) : une fois leur
  statut « vivante » confirmé, les ramener à leur slug de base, avec
  redirection 301 du `-2` (publié depuis le 2026-08-12) ajoutée à
  `enrichissement/redirections.json`.

### 3. Réextraction des appels anciens (avant le commit `fc9899224`)

Appels extraits avant le garde-fou de longueur et de taux de copie sur
la description (2026-09-03) : à identifier et rejouer avec le
garde-fou actuel.

### 4. JAIS et MIS Quarterly

Aucun scraper actuel ne couvre ces deux revues (rang 1 et 1*
respectivement). À instruire : scraper dédié ou extension d'un
scraper existant, selon la structure de leur page d'appels.

### 5. Plus tard, sans urgence

- Suite de tests et test de fumée en CI.
- Renormalisation CRLF (`git add --renormalize .`), quand aucune PR
  n'est ouverte.
- Horodatage Mir@bel dans l'attribution.
- Couverture du hub Elsevier (variantes de chargement, cf. mémoire
  `elsevier-hub-deux-variantes`).
