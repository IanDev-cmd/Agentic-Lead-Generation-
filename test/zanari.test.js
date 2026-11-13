import assert from 'node:assert/strict';
import test from 'node:test';
import { zanariLeads } from '../lib/zanari-leads.js';

test('the Zanari profile seeds twenty Nairobi leads', () => {
  const leads = zanariLeads();
  assert.equal(leads.length, 20);
  assert.equal(leads[0].company, 'Diamond Trust Bank');
  assert.equal(leads[0].contact, 'Philip G.');
  assert.equal(leads[0].priority, 'High');
  assert.equal(leads[12].company, 'ARN Security Consultants and Training Services LTD');
  assert.equal(leads.every((lead) => lead.hook && lead.hq && lead.interactionId === 'zanari-analytics'), true);
});

test('the desk stores the Zanari batch', async () => {
  const previous = process.env.DESK_TOKEN;
  process.env.DESK_TOKEN = 'zanari-desk-token';
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/zanari`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'desk=zanari-desk-token' },
      body: '{}',
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.leads.length, 20);
    assert.equal(body.leads.some((lead) => lead.company === 'Safaricom PLC'), true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous == null) delete process.env.DESK_TOKEN;
    else process.env.DESK_TOKEN = previous;
  }
});
