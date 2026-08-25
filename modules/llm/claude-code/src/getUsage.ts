import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PluginUsage, UsageWindow } from './PluginUsage.js'

// Undocumented/reverse-engineered endpoint (the same one Claude Code's own
// /status command and the ccusage project use) — there is no public API
// for Pro/Max plan usage. This can change without notice; a failure here
// should degrade to "usage unavailable", never break the chat path.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

interface OAuthCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string
  }
}

interface OAuthUsageWindow {
  utilization?: number
  resets_at?: string
}

interface OAuthUsageResponse {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
}

export class ClaudeCodeUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeCodeUsageError'
  }
}

// Overridable only from tests — mirrors ClaudeCodeCliClient's binary/
// binaryArgs seam. Never set in production; getUsage() always resolves the
// real per-user credentials path.
let credentialsPathOverride: string | undefined

export function __setCredentialsPathForTests(overridePath: string | undefined): void {
  credentialsPathOverride = overridePath
}

// Reads the access token `claude /login` already stored on this machine.
// VIC never asks the user for this credential (see settingsManifest.ts) —
// it only reads what the CLI itself manages.
async function readAccessToken(): Promise<string> {
  const credentialsPath = credentialsPathOverride ?? path.join(os.homedir(), '.claude', '.credentials.json')
  let raw: string
  try {
    raw = await readFile(credentialsPath, 'utf8')
  } catch {
    throw new ClaudeCodeUsageError(
      `Could not read Claude Code credentials at ${credentialsPath}. Run "claude" and complete /login first.`,
    )
  }
  let parsed: OAuthCredentialsFile
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ClaudeCodeUsageError('Claude Code credentials file is not valid JSON.')
  }
  const token = parsed.claudeAiOauth?.accessToken
  if (!token) {
    throw new ClaudeCodeUsageError('Claude Code credentials file has no access token — run /login again.')
  }
  return token
}

function toUsageWindow(window: OAuthUsageWindow | undefined): UsageWindow | undefined {
  if (!window || typeof window.utilization !== 'number') return undefined
  return {
    percentUsed: window.utilization,
    resetsAt: window.resets_at,
  }
}

// Fetches the current Pro/Max plan rate-limit usage for the account behind
// the CLI's own OAuth login. Independent of the `--print` chat path (which
// never surfaces this data — the statusline JSON that carries it is only
// populated inside an interactive `claude` session).
//
// Takes the same `values` bag createClient() does, purely so the server
// registry can call every plugin's getUsage the same way — this plugin has
// no settings that affect usage lookup (auth is the CLI's own OAuth login,
// not a value the user enters), so the parameter is unused.
export async function getUsage(_values: Record<string, string> = {}): Promise<PluginUsage> {
  const accessToken = await readAccessToken()

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    })
  } catch (err) {
    throw new ClaudeCodeUsageError(`Failed to reach ${USAGE_URL}: ${(err as Error).message}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new ClaudeCodeUsageError(
      `Usage request failed with status ${response.status}: ${body || response.statusText}`,
    )
  }

  const data = (await response.json()) as OAuthUsageResponse
  return {
    currentWindow: toUsageWindow(data.five_hour),
    weekly: toUsageWindow(data.seven_day),
  }
}
