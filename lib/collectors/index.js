import { keyedNotes } from './keyed.js';
import { keylessLeads, keylessNotes } from './keyless.js';
import { mergeLeadRecords } from './merge.js';

export { mergeLeadRecords };

export async function collectSignals(query) {
  const [notes, keyed, leads] = await Promise.all([
    keylessNotes(query).catch(() => []),
    keyedNotes(query).catch(() => []),
    keylessLeads(query).catch(() => []),
  ]);
  return { notes: [...notes, ...keyed].slice(0, 16), leads };
}
