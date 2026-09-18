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

---

# V0.2: Microsoft 365

## 11. Jarvis never acts without you

Reading, searching, analysing, summarising and drafting happen automatically
once you connect an account. Sending an email and creating, changing or
cancelling a calendar event **never** do.

Every consequential action becomes a record that has done nothing, shows you
exactly what it would do, and waits. The code that actually performs an action
is registered privately inside the approval engine (`approvals.ts`) and is held
nowhere else — no part of the conversational path has a reference to it. That is
the structural reason wording cannot get around the gate: a conversation is
only able to produce a proposal. `ApprovalEngine.approve(id)` is the single
entry point, it is called only from the IPC handler behind the approval button,
and it executes the payload stored when the action was proposed — so what runs
is necessarily what you were shown.

## 12. Your Microsoft credentials

Jarvis signs in with the authorization code flow and PKCE, in your own system
browser. There is no embedded web view, no username/password path, and no
client secret — it is registered as a public client, which has none.

Access and refresh tokens live in an MSAL cache encrypted by your macOS
keychain, stored through the same mechanism as your AI provider key. They are
never written to a settings file, never logged (MSAL's own logging is capped at
error level with PII disabled), never passed across the bridge to the Jarvis
window, and never sent to an AI provider. If the keychain is unavailable, Jarvis
refuses to save them rather than writing them in the clear.

## 13. Least-privilege permissions

Jarvis requests seven **delegated** scopes and no application permissions, so it
acts as you and can never reach another person's mailbox or your organisation at
large. Each one is listed with its reason in Settings → Connected Accounts, and
in `docs/MICROSOFT-SETUP.md`. None normally requires an administrator; if your
tenant has disabled user consent, Jarvis says so plainly rather than asking for
anything broader.

## 14. What is sent when Jarvis reads your mail

The same rule as documents. Listing, searching and triaging mail send nothing —
all of that is Microsoft Graph filtering plus Jarvis's own scoring, which runs
on this Mac and costs nothing.

When a question needs a message *read*, Jarvis selects a handful of messages,
truncates each one, stops at a hard character budget, and sends only those —
never a mailbox, never a folder, never everything from a sender. The selection
happens in one place, `mail-context.ts`, and every answer produced this way
states the provider, the model, how many emails, roughly how many words, and
which accounts they came from.

## 15. Partial failure is never hidden

When several accounts are connected and one cannot be reached, Jarvis reports
which ones it actually checked and why the others failed — "I checked 3 of your
4 connected accounts. Titan needs its Microsoft session renewed." An expired
session, withdrawn consent, a throttled account and an offline Mac are
distinguished from one another, because they call for different actions. A
partial result is never presented as a complete one.

## 16. What the activity log records

Account connections and disconnections, index runs,every external AI call with its
counts and the accounts involved, and every proposed, approved, rejected and
completed action. Message bodies, draft text, recipients' content and tokens are
never logged.
