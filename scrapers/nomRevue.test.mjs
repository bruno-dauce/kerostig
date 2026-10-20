import test from 'node:test';
import assert from 'node:assert/strict';

import { nomAffichageRevue } from './nomRevue.mjs';

const journals = { '1873-7706': { titre: 'Transportation Research Part D Transport and Environment' } };

test('le nom vient de journals.json par ISSN, pas du libelle du scraper', () => {
    const call = { issn: '1873-7706', journal: 'Transportation Research Part D: Transport and Environment' };
    assert.equal(nomAffichageRevue(call, journals), 'Transportation Research Part D Transport and Environment');
});

test('repli sur le libelle du scraper quand la jointure echoue', () => {
    assert.equal(nomAffichageRevue({ issn: '0000-0000', journal: 'Revue X' }, journals), 'Revue X');
    assert.equal(nomAffichageRevue({ journal: 'Revue X' }, journals), 'Revue X');
    assert.equal(nomAffichageRevue({ issn: '1873-7706', journal: 'Revue X' }, null), 'Revue X');
});

test('un titre vide dans journals.json ne masque pas le libelle', () => {
    assert.equal(nomAffichageRevue({ issn: 'A', journal: 'Revue X' }, { A: { titre: '  ' } }), 'Revue X');
});

test('aucune donnee, chaine vide', () => {
    assert.equal(nomAffichageRevue({}, {}), '');
});
