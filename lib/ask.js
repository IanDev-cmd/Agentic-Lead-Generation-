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
  return { explanation: clipExplanation(explanation), leads: leads.slice(0, 50) };
}

export function leadCap(profile) {
  const requested = Number(profile && profile.MAX_LEADS);
  if (requested === 4 || requested === 8 || requested === 15 || requested === 50) return requested;
  return 50;
}

export function askPrompt(question, profile, sellerMaterial = '') {
  const business = [
    profile.SELLER_NAME ? `Business: ${profile.SELLER_NAME}` : '',
    profile.SELLER_OFFERING ? `Offering: ${profile.SELLER_OFFERING}` : '',
    profile.TARGET_INDUSTRY ? `Industry: ${profile.TARGET_INDUSTRY}` : '',
    profile.TARGET_REGION ? `Region: ${profile.TARGET_REGION}` : '',
    profile.IDEAL_CUSTOMER_PROFILE ? `Ideal customer: ${profile.IDEAL_CUSTOMER_PROFILE}` : '',
  ].filter(Boolean).join('\n');
  const cap = leadCap(profile);
  const material = String(sellerMaterial || '').trim();
  return [
    'You are the lead desk. The question and the seller material are one request. Read the material to learn who we sell for, then carry out the question by searching the public web for buyers. Do not answer the question and the material as two tasks.',
    'Seller material may be written in this request or attached to this same request as a PDF, slide deck, spreadsheet, web page, or image. From that material only, infer the seller: the name, what they sell, and who feels the pains the material already describes.',
    'Do not put the seller in the LEADS table. Do not research the seller as a prospect. The upload is not a lead.',
    'If the material is a company profile, that company is the seller. Buyers are other organisations that could hire them. If the material is a photo of a product, such as a T-shirt, the seller makes or sells that product. Buyers are retailers, brands, teams, and merchandisers who would purchase it. Do not return factories, marketplaces that sell the same product, or a description of the picture.',
    'After the seller is fixed, use Google Search to find real client companies. Do not mine the upload for the company list. The upload only grounds who to look for.',
    `Return up to ${cap} distinct companies. Search Kenya first and fill those rows before any other country. Then search globally. If fewer than ${cap} real buyers are on the open web, return only the real ones.`,
    'Every row needs a real public website. Headquarters, latitude, and longitude only when a public page states them. Search for a public contact email on that buyer\'s site. Do not invent an email address, a phone number, a logo, or a company. Leave Contact Email blank when no public email is on file.',
    'EXPLANATION is two or three sentences. Name the seller, what they sell, and that the table is Kenyan buyers first, then buyers elsewhere, with the count. Do not quote the upload. Do not narrate the search. Do not add news headlines.',
    'A draft is not an email. Do not say anything was sent.',
    business,
    material ? `Seller material:\n${material}` : 'Seller material is attached to this same request.',
    `Question: ${question}`,
    'Reply in this exact shape:',
    'EXPLANATION:',
    'Two or three sentences naming the seller, the offer, and the buyer count.',
    'LEADS:',
    HEADER,
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    'One row per buyer. Website is the official https address. Lat and Lng are decimal degrees, or blank. Contact Email stays blank when no public email was found. Pain Point is a public fact about that buyer that matches the seller\'s offer. Hook is that same public fact, and only then is Priority High. Otherwise Priority is Low and Hook is blank. Source is the public page for that buyer, not the uploaded profile.',
  ].filter(Boolean).join('\n');
}

export function clipExplanation(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3);
  return sentences.join(' ').slice(0, 600);
}

function pipelineEnabled() {
  return String(process.env.PIPELINE_ENABLED ?? 'true').toLowerCase() !== 'false';
}

async function oneShot(options) {
  const { apiKey, model, question, profile, parts, urls, tabular } = options;
  const ai = options.ai || new (await import('@google/genai')).GoogleGenAI({ apiKey });
  const sellerMaterial = [];
  const media = [];
  for (const part of parts || []) {
    if (part && part.text) sellerMaterial.push(part.text);
    else if (part) media.push(part);
  }
  const content = [{ text: askPrompt(question, profile, sellerMaterial.join('\n\n')) }, ...media];
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
      console.error('[oneShot failed]', error?.status, error?.code, String(error?.message || error).slice(0, 300));
      if (error?.code === 'quota' || error?.code === 'no-key' || error?.code === 'model-not-found' || error?.code === 'bad-request' || error?.code === 'transient') throw error;
      lastError = error instanceof Error ? error.message : 'Gemini refused the request.';
    }
  }
  throw new Error(lastError || 'Gemini returned no text. Nothing was written to Sheets.');
}

async function verifyOneShot(leads, options) {
  const { verifyCandidates } = await import('./pipeline/verify.js');
  const { companyHost } = await import('./collectors/http.js');
  const { fetchHtml } = await import('./pipeline/index.js');
  const fetchPage = options.fetchPage || ((url) => fetchHtml(url, options.fetchImpl));
  const { kept } = await verifyCandidates(leads, { fetchPage, spec: options.spec || null });
  const host = (value) => companyHost(value) || companyHost(`https://${value || ''}`);
  const domains = new Set(kept.map((item) => host(item.website || item.domain)));
  return leads.filter((lead) => domains.has(host(lead.website || lead.domain))).slice(0, leadCap(options.profile));
}

export async function askSources(options) {
  if (pipelineEnabled()) {
    try {
      const { runPipeline } = await import('./pipeline/index.js');
      const result = await runPipeline(options);
      if (result?.leads?.length) {
        return { explanation: result.explanation, leads: result.leads.slice(0, leadCap(options.profile)) };
      }
    } catch (error) {
      console.error('[askSources failed]', error?.status, error?.code, String(error?.message || error).slice(0, 300));
      if (error?.code === 'quota' || error?.code === 'no-key' || error?.code === 'model-not-found' || error?.code === 'bad-request' || error?.code === 'transient') throw error;
    }
    const parsed = await oneShot(options);
    return { explanation: parsed.explanation, leads: await verifyOneShot(parsed.leads, options) };
  }
  return oneShot(options);
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
