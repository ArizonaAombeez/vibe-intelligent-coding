# vic-llm-glm

Standalone LLM client module wrapping z.ai's GLM API (OpenAI-compatible
chat/completions). This module has no dependency on any other VIC module or
on VIC's domain model — it only knows how to send chat messages to z.ai and
return the reply text.

## Interface

```ts
interface GlmClient {
  chat(messages: LlmMessage[], options?: ChatOptions): Promise<string>
}
```

`ZaiGlmClient` implements `GlmClient` against `https://api.z.ai/api/paas/v4`.

## Running tests (standalone)

No other VIC module needs to be present or running.

```sh
cd modules/llm-glm
npm install
npm test
```

All tests mock `fetch` — no real network call, no API key required for the
test suite itself (a dummy key is set in test setup).

## Manual smoke test (real API call)

To verify against the real z.ai API once, with a real key:

```sh
cd modules/llm-glm
GLM_API_KEY=<your-real-key> npx tsx -e "
import { ZaiGlmClient } from './src/index.ts';
const client = new ZaiGlmClient();
const reply = await client.chat([{ role: 'user', content: 'Say hello in one word.' }]);
console.log(reply);
"
```

## Configuration

- `GLM_API_KEY` (env var, required) — your z.ai API key. Can also be passed
  as `new ZaiGlmClient({ apiKey: '...' })`.
- `model` (constructor option, default `glm-5.2`) — any z.ai GLM model name.
- `baseUrl` (constructor option, default `https://api.z.ai/api/paas/v4`).
