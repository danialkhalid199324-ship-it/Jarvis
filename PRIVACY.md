# How Jarvis handles your data

These are not aspirations. Each one is enforced in code, and the file that
enforces it is named.

## 1. Jarvis only sees folders you authorise

Adding a folder requires you to pick it in the macOS folder chooser. There is no
code path that adds a folder any other way — `chooseFolder` in
`src/main/ipc/register.ts` is the only way a folder enters the authorised list,
and it always opens the native dialog.

Every filesystem read is then re-checked against that list, resolving symlinks on
both sides, so a shortcut placed inside an authorised folder cannot be used to
reach anything outside it. That check is `assertReadable` in
`src/core/security/paths.ts`, and it is covered by tests that include the
symlink-escape case.

Removing a folder also deletes everything Jarvis read from it.

## 2. Jarvis never changes your files

No code in Jarvis opens one of your documents for writing. Parsers read; the
indexer reads; opening a file hands it to macOS to open in its normal
application. The only place Jarvis writes is its own data directory.

A test in `tests/indexer.test.ts` snapshots the size and modification time of
every file in a folder before and after a full index run and asserts nothing
moved.

## 3. Searching happens entirely on your Mac

The search index is built and queried locally, with no network access. If you
never configure an AI provider, Jarvis still finds your documents — it just
can't summarise them.

## 4. What is sent when you ask Jarvis to read something

When a question needs a document *read* rather than just *found*, Jarvis:

1. searches locally and picks the most relevant files;
2. selects specific passages from them — never whole files, never whole folders,
   and never anything from a file it did not select;
3. stops at a hard character budget (60,000 characters by default, adjustable);
4. sends only those passages, with your question, to the provider you chose.

The selection step is `buildExcerpts` in `src/core/assistant/context.ts` — the
single place in the codebase where data is prepared to leave the machine.

**Every answer produced this way tells you what was sent**: the provider, the
model, how many excerpts, roughly how many words, and which files they came
from. It is part of the answer, not hidden behind a setting.

If you point Jarvis at a model running locally through Ollama, step 4 stays on
your Mac too and the disclosure says so.

## 5. Jarvis does not make things up

When the selected passages don't contain the answer, Jarvis says it could not
find enough information and suggests what to try instead. The model is
instructed to answer only from the excerpts, to cite every claim, and to flag
insufficiency explicitly rather than fill the gap with general knowledge. Answers
carry citations back to the exact file and page so you can always check.

## 6. Your API keys

Keys are encrypted by the macOS keychain (Electron's `safeStorage`) and stored
separately from your settings. They are never written to `settings.json`, never
logged, never sent to the renderer process, and never appear in source code. If
the keychain is unavailable, Jarvis refuses to save a key rather than writing one
in the clear — see `src/core/security/secrets.ts`.

## 7. What Jarvis records

An append-only log on your Mac records folders authorised and revoked, index
runs, and every call to an external AI provider — including which files'
excerpts were included and how much text. **Document contents are never
logged**, only counts and file names. Read it in **Settings → Activity**.

## 8. Deleting everything

**Settings → Delete Jarvis's index** removes every trace of what Jarvis has read:
the extracted text, the search index, the lot. Your original documents are
untouched. Jarvis goes back to knowing nothing until you index again.

## 9. The interface between the app and the outside world

The user interface runs with no Node.js access, no filesystem access, and no
network access of its own. It can only call the named operations listed in
`src/preload/index.ts`. Nothing in a document you index can widen that surface.

## 10. Designed for what comes later

Future versions will send email, file documents and take actions on your behalf.
The permission model is built for that now: consequential actions are meant to
require explicit approval, every action is already logged locally, and the
authorised-folder boundary is checked at the point of use rather than assumed.
