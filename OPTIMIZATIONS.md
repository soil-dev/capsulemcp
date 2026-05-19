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
   AND resource.labels.service_name="capsulemcp-production"
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
gcloud run services update capsulemcp-production \
  --region=europe-west1 \
  --update-env-vars=CAPSULE_MCP_LOG_VERBOSE=1 \
  --project=<your-gcp-project>

# … let real traffic run …

# Flip it back off (recommended — log volume cost):
gcloud run services update capsulemcp-production \
  --region=europe-west1 \
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
gcloud run services update capsulemcp-production \
  --region=europe-west1 \
  --update-env-vars=CAPSULE_MCP_CACHE_DISABLED=1 \
  --project=<your-gcp-project>

# … run the same two-pass exercise …

gcloud run services update capsulemcp-production \
  --region=europe-west1 \
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

## 2. Planned candidates *(not yet landed)*

Ranked by expected ROI. Each has a brief sketch; if/when one lands,
move its row into a numbered section above with a real "what / why /
result" write-up.

### a. Tool-catalog tiering

Reduce the per-conversation token cost of `tools/list`. Currently
~20 KB of JSON descriptions ships to every client per session. A
`CAPSULE_MCP_TIER=core` env would register only the 20 most-used
tools (search/filter/get/create across the four resources, plus
tags) and skip the long-tail. Default leaves all 81 registered for
back-compat.

**Expected impact**: halves the `tools/list` payload, which is the
single biggest non-conversational token cost an MCP client pays.
**Effort**: small. **Risk**: low — opt-in env, default unchanged.

### b. Bundle minification

`tsup --minify`. Drops `dist/index.js` from 122 → ~75 KB and
`dist/http.js` from 147 → ~90 KB. Faster `npx capsulemcp` cold-start
(smaller download + parse).

**Trade-off**: production stack traces lose original symbol names.
We'd reproduce locally with the un-minified build anyway, so this is
mostly fine. Worth pairing with a sourcemap upload step if we ever
want production-readable traces (the npm tarball would carry the
sourcemap; users wouldn't unless they opt to download it).

### c. `min_instance_count=1` on production Cloud Run

Currently `min=0` → cold start ~1.5 s on first request after idle.
Setting `min=1` keeps one warm instance. Costs roughly **$5/mo** at
our resource shape. Eliminates the cold-start latency every OAuth
flow currently pays after a quiet period.

**One-line pulumi change.** Real user-visible improvement for
hosted-connector users.

### d. CI parallelism

CI runs ~25 s sequential (`typecheck` → `lint` → `format:check` →
`test` → `build` → `audit`). Splitting into three parallel jobs
(`typecheck` ∥ `lint+format` ∥ `test`) plus a final `build`+`audit`
drops it to ~12–15 s. About 30 LOC of YAML rearrangement.

**Purely developer experience.** Every PR pays the difference, so
worth doing once the cache work has bedded in.

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
