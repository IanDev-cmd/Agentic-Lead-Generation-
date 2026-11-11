const HEADER = '| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |';

export function parseLeadAnswer(text) {
  const raw = String(text || '');
  const explanationMatch = raw.match(/EXPLANATION:\s*([\s\S]*?)(?:\n\s*LEADS:|$)/i);
  const explanation = (explanationMatch ? explanationMatch[1] : raw).trim().slice(0, 2000);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('|'));
  const leads = [];
  if (lines.length >= 2) {
    const headers = splitRow(lines[0]);
    const column = (label) => headers.findIndex((cell) => cell.toLowerCase().includes(label));
    const cols = {
      company: column('company'),
      domain: column('domain'),
      hq: column('hq'),
      contact: column('contact name'),
      title: column('contact title'),
      email: column('email'),
      pain: column('pain'),
      hook: column('hook'),
      priority: column('priority'),
      source: column('source'),
    };
    for (const line of lines.slice(1)) {
      const cells = splitRow(line);
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      const company = cells[cols.company] || '';
      if (!company) continue;
      let email = cells[cols.email] || '';
      if (!email.includes('@') || /unknown|n\/a|none|not on file|no public/i.test(email)) email = '';
      const priority = /high/i.test(cells[cols.priority] || '') && (cells[cols.hook] || '').trim() ? 'High' : 'Low';
      leads.push({
        company,
        domain: cells[cols.domain] || '',
        hq: cells[cols.hq] || '',
        contact: cells[cols.contact] || '',
        title: cells[cols.title] || '',
        email,
        pain: cells[cols.pain] || '',
        hook: priority === 'High' ? (cells[cols.hook] || '') : '',
        priority,
        source: cells[cols.source] || '',
      });
    }
  }
  return { explanation, leads: leads.slice(0, 15) };
}

export function askPrompt(question, profile) {
  const business = [
    profile.SELLER_NAME ? `Business: ${profile.SELLER_NAME}` : '',
    profile.SELLER_OFFERING ? `Offering: ${profile.SELLER_OFFERING}` : '',
    profile.TARGET_INDUSTRY ? `Industry: ${profile.TARGET_INDUSTRY}` : '',
    profile.TARGET_REGION ? `Region: ${profile.TARGET_REGION}` : '',
    profile.IDEAL_CUSTOMER_PROFILE ? `Ideal customer: ${profile.IDEAL_CUSTOMER_PROFILE}` : '',
  ].filter(Boolean).join('\n');
  return [
    'You are the lead desk. Read the attached sources. Use Google Search only to check a public fact that the sources point at.',
    'When a source is a web URL, read that page. When a source is a table, you may run code to count rows. Do not invent an email address, a phone number, or a fact that is not in the sources or a search result.',
    'A draft is not an email. Do not say anything was sent.',
    business,
    `Question: ${question}`,
    'Reply in this exact shape:',
    'EXPLANATION:',
    'A short paragraph naming which sources you used.',
    'LEADS:',
    HEADER,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    'One row per company. Contact Email stays blank when the source has no email. Priority is High only when the source contains a concrete pain and a hook. Otherwise Priority is Low and Hook is blank.',
  ].filter(Boolean).join('\n');
}

export async function askSources({ apiKey, model, question, profile, parts, urls, tabular }) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const content = [{ text: askPrompt(question, profile) }, ...parts];
  const toolSets = [];
  const rich = [{ googleSearch: {} }];
  if (urls) rich.push({ urlContext: {} });
  if (tabular) rich.push({ codeExecution: {} });
  toolSets.push(rich);
  if (rich.length > 1) toolSets.push([{ googleSearch: {} }]);
  toolSets.push([]);
  let lastError = '';
  for (const tools of toolSets) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: content }],
        config: tools.length ? { tools } : undefined,
      });
      const text = responseText(response);
      if (text.trim()) return parseLeadAnswer(text);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Gemini refused the request.';
    }
  }
  throw new Error(lastError || 'Gemini returned no text. Nothing was written to Sheets.');
}

function responseText(response) {
  try {
    return String(response?.text || '');
  } catch {
    return '';
  }
}

function splitRow(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}
