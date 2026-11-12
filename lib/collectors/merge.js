export function domainKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/\.+$/, '');
}

function nameKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function list(value) {
  return (Array.isArray(value) ? value : [value]).map((item) => String(item || '').trim()).filter(Boolean);
}

function combine(left, right) {
  const sources = [...new Set([...list(left.sources), ...list(left.source), ...list(right.sources), ...list(right.source)])];
  const signals = [...new Set([...list(left.signals), ...list(right.signals)])];
  const added = sources.length > list(left.sources || left.source).length;
  return {
    ...left,
    company: left.company || right.company,
    domain: left.domain || right.domain,
    website: left.website || right.website,
    email: left.email || right.email,
    hq: left.hq || right.hq,
    lat: left.lat ?? right.lat,
    lng: left.lng ?? right.lng,
    photo: left.photo || right.photo || right.logo || '',
    logo: left.logo || right.logo || left.photo || '',
    hook: left.hook || right.hook,
    pain: left.pain || right.pain,
    contact: left.contact || right.contact,
    title: left.title || right.title,
    source: sources[0] || left.source || right.source || '',
    sources,
    signals,
    priority: left.priority === 'High' || right.priority === 'High' ? 'High' : 'Low',
    score: (Number(left.score) || 0) + (added && sources.length > 1 ? 15 : 0),
  };
}

export function mergeLeadRecords(primary, extra, query = '') {
  const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 4);
  const base = Array.isArray(primary) ? primary.filter(Boolean) : [];
  const additions = (Array.isArray(extra) ? extra : []).filter((lead) => {
    const domain = domainKey(lead && (lead.domain || lead.website));
    if (!domain) return false;
    if (base.some((item) => domainKey(item.domain || item.website) === domain)) return true;
    const blob = `${lead.company || ''} ${domain} ${list(lead.signals).join(' ')}`.toLowerCase();
    return tokens.some((token) => blob.includes(token));
  });
  const merged = new Map();
  for (const lead of [...base, ...additions]) {
    const key = domainKey(lead.domain || lead.website) || nameKey(lead.company);
    if (!key) continue;
    const previous = merged.get(key);
    merged.set(key, previous ? combine(previous, lead) : { ...lead, sources: list(lead.sources).length ? list(lead.sources) : list(lead.source), signals: list(lead.signals) });
  }
  return [...merged.values()];
}
