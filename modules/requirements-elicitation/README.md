# vic-requirements-elicitation

Standalone Requirements Elicitation module (VIC Area A — Elicitation
substep only). Owns the requirement data model, flat-file JSON persistence,
and both elicitation paths (structured form, Analyst chat). Has no
dependency on `vic-llm-glm` or any other VIC module — the Analyst-chat path
depends only on this module's own small `LlmClient` interface, which any
LLM client (GLM-backed or otherwise) can satisfy.

## What's in scope here

- Requirement data model (`Requirement`, `Project`, six requirement types,
  full status lifecycle enum).
- Flat versioned JSON persistence, one directory per project
  (`ProjectStore`).
- `createRequirementFromForm` — the structured-intake elicitation path,
  assigning permanent sequential `REQ-NNN` ids that are never reused.
- `chatWithAnalyst` — the Analyst-chat elicitation path. Builds the Analyst
  persona prompt with existing requirements as context, sends it to any
  `LlmClient`, and parses out proposed requirements (`REQUIREMENT: ...`
  lines) without saving them — the caller decides whether to accept a
  proposal via a separate `createRequirementFromForm` call.

## Explicitly not in scope here

Quality scoring, gap/conflict detection, change-request/freeze-after-signoff,
multi-source/multi-modal ingestion, bug-fix intake form, PRD export — later
increments on this same module.

## Running tests (standalone)

No other VIC module (including `vic-llm-glm`) needs to be present or
running — the Analyst-chat tests use a trivial in-test fake `LlmClient`.

```sh
cd modules/requirements-elicitation
npm install
npm test
```

## Wiring a real LLM client (application layer only)

This module never imports `vic-llm-glm`. The application (e.g. the server)
wires them together:

```ts
import { ZaiGlmClient } from 'vic-llm-glm'
import { chatWithAnalyst } from 'vic-requirements-elicitation'

const glm = new ZaiGlmClient() // reads GLM_API_KEY from env
const result = await chatWithAnalyst(project, glm, userMessage)
```

`ZaiGlmClient` satisfies this module's `LlmClient` interface structurally —
no import relationship between the two modules is required.
