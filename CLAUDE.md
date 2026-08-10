# hubecall

Agrégateur d'appels a publications des revues de gestion, enrichi du classement FNEGE et des informations d'accès ouvert.

## Architecture

- Fork de callsforpapers.org (licence MIT)
- Pipeline de scraping dans `scrapers/`
- Extraction structurée par l'API Anthropic (Claude), configurée dans `.env`
- Site statique généré par Eleventy dans `www/`
- Données des appels dans `www/_data/calls.json`
- Données des revues dans `www/_data/journals.json`
- Table de correspondance ISSN dans `hubecall-correspondance-issn-enrichi.csv`

## Conventions des scrapers

- Un fichier par éditeur dans `scrapers/journals/`
- Chaque scraper exporte un objet avec `name`, `url` et `async scrape(browser)`
- Chaque appel retourné porte l'ISSN canonique de sa revue (clé de jointure avec journals.json)
- Le matching se fait via le CSV enrichi (colonnes : titre, editeur, nom_openalex, issn_cle)
- Le pipeline (diffChecker) ne rappelle le modèle que sur les appels nouveaux ou modifiés

## Stack

Node.js, Playwright (patchright), API Anthropic, Eleventy, Alpine.js, Tailwind, daisyUI