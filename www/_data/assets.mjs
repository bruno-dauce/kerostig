// Empreinte du CSS compile, pour l'adresse du fichier : /public/css/style.css?v=<empreinte>.
//
// Cloudflare Pages sert les ressources statiques avec « max-age=14400 » (4 h) et le
// HTML avec « max-age=0 » : apres un deploiement, un navigateur ayant deja la page
// recevait le nouveau HTML avec l'ancien CSS pendant quatre heures (classes kc-*
// sans regles, cartes cassees). L'empreinte fait changer l'adresse du CSS avec son
// contenu : HTML et CSS changent ensemble.
//
// Le CSS doit donc exister avant Eleventy : le script « build » lance Tailwind en
// premier. Sans fichier (premier lancement de « npm start »), pas d'empreinte :
// l'adresse reste nue, comme avant.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const CSS = new URL("../../public/public/css/style.css", import.meta.url);

export default {
    cssVersion: existsSync(CSS)
        ? createHash("sha256").update(readFileSync(CSS)).digest("hex").slice(0, 10)
        : "",
};
