# Optimisations — what's done, how it was measured, what's next

A running record of performance and efficiency work on capsulemcp.
Each section names the change, the rationale, the design constraints
it had to satisfy, how to verify it, and the empirical result. The
"Planned" section at the bottom captures candidates that haven't
landed yet so we don't forget them or rediscover them later.

The bar for inclusion: a change that meaningfully shifts a measurable
operational quantity (latency, API quota consumption, bundle size,
cold-start, CI duration). One-off code cleanups belong in CHANGELOG,
not here.

---

## 1. Reference-data cache *(landed)*

### What

A per-instance TTL cache (`src/capsule/cache.ts`) for 16 "dictionary"
endpoints that admins configure and that LLM agents repeatedly look
up during a conversation:

- `list_pipelines`, `list_milestones`
- `list_boards`, `list_stages`
- `list_custom_fields`, `get_custom_field`
- `list_lostreasons`, `list_activitytypes`, `list_categories`, `list_goals`
- `list_track_definitions`, `list_saved_filters`
- `list_users`, `list_teams`, `list_tags`
- `get_site`

Record-level reads (parties, opportunities, projects, tasks, entries)
are deliberately **not** cached — those change during a conversation.
`get_current_user` is also uncached so it never lags a token rotation.

### Why

LLM-driven conversational flows routinely call the same dictionary
endpoint several times in a single turn to discover ids before
`create_*` / `update_*` / `filter_*`. Each lookup was a fresh ~150 ms
Capsule round trip. A short TTL turns the second-through-Nth lookups
within that window into ~5 ms cache hits while preserving freshness
on record data and respecting Capsule's hourly rate-limit budget.

### Design

- **Per-instance only.** Cloud Run instances don't share a cache.
  Worst-case staleness across N instances is still TTL (not TTL × N),
  but cache hit rates aren't shared — each instance warms its own.
  Deliberately avoids dragging in Redis / Firestore.
- **Two orthogonal env knobs.** `CAPSULE_MCP_CACHE_DISABLED=1`
  is the canonical on/off (matches the `MCP_HTTP_RATE_LIMIT_DISABLED`
  precedent in the codebase). `CAPSULE_MCP_CACHE_TTL_MS` is the entry
  lifetime when enabled (default `300000` = 5 minutes). Setting TTL to
  `0` also disables, as a back-compat shortcut.
- **Cache key**: `"GET <path>?<sorted-params>"`. Sorting keeps
  `{page:1,perPage:25}` and `{perPage:25,page:1}` on the same key.
- **Cap + eviction.** 64 entries max; Map iteration order = insertion
  order, so `.keys().next()` yields the oldest live entry for naïve
  eviction. No LRU bookkeeping — at our scale, unnecessary.
- **Invalidation.** `add_tag` / `remove_tag_by_id` call
  `invalidateByPrefix("/<entity>/tags")` after a mutation so the next
  `list_tags` read sees fresh data. Other cached endpoints have no
  write-side counterpart in our tool surface.

### Documented contract

See [DESIGN.md](DESIGN.md) L6 (reworded) and L13 (full spec, staleness
bounds, per-instance scope).

### How to verify

#### Method A — log-driven latency comparison

The most direct evidence. Drive the connector through two identical
sweeps of cached endpoints, then read `httpRequest.latency` from Cloud
Run's request logs:

```sh
gcloud logging read \
  'resource.type="cloud_run_revision"
   AND resource.labels.service_name="<your-service>"
   AND httpRequest.requestMethod="POST"
   AND httpRequest.requestUrl=~"/mcp$"
   AND httpRequest.status=200' \
  --project=<your-gcp-project> \
  --limit=30 \
  --format='value(timestamp, httpRequest.latency, httpRequest.responseSize)'
```

Pair pass-1 and pass-2 calls by `responseSize` (identical for the
same query) and compare latencies. Cache hits should land in the
~5 ms band; cache misses ~130–200 ms.

#### Method B — verbose event logging for retroactive analysis

`CAPSULE_MCP_LOG_VERBOSE=1` makes the server emit one JSON line per
cache event to stderr. Cloud Run's logging agent auto-parses these
into `jsonPayload` fields, so you can query them weeks later with
gcloud:

```sh
# Flip verbose logging on for an hour:
gcloud run services update <your-service> \
  --region=<your-region> \
  --update-env-vars=CAPSULE_MCP_LOG_VERBOSE=1 \
  --project=<your-gcp-project>

# … let real traffic run …

# Flip it back off (recommended — log volume cost):
gcloud run services update <your-service> \
  --region=<your-region> \
  --remove-env-vars=CAPSULE_MCP_LOG_VERBOSE \
  --project=<your-gcp-project>
```

Useful queries afterwards:

```sh
# Cache hit count over the last 24h, grouped by path:
gcloud logging read \
  'jsonPayload.event="cache.hit"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(jsonPayload.path)' | sort | uniq -c | sort -rn

# Miss rate (hits vs misses):
HITS=$(gcloud logging read 'jsonPayload.event="cache.hit"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(timestamp)' | wc -l)
MISSES=$(gcloud logging read 'jsonPayload.event="cache.miss"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(timestamp)' | wc -l)
echo "hit rate: $(echo "scale=3; $HITS / ($HITS + $MISSES)" | bc)"

# Misses broken down by reason ("empty" = first call, "expired" =
# TTL elapsed; high "expired" means TTL is too short for the access
# pattern):
gcloud logging read \
  'jsonPayload.event="cache.miss"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(jsonPayload.reason)' | sort | uniq -c

# Capsule API latency distribution (latencyMs is emitted on every
# cache.miss — these are the actual Capsule round trips):
gcloud logging read \
  'jsonPayload.event="cache.miss"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(jsonPayload.latencyMs)' | sort -n | \
  awk '{a[NR]=$1} END {
    print "p50:", a[int(NR*0.50)],
          "p90:", a[int(NR*0.90)],
          "p99:", a[int(NR*0.99)],
          "max:", a[NR]
  }'

# Cap eviction events (high count = MAX_ENTRIES too small):
gcloud logging read \
  'jsonPayload.event="cache.evict"' \
  --project=<your-gcp-project> --freshness=24h --format='value(timestamp)' | wc -l

# Tag-mutation invalidations (audit trail of cache drops):
gcloud logging read \
  'jsonPayload.event="cache.invalidate"' \
  --project=<your-gcp-project> --freshness=24h \
  --format='value(timestamp, jsonPayload.trigger, jsonPayload.prefix, jsonPayload.droppedCount)'
```

Event payload shapes for reference:

| Event | Fields |
|---|---|
| `cache.hit` | `path`, `params?`, `ageMs` (how old the entry was when served) |
| `cache.miss` | `path`, `params?`, `reason` (`empty` \| `expired`), `latencyMs` (Capsule round trip) |
| `cache.invalidate` | `prefix`, `trigger?` (e.g. `add_tag`), `droppedCount`, `cacheSize` |
| `cache.evict` | `evictedKey`, `reason: "cap"`, `cacheSize` (capacity-eviction only) |

All events also carry `timestamp` (ISO 8601). Off by default — log
volume is real (one line per cache lookup), so flip on for measurement
windows, not as a steady-state setting.

#### Method C — wall-clock A/B with the disable flag

For a side-by-side reference where both passes hit Capsule:

```sh
gcloud run services update <your-service> \
  --region=<your-region> \
  --update-env-vars=CAPSULE_MCP_CACHE_DISABLED=1 \
  --project=<your-gcp-project>

# … run the same two-pass exercise …

gcloud run services update <your-service> \
  --region=<your-region> \
  --remove-env-vars=CAPSULE_MCP_CACHE_DISABLED \
  --project=<your-gcp-project>
```

With caching disabled, pass 2's latencies should match pass 1's
(both ~130–200 ms). Restoring the default brings pass 2 back to
~5 ms.

#### Method D — local regression tests

`tests/cache.test.ts` (22 unit cases) covers hit, miss, TTL expiry,
capacity eviction, invalidation on tag mutation, and both env knobs.
`tests/log.test.ts` (12 cases) covers the verbose-logging helper and
the events emitted by the cache code. Run via `npm test`.

### Empirical result *(measured 2026-05-19 against production)*

Two identical sweeps of 12 cached endpoints back-to-back:

| Response size | Pass 1 (cache miss) | Pass 2 (cache hit) | Speedup |
|---:|---:|---:|---:|
| 15.7 KB | 152.7 ms | 4.6 ms | 33× |
|  7.3 KB | 148.3 ms | 5.4 ms | 27× |
|  6.2 KB | 171.5 ms | 4.8 ms | 36× |
|  4.1 KB | 149.2 ms | 6.2 ms | 24× |
|  2.1 KB | 379.3 ms | 6.5 ms | 58× |
|  2.0 KB | 158.0 ms | 4.5 ms | 35× |
|  1.8 KB | 132.7 ms | 4.9 ms | 27× |
|  1.2 KB | 138.3 ms | 5.2 ms | 27× |
|  1.2 KB | 132.3 ms | 4.1 ms | 32× |
|  1.1 KB | 160.0 ms | 5.1 ms | 31× |
|  1.2 KB | 138.6 ms | 5.5 ms | 25× |
|  476 B  | 132.3 ms | 7.0 ms | 19× |

**Mean: 166 ms → 5 ms (~30× faster).** Time saved on a single
12-endpoint warm-cache sweep: ~1.74 s. Capsule API quota units
conserved: 12 per sweep — compounds dramatically in conversational
flows that hit dictionaries dozens of times per turn.

**Correctness:** every pass-2 response was byte-identical to its
pass-1 counterpart (same ids, orderings, timestamps). Cache serves
exactly what fetch served; no truncation or staleness within TTL.

The ~145 ms gap between pass-1 and pass-2 per call is, almost by
definition, the Capsule round trip the cache eliminated. Pass-2's
~5 ms residual is local work: OAuth bearer verify, MCP parse, cache
key lookup, JSON serialise.

### Cost

- **Bundle size**: `dist/index.js` 119 → 122 KB, `dist/http.js`
  145 → 147 KB (each grew ~2 KB for the cache module).
- **Memory**: 64 entries × ~few KB each = <100 KB worst case per
  Cloud Run instance. Negligible.
- **Test count**: +22 (349 → 371) covering the new module.
- **Documentation**: DESIGN.md L6 reworded; new L13; DEPLOY.md
  env-var table gets two new rows; `src/http.ts` header updated.

---

## 2. Batched-write tools *(landed)*

### What

Five new tools that accept arrays and fan out parallel HTTP requests
to Capsule, since Capsule v2 has no batch-write API and every
write is one entity per call:

- `batch_update_party`, `batch_update_opportunity`
- `batch_complete_task`
- `batch_add_tag`, `batch_remove_tag_by_id`

Each accepts an `items` array (1–50 entries) shaped identically to
its single-tool counterpart and returns
`{ results: [{ ok, ...} per item], summary: { total, succeeded, failed } }`.
Reads aren't covered here — the dedicated `get_parties`,
`get_opportunities`, `get_projects`, and `get_tasks` tools already
batch-fetch up to 50 ids. Internally, they still respect Capsule's
native 10-id GET cap by splitting larger calls into parallel chunks;
see [§3](#3-get_-batch-fetch-fan-out-beyond-capsules-native-10-cap-landed).

### Why

LLM-driven flows like "tag these 20 people we met at the conference"
or "mark these 15 follow-up tasks done" previously cost N sequential
single-tool calls — each with its own MCP wire latency (~200 ms),
OAuth verify, and Capsule round-trip. Sequential 20 × ~400 ms ≈ 8 s.
Parallel-with-concurrency-cap collapses that to one tool call ≈
one wire trip + (N / concurrency) Capsule rounds ≈ ~1 s. ~5–10×
speedup for the common case.

### Design

- **Per-item results, not all-or-nothing.** Capsule has no rollback.
  If 8 of 10 PUTs succeed and 2 422, you can't undo the 8. Return
  shape surfaces every item's status so the LLM can react.
- **Concurrency cap, not unlimited.** Default 5 parallel; configurable
  via `CAPSULE_MCP_BATCH_CONCURRENCY` (clamped to [1, 50]). Keeps
  the burst polite vs. Capsule's hourly 4000-req-per-token budget,
  which is shared with every other tool call on the same token.
- **Batch size cap 50.** Same rationale — a single tool call can't
  burn more than ~1.25 % of the hourly budget per token.
- **Errors are per-item, never poison the batch.** Item N rejecting
  doesn't reject the outer promise; it lands in slot N with
  `{ ok: false, error: { status?, message } }`.
- **Same idempotency contract as single tools.** Each item routes
  through the existing single-tool function (`updateParty`,
  `completeTask`, etc.), so the idempotency wrappers
  (`idempotent` / `idempotentWithResult`) and the
  `remove_tag_by_id` "already-detached" semantics apply per-item.
- **Read-only mode**: batch writes register inside the same
  `if (!readOnly)` gate as the singles — disappear from the
  catalogue when `CAPSULE_MCP_READONLY=1`.

### Documented contract

See `src/capsule/batch.ts` for the helper API; tool descriptions in
`src/server.ts` are A-graded with explicit when-to-use guidance.

### How to verify / observe

#### `batch.complete` event

A single aggregate JSON line is emitted to stderr at the end of every
batch, **regardless of `CAPSULE_MCP_LOG_VERBOSE`** (the verbose flag
gates cache.* per-event chatter; batch.complete is low-volume — one
line per batch tool call — and uniformly useful, so the summary is
always-on). Default shape:

```json
{
  "event": "batch.complete",
  "tool": "batch_update_party",
  "total": 12,
  "succeeded": 10,
  "failed": 2,
  "durationMs": 412,
  "concurrency": 5,
  "timestamp": "2026-05-19T11:30:00.000Z"
}
```

When `CAPSULE_MCP_LOG_VERBOSE=1`, failed batches also include
`failureReasons` with the top 5 deduplicated errors by frequency:

```json
{
  "failureReasons": [
    { "status": 422, "message": "party.name: name is required", "count": 2 }
  ]
}
```

The opt-in matters: Capsule error messages can contain CRM data, so
raw failure text should not land in default always-on logs.

Useful gcloud queries (Cloud Run auto-parses these into `jsonPayload`):

```sh
# All batches in the last 24h, by tool:
gcloud logging read 'jsonPayload.event="batch.complete"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(jsonPayload.tool)' | sort | uniq -c | sort -rn

# Batches with any failures (worth investigating):
gcloud logging read \
  'jsonPayload.event="batch.complete" AND jsonPayload.failed > 0' \
  --project=<your-gcp-project> --freshness=24h \
  --format='value(timestamp, jsonPayload.tool, jsonPayload.total, jsonPayload.failed)'

# Latency distribution per batch tool:
gcloud logging read 'jsonPayload.event="batch.complete"' \
  --project=<your-gcp-project> --freshness=24h --limit=10000 \
  --format='value(jsonPayload.tool, jsonPayload.durationMs)'

# Top failure reasons across all batches (requires CAPSULE_MCP_LOG_VERBOSE=1):
gcloud logging read 'jsonPayload.event="batch.complete"' \
  --project=<your-gcp-project> --freshness=7d --limit=10000 \
  --format='value(jsonPayload.failureReasons)' | jq -s 'flatten | group_by(.message) | map({message: .[0].message, total: map(.count) | add}) | sort_by(-.total)'
```

#### Local regression tests

`tests/batch.test.ts` (19 cases): concurrency env knob (default,
clamping, malformed), batchExecute (per-item results, ordering,
exception isolation, status extraction, concurrency cap enforcement,
batch.complete shape, verbose-gated failureReasons dedup), tool-level wiring for
all 5 batch tools (one PUT per item, schema bounds).

### Empirical expectation

For a 10-item batch at default concurrency 5, with Capsule ~150 ms
per write: sequential ≈ 10 × 400 ms ≈ 4 s end-to-end; batch ≈ one
wire trip (~200 ms) + ⌈10/5⌉ × 150 ms ≈ 500 ms. **~8× speedup**
in the common case. Real production traffic will land in
`batch.complete.durationMs` and can be cross-referenced against
sequential equivalents.

### Cost

- **Bundle**: `dist/index.js` 123 → 131 KB, `dist/http.js` 148 → 156 KB
  (~8 KB each — the 5 new tool descriptions plus the batch helper).
- **Tool catalogue**: 81 → 86. Read-only count unchanged at 49.
- **Test count**: +18 (383 → 401).

### Not implemented (deferred to IDEAS.md)

`batch_create_*`, `batch_delete_*`, `batch_update_task`,
`batch_update_project`, `batch_update_entry`, `batch_add_note`, and
batch variants of track operations. See `IDEAS.md` →
*"Additional batched-write tools"* for the reasoning per tool and
when each becomes worth implementing.

---

## 3. `get_*` batch-fetch fan-out beyond Capsule's native 10-cap *(landed)*

### What

Four read tools — `get_parties`, `get_opportunities`, `get_projects`,
`get_tasks` — previously capped at **10 ids per call** (Capsule's
native multi-id GET endpoint hard limit). Each now accepts **1–50
ids**; for 11–50 the connector transparently splits into 10-id
chunks and runs the resulting Capsule GETs in parallel via
`Promise.all`. Caller-facing surface is unchanged.

### Why

The common "filter or search returned N records, now fetch full
details on all of them" pattern was forcing the LLM to call
`get_*` repeatedly with overlapping 10-id windows. For N = 25 ids:

| | Before | After |
|---|---|---|
| LLM-facing tool calls | 3 (split client-side) | 1 |
| Capsule API round trips | 3 (sequential, ≈ 450 ms) | 3 (parallel, ≈ 150 ms) |
| End-to-end latency | ~1.5 s (incl. MCP wire) | ~350 ms |

About **3–5× speedup** on the multi-record-detail flow.

### Design

- **No new tool surface.** Same four tools, just `max(10)` → `max(50)`
  in the Zod schema and updated descriptions. Existing callers using
  ≤ 10 ids see identical behaviour (single Capsule call); the new
  fan-out path triggers only when `ids.length > 10`.
- **Same result shape** regardless of chunk count. The tool
  concatenates per-chunk arrays into the original `{ parties: [...] }`
  shape — the LLM doesn't know fan-out happened.
- **Fail-fast on chunk errors.** Unlike the write-side `batch_*`
  tools (which use `batchExecute` for per-item result aggregation),
  reads use bare `Promise.all` and propagate the first chunk error.
  Rationale: a chunk-level 4xx/5xx means we couldn't deliver the
  full result set, so the caller can't safely act on partial data.
  Capsule's per-id "not found" inside a successful chunk is already
  silently omitted from the response (its native behaviour) —
  unchanged by this work.
- **No log event.** The user-facing tool call still produces exactly
  one MCP request/response; operators can already see the parallel
  Capsule fetches in Cloud Run's outbound request logs if they care.
  Adding a separate event would only duplicate that signal.
- **Concurrency bounded by problem size.** At max 50 ids = 5 chunks,
  the parallelism is naturally low — no need to wire in the
  `CAPSULE_MCP_BATCH_CONCURRENCY` cap (which exists for writes that
  can have up to 50 items, hence 50 parallel reqs).

### How to verify

`tests/parties.test.ts` covers the chunked path with a 25-id request:

```typescript
it("splits >10 ids into parallel 10-id chunks and merges results", …)
```

Asserts exactly 3 Capsule URLs hit (10/10/5), the per-URL id ordering,
and that the merged `parties` array has all 25 records in input
order. The other three tools (`get_opportunities`, `get_projects`,
`get_tasks`) share the same code shape; the parties test is
representative.

`tests/batch.test.ts` covers the `chunk(arr, size)` helper:
splitting, single-chunk passthrough, empty input, invalid size.

### Cost

- **Bundle**: `dist/index.js` 131 → 134 KB, `dist/http.js` 156 → 159 KB.
- **Tool count**: unchanged at 86.
- **Test count**: +6 (401 → 407).

### Not implemented (deferred to IDEAS.md)

Child-list batching tools — `batch_list_opportunity_entries`,
`batch_list_party_entries`, `batch_list_project_entries`, plus the
other 5 child-list reads — would let one tool call do "give me all
entries for these 10 deals" via fan-out. Not yet shipped: the cache
already handles most read-side duplication, and we want
`batch.complete` traffic data to identify which child-list patterns
the LLM actually hits before adding tool-catalogue surface for them.

---

## 4. Failure-mode observability *(landed)*

### What

Three **forced** (always-on, regardless of `CAPSULE_MCP_LOG_VERBOSE`)
single-line JSON events that fingerprint an outbound Capsule call that
did *not* complete normally — the paths that throw before the
`capsule.request` emit and would otherwise leave no trace:

| Event | Fires when | Fields |
|---|---|---|
| `capsule.timeout` | the 60s `AbortController` fires — waiting for headers (fetch stage) **or** mid-body (`res.json()` / stream read) | `method`, `path` (redacted), `elapsedMs`, `timeoutMs` |
| `capsule.error` | the fetch rejects before headers (connection refused/reset/DNS) | `method`, `path`, `elapsedMs`, `code?` (e.g. `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`) |
| `capsule.ratelimit` | the single 429 retry is also throttled (after up to 60s of backoff) | `method`, `path`, `elapsedMs`, `status: 429` |

All three also increment `tool.chain.capsuleCalls`, so a `/mcp` request
whose latency ballooned on a hang or backoff is explained rather than
silently uncounted.

### Why

`capsule.request` is emitted *after* the response body is read (to
capture full-lifecycle `durationMs`), so any call that throws before
that — a fetch-stage timeout, a refused connection, or a
retry-exhausted 429 — produced no structured trace. That blind spot
made intermittent "it times out sometimes" reports impossible to
localise from logs. These events close it with zero configuration
(forced, like `batch.complete`). Privacy: `path` is `redactPath`-ed
(IDs → `:id`, query dropped); network errors log only a stable `code`,
never the raw message or URL.

### How to observe

```sh
# Every hang/failure in the last 24h, by endpoint:
gcloud logging read \
  'jsonPayload.event=("capsule.timeout" OR "capsule.error" OR "capsule.ratelimit")' \
  --project=<your-gcp-project> --freshness=24h --limit=1000 \
  --format='value(jsonPayload.event, jsonPayload.method, jsonPayload.path, jsonPayload.elapsedMs, jsonPayload.code)'

# Just the timeouts, grouped by endpoint (which Capsule endpoint hangs?):
gcloud logging read 'jsonPayload.event="capsule.timeout"' \
  --project=<your-gcp-project> --freshness=24h --limit=1000 \
  --format='value(jsonPayload.path)' | sort | uniq -c | sort -rn
```

On the stdio transport the same lines land on the MCP host's
server-stderr log. Covered by `tests/capsule-failure-events.test.ts`
(fetch-stage + body-stage timeout, network `code` extraction,
double-429) and the `capsuleCalls` aggregation test in
`tests/log-events.test.ts`.

### Cost

Negligible — these events fire only on failure (rare). No tool-count
change; just the client emit helpers.

---

## 5. `tools/list` payload reduction *(landed)*

### What

Two reducers for the per-session token cost of the tool catalog:

1. **Tool-catalog tiering** — `CAPSULE_MCP_TIER=core` registers only a
   curated ~25-tool core (search/filter/get/create/update across
   parties, opportunities, projects, tasks, plus notes, tags, and
   `get_current_user`; see `src/server/tier.ts`). Default (unset, or
   any other value) keeps the full catalog. Composes orthogonally with
   `CAPSULE_MCP_READONLY` — the tier filters within whichever
   read/write set is active.

2. **Batch-schema description stripping** — the five `defineBatch`
   tools embed their single-tool item schema wholesale, which
   previously serialized every nested `.describe()` into `tools/list`
   twice (the single tool is always co-registered and is the
   canonical copy). `defineBatch` now registers a description-stripped
   clone (`src/tools/strip-descriptions.ts`); validation is identical
   because zod v4 keeps refinements in `def.checks`, which the strip
   preserves.

### Why

The full 88-tool catalog measures **~155 KB** of `tools/list` JSON
(measured against the built v1.8.0 server over stdio: 155,645 bytes —
36.9 KB top-level descriptions, 104.6 KB inputSchema, of which 65 KB
is schema-embedded `.describe()` text). For clients that inject the
catalog into model context, that is roughly 35–40k tokens per session
— the single biggest non-conversational token cost this server
imposes. The earlier "~20 KB" estimate in this file was stale by ~8×.

Stripping the batch-schema duplication saves ~17 KB on the full
catalog with zero information loss; the core tier cuts the rest of
the way down for deployments that opt in.

### How to verify

`tests/tier.test.ts` pins the tier counts (88 full / 25 core / 14
core∩read-only), the strip's validation-equivalence (including a
nested `superRefine` surviving), and a per-tool serialized-size
ceiling on every batch schema.

### Cost

None at runtime — both are registration-time filters. The tier is
opt-in; default behavior is unchanged.

## 6. Planned candidates *(not yet landed)*

Ranked by expected ROI. Each has a brief sketch; if/when one lands,
move its row into a numbered section above with a real "what / why /
result" write-up.

### a. Bundle minification *(evaluated, not adopting)*

`tsup --minify`. Current bundles are ~171 KB / ~199 KB; minification
would roughly halve them, but the measured effect on `npx capsulemcp`
cold-start is negligible (download is npm-registry-dominated, parse
time for ~200 KB is sub-millisecond on Node 22) and it costs readable
stack traces. Re-evaluate only if the bundles grow by an order of
magnitude.

**Trade-off**: production stack traces lose original symbol names.
We'd reproduce locally with the un-minified build anyway, so this is
mostly fine. Worth pairing with a sourcemap upload step if we ever
want production-readable traces (the npm tarball would carry the
sourcemap; users wouldn't unless they opt to download it).

### b. `min_instance_count=1` on production Cloud Run

Currently `min=0` → cold start ~1.5 s on first request after idle.
Setting `min=1` keeps one warm instance. Costs roughly **$5/mo** at
our resource shape. Eliminates the cold-start latency every OAuth
flow currently pays after a quiet period.

**One-line pulumi change.** Real user-visible improvement for
hosted-connector users.

### c. CI parallelism

CI runs ~25 s sequential (`typecheck` → `lint` → `format:check` →
`test` → `build` → `audit`). Splitting into three parallel jobs
(`typecheck` ∥ `lint+format` ∥ `test`) plus a final `build`+`audit`
drops it to ~12–15 s. About 30 LOC of YAML rearrangement.

**Purely developer experience.** Every PR pays the difference, so
worth doing once the cache work has bedded in.

---

## 7. Per-tool / per-endpoint analytics *(landed in v1.6.0-beta.3)*

### What

Three verbose-gated event types that give per-call visibility into
runtime behaviour, designed for retroactive analytics queries:

| Event | Fires | Fields |
|---|---|---|
| `tool.call` | Once per tool invocation | `tool`, `clientId`, `argFields` (field names only — never values), `durationMs`, `outcome` (success/error), `taskAugmented?` |
| `capsule.request` | Once per outbound Capsule API call | `method`, `path` (redacted: numeric IDs → `:id`, query stripped), `status`, `durationMs`, `responseBytes`, `retriedAfter429?` |
| `tool.chain` | Once per `/mcp` POST request | `clientId`, `tools` (sequence of tool names), `toolCount`, `capsuleCalls`, `cacheHits`, `durationMs` |

All gated on `CAPSULE_MCP_LOG_VERBOSE=1` — off by default. Flip on
for an investigation window (a few hours of real traffic is
usually plenty), then flip off. The retroactive nature of Cloud
Logging means you can keep querying the gathered data for weeks
after.

### Privacy invariants (load-bearing)

- Tool **arguments** are never logged — only the field NAMES that
  were present (`argFields: ["conditions", "page"]`). Search queries,
  party IDs, custom-field values, etc. stay out of operator logs.
- Capsule API **paths** are redacted: `/parties/123456789/notes` →
  `/parties/:id/notes`, `/parties/search?q=Acme` → `/parties/search`.
  Numeric IDs and query strings never appear. The shape stays for
  analytics ("top endpoints", "p95 latency per endpoint").
- **No request / response bodies, ever** — verbose mode does not
  unlock CRM content.

### Useful queries

#### Top tools by invocation count (last 7 days)

```sh
gcloud logging read \
  'jsonPayload.event="tool.call"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tool)' \
  | sort | uniq -c | sort -rn | head -20
```

#### Top Capsule endpoints by call count

```sh
gcloud logging read \
  'jsonPayload.event="capsule.request"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.method, jsonPayload.path)' \
  | sort | uniq -c | sort -rn | head -20
```

#### p95 latency per Capsule endpoint

```sh
gcloud logging read \
  'jsonPayload.event="capsule.request"' \
  --project=<your-gcp-project> --freshness=24h \
  --format='value(jsonPayload.path, jsonPayload.durationMs)' \
  | python3 -c "
import sys, statistics
from collections import defaultdict
by_path = defaultdict(list)
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) != 2: continue
    path, ms = parts[0], int(parts[1])
    by_path[path].append(ms)
for path, samples in sorted(by_path.items()):
    p50 = statistics.median(samples)
    p95 = statistics.quantiles(samples, n=20)[18] if len(samples) > 5 else max(samples)
    print(f'{path:40s} n={len(samples):5d} p50={p50:5.0f}ms p95={p95:5.0f}ms')
"
```

#### N+1 detector — chains with repeated same-tool calls

A `tool.chain` showing `tools: ["get_party", "get_party", "get_party", ...]`
is exactly the pattern that should be `get_parties` (batched). Run:

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=7d \
  --format='value(jsonPayload.tools)' \
  | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        tools = json.loads(line.strip())
    except Exception:
        continue
    # Find consecutive runs of same tool with length > 3.
    if not tools: continue
    runs = []
    cur, n = tools[0], 1
    for t in tools[1:]:
        if t == cur: n += 1
        else:
            if n > 3: runs.append((cur, n))
            cur, n = t, 1
    if n > 3: runs.append((cur, n))
    for tool, length in runs:
        print(f'{tool} ×{length}')
" | sort | uniq -c | sort -rn | head -20
```

#### Cache effectiveness per chain

```sh
gcloud logging read \
  'jsonPayload.event="tool.chain"' \
  --project=<your-gcp-project> --freshness=24h \
  --format='value(jsonPayload.capsuleCalls, jsonPayload.cacheHits)' \
  | python3 -c "
import sys
total_calls, total_hits = 0, 0
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) != 2: continue
    total_calls += int(parts[0])
    total_hits += int(parts[1])
denom = total_calls + total_hits
if denom:
    print(f'hit rate: {total_hits/denom:.1%} ({total_hits}/{denom})')
"
```

### Why opt-in only

At default-off, zero cost. At verbose-on, each `/mcp` request emits
roughly 5 events × ~200 bytes = 1 KB. A busy day (~1000 requests)
adds ~1 MB to log ingest — fractions of a cent on Cloud Logging
pricing. The reason we keep it off is hygiene, not cost: production
logs shouldn't be cluttered with per-call detail unless someone is
actively investigating.

---

## Methodology — how we measure

Three rules to keep the data trustworthy:

1. **Measure end-to-end, not internal.** Cloud Run's
   `httpRequest.latency` is what the OAuth-authenticated MCP client
   actually experiences, including TLS, OAuth verify, our app
   dispatch, the cache check, and (on miss) the Capsule round trip.
   Internal "how long did `capsuleGet` take" metrics would miss the
   transport overhead that dominates pass-2.

2. **Pair like calls.** Don't compare a `list_stages` (big payload)
   to a `get_site` (tiny payload). Match by `responseSize` from the
   logs; identical query → identical response → identical bytes.

3. **Two passes, not one.** A single call doesn't tell you anything
   — first calls always miss. The cache only shows benefit on the
   second-and-onward identical call. Run two passes, compare per-call.

For the cache specifically, the cleanest test is the **same
identical query run twice** within the TTL window. Anything beyond
that (timing minus prior history, statistical means over noisy data,
etc.) is overkill for binary "is the cache wired up correctly" — the
30× speedup per call is hard to mistake for noise.
