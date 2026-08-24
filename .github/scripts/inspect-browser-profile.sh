#!/usr/bin/env bash
# Etat du profil Chrome mis en cache par .github/workflows/scrape.yml.
#
# Appele avant et apres le scraping pour repondre a une question precise :
# le cookie cf_clearance restaure d'un run a l'autre est-il encore honore
# par Cloudflare, ou l'IP changeante des runners GitHub l'invalide-t-elle ?
# Sans ces deux releves, on ne peut pas distinguer "cache inutile" de
# "cache jamais restaure".
#
# Ne fait jamais echouer le job : c'est un instrument de mesure, pas une
# etape du pipeline.
set -u

MOMENT="${1:-}"
JAR=".browser-profile/userdir/Default/Network/Cookies"

echo "=== Profil navigateur ${MOMENT} ==="

if [ ! -f "$JAR" ]; then
    echo "Aucun jar de cookies : profil neuf, rien n'a ete restaure."
    exit 0
fi

echo "Jar : $(wc -c < "$JAR") octets"

if ! command -v sqlite3 >/dev/null 2>&1; then
    # Repli si sqlite3 manque a l'image du runner : le comptage brut ne dit
    # pas quels hotes sont couverts, mais distingue un jar vide d'un jar
    # peuple, ce qui suffit a savoir si la restauration a fonctionne.
    echo "sqlite3 absent, comptage brut des occurrences :"
    echo "  cf_clearance : $(grep -oa cf_clearance "$JAR" | wc -l)"
    exit 0
fi

# Copie prealable : le jar peut porter un journal WAL, et sqlite3 ouvrirait
# le fichier en ecriture pour le rejouer.
cp "$JAR" /tmp/inspect-cookies.sqlite

echo "Cookies cf_clearance en base :"
# expires_utc compte les microsecondes depuis le 1601-01-01 (epoque
# Windows), d'ou le decalage de 11 644 473 600 secondes vers l'epoque Unix.
sqlite3 /tmp/inspect-cookies.sqlite \
    "SELECT '  ' || host_key || ' -- expire le ' ||
            datetime(expires_utc / 1000000 - 11644473600, 'unixepoch')
     FROM cookies WHERE name = 'cf_clearance' ORDER BY host_key;" \
    || echo "  (lecture sqlite impossible)"

echo "Total cookies toutes origines : $(sqlite3 /tmp/inspect-cookies.sqlite 'SELECT COUNT(*) FROM cookies;' 2>/dev/null || echo '?')"
