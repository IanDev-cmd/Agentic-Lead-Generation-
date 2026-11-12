const STEMS = {
  linkedin: ['companies', 'startups', 'founders', 'head of sales', 'partnerships'],
  social: ['companies', 'founders', 'creators', 'community', 'product launch'],
};

const SOCIAL_PLATFORMS = ['X', 'Instagram', 'YouTube', 'Reddit', 'Facebook'];

export function keywordPlan(query, channel) {
  const topic = String(query || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const stems = STEMS[channel] || STEMS.linkedin;
  if (!topic) return [];
  return stems.map((stem) => `${topic} ${stem}`);
}

export function agentPrompt(query, channel, profile) {
  const keywords = keywordPlan(query, channel);
  const where = channel === 'social'
    ? `Other public social platforms only: ${SOCIAL_PLATFORMS.join(', ')}. Do not use LinkedIn.`
    : 'Public LinkedIn company pages and public LinkedIn people pages only.';
  const business = [
    profile?.SELLER_NAME ? `Business: ${profile.SELLER_NAME}` : '',
    profile?.SELLER_OFFERING ? `Offering: ${profile.SELLER_OFFERING}` : '',
    profile?.TARGET_INDUSTRY ? `Industry: ${profile.TARGET_INDUSTRY}` : '',
    profile?.TARGET_REGION ? `Region: ${profile.TARGET_REGION}` : '',
  ].filter(Boolean).join('\n');
  return [
    'You are a read-only research agent on the lead desk.',
    'Run each keyword below as its own Google search. Keep companies and people that match the topic.',
    where,
    'Do not log into an account. Do not send a message, a connection request, a follow, a like, or a post. Do not invent an email, a phone number, or a page you did not open.',
    business,
    `Topic: ${query}`,
    'Keyword searches:',
    ...keywords.map((keyword, index) => `${index + 1}. ${keyword}`),
    'Reply in this exact shape:',
    'EXPLANATION:',
    'Which searches returned companies or people, in a short paragraph.',
    'RESULTS:',
    '| Kind | Name | Role | Platform | Url | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    'Kind is Company or Person. Url is the public page. Note is one public fact from that page. Leave a cell blank when the page did not say it.',
  ].filter(Boolean).join('\n');
}

function splitRow(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

export function parseAgentAnswer(text) {
  const raw = String(text || '');
  const explanationMatch = raw.match(/EXPLANATION:\s*([\s\S]*?)(?:\n\s*RESULTS:|$)/i);
  const explanation = (explanationMatch ? explanationMatch[1] : raw).trim().slice(0, 2000);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|'));
  const companies = [];
  const people = [];
  if (lines.length >= 2) {
    const headers = splitRow(lines[0]);
    const column = (label) => headers.findIndex((cell) => cell.toLowerCase().includes(label));
    const cols = {
      kind: column('kind'),
      name: column('name'),
      role: column('role'),
      platform: column('platform'),
      url: column('url'),
      note: column('note'),
    };
    const take = (cells, key) => (cols[key] >= 0 ? (cells[cols[key]] || '') : '');
    for (const line of lines.slice(1)) {
      const cells = splitRow(line);
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      const name = take(cells, 'name');
      if (!name) continue;
      const row = {
        name,
        role: take(cells, 'role'),
        platform: take(cells, 'platform'),
        url: take(cells, 'url'),
        note: take(cells, 'note'),
      };
      const kind = take(cells, 'kind').toLowerCase();
      if (kind.startsWith('person') || kind.startsWith('people')) people.push(row);
      else companies.push(row);
    }
  }
  return {
    explanation,
    companies: companies.slice(0, 12),
    people: people.slice(0, 12),
  };
}

function responseText(response) {
  try {
    return String(response?.text || '');
  } catch {
    return '';
  }
}

export async function runAgentSearch({ apiKey, model, query, channel, profile }) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const keywords = keywordPlan(query, channel);
  const content = [{ text: agentPrompt(query, channel, profile) }];
  let lastError = '';
  for (const tools of [[{ googleSearch: {} }], []]) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: content }],
        config: tools.length ? { tools } : undefined,
      });
      const text = responseText(response);
      if (text.trim()) {
        const parsed = parseAgentAnswer(text);
        return { ...parsed, keywords };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Gemini refused the request.';
    }
  }
  throw new Error(lastError || 'Gemini returned no text. Nothing was saved.');
}

export function companyLeads(companies, channel) {
  return companies.map((row) => ({
    company: row.name,
    website: row.url,
    source: row.url || (channel === 'social' ? 'Social search' : 'LinkedIn search'),
    pain: row.note,
    priority: 'Low',
    hook: '',
    email: '',
  }));
}
