# dsh-web-search-baidu

Baidu Qianfan web search provider for the dsh web seam (`ctx.web`). Registers a
`WebSearchProvider` under the stable id `baidu` that calls Baidu's AI search
endpoint, so the built-in `web_search` tool (mounted by the `standard` agent
preset via `@deepseek-ai/dsh-tool-web`) executes through Baidu instead of the
DeepSeek route — a drop-in substitute when `DEEPSEEK_API_KEY` is not configured
or the default provider is otherwise unavailable.

## Why a provider, not a new tool

The web seam (`@deepseek-ai/dsh-web`) owns provider selection, error mapping,
cancellation, and the `maxResults` bound. Registering a search provider reuses
the whole existing pipeline — the `web_search` tool schema, prompt guidance,
`kind: search` cards, and timeout policy — with zero model-facing changes. The
model keeps calling `web_search`; only the backend changes.

## Installation

The package is a plain-ESM npm package (no build step) installable into any dsh
profile with the plugin command — from a local folder or a git repository.

```sh
# From a local folder (relative or absolute):
dsh plugin --profile web add file:/path/to/dsh-web-search-baidu
```
or
```sh
# From a git repository:
dsh plugin --profile web add git:joy3mao/dsh-web-search-baidu.git
```

`dsh plugin ... add` forwards to pnpm in the profile directory; the package
declares its own exact-pinned `@deepseek-ai/*` dependencies, so a fresh profile
pulls them automatically (no `prepare` script, so no `allowBuilds` entry is
needed — a future version adding a build step would require one). To update
after changing the source: re-run `add` for a folder dep, or
`dsh plugin --profile web update dsh-web-search-baidu` for a git dep.

## Wiring

After installing, reference the package by name in the profile's
`cordis.patch.yml` (this package ships no bundle):

```yaml
# Back the built-in web_search tool with Baidu AI search.
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: baidu

- insert:
    - id: web-search-baidu
      name: 'dsh-web-search-baidu'
      config: {apiKey: xxx}
```

The `web` patch row replaces the base row's whole `config` (loader patch
semantics), so `searchProvider` is restated. The base bundle's
`web-search-deepseek` row stays registered but unselected; switch back by
setting `searchProvider: deepseek-official`.

## Config

All fields optional; defaults shown. Editable live from the Plugins settings
panel (namespace `web-search-baidu`).

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `apiKey` | string (secret) | — | Literal Baidu Qianfan API key; wins over the env reference. |
| `apiKeyEnv` | string (credential-ref) | `BAIDU_QIANFAN_API_KEY` | Env var or credential-service reference resolved per search. |
| `baseURL` | string | `https://qianfan.baidubce.com/v2/ai_search/web_search` | AI search endpoint (no path appended). |
| `searchSource` | string | `baidu_search_v2` | `search_source` payload value. |
| `resourceTypes` | `{ type, top_k? }[]` | `[{ type: 'web', top_k: 20 }]` | `resource_type_filter` payload entries. |
| `searchRecencyFilter` | string | `year` | `search_recency_filter` payload value; empty string omits the field. |

The Baidu API key is resolved through the credentials service first, then the
launch environment (`launchEnvironmentOf`), then the literal `apiKey` config is
used directly. Prefer the environment variable so no secret enters
configuration files.

## Service API and events

- Registers a `WebSearchProvider` (id `baidu`) on `ctx.web` via
  `registerSearchProvider`; the returned disposer unregisters it when the
  plugin unloads. No service is provided by this package.
- Emits the session event `web/baidu-search-request` (secret-free endpoint and
  exact request body) on the current initiator's session before each dispatch,
  mirroring `web/deepseek-search-llm-request` from `@deepseek-ai/dsh-web-search-deepseek`.
  The event is appended with the envelope's `ignorable` marker because its type
  is plugin-private: a harness build that does not know it (e.g. after an
  update) skips the record instead of refusing to load the whole session log.
  The request is purely informational — reconstruction only needs the
  surrounding `tool/call` / `tool/result` events.
- Errors are `WebError`s with stable codes: `WEB_PROVIDER_CREDENTIAL_MISSING`,
  `WEB_PROVIDER_ERROR`, `WEB_ABORTED`.

## Design notes

- `available()` is a cheap local check (key resolvable and `baseURL` parseable)
  and never makes a network call; the seam resolves provider selection at call
  time.
- The wire format is provider-private and does not use `ctx.llm`: a plain
  `fetch` POST with `Authorization: Bearer <key>` and the exact payload of the
  Baidu `ai_search/web_search` endpoint (`messages` with the query,
  `search_source`, `resource_type_filter`, `search_recency_filter`).
- `mapBaiduResponse` walks `references[]` (`title`/`content`/`url`), dedupes by
  URL, and promotes a non-empty top-level `answer` string to the result's
  `content`. Empty references map to an empty result (the tool renders
  "No results found.") rather than an error.

## Model Experience

### Web search through the `web_search` tool

#### What the model sees

This package changes no prompt text and registers no tool. The model sees the
built-in `web_search` tool exactly as `@deepseek-ai/dsh-tool-web` defines it
(`query` argument; rendered sources with title, snippet, and URL). Only the
backend that answers the call changes: results now come from Baidu AI search.
Because Baidu returns no `publishedAt`, sources carry only `url`, `title`, and
`snippet`.

#### Token effect

Conditional, per call: the canonical `web_search` result is capped to
`searchMaxResults` (default 8) sources by the seam, unchanged from the DeepSeek
route. No prompt or schema tokens are added or removed.

#### KV Cache effect

Does not invalidate: the tool catalog and system prompt are byte-identical to
the DeepSeek-route composition, so an already-reusable request prefix stays
reusable. The only package-owned change is the provider selection config
(`web.searchProvider`), which affects execution-time routing, not the prompt
prefix.

## Known Limitations and Deferred Work

- **Live-tested** — a real `ctx.web.search()` against the Baidu Qianfan
  endpoint was run with a production API key and returned mapped sources in
  ~2s; the request path is additionally unit-verified with a stubbed `fetch`
  (`verify/baidu-search.mjs`) and seam-verified (`verify/baidu-search-seam.mjs`).
- **Baidu snippets only** — `references[].content` becomes the snippet; Baidu's
  response carries no publication date, so `publishedAt` is never set.
- **No fetch backend** — this package only provides search. `web_fetch` stays
  disabled in this deployment (`tool-web` row, `fetch: false`), matching the
  base composition.
- **Provider pinning, not auto-fallback** — the web seam deliberately has no
  silent fallback chain: the deployment must pin `searchProvider: baidu` (or
  `deepseek-official`) explicitly. The "fallback" here is the config-level
  substitute for an unconfigured default provider.
- **Plain ESM with JSDoc, no tsdown build** — kept build-free so
  `dsh plugin ... add` installs it as-is from a folder or git. A future move
  into the deepseek-harness repo (`packages/<group>/dsh-web-search-baidu`)
  would add the tsdown build, type declaration surface, and the repo's test
  gates.
