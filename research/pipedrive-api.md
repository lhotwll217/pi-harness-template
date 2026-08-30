# Pipedrive API access for an agent working the lead system of record

Research ticket resolved 2026-08-29 against Pipedrive primary sources
(developers.pipedrive.com API reference and OpenAPI specs, pipedrive.readme.io
developer docs, developers.pipedrive.com/changelog, support.pipedrive.com).
Every claim carries its source URL; unconfirmed points are flagged inline and
collected at the end. Scope matches the harness's actual surface: create/find
persons, create deals in the default pipeline/stage, attach notes, read records.
No email sending, no automated stage moves.

## Summary verdict

Pipedrive is a low-friction fit for a single-tenant server-side agent. Use the
**company API token** (a per-user credential passed as an `x-api-token` header)
rather than OAuth — OAuth is for Marketplace apps, and Pipedrive's own docs
draw exactly that line. Target **API v2 endpoints** (`/api/v2/...`) for
persons, deals, search, pipelines, and stages: v2 is the current standard,
consumes roughly half the rate-limit tokens of v1, and the matching v1
endpoints were formally deprecated with support ending after 2025-12-31 (full
v1 retirement of migrated endpoints announced for 2026-07-31 by downstream
vendors). **Notes have no v2 endpoint** — `POST /api/v1/notes` remains the
supported path and is not on the deprecation list. Notes take HTML content up
to ~100,000 characters (~100 KB), ample for multi-paragraph ICP rationale.
`POST /api/v2/deals` requires only `title`; with `stage_id`/`pipeline_id`
omitted the deal lands in the first stage of the default pipeline — exactly the
MVP behavior wanted. Rate limits use a daily token budget (30,000 base tokens ×
plan multiplier × seats); even the cheapest plan with one seat covers on the
order of 750 full lead intakes per day, so quota is a non-issue at consultancy
scale. A free 5-seat developer sandbox company is available by application, but
it assumes you are building a Marketplace app and is deleted if you never
create one — for a single-tenant internal agent, testing against a dedicated
pipeline in Softlandia's real account (or a regular trial account) may be more
honest.

## 1. Auth model

- Two methods exist: **OAuth 2.0** "for creating apps in the marketplace" and
  the **API token** "for direct integrations." A single-tenant server-side
  agent is squarely the second case.
  Source: https://pipedrive.readme.io/docs/core-api-concepts-authentication
- The API token is **per-user, per-company**: "an API token is tied to a
  specific user and company, giving access to all user's data." One active
  token per user at a time; rotating it breaks every integration using it.
  There is no company-wide service token — actions performed with a token are
  attributed to (and limited by the permissions of) the user who owns it.
  Source: https://pipedrive.readme.io/docs/core-api-concepts-authentication
- Transport: the token goes in the **`x-api-token` request header** (the
  OpenAPI spec defines the `api_key` security scheme as
  `apiKey, name: x-api-token, in: header`).
  Sources: https://pipedrive.readme.io/docs/core-api-concepts-authentication,
  https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
- OAuth, if ever needed, is authorization-code flow against
  `https://oauth.pipedrive.com/oauth/authorize` with granular scopes (e.g.
  `deals:read`, `deals:full`, `contacts:full`) — relevant only if the harness
  is later productized for other Pipedrive companies.
  Source: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  (per-endpoint `security` blocks),
  https://pipedrive.readme.io/docs/marketplace-oauth-authorization
- Practical implication: create (or designate) a Pipedrive user for the agent
  and use that user's API token, so agent-created records are attributed
  distinctly and the token's blast radius is that user's permission set.
  (Inference from the per-user token model above, not a Pipedrive
  recommendation.)

## 2. Core endpoints and shapes

All v2 endpoints live under `https://{company}.pipedrive.com/api/v2/...`, use
cursor pagination (`cursor` + `limit`, max 500/page), PATCH instead of PUT,
strict types (`true`/`false` booleans, RFC 3339 timestamps), and nest custom
fields under a `custom_fields` object.
Source: https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide

### Persons

- **Create**: `POST /api/v2/persons`. Required: `name`. Contacts go in plural
  array fields — `emails` / `phones`, each entry `{value, primary, label}`
  (renamed from v1's singular `email`/`phone`). Optional: `owner_id`,
  `org_id`, `visible_to`, `label_ids`, `custom_fields`.
  Sources: https://developers.pipedrive.com/docs/api/v1/Persons,
  https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide
- **Find**: `GET /api/v2/persons/search` with `term` (min 2 chars, or 1 with
  `exact_match=true`); searches name, email, phone, notes, and custom fields;
  filterable by `organization_id`. `exact_match` is case-insensitive full
  matching — use it with the email address for find-or-create idempotency.
  Source: https://developers.pipedrive.com/docs/api/v1/Persons

### Deals

- **Create**: `POST /api/v2/deals`. Required: `title` only. Optional:
  `person_id`, `org_id`, `owner_id`, `value`, `currency`, `stage_id`,
  `pipeline_id`, `status`, `expected_close_date`, `custom_fields`.
  Source: https://developers.pipedrive.com/docs/api/v1/Deals
- **Default-stage behavior — confirmed.** The v2 OpenAPI spec states for
  `stage_id`: "If omitted, the deal will be placed in the first stage of the
  default pipeline." And for `pipeline_id`: "By default, the deal will be
  added to the first stage of the specified pipeline. Please note that
  `pipeline_id` and `stage_id` should not be used together as `pipeline_id`
  will be ignored."
  Source: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  (AddDeal request schema)
- **Find**: `GET /api/v2/deals/search` with `term` (searches title, notes,
  custom fields), filterable by `person_id`, `organization_id`, `status`;
  2000-result cap per filter type.
  Source: https://developers.pipedrive.com/docs/api/v1/Deals

### Notes (v1 — no v2 exists)

- **Attach to a deal**: `POST /api/v1/notes` with `content` (required) and
  `deal_id` (one of `deal_id`/`person_id`/`org_id`/`lead_id`/`project_id`/
  `task_id` is required). Optional pinning via `pinned_to_deal_flag` (0/1).
  Listing: `GET /api/v1/notes?deal_id=...` (offset pagination, v1-style).
  Update: `PUT /api/v1/notes/{id}`.
  Source: https://developers.pipedrive.com/docs/api/v1/Notes

### Pipelines and stages (read)

- `GET /api/v2/pipelines` — all pipelines; fields per pipeline: `id`, `name`,
  `order_nr`, `is_deleted`, `is_deal_probability_enabled`, `add_time`,
  `update_time`. Costs 5 tokens.
- `GET /api/v2/stages` — all stages; fields: `id`, `name`, `order_nr`,
  `pipeline_id`, `deal_probability`, `is_deal_rot_enabled`, `days_to_rotten`,
  `is_deleted`. Costs 5 tokens. Sort stages by `pipeline_id` + `order_nr` to
  reconstruct board order.
  Sources: https://developers.pipedrive.com/docs/api/v1/Pipelines,
  https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
- Note the v2 pipeline object has **no `is_default` flag** in the spec's
  response schema — "default pipeline" is what deal creation falls back to,
  but identifying it via the read API is not obvious (ambiguity below). For
  the MVP this does not matter: omit `stage_id` and let Pipedrive place the
  deal.

## 3. Rate limits — the token-budget model

Pipedrive rate-limits API-token and OAuth traffic with a **daily token
budget** shared by all users in the company account (this is a metering
"token," unrelated to the auth token):

- **Formula: 30,000 base tokens × plan multiplier × number of seats**
  (+ optional purchased top-ups), per day.
- **Plan multipliers** (current plan names): Lite ×1, Growth ×2, Premium ×5,
  Ultimate ×7.
- **Per-request costs** (docs' summary table): get single entity 2, get list
  20, update 10, delete 6, search 40 — with "available API v2 endpoints ...
  performance-optimized, resulting in lower token costs compared to the
  original v1 endpoints." The OpenAPI specs pin exact per-endpoint costs
  (`x-token-cost`): v2 create person/deal 5 each, get single 1, list 10,
  search 20, pipelines/stages list 5; v1 note create 10, note list 20.
- **Burst limits** per user on a rolling 2-second window (API token):
  Lite 20, Growth 40, Premium 100, Ultimate 120 requests/2 s (OAuth apps get
  4× these). Search endpoints: 10 requests/2 s on all plans.
- Exhausted budget → **HTTP 429** for the rest of the day; warnings at 75% and
  100%. Headers: `x-ratelimit-limit`, `x-ratelimit-remaining`,
  `x-ratelimit-reset`, and `x-daily-requests-left` (API-token traffic).
  Sources: https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting,
  https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml,
  https://developers.pipedrive.com/docs/api/v1/openapi.yaml
- Plan-name mapping: Pipedrive consolidated its former five plans into four in
  2025 — Essential→Lite, Advanced→Growth, Professional and Power→Premium,
  Enterprise→Ultimate — so whatever legacy tier Softlandia is on maps onto the
  multiplier table above.
  Source: https://support.pipedrive.com/en/article/new-pipedrive-plans
- **Headroom arithmetic** for this harness: one full lead intake ≈ person
  search (20) + create person (5) + create deal (5) + create note (10) = 40
  tokens. Worst case (Lite, 1 seat, 30,000/day) that is ~750 intakes/day —
  two to three orders of magnitude above a consultancy's lead volume. The
  budget is shared with every other integration on the account (Zapier, sync
  tools), so the agent should still back off on 429, but quota will not
  constrain design.

## 4. Sandbox / test options

- A free **developer sandbox account** exists: a regular Pipedrive company
  limited to 5 seats, with Developer Hub access and importable sample-data
  spreadsheets. Request it via the form at
  https://developers.pipedrive.com/ .
  Source: https://pipedrive.readme.io/docs/developer-sandbox-account
- Retention condition: the sandbox is deleted unless you **create an app
  within 45 days** of signup or take a public/private app live within 6
  months. It is built for Marketplace app developers; a token-only internal
  integration technically never "creates an app." A private app registration
  in the sandbox's Developer Hub would satisfy the condition, but the simpler
  MVP path is a dedicated test pipeline in the production account or a
  throwaway trial company.
  Source: https://pipedrive.readme.io/docs/developer-sandbox-account

## 5. Notes constraints (ICP rationale storage)

- **Format: HTML.** `content` is "the textual content ... in HTML format,"
  "subject to sanitization on the back-end" — so send `<p>`, `<b>`, `<ul>`
  etc.; disallowed markup is stripped server-side rather than rejected. Plain
  paragraphs wrapped in `<p>` tags are the safe baseline.
  Sources: https://developers.pipedrive.com/docs/api/v1/Notes,
  https://developers.pipedrive.com/docs/api/v1/openapi.yaml
- **Size: ~100,000 characters (~100 KB) per note** ("The maximum note size is
  approximately 100,000 characters (or 100KB per note)" — the v1 spec's Notes
  section). Multi-paragraph qualification rationale fits with two orders of
  magnitude to spare; there is no documented per-deal note count limit.
  Source: https://developers.pipedrive.com/docs/api/v1/openapi.yaml (Notes
  tag description)
- Notes are display-ordered newest-first in the deal timeline; a note can be
  pinned to the deal (`pinned_to_deal_flag`) to keep the qualification
  rationale at the top.
  Source: https://developers.pipedrive.com/docs/api/v1/Notes

## 6. API versioning status

- **v2 is the current standard** with coverage for exactly the entities this
  harness touches: Deals, Persons, Organizations, Activities, Products,
  Pipelines, Stages, Search, plus field-definition endpoints. Changes vs v1:
  `/api/v2/` prefix, cursor pagination, PATCH, strict booleans/numbers,
  RFC 3339 timestamps, `custom_fields` nesting, plural `emails`/`phones`,
  `owner_id` instead of `user_id`, `is_deleted` replacing `active_flag`.
  Source: https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide
- **The matching v1 endpoints are formally deprecated.** Pipedrive's changelog
  lists the deprecated v1 sets — Activities, Deals, Persons, Organizations,
  Products, Pipelines, Stages, item Search — accessible only until
  **2025-12-31**, after which "their availability and functionality will no
  longer be guaranteed"; a community reminder marks them out of support as of
  2026-08-01. Downstream platforms (Make, Zapier) cite a hard v1 transition
  deadline of **2026-07-31**. An MVP must not use v1 for any entity that has
  a v2 equivalent.
  Sources:
  https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints,
  https://devcommunity.pipedrive.com/t/reminder-deprecated-api-v1-endpoints-are-now-out-of-support/20466,
  https://help.make.com/pipedrive-api-v1-to-v2-transition-by-july-31-2026
- **Notes are not in the deprecation list and have no v2 endpoint** — the v2
  OpenAPI spec contains no `/notes` path. `POST /api/v1/notes` is the
  supported, non-deprecated way to attach a note.
  Sources: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
  (path inventory),
  https://developers.pipedrive.com/changelog/post/deprecation-of-selected-api-v1-endpoints
- Leads exist as a separate v1 entity (with a v2 search endpoint only); this
  harness's model of "deal in first stage = new lead" avoids the Leads inbox
  entirely, which is fine — deals created via API are full CRM records from
  the start.
  Source: https://developers.pipedrive.com/docs/api/v1/Leads

## 7. Official MCP server (addendum, 2026-08-30)

Pipedrive ships a **native, first-party MCP server** (launched 2026; in
Claude's official connector marketplace since 2026-08-18). It connects over
**OAuth** — no token or server URL configuration — and exposes read/write
tools over deals, contacts/organizations, pipelines, activities, and notes,
scoped by the connecting Pipedrive user's own permissions. No official CLI
exists; community MCP servers (self-hosted, token-auth) also exist but are
redundant next to the native one.
Sources: https://www.pipedrive.com/en/features/mcp-server,
https://support.pipedrive.com/en/article/mcp,
https://www.pipedrive.com/en/newsroom/pipedrive-mcp-connector-is-now-available-in-claudes-official-marketplace

**Implication for the spec**: there are now two integration paths, and they
serve different runtimes rather than competing:

- **Native MCP** — zero-build, OAuth, permission-scoped. The right path
  wherever the runtime speaks MCP (Claude.ai / Claude Code connectors; the
  harness itself *if* Pi's tool surface can mount a remote MCP server — an
  open template question, since the inventory found no third-party API seam
  at all).
- **REST + API token** (the body of this document) — the path for
  harness-native specialized tools, scheduled/headless runs where an OAuth
  browser flow is unavailable, and anywhere tool shape must be pinned by the
  bundle rather than inherited from Pipedrive's MCP tool list.

The spec should prefer the native MCP where the runtime supports it and keep
the REST facts here as the fallback contract; the choice lands with the
specialized-tools section of the buildable spec (#12), gated on whether the
harness can consume remote MCP servers.

## Recommendation for the MVP spec

- **Auth**: company API token of a dedicated agent user, sent as
  `x-api-token`; store it as a single server-side secret. No OAuth.
- **Endpoints**: v2 for persons, deals, search, pipelines, stages
  (`POST /api/v2/persons`, `GET /api/v2/persons/search?term=<email>&exact_match=true`,
  `POST /api/v2/deals` with `title` + `person_id` only — omit `stage_id` and
  rely on the documented first-stage-of-default-pipeline placement,
  `GET /api/v2/pipelines`, `GET /api/v2/stages`); v1 only for
  `POST /api/v1/notes`.
- **Quota**: assume effectively unconstrained (~40 metering tokens per lead
  intake against ≥30,000/day even on Lite×1 seat); implement 429 backoff and
  read `x-daily-requests-left`, nothing more.
- **Notes**: store qualification rationale as HTML (`<p>`-wrapped
  paragraphs), one note per qualification event, pinned to the deal; treat
  100 KB as the ceiling.
- **Testing**: prefer a dedicated pipeline in the real Softlandia account or a
  trial company over the developer sandbox unless a Developer Hub app will
  actually be registered.

## Ambiguities and unconfirmed items

- **Identifying the default pipeline via the read API**: the v2 pipeline
  response schema exposes no `is_default` field, and the docs do not say how
  the "default pipeline" used by deal creation is determined (lowest
  `order_nr` is the plausible but unconfirmed rule). The MVP sidesteps this
  by omitting `stage_id`.
  Source: https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml
- **HTML sanitization whitelist for notes**: "subject to sanitization" is
  stated, but the allowed tag set is not documented anywhere found; verify
  empirically which tags survive before committing to rich formatting.
- **Legacy-plan token multipliers**: the rate-limiting page publishes
  multipliers only for the current Lite/Growth/Premium/Ultimate names; the
  mapping from legacy plans (Essential/Advanced/Professional/Power/Enterprise)
  is documented for features/pricing, and legacy Professional vs Power may
  differ in effective multiplier — check the account's actual
  `x-daily-requests-left` once credentials exist.
  Sources: https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting,
  https://support.pipedrive.com/en/article/new-pipedrive-plans
- **v1 hard-shutdown date**: Pipedrive's own changelog gives 2025-12-31 as end
  of guaranteed availability for the selected endpoints; the 2026-07-31 "all
  v1" date comes from Make/Zapier help pages describing Pipedrive's plans, not
  from a pinned Pipedrive changelog entry found during this research. Either
  way, v2-first makes the question moot for this harness except for Notes,
  which are not deprecated.
