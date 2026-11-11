export function envFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

export function shouldDelegate(config, env = process.env) {
  if (env.LEADGEN_ROUTE === 'paid') return false;
  if (config.reportFile || config.resumeId) return false;
  if (config.dryRun && !envFlag(env.DEMO_MODE)) return false;
  return true;
}
