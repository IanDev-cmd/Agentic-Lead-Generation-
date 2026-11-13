import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_WEBHOOK_URL, agentRequest, leadsFromAgent, postAgentWebhook } from '../lib/agent-webhook.js';

test('agent requests keep the question, profile, and readable files', () => {
  const payload = agentRequest({
    input: 'ask',
    question: '  edtech buyers  ',
    sellerName: 'North Desk',
    maxLeads: '8',
    sources: [
      { name: 'notes.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') },
      { name: 'empty.txt', mime: 'text/plain', data: '%%%' },
    ],
  });
  assert.equal(payload.input, 'ask');
  assert.equal(payload.question, 'edtech buyers');
  assert.equal(payload.profile.sellerName, 'North Desk');
  assert.equal(payload.profile.maxLeads, 8);
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].name, 'notes.txt');
  assert.equal(payload.sources[0].kind, 'File');
});

test('studio reads the desk lead envelope', () => {
  const found = leadsFromAgent({
    ok: true,
    explanation: 'Twelve school-software buyers.',
    leads: [{
      company: 'Acme Learning',
      domain: 'acme.example',
      website: 'https://acme.example',
      hq: 'Nairobi',
      contact: 'Ada Lovelace',
      title: 'Head of Ops',
      email: 'ada@acme.example',
      pain: 'Public hiring page',
      hook: 'Their hiring page matches the offer.',
      priority: 'High',
      source: 'https://acme.example/about',
    }],
  });
  assert.equal(found.explanation, 'Twelve school-software buyers.');
  assert.equal(found.leads[0].company, 'Acme Learning');
  assert.equal(found.leads[0].priority, 'High');
  assert.equal(found.leads[0].website, 'https://acme.example');
});

test('webhook leads accept n8n items and field aliases', () => {
  const found = leadsFromAgent([
    { json: { companyName: 'Acme', painPoint: 'Hiring', contactEmail: 'ada@acme.com', priority: 'high', hook: 'Hiring page' } },
  ]);
  assert.equal(found.leads.length, 1);
  assert.equal(found.leads[0].company, 'Acme');
  assert.equal(found.leads[0].email, 'ada@acme.com');
  assert.equal(found.leads[0].pain, 'Hiring');
  assert.equal(found.leads[0].priority, 'High');
});

test('the agent webhook posts only to the lead url', async () => {
  let seen = null;
  const payload = agentRequest({
    input: 'sources',
    sources: [{ name: 'brief.pdf', mime: 'application/pdf', data: Buffer.from('%PDF').toString('base64') }],
  });
  const result = await postAgentWebhook(payload, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            explanation: 'One buyer.',
            leads: [{ company: 'Acme', hook: 'Hiring page', priority: 'High' }],
          });
        },
      };
    },
  });
  assert.equal(seen.url, AGENT_WEBHOOK_URL);
  assert.equal(seen.url, 'https://proxyproxy.app.n8n.cloud/webhook/multimodal-lead-gen');
  assert.equal(seen.init.method, 'POST');
  const sent = JSON.parse(seen.init.body);
  assert.equal(sent.input, 'sources');
  assert.equal(sent.sources[0].name, 'brief.pdf');
  assert.equal(result.ok, true);
  assert.equal(result.leads[0].company, 'Acme');
});

test('an empty agent question is refused before the webhook', async () => {
  const previous = process.env.DESK_TOKEN;
  process.env.DESK_TOKEN = 'agent-desk-token';
  const { createDeskServer } = await import('../server.js');
  const server = createDeskServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'desk=agent-desk-token',
      },
      body: JSON.stringify({ input: 'ask', question: '   ' }),
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (previous == null) delete process.env.DESK_TOKEN;
    else process.env.DESK_TOKEN = previous;
  }
});
