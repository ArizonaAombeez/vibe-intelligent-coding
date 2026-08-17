import { ZaiGlmClient } from './ZaiGlmClient.js'
import type { GlmAccessMethod } from './ZaiGlmClient.js'
import type { GlmClient } from './GlmClient.js'

// Generic factory the application layer calls without knowing this
// module's constructor shape — same `values` bag the settings UI collects
// via settingsManifest's `fields`. Falls back to GLM_API_KEY so a
// dev/CI environment can run without touching the Settings UI, same as the
// server's previous hardcoded getGlmClient() did.
export function createClient(values: Record<string, string>): GlmClient {
  const apiKey = values.apiKey || process.env.GLM_API_KEY
  if (!apiKey) throw new Error('vic-llm-glm: no apiKey configured')
  return new ZaiGlmClient({
    apiKey,
    accessMethod: (values.accessMethod as GlmAccessMethod) || undefined,
    model: values.model || undefined,
  })
}
