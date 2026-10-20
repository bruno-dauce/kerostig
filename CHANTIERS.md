# Chantiers en cours

Suivi des chantiers ouverts pendant la séance du 2026-09-28 (doublons,
topics, libellés d'interface). Mis à jour au fil des PR ; ce fichier
documente l'état et les décisions prises, pas le détail technique
(qui vit dans les commits et les PR elles-mêmes).

## Routine

**Lancement manuel** (Wiley, SAGE, Emerald, INFORMS, Elsevier, MIS
Quarterly — bloqués en CI ou non testés depuis un runner) : toutes les semaines,

```powershell
npm.cmd run manuel
```

Depuis la racine, sous Windows, Chrome doit rester ouvert pendant la
collecte. Voir le README pour le détail des étapes et l'option
`--reverifier-wiley`.

**Si la collecte hebdomadaire (CI) échoue** :
1. Les données déjà collectées et passées par le modèle sont
   committées et poussées quand même (`if: always()` dans le
   workflow) — un run rouge ne fait jamais perdre de travail déjà
   fait.
2. Ouvrir les logs du run, chercher les lignes `[ALERTE]` : elles
   nomment le scraper en cause et le motif (`zero` ou `chute`). Ses
   appels actifs sont gelés tels quels, pas archivés à tort.
3. Retester ce scraper seul en local pour distinguer un vrai retrait
   éditeur d'un échec silencieux (site refondu, anti-bot renforcé) :
   `node --env-file .env scrapers/scraper.mjs --only <abréviation>`.
4. Une alerte sur Wiley, SAGE, Emerald, INFORMS, Elsevier ou MISQ un
   lundi est normale, pas un incident : ces six ne tournent jamais en
   CI. JAIS, lui, tourne en CI : une alerte `jais` est à traiter.

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
  dans un vrai navigateur pour trancher vivante/disparue. **6 de ces 9
  sont les fiches à suffixe `-2` sans jumeau ci-dessous** — même lot,
  pas un quatrième groupe distinct.
- Parmi elles, les 6 fiches à suffixe `-2` sans jumeau (reste du bug
  de slug corrigé en PR #16, confirmé par l'historique Git) : une fois
  leur statut « vivante » confirmé, les ramener à leur slug de base,
  avec redirection 301 du `-2` (publié depuis le 2026-08-12) ajoutée à
  `enrichissement/redirections.json`.

### 3. Réextraction des appels anciens (avant le commit `fc9899224`)

Appels extraits avant le garde-fou de longueur et de taux de copie sur
la description (2026-09-03) : à identifier et rejouer avec le
garde-fou actuel.

### 4. JAIS, MIS Quarterly et JMIS (scrapers en place, données à venir)

Scrapers `jais` et `misq` réécrits à partir de ceux supprimés dans le
commit `6fb0e704c` (dont le message, « Scrap-Emerald », n'explique pas
la suppression). Les anciens sélecteurs ne correspondaient plus ni
sur JAIS ni sur MISQ.

- **JAIS** : tourne en CI. Liens `li > a` commençant par « Call for
  Papers: », documents lus par téléchargement direct (PDF, docx,
  Dropbox avec `dl=1` ; l'URL de la fiche garde `dl=0`). Un lien
  expiré (SharePoint) écarte l'appel, sans contenu de repli.
- **MIS Quarterly** : passe en navigateur (challenge Cloudflare franchi
  seul en 6 s), jamais en curl. Ajouté au lancement manuel et à
  `--sauf` de `scrape.yml`. Les entrées sans lien de titre
  (« Registered Reports ») sont ignorées.
- **JMIS** : tourne en CI (le site répond à un simple `fetch`). Lien
  « (PDF) » de chaque `h3` de `https://www.jmis-web.org/cfp`, vers
  `/cfps/*.pdf` ; le titre du site, aussi en `h3`, est écarté. Seul
  scraper lisant le site propre de la revue (l'éditeur est Taylor &
  Francis).
- Les appels arriveront dans `calls.json` à la prochaine collecte.
  Essai à blanc du 2026-10-01 : JAIS et MISQ, 6 fiches héritées
  reconnues (slug conservé) et 1 appel nouveau (« Growing up Online »).
  JMIS, 2 fiches héritées reconnues (hash inchangé) et 1 appel nouveau
  (« Agentic Organizations »).

**Lot de données à venir** : faire pointer la fiche héritée
`misq-registered-reports` (URL morte `/call_for_papers/registered-reports`)
vers `https://misq.umn.edu/DocumentLibrary/InfoDocs/CFP_SI_RegisteredReports.pdf`,
s'il est toujours en ligne (à vérifier en navigateur : curl est bloqué).

### 5. Revérifier les 32 revues « aucun scraper possible »

Rapport de couverture du 2026-09-28 (rangs 1*/1/2) : 32 revues classées
sans scraper possible, sur le seul champ `editeur` de `journals.json`
(venant d'OpenAlex). Ce champ peut diverger de l'hébergement réel des
appels — cas trouvé en vérifiant : *European Journal of Information
Systems* est classé « Palgrave Macmillan » alors que ses appels sont
bien atteignables via le scraper Taylor & Francis
(`think.taylorandfrancis.com`).

À faire : revérifier les 32 une par une (l'éditeur qui héberge
réellement la page d'appels, pas l'éditeur OpenAlex), et corriger les
attributions erronées via une table de corrections versionnée — sur le
modèle de `enrichissement/corrections-issn.json`, pas une modification
directe de `journals.json` regénéré par le script d'enrichissement.

### 6. Transparence sur la couverture

Deux surfaces, une fois la reverification du point 5 avancée (pour
partir d'une classification aussi juste que possible) :

- **Page À propos**, nouvelle section « Couverture » :

  > kerostig suit les appels à publications (calls for papers) sur les
  > pages que les éditeurs et plateformes consacrent à leurs numéros
  > spéciaux. Certaines revues ne sont pas encore suivies
  > automatiquement, en particulier celles publiées par des presses
  > universitaires ou des associations savantes, dont les appels ne
  > sont pas rassemblés sur une page exploitable. Leur fiche le
  > signale. Les appels de ces revues collectés auparavant restent
  > consultables en archive.
  >
  > Une revue sans appel ouvert sur kerostig n'est donc pas forcément
  > une revue sans appel. En cas de doute, consultez son site.

- **Fiche revue**, une ligne selon le cas (appuyée sur
  `EDITEURS_COUVERTS` / `ISSN_COUVERTS`, déjà dans
  `eleventy.config.mjs`) :
  - non couverte : « Les appels de cette revue ne sont pas suivis
    automatiquement. Consultez son site pour les appels en cours. » ;
  - couverte, sans appel trouvé à la dernière collecte : « Aucun appel
    ouvert repéré pour cette revue à la dernière collecte. »

### 7. Plus tard, sans urgence

- Suite de tests et test de fumée en CI.
- Renormalisation CRLF (`git add --renormalize .`), quand aucune PR
  n'est ouverte.
- Horodatage Mir@bel dans l'attribution.
- Couverture du hub Elsevier (variantes de chargement, cf. mémoire
  `elsevier-hub-deux-variantes`).
- Surveiller la sortie d'un correctif amont de `braces` (tiré par
  micromatch, fast-glob et chokidar, eux-mêmes par Eleventy et Tailwind ;
  outils de build seulement). Ne jamais utiliser `npm audit fix --force` :
  il rétrograderait Eleventy en 0.6.0.

### 8. Ouverts le 2026-10-20, à traiter

- **Flux RSS des revues nommés d'après le slug de `journals.json`.**
  `feedgen.mjs` nomme chaque `www/journal/{slug}.xml` d'après le libellé de
  revue scrapé (`slugify`), pas d'après le slug de `journals.json`, et ne
  l'écrit que pour une revue qui a déjà eu un appel. Résultat : 299 revues sur
  885 ont un flux à leur slug, 41 flux portent un autre nom (orphelins), 586
  revues n'en ont pas. La fiche revue ne propose le flux que s'il existe
  (filtre `fluxRevueExiste`, PR #36). À faire : nommer les flux d'après le
  slug de `journals.json`, et rediriger (301) les 41 anciens noms.
- **Dépôt HAL des revues francophones.** L'API Mir@bel n'expose aucune
  politique de dépôt (le schéma `Revue` ne porte que l'identité), alors que
  le cahier des charges v3 (§3.1, §3.3) lui en attribue. 61 revues absentes
  d'Open Policy Finder sont dans Mir@bel mais sans politique ; 22 n'ont ni
  Mir@bel ni Open Policy Finder, leur ligne affiche « Non renseignée ». La
  licence des données Mir@bel reste à confirmer avant toute publication.

### 10. Casse des noms de revue

Constat du 2026-10-20 : des fiches affichent un nom en minuscules, par exemple
« Advances in strategic management », « Harvard business review », « Finance
research letters », alors que le nom officiel est en casse de titre. Ne pas
corriger maintenant ; à regarder :

- **Origine : OpenAlex, pas le fichier FNEGE.** Le classement FNEGE est en
  capitales. `titre` de `journals.json` vaut `nom_openalex` (`display_name`
  d'OpenAlex, cf. `enrichir-revues.mjs`, `titre_source: "openalex"`) pour 876
  revues sur 885 ; le titre FNEGE n'est repris que pour 9. La casse en minuscules
  est donc celle d'OpenAlex.
- **Ampleur (heuristique : la moitié au moins des mots significatifs en
  minuscules) : 41 revues sur 885.** Pour ces 41, `nom_openalex` du CSV enrichi
  est identique au titre, minuscules comprises.
- **`nom_openalex` ne peut pas servir à normaliser** : il est la source du défaut
  (885 sur 885 identiques au titre à la casse et à la ponctuation près). Il
  faut une règle, ou une table de corrections versionnée, comme pour les ISSN.
- **Une règle automatique se tromperait** : la casse de titre anglaise ne vaut
  pas pour le français (« Revue française de gestion », « Management
  international » sont corrects), et les sigles (IEEE, MIS) y échappent.
  Piste : règle par langue (champ `francophone`), plus une table d'exceptions.
- **Autres défauts de noms vus au passage**, à traiter avec la même table :
  « M n gement » (accent perdu), « Revue internationale P M E … », « Systèmes d
  information & management » (apostrophe perdue).
