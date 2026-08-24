#!/usr/bin/env bash
# Etat du profil Chrome mis en cache par .github/workflows/scrape.yml.
#
# Appele avant et apres le scraping pour repondre a une question precise :
# le cookie cf_clearance restaure d'un run a l'autre est-il encore honore
# par Cloudflare, ou l'IP changeante des runners GitHub l'invalide-t-elle ?
# Sans ces deux releves, on ne peut pas distinguer "cache inutile" de
# "cache jamais restaure".
#
# Le run 32712644782 (2026-08-24) a montre un troisieme cas non prevu : pas
# de jar du tout apres le scraping, alors que Chrome avait bien tourne
# (Elsevier 205 appels, Springer 54, T&F 78). D'ou le releve d'arborescence
# ci-dessous, qui dit si le jar est ailleurs ou nulle part.
#
# Ne fait jamais echouer le job : c'est un instrument de mesure, pas une
# etape du pipeline.
set -u

MOMENT="${1:-}"
PROFILE=".browser-profile"
JAR="$PROFILE/userdir/Default/Network/Cookies"

echo "=== Profil navigateur ${MOMENT} ==="

if [ ! -d "$PROFILE" ]; then
    echo "Repertoire $PROFILE absent : le navigateur n'a pas encore tourne."
    exit 0
fi

if [ ! -f "$JAR" ]; then
    echo "Jar absent au chemin attendu ($JAR)."

    echo "-- Un jar existe-t-il ailleurs dans le profil ?"
    trouves=$(find "$PROFILE" -name 'Cookies*' 2>/dev/null)
    if [ -n "$trouves" ]; then
        echo "$trouves" | sed 's/^/   /'
    else
        echo "   Aucun fichier nomme Cookies* dans tout le profil."
    fi

    echo "-- Arborescence du profil (40 plus gros fichiers, taille en octets)"
    find "$PROFILE" -type f -printf '%10s  %p\n' 2>/dev/null \
        | sort -rn | head -40 | sed 's/^/   /'
    echo "-- Total : $(find "$PROFILE" -type f 2>/dev/null | wc -l) fichier(s)"

    # Deux causes possibles a un profil sans cookies : Chrome n'a pas su
    # initialiser son backend de chiffrement, ou il tourne dans un mode qui
    # ne persiste rien. Ces deux releves aident a trancher.
    echo "-- Environnement"
    echo "   Chrome : $(google-chrome --version 2>/dev/null || echo 'introuvable')"
    # Sortie vide et code de retour nul quand rien ne tourne : le repli doit
    # porter sur la variable, pas sur le code de sortie du pipeline.
    trousseau=$(pgrep -l 'gnome-keyring|kwalletd' 2>/dev/null | tr '\n' ' ')
    echo "   Trousseau en session : ${trousseau:-aucun}"
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
