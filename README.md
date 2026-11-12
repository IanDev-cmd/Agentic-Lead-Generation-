# Lead generation skeleton

Local Node.js starts a Gemini Deep Research run, polls until the report is ready, and POSTs the markdown to a Google Apps Script web app. The script files leads into Sheets, writes a briefing doc for high-priority accounts, drafts an outreach email, geocodes headquarters, attaches the briefing to matching calendar events, and creates a follow-up task.

```
.env
  |
  v
index.js
  DRY_RUN / REPORT_FILE / RESUME -> existing Node paths
  otherwise                      -> python -m fallback
                                    BILLING_ENABLED and probe ok -> node index.js (LEADGEN_ROUTE=paid)
                                      interactions.create + poll
                                    DEMO_MODE -> fallback/demo_leads.json
                                    otherwise -> Flash planner, Search grounding, reviewer, markdown
  save output/last-report.md
  POST JSON { secret, interactionId, markdown, seller }
  |
  v
Apps Script doPost
  authorize secret
  parse the markdown table
  Sheets  Docs  Drive  Gmail draft  Maps  Calendar  Tasks
```

`gemini-2.5-flash` grounding on the free tier is 500 requests per day, shared with Flash-Lite. The 5,000-search monthly figure on Google's pricing page applies to Gemini 3 and newer models. The fallback records grounded calls in `output/grounding-quota.json` and stops at the published cap for `FREE_MODEL`.

## Free-tier boundary

Sheets, Docs, Drive, Gmail drafts, the built-in Maps geocoder, Calendar, and Tasks run inside a normal Google account and Apps Script quotas. No Maps Platform key and no paid Workspace add-on is required.

The Gemini side is narrower than "free":

- The Interactions API has a free tier. On that tier, stored interactions are retained for one day. Background Deep Research requires `store: true`, so a failed webhook must be resumed or replayed inside that window.
- Google's Deep Research documentation prices a typical `deep-research-preview-04-2026` task on a pay-as-you-go basis (their published estimate is about $1–$3, and the Max agent is higher). This skeleton does not treat that call as free. Confirm the key's project in AI Studio before `DRY_RUN=false`.
- Visualizations are off, collaborative planning is off, and the Max agent is not the default. `DRY_RUN=true` exercises the webhook without calling Gemini. `RESUME_INTERACTION_ID` and `REPORT_FILE` recover a run that already finished.

Apps Script consumer executions are limited to about six minutes. The webhook processes at most 15 leads, scans at most 500 calendar events, and updates at most five of them.

## Security

The web app has to be deployed as "Anyone" so Node can POST without a Google user session. `WEBHOOK_SECRET` is checked before any write. Use a random string of at least 16 characters, put the same value in `.env` and in Apps Script script properties, and treat the `/exec` URL like a credential.

Apps Script web apps cannot read HTTP request headers, so the secret is not sent as a header. Callers put it in the POST JSON body (`secret`) over HTTPS. The GET health check is the only request that passes it as a query parameter. Do not write that full URL to logs, tickets, or chat. Responses never include the secret.

The research prompt tells the agent to leave unknown emails as `unknown`. The script does not invent a recipient. When no public email exists, the draft is addressed to the script owner and prefixed `[Needs recipient]`. Nothing is sent.

Sheet cells that start with `=`, `+`, `-`, or `@` are prefixed so a model-written table cannot become a formula.

## Local setup

Requires Node.js 22 or newer (required by `@google/genai` 3.x).

```powershell
copy .env.example .env
npm install
npm start
```

With the example `.env`, `DRY_RUN=true` and the webhook URL is still a placeholder, so the first start fails until you either clear `GOOGLE_WEBHOOK_URL` (local fixture only) or paste a real `/exec` URL and secret.

A live run needs `DRY_RUN=false`, `GEMINI_API_KEY`, `SELLER_OFFERING`, `TARGET_INDUSTRY`, the webhook URL, and the secret.

If the process is interrupted after the interaction id is printed, the research continues on Google's side:

```powershell
# set RESUME_INTERACTION_ID in .env, then
npm start
```

If the report was saved and the webhook failed:

```powershell
# REPORT_FILE=output/last-report.md
npm start
```

Mode order is `REPORT_FILE`, then `DRY_RUN`, then `RESUME_INTERACTION_ID`, then a new research task.

## Apps Script setup

1. Create a project at [script.google.com](https://script.google.com).
2. Replace `Code.gs` with `apps-script/Code.gs`.
3. Open Project Settings, show the manifest, and replace it with `apps-script/appsscript.json`. Set `timeZone` to your timezone. `Etc/GMT-3` is UTC+3. Task due dates use this zone.
4. In the editor, open Services and add the Google Tasks API if the manifest did not enable it. The symbol must be `Tasks`.
5. Run `install` and approve the scopes. The log prints the spreadsheet URL and the "Leads Briefings" folder URL.
6. In Project Settings > Script properties, set `WEBHOOK_SECRET` to the same value as `.env`. Optional: `HOME_BASE_ADDRESS` (used for distance), `SELLER_NAME`, `SELLER_OFFERING`, `CALENDAR_LOOKAHEAD_DAYS`, `MAX_LEADS`, `TASKLIST_ID`.
7. Deploy > New deployment > Web app. Execute as **Me**. Who has access: **Anyone**. Copy the URL that ends in `/exec`.
8. Open that URL in a browser with the secret on the query string: `/exec?secret=` plus the URL-encoded value. The JSON says whether the spreadsheet and folder are configured. It does not reveal the secret. Do not log or share that full URL.

After any edit to `Code.gs`, redeploy or the live `/exec` URL keeps running the previous version: Deploy > Manage deployments > Edit > Version: New version > Deploy.

`install` creates the spreadsheet and folder on first run and stores their ids in script properties. Run it before the first POST so the OAuth consent happens in the editor. A POST that arrives before consent gets an HTML error page; Node reports that as a non-JSON webhook response and leaves `output/last-report.md` in place.

## Lead contract

The agent is asked for one markdown table and a `## Briefing: {Company}` section for each High row. Structured output is not available on this agent, so the table is the contract.

| Company | Domain | HQ Address | Contact Name | Contact Title | Contact Email | Pain Point | Hook | Priority | Source |

Priority `High` creates the briefing doc, files it in Drive, scans the primary calendar, and creates "Review pitch deck for [Company]". Other rows are still written to Sheets. A draft is created only when the hook cell has public text.

Google Tasks stores a due **date**, not a time. The task is due on the calendar date of the instant 48 hours after processing, in the script timezone. The exact UTC instant is written in the task notes.

A repeated delivery of the same `interactionId` returns `duplicate: true` and does not create a second set of rows. Briefing files, drafts, and tasks are also looked up by stable title before a second one is created.

## Failure behavior

| What happened | What to do |
| --- | --- |
| Process killed while polling | `RESUME_INTERACTION_ID` |
| Webhook rejected the payload | Fix Apps Script, then `REPORT_FILE=output/last-report.md` |
| Report had no table | The file is saved and the webhook is not called |
| One lead's geocode, doc, draft, or task failed | That row is still written. The Notes column and the JSON `errors` array carry the message |
| Script lock was busy | Response is `retryable: true`. Node retries the POST with backoff |
