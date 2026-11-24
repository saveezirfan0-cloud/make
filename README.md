# Blueprint Runner

A self-hosted, Make.com-style automation runner. Paste a Make blueprint export,
put your tokens/auth in **variables** (not in the JSON), and run the scenario —
with a per-module execution log showing every request and output.

Built as a Next.js app so it deploys straight to **Vercel** with zero
configuration and no database (state lives in your browser's localStorage; a
Supabase-backed store can be added later for scheduling/history).

## Visual editor

A Make.com-style canvas is the default view. It renders the blueprint as
circular module nodes wired left-to-right, with routers and if/else modules
fanning branches out vertically (curved connectors, branch labels, filter
badges). You can:

- **Click any node** to open an inspector with type-specific settings — for an
  HTTP module: URL, method, headers, query string, content type, body; for
  Airtable: connection id, base/table, formula or record fields; etc.
- **Click a “+”** between modules (or at a branch tip) to open a grouped module
  picker (HTTP · Airtable · Flow control · Tools) and insert a module there.
- **Add routers / if-else branches**, edit each branch's conditions
  (`{{6.id}}` → `exists`, AND/OR groups), and add a **filter** to any module.
- **Edit raw module JSON** per node, **undo**, and **delete** modules.

The canvas and the **Blueprint JSON** tab are two views of the same data, so
anything built visually exports as a Make-compatible blueprint and runs on the
same engine. Paste an existing Make export in the JSON tab and it appears on the
canvas.

## What it runs

The engine natively understands Make.com blueprint JSON (`{"subflows":[{"flow":[...]}]}`):

| Category | Modules |
| --- | --- |
| HTTP | `http:ActionSendData` (raw/urlencoded bodies, headers, query strings, basic auth, parse response, error handling) |
| Airtable | `ActionSearchRecords`, `ActionCreateRecord`, `ActionUpdateRecords`, `upsertRecord`, `ActionGetRecord`, `ActionDeleteRecord`, `makeApiCall` (arbitrary Airtable REST calls) |
| Flow control | `builtin:BasicFeeder` (iterator), `builtin:BasicRouter`, `builtin:BasicIfElse` (+merge), `builtin:BasicMerge` (with input filters), `placeholder:Placeholder` |
| Tools | `util:SetVariable2`, `util:SetVariables`, `util:GetVariables`, `util:TextAggregator`, `util:ComposeTransformer`, `json:ParseJSON`, sleep |

Plus the Make expression language inside `{{ }}`:

- module references: `{{3.data.Data}}`, backticked keys `` {{5.notes.`Gift Message`}} ``,
  array mapping `{{5.vitals[].Height}}`, 1-based indexing `{{arr[1]}}`
- functions: `formatDate`, `parseDate`, `addDays`, `now`, `ifempty`, `if`, `replace`,
  `toString`, `length`, `lower/upper/trim/capitalize`, `split/join/first/last`,
  `contains`, `get`, `sum/round/floor/ceil/min/max`, `md5/sha1/sha256`, `base64`,
  `encodeURL`, and more
- keywords: `space`, `newline`, `emptystring`, `timestamp`, string concatenation with `+`
- filters: `exist` / `notexist`, `text:*`, `number:*`, `boolean:equal`, `array:*`
  operators, with Make's OR-of-AND-groups condition matrix

Unknown app modules are skipped with a log entry (they emit an empty bundle), so
partially supported blueprints still execute end to end.

## Tokens & auth as variables

Two mechanisms, both managed in the UI and stored only in your browser:

1. **Variables** — referenced in blueprints as `{{var.NAME}}`.
   Example header value: `Bearer {{var.SHOP_API_TOKEN}}`.
2. **Connections** — Make blueprints reference accounts by numeric
   `__IMTCONN__` id. Map each id to an API token (e.g. an Airtable personal
   access token). A variable named `AIRTABLE_TOKEN` acts as a fallback for all
   Airtable modules.

The **"Extract hardcoded tokens → variables"** button scans a pasted blueprint
for bearer tokens / API keys in HTTP headers, moves them into variables, and
rewrites the JSON to use `{{var.*}}` — so secrets never live in the blueprint.

## Running

```bash
npm install
npm run dev        # http://localhost:3000
```

In the UI: **Load sample scenario** → **Dry run** to see every resolved
request without calling anything. The sample's shop API is fictional
(`shop.example.com`), so a full run needs your own API in module 3, an
`AIRTABLE_BASE_ID` variable and an Airtable token for connection `1001`.

### API

`POST /api/run`

```json
{
  "blueprint": { "subflows": [{ "flow": [] }] },
  "variables": { "SHOP_API_TOKEN": "...", "AIRTABLE_BASE_ID": "app..." },
  "connections": { "1001": { "token": "pat..." } },
  "dryRun": false
}
```

Returns `{ ok, ops, durationMs, log: [...] }` with a per-module log
(status, request with redacted auth headers, output, timing, bundle position).

### Who can run what

The API route is safe to expose publicly:

- **Dry runs** are open to anyone. They make no network calls.
- **Live runs** need `RUN_ACCESS_KEY` set on the deployment and the same value
  sent as the `x-run-key` header (the UI has a **Run key** field). With no
  key set, live runs are refused. Under `npm run dev` they're always allowed.
- **Server-side secrets** (`BP_VAR_*`, `BP_CONN_*` below) are only used for
  runs that passed the key check, so a stranger's blueprint can't read them
  back, even in a dry run.
- **Private networks are blocked.** Requests and redirect hops to
  non-http(s) URLs, localhost, private ranges, link-local (including cloud
  metadata) and reserved addresses fail. Set `ALLOW_PRIVATE_NETWORK=1` only on
  a self-hosted deployment that needs to reach internal APIs.

### Server-side secrets (environment variables)

Instead of entering tokens in the UI, you can set them once as environment
variables (Vercel → Project → Settings → Environment Variables):

- `BP_VAR_<NAME>` → available to blueprints as `{{var.NAME}}`
  (e.g. `BP_VAR_SHOP_API_TOKEN`)
- `BP_CONN_<id>` → token for Make connection `__IMTCONN__ <id>`
  (e.g. `BP_CONN_1001` for the Airtable connection)

Values entered in the UI override the environment defaults.

### Tests

```bash
npm run generate-sample   # regenerates public/samples/orders-sync.json
npm run selftest          # expression tests + mocked end-to-end run of the sample
```

The self-test mocks the shop API and Airtable and asserts the whole scenario:
new-customer creation, order dedupe via the merge filter, order creation,
linked-record append (the toString/replace string-surgery idiom), the
main-category filtered route, and cross-bundle text aggregation.

## Deploying to Vercel

Import the repo in Vercel — it is detected as a Next.js app, no configuration
needed. `app/api/run` sets `maxDuration = 300` for long scenario runs (the
engine also self-limits to ~280s and 5000 operations per run; raise via
`maxOps` in the request body up to 20000).

## Sample scenario

`public/samples/orders-sync.json` is a made-up scenario. Every name, URL and
ID in it is fictional. It pulls the last 7 days of orders from a web shop API,
then for each customer and order: find-or-create the customer in Airtable,
skip orders already recorded, create an Orders row, link categories, products
and add-ons back to it, and aggregate line quantities and prices. It uses
tables named Customers, Orders, Categories, Products and Add-ons, and reads
the base ID from `{{var.AIRTABLE_BASE_ID}}`. It is regenerated by
`scripts/generate-sample.mjs`.

## Notes & limitations

- Variable scope: Make distinguishes "one cycle" vs "one execution" variable
  lifetimes; here all variables are per-run.
- Airtable search with zero results emits one empty bundle (so
  `exist`/`notexist` routing works, matching how this scenario expects it).
- Rate limiting: one automatic retry on Airtable 429s.
- No scheduler yet — trigger runs via the UI or `POST /api/run` (e.g. from a
  Vercel cron job). Persistent run history would be the first thing to move to
  Supabase.

## Live deployment

Production: https://make-saveezirfan0-3688s-projects.vercel.app (Vercel project `make`, auto-deploys on push).
