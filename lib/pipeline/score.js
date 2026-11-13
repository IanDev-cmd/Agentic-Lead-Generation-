export function enterpriseHints() {
  return String(process.env.PIPELINE_ENTERPRISE_HINTS || 'listed bank,national telecom,national health system,multinational')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function tierOf(score) {
  if (score >= 75) return 'A';
  if (score >= 55) return 'B';
  return 'C';
}

export function isEnterprise(candidate, hints = enterpriseHints()) {
  const blob = `${candidate?.approx_size_signal || ''} ${candidate?.company || ''}`.toLowerCase();
  return hints.some((hint) => hint && blob.includes(hint));
}

function industryPoints(candidate, spec) {
  const industry = String(candidate.industry || '').toLowerCase();
  const targets = spec?.target_industries || [];
  if (!industry || !targets.length) return 0;
  if (targets.some((item) => {
    const target = String(item).toLowerCase();
    return industry.includes(target) || target.includes(industry);
  })) return 25;
  return 0;
}

function sizePoints(candidate, spec) {
  const min = Number(spec?.size_band?.min_employees) || 0;
  const max = Number(spec?.size_band?.max_employees) || 0;
  const match = String(candidate.approx_size_signal || '').match(/\d+/);
  if (!match) return 10;
  const size = Number(match[0]);
  if (min && max && size >= min && size <= max) return 20;
  if (min && max) return 0;
  return 10;
}

function regionPoints(candidate, spec) {
  const blob = `${candidate.hq || ''} ${candidate.hq_region || ''} ${candidate.region || ''}`.toLowerCase();
  const primary = spec?.regions?.primary || [];
  const secondary = spec?.regions?.secondary || [];
  if (primary.some((item) => blob.includes(String(item).toLowerCase()))) return 15;
  if (secondary.some((item) => blob.includes(String(item).toLowerCase()))) return 8;
  return 0;
}

function regionRank(candidate, spec) {
  const points = regionPoints(candidate, spec);
  if (points >= 15) return 'primary';
  if (points >= 8) return 'secondary';
  return 'other';
}

export function scoreCandidate(candidate, spec, hints = enterpriseHints()) {
  const evidence = candidate.quoteVerified && candidate.evidence_quote ? 30 : 0;
  const dated = candidate.recent === true || /20\d{2}/.test(String(candidate.signal || ''));
  const recency = evidence && dated ? 10 : 0;
  let fit = industryPoints(candidate, spec) + sizePoints(candidate, spec) + regionPoints(candidate, spec) + evidence + recency;
  const enterprise = isEnterprise(candidate, hints);
  if (enterprise && evidence < 30) fit = Math.min(fit, 40);
  const tier = tierOf(fit);
  const hookText = String(candidate.hook || candidate.pain_inferred_from_signal || '').trim();
  const high = (tier === 'A' || tier === 'B') && Boolean(candidate.quoteVerified) && Boolean(candidate.evidence_quote) && Boolean(hookText);
  return {
    ...candidate,
    fit_score: fit,
    tier,
    regionRank: regionRank(candidate, spec),
    priority: high ? 'High' : 'Low',
    hook: high ? hookText : '',
  };
}

export function selectLeads(scored, cap, minTier = 'B') {
  const allowed = minTier === 'A' ? ['A'] : minTier === 'C' ? ['A', 'B', 'C'] : ['A', 'B'];
  const rank = { A: 0, B: 1, C: 2 };
  const sort = (rows) => [...rows].sort((left, right) => rank[left.tier] - rank[right.tier] || right.fit_score - left.fit_score);
  const primary = sort((scored || []).filter((lead) => lead.regionRank === 'primary' && allowed.includes(lead.tier)));
  const secondary = sort((scored || []).filter((lead) => lead.regionRank === 'secondary' && allowed.includes(lead.tier)));
  return [...primary, ...secondary].slice(0, Math.max(0, cap));
}
