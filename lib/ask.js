const HEADER = '| Company | Domain | Website | HQ Address | Lat | Lng | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |';

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
      website: column('website'),
      hq: column('hq'),
      lat: column('lat'),
      lng: column('lng'),
      contact: column('contact name'),
      title: column('contact title'),
      email: column('email'),
      pain: column('pain'),
      hook: column('hook'),
      priority: column('priority'),
      source: column('source'),
    };
    const take = (cells, key) => (cols[key] >= 0 ? (cells[cols[key]] || '') : '');
    for (const line of lines.slice(1)) {
      const cells = splitRow(line);
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      const company = take(cells, 'company');
      if (!company) continue;
      let email = take(cells, 'email');
      if (!email.includes('@') || /unknown|n\/a|none|not on file|no public/i.test(email)) email = '';
      const latText = take(cells, 'lat');
      const lngText = take(cells, 'lng');
      const lat = Number(latText);
      const lng = Number(lngText);
      const priority = /high/i.test(take(cells, 'priority')) && take(cells, 'hook').trim() ? 'High' : 'Low';
      leads.push({
        company,
        domain: take(cells, 'domain'),
        website: take(cells, 'website'),
        hq: take(cells, 'hq'),
        lat: latText && Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
        lng: lngText && Number.isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
        contact: take(cells, 'contact'),
        title: take(cells, 'title'),
        email,
        pain: take(cells, 'pain'),
        hook: priority === 'High' ? take(cells, 'hook') : '',
        priority,
        source: take(cells, 'source'),
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
  const requested = Number(profile.MAX_LEADS);
  const cap = requested === 4 || requested === 8 || requested === 15 ? requested : 10;
  return [
    'You are the lead desk. Sources may be text, a PDF, a spreadsheet, a web page, or an image. Read every attached source, including images.',
    'If the source is already a company, research that company. If the source is a product, a place, or a scene rather than a company list, say in EXPLANATION how that input becomes a business or startup, then put the real companies that make, sell, distribute, or marketplace that thing in the LEADS table. A photo of an electric scooter becomes a short business explanation plus scooter makers and marketplaces, not a description of the photo.',
    'Use Google Search to open each company\'s public website, headquarters, and contact page. Return the company cap below. The default batch is 10 companies. Every row needs a real public website domain. Include decimal latitude and longitude for the public headquarters when a page states the address.',
    'Search for a public contact email on the company site. Do not invent an email address, a phone number, a logo, or a fact that is not in the sources or a page you opened. Leave Contact Email blank when no public email is on file. Logo can be blank; the desk fills an icon from the domain.',
    'When a source is a web URL, read that page. When a source is a table, you may run code to count rows. A draft is not an email. Do not say anything was sent.',
    business,
    `Company cap: ${cap}`,
    `Question: ${question}`,
    'Reply in this exact shape:',
    'EXPLANATION:',
    'A short paragraph on how the source becomes a business, and which public pages you used.',
    'LEADS:',
    HEADER,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    'One row per company. Website is the official https address. Lat and Lng are decimal degrees, or blank. Contact Email stays blank when no public email was found. Priority is High only when a public page contains a concrete pain and a hook. Otherwise Priority is Low and Hook is blank.',
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
