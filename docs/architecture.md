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

## DSH client contract

The browser integration is compiled against the exact official client packages used by the supported DSH release. These packages are pinned as development-only dependencies; they are never bundled into the plugin:

- `@deepseek-ai/dsh-client-runtime` supplies the official `ClientContext` and framework-standard slot props.
- `@deepseek-ai/dsh-client-ui-layout` declares the single `conversation` slot.
- `@deepseek-ai/dsh-client-ui-sidebar` declares the list `sidebar.footer.action` slot.
- `@deepseek-ai/dsh-client-ui-settings-plugins` declares the keyed `settings.plugin.item` slot.
- `@deepseek-ai/dsh-client-ui-theme` declares the theme service and `theme/change` event.
- `@deepseek-ai/dsh-client-ui-slots` supplies `SlotMap`, `PropsRuntime` and the typed registration contract.

`src/client.tsx` must not redeclare any of these services structurally. The TypeScript build includes both `.ts` and `.tsx`, so slot cardinality is checked before packaging: list entries require `id`, keyed entries require `key`, and the knowledge workspace shadows the official single `conversation` occupant at an explicit lower priority. Closing the workspace disposes only that registration and restores the official conversation occupant; the DSH shell is never replaced or patched.

## Layers

- `domain.ts` owns stable value types, normalization, IDs and content hashing. It has no DSH dependency.
- `provider.ts` is the storage/application port. Local and remote clients implement the same asynchronous contract.
- `local-provider.ts` owns schema migrations, transactions, FTS and token hashes.
- `remote-provider.ts` is an authenticated, timeout-bounded HTTPS adapter.
- `management-proxy.ts` lets the embedded console operate on the selected central service while keeping the saved remote token on the DSH server.
- `notes/domain.ts` owns stable note ids and knowledge-to-note relation types; `notes/store.ts` owns the independent directory tree, editable notes and opaque file storage.
- `note-reference-tools.ts` owns the AI-facing metadata search and structured reference mutations; `note-reference-handle.ts` keeps note selections opaque and session-bound.
- `extraction.ts` snapshots completed turns, resolves writable mounts and validates model JSON fail-closed.
- `retrieval.ts` owns mounted-scope authorization, signed handles, ranking and bounded rendering shared by proactive and tool-driven retrieval.
- `recall.ts` owns the official prompt-assembly knowledge map and bounded first-step automatic retrieval. It also removes durable UI notices and prior recall snapshots before later model requests.
- `tools.ts` registers the tool-first retrieval chain: mounted-base discovery, scoped document search and paginated reading, plus explicit knowledge-base administration. Content write-back is deliberately absent from the main Agent tool surface.
- `api.ts` is a size-bounded HTTP adapter with two explicit authentication modes: same-origin administration for the embedded console and Bearer capabilities for remote clients.
- `web.ts` serves a same-origin, CSP-constrained management console from package-owned, content-versioned static assets.
- `web/app.js` is the browser composition root and owns navigation plus business view state. Transport, host integration and reusable DOM construction are deliberately outside it:
  - `web/api-client.js` owns authenticated JSON, binary download and progress-aware upload requests.
  - `web/host-theme.js` validates the parent-frame protocol and applies only the allowlisted light/dark palette.
  - `web/ui-primitives.js` owns dependency-free DOM, button, badge and toast primitives.
  - `web/styles.css` owns the management layout while `src/client.css` owns DSH-shell integrations; neither reads host component-fill or browser-default control styling.
- `service-settings.ts` atomically persists the user-controlled public API state separately from provider connection settings.
- `index.ts` validates configuration and wires lifecycle disposal.

## Data model and consistency

SQLite is authoritative in local mode. Schema version 12 contains:

- `knowledge_bases`: independently named destinations with default tags and extraction instructions.
- `knowledge_mounts`: project/session policy overlays for recall, write mode and tag constraints.
- `knowledge_entries`: current materialized entry state.
- `knowledge_versions`: immutable snapshots for every create, update, archive or restore.
- `knowledge_fts`: FTS5 index containing only active entries.
- `knowledge_candidates`: proposed create/update/conflict decisions, explicit append/revise change data, base revision metadata and review state.
- `extraction_jobs`: one idempotency record per `sessionId:turn`.
- `api_tokens`: token metadata, permissions and SHA-256 token digests.
- `knowledge_settings`: the authoritative global conservative/proactive writeback policy shared by local and remote clients.
- `knowledge_note_references`: the many-to-many relation between knowledge documents and stable note nodes, including user/agent/legacy provenance.

Each active `knowledge_entries` row represents one topic document and is materialized as one real Markdown file under `documents/base-<stable-id>/`. Related findings are Markdown sections or incremental content inside that row/file, rather than sibling one-fact documents. `knowledge_documents` indexes those files for the management console; the entry ID is the document ID, and the human-readable filename is derived from the title plus a stable ID suffix. Mutations complete only after the corresponding file synchronization finishes. Normal entry mutations update exactly one derived file and index row; the full-base reconciliation is reserved for startup repair. Knowledge-base metadata changes update only the manifest. SQLite remains authoritative so FTS, version history, direct-write reconciliation and remote providers keep one consistency model.

Notes form a separate hierarchical workspace beside the knowledge database:

```text
<knowledge data directory>/
├── knowledge.sqlite
├── documents/
└── notes/
    ├── notes.sqlite
    └── objects/
        └── note_<32 lowercase hexadecimal characters>
```

`notes.sqlite` stores an adjacency-list tree of folders, editable Markdown documents and uploaded files. Every node has a stable id and parent id; files additionally store media type, size and SHA-256. Text-based uploads expose an explicit editable capability and use the same atomic content update boundary as native note documents; binary uploads remain opaque. `objects/` stores document and file bytes under the stable id, so user-visible names never participate in physical paths. Moving and renaming are metadata-only operations. Folder copies recursively create new stable ids, and folder deletion is recursive. File operations use the shared cross-platform atomic writer and are capped at 64 MiB.

Knowledge-to-note references are explicit many-to-many rows in `knowledge_note_references`; knowledge Markdown contains only knowledge content. Moving or renaming a note does not break a relation because it targets the stable note id. Normal deletion of a node or ancestor folder is rejected while any descendant is referenced; explicit administrator force-deletion remains an API-only recovery operation. Schema 9 upgrades scan valid legacy `note://note_<id>` markers once and backfill `source=legacy` rows without rewriting user-authored Markdown, so old prose remains byte-safe while new mutations use only the relation table. Note content is not parsed, indexed, embedded, recalled or written back by the AI.

The management console never loads the complete document corpus during startup. `/document-index` returns a keyset-paginated metadata projection without `content`; its browse order has a matching SQLite index. The browser requests one page only for the initially selected knowledge base, loads other bases when their tree nodes expand, and fetches a document body only after selection. Search uses the same bounded index endpoint across the currently visible mounted bases. The original `/documents` endpoint remains available for compatibility, but is not part of console bootstrap, partner-source discovery or normal reference inspection.

Entry writes, version creation and FTS changes share one `BEGIN IMMEDIATE` transaction. Candidate approval and its resulting entry mutation are also one transaction. WAL mode permits readers during a writer, `busy_timeout` absorbs short contention, and foreign keys prevent orphan versions.

An active content hash unique index blocks byte-equivalent duplicate knowledge. Candidate proposals additionally deduplicate by source turn plus proposal hash.

## Extraction flow

1. Awaited `agent/turn-stopping` observes the completed answer before `turn/end` is committed.
2. Project mounts are resolved and then overlaid by explicit session mounts; a disabled session mount blocks inheritance.
3. Without a writable mount, no extraction model call or job claim occurs.
4. The relevant direct user input and final non-empty assistant message are copied into an immutable job snapshot.
5. `extraction_jobs` atomically claims `sessionId:turn`; replaying the event cannot duplicate work. A running claim is a 15-minute lease, so an interrupted process can recover the turn without leaving it permanently stuck; proposal hashes and a three-attempt ceiling keep recovery bounded and idempotent.
6. The authoritative writeback policy is loaded and writable mounts are grouped by their configured extraction model route.
7. Each route group searches its mounted bases for related existing documents, globally ranks the results and caps the comparison set.
8. One bounded model call decides destination relevance and extracts strict document-mutation JSON together. It returns a stable `documentTitle`, optional `sectionTitle`, Markdown body and an existing `targetId` whenever relevant. This avoids a second routing-model call and prevents an overly conservative first gate from discarding valid destination-specific knowledge. Model selection is explicit and deterministic: a client-local override wins first, then a knowledge-base-specific route, then the completed assistant turn's actual model, and finally the legacy static extraction route.
9. Runtime validation rejects unknown destinations, non-durable retention, types, targets, arbitrary project IDs and malformed output. It then coalesces same-base, same-scope and same-title mutations into one document proposal, merging sections, tags and provenance. Ambiguous proposals that point at different existing documents become conflicts instead of silently choosing a target.
10. Audit mounts keep valid proposals pending. Direct mounts automatically write high-confidence non-conflicting candidates; lower-confidence and conflicting candidates go to audit instead. Additions use the lossless append path. Revisions carry exact single-match old-text anchors plus the target version/hash and are replayed against the complete current document. Unrelated concurrent additions survive that replay; missing or ambiguous anchors become a conflict. Both paths create an immutable previous version before committing the new entry.
11. Per-base direct and pending counts are written to the service log and exposed through the completed-turn UI extension. The plugin never appends a synthetic `user/message`, so write-back cannot change model context, the conversation tail, or branching semantics.
12. Before every later model request, legacy plugin notices and prior recall snapshots are removed from the final request message list. Extraction snapshots accept only direct user messages.

The extractor explicitly refuses secrets and ephemeral output in its system policy. Conflicts always remain behind human review, including on direct-write mounts.

## Recall flow

Recall combines bounded automatic retrieval with model-driven tools:

- the official `system-prompt/assemble` waterfall contributes a bounded map containing mounted-base names, ids, descriptions and tags, but no document body;
- on the first step of each direct user turn, the plugin searches mounted bases, applies a configurable relevance floor and injects at most `autoRecallLimit` partial snippets with signed handles;
- `knowledge_base_search` matches the current information need against the names, routing descriptions and tags of recall-enabled mounted bases, returning metadata only;
- `knowledge_search` requires one exact base returned by the discovery tool and returns ranked snippets with signed handles;
- `knowledge_read` opens an exact result through a signed, session-bound handle and paginates long documents;
- `knowledge_note_list` browses one note folder or searches all note-node names, returning signed session-bound handles;
- `knowledge_note_search` searches non-folder note metadata without returning bodies;
- `knowledge_note_read` reads bounded UTF-8 chunks only after an explicit note request;
- `knowledge_note_create`, `knowledge_note_update`, `knowledge_note_move`, and `knowledge_note_delete` mutate the active local or remote note workspace only after a matching direct user request; remote permissions and referenced-note deletion protection remain server-enforced;
- `knowledge_note_references` lists, adds or removes relation rows using exact knowledge and note handles, re-resolving live mounts and rejecting writes through read-only mounts or finalized documents;
- content write-back, including an explicit user request to save knowledge, runs only in the separate completed-turn extractor and never in the main Agent loop;
- remote retrieval is awaited, cancellation propagates through the current turn signal, and independent per-mount requests run through a shared four-worker bound rather than an unbounded `Promise.all` fan-out;
- greetings and empty input skip automatic retrieval, and search failures fail open so the normal answer can continue.

Only active entries from recall-enabled resolved mounts are searchable. Each stage re-resolves live mounts, and search/read enforce include/exclude tags and project scope. Exact project entries rank before global entries. Automatic snapshots are partial reference data and are removed before later steps; full document content enters the request only through `knowledge_read`.

The prompt catalog states a strict response-isolation contract: the main model must never narrate persistence attempts, refusals or results. Every answer, including one that explicitly requests persistence, is handled by the bounded completed-turn extractor, which receives canonical source URLs present in the final answer but never raw tool output or prior plugin notices.

## Local and remote topology

Local and remote modes are mutually exclusive for one plugin instance. There is deliberately no transparent cache or two-way synchronization: that would create conflict semantics at a second layer and obscure which database is authoritative.

A local provider always supports its same-origin management console unless `exposeWeb` is explicitly disabled. Local runtime calls and the management console borrow the same provider instance, avoiding duplicate SQLite connections and startup projection passes; the provider router tracks borrowed ownership so switching to remote never closes the management store. This internal surface is distinct from the public API: enabling the public route is an explicit, persistent action in “访问管理”, and enabling it prevents the same instance from switching to a remote provider. In remote mode the same embedded console uses a bounded same-origin server proxy to the configured central API; the browser never receives the saved remote token, and central access-management controls remain hidden. Remote clients use the same provider contract, so extraction candidates and recall work identically. Network timeouts and DSH turn cancellation bound remote requests.

## Security boundaries

- Stored connection secrets are never returned by plugin control APIs or written to logs.
- Server tokens are stored as SHA-256 digests; generated client tokens are shown once.
- Permissions are capability-oriented: `read`, `propose`, `write`, `admin`. `write` is currently instance-wide and also covers knowledge-base, mount, and note mutations; ordinary remote clients should use `read + propose` unless they explicitly need that broader authority.
- JSON request bodies are capped at 1 MiB and every domain value has size/range validation. Only note content upload/download routes use the separate 64 MiB bound; the remote management proxy preserves the same distinction.
- Hard deletion and token management require admin.
- Remote URLs require HTTPS except explicit loopback testing.
- Knowledge and note tool handles are HMAC-signed and bound to the calling session. Reference mutations re-authorize the knowledge document against live mount, project, tag and write policy; note metadata search never returns file content.
- The embedded DSH web server has no TLS; LAN/public exposure requires an HTTPS reverse proxy.
- The management console uses a dedicated same-origin API guarded by Fetch Metadata, origin checks and a non-simple client header; it never makes the public Bearer API implicitly available.
- Public API routes always require Bearer capabilities. Any user who can access the DSH Web origin can administer the local knowledge base, so public DSH deployments must protect the whole origin with authentication at the reverse proxy.

## Deferred modules

- Explicit export/import jobs.
- Optional embeddings/reranking behind a retrieval port.
- Retry controls for failed extraction jobs.
- Multi-user tenant isolation.

These are additions around existing boundaries; none requires changing the entry, candidate or provider semantics.
