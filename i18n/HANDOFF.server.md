# English mode — the server side's answer to HANDOFF.md

From the server, agent and data work (server/lib/lang.js and its callers) to the web UI side.
Terms: i18n/GLOSSARY.md.

## Contract, as built in the server

- **Language of a request**: `X-PGL-Lang` header, else `?lang=` (for `/api/events?token=…&lang=…`,
  where EventSource cannot send headers), else the person's saved language, else `ko`
  (`resolveLang` in `server/lib/lang.js`; `auth()` in `server/index.js`). Unknown values (`fr`,
  `english`) fall through to the next source.
- `PUT /api/me/lang {lang: 'en'|'ko'}` → `{lang}`; anything else → 400 `{error}`. Stored in
  `pro_profile.lang` (`server/sql/019_lang.sql`, idempotent, **no default**).
- `GET /api/me` → `{…, lang, reqLang}`: `lang` is the saved value and stays `null` until the person
  chooses (as asked); `reqLang` is the language that request ran in (header > query > saved > ko).
- **Background work** (mail poller, missions/pg_cron runs, mining worker and scans, meetings,
  browser and folder process steps, step-retry and constraint notices, teammate notifications)
  runs in the saved language of the person it is for — owner or recipient — not of whoever
  triggered it. So the page should save the language (it does) for English-mode background cards.

## What comes back in English at the source (English mode)

- Every direct model call (`lib/llm.js chat/chatJson/chatStream`) carries an English note at the
  end of its first system message, plus explicit English prompts where the prompt asked for Korean.
- Every agent message (deepagents, cli-agent, skill-creator, folder runs, missions) ends with an
  `[Instruction]` line: answer in English, English file names, English text inside files
  (`langInstruction()`). Claude Code in the workroom terminal gets `--append-system-prompt` with
  the same note when the person opening it is in English mode (the ticket carries the language).
- Fixed sentences the server writes (chat lines, chips, cards, notifications, errors, statuses,
  onboarding, brief dividers, practice mails, demo mailbox) have English versions via `L(ko, en)`.
  Korean stays byte-identical, so the dictionary entries for Korean server text keep working for
  rows stored before.
- `GET /api/conversations` rewrites the context router's Korean summary labels ("최근 요청:",
  "최근 답:", "진행 중인 요청") for English-mode requests; the router itself is not changed.
- Practice mails (`GET /api/mail/demo-templates`) and the demo mailbox come from
  `server/fixtures/*-en.json` (same ids, addresses, amounts and dates).

## Still Korean, on purpose (the dictionary may want them)

- Rows written before the person switched language (stored text is shown as it was written).
- Tenant data made by Korean-mode people: process, step, form, role, skill and file names.
- Agent-only instructions (tool descriptions, the live-editor hints) — the person never sees them;
  the agent answers in English because of the `[Instruction]` line.
- The task-card failure line written for everyone at server start ("서버가 다시 시작되어 작업이
  중단됐어요.") is English for people whose saved language is English.

## Embedded editors

- IeumOffice: `process-gpt-office-host` branch **`feat/per-page-ui-lang`** answers the editors'
  `app:get-language` from the page's own `lang=en|ko` query (the renderer shim), so the page's
  `lang=en` is honoured per connection; without the parameter the host's `IEUM_LANG` answers as
  before. The running host (:5390, `/Users/uengine/uengine-platform/ieumoffice-web`) picks it up
  after that branch is merged/checked out there and `node host/build.mjs` + a host restart — not
  done here, to leave the shared dev host alone while Korean screenshots are taken.
- Documents and file names the agents create through office-mcp and the ArtCraft apps are English
  in English mode (instruction + English example names in the hints; an English design proposal is
  a Word document with the CADCraft floor plan picture in it, instead of the Korean 한글 template).
