import express, { type ErrorRequestHandler } from 'express'
import {
  ProjectStore,
  createRequirementFromForm,
  chatWithAnalyst,
  updateRequirementText,
  setAllocationRationale,
  analyseRequirements,
  importRequirementsFromText,
  countImportBlocks,
  PROJECT_PARTS,
  exportPart,
  importRequirementsFromPart,
  importArchitecturePart,
  proposeCodeGapRequirements,
  proposeCodeGapRequirementsPerFile,
  filterCodeFilesForGapScan,
  runCodeAlignmentAnalysis,
  runElementCodeCheck,
  checkConflicts,
  checkGaps,
  activeRequirements,
  deletedRequirements,
  deleteRequirement,
  restoreRequirement,
  purgeRequirement,
  reassignArchitectureElement,
  addRequirementToElement,
  removeRequirementFromElement,
  advanceStatusForward,
  regressStatusForRecode,
  setRequirementStatus,
  setCollapsedRequirementGroups,
  splitRequirement,
  findRequirementReferences,
  applySplitRequirement,
  setArchitectureType,
  createArchitectureElement,
  updateArchitectureElement,
  deleteArchitectureElement,
  addLayer,
  removeLayer,
  checkArchitectureConflicts,
  autoConfigureAndAllocate,
  autoAllocateLlm,
  generateProjectOverview,
  chatWithArchitect,
  acceptProposedInterface,
  removeArchitectureInterface,
  checkInterfaceConflict,
  defineInterfaceDefinition,
  defineAllInterfaceDefinitions,
  setInterfaceDefinition,
  reconcileElementInterface,
  checkInterfaces,
  nextFreeColumn,
  EXTERNAL_CONTEXT_ROW,
  ARCHITECTURE_TYPES,
  getProjectSettings,
  updateProjectSettings,
  estimateAnalysisTokens,
  estimateCodeGapScanTokens,
  DEFAULT_CODE_STRIP_OPTIONS,
  CODE_GAP_SCAN_SYSTEM_PROMPT,
  ANALYSIS_SYSTEM_PROMPT,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  generateFunctionalTestsForElement,
  generateIntegrationTestsForContract,
  generateAllTestsForUnplannedElements,
  chatWithQATestCreation,
  triageTestFailure,
  confirmTestCaseFailure,
  chatWithQATestExecution,
  classifyAndDispatchUserReportedIssue,
  formatCodeContextForTriage,
  importLegacyTestCases,
  deleteImportedTestCase,
  type ArchitectureTypeId,
  type ArchitectureElementKind,
  type PhaseTabGating,
  type Project,
  type LlmCallOptions,
  type LlmUsage,
  type LlmClient,
  type ProjectPartId,
  type RequirementsPartData,
  type ArchitecturePartData,
  type ImportedCodeFile,
  type PendingImport,
  type PendingImportPreview,
  type RequirementStatus,
  type CodeStripOptions,
  type UnitTestMode,
  type InterfaceContractOperation,
} from 'vic-requirements-elicitation'
import { generateMigrationPlan } from 'vic-planning'
import type { GlmAccessMethod } from 'vic-llm-glm'
import { glmModelCapabilities } from 'vic-llm-glm'
import {
  scaffoldProjectSourceTree,
  runCodingForElement,
  elementSubfolderName,
  sharedInterfaceSubfolderName,
  sourceTreeRoot,
  scanCodeForRequirementReferences,
  checkInterfaceCodeAlignment,
  interfaceGateReasonForElement,
  interfaceChangedSinceLastCoding,
  MARKER_FILENAME,
} from 'vic-coding'
import type { CodingAgentClient } from 'vic-coding'
import {
  generateTestFileForTestCase,
  runElementTestSuite,
  runFullRegression,
  evaluateRequirementStatus,
  scopeReadinessEntries,
} from 'vic-testing'
import JSZip from 'jszip'
import path from 'node:path'
import os from 'node:os'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { SecretsStore } from './secretsStore.js'
import { PersonaSettingsStore, type PersonaScope } from './personaSettingsStore.js'
import { GlobalSeqStore } from './globalSeqStore.js'
import { ServerSettingsStore } from './serverSettingsStore.js'
import { UsersStore } from './usersStore.js'
import {
  startRunLog,
  finishRunLog,
  readRunLog,
  acquireProjectRunLock,
  releaseProjectRunLock,
  readProjectRunLock,
  cancelProjectRun,
  ProjectRunLockedError,
} from './runLogRegistry.js'
import {
  installedPluginManifests,
  personas,
  findPluginManifest,
  findInstalledPlugin,
  CLI_BACKED_PLUGIN_IDS,
  codingAgentClient,
  openCodeAgentClient,
  checkClaudeCodeInstalled,
  GlmApiError,
  resolveGlmBaseUrl,
} from './settingsRegistry.js'

// Defaults live under the user's home directory, not process.cwd() — the
// server used to resolve '.vic-projects'/'​.vic' relative to whatever
// directory it happened to be launched from, so projects and saved plugin
// settings (API keys, model choices) appeared to "disappear" any time the
// server was started from a different folder (e.g. repo root vs.
// packages/server) even though the files were never touched. Anchoring to
// the home dir makes the default launch-location-independent; either
// var still overrides it explicitly if you want projects stored elsewhere
// (a synced drive, an external disk, etc).
const VIC_HOME = path.join(os.homedir(), '.vic')
const PORT = Number(process.env.PORT ?? 3001)
const SECRETS_DIR = process.env.VIC_SECRETS_DIR ?? VIC_HOME

const secretsStore = new SecretsStore(SECRETS_DIR)
const personaSettingsStore = new PersonaSettingsStore(SECRETS_DIR)
const globalSeqStore = new GlobalSeqStore(VIC_HOME)
const serverSettingsStore = new ServerSettingsStore(SECRETS_DIR)

// VIC is remote-only: every install shares one projects root on the team's
// network drive (Q:\VIC_Data by default) rather than each machine keeping
// its own local project store. Precedence: VIC_PROJECTS_ROOT env var >
// persisted Settings-screen override (Settings > Storage) > the shared-drive
// default. The env var wins over the persisted override so explicit,
// visible wiring (e.g. a deployment script) always stays authoritative and
// can never be silently shadowed by a stale override left over from a
// previous session. Read once at startup: this is a "restart required"
// setting (see PUT /api/system/storage below) rather than live-
// reconfigurable, since ProjectStore has no safe way to swap projectsRoot
// mid-request without risking a read/write racing against the old root.
//
// SECRETS_DIR (API keys, per-machine settings) deliberately stays local to
// each machine (~/.vic by default) even though PROJECTS_ROOT is shared —
// credentials aren't meant to be readable by everyone with drive access.
const DEFAULT_PROJECTS_ROOT = 'Q:\\VIC_Data'
const projectsRootOverride = process.env.VIC_PROJECTS_ROOT
  ? undefined
  : await serverSettingsStore.getProjectsRootOverride()
const PROJECTS_ROOT = process.env.VIC_PROJECTS_ROOT ?? projectsRootOverride ?? DEFAULT_PROJECTS_ROOT
const PROJECTS_ROOT_SOURCE: 'env' | 'override' | 'default' = process.env.VIC_PROJECTS_ROOT
  ? 'env'
  : projectsRootOverride
    ? 'override'
    : 'default'

const store = new ProjectStore({ projectsRoot: PROJECTS_ROOT })
const usersStore = new UsersStore(PROJECTS_ROOT)
// codingAgentClient/openCodeAgentClient are options-free singletons built by
// settingsRegistry.ts at startup — per-call model/effort/apiKey/baseUrl
// travel through runAgentTask's options (resolved from the Dev/QA persona
// per request, same as every chat-backed route), matching how
// getClientForPersona is never cached either. Either can be undefined if its
// plugin module (modules/llm/claude-code, modules/opencode) isn't
// present — see getCodingAgentClientForPersona below, which surfaces that as
// LlmNotConfiguredError rather than crashing.

// Running total across this server process's lifetime, accumulated from
// each GLM call's real reported usage (not estimated, unlike the UI's mock
// API). z.ai's Coding Plan is flat-rate against an included-usage
// allowance rather than metered per-token billing, and doesn't publish a
// per-token PAYG rate we can hardcode with confidence — so estimatedCostUsd
// stays a rough placeholder rate rather than a real invoiced figure, same
// caveat as the mock API's estimate. In-memory only — resets on restart,
// same lifetime as the rest of this process's state.
const MOCK_COST_PER_1K_TOKENS_USD = 0.001
let sessionTokenUsage = { totalTokens: 0, estimatedCostUsd: 0 }

function recordTokenUsage(usage: LlmUsage | undefined) {
  if (!usage) return
  sessionTokenUsage = {
    totalTokens: sessionTokenUsage.totalTokens + usage.totalTokens,
    estimatedCostUsd:
      sessionTokenUsage.estimatedCostUsd + (usage.totalTokens / 1000) * MOCK_COST_PER_1K_TOKENS_USD,
  }
}

// Distinct from GlmApiError (a failed call to a configured provider) — this
// is "no provider configured at all," so the UI can point the user at
// Settings instead of offering a Retry that can only fail identically again.
class LlmNotConfiguredError extends Error {
  constructor() {
    super('No LLM provider is configured yet. Add an API key in Settings to use this feature.')
    this.name = 'LlmNotConfiguredError'
  }
}

// Shared error response for every LLM-backed route: distinguishes "no
// provider configured" (503, points the user at Settings) from a failed
// call to a configured provider (502, a Retry may genuinely help) from any
// other unexpected failure (500).
function sendLlmError(res: express.Response, err: unknown): void {
  if (err instanceof LlmNotConfiguredError) {
    res.status(503).json({ error: err.message, code: 'llm-not-configured' })
    return
  }
  if (GlmApiError && err instanceof GlmApiError) {
    res.status(502).json({ error: err.message })
    return
  }
  res.status(500).json({ error: (err as Error).message })
}

// Which plugin actually backs a persona's LLM calls right now: the user's
// choice in Settings > Personas if they've made one, else the persona's
// built-in default from settingsRegistry.ts.
async function resolvePersonaPluginId(scope: PersonaScope, personaId: string): Promise<string | null> {
  const persona = personas.find((p) => p.id === personaId)
  if (!persona) return null
  const selected = await personaSettingsStore.getSelectedPluginId(scope, personaId)
  return selected ?? persona.defaultPluginId
}

// The second, optional "agent" level's plugin: only meaningful for a
// persona with supportsAgentLevel (currently just 'dev'), and there's no
// built-in default to fall back to — the agent level starts unselected
// until the user explicitly picks one in Settings > Personas.
async function resolvePersonaAgentPluginId(scope: PersonaScope, personaId: string): Promise<string | null> {
  const persona = personas.find((p) => p.id === personaId)
  if (!persona || !persona.supportsAgentLevel) return null
  const selected = await personaSettingsStore.getSelectedAgentPluginId(scope, personaId)
  return selected ?? null
}

// Builds a working LlmClient for whichever plugin a persona currently
// resolves to, using that plugin's own createClient (so this function
// never needs provider-specific construction logic — adding a new plugin
// to settingsRegistry.ts is all that's needed for it to work here too).
// Reads secrets fresh on every call (cheap — local file read, no network)
// so a key entered via Settings takes effect on the next chat without
// restarting the server.
async function getClientForPersona(scope: PersonaScope, personaId: string): Promise<LlmClient> {
  const pluginId = await resolvePersonaPluginId(scope, personaId)
  if (!pluginId) throw new LlmNotConfiguredError()
  const plugin = findInstalledPlugin(pluginId)
  if (!plugin) throw new LlmNotConfiguredError()

  const values = await secretsStore.getPluginValues(pluginId)
  try {
    return plugin.createClient(values)
  } catch {
    throw new LlmNotConfiguredError()
  }
}

// Mirrors getClientForPersona for the optional agent level — returns
// undefined (not a thrown error) when the persona doesn't support an
// agent level or the user hasn't selected one, since the agent level is
// always optional, unlike the master level which is required for the
// persona to function at all.
async function getAgentClientForPersona(scope: PersonaScope, personaId: string): Promise<LlmClient | undefined> {
  const pluginId = await resolvePersonaAgentPluginId(scope, personaId)
  if (!pluginId) return undefined
  const plugin = findInstalledPlugin(pluginId)
  if (!plugin) return undefined

  const values = await secretsStore.getPluginValues(pluginId)
  try {
    return plugin.createClient(values)
  } catch {
    return undefined
  }
}

// Resolves the per-call LLM options for a persona: persona-level override
// (set via Settings > Personas) wins per-field, falling back to the
// backing plugin's own global default (e.g. GLM's Settings-configured
// model/thinking) for any field the persona hasn't overridden. Only
// fields the plugin declares as personaOverridableFields are honoured —
// this can never surface a secret (e.g. apiKey is never in that list).
//
// If neither the persona nor the plugin's stored settings have a value for
// a 'select' field (e.g. the user never opened Settings and picked a
// model), this falls back to that field's first declared option rather
// than leaving it undefined — the LLM client applies its own hardcoded
// default in that case (e.g. ZaiGlmClient.DEFAULT_MODEL), and that default
// is always the plugin's first KNOWN_GLM_MODELS entry, so this keeps
// resolvePersonaLlmOptions's answer truthful about what will actually run
// instead of silently under-reporting it (this surfaces directly in the
// code gap scan's context-window estimate — see /scan-code-gaps/estimate).
async function resolvePersonaLlmOptions(scope: PersonaScope, personaId: string): Promise<LlmCallOptions> {
  const pluginId = await resolvePersonaPluginId(scope, personaId)
  if (!pluginId) return {}
  const manifest = findPluginManifest(pluginId)
  if (!manifest) return {}

  const pluginDefaults = await secretsStore.getPluginValues(pluginId)
  const personaOverrides = await personaSettingsStore.getPersonaValues(scope, personaId)

  const options: LlmCallOptions = {}
  for (const field of manifest.personaOverridableFields) {
    // A select field's override is only honoured if it's one of the
    // current plugin's own declared options — guards against a stale
    // value surviving under the same field key (e.g. "model") from
    // whatever plugin previously backed this persona.
    const isValidOverride =
      field.type !== 'select' || field.options?.some((o) => o.value === personaOverrides[field.key])
    const personaValue = isValidOverride ? personaOverrides[field.key] : undefined
    const fieldDefault = field.type === 'select' ? field.options?.[0]?.value : undefined
    const value = personaValue || pluginDefaults[field.key] || fieldDefault
    if (value) options[field.key] = value
  }
  return options
}

// Which agent CLI actually writes files for a Coding-stage run (the real
// fix for the "GLM selected, Claude Code CLI crashes as `claude --model
// glm-5.2`, 404" bug): resolvePersonaLlmOptions above answers "what
// model/effort should the run use," but until now the CLI that consumed
// those values was always hardcoded to codingAgentClient (the `claude`
// CLI) regardless of which plugin the persona actually resolved to — a GLM
// model id was being handed to Anthropic's own API, which naturally
// rejected it. This picks the matching concrete agent client instead:
// GLM -> openCodeAgentClient (OpenCode CLI pointed at z.ai's
// OpenAI-compatible endpoint via apiKey/baseUrl, no Anthropic software
// involved at all), anything else (Claude Code, or no plugin selected
// yet) -> codingAgentClient, unchanged from today's behavior.
// thinking/reasoningEffort are resolved generically by
// resolvePersonaLlmOptions (any plugin's personaOverridableFields, keyed by
// field.key) with no idea which concrete model they'll end up applied to.
// GLM's own capabilities are genuinely per-model (see vic-llm-glm's
// GLM_MODEL_CAPABILITIES) — GLM-5.3 cannot disable thinking at all, and
// reasoning_effort's accepted values differ by model — so gating happens
// here, the one place that knows both "this is actually GLM" and the
// resolved model id, rather than inside OpenCodeAgentClient (deliberately
// provider-agnostic, see its own comment) or ClaudeCodeAgentClient (which
// never sees these fields — ignores them entirely, so no gating is needed
// there).
function resolveGlmThinkingAndEffort(
  model: string | undefined,
  thinking: string | undefined,
  reasoningEffort: string | undefined,
): { thinking?: string; reasoningEffort?: string } {
  const capabilities = glmModelCapabilities(model)
  return {
    thinking: thinking && (thinking === 'enabled' || capabilities.canDisableThinking) ? thinking : undefined,
    reasoningEffort:
      reasoningEffort && capabilities.reasoningEffortValues?.includes(reasoningEffort) ? reasoningEffort : undefined,
  }
}

async function getCodingAgentClientForPersona(
  scope: PersonaScope,
  personaId: string,
  model: string | undefined,
  thinking: string | undefined,
  reasoningEffort: string | undefined,
): Promise<{
  client: CodingAgentClient
  extraOptions: { apiKey?: string; baseUrl?: string; thinking?: string; reasoningEffort?: string }
}> {
  const pluginId = await resolvePersonaPluginId(scope, personaId)
  if (pluginId === 'vic-llm-glm') {
    if (!openCodeAgentClient || !resolveGlmBaseUrl) {
      throw new LlmNotConfiguredError()
    }
    const values = await secretsStore.getPluginValues('vic-llm-glm')
    return {
      client: openCodeAgentClient,
      extraOptions: {
        apiKey: values.apiKey,
        baseUrl: resolveGlmBaseUrl(values.accessMethod as GlmAccessMethod | undefined),
        ...resolveGlmThinkingAndEffort(model, thinking, reasoningEffort),
      },
    }
  }
  if (!codingAgentClient) {
    throw new LlmNotConfiguredError()
  }
  return { client: codingAgentClient, extraOptions: {} }
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VIC-User')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

// Which persona list (admin's own, or the shared user list) a request's
// LLM-backed routes should resolve against — derived from the X-VIC-User
// header (the calling user's id, see usersStore.ts) on every request.
// Same "identity/attribution only, not a security boundary" trust model as
// the rest of login: an unrecognised/missing id, or one sent by a client
// that could just as easily lie about it, falls back to 'user' rather than
// granting admin scope by default.
async function resolvePersonaScope(req: express.Request): Promise<'admin' | 'user'> {
  const userId = req.header('X-VIC-User')
  if (!userId) return 'user'
  const users = await usersStore.listUsers()
  const user = users.find((u) => u.id === userId)
  return user?.isAdmin ? 'admin' : 'user'
}

// Same X-VIC-User header as resolvePersonaScope, resolved to a display name
// instead of admin/user scope — used purely for attributing a project's
// Coding-run lock to a human-readable "who" (see runLogRegistry.ts's
// acquireProjectRunLock), not as an authorization check.
async function resolveUserDisplayName(req: express.Request): Promise<string | undefined> {
  const userId = req.header('X-VIC-User')
  if (!userId) return undefined
  const users = await usersStore.listUsers()
  return users.find((u) => u.id === userId)?.name
}

async function loadProjectOr404(id: string): Promise<Project | null> {
  try {
    return await store.loadProject(id)
  } catch {
    return null
  }
}

// Where this server instance is actually storing data right now, what's
// driving that (env var / a persisted Settings-screen override / the
// shared-drive default), and — separately — what override is currently
// persisted (which may differ from what's active, if VIC_PROJECTS_ROOT is
// currently shadowing it; see the precedence comment above PROJECTS_ROOT).
// secretsDir has no equivalent override: it's where this override itself
// (and secrets.json/persona-settings.json) live, so it can only be changed
// via VIC_SECRETS_DIR — a store can't relocate the file it reads its own
// relocation instructions from.
app.get('/api/system/storage', async (_req, res) => {
  res.json({
    projectsRoot: PROJECTS_ROOT,
    projectsRootIsDefault: PROJECTS_ROOT_SOURCE === 'default',
    projectsRootSource: PROJECTS_ROOT_SOURCE,
    projectsRootOverride: (await serverSettingsStore.getProjectsRootOverride()) ?? null,
    secretsDir: SECRETS_DIR,
    secretsDirIsDefault: !process.env.VIC_SECRETS_DIR,
  })
})

// Sets (or clears, if projectsRootOverride is '' / null) the persisted
// operator override for where new project reads/writes go. Only takes
// effect after the server is restarted (see the precedence comment above
// PROJECTS_ROOT) — this route never touches the live `store` instance, so
// there's no risk of a request racing a mid-flight projectsRoot swap.
// Validates the path is usable (exists-or-creatable, and writable) so a
// typo or an unmapped network drive fails loudly here instead of silently
// at the next restart.
app.put('/api/system/storage', async (req, res) => {
  const rawOverride = req.body?.projectsRootOverride
  if (rawOverride !== null && typeof rawOverride !== 'string') {
    res.status(400).json({ error: 'projectsRootOverride must be a string or null' })
    return
  }
  const trimmed = typeof rawOverride === 'string' ? rawOverride.trim() : ''
  if (!trimmed) {
    await serverSettingsStore.setProjectsRootOverride(undefined)
    res.status(204).end()
    return
  }
  const resolvedPath = path.resolve(trimmed)
  try {
    await mkdir(resolvedPath, { recursive: true })
    const probeFile = path.join(resolvedPath, `.vic-write-check-${Date.now()}`)
    await writeFile(probeFile, '')
    await rm(probeFile)
  } catch (err) {
    res.status(400).json({
      error: `${resolvedPath} is not writable: ${(err as Error).message}`,
    })
    return
  }
  await serverSettingsStore.setProjectsRootOverride(resolvedPath)
  res.status(204).end()
})

// Name-only login list, shared across every machine pointed at this
// projects root (see usersStore.ts). No password, no session token.
app.get('/api/users', async (_req, res) => {
  res.json(await usersStore.listUsers())
})

app.post('/api/users', async (req, res) => {
  const name = req.body?.name
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const user = await usersStore.createUser(name)
  res.status(201).json(user)
})

app.get('/api/projects', async (_req, res) => {
  const projects = await store.listProjects()
  res.json(
    projects.map((p) => ({ id: p.id, name: p.name, lastOpenedAt: new Date().toISOString() })),
  )
})

app.post('/api/projects', async (req, res) => {
  const name = req.body?.name
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  const mode = req.body?.mode ?? 'new'
  if (mode !== 'new' && mode !== 'import') {
    res.status(400).json({ error: 'mode must be "new" or "import"' })
    return
  }
  const project = await store.createProject(name, mode)
  res.status(201).json(project)
})

app.put('/api/projects/:id', async (req, res) => {
  const name = req.body?.name
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  try {
    const project = await store.renameProject(req.params.id, name)
    res.json({ id: project.id, name: project.name, lastOpenedAt: new Date().toISOString() })
  } catch {
    res.status(404).json({ error: 'project not found' })
    return
  }
})

app.delete('/api/projects/:id', async (req, res) => {
  await store.deleteProject(req.params.id)
  res.status(204).end()
})

app.get('/api/token-usage', async (_req, res) => {
  res.json(sessionTokenUsage)
})

app.get('/api/projects/:id/requirements', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(activeRequirements(project))
})

// Registered before the /:reqId routes below so "collapsed-groups" in the
// path is never matched as a requirement id (Express matches routes in
// registration order — a later-registered PUT /requirements/:reqId would
// otherwise swallow PUT /requirements/collapsed-groups first).
app.get('/api/projects/:id/requirements/collapsed-groups', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.collapsedRequirementGroups ?? [])
})

// Which architecture-element groups are collapsed in the Requirements
// screen's list view (see setCollapsedRequirementGroups) — pure UI view
// state, but persisted per-project so it survives reopening the project.
app.put('/api/projects/:id/requirements/collapsed-groups', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const groupNames = req.body?.groupNames
  if (!Array.isArray(groupNames) || groupNames.some((name) => typeof name !== 'string')) {
    res.status(400).json({ error: 'groupNames must be an array of strings' })
    return
  }
  setCollapsedRequirementGroups(project, groupNames)
  await store.saveProject(project)
  res.status(204).end()
})

app.post('/api/projects/:id/requirements', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const text = req.body?.text
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  const seq = await globalSeqStore.getAndIncrementRequirementSeq()
  const requirement = createRequirementFromForm(project, { text }, seq)
  await store.saveProject(project)
  res.status(201).json(requirement)
})

app.post('/api/projects/:id/analyst-chat', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'analyst')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
    const result = await chatWithAnalyst(project, llmClient, message, llmOptions)
    recordTokenUsage(result.usage)
    res.json({ reply: result.reply, proposedRequirements: result.proposedRequirements })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/requirements/from-proposal', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const text = req.body?.text
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  const seq = await globalSeqStore.getAndIncrementRequirementSeq()
  const requirement = createRequirementFromForm(project, { text }, seq)
  await store.saveProject(project)
  res.status(201).json(requirement)
})

app.put('/api/projects/:id/requirements/:reqId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const text = req.body?.text
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  try {
    const requirement = updateRequirementText(project, req.params.reqId, text)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

// Split Requirement (Requirements screen, resolved) — three-step flow, one
// route per step, mirroring the propose -> review -> accept shape every
// other LLM proposal in this file already follows: propose (LLM call, no
// mutation), references (mechanical, no LLM call — checked separately so
// the UI can show it before/without re-running the LLM), apply (mutates).
app.post('/api/projects/:id/requirements/:reqId/split', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'analyst')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
    const result = await splitRequirement(project, llmClient, req.params.reqId, llmOptions)
    recordTokenUsage(result.usage)
    res.json({ pieces: result.pieces })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.get('/api/projects/:id/requirements/:reqId/references', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const structuralReferences = findRequirementReferences(project, req.params.reqId)
  const codeReferences = await scanCodeForRequirementReferences(store.projectDir(project.id), req.params.reqId)
  res.json({ structuralReferences, codeReferences })
})

app.post('/api/projects/:id/requirements/:reqId/split/apply', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const pieces = req.body?.pieces
  if (
    !Array.isArray(pieces) ||
    pieces.length < 2 ||
    pieces.some(
      (p) =>
        typeof p?.text !== 'string' ||
        !p.text.trim() ||
        (p.architectureElementId !== null && typeof p.architectureElementId !== 'string'),
    )
  ) {
    res.status(400).json({ error: 'pieces must be an array of at least 2 { text, architectureElementId } entries' })
    return
  }
  try {
    const seqStart = await globalSeqStore.reserveRequirementSeqBlock(pieces.length)
    const result = applySplitRequirement(project, req.params.reqId, pieces, seqStart)
    await store.saveProject(project)
    res.status(201).json(result)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.put('/api/projects/:id/requirements/:reqId/allocation-rationale', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const rationale = req.body?.rationale
  if (typeof rationale !== 'string') {
    res.status(400).json({ error: 'rationale is required' })
    return
  }
  try {
    const requirement = setAllocationRationale(project, req.params.reqId, rationale)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

// Pre-flight token estimate for a Review Clarity run — pure local
// computation (char-count heuristic, see tokenEstimate.ts), no LLM call and
// no cost, so the UI can show "~N tokens, approaching context limit" before
// the user commits to the real (billed) /analyse call below.
app.post('/api/projects/:id/analyse/estimate', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const requirementIds = req.body?.requirementIds
  if (!Array.isArray(requirementIds) || requirementIds.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'requirementIds must be an array of strings' })
    return
  }
  const personaScope = await resolvePersonaScope(req)
  const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
  const estimate = estimateAnalysisTokens(
    activeRequirements(project),
    requirementIds,
    ANALYSIS_SYSTEM_PROMPT,
    llmOptions.model,
  )
  res.json(estimate)
})

app.post('/api/projects/:id/analyse', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const requirementIds = req.body?.requirementIds
  if (!Array.isArray(requirementIds) || requirementIds.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'requirementIds must be an array of strings' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'analyst')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
    const { results, usage } = await analyseRequirements(project, llmClient, requirementIds, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json(results)
  } catch (err) {
    sendLlmError(res, err)
  }
})

// Last-run Check Conflicts / Check Gaps records (if any), so the
// Requirements screen can redisplay the results panel after navigating
// away and back or reopening the project, instead of that panel only
// existing as transient React state that's lost on navigation.
app.get('/api/projects/:id/last-checks', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json({
    lastConflictCheck: project.lastConflictCheck ?? null,
    lastGapCheck: project.lastGapCheck ?? null,
  })
})

app.post('/api/projects/:id/check-conflicts', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'analyst')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
    const { pairs, usage } = await checkConflicts(project, llmClient, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ pairs, requirements: activeRequirements(project) })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/check-gaps', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'analyst')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'analyst')
    const { suggestions, usage } = await checkGaps(project, llmClient, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ suggestions })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/requirements/import', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const text = req.body?.text
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text is required' })
    return
  }
  let created
  try {
    const seqStart = await globalSeqStore.reserveRequirementSeqBlock(countImportBlocks(text))
    created = importRequirementsFromText(project, text, seqStart)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
    return
  }
  await store.saveProject(project)
  res.status(201).json(created)
})

app.delete('/api/projects/:id/requirements/:reqId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    deleteRequirement(project, req.params.reqId)
    await store.saveProject(project)
    res.status(204).end()
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

app.get('/api/projects/:id/requirements/deleted', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(deletedRequirements(project))
})

app.post('/api/projects/:id/requirements/:reqId/restore', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const requirement = restoreRequirement(project, req.params.reqId)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `deleted requirement ${req.params.reqId} not found` })
  }
})

app.delete('/api/projects/:id/requirements/:reqId/purge', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    purgeRequirement(project, req.params.reqId)
    await store.saveProject(project)
    res.status(204).end()
  } catch {
    res.status(404).json({ error: `deleted requirement ${req.params.reqId} not found` })
  }
})

app.put('/api/projects/:id/requirements/:reqId/architecture-element', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const architectureElement = req.body?.architectureElement
  if (architectureElement !== null && typeof architectureElement !== 'string') {
    res.status(400).json({ error: 'architectureElement must be a string or null' })
    return
  }
  try {
    const requirement = reassignArchitectureElement(project, req.params.reqId, architectureElement)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

// Multi-element allocation (chip add/remove) — additive/subtractive,
// alongside the single-select replace-style route above, which stays
// unchanged for any caller still using it.
app.post('/api/projects/:id/requirements/:reqId/architecture-elements', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const elementId = req.body?.elementId
  if (typeof elementId !== 'string' || !elementId) {
    res.status(400).json({ error: 'elementId is required' })
    return
  }
  try {
    const requirement = addRequirementToElement(project, req.params.reqId, elementId)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

app.delete('/api/projects/:id/requirements/:reqId/architecture-elements/:elementId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const requirement = removeRequirementFromElement(project, req.params.reqId, req.params.elementId)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

const REQUIREMENT_STATUSES: RequirementStatus[] = ['elicited', 'architected', 'allocated', 'coded', 'tested', 'complete']

app.put('/api/projects/:id/requirements/:reqId/status', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const status = req.body?.status
  if (typeof status !== 'string' || !REQUIREMENT_STATUSES.includes(status as RequirementStatus)) {
    res.status(400).json({ error: `status must be one of ${REQUIREMENT_STATUSES.join(', ')}` })
    return
  }
  try {
    const requirement = setRequirementStatus(project, req.params.reqId, status as RequirementStatus)
    await store.saveProject(project)
    res.json(requirement)
  } catch {
    res.status(404).json({ error: `requirement ${req.params.reqId} not found` })
  }
})

const ARCHITECTURE_TYPE_IDS: ArchitectureTypeId[] = ARCHITECTURE_TYPES.map((t) => t.id)

app.get('/api/architecture-types', async (_req, res) => {
  res.json(ARCHITECTURE_TYPES)
})

app.get('/api/projects/:id/architecture-type', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.architectureType ?? null)
})

app.put('/api/projects/:id/architecture-type', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const typeId = req.body?.typeId
  if (typeof typeId !== 'string' || !ARCHITECTURE_TYPE_IDS.includes(typeId as ArchitectureTypeId)) {
    res.status(400).json({ error: 'typeId must be a known architecture type id' })
    return
  }
  setArchitectureType(project, typeId as ArchitectureTypeId)
  await store.saveProject(project)
  res.status(204).end()
})

const ARCHITECTURE_ELEMENT_KINDS: ArchitectureElementKind[] = [
  'functional',
  'interface-spine',
  'service',
  'external',
  'runtime',
]

app.get('/api/projects/:id/architecture', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.architecture ?? null)
})

app.post('/api/projects/:id/architecture/elements', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { kind, name, responsibility, row, col, rowSpan, colSpan, interfaces } = req.body ?? {}
  if (
    typeof kind !== 'string' ||
    !ARCHITECTURE_ELEMENT_KINDS.includes(kind as ArchitectureElementKind) ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof responsibility !== 'string' ||
    typeof row !== 'number' ||
    typeof col !== 'number'
  ) {
    res.status(400).json({ error: 'kind, name, responsibility, row, col are required' })
    return
  }
  try {
    const element = createArchitectureElement(project, {
      kind: kind as ArchitectureElementKind,
      name,
      responsibility,
      row,
      col,
      rowSpan,
      colSpan,
      interfaces,
    })
    await store.saveProject(project)
    res.status(201).json(element)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.put('/api/projects/:id/architecture/elements/:elementId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const element = updateArchitectureElement(project, req.params.elementId, req.body ?? {})
    await store.saveProject(project)
    res.json(element)
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

app.delete('/api/projects/:id/architecture/elements/:elementId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    deleteArchitectureElement(project, req.params.elementId)
    await store.saveProject(project)
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/architecture/layers', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const label = req.body?.label
  if (typeof label !== 'string' || !label.trim()) {
    res.status(400).json({ error: 'label is required' })
    return
  }
  try {
    addLayer(project, label)
    await store.saveProject(project)
    res.status(201).json(project.architecture)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.delete('/api/projects/:id/architecture/layers/:rowIndex', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const rowIndex = Number(req.params.rowIndex)
  if (!Number.isInteger(rowIndex)) {
    res.status(400).json({ error: 'rowIndex must be an integer' })
    return
  }
  try {
    removeLayer(project, rowIndex)
    await store.saveProject(project)
    res.json(project.architecture)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/architecture/check-conflicts', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const { conflicts, usage } = await checkArchitectureConflicts(project, llmClient, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ conflicts })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/auto-configure', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await autoConfigureAndAllocate(project, llmClient, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({
      architecture: project.architecture,
      createdElements: result.createdElements,
      allocatedRequirementIds: result.allocatedRequirementIds,
      unallocatedRequirementIds: result.unallocatedRequirementIds,
    })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/auto-allocate', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const mode = req.body?.mode
  if (mode !== 'llm') {
    res.status(400).json({ error: 'mode must be "llm"' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await autoAllocateLlm(project, llmClient, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({
      architecture: project.architecture,
      allocatedRequirementIds: result.allocatedRequirementIds,
      unallocatedRequirementIds: result.unallocatedRequirementIds,
    })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/chat', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await chatWithArchitect(project, llmClient, message, llmOptions)
    recordTokenUsage(result.usage)
    res.json({
      reply: result.reply,
      proposedElements: result.proposedElements,
      proposedInterfaces: result.proposedInterfaces,
    })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/elements/from-proposal', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { kind, name, layer, responsibility } = req.body ?? {}
  if (
    typeof kind !== 'string' ||
    !ARCHITECTURE_ELEMENT_KINDS.includes(kind as ArchitectureElementKind) ||
    typeof name !== 'string' ||
    !name.trim() ||
    typeof responsibility !== 'string' ||
    typeof layer !== 'string'
  ) {
    res.status(400).json({ error: 'kind, name, responsibility, layer are required' })
    return
  }
  try {
    const architecture = project.architecture
    const isExternal = kind === 'external'
    const row = isExternal ? EXTERNAL_CONTEXT_ROW : (architecture?.layers.indexOf(layer) ?? -1)
    if (!isExternal && row === -1) {
      res.status(400).json({ error: `layer "${layer}" does not exist` })
      return
    }
    const element = createArchitectureElement(project, {
      kind: kind as ArchitectureElementKind,
      name,
      responsibility,
      row,
      col: nextFreeColumn(architecture?.elements ?? [], row),
    })
    await store.saveProject(project)
    res.status(201).json(element)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/architecture/interfaces/from-proposal', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { fromId, toId } = req.body ?? {}
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    res.status(400).json({ error: 'fromId and toId are required' })
    return
  }
  try {
    const element = acceptProposedInterface(project, fromId, toId)
    await store.saveProject(project)
    res.json(element)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.delete('/api/projects/:id/architecture/interfaces', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { fromId, toId } = req.body ?? {}
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    res.status(400).json({ error: 'fromId and toId are required' })
    return
  }
  try {
    const element = removeArchitectureInterface(project, fromId, toId)
    await store.saveProject(project)
    res.json(element)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/architecture/interfaces/check-conflict', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { fromId, toId } = req.body ?? {}
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    res.status(400).json({ error: 'fromId and toId are required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await checkInterfaceConflict(project, llmClient, fromId, toId, llmOptions)
    recordTokenUsage(result.usage)
    res.json({ conflict: result.conflict })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/interfaces/define', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { fromId, toId } = req.body ?? {}
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    res.status(400).json({ error: 'fromId and toId are required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await defineInterfaceDefinition(project, llmClient, fromId, toId, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({ definition: result.definition })
  } catch (err) {
    sendLlmError(res, err)
  }
})

function cleanOperations(operations: unknown[]): InterfaceContractOperation[] {
  return operations.map((op: any) => ({
    name: String(op?.name ?? ''),
    description: String(op?.description ?? ''),
    request: String(op?.request ?? ''),
    response: String(op?.response ?? ''),
    errors: String(op?.errors ?? ''),
    range: op?.range ? String(op.range) : undefined,
    resolution: op?.resolution ? String(op.resolution) : undefined,
    unit: op?.unit ? String(op.unit) : undefined,
    updateFrequency: op?.drivenDirectly ? undefined : op?.updateFrequency ? String(op.updateFrequency) : undefined,
    drivenDirectly: op?.drivenDirectly === true ? true : undefined,
  }))
}

// Manual counterpart to /interfaces/define — sets a definition's
// participants/operations directly from the request body, no LLM call.
// Backs the "list and edit all interfaces" manual CRUD requirement (both
// the global Interfaces list and the per-element focus view use this same
// endpoint). Creates a new definition when definitionId is omitted.
app.put('/api/projects/:id/architecture/interfaces', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { definitionId, name, participants, operations } = req.body ?? {}
  if (
    typeof name !== 'string' ||
    !Array.isArray(participants) ||
    participants.length < 2 ||
    !Array.isArray(operations)
  ) {
    res.status(400).json({ error: 'name, a participants array (>= 2), and an operations array are required' })
    return
  }
  const cleanedParticipants = participants.map((p: any) => ({
    elementId: String(p?.elementId ?? ''),
    role: p?.role === 'produces' || p?.role === 'consumes' || p?.role === 'both' ? p.role : 'both',
  }))
  try {
    const definition = setInterfaceDefinition(
      project,
      typeof definitionId === 'string' ? definitionId : undefined,
      name,
      cleanedParticipants,
      cleanOperations(operations),
    )
    await store.saveProject(project)
    res.json({ definition })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Reconciles one element's own local interface copy against its current
// master definition (Area B/D, resolved) — the human review step required
// before Coding unblocks for that element after a master interface change.
app.put('/api/projects/:id/architecture/interfaces/:definitionId/reconcile', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { elementId, operations } = req.body ?? {}
  if (typeof elementId !== 'string' || !Array.isArray(operations)) {
    res.status(400).json({ error: 'elementId and an operations array are required' })
    return
  }
  try {
    const entry = reconcileElementInterface(project, elementId, req.params.definitionId, cleanOperations(operations))
    await store.saveProject(project)
    res.json({ elementInterface: entry })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/architecture/interfaces/define-all', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const force = req.body?.force === true
    const result = await defineAllInterfaceDefinitions(project, llmClient, llmOptions, force)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({ definitions: result.definitions })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/architecture/interfaces/check', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const result = checkInterfaces(project)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Check Interface/Code Alignment — the code-vs-Architecture half of
// interface governance (Check Interfaces above only checks the
// Architecture side: does every connection have a contract at all). Local,
// mechanical, no LLM: scans the generated source tree for each pair's
// contract operations. Advisory only, same as Check Interfaces — never
// blocks, never deletes anything it finds.
app.post('/api/projects/:id/architecture/interfaces/check-code-alignment', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  if (!project.architecture) {
    res.status(400).json({ error: 'Project has no architecture — select an Architecture type first' })
    return
  }
  const result = await checkInterfaceCodeAlignment(store.projectDir(project.id), project.architecture)
  res.json(result)
})

// Coding & Review-Rework (Area D) — subfolder scaffolding and the
// coding-conventions free-text field the prompt builder reads. "Run
// Coding" does NOT go through getClientForPersona's plugin-manifest
// indirection (the agent client isn't a registered LLM plugin, see
// modules/coding's design notes) — "not installed" surfaces as a
// cli-error-status CodingRun in a 200 response, not an HTTP error,
// mirroring the "greyed out/disabled rather than hidden" degradation the
// Coding screen already anticipates.
app.post('/api/projects/:id/coding/scaffold', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const result = await scaffoldProjectSourceTree(project, store.projectDir(project.id))
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.get('/api/projects/:id/coding/runs', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.codingRuns ?? [])
})

app.get('/api/projects/:id/coding/runs/:runId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const run = (project.codingRuns ?? []).find((r) => r.id === req.params.runId)
  if (!run) {
    res.status(404).json({ error: 'coding run not found' })
    return
  }
  res.json(run)
})

// Element-scoped Coding — the only Coding path (Story-based Coding has
// been removed): no shared-scope guard (impossible — a Coding run always
// targets exactly one element's own folder), eligibility/prompt/status
// advancement all driven by requirement.architectureElements live queries.
app.post('/api/projects/:id/architecture/elements/:elementId/run-coding', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const element = project.architecture?.elements.find((e) => e.id === req.params.elementId)
  if (!element) {
    res.status(404).json({ error: 'architecture element not found' })
    return
  }
  const runToken = typeof req.body?.runToken === 'string' ? req.body.runToken : randomUUID()
  // Manual recode of an already-coded element — regresses every requirement
  // currently allocated to this element (live query, not a cached list)
  // back to 'allocated' so isElementEligibleForCoding treats it as pending.
  if (req.body?.recode === true) {
    for (const requirement of project.requirements) {
      if (!requirement.deletedAt && requirement.architectureElements.includes(element.id)) {
        regressStatusForRecode(requirement)
      }
    }
  }
  // "Recode from scratch" (fromScratch:true, forwarded to
  // runCodingForElement below) wipes the element's own scoped subfolder
  // before the agent runs. This used to happen here as a separate,
  // network-facing wipe+scaffold pair directly against the project's (often
  // SMB-mapped) directory — now performed inside runCodingForElement's own
  // local working copy instead (see localSourceTree.ts), so this route no
  // longer does any of that work itself; passing fromScratch through is
  // enough.
  const abortController = new AbortController()
  try {
    acquireProjectRunLock(project.id, runToken, {
      architectureElementId: element.id,
      userId: await resolveUserDisplayName(req),
      cancel: () => abortController.abort(),
    })
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      res.status(409).json({
        error: `Coding is already running for this project${err.lock.userId ? ` (started by ${err.lock.userId})` : ''} — try again once it finishes.`,
        code: 'project-run-locked',
      })
      return
    }
    throw err
  }
  const appendLog = startRunLog(runToken)
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'dev')
    const { client: codingClient, extraOptions } = await getCodingAgentClientForPersona(
      personaScope,
      'dev',
      llmOptions.model,
      llmOptions.thinking,
      llmOptions.reasoningEffort,
    )
    const codingRun = await runCodingForElement(project, store.projectDir(project.id), element.id, codingClient, {
      model: llmOptions.model,
      effort: llmOptions.effort,
      ...extraOptions,
      fromScratch: req.body?.fromScratch === true,
      onChunk: appendLog,
      signal: abortController.signal,
    })
    project.codingRuns = [...(project.codingRuns ?? []), codingRun]
    if (codingRun.status === 'success') {
      // A successful Coding run advances every requirement allocated to
      // THIS element toward 'coded' — but per the confirmed multi-element
      // status decision, a requirement allocated to more than one element
      // only truly reaches 'coded' once EVERY element it's allocated to has
      // its own successful run since the requirement last changed. Computed
      // live from project.codingRuns history — no new persisted field.
      const allRuns = project.codingRuns
      for (const requirement of project.requirements) {
        if (requirement.deletedAt || !requirement.architectureElements.includes(element.id)) continue
        const changedAt = new Date(requirement.createdAt).getTime()
        const allElementsHaveSuccessSinceChange = requirement.architectureElements.every((elId) =>
          allRuns.some(
            (run) =>
              run.architectureElementId === elId &&
              run.status === 'success' &&
              new Date(run.finishedAt).getTime() >= changedAt,
          ),
        )
        if (allElementsHaveSuccessSinceChange) {
          advanceStatusForward(requirement, 'coded')
        }
      }
    }
    if (codingRun.status === 'success') {
      await runFullRegression(project, store.projectDir(project.id), 'coding-success')
    }
    await store.saveProject(project)
    res.json({ codingRun })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  } finally {
    finishRunLog(runToken)
    releaseProjectRunLock(project.id, runToken)
  }
})

// "Analyse Code" for an architecture element. Read-only: checks the code
// currently in the element's own scoped subfolder against the requirements
// currently allocated to it (live query), records the verdict on
// project.elementCodeChecks.
app.post('/api/projects/:id/architecture/elements/:elementId/analyze-code', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const element = project.architecture?.elements.find((e) => e.id === req.params.elementId)
  if (!element) {
    res.status(404).json({ error: 'architecture element not found' })
    return
  }
  try {
    const allowedRelativePrefix = elementSubfolderName(element)
    const root = sourceTreeRoot(store.projectDir(project.id))
    const prefix = allowedRelativePrefix.split(path.sep).join('/')
    const allFiles = await listSourceTreeFiles(root)
    const scopedFiles = allFiles.filter((f) => f.path === prefix || f.path.startsWith(`${prefix}/`))
    const codeFiles = await Promise.all(
      scopedFiles
        .filter((f) => f.path.split('/').pop() !== MARKER_FILENAME)
        .map(async (f) => ({ path: f.path, content: await readFile(path.join(root, f.path), 'utf-8') })),
    )
    const requirements = project.requirements.filter(
      (r) => !r.deletedAt && r.architectureElements.includes(element.id),
    )

    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'dev')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'dev')
    const result = await runElementCodeCheck(project, element.id, requirements, codeFiles, llmClient, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({ coverage: result.coverage })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.get('/api/coding/runs/:token/log', (req, res) => {
  const entry = readRunLog(req.params.token)
  if (!entry) {
    res.status(404).json({ error: 'unknown or expired run token' })
    return
  }
  res.json(entry)
})

// Lets the Coding screen show "X is already running Coding here" proactively
// (e.g. on load/poll) rather than only after a user clicks Code and gets a
// 409 — see acquireProjectRunLock in runLogRegistry.ts for the lock itself.
app.get('/api/projects/:id/coding/run-lock', (req, res) => {
  const lock = readProjectRunLock(req.params.id)
  res.json({
    locked: !!lock,
    architectureElementId: lock?.architectureElementId,
    userId: lock?.userId,
    startedAt: lock?.startedAt,
  })
})

// User-triggered escape hatch for a stuck Coding run (Cancel button on the
// Coding screen's lock banner) — aborts the CLI subprocess currently
// holding this project's run-lock rather than making the user wait out
// CODING_RUN_TIMEOUT_MS. The lock itself is released by the aborted run's
// own route handler once its `finally` runs (same path the timeout takes),
// not by this route directly — so a 204 here means "cancellation
// requested," not "already unlocked."
app.delete('/api/projects/:id/coding/run-lock', (req, res) => {
  const cancelled = cancelProjectRun(req.params.id)
  if (!cancelled) {
    res.status(404).json({ error: 'No Coding run is currently in progress for this project' })
    return
  }
  res.status(204).end()
})

app.get('/api/projects/:id/coding-conventions', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json({ conventions: project.codingConventions ?? '' })
})

app.put('/api/projects/:id/coding-conventions', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const conventions = req.body?.conventions
  if (typeof conventions !== 'string') {
    res.status(400).json({ error: 'conventions must be a string' })
    return
  }
  project.codingConventions = conventions
  await store.saveProject(project)
  res.status(204).end()
})

// Project Overview panel (Architecture tab) — what the app is, what tech
// it's built with, and how to build/run it. Same GET/PUT shape as
// coding-conventions above; read by buildCodingPrompt (vic-coding) as extra
// context and shown alongside Test Full App.
app.get('/api/projects/:id/overview', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json({ description: project.description ?? '', runInstructions: project.runInstructions ?? '' })
})

app.put('/api/projects/:id/overview', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { description, runInstructions } = req.body ?? {}
  if (typeof description !== 'string' || typeof runInstructions !== 'string') {
    res.status(400).json({ error: 'description and runInstructions must both be strings' })
    return
  }
  project.description = description
  project.runInstructions = runInstructions
  await store.saveProject(project)
  res.status(204).end()
})

// Auto-populates the Project Overview panel from the project's requirements
// and (if present) architecture elements — one LLM call, doesn't persist;
// the UI saves the result via PUT /overview like a normal edit once the
// user is happy with it.
app.post('/api/projects/:id/overview/auto-populate', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await generateProjectOverview(project, llmClient, llmOptions)
    recordTokenUsage(result.usage)
    res.json({ description: result.description, runInstructions: result.runInstructions })
  } catch (err) {
    sendLlmError(res, err)
  }
})

// Reads every recognised source file (CODE_FILE_EXTENSIONS — text only,
// same allowlist Import Project uses, so a binary asset in the tree is
// never read and fed to the LLM as if it were text) under a directory, for
// the QA dispatch chat's code context (test-runs/chat route, Area F "User-
// reported issue triage") — the element's own code helps the triage call
// distinguish a code failure from a requirement issue. Missing directory
// (never scaffolded/coded yet) yields an empty list rather than an error —
// same tolerance as listSourceTreeFiles.
async function readCodeContextFiles(rootPath: string, subdir?: string): Promise<Array<{ path: string; content: string }>> {
  const startDir = subdir ? path.join(rootPath, subdir) : rootPath
  const files: Array<{ path: string; content: string }> = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!CODE_FILE_EXTENSIONS.has(ext)) continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/')
      files.push({ path: relativePath, content: await readFile(fullPath, 'utf-8') })
    }
  }

  await walk(startDir)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// Test Creation (Area E) — test suite CRUD, LLM-assisted proposal
// generation gated by the mechanical requirement-traceability check
// (createTestCase itself, not a separate route — a manually-entered test
// with no requirementIds/contract ref is rejected exactly like an
// LLM-proposed one), and agentic test-file generation reusing vic-coding's
// write-scope gate. Mirrors the Planning/Coding route blocks: loadProjectOr404
// -> validate -> call -> save -> respond; LLM-backed routes use the 'qa'
// persona + sendLlmError.
app.get('/api/projects/:id/test-suite', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.testSuite ?? null)
})

app.get('/api/projects/:id/test-suite/readiness', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(scopeReadinessEntries(project))
})

app.post('/api/projects/:id/test-suite/tests', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { type, title, requirementIds, interfaceDefinitionId, architectureElementId, interfaceElementIds } = req.body ?? {}
  if (type !== 'functional' && type !== 'integration') {
    res.status(400).json({ error: 'type must be "functional" or "integration"' })
    return
  }
  if (typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  const result = createTestCase(project, {
    type,
    title,
    requirementIds,
    interfaceDefinitionId,
    architectureElementId,
    interfaceElementIds,
  })
  await store.saveProject(project)
  res.status(result.testCase ? 201 : 200).json(result)
})

app.put('/api/projects/:id/test-suite/tests/:testId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const testCase = updateTestCase(project, req.params.testId, req.body ?? {})
    await store.saveProject(project)
    res.json(testCase)
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

app.delete('/api/projects/:id/test-suite/tests/:testId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    deleteTestCase(project, req.params.testId)
    await store.saveProject(project)
    res.status(204).end()
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/test-suite/generate-functional', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const architectureElementId = req.body?.architectureElementId
  if (typeof architectureElementId !== 'string' || !architectureElementId.trim()) {
    res.status(400).json({ error: 'architectureElementId is required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const { tests, rejected, usage } = await generateFunctionalTestsForElement(project, llmClient, architectureElementId, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ tests, rejected })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/test-suite/generate-integration', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { fromId, toId } = req.body ?? {}
  if (typeof fromId !== 'string' || typeof toId !== 'string') {
    res.status(400).json({ error: 'fromId and toId are required' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const { tests, rejected, usage } = await generateIntegrationTestsForContract(project, llmClient, fromId, toId, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ tests, rejected })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/test-suite/generate-all', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const { tests, rejected, usage } = await generateAllTestsForUnplannedElements(project, llmClient, llmOptions)
    recordTokenUsage(usage)
    await store.saveProject(project)
    res.json({ tests, rejected })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/test-suite/chat', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  const architectureElementId = typeof req.body?.architectureElementId === 'string' ? req.body.architectureElementId : null
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const result = await chatWithQATestCreation(project, llmClient, architectureElementId, message, llmOptions)
    recordTokenUsage(result.usage)
    res.json({ reply: result.reply, proposedTests: result.proposedTests })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/test-suite/tests/from-proposal', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { title, requirementIds, architectureElementId } = req.body ?? {}
  if (typeof title !== 'string' || !title.trim() || !Array.isArray(requirementIds)) {
    res.status(400).json({ error: 'title and requirementIds are required' })
    return
  }
  const { testCase, rejected } = createTestCase(project, {
    type: 'functional',
    title,
    requirementIds,
    architectureElementId: typeof architectureElementId === 'string' ? architectureElementId : null,
  })
  if (!testCase) {
    res.status(400).json({ error: 'rejected', rejected })
    return
  }
  await store.saveProject(project)
  res.status(201).json(testCase)
})

// The agentic write step — NOT wrapped in sendLlmError (mirrors run-coding:
// the agent client isn't a registered LLM plugin, "not installed" surfaces
// as a normal 200 with a failure-status result).
app.post('/api/projects/:id/test-suite/tests/:testId/generate-file', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const testCase = project.testSuite?.tests.find((t) => t.id === req.params.testId)
  if (!testCase) {
    res.status(404).json({ error: 'test case not found' })
    return
  }
  const runToken = typeof req.body?.runToken === 'string' ? req.body.runToken : randomUUID()
  const abortController = new AbortController()
  try {
    acquireProjectRunLock(project.id, runToken, {
      userId: await resolveUserDisplayName(req),
      cancel: () => abortController.abort(),
    })
  } catch (err) {
    if (err instanceof ProjectRunLockedError) {
      res.status(409).json({
        error: `Coding is already running for this project${err.lock.userId ? ` (started by ${err.lock.userId})` : ''} — try again once it finishes.`,
        code: 'project-run-locked',
      })
      return
    }
    throw err
  }
  const appendLog = startRunLog(runToken)
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    // Same CLI-follows-persona-plugin resolution as /run-coding — GLM
    // selected for QA gets OpenCode, not a broken `claude --model glm-...`.
    const { client: codingClient, extraOptions } = await getCodingAgentClientForPersona(
      personaScope,
      'qa',
      llmOptions.model,
      llmOptions.thinking,
      llmOptions.reasoningEffort,
    )
    const result = await generateTestFileForTestCase(project, store.projectDir(project.id), testCase, codingClient, {
      model: llmOptions.model,
      effort: llmOptions.effort,
      ...extraOptions,
      onChunk: appendLog,
      signal: abortController.signal,
    })
    if (result.status === 'success' && result.testCase.filePath) {
      testCase.filePath = result.testCase.filePath
    }
    await store.saveProject(project)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  } finally {
    finishRunLog(runToken)
    releaseProjectRunLock(project.id, runToken)
  }
})

// Import legacy test cases (Area E) — scans a server-side folder of
// existing test files, writes each verbatim under this project's own
// generated source tree (src/_imported-tests/...), and analyzes each one
// with the QA persona to produce a title/description. Deliberately does NOT
// go through createTestCase — see ImportedTestCase in vic-requirements-
// elicitation's types.ts for why these are a separate, untraced list rather
// than TestSuite entries.
const IMPORTED_TESTS_DIRNAME = '_imported-tests'
const TEST_FILE_NAME_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i

async function readLegacyTestFolder(rootPath: string): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile() || !TEST_FILE_NAME_PATTERN.test(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/')
      files.push({ relativePath, content: await readFile(fullPath, 'utf-8') })
    }
  }

  await walk(rootPath)
  return files
}

app.get('/api/projects/:id/imported-test-cases', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.importedTestCases ?? null)
})

app.post('/api/projects/:id/imported-test-cases/import', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const folderPath = req.body?.folderPath
  if (typeof folderPath !== 'string' || !folderPath.trim()) {
    res.status(400).json({ error: 'folderPath is required' })
    return
  }
  const resolvedPath = path.resolve(folderPath.trim())
  if (!(await isDirectory(resolvedPath))) {
    res.status(400).json({ error: `"${resolvedPath}" is not a readable directory` })
    return
  }

  try {
    const legacyFiles = await readLegacyTestFolder(resolvedPath)
    if (legacyFiles.length === 0) {
      res.json({ imported: [] })
      return
    }

    const destinationRoot = path.join(sourceTreeRoot(store.projectDir(project.id)), IMPORTED_TESTS_DIRNAME)
    const filesWithDestination = []
    for (const file of legacyFiles) {
      const destinationPath = path.join(IMPORTED_TESTS_DIRNAME, file.relativePath)
      const fullDestinationPath = path.join(destinationRoot, file.relativePath)
      await mkdir(path.dirname(fullDestinationPath), { recursive: true })
      await writeFile(fullDestinationPath, file.content, 'utf-8')
      filesWithDestination.push({ ...file, destinationPath: destinationPath.split(path.sep).join('/') })
    }

    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const result = await importLegacyTestCases(project, llmClient, filesWithDestination, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({ imported: result.imported })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.delete('/api/projects/:id/imported-test-cases/:testId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    deleteImportedTestCase(project, req.params.testId)
  } catch (err) {
    res.status(404).json({ error: (err as Error).message })
    return
  }
  await store.saveProject(project)
  res.status(204).end()
})

// Test Execution (Area F) — element-scoped runs, full regression, mandatory
// triage before any status change, mechanical pass-threshold status flip
// (evaluateRequirementStatus/evaluateRequirementStatusForRegression, called
// explicitly after a run and again after triage/confirmation — never
// implicit).
app.get('/api/projects/:id/test-runs', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.testRuns ?? [])
})

app.get('/api/projects/:id/test-runs/:runId', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const run = (project.testRuns ?? []).find((r) => r.id === req.params.runId)
  if (!run) {
    res.status(404).json({ error: 'test run not found' })
    return
  }
  res.json(run)
})

app.get('/api/projects/:id/test-regression-runs', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(project.testRegressionRuns ?? [])
})

app.post('/api/projects/:id/test-suite/run-element', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { architectureElementId, interfaceElementIds } = req.body ?? {}
  try {
    const testRun = await runElementTestSuite(project, store.projectDir(project.id), {
      architectureElementId,
      interfaceElementIds,
    })
    await store.saveProject(project)
    res.json({ testRun })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/test-suite/run-regression', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const regressionRun = await runFullRegression(project, store.projectDir(project.id), 'manual')
    await store.saveProject(project)
    res.json({ regressionRun })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/test-runs/:runId/outcomes/:testCaseId/triage', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const run = (project.testRuns ?? []).find((r) => r.id === req.params.runId)
  if (!run) {
    res.status(404).json({ error: 'test run not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const { triage, triageRationale, usage } = await triageTestFailure(project, llmClient, run, req.params.testCaseId, llmOptions)
    recordTokenUsage(usage)
    evaluateRequirementStatus(project, run, run.kind === 'full-regression')
    await store.saveProject(project)
    res.json({ triage, triageRationale })
  } catch (err) {
    sendLlmError(res, err)
  }
})

app.post('/api/projects/:id/test-runs/:runId/outcomes/:testCaseId/confirm-test-case-failure', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const run = (project.testRuns ?? []).find((r) => r.id === req.params.runId)
  if (!run) {
    res.status(404).json({ error: 'test run not found' })
    return
  }
  try {
    confirmTestCaseFailure(run, req.params.testCaseId)
    evaluateRequirementStatus(project, run, run.kind === 'full-regression')
    await store.saveProject(project)
    res.status(204).end()
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

app.post('/api/projects/:id/test-runs/chat', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const message = req.body?.message
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }
  const testCaseId = typeof req.body?.testCaseId === 'string' ? req.body.testCaseId : null
  const runId = typeof req.body?.runId === 'string' ? req.body.runId : null
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'qa')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'qa')
    const result = await chatWithQATestExecution(project, llmClient, testCaseId, runId, message, llmOptions)
    recordTokenUsage(result.usage)

    // Dispatch classification (Area F "User-reported issue triage",
    // resolved) — runs alongside the conversational reply above, only
    // when a test is actually in focus (nothing to attribute a verdict
    // against otherwise). A separate try/catch so a dispatch-call failure
    // (e.g. malformed LLM reply) still lets the conversational reply
    // through rather than failing the whole request.
    let dispatch: Awaited<ReturnType<typeof classifyAndDispatchUserReportedIssue>>['dispatch']
    if (testCaseId) {
      try {
        const test = project.testSuite?.tests.find((t) => t.id === testCaseId)
        let codeContext: string | undefined
        if (test?.architectureElementId) {
          const element = project.architecture?.elements.find((e) => e.id === test.architectureElementId)
          if (element) {
            const files = await readCodeContextFiles(sourceTreeRoot(store.projectDir(project.id)), elementSubfolderName(element))
            codeContext = formatCodeContextForTriage(files)
          }
        }
        const dispatchResult = await classifyAndDispatchUserReportedIssue(
          project,
          llmClient,
          testCaseId,
          runId,
          message,
          llmOptions,
          codeContext,
        )
        for (const usage of dispatchResult.usage) recordTokenUsage(usage)
        dispatch = dispatchResult.dispatch
        if (dispatch) await store.saveProject(project)
      } catch {
        // Swallow — the conversational reply above already succeeded and
        // is still worth returning even if classification failed.
      }
    }

    res.json({ reply: result.reply, dispatch })
  } catch (err) {
    sendLlmError(res, err)
  }
})

// Recursively lists every file under a project's generated src/ tree
// (skipping the same noise directories as readCodeFolder/readDocumentFiles
// above — .git, node_modules, etc.) — used both to build the file browser
// in the Coding tab and, via zipSourceTree below, to build the "download
// everything" archive. Unlike readCodeFolder this is not filtered by
// extension: the browser needs to see every generated file (HTML, CSS,
// JSON, images), not just recognised source-code extensions.
async function listSourceTreeFiles(rootPath: string): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // src/ doesn't exist yet (never scaffolded) — empty list, not an error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/')
      const info = await stat(fullPath)
      files.push({ path: relativePath, size: info.size })
    }
  }

  await walk(rootPath)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// Resolves a browser-supplied relative path against a project's src/ root,
// rejecting anything that would escape it (../, absolute paths, etc.) —
// the file-serving and single-file routes below are the first place this
// server hands raw filesystem content back to a request, so unlike the
// no-auth-needed rule noted above (single-user dev tool, trusted caller),
// path traversal out of the project's own source tree is still worth a
// hard stop rather than trusting the client-supplied path unchecked.
function resolveWithinSourceTree(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(root, relativePath)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null
  return resolved
}

app.get('/api/projects/:id/source-tree', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const root = sourceTreeRoot(store.projectDir(project.id))
  const files = await listSourceTreeFiles(root)
  res.json({ root, files })
})

app.get('/api/projects/:id/source-tree/file', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const relativePath = req.query.path
  if (typeof relativePath !== 'string' || !relativePath) {
    res.status(400).json({ error: 'path query parameter is required' })
    return
  }
  const root = sourceTreeRoot(store.projectDir(project.id))
  const fullPath = resolveWithinSourceTree(root, relativePath)
  if (!fullPath) {
    res.status(400).json({ error: 'path must stay within the project source tree' })
    return
  }
  res.sendFile(fullPath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file not found' })
  })
})

app.get('/api/projects/:id/source-tree/download', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const root = sourceTreeRoot(store.projectDir(project.id))
  const files = await listSourceTreeFiles(root)
  if (files.length === 0) {
    res.status(404).json({ error: 'no source files for this project yet' })
    return
  }
  const zip = new JSZip()
  for (const file of files) {
    zip.file(file.path, await readFile(path.join(root, file.path)))
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const filename = `${slugForFilename(project.name)}_source_${timestampForFilename()}.zip`
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(buffer)
})

const EXPORTABLE_PART_IDS = new Set(PROJECT_PARTS.filter((p) => p.available).map((p) => p.id))

// Filesystem-safe stand-in for anything in the project name that isn't
// alphanumeric/dash/underscore, so the zip filename never breaks on
// slashes, colons, quotes, etc. that a project name could legally contain.
function slugForFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, '_').replace(/^_+|_+$/g, '') || 'project'
}

// yyyyMMdd-HHmmss in local-ish (UTC) time, sortable and safe in a filename
// (no colons) — matches the "project + date/time" naming convention asked
// for in the Import/Export design.
function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}

// Export (Import/Export, resolved): builds a .zip with one JSON file per
// requested, available part (e.g. requirements.json, architecture.json) so
// a re-import can selectively apply just the parts whose checkbox is
// ticked. Unavailable/unknown part ids in the request are silently
// dropped rather than erroring — the UI only ever sends ids from
// PROJECT_PARTS, and a stale client asking for a not-yet-real part
// shouldn't 400 the whole export.
app.post('/api/projects/:id/export', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const partIds = req.body?.partIds
  if (!Array.isArray(partIds) || partIds.some((id) => typeof id !== 'string')) {
    res.status(400).json({ error: 'partIds must be an array of strings' })
    return
  }
  const requested = (partIds as string[]).filter((id): id is ProjectPartId =>
    EXPORTABLE_PART_IDS.has(id as ProjectPartId),
  )
  if (requested.length === 0) {
    res.status(400).json({ error: 'no exportable parts were selected' })
    return
  }

  const zip = new JSZip()
  for (const partId of requested) {
    zip.file(`${partId}.json`, JSON.stringify(exportPart(project, partId), null, 2))
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const filename = `${slugForFilename(project.name)}_${timestampForFilename()}.zip`
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(buffer)
})

// Import (Import/Export, resolved): reads back a zip built by the export
// route above (or hand-assembled in the same shape — one JSON file per
// part, named "<partId>.json"). Only files matching a requested,
// available part id are applied; every other file in the zip is ignored.
// Merges into the current project rather than replacing it — see
// importRequirementsFromPart/importArchitecturePart for the id-remapping
// (REQ-NNN -> IMP_REQ-NNN, ARCH-NNN -> IMP_ARCH-NNN) that keeps an
// imported part's internal references consistent without colliding with
// the target project's own ids.
app.post('/api/projects/:id/import', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const partIdsHeader = req.query.partIds
  const requestedPartIds = new Set(
    (typeof partIdsHeader === 'string' ? partIdsHeader.split(',') : []).filter((id) =>
      EXPORTABLE_PART_IDS.has(id as ProjectPartId),
    ),
  )
  if (requestedPartIds.size === 0) {
    res.status(400).json({ error: 'no importable parts were selected' })
    return
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'request body must be the zip file contents' })
    return
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(req.body)
  } catch {
    res.status(400).json({ error: 'uploaded file is not a valid zip archive' })
    return
  }

  const importedCounts: Partial<Record<ProjectPartId, number>> = {}
  try {
    if (requestedPartIds.has('requirements')) {
      const entry = zip.file('requirements.json')
      if (entry) {
        const data = JSON.parse(await entry.async('string')) as RequirementsPartData
        importedCounts.requirements = importRequirementsFromPart(project, data).length
      }
    }
    if (requestedPartIds.has('architecture')) {
      const entry = zip.file('architecture.json')
      if (entry) {
        const data = JSON.parse(await entry.async('string')) as ArchitecturePartData
        importedCounts.architecture = importArchitecturePart(project, data).length
      }
    }
  } catch (err) {
    res.status(400).json({ error: `import data was malformed: ${(err as Error).message}` })
    return
  }

  await store.saveProject(project)
  res.json({ importedCounts })
})

// Recognised source-code extensions for Import Project (REQ-055) — anything
// else in the uploaded zip is treated as a supporting document. Deliberately
// a fixed allowlist rather than "everything that isn't a known doc
// extension": an unrecognised binary (image, compiled artifact) must not be
// read as text and fed to the LLM as if it were source.
const CODE_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go',
  '.rs', '.rb', '.php', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.m',
  '.scala', '.sql', '.sh', '.ps1', '.html', '.css', '.scss', '.vue', '.svelte',
])
const DOCUMENT_FILE_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.adoc'])

// Directory names skipped entirely when walking a codebase folder (Import
// Project, REQ-055) — a small fixed list, not a full .gitignore parser
// (deliberately out of scope). node_modules/.git/dist/build cover the
// overwhelming majority of what would otherwise flood importedCode with
// vendored/generated content no reverse-elicitation or alignment step
// should ever read.
const SKIPPED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.vite', 'coverage'])

// Walks a server-side code folder (the machine running vic-server, not a
// browser-uploaded file — see the Import Project dialog) and collects
// every recognised source file. This is a local single-user dev tool with
// no auth layer, matching every other route in this file — the only
// safety check here is "must be a real, readable directory"; no further
// sandboxing of which paths are readable is in scope. Requirements and
// architecture now have their own dedicated paths (see
// resolveRequirementsInput/resolveArchitectureInput below) rather than
// being detected inside the code folder, so this only ever returns code
// files.
async function readCodeFolder(rootPath: string): Promise<ImportedCodeFile[]> {
  const codeFiles: ImportedCodeFile[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!CODE_FILE_EXTENSIONS.has(ext)) continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/')
      codeFiles.push({ path: relativePath, content: await readFile(fullPath, 'utf-8') })
    }
  }

  await walk(rootPath)
  return codeFiles
}

// Reads every document-extension file directly under (and beneath) a
// folder — used for the vic-tagged requirements import option, where
// requirementsPath may be a single file or a folder to scan.
async function readDocumentFiles(rootPath: string): Promise<Array<{ path: string; content: string }>> {
  const documents: Array<{ path: string; content: string }> = []

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!DOCUMENT_FILE_EXTENSIONS.has(ext)) continue
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/')
      documents.push({ path: relativePath, content: await readFile(fullPath, 'utf-8') })
    }
  }

  await walk(rootPath)
  return documents
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

// Validates a path exists (400 with a clear message otherwise) — shared by
// every /import-project/preview input, each of which independently
// resolves and checks its own path since code/requirements/architecture
// may each live in a different location.
async function resolveExistingPath(rawPath: string, label: string): Promise<string> {
  const resolvedPath = path.resolve(rawPath)
  try {
    await stat(resolvedPath)
  } catch {
    throw new Error(`${label} path ${resolvedPath} does not exist or is not readable`)
  }
  return resolvedPath
}

// Scans a set of document-shaped entries for VIC's tagged requirement
// block format, importing each match into `project` via the existing
// importRequirementsFromText, stamping provenance 'imported-document'.
// Shared between the preview route (run against a scratch clone) and the
// save route (run against the real project) so both use the exact same
// logic — reused, not reimplemented, per the two callers needing identical
// results. Files not in the tagged format are silently skipped (this
// option's contract is "import files that already are tagged", not an
// error for the ones that aren't).
async function importTaggedRequirementDocuments(
  project: Project,
  documents: Array<{ path: string; content: string }>,
  reserveSeqBlock: (count: number) => Promise<number>,
): Promise<number> {
  let count = 0
  for (const doc of documents) {
    try {
      const seqStart = await reserveSeqBlock(countImportBlocks(doc.content))
      const created = importRequirementsFromText(project, doc.content, seqStart)
      for (const requirement of created) {
        requirement.provenance = 'imported-document'
      }
      count += created.length
    } catch {
      // Not in VIC's tagged block format — skipped, not an error.
    }
  }
  return count
}

// Applies a PendingImport's already-parsed data against `project` for
// real, returning the same preview-shaped counts. Used by both the save
// route (against the live project) and computePreview (against a scratch
// clone) — one implementation, two targets, so preview and save can never
// disagree about what committing would produce.
async function applyPendingImport(
  project: Project,
  codeFiles: ImportedCodeFile[],
  requirementsImport: PendingImport['requirementsImport'],
  architectureImport: PendingImport['architectureImport'],
  reserveSeqBlock: (count: number) => Promise<number>,
): Promise<{ requirementsImportedCount: number; architectureImportedCount: number }> {
  let requirementsImportedCount = 0
  let architectureImportedCount = 0

  if (requirementsImport?.format === 'vic-export') {
    requirementsImportedCount = importRequirementsFromPart(project, {
      requirements: requirementsImport.requirements,
    }).length
  } else if (requirementsImport?.format === 'vic-tagged') {
    requirementsImportedCount = await importTaggedRequirementDocuments(
      project,
      requirementsImport.documents,
      reserveSeqBlock,
    )
  }

  if (architectureImport) {
    architectureImportedCount = importArchitecturePart(project, {
      architectureType: architectureImport.architectureType,
      architecture: architectureImport.architecture,
    }).length
  }

  return { requirementsImportedCount, architectureImportedCount }
}

// Import Project preview (REQ-055): points at up to three independent
// server-side locations (code may live somewhere different from a
// previously-exported requirements.json/architecture.json) and computes
// what importing them would produce, WITHOUT committing anything — every
// parse below runs twice: once for real against a scratch clone (to get
// accurate counts using the exact same merge functions Save will use, see
// applyPendingImport), and the frozen parsed inputs are stored on
// project.pendingImport so Save can replay the identical commit later
// without re-reading the filesystem (paths could change on disk between
// preview and save) or re-parsing. Nothing here calls an LLM — every
// option is a deterministic parse of an exact expected format, matching
// the Import Project dialog's "Import previews, Save commits" design.
app.post('/api/projects/:id/import-project/preview', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  if (project.projectMode !== 'import') {
    res.status(400).json({ error: 'import-project is only valid for an "import" mode project' })
    return
  }

  const codePath = req.body?.codePath
  const requirementsPath = req.body?.requirementsPath
  const requirementsFormat = req.body?.requirementsFormat
  const architecturePath = req.body?.architecturePath

  if (codePath !== null && typeof codePath !== 'string') {
    res.status(400).json({ error: 'codePath must be a string or null' })
    return
  }
  if (requirementsPath !== null && typeof requirementsPath !== 'string') {
    res.status(400).json({ error: 'requirementsPath must be a string or null' })
    return
  }
  if (requirementsPath && requirementsFormat !== 'vic-export' && requirementsFormat !== 'vic-tagged') {
    res.status(400).json({ error: 'requirementsFormat must be "vic-export" or "vic-tagged" when requirementsPath is set' })
    return
  }
  if (architecturePath !== null && typeof architecturePath !== 'string') {
    res.status(400).json({ error: 'architecturePath must be a string or null' })
    return
  }

  let codeFiles: ImportedCodeFile[] = []
  let requirementsImport: PendingImport['requirementsImport'] = null
  let architectureImport: PendingImport['architectureImport'] = null

  try {
    if (codePath) {
      const resolved = await resolveExistingPath(codePath, 'Code folder')
      if (!(await isDirectory(resolved))) {
        throw new Error(`Code folder path ${resolved} is not a directory`)
      }
      codeFiles = await readCodeFolder(resolved)
    }

    if (requirementsPath && requirementsFormat === 'vic-export') {
      const resolved = await resolveExistingPath(requirementsPath, 'Requirements file')
      const data = JSON.parse(await readFile(resolved, 'utf-8')) as RequirementsPartData
      requirementsImport = { format: 'vic-export', requirements: data.requirements }
    } else if (requirementsPath && requirementsFormat === 'vic-tagged') {
      const resolved = await resolveExistingPath(requirementsPath, 'Requirements path')
      const documents = (await isDirectory(resolved))
        ? await readDocumentFiles(resolved)
        : [{ path: resolved, content: await readFile(resolved, 'utf-8') }]
      requirementsImport = { format: 'vic-tagged', documents }
    }

    if (architecturePath) {
      const resolved = await resolveExistingPath(architecturePath, 'Architecture file')
      const data = JSON.parse(await readFile(resolved, 'utf-8')) as ArchitecturePartData
      architectureImport = { architectureType: data.architectureType ?? null, architecture: data.architecture }
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
    return
  }

  const scratch = structuredClone(project)
  let counts: { requirementsImportedCount: number; architectureImportedCount: number }
  try {
    // Preview never saves anything, so it must not permanently consume real
    // global requirement-id numbers — a local, throwaway counter stands in
    // for globalSeqStore here; the save route below reserves for real.
    let previewSeq = 1
    const reservePreviewSeqBlock = async (count: number) => {
      const seqStart = previewSeq
      previewSeq += count
      return seqStart
    }
    counts = await applyPendingImport(scratch, codeFiles, requirementsImport, architectureImport, reservePreviewSeqBlock)
  } catch (err) {
    res.status(400).json({ error: `import data was malformed: ${(err as Error).message}` })
    return
  }

  const preview: PendingImportPreview = {
    codeFileCount: codeFiles.length,
    requirementsImportedCount: counts.requirementsImportedCount,
    architectureImportedCount: counts.architectureImportedCount,
  }
  project.pendingImport = {
    codeFiles,
    requirementsImport,
    architectureImport,
    preview,
    stagedAt: new Date().toISOString(),
  }
  await store.saveProject(project)
  res.json(preview)
})

// Commits a previously-staged preview (see /import-project/preview above)
// for real against the live project, using the exact same
// applyPendingImport function the preview ran against its scratch clone —
// guaranteed to reproduce the previewed counts. Clears pendingImport once
// committed.
app.post('/api/projects/:id/import-project/save', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const pending = project.pendingImport
  if (!pending) {
    res.status(400).json({ error: 'nothing to save — run Import first' })
    return
  }

  if (pending.codeFiles.length > 0) {
    project.importedCode = { files: pending.codeFiles, importedAt: new Date().toISOString() }
  }
  await applyPendingImport(
    project,
    pending.codeFiles,
    pending.requirementsImport,
    pending.architectureImport,
    (count) => globalSeqStore.reserveRequirementSeqBlock(count),
  )
  project.pendingImport = undefined

  await store.saveProject(project)
  res.json(pending.preview)
})

// Discards a previously-staged preview without committing it — called when
// the Import Project dialog is closed after Import but before Save, so a
// half-reviewed import doesn't linger as stale pendingImport state.
app.delete('/api/projects/:id/import-project/pending', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  project.pendingImport = undefined
  await store.saveProject(project)
  res.status(204).end()
})

// Commits accepted proposals from /import-codebase, stamping the given
// provenance — mirrors the existing accept-a-proposal pattern used for
// analyst-chat and gap-check proposals (create one requirement per accepted
// text via createRequirementFromForm), just batched since Import Project
// can return many proposals in one response.
app.post('/api/projects/:id/import-codebase/accept', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const texts = req.body?.texts
  const provenance = req.body?.provenance
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) {
    res.status(400).json({ error: 'texts must be an array of strings' })
    return
  }
  if (provenance !== 'imported-document' && provenance !== 'reverse-elicited-code') {
    res.status(400).json({ error: 'provenance must be "imported-document" or "reverse-elicited-code"' })
    return
  }
  const created = []
  for (const text of texts as string[]) {
    const seq = await globalSeqStore.getAndIncrementRequirementSeq()
    created.push(createRequirementFromForm(project, { text, provenance }, seq))
  }
  await store.saveProject(project)
  res.status(201).json(created)
})

// Code gap scan (Import Project, REQ-056) — a separate, explicitly
// user-triggered, re-runnable step (not part of /import-codebase) so it
// only runs once the user is satisfied with their baseline requirement set
// (from documents and/or manual entry). Scans project.importedCode's files
// against the project's current confirmed requirements and proposes
// requirements only for behaviour not already covered — see
// proposeCodeGapRequirements. Requires a codebase to already have been
// uploaded via /import-codebase.
// Parses the optional content-stripping toggles from a request body — each
// an independent boolean (see codeStrip.ts's CodeStripOptions for the
// tradeoff behind each one). Missing/non-boolean fields fall back to
// DEFAULT_CODE_STRIP_OPTIONS's value for that field, not blanket-off, so an
// omitted body still gets the same safe default the dialog shows.
function parseStripOptions(body: unknown): CodeStripOptions {
  const b = (body ?? {}) as Record<string, unknown>
  return {
    stripBlankLines:
      typeof b.stripBlankLines === 'boolean' ? b.stripBlankLines : DEFAULT_CODE_STRIP_OPTIONS.stripBlankLines,
    stripComments:
      typeof b.stripComments === 'boolean' ? b.stripComments : DEFAULT_CODE_STRIP_OPTIONS.stripComments,
    stripBodies: typeof b.stripBodies === 'boolean' ? b.stripBodies : DEFAULT_CODE_STRIP_OPTIONS.stripBodies,
  }
}

// Pre-flight token estimate for a code gap scan — pure local computation
// (see tokenEstimate.ts), no LLM call. Covers both the 'complete' and
// 'stripped' content modes (stripOptions from the query string configures
// what 'stripped' means) so the dialog can show both without a round trip
// per toggle, plus singleCallFits/perFileTotalTokens for each — the
// ImportCodeGapScanDialog uses these to grey out single-call when it won't
// fit and to show cost/size for whichever combination of content mode and
// delivery mode the user has selected, instead of letting the user hit the
// GLM "Prompt 超长" / prompt-too-long 400 that motivated this.
app.get('/api/projects/:id/scan-code-gaps/estimate', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  if (!project.importedCode || project.importedCode.files.length === 0) {
    res.status(400).json({ error: 'no imported code to scan — import a codebase first' })
    return
  }
  const personaScope = await resolvePersonaScope(req)
  const llmOptions = await resolvePersonaLlmOptions(personaScope, 'code-gap-scan')
  const stripOptions = parseStripOptions({
    stripBlankLines: req.query.stripBlankLines === undefined ? undefined : req.query.stripBlankLines === 'true',
    stripComments: req.query.stripComments === undefined ? undefined : req.query.stripComments === 'true',
    stripBodies: req.query.stripBodies === undefined ? undefined : req.query.stripBodies === 'true',
  })
  const estimate = estimateCodeGapScanTokens(
    project.importedCode.files,
    activeRequirements(project),
    CODE_GAP_SCAN_SYSTEM_PROMPT,
    stripOptions,
    llmOptions.model,
  )
  res.json(estimate)
})

// content: 'complete' (default) sends each file's original content;
// 'stripped' applies stripOptions (see parseStripOptions) first — see
// codeStrip.ts for what each toggle removes and why. mode: 'single-call'
// (default) reproduces the original behaviour — every (content-mode-
// adjusted) file concatenated into one LLM call, only safe under the
// model's context window (see the /estimate route above). 'per-file' runs
// one call per file instead, with no such ceiling, at the cost of N calls
// and losing cross-file context — see proposeCodeGapRequirementsPerFile.
// maxFiles (per-file mode only) applies the structure-only pre-filter
// (filterCodeFilesForGapScan) to cap the number of files/calls on a very
// large import; omitted means scan every file.
app.post('/api/projects/:id/scan-code-gaps', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  if (!project.importedCode || project.importedCode.files.length === 0) {
    res.status(400).json({ error: 'no imported code to scan — import a codebase first' })
    return
  }
  const mode = req.body?.mode === 'per-file' ? 'per-file' : 'single-call'
  const maxFiles = typeof req.body?.maxFiles === 'number' ? req.body.maxFiles : undefined
  const stripOptions = req.body?.content === 'stripped' ? parseStripOptions(req.body?.stripOptions) : undefined
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'code-gap-scan')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'code-gap-scan')
    const files =
      mode === 'per-file' && maxFiles !== undefined
        ? filterCodeFilesForGapScan(project.importedCode.files, maxFiles)
        : project.importedCode.files
    const result =
      mode === 'per-file'
        ? await proposeCodeGapRequirementsPerFile(project, llmClient, files, llmOptions, undefined, stripOptions)
        : await proposeCodeGapRequirements(project, llmClient, files, llmOptions, stripOptions)
    recordTokenUsage(result.usage)
    res.json({ proposedRequirements: result.proposedRequirements })
  } catch (err) {
    sendLlmError(res, err)
  }
})

// Code alignment analysis (Import Project, REQ-059/REQ-060) — compares the
// imported codebase against the confirmed architecture, run after the
// Architect has designed the target architecture from requirements alone
// (REQ-058). Uses the architect persona since this is architecture-adjacent
// analysis, same reasoning as checkArchitectureConflicts above.
app.post('/api/projects/:id/analyze-code-alignment', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const personaScope = await resolvePersonaScope(req)
    const llmClient = await getClientForPersona(personaScope, 'architect')
    const llmOptions = await resolvePersonaLlmOptions(personaScope, 'architect')
    const result = await runCodeAlignmentAnalysis(project, llmClient, llmOptions)
    recordTokenUsage(result.usage)
    await store.saveProject(project)
    res.json({ codeAlignment: project.codeAlignment })
  } catch (err) {
    sendLlmError(res, err)
  }
})

// Migration plan generation (Import Project, REQ-061) — pure/deterministic,
// no LLM call, so unlike the routes above this doesn't need
// getClientForPersona/sendLlmError; a thrown Error here means the project
// isn't ready yet (wrong mode, no architecture, no alignment analysis), not
// an LLM failure.
app.post('/api/projects/:id/generate-migration-plan', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  try {
    const stories = generateMigrationPlan(project)
    project.migrationPlan = { stories, generatedAt: new Date().toISOString() }
    await store.saveProject(project)
    res.json({ migrationPlan: project.migrationPlan })
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

// Import Project state that openProject needs to restore on reopen —
// projectMode is otherwise only ever returned by POST /api/projects
// (creation), so without this route reopening a previously-created
// import-mode project would lose track of its mode and any
// imported-code/alignment/migration-plan progress.
app.get('/api/projects/:id/import-status', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json({
    projectMode: project.projectMode,
    importedCode: project.importedCode ?? null,
    codeAlignment: project.codeAlignment ?? null,
    migrationPlan: project.migrationPlan ?? null,
    hasPendingImport: project.pendingImport !== undefined,
  })
})

const PHASE_TAB_GATING_VALUES: PhaseTabGating[] = ['gated', 'always-accessible']
const UNIT_TEST_MODE_VALUES: UnitTestMode[] = ['llm', 'scaffold', 'disabled']

app.get('/api/projects/:id/settings', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  res.json(getProjectSettings(project))
})

app.put('/api/projects/:id/settings', async (req, res) => {
  const project = await loadProjectOr404(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'project not found' })
    return
  }
  const { phaseTabGating, unitTestMode } = req.body ?? {}
  if (phaseTabGating !== undefined && !PHASE_TAB_GATING_VALUES.includes(phaseTabGating)) {
    res.status(400).json({ error: 'phaseTabGating must be "gated" or "always-accessible"' })
    return
  }
  if (unitTestMode !== undefined && !UNIT_TEST_MODE_VALUES.includes(unitTestMode)) {
    res.status(400).json({ error: 'unitTestMode must be "llm", "scaffold", or "disabled"' })
    return
  }
  const updates = {
    ...(phaseTabGating !== undefined ? { phaseTabGating } : {}),
    ...(unitTestMode !== undefined ? { unitTestMode } : {}),
  }
  const settings = updateProjectSettings(project, updates)
  await store.saveProject(project)
  res.json(settings)
})

app.get('/api/settings/plugins', async (_req, res) => {
  const result = await Promise.all(
    installedPluginManifests.map(async (manifest) => {
      const values = await secretsStore.getPluginValues(manifest.id)
      return {
        id: manifest.id,
        label: manifest.label,
        setupSummary: manifest.setupSummary,
        setupUrl: manifest.setupUrl,
        fields: manifest.fields.map((field) => ({
          key: field.key,
          label: field.label,
          description: field.description,
          secret: field.secret,
          type: field.type,
          options: field.options,
          // Secret values are never sent back in plaintext once saved —
          // only whether one is currently set. Non-secret values (e.g.
          // model name) are safe to echo back so the form can show them.
          hasValue: Boolean(values[field.key]),
          value: field.secret ? undefined : (values[field.key] ?? ''),
        })),
      }
    }),
  )
  res.json(result)
})

// CLI-backed plugins only (see CLI_BACKED_PLUGIN_IDS) — runs `claude
// --version`, never a prompt, so checking status never spends Pro/Max plan
// usage. Safe to call every time the Settings screen renders this plugin.
app.get('/api/settings/plugins/:id/status', async (req, res) => {
  const manifest = installedPluginManifests.find((m) => m.id === req.params.id)
  if (!manifest) {
    res.status(404).json({ error: 'unknown plugin id' })
    return
  }
  if (!CLI_BACKED_PLUGIN_IDS.has(manifest.id)) {
    res.status(400).json({ error: 'this plugin has no installation status to check' })
    return
  }
  const status = await checkClaudeCodeInstalled()
  res.json(status)
})

// Rate-limit/quota usage for the status bar (5-hour and weekly windows).
// Distinct from /api/token-usage, which is VIC's own running token tally
// across this process's lifetime — this is the provider's own account-wide
// quota, independent of which project or persona is open. Any plugin
// without a getUsage hook (see settingsRegistry.ts) reports 501 rather
// than a generic 404/500, so the UI can tell "no usage concept for this
// provider" apart from "unknown plugin id" or "the lookup itself failed".
app.get('/api/settings/plugins/:id/usage', async (req, res) => {
  const plugin = findInstalledPlugin(req.params.id)
  if (!plugin) {
    res.status(404).json({ error: 'unknown plugin id' })
    return
  }
  if (!plugin.getUsage) {
    res.status(501).json({ error: 'this plugin does not report usage' })
    return
  }
  try {
    const values = await secretsStore.getPluginValues(plugin.manifest.id)
    const usage = await plugin.getUsage(values)
    res.json(usage)
  } catch (err) {
    res.status(502).json({ error: (err as Error).message })
  }
})

app.put('/api/settings/plugins/:id', async (req, res) => {
  const manifest = installedPluginManifests.find((m) => m.id === req.params.id)
  if (!manifest) {
    res.status(404).json({ error: 'unknown plugin id' })
    return
  }
  const values = req.body?.values
  if (typeof values !== 'object' || values === null) {
    res.status(400).json({ error: 'values object is required' })
    return
  }
  const knownKeys = new Set(manifest.fields.map((f) => f.key))
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (knownKeys.has(key) && typeof value === 'string' && value !== '') {
      filtered[key] = value
    }
  }
  await secretsStore.setPluginValues(manifest.id, filtered)
  res.status(204).end()
})

// Builds one scope's full persona list (same per-persona shape GET has
// always returned) — shared by both the 'user' list (every caller sees
// this) and the 'admin' list (only included for admin callers, see below).
async function buildPersonaSettingsList(scope: PersonaScope) {
  return Promise.all(
    personas.map(async (persona) => {
      const pluginId = await resolvePersonaPluginId(scope, persona.id)
      const manifest = pluginId ? findPluginManifest(pluginId) : undefined
      const overrides = await personaSettingsStore.getPersonaValues(scope, persona.id)

      const agentPluginId = await resolvePersonaAgentPluginId(scope, persona.id)
      const agentManifest = agentPluginId ? findPluginManifest(agentPluginId) : undefined
      const agentOverrides = persona.supportsAgentLevel
        ? await personaSettingsStore.getAgentValues(scope, persona.id)
        : {}

      return {
        id: persona.id,
        label: persona.label,
        pluginId: pluginId ?? null,
        pluginLabel: manifest?.label,
        // Every installed plugin is a valid choice for any persona — the
        // dropdown in Settings > Personas is populated from this generic
        // list, never a per-persona hardcoded set.
        availablePlugins: installedPluginManifests.map((m) => ({ id: m.id, label: m.label })),
        // Only fields the backing plugin declared as persona-overridable
        // are exposed here — never a secret field.
        fields: (manifest?.personaOverridableFields ?? []).map((field) => ({
          key: field.key,
          label: field.label,
          description: field.description,
          type: field.type,
          options: field.options,
          value: overrides[field.key] ?? '',
        })),
        supportsAgentLevel: persona.supportsAgentLevel,
        agentPluginId: agentPluginId ?? null,
        agentPluginLabel: agentManifest?.label,
        agentFields: (agentManifest?.personaOverridableFields ?? []).map((field) => ({
          key: field.key,
          label: field.label,
          description: field.description,
          type: field.type,
          options: field.options,
          value: agentOverrides[field.key] ?? '',
        })),
      }
    }),
  )
}

// Admins see and can edit both persona lists; everyone else only ever sees
// (never edits) the 'user' list — the one that actually backs their own
// pipeline runs, see resolvePersonaScope. The 'admin' key is omitted
// entirely for non-admin callers rather than sent empty, so the UI can't
// accidentally render an "admin personas" section for a regular user.
app.get('/api/settings/personas', async (req, res) => {
  const callerScope = await resolvePersonaScope(req)
  const user = await buildPersonaSettingsList('user')
  if (callerScope !== 'admin') {
    res.json({ user })
    return
  }
  const admin = await buildPersonaSettingsList('admin')
  res.json({ admin, user })
})

app.put('/api/settings/personas/:id', async (req, res) => {
  const persona = personas.find((p) => p.id === req.params.id)
  if (!persona) {
    res.status(404).json({ error: 'unknown persona id' })
    return
  }
  // Only admins may edit either persona list — regular users can view the
  // 'user' list (GET above) but never change it themselves.
  const callerScope = await resolvePersonaScope(req)
  if (callerScope !== 'admin') {
    res.status(403).json({ error: 'only admins can edit persona settings' })
    return
  }
  const requestedScope = req.body?.scope
  if (requestedScope !== 'admin' && requestedScope !== 'user') {
    res.status(400).json({ error: "scope must be 'admin' or 'user'" })
    return
  }
  const personaScope: PersonaScope = requestedScope

  // Plugin selection, if provided, is applied first so the field values
  // below are validated/filtered against the newly-selected plugin's
  // manifest, not whatever was previously active.
  const requestedPluginId = req.body?.pluginId
  if (requestedPluginId !== undefined) {
    if (typeof requestedPluginId !== 'string' || !findPluginManifest(requestedPluginId)) {
      res.status(400).json({ error: 'pluginId must be an installed plugin id' })
      return
    }
    await personaSettingsStore.setSelectedPluginId(personaScope, persona.id, requestedPluginId)
  }

  const pluginId = await resolvePersonaPluginId(personaScope, persona.id)
  const manifest = pluginId ? findPluginManifest(pluginId) : undefined
  const values = req.body?.values
  if (typeof values !== 'object' || values === null) {
    res.status(400).json({ error: 'values object is required' })
    return
  }
  const knownKeys = new Set((manifest?.personaOverridableFields ?? []).map((f) => f.key))
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    // An empty string explicitly clears an override (falls back to the
    // plugin default), unlike the plugin-secrets route where blank means
    // "leave unchanged" — personas have no secret fields to protect, so a
    // deliberate clear-to-default is always safe to apply immediately.
    if (knownKeys.has(key) && typeof value === 'string') {
      filtered[key] = value
    }
  }
  await personaSettingsStore.setPersonaValues(personaScope, persona.id, filtered)

  // Agent-level plugin/values, only accepted for a persona that declares
  // supportsAgentLevel — rejected outright for any other persona so the
  // agent level can never be silently set on one that doesn't render it.
  const requestedAgentPluginId = req.body?.agentPluginId
  const agentValues = req.body?.agentValues
  if (requestedAgentPluginId !== undefined || agentValues !== undefined) {
    if (!persona.supportsAgentLevel) {
      res.status(400).json({ error: 'this persona does not support an agent level' })
      return
    }
  }
  if (requestedAgentPluginId !== undefined) {
    if (requestedAgentPluginId === '') {
      await personaSettingsStore.clearSelectedAgentPluginId(personaScope, persona.id)
    } else if (typeof requestedAgentPluginId !== 'string' || !findPluginManifest(requestedAgentPluginId)) {
      res.status(400).json({ error: 'agentPluginId must be an installed plugin id' })
      return
    } else {
      await personaSettingsStore.setSelectedAgentPluginId(personaScope, persona.id, requestedAgentPluginId)
    }
  }
  if (agentValues !== undefined) {
    if (typeof agentValues !== 'object' || agentValues === null) {
      res.status(400).json({ error: 'agentValues must be an object' })
      return
    }
    const agentPluginId = await resolvePersonaAgentPluginId(personaScope, persona.id)
    const agentManifest = agentPluginId ? findPluginManifest(agentPluginId) : undefined
    const agentKnownKeys = new Set((agentManifest?.personaOverridableFields ?? []).map((f) => f.key))
    const filteredAgentValues: Record<string, string> = {}
    for (const [key, value] of Object.entries(agentValues)) {
      if (agentKnownKeys.has(key) && typeof value === 'string') {
        filteredAgentValues[key] = value
      }
    }
    await personaSettingsStore.setAgentValues(personaScope, persona.id, filteredAgentValues)
  }

  res.status(204).end()
})

// Catches anything that reaches Express without going through a route's own
// try/catch — e.g. express.json() throwing on a malformed request body, or
// an async error a route forgot to catch. Without this, Express's default
// handler sends a bare non-JSON 500, which requestJson (httpApi.ts) can't
// parse an `error` message out of, so the UI falls back to a generic
// "failed with status 500" — this restores the same { error: message } shape
// every route already returns so that message is never lost.
const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err)
    return
  }
  console.error(err)
  res.status(500).json({ error: (err as Error).message ?? 'Internal server error' })
}
app.use(jsonErrorHandler)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`vic-server listening on http://0.0.0.0:${PORT} (reachable on the LAN)`)
  console.log(`projects root: ${PROJECTS_ROOT}`)
  console.log(`secrets dir:   ${SECRETS_DIR}`)
})
