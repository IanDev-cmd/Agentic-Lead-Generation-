export function secretsMatch(provided, expected) {
  const left = String(provided || '');
  const right = String(expected || '');
  if (!left || !right || left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < right.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

export function asCell(value) {
  const text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function blankUnknown(value) {
  const text = String(value || '').trim();
  return /^(unknown|n\/a|none)$/i.test(text) ? '' : text;
}
