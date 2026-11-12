import assert from 'node:assert/strict';
import test from 'node:test';
import { keywordPlan, parseAgentAnswer } from '../lib/agents.js';

test('an edtech query becomes several company and people searches', () => {
  const linkedin = keywordPlan('ed tech', 'linkedin');
  const social = keywordPlan('edtech', 'social');
  assert.equal(linkedin.length, 5);
  assert.equal(social.length, 5);
  assert.ok(linkedin.some((keyword) => /companies/i.test(keyword) && /ed tech/i.test(keyword)));
  assert.ok(linkedin.some((keyword) => /founders/i.test(keyword)));
  assert.ok(social.some((keyword) => /creators/i.test(keyword)));
  assert.deepEqual(keywordPlan('   ', 'linkedin'), []);
});

test('agent rows split companies from people and drop a blank name', () => {
  const parsed = parseAgentAnswer([
    'EXPLANATION:',
    'Five searches, two matches.',
    'RESULTS:',
    '| Kind | Name | Role | Platform | Url | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    '| Company | Northstar Learn |  | LinkedIn | https://www.linkedin.com/company/northstar | Sells classroom software |',
    '| Person | Ada Mensah | Founder | LinkedIn | https://www.linkedin.com/in/ada | Founded a tutoring network |',
    '| Person |  |  |  |  |  |',
  ].join('\n'));
  assert.match(parsed.explanation, /Five searches/);
  assert.equal(parsed.companies.length, 1);
  assert.equal(parsed.companies[0].name, 'Northstar Learn');
  assert.equal(parsed.people.length, 1);
  assert.equal(parsed.people[0].role, 'Founder');
});
