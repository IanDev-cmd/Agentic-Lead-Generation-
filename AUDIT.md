# Integration and code audit

Scope: this repository only. No application code was changed. `render.yaml` is a new deploy blueprint, not a fix for the findings below.

Reviewed: `index.js`, `fallback/`, `apps-script/Code.gs`, `apps-script/appsscript.json`, `web/index.html`, `package.json`. `node_modules/` was excluded.

## Executive summary

**Health score: 46 / 100.**

The batch chain is real and careful: Node or Python posts a markdown report to Apps Script `doPost`, and Apps Script writes Sheets, Docs, Drive, a Gmail draft, Calendar notes, and a Task. Drafts are not sent. Formula-looking cells are prefixed. The webhook secret is compared in constant time and rejected when it is missing.

The desk the browser shows is not on that chain. `web/index.html` has no `fetch`, XHR, or other API client. Research, approve, and the Workspace drawers update local sample data and then announce a Google sync that did not happen. There is no Express, FastAPI, Nest, or Next server to attach the page to.

Critical blockers:

1. The UI and the pipeline do not share a route. A green toast is not evidence that Sheets or Gmail changed.
2. The Apps Script web app is anonymous and runs as the deploying user (`appsscript.json`). The shared secret is the only lock, and both CLIs also put that secret in the JSON body.
3. `npm start` is a one-shot process. A Render Web Service or Background Worker using that command will exit and be started again.

## Frontend-backend integration matrix

There is no first-party HTTP server. The only HTTP route implemented in this repo is the Apps Script web app. Callers below are the batch CLIs, not the browser.

### Fully connected routes

| Caller | Method and target | Callee | Payload |
| --- | --- | --- | --- |
| `index.js` `postWebhook` (lines 356–370) and the body at lines 448–456 | `POST` `GOOGLE_WEBHOOK_URL` | `doPost` in `apps-script/Code.gs` line 57 | `secret`, `interactionId`, `agent`, `generatedAt`, `query`, `seller`, `markdown`. Header `X-Webhook-Secret`. |
| `fallback/pipeline.py` `post_webhook` (lines 226–252) | `POST` the same URL | `doPost` | Same JSON shape and header. |
| `fallback/__main__.py` `_run_paid` (lines 63–70) | Process spawn of `node index.js` with `LEADGEN_ROUTE=paid` | `index.js` `main` | Environment only. Not an HTTP route. |

`doPost` then calls Sheets, Docs, Drive, Gmail drafts, Calendar, Tasks, and Maps inside Apps Script. Those are Google service calls, not routes defined here.

### Orphaned backend endpoints

| Endpoint | Why it is orphaned |
| --- | --- |
| `GET` `doGet` (`Code.gs` lines 46–54) | No caller in `index.js`, `fallback/`, or `web/index.html`. It returns whether the secret, spreadsheet, and folder are configured. |
| `install()` (`Code.gs` lines 68–80) | Editor function. Nothing in the repo invokes it. |
| Browser to `doPost` | The webhook has CLI callers. It has zero frontend callers. |

No other HTTP routes exist, so there is no unused Express or framework router.

### Broken frontend calls

`web/index.html` does not request a missing URL. The break is that the actions below claim a backend effect and never leave the page.

| UI action | What the page does | Missing route |
| --- | --- | --- |
| Research (`startRun` / `finishRun`) | Local timers, then a toast that the batch synced to Google Sheets | No `POST` to Node or Apps Script |
| Approve pitch (`act`, approve branch) | Sets the sample lead to `draft` and says the Gmail draft was saved | No `POST` to `doPost` or the Gmail API |
| Studio edge cards (Docs, Gmail, Sheets, Tasks, Maps) | Render local HTML into the drawer | No Workspace read API |
| Lead sheet, pipeline, accounts, territory pages | Render the two hardcoded leads | No sheet read API |

Add-source is not in this list. Its toast says the file stayed on the machine.

## Code quality and architecture findings

### Critical

- **UI and pipeline are separate programs.** `web/index.html` keeps leads in a page-local array (around line 981). `index.js` and `fallback/pipeline.py` are CLIs. Nothing binds a button to `postWebhook`.
- **Anonymous web app with owner privileges.** `apps-script/appsscript.json` lines 23–26 set `executeAs: USER_DEPLOYING` and `access: ANYONE_ANONYMOUS`. A caller who has `WEBHOOK_SECRET` can create Drive files, Gmail drafts, Calendar notes, and Tasks as the owner. `gmail.compose` is the right scope (the script uses `GmailApp.createDraft`, not send). The exposure is the anonymous execution identity, not a send scope.
- **Secret in the JSON body.** `index.js` lines 366 and 449 send `X-Webhook-Secret` and `payload.secret`. `fallback/pipeline.py` lines 233 and 248 do the same. `Code.gs` `providedSecret_` (lines 255–257) accepts either. A log, proxy, or Apps Script execution transcript of the body is enough to reuse the webhook.
- **One-shot start command.** `package.json` `start` is `node index.js`. The process returns after one batch. A restarting host will run it again. `render.yaml` uses a weekly cron and `DRY_RUN=true` so the blueprint itself does not loop a live run.

### Warning

- **`doGet` is public.** `Code.gs` lines 46–54 need no secret. They reveal whether the webhook secret and the Drive ids are set.
- **Auth failures are HTTP 200.** `json_` (line 283) cannot set a status. `doPost` returns `{ ok: false }` for a bad secret (lines 88–89). `index.js` lines 378–381 treat `body.ok === false` as failure, so the CLI is safe. Anything that only watches HTTP status will treat a rejected call as success. Apps Script also returns the caught exception message to the caller (lines 61–64).
- **Gmail search is built from lead text.** `Code.gs` line 626 strips quotes from the subject and interpolates it into `GmailApp.search`. Other search operators in a company or pain field still apply. This runs only after the secret check.
- **Task de-duplication is capped at 100.** `Code.gs` line 666. A task list longer than that can gain a second "Review pitch deck" task for the same company.
- **Desk HTML is not escaped on every path.** `drawerBody` uses `escapeHtml`. `card` (around lines 1380–1388), `renderReport` (line 1418), citations (line 1423), and the account, pain, priority, and map renderers (lines 1465–1474) assign lead fields with `innerHTML`. The current strings are hardcoded. The same functions become an XSS sink if they are later fed webhook markdown.
- **No shared type for a lead.** The markdown headers, `LEAD_HEADERS` in `Code.gs`, the Python record dict, and the desk object use different field names (`hqAddress` vs `hq`, `painPoint` vs `pain`). Nothing checks them against each other.
- **No tests.** Secret compare, formula prefix, route choice, and the 15-lead cap are untested.
- **Free tier cannot run on the Node cron image.** `shouldDelegate` in `index.js` (lines 401–405) spawns Python unless the run is a dry run, a replay, or `LEADGEN_ROUTE=paid`. `fallback/requirements.txt` is the unpinned name `google-genai`. Render's Node runtime does not provide that interpreter.
- **Seller copy is taken from the POST body.** `getConfig_` (`Code.gs` lines 271–275) prefers `payload.seller` over script properties. That is correct for the CLI and also lets a secret holder put arbitrary text into drafts.

### Optimization

- **Per-lead Workspace work is serial.** `handlePost_` (lines 144–164) geocodes, writes a Doc, searches Gmail, scans the calendar, and inserts a Task for each lead inside one Apps Script execution. The platform limit is about six minutes. The 15-lead cap and the 500-event slice (`Code.gs` line 577) reduce the damage. `getEvents` still loads the whole lookahead window before the slice.
- **The desk is one 1,500-line script.** State, simulated research, and layout cannot be tested or deployed apart from each other.
- **Quota state is a local file.** `fallback/quota.py` writes `output/grounding-quota.json`. Two cron machines would not share it. The current blueprint runs one cron, so this is latent.

What is in good shape: placeholder secrets are rejected; the webhook URL must be `https`; dry run skips Gemini; `BILLING_ENABLED` defaults off; `asCell_` (`Code.gs` lines 389–391) prefixes `=`, `+`, `-`, and `@`; idempotent runs return the earlier report when the interaction id is already `complete`; negative matches do not get a draft in the Apps Script lead processor; the desk ask box writes with `textContent`.

## Actionable recommendations

1. Add one HTTP boundary the desk can call, such as `POST /api/runs` and `GET /api/runs/:id` in front of the existing CLI. Keep Apps Script as the Workspace writer. Do not point the browser at `doPost` with the webhook secret.
2. Replace `startRun`, `finishRun`, and the approve toast with that API. Show the Apps Script `ok` and `error` fields. Leave the toast on the local sample path only when the server is unreachable and the label says so.
3. Delete `doGet`, or require the same secret as `doPost`. Stop copying `WEBHOOK_SECRET` into the JSON body in `index.js` and `fallback/pipeline.py`. Keep the header.
4. Escape every lead field before `innerHTML`, or render with `textContent`, before any remote markdown reaches the desk.
5. Quote or hash the Gmail draft lookup instead of interpolating the subject into `GmailApp.search`. Page through Tasks until the title is found or the list ends.
6. Add tests for `secretsMatch_`, `asCell_`, a duplicate `interactionId`, a missing table, and `shouldDelegate` for dry run versus free versus `LEADGEN_ROUTE=paid`.
7. Before setting the cron `DRY_RUN` to `false`, either install Python on that job or set `LEADGEN_ROUTE=paid` only when `BILLING_ENABLED=true`. Pin `google-genai` in `fallback/requirements.txt`.
8. Give the lead row one schema used by the markdown contract, Apps Script, and the desk. Generate the desk sample from a fixture that already passed `parseLeadTable_`.
