import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fromRubric, toRubric } from '../src/roles.ts';

const CRITERIA = ['Covers pricing', 'Under 300 words'];
const item = (criterion: string, met: boolean, evidence = '') => ({ criterion, met, evidence });

describe('reviewer rubric: the model judges each criterion, code decides', () => {
  test('items match criteria by text or number, in any order', () => {
    const byText = toRubric(CRITERIA, [item('under 300 words', true, '250 words'), item('Covers pricing', false, 'no prices')]);
    assert.deepEqual(byText, [
      { criterion: 'Covers pricing', met: false, note: 'no prices' },
      { criterion: 'Under 300 words', met: true, note: '250 words' },
    ]);
    assert.deepEqual(toRubric(CRITERIA, [item('2', true, 'ok'), item('1. Covers pricing', false, 'no')]), [
      { criterion: 'Covers pricing', met: false, note: 'no' },
      { criterion: 'Under 300 words', met: true, note: 'ok' },
    ]);
  });

  test('a reworded item never borrows another criterion\'s verdict: the reviewer is asked again', () => {
    // One item names criterion 2; the other is reworded. A positional guess would pass "Covers pricing".
    const r = toRubric(CRITERIA, [item('Under 300 words', true, '250 words'), item('Mentions pricing', false, 'no prices')]);
    assert.equal(typeof r, 'string');
    assert.match(r as string, /Not judged exactly once: "Covers pricing"/);
    // Two items for the same criterion.
    assert.match(toRubric(CRITERIA, [item('Covers pricing', true), item('1', false, 'x')]) as string, /"Covers pricing", "Under 300 words"/);
    assert.match(toRubric(CRITERIA, [item('Covers pricing', true)]) as string, /exactly 2 criteria items/);
    assert.match(toRubric(CRITERIA, 'yes') as string, /no "criteria" list/);
    // A malformed item is not dropped: it may be the one that said "not met".
    assert.match(toRubric(CRITERIA, [item('Covers pricing', true), { criterion: 'Under 300 words', met: 'false' }, item('Under 300 words', true)]) as string, /needs "criterion".*"met" \(true or false\)/);
  });

  test('when no item names a criterion, they are taken in order', () => {
    assert.deepEqual(toRubric(CRITERIA, [item('pricing', true, 'a'), item('length', false)]), [
      { criterion: 'Covers pricing', met: true, note: 'a' },
      { criterion: 'Under 300 words', met: false, note: 'not met (the reviewer gave no detail)' },
    ]);
  });

  test('passed means every criterion met; the score is the share met; feedback names what is missing', () => {
    const rubric = [{ criterion: 'Covers pricing', met: false, note: 'no prices' }, { criterion: 'Under 300 words', met: true }];
    assert.deepEqual(fromRubric(rubric, 'Add a table.'), {
      passed: false,
      score: 0.5,
      feedback: 'Not met:\n- Covers pricing: no prices\n\nAdd a table.',
      rubric,
    });
    assert.deepEqual(fromRubric([{ criterion: 'Covers pricing', met: true }], ' Good. '), { passed: true, score: 1, feedback: 'Good.', rubric: [{ criterion: 'Covers pricing', met: true }] });
  });
});
