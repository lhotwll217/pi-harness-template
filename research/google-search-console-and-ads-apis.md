# Agent access to Google Search Console and Google Ads data

Research ticket resolved 2026-08-29 against primary Google sources (developers.google.com,
cloud.google.com, support.google.com). Every claim carries its source URL; unconfirmed points
are flagged inline and collected at the end.

## Summary verdict

Search Console is cheap to integrate and belongs in a first version: it is a plain REST API
behind ordinary OAuth 2.0, a service-account credential works in practice by adding the service
account's email as a user on the property (a widely used pattern, though Google's Search Console
docs never state it explicitly — see "Not confirmed"), quotas are generous for consultancy-scale
use (1,200 queries/min per site), and the Search Analytics endpoint returns up to 25,000 rows per
request with pagination. Its known limits — ~16-month rolling retention, ~2-day finalization lag,
top-rows-only sampling — are properties of the data, not the integration. Google Ads is a
different animal: before the first production API call you need a Google Ads **manager account**,
a **developer token** application reviewed by Google's compliance team, and (beyond the
auto-granted Explorer level) a Basic/Standard access-level application with stated review times of
5–10 business days, brand-verification of the Cloud project in some cases, and a live company
website. The reporting surface (GAQL) is excellent once you're in, and a reporting-only or
internal-use tool escapes most Required Minimum Functionality obligations, but the application
friction and contractual surface (Google may audit the tool, terminate at will, and imposes data
protection duties) make it poor fit for an MVP. **Recommendation: ship Search Console in the first
version; defer Google Ads.** If Ads numbers are needed early, the BigQuery Data Transfer Service
for Google Ads is the sanctioned low-friction path — scheduled daily loads of the standard Ads
reports into BigQuery with no developer token application by you — at the cost of daily (not
on-demand) freshness and BigQuery/transfer pricing.

## 1. Search Console API

### Auth model

- All requests to the Search Console API must be authorized via **OAuth 2.0**; "no other
  authorization protocols are supported." Scopes are
  `https://www.googleapis.com/auth/webmasters` (read/write) and
  `https://www.googleapis.com/auth/webmasters.readonly` (read-only).
  Source: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
- The same page notes OAuth 2.0 credentials can be generated "for web applications, **service
  accounts**, or installed applications" (stated in the Testing Tools section, but service
  accounts are a standard Google OAuth 2.0 credential type).
  Source: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
- **Can a service account be added to a GSC property?** Google's Search Console documentation does
  not explicitly say so anywhere I could find. In practice the standard pattern is to add the
  service account's email address as a user on the property in Search Console's user management
  (Settings → Users and permissions), after which the service account's self-signed OAuth flow
  works without any human consent screen. This is exactly the pattern Google documents for
  Google Ads ("add the service account email as a user in your Google Ads account",
  https://developers.google.com/google-ads/api/docs/oauth/service-accounts), but the equivalent
  Search Console statement is absent from the primary docs. Treat as very-likely-works /
  verify-in-spike. See "Not confirmed" below.
- Practical consequence for an agent/harness: either (a) service account added as a restricted
  user per property — no token refresh UX, survives staff turnover; or (b) a normal OAuth client
  with a stored refresh token for a human who has property access.

### Search Analytics query endpoint

`POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`
Source for everything in this subsection:
https://developers.google.com/webmaster-tools/v1/searchanalytics/query

- **Metrics returned per row:** `clicks`, `impressions`, `ctr`, `position`.
- **Dimensions (group-by):** `country`, `device`, `page`, `query`, `searchAppearance`, plus
  `date` and `hour`. Any number of dimensions may be combined (no repeats).
- **Filters:** by any dimension, with operators `equals`, `notEquals`, `contains`, `notContains`,
  `includingRegex`, `excludingRegex` (RE2 syntax); filter groups are AND-combined.
- **Search types:** `web` (default), `image`, `video`, `news`, `googleNews`, `discover`.
- **Row limits:** `rowLimit` valid range 1–25,000 per request (default 1,000); paginate with
  `startRow`. The API "is bounded by internal limitations of Search Console and does not
  guarantee to return all data rows but rather top ones" — i.e. long-tail queries are withheld
  (anonymized/privacy-filtered), so totals from row sums undercount true totals.
- **Freshness / lag:** by default only **finalized** data is returned; `dataState: "all"` includes
  fresh (still-changing) data and `dataState: "hourly_all"` adds an hourly breakdown, with a
  `metadata.first_incomplete_date` / `first_incomplete_hour` marker for where data is still
  incomplete. Dates are in Pacific time.
- **Finalization lag:** "Normally... collected data should be available in 2-3 days."
  Source: https://support.google.com/webmasters/answer/96568
- **Retention:** "Search Console keeps data for the last 16 months."
  Source: https://support.google.com/analytics/answer/10737381 (Google's own GA4–Search Console
  integration page; the same page states data is available "48 hours after it is collected").
  Consequence: if longer history matters, the harness must archive on a schedule (or use the
  Search Console Bulk Data Export to BigQuery).
- **Sampling caveat:** Search Console "stores top data rows and not all data rows" and omits
  rare/privacy-sensitive queries. Source: https://support.google.com/webmasters/answer/96568

### Quotas

Source: https://developers.google.com/webmaster-tools/limits

- Search Analytics: per-site **1,200 QPM**; per-user **1,200 QPM**; per-project **40,000 QPM /
  30,000,000 QPD** — plus internal "load" quotas (short-term 10-minute and long-term 1-day
  windows). Queries grouped/filtered by page AND query string, and long date ranges, are the
  expensive ones.
- URL Inspection: per-site 600 QPM / 2,000 QPD; per-project 15,000 QPM / 10,000,000 QPD.
- All other resources: per-user 20 QPS / 200 QPM.
- Verdict: quotas are a non-issue for a consultancy-scale nightly sync; only careless
  page×query×long-range re-querying hits load limits.

## 2. Google Ads API

### What access requires today

- A **developer token** (22-character key) obtained from the **API Center of a Google Ads manager
  account** — so a manager (MCC) account is a prerequisite. Application requires a company name
  and functioning company URL and a monitored API contact email; Google's compliance team may
  reach out and rejects applications with dead websites. Generally one token per company.
  Source: https://developers.google.com/google-ads/api/docs/get-started/dev-token
- **Access levels** (source: https://developers.google.com/google-ads/api/docs/access-levels):
  - **Test Account Access** — test accounts only; 15,000 ops/day. Granted on sign-up when Google
    can't auto-review.
  - **Explorer Access** — test + production accounts, 2,880 ops/day on production; may be granted
    automatically at sign-up. "Sufficient for most developers to get started" but restricts some
    features.
  - **Basic Access** — 15,000 ops/day; apply via the API Center; **reviews typically take 5
    business days**; Google may require **brand verification of the linked Google Cloud
    project** before processing.
  - **Standard Access** — unlimited ops/day; **reviews typically take 10 business days**; the
    Required Minimum Functionality (RMF) policy applies at this level.
- **Approval friction in practice:** the application chain is manager account → token sign-up →
  (possibly) Explorer auto-grant → Basic application with brand verification → email
  back-and-forth with the compliance team. Also, tools used by external users "must be prepared
  to provide demo sign-in access" during review.
  Source: https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- **RMF exposure:** RMF applies only to **Standard Access** tokens; reporting-only tools carry
  only the Reporting RMF; **internal-use-only tools are exempt entirely**; tools that fit within
  Basic Access (<15,000 requests/day) are exempt.
  Sources: https://developers.google.com/google-ads/api/docs/rmf ,
  https://developers.google.com/google-ads/api/starter-checklist ,
  https://support.google.com/adspolicy/answer/6169371

### Auth model

- OAuth 2.0, same as other Google APIs, **plus** the developer token header on every call.
  Source: https://developers.google.com/google-ads/api/docs/oauth/overview
- **Service accounts are first-class**: create a service account, download the JSON key, and
  "add the service account email as a user in your Google Ads account with the appropriate
  access level" (Admin → Access and security). Recommended by Google for apps managing accounts
  you already have access to; no domain-wide delegation needed for this path.
  Source: https://developers.google.com/google-ads/api/docs/oauth/service-accounts

### Reporting data (GAQL)

Source: https://developers.google.com/google-ads/api/docs/query/overview

- The Google Ads Query Language queries resources (`campaign`, `ad_group`, `keyword_view`, …)
  with their attributes, **metrics** (`metrics.impressions`, `metrics.clicks`, cost, conversions,
  …) and **segments** (`segments.date`, `segments.device`, …), via `GoogleAdsService`
  `Search`/`SearchStream`; SQL-like SELECT/FROM/WHERE/ORDER BY/LIMIT with date-range predicates
  like `segments.date DURING LAST_30_DAYS`. Implicit joins to attributed resources;
  `GoogleAdsFieldService` provides the field catalog. Everything the Ads UI reports is reachable.

### Practical for a small consultancy's v1?

No. The reporting surface is strong, but the entry cost — manager account, token application with
compliance review, access-level applications measured in business days, possible brand
verification, plus a contract that lets Google audit the tool and imposes explicit data-protection
duties (see section 4) — is out of proportion for an MVP whose Ads needs are "show the client
their spend and conversions." Defer to a later iteration (as an internal-use-only tool at
Basic/Explorer access, the policy burden is modest), and cover early Ads needs with the BigQuery
transfer below.

## 3. Simpler Google-offered alternatives for Ads reporting

- **BigQuery Data Transfer Service for Google Ads** — Google's managed connector schedules
  recurring (max once per 24h) loads of the standard Google Ads API reports into date-partitioned
  BigQuery tables; configurable refresh window up to 30 days (default 7) re-fetches recent days;
  backfills reach as far as Ads data retention allows; up to 8,000 customer IDs per manager
  account. Setup is authorization + configuration in the Cloud console — **no developer token
  application by the consultancy**. Limitations: daily cadence only, full-day overwrites (no
  incremental transfer).
  Source: https://cloud.google.com/bigquery/docs/google-ads-transfer
- The agent then reads from BigQuery (its own store, effectively), sidestepping the Ads API's
  access-level machinery for reporting. Costs are BigQuery storage/query pricing rather than API
  quota.
- Analogous note for GSC: Search Console offers a **Bulk Data Export** to BigQuery for
  unlimited-row, long-horizon performance data (referenced in Google's data-anomalies page,
  https://support.google.com/webmasters/answer/6211453, which discusses "Bulk data exports");
  worth evaluating if the 25,000-row / 16-month API limits ever bind.
- I found no Google-offered scheduled CSV export API for Ads; the UI's emailed/scheduled reports
  exist but are not a machine-readable contract worth building on (not verified against a primary
  page — see "Not confirmed").

## 4. Terms-of-service constraints on storing/serving the data in your own store

- **Google APIs Terms of Service** (governs Search Console API):
  https://developers.google.com/terms — key obligations: access only by documented means with
  your own credentials, never misrepresenting the client's identity (§2c); do not circumvent
  enforced limits (§2d); comply with privacy law and any API-specific additional terms, which
  control on conflict (preamble, §2b). Nothing in the fetched text prohibits storing your own
  (or a consenting client's) Search Console data in your own datastore; the constraint is the
  user-consent and privacy sections plus API-specific policy. (I did not exhaustively review the
  full ToS text — the fetch was truncated before Sections 3–9; flagged below.)
- **Google Ads API Terms and Conditions**:
  https://developers.google.com/google-ads/api/docs/api-policy/terms — key clauses affecting a
  store-and-serve design:
  - Use is subject to the **Google Ads API policies**
    (https://support.google.com/adspolicy/answer/6169371), with non-compliance fees, downgrades,
    suspension.
  - **Google may inspect your client's UI and monitor/audit API activity at any time**; you must
    not obscure activity.
  - **Data Protection clause**: any Personal Information accessed via the API must be used only
    consistently with the individual's consent, protected with appropriate technical/
    organizational measures, and processing must stop (with notice to Google) if protection can't
    be maintained; GDPR terms apply where relevant. This directly governs what may sit in your
    store.
  - **Termination**: Google may suspend/terminate access "for any or no reason"; on termination
    you must delete all Google Ads API *Specifications* in your possession "including... from
    your servers." (This deletion duty is phrased around the API Specifications, not report data;
    still, plan for the pipeline disappearing — the terms explicitly say it's your responsibility
    to be able to run your business without API access.)
  - Serving data to third parties makes you a "Google Ads API Client" subject to RMF (if
    Standard Access) and to the required-disclosures/prohibited-practices policies at
    https://support.google.com/adspolicy/answer/6169371.
- Net: storing campaign/search performance data for the property owner or a consenting client in
  your own store is contemplated by both APIs (the BigQuery transfer products exist precisely for
  this); the binding constraints are consent, privacy-law compliance, not reselling/serving
  beyond the consented purpose, and (Ads, Standard Access, external users) RMF display
  requirements.

## Not confirmed / open items

- **Service account as a Search Console property user**: no primary Google page found stating it
  explicitly for Search Console (the Ads docs state the equivalent pattern verbatim). Verify with
  a 30-minute spike: create SA, add its email as restricted user on a property, call
  `searchanalytics.query`.
- **Google APIs ToS full text**: only Sections 1–2 were fetched; the privacy/user-data sections
  (§3+) were not read verbatim. No red flags expected, but re-read before shipping a
  multi-tenant store.
- **Google Ads scheduled CSV/email exports**: not verified against a primary page; excluded from
  recommendations.
- **Explorer Access auto-grant reliability**: docs say Google "may" auto-upgrade to Explorer at
  sign-up "in some cases" — whether a given application lands at Test-only or Explorer is not
  predictable from the docs.
- **Search Console Bulk Data Export**: existence confirmed only indirectly via
  https://support.google.com/webmasters/answer/6211453; its setup/limits page was not fetched.
