# Jarvis

**Your Life. Organised. Ahead.**

A private AI executive assistant that runs on your Mac.

This is **V0.1 — Local Intelligence**. It does one thing, and it does it properly:
it finds and answers questions about the documents in the folders you authorise.
Email, calendar, reMarkable, browser automation, voice and business agents are
later phases and are not built yet.

---

## What V0.1 can do

- **Find documents in plain English.** "Find my latest GTA operational plan."
  "What documents do I have relating to Titan Security?"
- **Read and answer from them.** "Summarise it and tell me what still needs
  attention." Answers cite the exact file and page they came from.
- **Follow a conversation.** Ask a follow-up and Jarvis stays with the document
  you were just looking at.
- **Tell you when it doesn't know.** If your documents don't contain the answer,
  Jarvis says so and suggests what to try instead. It does not guess.
- **Read PDF, Word, Excel, CSV, Markdown and plain text.**

## What it deliberately will not do

- It never scans your Mac. It only sees folders you explicitly add.
- It never modifies, moves, renames or deletes your files. It only reads them.
- It never uploads a whole file or a whole folder. When an answer needs AI, only
  the specific passages Jarvis selected are sent — and the app tells you exactly
  what was sent, to whom, every time.
- It never shows made-up data. Screens for features that don't exist yet say so.

---

## Setting it up

You need a Mac and [Node.js 20 or newer](https://nodejs.org) (the LTS installer
is fine). In Terminal, from this folder:

```bash
npm install
npm run build
npm start
```

To build a real `Jarvis.app` you can keep in your Applications folder:

```bash
npm run mac
```

The installer appears in `release/`. It is unsigned, so the first time you open
it macOS will warn you — right-click the app and choose **Open** to confirm.

### First run

1. Open **Settings → Data & Permissions**.
2. Click **Add folder** and choose a folder of documents. macOS may ask for
   permission to read it — that prompt is the operating system's, not Jarvis's.
3. Click **Index now** and wait. Jarvis reads the files once so it can search
   them instantly afterwards.
4. Go **Home** and ask something.

Search works with no setup beyond this. You only need an AI provider if you want
Jarvis to *read* documents and answer questions about them, rather than just
find them.

### Adding an AI provider

In **Settings → AI Provider**, either:

- **Anthropic Claude** — paste an API key from
  [console.anthropic.com](https://console.anthropic.com). Your key is encrypted
  by the macOS keychain. This is the default.
- **A model running on your own Mac** — choose *OpenAI-compatible*, set the
  endpoint to `http://localhost:11434/v1`, and run [Ollama](https://ollama.com).
  Nothing then leaves your machine at all, including document excerpts.

---

## Privacy, in one paragraph

Your documents stay on your Mac. Searching them happens entirely offline and
needs no internet connection. The only time anything leaves your machine is when
you ask a question that requires *reading* a document — and then Jarvis sends
only the handful of passages it selected, never the whole file and never anything
from a file it didn't cite. Every one of those requests is disclosed in the
answer itself and written to a log on your Mac that you can read in
**Settings → Activity**. Full detail is in [PRIVACY.md](PRIVACY.md).

---

## Day-to-day

| Task | Where |
|---|---|
| Ask a question | Home |
| See everything Jarvis has indexed | Files |
| Add or remove an authorised folder | Settings → Data & Permissions |
| Re-index after adding new documents | Settings → **Index now** |
| Delete everything Jarvis has stored | Settings → **Delete Jarvis's index** |
| See what Jarvis has been doing | Settings → Activity |

**Re-indexing is cheap.** Jarvis only re-reads files whose size or modification
date changed, so running **Index now** after adding a few documents takes
seconds. Use **Rebuild from scratch** only if something looks wrong.

---

## For whoever works on this next

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it is put together and why, plus
  the extension points each future phase will use.
- [PRIVACY.md](PRIVACY.md) — the data-handling rules the code enforces.

```bash
npm test          # 61 tests covering the core, no network or GUI needed
npm run typecheck
npm run dev       # hot-reloading development build
```

## Roadmap

| Version | Scope |
|---|---|
| **V0.1** | **Local file intelligence — this release** |
| V0.2 | Microsoft Outlook mail and calendar |
| V0.3 | Multi-business intelligence (GTA, Titan, Pathlyn, NDIS, personal) |
| V0.4 | Tasks and reMarkable, carrying unfinished work forward |
| V0.5 | Browser and application automation, with approval controls |
| V1.0 | Voice, mobile access, proactive morning and evening briefings |
