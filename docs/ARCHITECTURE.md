# Jarvis architecture

## The one decision that shapes everything else

**`src/core` does not import Electron.**

Everything that makes Jarvis useful — parsing, indexing, searching, planning a
query, grounding an answer — is plain TypeScript with no knowledge of windows,
IPC or the desktop. Electron is a shell around it.

This is why the 61-test suite runs in a second with no GUI and no network, and
it is why V0.2's mail connector, V1.0's voice interface or a future mobile
backend can reuse the same core instead of reimplementing it.

```
src/
  core/        no Electron imports, fully unit-tested
    security/    path containment guard, keychain-backed secrets
    storage/     document store, atomic JSON writes
    parsers/     pdf · docx · xlsx · csv · txt · md
    index/       tokeniser, BM25 index, chunker, incremental indexer
    files/       authorised-folder crawler
    ai/          provider abstraction + implementations
    assistant/   query planning, retrieval, grounded answering, session memory
    logging/     append-only local audit log
  main/        Electron main process: window, IPC, service wiring
  preload/     the only bridge to the UI
  renderer/    React interface
  shared/      types and IPC channel names used by both sides
```

## Zero native dependencies, on purpose

The obvious choice for local search is SQLite with FTS5. Jarvis does not use it.

Native modules must be compiled against Electron's ABI at install time. When
that fails — a missing compiler, an Xcode licence prompt, a proxy — the app does
not start, and the person it fails for is usually not in a position to debug it.
For something meant to be used every day, that is the wrong failure mode to
accept in exchange for performance nobody at this scale will notice.

So the search layer is a BM25 inverted index written in TypeScript
(`src/core/index/bm25.ts`, ~200 lines). `npm install` cannot fail.

It sits behind `SearchIndex`, which is the only thing the assistant talks to.
Replacing it with SQLite FTS5, or adding a vector store alongside it, means
reimplementing that one class.

### How ranking works

Three fields are indexed separately and scored together:

| Field | Weight | Why |
|---|---|---|
| File name | 6 | "Find my latest GTA operational plan" is usually satisfied by the file name alone |
| Folder path | 2 | A weaker but real signal about what a document is |
| Passage text | 1 | Best-matching passage plus a decayed share of the rest |

The body contribution is `Σ score(chunkᵢ) / (1 + i)` over a document's matching
passages, so a file that discusses a topic throughout beats one with a single
passing mention, without long files winning purely on length.

Recency multiplies the score only when the question asked for it ("latest",
"most recent"), and never by enough to push a weak match above a strong one.

The tokeniser keeps short tokens and digits rather than filtering them, because
acronyms and reference numbers — GTA, LRD, NDIS, invoice 1042 — are exactly what
this archive is searched by.

## How a question becomes an answer

```
question
   │
   ├─ 1. plan          LLM expands acronyms and classifies intent.
   │                   Falls back to rules if there's no provider or it fails,
   │                   so search never depends on the network.
   │
   ├─ 2. search        Local BM25. Nothing leaves the machine.
   │
   ├─ 3. scope         If the question says "it" or "those", stay with the
   │                   documents already in the conversation.
   │
   ├─ 4. find/locate → return the file list. Done. No document text sent.
   │
   └─ 5. answer/compare
          ├─ select passages under a hard character budget
          ├─ send question + passages to the provider
          ├─ parse [n] citations back to files and pages
          └─ return answer + sources + disclosure of what was sent
```

Step 4 matters: the most common request — *find me this document* — never sends
any document text anywhere.

### Grounding

The answering prompt requires the model to use only the supplied excerpts, cite
every claim with a bracketed excerpt number, and reply with a literal
`INSUFFICIENT:` marker when the excerpts do not contain the answer. Jarvis
detects that marker and renders it as an honest "I could not find enough
information", with suggestions, rather than prose that reads like an answer.

Citations are parsed out of the response, so the sources list reflects what the
model actually used, not everything it was offered.

## Conversational memory

`Session` (`src/core/assistant/session.ts`) keeps the last few turns and the
documents from the most recent useful answer. That is the whole mechanism, and
it is enough for "find it" → "summarise it" → "what's outstanding?".

It is deliberately in-memory and session-scoped. Persistent memory means storing
a record of the user's questions on disk, which needs a better reason than
"we could".

## The AI provider abstraction

`AIProvider` (`src/core/ai/provider.ts`) is four properties and one method.
Nothing above it knows which provider is in use.

Shipped: **Anthropic Claude**, and an **OpenAI-compatible** provider that covers
OpenAI, Ollama, LM Studio and anything else speaking that protocol — which is
what makes fully-local inference possible today, not in a later version.

Adding one means writing a class and registering it in
`src/core/ai/registry.ts`. No other file changes.

Structured output (the query planner) is requested through a schema hint and
parsed with a tolerant extractor that handles code fences and preamble, rather
than through any one vendor's JSON mode — so the abstraction stays honest.

## Storage

```
~/Library/Application Support/Jarvis/
  settings.json        authorised folders, provider choice — never secrets
  secrets.enc.json     API keys, encrypted by the macOS keychain
  logs/*.jsonl         append-only audit log
  index/
    catalog.json       one record per indexed file
    chunks/<id>.json   extracted passages
    search-index.json  serialised BM25 index
```

Everything under `index/` is derived data. Deleting it costs only the time to
re-index, which is why **Delete Jarvis's index** is a safe button rather than a
scary one. The search index can always be rebuilt from `chunks/`, and is
automatically if it is missing or stale at startup.

Settings are written atomically (temp file plus rename) so a crash mid-write
cannot corrupt the authorised-folder list.

## Indexing

Incremental by size and modification time: unchanged files are not re-read.
Files that have disappeared are dropped. A file that fails to parse stays listed
with the reason shown, rather than vanishing silently — a scanned PDF with no
text layer should be visible as *"needs OCR"*, not absent.

The crawler skips hidden directories, `node_modules`, caches, and Office lock
files, and does not follow symlinked directories — which prevents both loops and
escapes from the authorised root.

## Security boundaries

| Boundary | How it is enforced |
|---|---|
| Renderer → everything | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The UI can only call the named methods in `src/preload/index.ts`. |
| Any file read | `assertReadable` re-checks the authorised list, resolving symlinks, at the point of use. |
| Opening a file | Re-validated before handing the path to macOS, so a stale id cannot open something out of bounds. |
| API keys | OS keychain only; refuses to persist if unavailable. Never reaches the renderer. |
| External navigation | Links open in the user's browser; in-app navigation is blocked. |
| Content Security Policy | Set in `index.html`; no remote scripts, styles or fonts. |

## Extension points for the phases ahead

| Version | What it plugs into |
|---|---|
| **V0.2** Outlook | A source alongside `files/`, feeding the same chunk-and-index pipeline. Messages become documents with their own locators. |
| **V0.3** Businesses | `AuthorisedFolder.context` already exists and is stored. The retriever takes a `restrictTo` set — business scoping is a filter, not a rewrite. |
| **V0.4** Tasks / reMarkable | Another source; `Session` grows a persistent sibling for carried-forward work. |
| **V0.5** Automation | The audit log and the approval-gated permission model are already in place; actions register as capabilities requiring explicit confirmation. |
| **V1.0** Voice / mobile | Core has no UI dependency. A different front end calls the same assistant. |

## Testing

`npm test` — 61 tests, no network, no GUI. Covers the path guard including
symlink escape, every parser, the tokeniser and BM25 ranking, incremental
indexing, keychain refusal behaviour, and the full question-to-answer flow
against a scripted provider — including that Jarvis stays in context on
follow-ups, discloses what it sent, and refuses to invent an answer.

`tests/smoke/smoke.mjs` launches the real Electron app and drives the real UI
(see the header of that file). It is not part of `npm test` because it needs
Playwright, which Jarvis does not otherwise depend on.
