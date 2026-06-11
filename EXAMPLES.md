# Example prompts

A starter set of natural-language questions you can ask Claude once
the Capsule CRM connector is enabled. Pick whatever fits your work
and adapt the wording.

A few placeholders are used throughout — replace them with real
values when you ask:

- `$COMPANY` — an organisation in your CRM (e.g. a customer name)
- `$PERSON` — a contact's name
- `$TAG` — a tag you use (e.g. `VIP`, `Partner`, `Prospect`)
- `$PIPELINE` / `$STAGE` / `$MILESTONE` — names from your sales setup

You don't have to memorise these — Claude understands plain English.
The placeholders are just to keep the examples concrete.

> **Per-chat reminder.** The connector enables per-conversation, not
> per-Project. In a fresh chat, click the tools icon in the composer
> and turn on **Capsule CRM** before asking. Most "I don't have CRM
> tools" reports trace to skipping this step.

---

## People and companies

- Tell me what we know about $COMPANY.
- Who works at $COMPANY?
- Find the contact at $COMPANY whose name is $PERSON.
- List companies tagged $TAG.
- Show me companies in Germany / France / the UK.
- Which companies do we have no logged activity for at all?
- Find duplicates: are there two records for $COMPANY?
- Who owns the contact for $PERSON in our CRM?

## Recent activity and "what's new"

- Who's the most recently added company in our CRM?
- Which companies have we contacted in the last 14 days?
- What activity happened across the company today?
- What was logged into the CRM yesterday?
- Show me everything logged this week, with dates and authors.
- Who haven't we spoken to in over 90 days?
- What was the last note added to $COMPANY?
- Summarise the last five interactions with $COMPANY.
- Did anyone log a call or email about $COMPANY this week?

## Sales pipeline

- How many active deals do we have at each stage?
- What's the total expected value of deals at the $STAGE stage?
- Which deals are expected to close this month?
- Show me deals we've won in the last 90 days.
- List all lost deals from the last quarter, with the reason for each.
- What's the most common reason we lose deals?
- Which deals haven't moved stages in over 60 days?
- For deals in $PIPELINE, group them by milestone and count.
- Who are the additional companies (partners, consultants) linked
  to our biggest open deal?

## Projects and ongoing work

- List all open projects on the $BOARD board.
- Which projects are in the $STAGE stage right now?
- What support contracts are renewing in the next 60 days?
- Show me projects opened this month that have no owner.
- Are there any closed projects from last quarter I should review?
- Which projects are linked to the deal with $COMPANY?

## Tasks and to-dos

- What open tasks are assigned to me?
- List overdue tasks across the team.
- Show me the five tasks I most recently completed.
- What tasks did Claude or a workflow auto-create this week?
- Look up these specific tasks I'm tracking. (paste task references)

## Workflows (tracks)

- What workflow templates do we have configured?
- Which workflows are running on $COMPANY's project right now?
- What tasks does the "Onboarding" workflow create?
- Are any active workflows incomplete and overdue?

## Audit and changes

- Which contacts were deleted since the start of the month?
- Were any deals deleted this quarter? Which ones?
- Show me all projects deleted in the last 30 days.

## Setup and reference

- Which Capsule account is the connector connected to?
- What teams exist in our setup?
- List our pipelines and the milestones inside each.
- What boards do we have for projects, and what stages are on each?
- What custom fields are defined on contacts? On deals? On projects?
- What categories can we tag activity with?
- Do we have any sales goals configured?
- What tags do we use on contacts?

## Cross-references and small reports

- For the top five most-recently-contacted customers, list their
  open deals and active projects.
- Show me everyone who came in as a new contact this month and is
  also linked to an open deal.
- Cross-reference: which renewal-queue customers haven't been
  contacted in 60+ days? (potential at-risk renewals.)
- Group contacts by owner and count — who owns the most?
- Which deal owners have left? We may need to reassign.

## Saved searches

- What saved filters do we already have for contacts?
- Run our "Newest first" saved filter and show me the top 10.
- Are there any saved filters for deals worth running today?

## Files / attachments

- Show me the attachment with id NNN. (image attachments are
  rendered inline; text files are decoded; PDFs and other binaries
  return as metadata + base64 for downstream tools.)
- Read the screenshot attached to the most recent note on $COMPANY.
- Upload this PDF as a note on $COMPANY. (paste base64 contents
  along with filename and content type — practical only for small
  files, a few tens of KB: the base64 must pass through the model
  as tool-call output, so large files exceed the model's output
  budget long before the connector's 25 MB limit. Files attached in
  the chat composer are NOT visible to MCP connectors. See DESIGN.md
  L9.)

## Quick diagnostics

- Is the CRM connector working? Which account am I connected to?
- What can you do with our CRM, exactly? List your capabilities.

---

## Tips for getting good answers

- **Be specific about time windows.** "In the last 30 days" works
  better than "recently."
- **Disambiguate "most recent."** It can mean newly added, newly
  contacted, or newly won — say which.
- **Ask for cited details.** "Include dates and owner names so I
  can verify in the CRM" gets you a checkable answer.
- **Combine queries.** Asking "summarise the last 5 entries on
  $COMPANY and list their open deals" is one chat turn, two tool
  calls — faster than asking separately.
- **Trust the field, but caveat.** Claude reports "last contacted"
  dates from what's logged in your CRM. If conversations happen in
  email or chat without being captured back, the date won't reflect
  them — Claude will flag that explicitly when relevant.

## What the connector can't do (yet)

- **Sort arbitrarily.** Capsule's API doesn't support ad-hoc sort.
  Claude works around this with date-bounded filters and saved
  filters (sort gets configured once when you create the filter in
  Capsule's web UI). For ranked reports you run repeatedly, set up a
  saved filter once.
- **Edit settings.** Pipelines, stages, custom fields, tags, teams —
  these are admin-managed in Capsule's web UI, not from chat.
