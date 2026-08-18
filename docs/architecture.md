# Architecture

## Design goals

The plugin is a modular monolith inside one DSH process. It keeps deployment simple while preserving explicit boundaries that can later become separate packages without changing the knowledge contract.

```text
DSH events / pre-step / HTTP / Web console
              |
 extraction, catalog, retrieval tools, API
              |
       KnowledgeProvider
          /          \
 local SQLite      remote HTTPS
```

The DSH core is never patched. `src/index.ts` is the composition root; every other module is independently testable.

## Layers

- `domain.ts` owns stable value types, normalization, IDs and content hashing. It has no DSH dependency.
- `provider.ts` is the storage/application port. Local and remote clients implement the same asynchronous contract.
- `local-provider.ts` owns schema migrations, transactions, FTS and token hashes.
- `remote-provider.ts` is an authenticated, timeout-bounded HTTPS adapter.
- `management-proxy.ts` lets the embedded console operate on the selected central service while keeping the saved remote token on the DSH server.
- `extraction.ts` snapshots completed turns, resolves writable mounts and validates model JSON fail-closed.
- `retrieval.ts` owns mounted-scope authorization, signed handles, ranking and bounded rendering shared by proactive and tool-driven retrieval.
- `recall.ts` contributes a lightweight mounted-base catalog and performs bounded proactive retrieval in the asynchronous `agent/pre-step` waterfall.
- `tools.ts` registers read-only `knowledge_search` and paginated `knowledge_read` tools whose scope is resolved from the calling Agent.
- `api.ts` is a size-bounded HTTP adapter with two explicit authentication modes: same-origin administration for the embedded console and Bearer capabilities for remote clients.
- `web.ts` serves a same-origin, CSP-constrained management console from package-owned static assets.
- `web/` is a dependency-free browser application with a small API/state/view boundary.
- `service-settings.ts` atomically persists the user-controlled public API state separately from provider connection settings.
- `index.ts` validates configuration and wires lifecycle disposal.

## Data model and consistency

SQLite is authoritative in local mode. Schema version 5 contains:

- `knowledge_bases`: independently named destinations with default tags and extraction instructions.
- `knowledge_mounts`: project/session policy overlays for recall, write mode and tag constraints.
- `knowledge_entries`: current materialized entry state.
- `knowledge_versions`: immutable snapshots for every create, update, archive or restore.
- `knowledge_fts`: FTS5 index containing only active entries.
- `knowledge_candidates`: proposed create/update/conflict decisions and review state.
- `extraction_jobs`: one idempotency record per `sessionId:turn`.
- `api_tokens`: token metadata, permissions and SHA-256 token digests.
- `knowledge_settings`: the authoritative global conservative/proactive writeback policy shared by local and remote clients.

Entry writes, version creation and FTS changes share one `BEGIN IMMEDIATE` transaction. Candidate approval and its resulting entry mutation are also one transaction. WAL mode permits readers during a writer, `busy_timeout` absorbs short contention, and foreign keys prevent orphan versions.

An active content hash unique index blocks byte-equivalent duplicate knowledge. Candidate proposals additionally deduplicate by source turn plus proposal hash.

## Extraction flow

1. Awaited `agent/turn-stopping` observes the completed answer before `turn/end` is committed.
2. Project mounts are resolved and then overlaid by explicit session mounts; a disabled session mount blocks inheritance.
3. Without a writable mount, no extraction model call or job claim occurs.
4. The relevant direct user input and final non-empty assistant message are copied into an immutable job snapshot.
5. `extraction_jobs` atomically claims `sessionId:turn`; replaying the event cannot duplicate work.
6. Existing knowledge is retrieved only from mounted destinations and framed with the conversation as untrusted JSON.
7. The provider's authoritative global policy is loaded for every extraction. A bounded auxiliary LLM call returns strict candidate JSON naming one supplied destination; the policy never imposes a candidate-count quota.
8. Runtime validation rejects unknown destinations, types, targets, arbitrary project IDs and malformed output. Conservative mode additionally requires durable knowledge backed by explicit or verified evidence and high confidence.
9. Audit mounts keep valid proposals pending. Direct mounts call the provider's atomic reconciliation operation: duplicates are skipped, compatible same-topic content is merged with a new version, and possible contradictions remain pending without overwriting the active entry.
10. A persistent DSH notice reports per-base direct and pending counts below the answer; failures produce a retryable failure notice.
11. Before every later model request, plugin notices with `form: notice` are removed from the final request message list. Extraction snapshots also accept only direct user messages. Notices remain durable UI feedback but never consume or influence model context.

The extractor explicitly refuses secrets and ephemeral output in its system policy. Conflicts always remain behind human review, including on direct-write mounts.

## Recall flow

Recall is a hybrid of a replaceable runtime-context catalog, proactive snippets, and model-driven tools:

- `system-prompt/assemble` resolves the current session mounts and publishes only knowledge-base names, descriptions and tag filters as a lightweight runtime-context snapshot;
- `agent/pre-step` sees only the current claimed user input and proactively searches a small configurable number of snippets (default 3);
- `knowledge_search` lets the model issue a focused natural-language query across all or one mounted base;
- `knowledge_read` opens an exact matched section through a signed, session-bound handle and paginates unusually long content;
- remote retrieval can be awaited;
- cancellation propagates through the current turn signal;
- proactively injected snippets are attributed as plugin `dsh-knowledge`, form `recall`;
- retrieval failure is fail-open and never prevents a model response.

Only active entries from recall-enabled resolved mounts are searched. Each search and read applies that mount's include/exclude tag constraints and project scope. Exact project entries are ordered before global entries. Proactive retrieval injects only compact snippets and handles; full content enters the model context only after an explicit `knowledge_read` call. The framing tells the model that knowledge is contextual data and cannot override current system or user instructions.

## Local and remote topology

Local and remote modes are mutually exclusive for one plugin instance. There is deliberately no transparent cache or two-way synchronization: that would create conflict semantics at a second layer and obscure which database is authoritative.

A local provider always supports its same-origin management console unless `exposeWeb` is explicitly disabled. This internal surface is distinct from the public API: enabling the public route is an explicit, persistent action in “访问管理”, and enabling it prevents the same instance from switching to a remote provider. In remote mode the same embedded console uses a bounded same-origin server proxy to the configured central API; the browser never receives the saved remote token, and central access-management controls remain hidden. Remote clients use the same provider contract, so extraction candidates and recall work identically. Network timeouts and DSH turn cancellation bound remote requests.

## Security boundaries

- Stored connection secrets are never returned by plugin control APIs or written to logs.
- Server tokens are stored as SHA-256 digests; generated client tokens are shown once.
- Permissions are capability-oriented: `read`, `propose`, `write`, `admin`.
- Request bodies are capped at 1 MiB and every domain value has size/range validation.
- Hard deletion and token management require admin.
- Remote URLs require HTTPS except explicit loopback testing.
- Tool handles are HMAC-signed, bound to the calling session, and re-authorized against live mount, project and tag policy on every read.
- The embedded DSH web server has no TLS; LAN/public exposure requires an HTTPS reverse proxy.
- The management console uses a dedicated same-origin API guarded by Fetch Metadata, origin checks and a non-simple client header; it never makes the public Bearer API implicitly available.
- Public API routes always require Bearer capabilities. Any user who can access the DSH Web origin can administer the local knowledge base, so public DSH deployments must protect the whole origin with authentication at the reverse proxy.

## Deferred modules

- Explicit export/import jobs.
- Optional embeddings/reranking behind a retrieval port.
- Retry controls for failed extraction jobs.
- Multi-user tenant isolation.

These are additions around existing boundaries; none requires changing the entry, candidate or provider semantics.
