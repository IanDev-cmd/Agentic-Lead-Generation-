import { visibleText } from './extract.js';

const ROLE = /^(info|sales|enquiries|hello|contact)@/i;

function onDomain(email, domain) {
  const host = String(email.split('@')[1] || '').toLowerCase().replace(/^www\./, '');
  const root = String(domain || '').toLowerCase().replace(/^www\./, '');
  return Boolean(root) && (host === root || host.endsWith(`.${root}`));
}

export function emailsOnPage(html, domain) {
  const raw = String(html || '');
  const text = visibleText(raw);
  const mailtos = [...raw.matchAll(/mailto:([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map((match) => match[1]);
  const visible = [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map((match) => match[0]);
  const found = [...new Set([...mailtos, ...visible].map((email) => email.toLowerCase()))].filter((email) => onDomain(email, domain));
  return found.find((email) => ROLE.test(email)) || found[0] || '';
}

export function personOnPage(html) {
  const text = visibleText(html);
  const match = text.match(/\b([A-Z][a-z]+ [A-Z][a-z]+),\s+((?:Chief|Director|Head|Manager|Founder|Officer)[^.]{0,48})/);
  if (!match) return { contact: '', title: '' };
  return { contact: match[1], title: match[2].trim() };
}

export async function attachContacts(leads, fetchPage, deadline) {
  const paths = ['/', '/contact', '/contact-us', '/about'];
  const next = [];
  for (const lead of leads || []) {
    if (deadline?.expired?.()) {
      next.push(lead);
      continue;
    }
    let email = '';
    let contact = '';
    let title = '';
    if (fetchPage && lead.domain) {
      for (const suffix of paths) {
        if (email && contact) break;
        try {
          const page = await fetchPage(`https://${lead.domain}${suffix === '/' ? '' : suffix}`);
          if (!page?.ok && !(Number(page?.status) >= 200 && Number(page?.status) < 400)) continue;
          if (!email) email = emailsOnPage(page.text, lead.domain);
          if (!contact) {
            const person = personOnPage(page.text);
            contact = person.contact;
            title = person.title;
          }
        } catch {
          // A missing contact page stays blank.
        }
      }
    }
    next.push({ ...lead, email: email || '', contact: contact || '', title: title || '' });
  }
  return next;
}
