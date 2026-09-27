# kerostig

Les appels à publications en gestion, classés. Le site rassemble les appels à publications (calls for papers) des revues de sciences de gestion et management, en affichant leur rang FNEGE et des informations d'accès ouvert.

Projet non lucratif. Base technique : fork de callsforpapers (licence MIT), projet de Julian Prester. Site statique alimenté par un pipeline de scraping, sans serveur applicatif. La collecte quotidienne tourne via GitHub Actions, et le site est hébergé sur Cloudflare, redéployé automatiquement à chaque mise à jour du dépôt.

Site : https://kerostig.org (en construction)

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
  kerostig-correspondance-issn.csv
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

## Collecter Wiley, SAGE, Emerald et INFORMS à la main

La collecte hebdomadaire tourne sur GitHub Actions le lundi matin. Wiley, SAGE, Emerald et INFORMS en sont exclus : Cloudflare bloque les adresses des serveurs de GitHub, alors que le navigateur passe depuis un poste personnel. Ces quatre éditeurs se collectent donc à la main, sous Windows, depuis la racine du dépôt :

```powershell
npm.cmd run manuel
```

Le script enchaîne les étapes suivantes :

1. Il vérifie qu'on est sur `main` et que le dépôt n'a aucune modification en cours. Sinon, il s'arrête.
2. Il récupère le dernier passage de la CI (`git pull --ff-only`).
3. Il collecte les quatre éditeurs. Chrome s'ouvre : il ne faut pas le fermer. Les quatre éditeurs sont collectés en parallèle : Wiley prend environ 3 minutes, SAGE autant. L'extraction des nouveaux appels par le modèle s'ajoute.
4. Il régénère les flux RSS.
5. Il affiche le bilan : nouveaux appels, appels réactivés, appels désactivés par éditeur. Il isole les désactivations suspectes, c'est-à-dire les appels désactivés alors que leur échéance est future ou inconnue.
6. Il committe, puis pousse. Si plus de 5 désactivations sont suspectes, ou si une étape a échoué, il demande confirmation avant de pousser. Les appels clos qui passent en archive ne comptent pas. En cas de refus, le commit reste local.

Wiley ne revérifie qu'une fois par semaine les revues confirmées sans page d'appels. Pour toutes les revérifier, par exemple après l'ajout d'un chemin dans le scraper, ajoutez une option (environ 20 minutes de plus) :

```powershell
npm.cmd run manuel -- --reverifier-wiley
```

Prérequis : Google Chrome installé, et un fichier `.env` avec la clé de l'API d'extraction. Un appel désactivé n'est pas supprimé : il passe en archive. Une revue bloquée par Cloudflare pendant le passage garde ses appels tels quels.

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

Un don couvre le nom de domaine et les frais de fonctionnement : https://ko-fi.com/kerostig

## Contact

Bruno Daucé, IAE Angers, université d'Angers. bruno.dauce@univ-angers.fr

Pour signaler un appel manquant, une donnée erronée ou un scraper cassé, ouvrir une issue sur le dépôt est le plus simple.
