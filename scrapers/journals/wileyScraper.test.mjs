import test from 'node:test';
import assert from 'node:assert/strict';

import { classerTentatives, ordonnerUrls, formaterBilan, extract_entries, lireEntree, doitVerifier, noterResultat, build_urls, revueParTitre, rattacherAppelsCommuns, extraire_detail, estSousDomaineSociete, classerRedirection, PAGES_SOCIETE, PAGE_COMMUNE_SMS, sourceDuLien, doitSuivre, resoudreEntree, extraire_detail_page } from './wileyScraper.mjs';

// Le compteur de fin de run rangeait tout echec sous « aucun des chemins
// d'URL essayes n'a repondu ». Verifie le 2026-09-03 sur quatre revues
// portant des appels actifs, c'etait faux : les chemins repondaient 403 ou
// 302, et leurs pages existent bien -- un navigateur y obtient 200 et plus de
// 100 Ko, aux memes URL. Un blocage rapporte comme une absence envoie le
// diagnostic suivant chercher des chemins d'URL au lieu du client HTTP.

test('un 403 est un blocage, pas une absence', () => {
    assert.equal(classerTentatives([{ statut: 403 }]), 'bloque');
});

test('une redirection est un blocage : chez Wiley elle mene au challenge', () => {
    assert.equal(classerTentatives([{ statut: 302 }]), 'bloque');
    assert.equal(classerTentatives([{ statut: 301 }]), 'bloque');
});

test('un corps de challenge suffit, quel que soit le statut', () => {
    assert.equal(classerTentatives([{ statut: 200, challenge: true }]), 'bloque');
});

test('le blocage l emporte sur les autres motifs', () => {
    // Une revue bloquee peut aussi bien avoir une page qu'aucune : on n'en
    // sait rien, et c'est le blocage qu'il faut signaler.
    assert.equal(classerTentatives([{ statut: 404 }, { statut: 403 }, { statut: 404 }]), 'bloque');
    assert.equal(classerTentatives([{ erreur: 'timeout' }, { statut: 403 }]), 'bloque');
});

test('des 404 sur tous les chemins signalent une page reellement absente', () => {
    assert.equal(classerTentatives([{ statut: 404 }, { statut: 404 }, { statut: 404 }]), 'absent');
});

test('une erreur reseau sans blocage est son propre motif', () => {
    assert.equal(classerTentatives([{ erreur: 'ETIMEDOUT' }, { statut: 404 }]), 'reseau');
});

test('un statut inattendu ne se fait pas passer pour une absence', () => {
    // Un 500 chez l'editeur n'est ni une page manquante ni un blocage : le
    // ranger dans « absent » ferait croire a une revue sans appels.
    assert.equal(classerTentatives([{ statut: 500 }, { statut: 404 }]), 'autre');
});

test('une liste vide de tentatives ne prétend rien', () => {
    assert.equal(classerTentatives([]), 'autre');
});

// Le chemin qui a fonctionne au passage precedent est essaye en premier : une
// page chargee par revue au lieu de jusqu'a sept.

test('sans chemin memorise, l ordre des candidats est conserve', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b', 'c'], undefined), ['a', 'b', 'c']);
});

test('le chemin memorise passe en tete, sans doublon', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
});

test('un chemin memorise hors des candidats est essaye quand meme', () => {
    assert.deepEqual(ordonnerUrls(['a', 'b'], 'z'), ['z', 'a', 'b']);
});

test('le bilan chiffre chaque motif et le nombre d appels', () => {
    const bilan = formaterBilan({
        total: 10, atteintes: 6, avecAppels: 4, appels: 12, requetes: 15,
        motifs: { bloque: 2, absent: 1, reseau: 1, autre: 0 },
    });
    assert.match(bilan, /Bilan sur 10 revue/);
    assert.match(bilan, /OK\s+6 \(dont 4/);
    assert.match(bilan, /bloquees\s+2/);
    assert.match(bilan, /absentes\s+1/);
    assert.match(bilan, /appels\s+12/);
});

// Constate le 2026-09-27 sur International Transactions in Operational
// Research : sous son h2 « Call for Papers », Wiley affiche un vieux module
// d'une AUTRE revue (Children & Society, 25e anniversaire, numero virtuel).
// Le seul lien de la section pointait vers la page de cette autre revue, et
// devenait un « appel » ITOR intitule « Children & Society ».

const PAGE_ITOR = 'https://onlinelibrary.wiley.com/page/journal/14753995/homepage/call_for_papers';
const sectionItor = liens => `<div class="pb-rich-text"><h2>Call for Papers</h2>${liens}</div>`;

test('un lien vers la page d une autre revue n est pas un appel', () => {
    const html = sectionItor(`<div class="moduleFragmentContainer"><h3>Children &amp; Society 25th Anniversary Issue</h3>
        <p><a href="/page/journal/10990860/homepage/children___society_25th_anniversary_issue.htm"><b><i>Children &amp; Society</i></b></a></p></div>`);
    assert.deepEqual(extract_entries(html, PAGE_ITOR, 'ITOR'), []);
});

test('un lien vers une page de la meme revue reste un appel', () => {
    const html = sectionItor(`<p><a href="/page/journal/14753995/homepage/si_logistics.htm">Special issue on logistics</a></p>`);
    const entries = extract_entries(html, PAGE_ITOR, 'ITOR');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].metaTitle, 'Special issue on logistics');
});

test('un lien hors des pages revue Wiley (PDF, site externe) reste un appel', () => {
    const html = sectionItor(`<p><a href="https://onlinelibrary.wiley.com/pb-assets/assets/14753995/CFP.pdf">CFP logistics</a></p>
        <p><a href="https://example.org/cfp">CFP external</a></p>`);
    assert.equal(extract_entries(html, PAGE_ITOR, 'ITOR').length, 2);
});

// Revues sans page d'appels : 61 revues sur 108 essayaient leurs 7 chemins a
// chaque run, soit 427 pages chargees sur 474. Une revue confirmee absente
// (deux runs consecutifs sans page) n'est plus reverifiee qu'une fois par
// semaine -- jamais sautee si elle a encore des appels actifs en base.

const JOUR = 24 * 3600 * 1000;
const MAINTENANT = Date.parse('2026-09-27T12:00:00Z');
const ilYa = jours => new Date(MAINTENANT - jours * JOUR).toISOString().slice(0, 10);

test('l ancien format (URL seule) est lu comme un chemin', () => {
    assert.deepEqual(lireEntree('https://x/y'), { chemin: 'https://x/y' });
    assert.deepEqual(lireEntree(undefined), {});
    assert.deepEqual(lireEntree({ absences: 2, verifie: '2026-09-20' }), { absences: 2, verifie: '2026-09-20' });
});

test('une revue inconnue ou avec un chemin est toujours verifiee', () => {
    assert.equal(doitVerifier({}, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
    assert.equal(doitVerifier({ chemin: 'u' }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
});

test('une seule absence ne suffit pas a sauter la revue', () => {
    assert.equal(doitVerifier({ absences: 1, verifie: ilYa(1) }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
});

test('deux absences consecutives et verification recente : la revue est sautee', () => {
    assert.equal(doitVerifier({ absences: 2, verifie: ilYa(3) }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), false);
});

test('au bout d une semaine, la revue absente est reverifiee', () => {
    assert.equal(doitVerifier({ absences: 2, verifie: ilYa(7) }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
    assert.equal(doitVerifier({ absences: 5, verifie: ilYa(10) }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
});

test('une revue qui a des appels actifs n est jamais sautee', () => {
    assert.equal(doitVerifier({ absences: 3, verifie: ilYa(1) }, { appelsActifs: true, force: false, maintenant: MAINTENANT }), true);
});

test('l option de reverification force toutes les revues', () => {
    assert.equal(doitVerifier({ absences: 3, verifie: ilYa(1) }, { appelsActifs: false, force: true, maintenant: MAINTENANT }), true);
});

test('une date de verification illisible fait reverifier', () => {
    assert.equal(doitVerifier({ absences: 3 }, { appelsActifs: false, force: false, maintenant: MAINTENANT }), true);
});

test('une page trouvee remet le compteur d absences a zero', () => {
    assert.deepEqual(noterResultat({ absences: 1, verifie: ilYa(1) }, { page: 'https://p' }, MAINTENANT), { chemin: 'https://p' });
});

test('une absence incremente le compteur, date la verification et oublie le chemin', () => {
    assert.deepEqual(noterResultat({ chemin: 'https://p' }, { motif: 'absent' }, MAINTENANT), { absences: 1, verifie: '2026-09-27' });
    assert.deepEqual(noterResultat({ absences: 1, verifie: ilYa(1) }, { motif: 'absent' }, MAINTENANT), { absences: 2, verifie: '2026-09-27' });
});

test('un blocage ou une erreur reseau ne touche pas l entree', () => {
    const entree = { absences: 1, verifie: ilYa(2) };
    assert.deepEqual(noterResultat(entree, { motif: 'bloque' }, MAINTENANT), entree);
    assert.deepEqual(noterResultat({ chemin: 'u' }, { motif: 'reseau' }, MAINTENANT), { chemin: 'u' });
});

// Journal of Organizational Behavior publie ses appels a
// /journal/{id}/call-for-papers (singulier, sans /page/ ni /homepage/) :
// 5 appels ouverts le 2026-09-27, alors que la revue passait pour absente.
test('le chemin /journal/{id}/call-for-papers fait partie des candidats', () => {
    const urls = build_urls('1099-1379');
    assert.ok(urls.includes('https://onlinelibrary.wiley.com/journal/10991379/call-for-papers'));
    assert.ok(urls.includes('https://onlinelibrary.wiley.com/journal/10991379/calls-for-papers'), 'la variante au pluriel reste essayee');
    assert.equal(new Set(urls).size, urls.length, 'aucun candidat en double');
});

test('les candidats utilisent l ISSN sans tiret et en minuscules', () => {
    assert.ok(build_urls('1475-679X').every(url => url.includes('/1475679x/')));
});

// Revues servies par un sous-domaine societe (constat du 2026-09-27) : leur
// page d'accueil redirige vers {societe}.onlinelibrary.wiley.com, ou les
// pages d'appels vivent sous /hub/journal/{id}/..., un prefixe que l'hote
// principal ne redirige pas (404). Neuf revues passaient pour absentes.

test('la page societe connue passe en tete des candidats', () => {
    const urls = build_urls('1464-0597');
    assert.equal(urls[0], 'https://iaap-journals.onlinelibrary.wiley.com/hub/journal/14640597/homepage/call-for-papers');
    assert.equal(urls.length, new Set(urls).size);
});

test('une revue sans page societe garde ses seuls candidats', () => {
    assert.ok(build_urls('1099-1379').every(url => url.startsWith('https://onlinelibrary.wiley.com/')));
});

test('les pages societe designent les trois revues IAAP et BERA', () => {
    assert.deepEqual(Object.keys(PAGES_SOCIETE).sort(), ['1464-0597', '1467-8535', '1469-3518']);
});

test('un sous-domaine societe se reconnait a son hote', () => {
    assert.equal(estSousDomaineSociete('https://sms.onlinelibrary.wiley.com/hub/call-for-papers/x'), true);
    assert.equal(estSousDomaineSociete('https://onlinelibrary.wiley.com/journal/10970266'), false);
    assert.equal(estSousDomaineSociete('https://example.org/onlinelibrary.wiley.com'), false);
    assert.equal(estSousDomaineSociete('pas une url'), false);
});

// Page commune de la Strategic Management Society : les appels de SMJ, SEJ
// et GSJ sur une seule page. Chaque appel est rattache par le debut de son
// titre, jamais par son slug : le 2026-09-27, l'appel SEJ « Mobilizing,
// Organizing, and Exploiting Entrepreneurial Judgment » avait pour URL
// .../smj-judgment-ecosystems.

const TABLE_SMS = PAGE_COMMUNE_SMS.revues;

test('la table SMS couvre les trois revues de la societe', () => {
    assert.deepEqual(TABLE_SMS.map(r => r.issn).sort(), ['1097-0266', '1932-443X', '2042-5805']);
});

test('chaque prefixe de titre designe l ISSN de sa revue', () => {
    assert.equal(revueParTitre('Strategic Management Journal Special Issue: X', TABLE_SMS), '1097-0266');
    assert.equal(revueParTitre('Strategic Entrepreneurship Journal Special Issue: X', TABLE_SMS), '1932-443X');
    assert.equal(revueParTitre('Global Strategy Journal Special Issue: X', TABLE_SMS), '2042-5805');
});

test('le rattachement ignore la casse et les espaces', () => {
    assert.equal(revueParTitre('  GLOBAL   STRATEGY JOURNAL: call', TABLE_SMS), '2042-5805');
});

test('un titre de revue inconnue ou un prefixe partiel ne rattache rien', () => {
    assert.equal(revueParTitre('SMJ Special Issue: X', TABLE_SMS), null, 'pas de sigle');
    assert.equal(revueParTitre('Strategic Management Journals roundup', TABLE_SMS), null, 'limite de mot');
    assert.equal(revueParTitre('Special Issue in Strategic Management Journal', TABLE_SMS), null, 'prefixe seulement');
    assert.equal(revueParTitre('', TABLE_SMS), null);
    assert.equal(revueParTitre(null, TABLE_SMS), null);
});

const HUB_SMS = 'https://sms.onlinelibrary.wiley.com/hub/call-for-papers/';
const itemSms = (slug, revue, sujet) => `<div class="DST-CFP-listing-item"><h3><a href="/hub/call-for-papers/${slug}" target="_blank"><em>${revue}</em> Special Issue: ${sujet}</a></h3>
    <p class="DST-CFP-listing-item__deadline"><strong>Deadline for Submissions</strong>: 1 March 2027</p>
    <a href="/hub/call-for-papers/${slug}" class="DST-CFP-listing-item__more">More information available here</a></div>`;
const pageSms = items => `<div class="DST-CFP-listing-item DST-CFP-listing-item--intro"><h2>Calls for Papers</h2><p>This page is dedicated to our current Calls for Papers.</p></div>${items.join('')}`;
const REVUES_CSV = [
    { issn: '1097-0266', nomOpenalex: 'Strategic Management Journal' },
    { issn: '1932-443X', nomOpenalex: 'Strategic Entrepreneurship Journal' },
    { issn: '2042-5805', nomOpenalex: 'Global Strategy Journal' },
];

test('la page commune rattache chaque appel a sa revue, slug trompeur compris', () => {
    const html = pageSms([
        itemSms('smj-judgment-ecosystems', 'Strategic Entrepreneurship Journal', 'Mobilizing Entrepreneurial Judgment'),
        itemSms('gsj-ai-global-advantage', 'Global Strategy Journal', 'Globalizing Intelligence'),
    ]);
    const { appels, ecartes } = rattacherAppelsCommuns(extract_entries(html, HUB_SMS, 'SMS'), TABLE_SMS, REVUES_CSV);
    assert.deepEqual(appels.map(a => [a.issn, a.journal]), [
        ['1932-443X', 'Strategic Entrepreneurship Journal'],
        ['2042-5805', 'Global Strategy Journal'],
    ]);
    assert.equal(appels[0].url, 'https://sms.onlinelibrary.wiley.com/hub/call-for-papers/smj-judgment-ecosystems');
    assert.deepEqual(ecartes, []);
});

test('un appel dont la revue n est pas reconnue est ecarte, pas devine', () => {
    const html = pageSms([itemSms('sms-conference', 'SMS Annual Conference', 'Call for Proposals')]);
    const { appels, ecartes } = rattacherAppelsCommuns(extract_entries(html, HUB_SMS, 'SMS'), TABLE_SMS, REVUES_CSV);
    assert.deepEqual(appels, []);
    assert.deepEqual(ecartes, ['SMS Annual Conference Special Issue: Call for Proposals']);
});

test('une revue de la table absente du CSV fait ecarter ses appels', () => {
    const html = pageSms([itemSms('smj-x', 'Strategic Management Journal', 'X')]);
    const { appels, ecartes } = rattacherAppelsCommuns(extract_entries(html, HUB_SMS, 'SMS'), TABLE_SMS, REVUES_CSV.slice(1));
    assert.deepEqual(appels, []);
    assert.equal(ecartes.length, 1);
});

// Les blocs de liste des pages societe ne portent que le titre et une
// echeance, parfois trompeuse : sur Applied Psychology, « 1 April and 30 May
// 2027 » est la fenetre de l'atelier, la page de detail annonce des
// soumissions du 1er octobre au 30 novembre 2027. Le texte de l'appel est
// le plus long bloc .pb-rich-text de la page de detail ; les autres sont des
// menus de la societe.

test('le detail d un appel est le plus long bloc de texte riche', () => {
    const html = `<main id="main-content">
        <div class="pb-rich-text"><p>Resources About Us Join SMS</p></div>
        <div class="pb-rich-text"><h3>Strategic Entrepreneurship Journal: Call for Papers</h3><p>${'Background text. '.repeat(30)}</p><p>Submission Deadline: March 31, 2027</p></div>
    </main>`;
    const detail = extraire_detail(html);
    assert.match(detail, /^<div class="pb-rich-text"><h3>Strategic Entrepreneurship Journal/);
    assert.match(detail, /March 31, 2027/);
    assert.doesNotMatch(detail, /Join SMS/);
});

test('une page de detail sans texte substantiel ne rend rien', () => {
    assert.equal(extraire_detail('<div class="pb-rich-text"><p>Error 404</p></div>'), null);
    assert.equal(extraire_detail('<main><p>rien</p></main>'), null);
});

// Une page d'accueil qui redirige vers un sous-domaine absent des tables
// signale une revue a ajouter a PAGES_SOCIETE.

test('l hote principal n appelle aucun signalement', () => {
    assert.equal(classerRedirection('1099-1379', 'onlinelibrary.wiley.com'), null);
    assert.equal(classerRedirection('1099-1379', null), null);
});

test('un sous-domaine inconnu est a completer', () => {
    assert.equal(classerRedirection('1234-5678', 'nouvelle-societe.onlinelibrary.wiley.com'), 'a-completer');
});

test('une page societe connue devenue introuvable est aussi a completer', () => {
    assert.equal(classerRedirection('1464-0597', 'iaap-journals.onlinelibrary.wiley.com'), 'a-completer');
});

test('un sous-domaine verifie sans page d appels est connu', () => {
    assert.equal(classerRedirection('2044-8325', 'bpspsychub.onlinelibrary.wiley.com'), 'connu-sans-appels');
    assert.equal(classerRedirection('2044-8325', 'autre.onlinelibrary.wiley.com'), 'a-completer', 'hote change');
});

test('le bilan chiffre la page commune et signale les sous-domaines a completer', () => {
    const bilan = formaterBilan({
        total: 10, atteintes: 6, avecAppels: 4, appels: 12, requetes: 15,
        motifs: { bloque: 0, absent: 1, reseau: 0, autre: 0 },
        commune: { appels: 5, ecartes: 1, bloquee: false },
        details: { page: 7, pdf: 2, liste: 3, echecs: 1 },
        sousDomaines: [{ issn: '1234-5678', hote: 'x.onlinelibrary.wiley.com' }],
    });
    assert.match(bilan, /page commune SMS\s+5 appel\(s\), 1 ecarte/);
    assert.match(bilan, /sources lues\s+7 page\(s\) de detail, 2 PDF, 3 bloc\(s\) de liste ; 1 echec/);
    assert.match(bilan, /1234-5678.*x\.onlinelibrary\.wiley\.com/);
});

// Gabarit .DST-CFP-listing-item de l'hote principal : le bloc de liste ne
// porte que le titre et une echeance. Audit du 2026-09-27 : 72 appels actifs,
// rawContent median de 294 caracteres, 54 sans description, 72 sans editeurs.
// La source du rawContent suit le type du lien, et lui seul : page Wiley ->
// page de detail, PDF Wiley -> texte du PDF, autre site -> bloc de liste.

test('la source du rawContent se lit sur le seul lien', () => {
    assert.equal(sourceDuLien('https://onlinelibrary.wiley.com/page/journal/14680394/homepage/call-for-papers/si-2026-001060'), 'page');
    assert.equal(sourceDuLien('https://sms.onlinelibrary.wiley.com/hub/call-for-papers/sej-x'), 'page-societe');
    assert.equal(sourceDuLien('https://onlinelibrary.wiley.com/pb-assets/assets/10991379/cfp/JOB_CFP-1787185890970.pdf'), 'pdf');
    assert.equal(sourceDuLien('https://onlinelibrary.wiley.com/pb-assets/IOECPR%20-%20MDE%20CFP-1667224224133.PDF'), 'pdf');
    assert.equal(sourceDuLien('https://www.bam.ac.uk/cfp'), 'liste');
    assert.equal(sourceDuLien('https://www.example.org/cfp.pdf'), 'liste', 'un PDF hors Wiley reste un lien externe');
    assert.equal(sourceDuLien('pas une url'), 'liste');
});

const PAGE_LISTE = 'https://onlinelibrary.wiley.com/page/journal/14680394/homepage/call-for-papers';
const itemListe = href => `<div class="DST-CFP-listing-item"><h3><a href="${href}">Special issue X</a></h3>
    <p class="DST-CFP-listing-item__deadline"><strong>Deadline</strong>: 31 January 2027</p></div>`;

test('les entrees du gabarit de liste sont marquees comme telles', () => {
    const [entry] = extract_entries(itemListe('/page/journal/14680394/homepage/call-for-papers/si-1'), PAGE_LISTE, 'ES');
    assert.equal(entry.gabarit, 'liste');
    const [ancien] = extract_entries(`<div class="pb-rich-text"><h2>Call for Papers</h2><p><a href="/page/journal/14680394/homepage/si.htm">SI</a></p></div>`, PAGE_LISTE, 'ES');
    assert.equal(ancien.gabarit, undefined);
});

test('on suit les liens du gabarit de liste et ceux des sous-domaines, pas l ancien gabarit', () => {
    assert.equal(doitSuivre(PAGE_LISTE, { gabarit: 'liste' }), true);
    assert.equal(doitSuivre(PAGE_LISTE, {}), false, 'ancien gabarit : son groupe porte deja le texte, son hash ne bouge pas');
    assert.equal(doitSuivre('https://iaap-journals.onlinelibrary.wiley.com/hub/journal/14640597/homepage/call-for-papers', {}), true);
});

// Regle de stabilite : une source prevue et illisible ne retombe jamais sur
// le bloc de liste. Le repli ferait alterner deux rawContent d'un run a
// l'autre -- deux hashes, une reextraction payante a chaque bascule, et des
// champs vides a chaque retour au bloc de liste. L'appel est ecarte, sa revue
// passe dans issnBloques et l'appel en base est preserve tel quel.

const ENTREE = { metaTitle: 'SI', url: 'https://onlinelibrary.wiley.com/page/journal/14680394/homepage/call-for-papers/si-1', rawContent: '<div>bloc de liste</div>', gabarit: 'liste' };

test('une source lue remplace le rawContent', () => {
    assert.deepEqual(resoudreEntree(ENTREE, 'page', '<div>texte complet</div>'), { entry: { ...ENTREE, rawContent: '<div>texte complet</div>' } });
    assert.deepEqual(resoudreEntree(ENTREE, 'pdf', 'texte du pdf'), { entry: { ...ENTREE, rawContent: 'texte du pdf' } });
});

test('une source prevue et illisible preserve l appel, sans repli sur le bloc de liste', () => {
    for (const source of ['page', 'page-societe', 'pdf']) {
        assert.deepEqual(resoudreEntree(ENTREE, source, null), { preserver: true }, source);
        assert.deepEqual(resoudreEntree(ENTREE, source, ''), { preserver: true }, `${source}, texte vide`);
    }
});

test('un lien externe garde le bloc de liste, sans rien lire', () => {
    assert.deepEqual(resoudreEntree(ENTREE, 'liste', null), { entry: ENTREE });
});

// Page de detail de l'hote principal : le texte de l'appel est dans
// .publications-page-body .main-content, avec ou sans .pb-rich-text
// (Expert Systems et Journal of Business Logistics n'en ont pas). Mesure sur
// 69 pages : quand un .pb-rich-text existe, ce conteneur en a exactement le
// texte ; la barre laterale (alertes courriel) est hors du conteneur.

const pageDetail = corps => `<div class="publications-page-body"><div class="container"><div class="row"><div class=" col-md-12">
    <div class="gutterless--md main-content col-md-8">${corps}</div>
    <div class="gutterless--md col-md-4"><div class="journal-sidebar">Sign up for email alerts</div></div>
    </div></div></div></div>`;
const TEXTE = `<h2>Call for Papers</h2><h3>LLMs and Agentic AI in Healthcare</h3><p>Submission deadline: Sunday, 31 January 2027</p><p>${'Theme text. '.repeat(30)}</p>`;

test('le detail de l hote principal se lit sans .pb-rich-text', () => {
    const detail = extraire_detail_page(pageDetail(TEXTE));
    assert.match(detail, /31 January 2027/);
    assert.doesNotMatch(detail, /email alerts/);
});

test('le detail de l hote principal a le meme texte avec .pb-rich-text', () => {
    const avec = extraire_detail_page(pageDetail(`<div class="pb-rich-text">${TEXTE}</div>`));
    assert.match(avec, /LLMs and Agentic AI in Healthcare/);
});

test('les scripts du conteneur ne passent pas dans le rawContent', () => {
    assert.doesNotMatch(extraire_detail_page(pageDetail(`${TEXTE}<script>googletag.cmd.push()</script>`)), /googletag/);
});

test('une page de detail sans conteneur ou sans texte ne rend rien', () => {
    assert.equal(extraire_detail_page('<main><p>Error 404</p></main>'), null);
    assert.equal(extraire_detail_page(pageDetail('<p>Court</p>')), null);
});
