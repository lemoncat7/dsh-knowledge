# Architecture

## Design goals

The plugin is a modular monolith inside one DSH process. It keeps deployment simple while preserving explicit boundaries that can later become separate packages without changing the knowledge contract.

```text
DSH events / pre-step / HTTP / Web console
              |
     extraction, recall, API
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
- `extraction.ts` snapshots completed turns, resolves writable mounts and validates model JSON fail-closed.
- `recall.ts` performs bounded retrieval in the asynchronous `agent/pre-step` waterfall.
- `api.ts` is a size-bounded HTTP adapter with permission checks and safe errors.
- `web.ts` serves a same-origin, CSP-constrained management console from package-owned static assets.
- `web/` is a dependency-free browser application with a small API/state/view boundary; it stores credentials only in session storage.
- `index.ts` validates configuration and wires lifecycle disposal.

## Data model and consistency

SQLite is authoritative in local mode. Schema version 2 contains:

- `knowledge_bases`: independently named destinations with default tags and extraction instructions.
- `knowledge_mounts`: project/session policy overlays for recall, write mode and tag constraints.
- `knowledge_entries`: current materialized entry state.
- `knowledge_versions`: immutable snapshots for every create, update, archive or restore.
- `knowledge_fts`: FTS5 index containing only active entries.
- `knowledge_candidates`: proposed create/update/conflict decisions and review state.
- `extraction_jobs`: one idempotency record per `sessionId:turn`.
- `api_tokens`: token metadata, permissions and SHA-256 token digests.

Entry writes, version creation and FTS changes share one `BEGIN IMMEDIATE` transaction. Candidate approval and its resulting entry mutation are also one transaction. WAL mode permits readers during a writer, `busy_timeout` absorbs short contention, and foreign keys prevent orphan versions.

An active content hash unique index blocks byte-equivalent duplicate knowledge. Candidate proposals additionally deduplicate by source turn plus proposal hash.

## Extraction flow

1. Awaited `agent/turn-stopping` observes the completed answer before `turn/end` is committed.
2. Project mounts are resolved and then overlaid by explicit session mounts; a disabled session mount blocks inheritance.
3. Without a writable mount, no extraction model call or job claim occurs.
4. The relevant direct user input and final non-empty assistant message are copied into an immutable job snapshot.
5. `extraction_jobs` atomically claims `sessionId:turn`; replaying the event cannot duplicate work.
6. Existing knowledge is retrieved only from mounted destinations and framed with the conversation as untrusted JSON.
7. A bounded auxiliary LLM call returns strict candidate JSON naming one supplied destination.
8. Runtime validation rejects unknown destinations, types, targets, arbitrary project IDs and malformed output.
9. Audit mounts keep valid proposals pending. Direct mounts auto-approve only non-conflicts at or above the confidence threshold.
10. A persistent DSH notice reports per-base direct and pending counts below the answer; failures produce a retryable failure notice.

The extractor explicitly refuses secrets and ephemeral output in its system policy. Conflict and low-confidence proposals always remain behind human review.

## Recall flow

Recall uses `agent/pre-step`, not a synchronous prompt callback. This is intentional:

- the waterfall sees the current user messages;
- remote retrieval can be awaited;
- cancellation propagates through the current turn signal;
- the injected message is attributed as plugin `dsh-knowledge`, form `recall`;
- retrieval failure is fail-open and never prevents a model response.

Only active entries from recall-enabled resolved mounts are searched. Each search applies that mount's include/exclude tag constraints. Exact project entries are ordered before global entries, and only a configured number and character budget are injected. The framing tells the model that knowledge is contextual data and cannot override current system or user instructions.

## Local and remote topology

Local and remote modes are mutually exclusive for one plugin instance. There is deliberately no transparent cache or two-way synchronization: that would create conflict semantics at a second layer and obscure which database is authoritative.

A local provider may expose the API and become a central service. Remote clients use the same provider contract, so extraction candidates and recall work identically. Network timeouts and DSH turn cancellation bound remote requests.

## Security boundaries

- Secrets are configuration-only and are never returned by plugin APIs or written to logs.
- Server tokens are stored as SHA-256 digests; generated client tokens are shown once.
- Permissions are capability-oriented: `read`, `propose`, `write`, `admin`.
- Request bodies are capped at 1 MiB and every domain value has size/range validation.
- Hard deletion and token management require admin.
- Remote URLs require HTTPS except explicit loopback testing.
- The embedded DSH web server has no TLS; LAN/public exposure requires an HTTPS reverse proxy.
- The management console uses the same Bearer permissions as every other client, never puts tokens in URLs, and ships with a restrictive Content Security Policy.

## Deferred modules

- Explicit export/import jobs.
- Optional embeddings/reranking behind a retrieval port.
- Retry controls for failed extraction jobs.
- Multi-user tenant isolation.

These are additions around existing boundaries; none requires changing the entry, candidate or provider semantics.
