/**
 * Apps Script hub for the lead-generation webhook.
 *
 * Deploy as a web app that executes as you, accessible to anyone.
 * The shared WEBHOOK_SECRET is the access control, because Apps Script
 * anonymous web apps do not provide Google-authenticated callers for a local Node process.
 *
 * Run install() from the editor once and approve scopes before the first POST.
 * Drafts are created with GmailApp.createDraft. MailApp only sends mail, so it is not used.
 * Geocoding uses the built-in Maps service, which does not need a Maps Platform billing account.
 * Follow-up tasks use the Advanced Tasks service (Tasks API v1).
 *
 * Script properties:
 *   WEBHOOK_SECRET, SPREADSHEET_ID, BRIEFINGS_FOLDER_ID,
 *   SELLER_NAME, SELLER_OFFERING, HOME_BASE_ADDRESS,
 *   CALENDAR_LOOKAHEAD_DAYS, MAX_LEADS, TASKLIST_ID
 */

var LEAD_HEADERS = [
  'Generated At',
  'Interaction ID',
  'Company',
  'Domain',
  'HQ Address',
  'Latitude',
  'Longitude',
  'Distance Km',
  'Contact Name',
  'Contact Title',
  'Contact Email',
  'Pain Point',
  'Hook',
  'Priority',
  'Source',
  'Briefing URL',
  'Draft ID',
  'Calendar Event IDs',
  'Task ID',
  'Task Due',
  'Notes'
];

var RUN_HEADERS = ['Interaction ID', 'Processed At', 'Lead Count', 'Report URL', 'Status'];
var HARD_LEAD_CAP = 15;

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('WEBHOOK_SECRET') || '';
  if (!expected || !secretsMatch_(providedSecret_(e), expected)) {
    return json_({ ok: false, error: 'Unauthorized webhook.' });
  }
  return json_({
    ok: true,
    service: 'lead-generation-webhook',
    spreadsheetConfigured: Boolean(props.getProperty('SPREADSHEET_ID')),
    folderConfigured: Boolean(props.getProperty('BRIEFINGS_FOLDER_ID'))
  });
}

function doPost(e) {
  try {
    return handlePost_(e);
  } catch (err) {
    Logger.log(err);
    return json_({
      ok: false,
      error: 'The webhook failed before the batch was saved.'
    });
  }
}

function install() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheet = getOrCreateSpreadsheet_(props);
  var folder = getOrCreateFolder_(props);
  ensureSheet_(spreadsheet, 'Leads', LEAD_HEADERS);
  ensureSheet_(spreadsheet, 'Runs', RUN_HEADERS);
  Logger.log('SPREADSHEET_URL=' + spreadsheet.getUrl());
  Logger.log('BRIEFINGS_FOLDER_URL=' + folder.getUrl());
  if (!props.getProperty('WEBHOOK_SECRET')) {
    Logger.log('Set WEBHOOK_SECRET in Project Settings > Script properties before deploying.');
  }
  Logger.log('Change the project timezone if Etc/GMT-3 is not your timezone. Task due dates use it.');
}

function handlePost_(e) {
  var body = readBody_(e);
  var config = getConfig_(body);
  if (!config.secret) {
    return json_({ ok: false, error: 'WEBHOOK_SECRET is not set. Run install(), then set the script property.' });
  }
  if (!secretsMatch_(providedSecret_(e), config.secret)) {
    return json_({ ok: false, error: 'Unauthorized webhook.' });
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return json_({ ok: false, retryable: true, error: 'Script is busy. Retry this delivery.' });
  }

  try {
    if (String(body.action || '') === 'approve') {
      return approveLead_(body, config);
    }

    var markdown = String(body.markdown || '');
  if (!markdown || markdown.length > 500000) {
    return json_({ ok: false, error: 'Markdown payload is missing or larger than 500000 characters.' });
  }
  var interactionId = String(body.interactionId || '').trim();
  if (!interactionId) {
    return json_({ ok: false, error: 'interactionId is required.' });
  }

  var props = PropertiesService.getScriptProperties();
    var spreadsheet = getOrCreateSpreadsheet_(props);
    var folder = getOrCreateFolder_(props);
    var leadsSheet = ensureSheet_(spreadsheet, 'Leads', LEAD_HEADERS);
    var runsSheet = ensureSheet_(spreadsheet, 'Runs', RUN_HEADERS);
    var prior = findRun_(runsSheet, interactionId);
    if (prior && prior.status === 'complete') {
      return json_({
        ok: true,
        duplicate: true,
        interactionId: interactionId,
        reportUrl: prior.reportUrl
      });
    }

    var parsed = parseLeadTable_(markdown);
    if (!parsed.foundTable) {
      return json_({ ok: false, error: 'No leads table found. Expected a markdown table whose header contains Company and Pain Point.' });
    }

    var leads = parsed.leads.slice(0, config.maxLeads);
    var reportUrl = archiveReport_(folder, interactionId, markdown);
    var home = config.homeBase ? geocodeAddress_(config.homeBase) : null;
    var summary = {
      ok: true,
      interactionId: interactionId,
      truncated: parsed.leads.length > leads.length,
      leadsReceived: parsed.leads.length,
      leadsWritten: 0,
      reportUrl: reportUrl,
      briefings: [],
      drafts: [],
      tasks: [],
      calendarUpdates: [],
      errors: []
    };

    var started = Date.now();
    for (var i = 0; i < leads.length; i += 1) {
      if (Date.now() - started > 4.5 * 60 * 1000) {
        summary.truncated = true;
        summary.errors.push({ company: '', notes: ['Stopped before the Apps Script time limit. Retry this delivery.'] });
        break;
      }
      var lead = leads[i];
      var outcome = processLead_(lead, {
        body: body,
        config: config,
        folder: folder,
        sheet: leadsSheet,
        home: home,
        markdown: markdown,
        reportUrl: reportUrl
      });
      summary.leadsWritten += 1;
      if (outcome.briefingUrl) summary.briefings.push(outcome.briefingUrl);
      if (outcome.draftId) summary.drafts.push(outcome.draftId);
      if (outcome.taskId) summary.tasks.push(outcome.taskId);
      if (outcome.calendarEventIds.length) {
        summary.calendarUpdates = summary.calendarUpdates.concat(outcome.calendarEventIds);
      }
      if (outcome.notes.length) {
        summary.errors.push({ company: lead.company, notes: outcome.notes });
      }
    }

    recordRun_(runsSheet, interactionId, summary.leadsWritten, reportUrl, 'complete');
    return json_(summary);
  } finally {
    lock.releaseLock();
  }
}

function processLead_(lead, ctx) {
  var notes = [];
  var blank = {
    briefingUrl: '',
    draftId: '',
    taskId: '',
    taskDue: '',
    calendarEventIds: [],
    latitude: '',
    longitude: '',
    distanceKm: '',
    notes: notes
  };

  if (leadExists_(ctx.sheet, ctx.body.interactionId, lead)) {
    notes.push('Row already existed; side effects were not repeated.');
    blank.notes = notes;
    return blank;
  }

  var geo = lead.hqAddress ? geocodeAddress_(lead.hqAddress) : { error: '' };
  if (geo.error) notes.push('Geocode: ' + geo.error);
  if (geo.lat != null) {
    blank.latitude = geo.lat;
    blank.longitude = geo.lng;
    if (ctx.home && ctx.home.lat != null) {
      blank.distanceKm = haversineKm_(ctx.home, geo);
    } else if (ctx.config.homeBase) {
      notes.push('Home base could not be geocoded, so proximity was skipped.');
    }
  }

  var highValue = isHighValue_(lead);
  if (highValue) {
    try {
      var briefing = createBriefingDoc_(ctx.folder, lead, ctx.markdown, geo, blank.distanceKm, ctx.body.interactionId);
      blank.briefingUrl = briefing.url;
      var calendar = attachBriefingToCalendar_(lead, briefing.url, ctx.config.lookaheadDays);
      blank.calendarEventIds = calendar.updated;
      if (calendar.note) notes.push(calendar.note);
    } catch (err) {
      notes.push('Briefing: ' + (err.message || err));
    }

    try {
      var task = createFollowUpTask_(lead, blank.briefingUrl, ctx.config.tasklist);
      blank.taskId = task.id;
      blank.taskDue = task.due;
    } catch (err) {
      notes.push('Task: ' + (err.message || err));
    }
    notes.push('Draft is not created until the pitch is approved. Nothing is sent from this desk.');
  } else {
    notes.push('Negative match. No briefing, task, or draft was created.');
  }

  appendLead_(ctx.sheet, lead, ctx.body, blank);
  return blank;
}

function readBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) throw new Error('Missing JSON body.');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('Body is not valid JSON.');
  }
}

function providedSecret_(e) {
  var headers = (e && e.headers) || {};
  return String(headers['X-Webhook-Secret'] || headers['x-webhook-secret'] || '');
}

function secretsMatch_(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  var mismatch = 0;
  for (var i = 0; i < expected.length; i += 1) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

function getConfig_(payload) {
  var props = PropertiesService.getScriptProperties();
  var seller = payload.seller || {};
  return {
    secret: props.getProperty('WEBHOOK_SECRET') || '',
    sellerName: seller.name || props.getProperty('SELLER_NAME') || '',
    sellerOffering: seller.offering || props.getProperty('SELLER_OFFERING') || '',
    homeBase: props.getProperty('HOME_BASE_ADDRESS') || '',
    lookaheadDays: clamp_(Number(props.getProperty('CALENDAR_LOOKAHEAD_DAYS') || 30), 1, 90),
    maxLeads: clamp_(Number(props.getProperty('MAX_LEADS') || 8), 1, HARD_LEAD_CAP),
    tasklist: props.getProperty('TASKLIST_ID') || '@default'
  };
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function clamp_(value, min, max) {
  if (!isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function getOrCreateSpreadsheet_(props) {
  var existing = props.getProperty('SPREADSHEET_ID');
  if (existing) return SpreadsheetApp.openById(existing);
  var created = SpreadsheetApp.create('Lead Generation');
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

function getOrCreateFolder_(props) {
  var existing = props.getProperty('BRIEFINGS_FOLDER_ID');
  if (existing) return DriveApp.getFolderById(existing);
  var created = DriveApp.createFolder('Leads Briefings');
  props.setProperty('BRIEFINGS_FOLDER_ID', created.getId());
  return created;
}

function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }
  var width = Math.max(sheet.getLastColumn(), headers.length);
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];
  var same = headers.every(function (header, index) { return current[index] === header; });
  if (!same) {
    throw new Error('Sheet "' + name + '" has an unexpected header row. Point SPREADSHEET_ID at a new spreadsheet or rename that tab.');
  }
  return sheet;
}

function findRun_(sheet, interactionId) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][0]) === interactionId) {
      return { reportUrl: values[i][3], status: values[i][4] };
    }
  }
  return null;
}

function recordRun_(sheet, interactionId, leadCount, reportUrl, status) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][0]) === interactionId) {
      sheet.getRange(i + 1, 1, 1, RUN_HEADERS.length).setValues([[
        interactionId,
        new Date().toISOString(),
        leadCount,
        reportUrl,
        status
      ]]);
      return;
    }
  }
  sheet.appendRow([interactionId, new Date().toISOString(), leadCount, reportUrl, status]);
}

function leadExists_(sheet, interactionId, lead) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i += 1) {
    var sameRun = String(values[i][1]) === String(interactionId);
    var sameCompany = String(values[i][2]).toLowerCase() === lead.company.toLowerCase();
    var sameDomain = lead.domain && String(values[i][3]).toLowerCase() === lead.domain;
    if (sameRun && (sameCompany || sameDomain)) return true;
  }
  return false;
}

function appendLead_(sheet, lead, body, outcome) {
  sheet.appendRow([
    body.generatedAt || new Date().toISOString(),
    body.interactionId,
    asCell_(lead.company),
    asCell_(lead.domain),
    asCell_(lead.hqAddress),
    outcome.latitude,
    outcome.longitude,
    outcome.distanceKm,
    asCell_(lead.contactName),
    asCell_(lead.title),
    asCell_(lead.email),
    asCell_(lead.painPoint),
    asCell_(lead.hook),
    asCell_(lead.priority),
    asCell_(lead.source),
    outcome.briefingUrl,
    outcome.draftId,
    outcome.calendarEventIds.join(', '),
    outcome.taskId,
    outcome.taskDue,
    asCell_(outcome.notes.join(' | '))
  ]);
}

function asCell_(value) {
  var text = value == null ? '' : String(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function parseLeadTable_(markdown) {
  var lines = String(markdown || '').split(/\r?\n/);
  var headerIndex = -1;
  for (var i = 0; i < lines.length; i += 1) {
    var candidate = lines[i].toLowerCase();
    if (candidate.indexOf('|') !== -1 && candidate.indexOf('company') !== -1 && candidate.indexOf('pain') !== -1) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return { foundTable: false, leads: [] };

  var headers = splitRow_(lines[headerIndex]).map(normalizeHeader_);
  var leads = [];
  for (var row = headerIndex + 1; row < lines.length; row += 1) {
    var line = lines[row].trim();
    if (!line || line.charAt(0) !== '|') break;
    var cells = splitRow_(line);
    if (cells.every(function (cell) { return /^:?-{3,}:?$/.test(cell); })) continue;
    var raw = {};
    headers.forEach(function (header, index) {
      if (header) raw[header] = cells[index] || '';
    });
    var lead = canonicalLead_(raw);
    if (lead) leads.push(lead);
  }
  return { foundTable: true, leads: leads };
}

function splitRow_(line) {
  var trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  var cells = [];
  var current = '';
  for (var i = 0; i < trimmed.length; i += 1) {
    var char = trimmed.charAt(i);
    if (char === '|' && trimmed.charAt(i - 1) !== '\\') {
      cells.push(current.replace(/\\\|/g, '|').trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.replace(/\\\|/g, '|').trim());
  return cells;
}

function normalizeHeader_(cell) {
  var cleaned = String(cell || '').replace(/\*\*/g, '').replace(/`/g, '').trim().toLowerCase();
  if (cleaned.indexOf('email') !== -1) return 'email';
  if (cleaned.indexOf('pain') !== -1) return 'painPoint';
  if (cleaned.indexOf('hook') !== -1) return 'hook';
  if (cleaned.indexOf('prior') !== -1) return 'priority';
  if (cleaned.indexOf('source') !== -1 || cleaned.indexOf('url') !== -1) return 'source';
  if (cleaned.indexOf('domain') !== -1 || cleaned.indexOf('website') !== -1) return 'domain';
  if (cleaned.indexOf('address') !== -1 || cleaned.indexOf('headquarter') !== -1 || cleaned === 'hq') return 'hqAddress';
  if (cleaned.indexOf('title') !== -1 || cleaned.indexOf('role') !== -1) return 'title';
  if (cleaned.indexOf('contact') !== -1) return 'contactName';
  if (cleaned.indexOf('company') !== -1 || cleaned.indexOf('account') !== -1) return 'company';
  return '';
}

function canonicalLead_(raw) {
  var company = cleanField_(raw.company);
  if (!company || /^(unknown|n\/a|none|-)$/i.test(company)) return null;
  var domain = normalizeDomain_(raw.domain);
  return {
    company: company,
    domain: domain === 'unknown' ? '' : domain,
    hqAddress: unknownToBlank_(raw.hqAddress),
    contactName: unknownToBlank_(raw.contactName),
    title: unknownToBlank_(raw.title),
    email: extractEmail_(raw.email),
    painPoint: unknownToBlank_(raw.painPoint),
    hook: unknownToBlank_(raw.hook),
    priority: cleanField_(raw.priority) || 'unknown',
    source: cleanField_(raw.source)
  };
}

function cleanField_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unknownToBlank_(value) {
  var cleaned = cleanField_(value);
  return /^(unknown|n\/a|none|-)$/i.test(cleaned) ? '' : cleaned;
}

function normalizeDomain_(value) {
  return cleanField_(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .replace(/[^a-z0-9.-]/g, '');
}

function extractEmail_(value) {
  var match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function isHighValue_(lead) {
  return String(lead.priority || '').toLowerCase().indexOf('high') === 0;
}

function extractBriefing_(markdown, company) {
  var lines = String(markdown || '').split(/\r?\n/);
  var start = -1;
  var heading = new RegExp('^#{1,3}\\s+Briefing:\\s+' + escapeRegExp_(company) + '\\s*$', 'i');
  for (var i = 0; i < lines.length; i += 1) {
    if (heading.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  var section = [];
  for (var j = start; j < lines.length; j += 1) {
    if (/^#{1,3}\s+/.test(lines[j])) break;
    section.push(lines[j]);
  }
  return section.join('\n').trim();
}

function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveReport_(folder, interactionId, markdown) {
  var name = 'research-' + safeName_(interactionId) + '.md';
  var existing = folder.getFilesByName(name);
  if (existing.hasNext()) return existing.next().getUrl();
  return folder.createFile(name, markdown, MimeType.PLAIN_TEXT).getUrl();
}

function createBriefingDoc_(folder, lead, markdown, geo, distanceKm, interactionId) {
  var title = 'Briefing - ' + safeName_(lead.company) + ' - ' + safeName_(interactionId);
  var existing = folder.getFilesByName(title);
  if (existing.hasNext()) {
    var file = existing.next();
    return { id: file.getId(), url: file.getUrl() };
  }

  var doc = DocumentApp.create(title);
  var body = doc.getBody();
  body.appendParagraph('Pre-meeting briefing').setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(lead.company).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  addField_(body, 'Domain', lead.domain);
  addField_(body, 'Headquarters', lead.hqAddress);
  if (geo && geo.lat != null) {
    addField_(body, 'Coordinates', geo.lat + ', ' + geo.lng);
  }
  if (distanceKm !== '' && distanceKm != null) {
    addField_(body, 'Distance from home base', distanceKm + ' km');
  }
  addField_(body, 'Contact', [lead.contactName, lead.title, lead.email].filter(Boolean).join(' — '));
  addField_(body, 'Priority', lead.priority);
  addField_(body, 'Source', lead.source);

  body.appendParagraph('Pain point').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(lead.painPoint || 'No public pain point was confirmed.');
  body.appendParagraph('Hook').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(lead.hook || 'No public hook was confirmed.');

  var narrative = extractBriefing_(markdown, lead.company);
  body.appendParagraph('Research notes').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph(narrative || 'The research report did not include a separate briefing section for this company.');

  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  return { id: doc.getId(), url: doc.getUrl() };
}

function addField_(body, label, value) {
  var paragraph = body.appendParagraph(label + ': ' + (value || 'unknown'));
  paragraph.editAsText().setBold(0, label.length);
}

function attachBriefingToCalendar_(lead, docUrl, lookaheadDays) {
  var calendar = CalendarApp.getDefaultCalendar();
  var cursor = new Date();
  var end = new Date(cursor.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  var updated = [];
  var matched = 0;
  var failures = 0;
  var examined = 0;

  while (cursor < end && updated.length < 5 && examined < 500) {
    var chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + 7 * 24 * 60 * 60 * 1000));
    var events = calendar.getEvents(cursor, chunkEnd);
    for (var i = 0; i < events.length && updated.length < 5 && examined < 500; i += 1) {
      examined += 1;
      var event = events[i];
      if (!eventMatches_(event, lead.domain, lead.company)) continue;
      matched += 1;
      try {
        var description = event.getDescription() || '';
        if (description.indexOf(docUrl) !== -1) continue;
        event.setDescription(description + '\n\nLead briefing (' + lead.company + '): ' + docUrl);
        updated.push(event.getId());
      } catch (err) {
        failures += 1;
      }
    }
    cursor = chunkEnd;
  }

  var note = '';
  if (failures) note = 'Could not edit ' + failures + ' matching calendar event(s). They may be owned by someone else.';
  if (examined === 500) note = (note ? note + ' ' : '') + 'Calendar scan stopped at 500 events.';
  if (!note && matched > updated.length) note = 'Matched ' + matched + ' events and attached the briefing to the first ' + updated.length + '.';
  return { updated: updated, note: note };
}

function eventMatches_(event, domain, company) {
  var haystack = ((event.getTitle() || '') + '\n' + (event.getDescription() || '')).toLowerCase();
  if (company && haystack.indexOf(company.toLowerCase()) !== -1) return true;
  if (!domain) return false;
  try {
    return (event.getGuestList() || []).some(function (guest) {
      return String(guest.getEmail() || '').toLowerCase().endsWith('@' + domain);
    });
  } catch (err) {
    return false;
  }
}

function createOutreachDraft_(lead, seller) {
  var needsRecipient = !looksLikeEmail_(lead.email);
  var recipient = lead.email;
  var subject = buildSubject_(lead);
  if (needsRecipient) {
    recipient = Session.getActiveUser().getEmail();
    if (!recipient) throw new Error('No public contact email, and the account email is unavailable.');
    subject = '[Needs recipient] ' + subject;
  }

  var existingId = findDraftBySubject_(subject);
  if (existingId) return { id: existingId, needsRecipient: needsRecipient };

  var draft = GmailApp.createDraft(recipient, subject, buildDraftBody_(lead, seller));
  return { id: draft.getId(), needsRecipient: needsRecipient };
}

function findDraftBySubject_(subject) {
  var start = 0;
  while (start < 500) {
    var threads = GmailApp.search('in:drafts newer_than:30d', start, 50);
    if (!threads.length) return '';
    for (var i = 0; i < threads.length; i += 1) {
      var messages = threads[i].getMessages();
      for (var m = 0; m < messages.length; m += 1) {
        if (messages[m].getSubject() === subject) return messages[m].getId();
      }
    }
    if (threads.length < 50) return '';
    start += 50;
  }
  return '';
}

function buildSubject_(lead) {
  var focus = lead.painPoint || lead.hook;
  var short = focus.length > 70 ? focus.slice(0, 67) + '...' : focus;
  return lead.company + ': ' + short;
}

function buildDraftBody_(lead, seller) {
  var greeting = lead.contactName ? 'Hi ' + lead.contactName.split(' ')[0] + ',' : 'Hi,';
  var paragraphs = [
    greeting,
    'I was reading about ' + lead.company + ' and this stood out: ' + lead.hook,
    seller.offering
      ? 'We work with teams on that kind of problem. ' + seller.offering
      : 'I can send a one-page brief if this is a current problem.',
    'If this is relevant I can send the short brief. If it is not, no need to reply.'
  ];
  if (seller.name) paragraphs.push(seller.name);
  paragraphs.push('Draft only. Review the sources before sending.');
  return paragraphs.join('\n\n');
}

function looksLikeEmail_(value) {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value || '');
}

function createFollowUpTask_(lead, briefingUrl, tasklist) {
  if (typeof Tasks === 'undefined' || !Tasks.Tasks) {
    throw new Error('Tasks advanced service is not enabled. In the Apps Script editor, open Services and add the Tasks API.');
  }
  var title = 'Review pitch deck for ' + lead.company;
  var existing = findOpenTask_(tasklist, title);
  if (existing) return { id: existing.id, due: existing.due || '' };

  var dueAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  var timeZone = Session.getScriptTimeZone() || 'Etc/GMT-3';
  var dueDate = Utilities.formatDate(dueAt, timeZone, 'yyyy-MM-dd');
  // The Tasks due field stores a calendar date. The exact instant is kept in the notes.
  var due = dueDate + 'T00:00:00.000Z';
  var created = Tasks.Tasks.insert({
    title: title,
    due: due,
    notes: [
      'Created from lead research.',
      'Exact 48-hour instant: ' + dueAt.toISOString(),
      'Due date in the script timezone: ' + dueDate,
      briefingUrl ? 'Briefing: ' + briefingUrl : ''
    ].filter(Boolean).join('\n')
  }, tasklist);
  return { id: created.id, due: due };
}

function findOpenTask_(tasklist, title) {
  var token = '';
  var seen = 0;
  while (seen < 1000) {
    var options = { showCompleted: false, maxResults: 100 };
    if (token) options.pageToken = token;
    var page = Tasks.Tasks.list(tasklist, options);
    var items = (page && page.items) || [];
    for (var i = 0; i < items.length; i += 1) {
      seen += 1;
      if (items[i].title === title) return items[i];
    }
    token = page && page.nextPageToken;
    if (!token || !items.length) return null;
  }
  return null;
}

function findLeadRow_(sheet, interactionId, company) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][1]) === interactionId && String(values[i][2]) === company) return i + 1;
  }
  return 0;
}

function approveLead_(body, config) {
  var company = cleanField_(body.company);
  var interactionId = String(body.interactionId || '').trim();
  if (!company || !interactionId) {
    return json_({ ok: false, sent: false, error: 'company and interactionId are required. Nothing was saved in Gmail.' });
  }
  var props = PropertiesService.getScriptProperties();
  var sheet = ensureSheet_(getOrCreateSpreadsheet_(props), 'Leads', LEAD_HEADERS);
  var row = findLeadRow_(sheet, interactionId, company);
  if (!row) {
    return json_({ ok: false, sent: false, error: 'That lead is not on the sheet yet. Nothing was saved in Gmail.' });
  }
  var values = sheet.getRange(row, 1, 1, LEAD_HEADERS.length).getValues()[0];
  var hook = cleanField_(values[12]);
  var priority = cleanField_(values[13]);
  if (!hook || priority.toLowerCase().indexOf('high') !== 0) {
    return json_({ ok: false, sent: false, error: 'A negative match does not create a draft. Nothing was sent.' });
  }
  var existingDraft = cleanField_(values[16]);
  if (existingDraft) {
    return json_({ ok: true, sent: false, duplicate: true, draftId: existingDraft, taskCleared: false });
  }
  var lead = {
    company: company,
    email: cleanField_(values[10]),
    contactName: cleanField_(values[8]),
    painPoint: cleanField_(values[11]),
    hook: hook
  };
  var draft = createOutreachDraft_(lead, { name: config.sellerName, offering: config.sellerOffering });
  sheet.getRange(row, 17).setValue(asCell_(draft.id));
  var taskId = cleanField_(values[18]);
  var taskCleared = false;
  if (taskId && typeof Tasks !== 'undefined' && Tasks.Tasks) {
    try {
      Tasks.Tasks.patch({ status: 'completed' }, config.tasklist, taskId);
      taskCleared = true;
    } catch (err) {
      Logger.log(err);
    }
  }
  return json_({
    ok: true,
    sent: false,
    draftId: draft.id,
    taskCleared: taskCleared,
    needsRecipient: Boolean(draft.needsRecipient)
  });
}

function geocodeAddress_(address) {
  var cleaned = cleanField_(address);
  if (!cleaned || /^(unknown|n\/a|none)$/i.test(cleaned)) return { error: '' };
  var cache = CacheService.getScriptCache();
  var key = 'geo:' + fingerprint_(cleaned);
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var response = Maps.newGeocoder().geocode(cleaned);
  if (!response || response.status === 'OVER_QUERY_LIMIT') {
    return { error: 'Maps geocoder quota is exhausted for today.' };
  }
  if (response.status !== 'OK' || !response.results || !response.results.length) {
    return { error: 'No geocode match (' + (response && response.status ? response.status : 'empty') + ').' };
  }
  var location = response.results[0].geometry.location;
  var point = { lat: location.lat, lng: location.lng };
  cache.put(key, JSON.stringify(point), 21600);
  return point;
}

function haversineKm_(from, to) {
  var toRad = function (degrees) { return degrees * Math.PI / 180; };
  var earthKm = 6371;
  var dLat = toRad(to.lat - from.lat);
  var dLng = toRad(to.lng - from.lng);
  var lat1 = toRad(from.lat);
  var lat2 = toRad(to.lat);
  var h = Math.pow(Math.sin(dLat / 2), 2)
    + Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin(dLng / 2), 2);
  return Math.round(earthKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 10) / 10;
}

function fingerprint_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(function (byte) {
    var unsigned = (byte + 256) % 256;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('').slice(0, 32);
}

function safeName_(value) {
  var cleaned = String(value || 'Account').replace(/[\\/:*?"<>|]/g, '').trim();
  return cleaned.slice(0, 80) || 'Account';
}
