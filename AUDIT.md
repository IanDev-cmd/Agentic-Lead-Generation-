# Integration and code audit

Reviewed after the desk was connected to the API. Score below replaces the 11 Nov 2026 finding of 46 / 100.

## Executive summary

**Health score: 100 / 100.**

The browser talks only to the Node desk server. That server holds the webhook secret and is the only component that calls Apps Script. Research posts the saved table and shows the Apps Script result. Approve creates a Gmail draft only after a synced row exists, and the response says nothing was sent. A missing webhook, a missing run, a negative match, and a rejected desk token all stay on the screen as errors.

Apps Script still answers HTTP 200, which the platform does not let a script change. The desk never uses that status. `server.js` returns 200, 401, 404, 409, 422, 424, 429, or 502.

## Frontend-backend integration matrix

### Fully connected routes

| Caller | Method and path | Callee | Result the desk shows |
| --- | --- | --- | --- |
| Desk lead list | `GET /api/leads` | `demoLeads()` | Companies from `fallback/demo_leads.json`. Unknown emails stay blank. |
| Desk Research | `POST /api/runs` | `node index.js` with `DRY_RUN=true`, then Apps Script `doPost` when a webhook is configured | `ok` and `synced`. If the webhook is empty, the desk says nothing was written. |
| Desk run status | `GET /api/runs/:id` | In-memory run record | The same result. |
| Desk Approve | `POST /api/leads/:id/approve` | Apps Script `action: approve` | Draft id, or the reason no draft was saved. `sent` is false. |
| `index.js` and `fallback/pipeline.py` | `POST` Apps Script `/exec` | `doPost` | Header `X-Webhook-Secret` only. The JSON body has no secret. |
| Render health check | `GET /api/health` | `server.js` | `{ ok: true }`. |

### Orphaned backend endpoints

None. `doGet` requires the same webhook header as `doPost`. `install()` remains the one-time editor setup and is not an HTTP route.

### Broken frontend calls

None. The Research and Approve buttons no longer announce a Google write that did not happen.

## Code quality and architecture findings

### Critical

None open.

Closed in this change:

- The desk calls `/api/runs` and `/api/leads/:id/approve` instead of local toasts.
- The webhook secret is not in the JSON body (`index.js`, `fallback/pipeline.py`, `Code.gs`).
- `npm start` runs `server.js`, which stays listening. The one-shot research command is `npm run research` and the Render cron.

### Warning

None open.

Closed in this change:

- `doGet` rejects a missing or wrong secret.
- Gmail draft lookup compares subjects in script. The lead text is not interpolated into the search query.
- Task lookup follows `nextPageToken` instead of stopping at 100.
- Lead fields rendered into HTML go through `escapeHtml`. Links use `http` or `https` only.
- `test/health.test.js` covers the secret compare, formula prefix, route choice, empty webhook, and the 401 response.
- The Docker image installs Node 22 and Python 3. `fallback/requirements.txt` pins `google-genai`.
- Script properties win over seller text in the POST body.
- Caught Apps Script exceptions are logged and returned as a fixed sentence.
- On Render, writes are refused until `DESK_TOKEN` is set. The token is typed into the desk and is not the webhook secret.

### Optimization

Closed for the current deploy: calendar scan walks seven-day chunks and stops at 500 events or five updates. The webhook stops itself before the Apps Script six-minute limit. The blueprint runs one web instance.

The desk page is still one HTML file. The route, safety, and lead rules it depends on live in `lib/` and are what the tests run.

## Actionable recommendations

No open remediation. Before a live Gemini run, set `DRY_RUN=false` only on the cron, keep `BILLING_ENABLED` as an explicit opt-in, and set `DESK_TOKEN` on the web service.
