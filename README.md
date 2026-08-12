# hubecall

Un hub d'appels à publications en gestion. Le site rassemble les appels à publications (calls for papers) des revues de sciences de gestion et management, en affichant leur rang FNEGE et des informations d'accès ouvert.

Projet non lucratif. Base technique : fork de callsforpapers (licence MIT), projet de Julian Prester. Site statique alimenté par un pipeline de scraping, sans serveur applicatif. La collecte quotidienne tourne via GitHub Actions, et le site est hébergé sur Cloudflare, redéployé automatiquement à chaque mise à jour du dépôt.

Site : https://hubecall.com (en construction)

## Structure du dépôt

```
scrapers/                pipeline de collecte et d'extraction des appels
  journals/              un fichier par source à scraper
www/                     le site (générateur Eleventy)
  _data/
    calls.json           base des appels, produite par le pipeline
    journals.json        base des 494 revues enrichies (voir enrichissement/)
enrichissement/          NOTRE ajout : script qui fabrique journals.json
  enrichir-revues.mjs
  hubecall-correspondance-issn.csv
  .env                   clés API, jamais publié (voir .gitignore)
.github/workflows/       automatisation quotidienne du scraping
```

Le dossier `enrichissement/` est le seul que nous avons ajouté. Le reste vient du projet d'origine et ne doit pas être réorganisé : l'outillage s'attend à trouver cette arborescence telle quelle.

## Lancer le site en local

Prérequis : Node.js 20 ou plus (Node 18 n'est plus maintenu). Depuis la racine du dépôt :

```bash
npm install        # installe les dépendances (une fois)
npm run build      # construit le site
```

## Fabriquer la base des revues

Depuis le dossier `enrichissement/`, après avoir créé le fichier `.env` (voir `.env.exemple`) :

```bash
cd enrichissement
node enrichir-revues.mjs --limit 5    # test sur 5 revues
node enrichir-revues.mjs              # passage complet
```

Copier ensuite le `journals.json` produit dans `www/_data/`.

## Règles de travail à plusieurs

Toujours récupérer les changements (pull) avant de commencer, toujours envoyer (push) en finissant.
Pour une modification conséquente, travailler sur une branche puis fusionner via une pull request.
Ne jamais committer le fichier `.env` ni aucune clé API. Ils restent locaux et figurent dans `.gitignore`.
Utiliser les Issues du dépôt comme liste de tâches partagée.

## Sources de données

- Rang et discipline : FNEGE 2025. Contenu protégé : le rang est affiché au niveau de chaque revue, attribué à la FNEGE et lié à sa source, sans redistribution de la liste intégrale.
- Métriques : OpenAlex (CC0).
- Accès ouvert et APC : DOAJ (CC0).
- Auto-archivage et dépôt HAL : Open Policy Finder (ex Sherpa Romeo, Jisc), utilisé avec attribution.

Chaque appel renvoie à sa source d'origine. Les appels sont extraits automatiquement et peuvent comporter des inexactitudes, à vérifier avant toute décision.

## Licence

Le code est distribué sous licence MIT, dans la continuité de callsforpapers (Julian Prester). Voir le fichier `LICENSE`. Cette licence couvre le code, pas les données : le classement FNEGE reste un contenu protégé (voir Sources de données).

## Soutenir le projet

Un don couvre le nom de domaine et les frais de fonctionnement : https://ko-fi.com/hubecall

## Contact

Bruno Daucé, IAE Angers, université d'Angers. bruno.dauce@univ-angers.fr

Pour signaler un appel manquant, une donnée erronée ou un scraper cassé, ouvrir une issue sur le dépôt est le plus simple.
