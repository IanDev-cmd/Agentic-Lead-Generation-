function clipQuery(text) {
  return String(text || '').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 12).join(' ');
}

export function planQueries(spec, { max = 14, now = new Date() } = {}) {
  const year = (now instanceof Date ? now : new Date(now)).getFullYear();
  const cap = Math.min(20, Math.max(12, Number(max) || 14));
  const services = spec?.services?.length ? spec.services : [{ name: 'service', trigger_signals: [], buyer_pains: [] }];
  const industries = spec?.target_industries?.length ? spec.target_industries : ['organisations'];
  const primary = spec?.regions?.primary?.length ? spec.regions.primary : ['local market'];
  const secondary = spec?.regions?.secondary || [];
  const queries = [];
  const seen = new Set();
  const add = (text) => {
    const query = clipQuery(text);
    const key = query.toLowerCase();
    if (!query || seen.has(key) || queries.length >= cap) return;
    seen.add(key);
    queries.push(query);
  };
  for (const region of primary) {
    for (const industry of industries) {
      for (const service of services) {
        const signal = (service.trigger_signals || [])[0] || 'data analyst vacancy';
        add(`${region} "${signal}" ${industry} ${year}`);
        const pain = (service.buyer_pains || [])[0];
        if (pain) add(`${region} ${industry} "${pain}"`);
      }
      add(`${region} tender "business intelligence" OR ERP ${year}`);
    }
  }
  for (const client of (spec?.existing_clients || []).slice(0, 3)) {
    add(`${primary[0]} organisations like ${client}`);
  }
  for (const look of (spec?.lookalike_descriptions || []).slice(0, 3)) {
    add(`${primary[0]} ${look}`);
  }
  const extras = ['job post', 'tender notice', 'system migration', 'reporting load', 'compliance deadline', 'new branch', 'funding round', 'erp rollout'];
  let index = 0;
  while (queries.length < 12 && index < 40) {
    const region = primary[index % primary.length];
    const industry = industries[index % industries.length];
    const signal = extras[index % extras.length];
    add(`${region} ${industry} "${signal}" ${index + 1}`);
    index += 1;
  }
  if (queries.length < cap) {
    for (const region of secondary) {
      add(`${region} ${industries[0]} "digital transformation" ${year}`);
    }
  }
  return queries.slice(0, cap);
}
