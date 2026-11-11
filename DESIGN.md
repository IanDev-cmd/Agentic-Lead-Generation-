# Lead desk layout

The landing screen follows the Sequel gate in `HR.automata/index.html`: a full-bleed card, top brand and slide links, a vertical rail, a title and Enter button, and a bottom row of Workspace marks plus three batch thumbs. The photo file from that project is not in this repo, so the card uses the same frame with a dark scene behind the shade.

The desk follows `skanyingi/Alpha` at main `9086044`: dark stage, Outfit wordmark, white search pill, white tiles, and a white result card. Two Alpha pages are left out: Hazard and Alpha Agents. Their tiles, globes, and specialist cards are not in this desk.

Open `web/index.html`. Enter leaves the gate and opens the desk.

## 1. Information architecture and agent status

A batch is one research run. The desk never replaces the page with a spinner. The phase row stays visible: Planning, Searching, Drafting, Syncing to Sheets.

| Phase | What the person sees | What is actually happening |
| --- | --- | --- |
| Planning | Blue pill, "Planning the search" | Flash splits the ICP into three public queries, or Deep Research is building its plan |
| Searching | Blue pill, "Searching public sources" | Gemini Search grounding, or the Deep Research read loop |
| Drafting | Blue pill, "Drafting the briefing" | Markdown table and High-priority briefing |
| Syncing | Green pill after the webhook returns | Apps Script has appended the sheet rows |

Completed phases stay green. The current phase is the only one that pulses, and the pulse is removed when the system asks for reduced motion. A live region repeats the same sentence for assistive technology.

Rate limit, used when `gemini-2.5-flash` grounding hits its 500-request day cap: the Searching pill turns red, the heading says the batch stopped, and Resume continues from the saved notes. It does not start a second paid interaction.

Timeout, used when drafting exceeds the wait: the Drafting pill turns amber. Resume continues from drafting. The partial notes stay on the desk.

When Sheets confirms the rows, a dark toast sits at the bottom center: "Batch synced to Google Sheets. Northwind briefing is ready for review." The toast is also written to the live region. It does not steal focus. It leaves after about four seconds.

## 2. Dashboard layout

The gate is the only landing page. The desk is one workspace with these views:

| View | Alpha pattern it keeps | Lead-desk content |
| --- | --- | --- |
| Desk | Wordmark, search pill, tile grid | ICP, industry, region, max leads, route, PDF |
| Upload | Upload card | Local grounding PDF name only |
| Lead pipeline | Event queue card | Four columns: Discovered, Briefing created (Drive), Draft ready (Gmail), Action required (Tasks) |
| Google Workspace | Workspace card | Surface, state, and the reason text |
| Accounts | Exposure list | Company, domain, headquarters, distance |
| Pain points | Vulnerability list | Sourced pain, or a red negative match |
| Priority | Financial result table | High creates briefing, calendar link, and task. Low is a sheet row only |
| Territory | Map table, not the hazard globe | City group and coordinates |

The report is a split inside the result card. The left side is the markdown. The right drawer holds a source-mix bar chart and citation links. Bars are counts for this batch. Citations are real URLs from the report, opened in the same tab as normal links.

Bulk synthesis stays in the columns. The report opens for one company at a time, so a finished batch does not dump every briefing onto the home screen.

## 3. Human review

The Gmail draft is a textarea on the desk. Approving it marks the lead Draft ready and shows the toast that the draft was saved. The desk does not send mail. If the row is a negative match, Approve explains that no pitch was created.

Calendar and Tasks are not a second calendar UI. The Workspace table and the amber reason under the draft use the same sentence that Apps Script writes into the event description and the task notes. For a High row that sentence includes the 48-hour due date. For a negative match it says no task was created.

Quick actions sit on the lead card:

| Action | Result |
| --- | --- |
| Open report | One-company drawer |
| Re-research company | Queues a new batch and keeps the old row until the new sync |
| Approve pitch and clear task | Saves the draft and moves the card to Action required until the person sends it |
| Archive lead | Removes it from the active columns and does not delete Drive files |

## 4. Accessibility, color, and speed

Text on white uses `#202124`. Secondary text uses `#3c4043`, which stays above the WCAG 2.2 AA 4.5:1 ratio at 13px. Links and the avatar use `#174ea6` on white. High-intent tags use `#0d6b32` on `#e6f4ea`. Negative matches use `#8a1c1c` on `#fdecea`. Amber reasons use `#7a4e00` on `#fff8e1`. The bright `#0dd573` from the HR stylesheet is not used for text or small icons, because it fails on white.

The search pill and the High tag are the loudest elements. Tiles, columns, and tables stay neutral. Focus is a 2px `#174ea6` ring, or white on the dark gate. The phase pulse is the only motion, and it is disabled for reduced motion.

Type is Montserrat on the gate, Outfit for the desk wordmark, and Inter everywhere else. Titles are 18px semibold. Phase labels are 13px bold. Body copy is 14–16px at 1.5 line height.

Hazard and Alpha Agents stay out of the navigation, the tile grid, and the pipeline.
