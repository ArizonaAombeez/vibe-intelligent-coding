import type {
  AnalyseResult,
  AnalystChatResult,
  ApplySplitRequirementResult,
  ChatSession,
  ChatSurface,
  ChatSessionFocus,
  Architecture,
  ArchitectChatResult,
  ArchitectureConflict,
  ArchitectureElement,
  ArchitectureElementKind,
  ArchitectureTypeId,
  ArchitectureTypeOption,
  PlatformDescriptor,
  PlatformId,
  HarnessSpec,
  AutoConfigureAndAllocateResult,
  AutoAllocateResult,
  CheckConflictsResult,
  CheckInterfacesResult,
  CheckInterfaceCodeAlignmentResult,
  InterfaceDefinition,
  InterfaceRole,
  ElementInterfaceDefinition,
  InterfaceContractOperation,
  CodeAlignmentRecord,
  CodingRun,
  ElementRequirementCoverage,
  CreateArchitectureElementFields,
  CurrentOperation,
  ImportProjectPreviewOptions,
  ImportProjectPreview,
  ImportedTestCase,
  ImportedTestCaseSet,
  ScanCodeGapsResult,
  ScanCodeGapsOptions,
  CodeGapScanTokenEstimate,
  CodeStripOptions,
  CreateTestCaseFields,
  LastChecksResult,
  MigrationPlanRecord,
  OpenProjectResult,
  PersonaScope,
  PersonaSettings,
  PluginInstallStatus,
  PluginSettings,
  PluginUsage,
  ProjectMode,
  ProjectPartId,
  ProjectPartInfo,
  ProjectSettings,
  ProjectSummary,
  ProposedTest,
  RejectedProposal,
  Requirement,
  RequirementProvenance,
  RequirementReferencesResult,
  RequirementStatus,
  SplitPieceInput,
  SplitRequirementResult,
  StorageInfo,
  Status,
  PhaseId,
  PhaseBlocker,
  TestCase,
  TestCommandScope,
  TestCreationChatResult,
  TestExecutionChatResult,
  TestOutcomeTriage,
  TestRegressionRun,
  TestRun,
  TestSuite,
  ScopeReadinessEntry,
  TokenEstimate,
  TokenUsage,
  TraceabilityRejectionReason,
  UpdateArchitectureElementFields,
  UpdateTestCaseFields,
  VicCoreApi,
  VicUser,
} from './types'
import { toOperationError } from './errorCode'

const defaultSettings: ProjectSettings = {
  earsMode: 'full',
  unitTestMode: 'llm',
  lightDarkMode: 'system',
  autoSave: true,
  // Sign-off (requirement 61) isn't built yet and the tool is single-user
  // only for now, so 'gated' has nothing to usefully gate on — defaults to
  // always-accessible until sign-off exists. Overridden below by whatever
  // the server has actually persisted for this project.
  phaseTabGating: 'always-accessible',
}

// T2.2: the server computes real phase status + blockers; overlay its
// statuses onto the labelled/substep skeleton here so a stale or errored
// route still renders a sane sidebar.
interface PhaseReadinessResponse {
  statuses: Record<PhaseId, Status>
  blockers: Array<{ phaseId: PhaseId; reason: string; fixPhaseId: PhaseId; fixLabel: string }>
}

function overlayPhaseStatuses(
  phases: OpenProjectResult['phases'],
  statuses: PhaseReadinessResponse['statuses'],
): OpenProjectResult['phases'] {
  return phases.map((p) => (statuses[p.id] ? { ...p, status: statuses[p.id] } : p))
}

function defaultPhases(): OpenProjectResult['phases'] {
  return [
    { id: 'dashboard', label: 'Dashboard', status: 'in-progress', substeps: [] },
    {
      id: 'requirements',
      label: 'Requirements',
      status: 'in-progress',
      // Gap/Conflict Check and Quality Scoring used to be separate substeps
      // but that functionality has always lived on the Elicitation screen
      // itself (Check Conflicts/Check Gaps buttons, quality score badges) —
      // they were dead placeholder tabs, not distinct screens. Requirements
      // now has a single substep, so the sidebar hides entirely for this
      // phase (substeps.length === 0), same as Coding/Test.
      substeps: [],
    },
    {
      id: 'architecture',
      label: 'Architecture',
      status: 'not-started',
      substeps: [
        { id: 'baseline', label: 'Baseline Selection', status: 'not-started' },
        { id: 'allocation', label: 'Allocation', status: 'not-started' },
        { id: 'traceability', label: 'Traceability View', status: 'not-started' },
      ],
    },
    { id: 'test-creation', label: 'Test Creation', status: 'not-started', substeps: [] },
    { id: 'coding', label: 'Coding', status: 'not-started', substeps: [] },
    { id: 'test-execution', label: 'Test Execution', status: 'not-started', substeps: [] },
  ]
}

// Carries the server's error `code` (e.g. 'llm-not-configured') alongside
// the message, so callers can distinguish "no provider configured" from any
// other failure without string-matching the message text.
export class ApiError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

// Set once by createHttpApi's caller (App.tsx) after login, read fresh on
// every request — the api object itself is created before a user is ever
// logged in (the login screen needs api.listUsers()/createUser() with no
// one logged in yet), so this can't be a constructor param. Same
// identity/attribution-only trust model as the rest of login: the server
// re-derives isAdmin from this id itself rather than trusting a client-sent
// flag (see usersStore.ts).
let currentUserId: string | null = null

export function setCurrentUserIdForApi(userId: string | null): void {
  currentUserId = userId
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(currentUserId ? { 'X-VIC-User': currentUserId } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(
      body?.error ?? `Request to ${url} failed with status ${response.status}`,
      body?.code,
    )
  }
  return response.json() as Promise<T>
}

// Mirrors modules/requirements-elicitation/src/projectParts.ts's
// PROJECT_PARTS — kept as a plain literal here rather than importing the
// core module, per the UI-as-a-pluggable-module principle. The server is
// the source of truth for which parts are actually importable/exportable
// (see EXPORTABLE_PART_IDS); this only drives which checkboxes the dialog
// shows and which start disabled.
const PROJECT_PARTS: ProjectPartInfo[] = [
  { id: 'requirements', label: 'Requirements', available: true },
  { id: 'architecture', label: 'Architecture', available: true },
  { id: 'test-creation', label: 'Test Creation', available: false },
  { id: 'coding', label: 'Coding', available: false },
  { id: 'test-execution', label: 'Test Execution', available: false },
]

// Extracts the filename the server chose (project name + timestamp) from
// its Content-Disposition header, so the browser download uses the same
// name the zip was built with rather than a generic default.
function filenameFromContentDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/)
  return match?.[1] ?? 'export.zip'
}

// Real VicCoreApi implementation, backed by vic-server over HTTP.
export function createHttpApi(baseUrl: string): VicCoreApi {
  let currentOperation: CurrentOperation = { text: null }

  return {
    async listUsers() {
      return requestJson<VicUser[]>(`${baseUrl}/api/users`)
    },

    async createUser(name: string) {
      return requestJson<VicUser>(`${baseUrl}/api/users`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
    },

    async listRecentProjects() {
      const projects = await requestJson<ProjectSummary[]>(`${baseUrl}/api/projects`)
      return projects
    },

    async openProject(id: string) {
      currentOperation = { text: `Opening project "${id}"...` }
      const projects = await requestJson<ProjectSummary[]>(`${baseUrl}/api/projects`)
      const project = projects.find((p) => p.id === id)
      const architectureType = await requestJson<ArchitectureTypeId | null>(
        `${baseUrl}/api/projects/${id}/architecture-type`,
      )
      const persistedSettings = await requestJson<Partial<ProjectSettings>>(
        `${baseUrl}/api/projects/${id}/settings`,
      )
      const importStatus = await requestJson<{
        projectMode: ProjectMode
        importedCode: { files: Array<{ path: string; content: string }>; importedAt: string } | null
        codeAlignment: CodeAlignmentRecord | null
        migrationPlan: MigrationPlanRecord | null
      }>(`${baseUrl}/api/projects/${id}/import-status`)
      // T2.2: overlay real computed phase status. Non-fatal — a failure here
      // just leaves the labelled skeleton's default statuses.
      const readiness = await requestJson<PhaseReadinessResponse>(
        `${baseUrl}/api/projects/${id}/phase-readiness`,
      ).catch(() => null)
      currentOperation = { text: null }
      return {
        projectId: id,
        projectName: project?.name ?? id,
        phases: readiness
          ? overlayPhaseStatuses(defaultPhases(), readiness.statuses)
          : defaultPhases(),
        settings: { ...defaultSettings, ...persistedSettings },
        architectureType,
        projectMode: importStatus.projectMode,
        // documentFileCount is always 0 on reopen — only code files are
        // persisted on project.importedCode (see codeImport.ts); documents
        // are fully consumed into requirements/discarded at import time and
        // not stored, so there's nothing to recount here.
        importedCode: importStatus.importedCode
          ? {
              codeFileCount: importStatus.importedCode.files.length,
              documentFileCount: 0,
              importedAt: importStatus.importedCode.importedAt,
            }
          : undefined,
        codeAlignment: importStatus.codeAlignment ?? undefined,
        migrationPlan: importStatus.migrationPlan ?? undefined,
      }
    },

    async createProject(name: string, mode?: ProjectMode) {
      currentOperation = { text: `Creating project "${name}"...` }
      const created = await requestJson<{ id: string; name: string; projectMode?: ProjectMode }>(
        `${baseUrl}/api/projects`,
        { method: 'POST', body: JSON.stringify({ name, mode }) },
      )
      currentOperation = { text: null }
      return {
        projectId: created.id,
        projectName: created.name,
        phases: defaultPhases(),
        settings: defaultSettings,
        architectureType: null,
        projectMode: created.projectMode ?? mode ?? 'new',
      }
    },

    async renameProject(id: string, name: string) {
      return requestJson<ProjectSummary>(`${baseUrl}/api/projects/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
      })
    },

    async deleteProject(id: string) {
      const response = await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Deleting project ${id} failed`)
      }
    },

    async closeProject() {
      currentOperation = { text: null }
    },

    async getCurrentOperation() {
      return currentOperation
    },

    async getTokenUsage() {
      return requestJson<TokenUsage>(`${baseUrl}/api/token-usage`)
    },

    async listRequirements(projectId: string) {
      return requestJson<Requirement[]>(`${baseUrl}/api/projects/${projectId}/requirements`)
    },

    async createRequirement(projectId: string, text: string) {
      return requestJson<Requirement>(`${baseUrl}/api/projects/${projectId}/requirements`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
    },

    async analystChat(projectId: string, message: string, sessionId?: string) {
      try {
        currentOperation = { text: 'Analyst is thinking...' }
        const result = await requestJson<AnalystChatResult>(
          `${baseUrl}/api/projects/${projectId}/analyst-chat`,
          { method: 'POST', body: JSON.stringify({ message, sessionId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async acceptProposedRequirement(projectId: string, text: string) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/from-proposal`,
        { method: 'POST', body: JSON.stringify({ text }) },
      )
    },

    async updateRequirement(projectId: string, requirementId: string, text: string) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}`,
        { method: 'PUT', body: JSON.stringify({ text }) },
      )
    },

    async proposeSplitRequirement(projectId: string, requirementId: string) {
      try {
        currentOperation = { text: 'Analyst is proposing a split...' }
        const result = await requestJson<SplitRequirementResult>(
          `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/split`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async getRequirementReferences(projectId: string, requirementId: string) {
      return requestJson<RequirementReferencesResult>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/references`,
      )
    },

    async applySplitRequirement(projectId: string, requirementId: string, pieces: SplitPieceInput[]) {
      return requestJson<ApplySplitRequirementResult>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/split/apply`,
        { method: 'POST', body: JSON.stringify({ pieces }) },
      )
    },

    async setAllocationRationale(projectId: string, requirementId: string, rationale: string) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/allocation-rationale`,
        { method: 'PUT', body: JSON.stringify({ rationale }) },
      )
    },

    async estimateAnalysisTokens(projectId: string, requirementIds: string[]) {
      return requestJson<TokenEstimate>(`${baseUrl}/api/projects/${projectId}/analyse/estimate`, {
        method: 'POST',
        body: JSON.stringify({ requirementIds }),
      })
    },

    async analyseRequirements(projectId: string, requirementIds: string[]) {
      try {
        currentOperation = { text: 'Analyst is reviewing requirements...' }
        const result = await requestJson<AnalyseResult[]>(
          `${baseUrl}/api/projects/${projectId}/analyse`,
          { method: 'POST', body: JSON.stringify({ requirementIds }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async importRequirements(projectId: string, text: string) {
      return requestJson<Requirement[]>(
        `${baseUrl}/api/projects/${projectId}/requirements/import`,
        { method: 'POST', body: JSON.stringify({ text }) },
      )
    },

    async checkConflicts(projectId: string) {
      try {
        currentOperation = { text: 'Analyst is checking for conflicts...' }
        const result = await requestJson<CheckConflictsResult>(
          `${baseUrl}/api/projects/${projectId}/check-conflicts`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async getLastChecks(projectId: string) {
      return requestJson<LastChecksResult>(`${baseUrl}/api/projects/${projectId}/last-checks`)
    },

    async getCollapsedRequirementGroups(projectId: string) {
      return requestJson<string[]>(`${baseUrl}/api/projects/${projectId}/requirements/collapsed-groups`)
    },

    async setCollapsedRequirementGroups(projectId: string, groupNames: string[]) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/requirements/collapsed-groups`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupNames }),
        },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Saving collapsed groups for ${projectId} failed`)
      }
    },

    async checkGaps(projectId: string) {
      try {
        currentOperation = { text: 'Analyst is checking for gaps...' }
        const result = await requestJson<{ suggestions: string[] }>(
          `${baseUrl}/api/projects/${projectId}/check-gaps`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result.suggestions
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async deleteRequirement(projectId: string, requirementId: string) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Deleting requirement ${requirementId} failed`)
      }
    },

    async listDeletedRequirements(projectId: string) {
      return requestJson<Requirement[]>(
        `${baseUrl}/api/projects/${projectId}/requirements/deleted`,
      )
    },

    async restoreRequirement(projectId: string, requirementId: string) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/restore`,
        { method: 'POST' },
      )
    },

    async purgeRequirement(projectId: string, requirementId: string) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/purge`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Purging requirement ${requirementId} failed`)
      }
    },

    async reassignRequirementArchitectureElement(
      projectId: string,
      requirementId: string,
      architectureElement: string | null,
    ) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/architecture-element`,
        { method: 'PUT', body: JSON.stringify({ architectureElement }) },
      )
    },

    async addRequirementToElement(projectId: string, requirementId: string, elementId: string) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/architecture-elements`,
        { method: 'POST', body: JSON.stringify({ elementId }) },
      )
    },

    async removeRequirementFromElement(projectId: string, requirementId: string, elementId: string) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/architecture-elements/${elementId}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Removing element ${elementId} from requirement ${requirementId} failed`)
      }
      return response.json() as Promise<Requirement>
    },

    async setRequirementStatus(projectId: string, requirementId: string, status: RequirementStatus) {
      return requestJson<Requirement>(
        `${baseUrl}/api/projects/${projectId}/requirements/${requirementId}/status`,
        { method: 'PUT', body: JSON.stringify({ status }) },
      )
    },

    async previewImportProject(projectId: string, options: ImportProjectPreviewOptions) {
      return requestJson<ImportProjectPreview>(
        `${baseUrl}/api/projects/${projectId}/import-project/preview`,
        { method: 'POST', body: JSON.stringify(options) },
      )
    },

    async saveImportProject(projectId: string) {
      return requestJson<ImportProjectPreview>(
        `${baseUrl}/api/projects/${projectId}/import-project/save`,
        { method: 'POST' },
      )
    },

    async discardPendingImport(projectId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/import-project/pending`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Discarding pending import for ${projectId} failed`)
      }
    },

    async estimateCodeGapScan(projectId: string, stripOptions?: CodeStripOptions) {
      const params = stripOptions
        ? '?' +
          new URLSearchParams({
            stripBlankLines: String(stripOptions.stripBlankLines),
            stripComments: String(stripOptions.stripComments),
            stripBodies: String(stripOptions.stripBodies),
          }).toString()
        : ''
      return requestJson<CodeGapScanTokenEstimate>(
        `${baseUrl}/api/projects/${projectId}/scan-code-gaps/estimate${params}`,
      )
    },

    async scanCodeGaps(projectId: string, options?: ScanCodeGapsOptions) {
      return requestJson<ScanCodeGapsResult>(`${baseUrl}/api/projects/${projectId}/scan-code-gaps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options ?? { content: 'complete', mode: 'single-call' }),
      })
    },

    async acceptImportedRequirements(
      projectId: string,
      texts: string[],
      provenance: RequirementProvenance,
    ) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/import-codebase/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, provenance }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Accepting imported requirements for ${projectId} failed`)
      }
      return response.json() as Promise<Requirement[]>
    },

    async listArchitectureTypes() {
      return requestJson<ArchitectureTypeOption[]>(`${baseUrl}/api/architecture-types`)
    },

    async getArchitectureType(projectId: string) {
      return requestJson<ArchitectureTypeId | null>(
        `${baseUrl}/api/projects/${projectId}/architecture-type`,
      )
    },

    async setArchitectureType(projectId: string, typeId: ArchitectureTypeId) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/architecture-type`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typeId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Setting architecture type for ${projectId} failed`)
      }
    },

    async listPlatforms() {
      return requestJson<PlatformDescriptor[]>(`${baseUrl}/api/platforms`)
    },

    async addCustomPlatform(fields) {
      const response = await fetch(`${baseUrl}/api/platforms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Adding custom platform failed')
      }
      return response.json() as Promise<PlatformDescriptor>
    },

    async deleteCustomPlatform(platformId: string) {
      const response = await fetch(`${baseUrl}/api/platforms/${encodeURIComponent(platformId)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Deleting custom platform failed')
      }
    },

    async getProjectPlatform(projectId: string) {
      return requestJson<PlatformId | null>(`${baseUrl}/api/projects/${projectId}/platform`)
    },

    async setProjectPlatform(projectId: string, platformId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/platform`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platformId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Setting platform for ${projectId} failed`)
      }
      return (await response.json()) as {
        platform: string
        harnessSpecDerived: boolean
        harnessSpecError?: string
      }
    },

    async branchProjectPlatform(projectId: string, platformId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/branch-platform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platformId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Branching project ${projectId} failed`)
      }
      return response.json() as Promise<{
        originalProject: { id: string; name: string }
        newProject: { id: string; name: string }
      }>
    },

    async defineHarness(projectId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/architecture/harness/define`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Defining harness for ${projectId} failed`)
      }
      return (await response.json()).harnessSpec as HarnessSpec
    },

    async getArchitecture(projectId: string) {
      return requestJson<Architecture | null>(`${baseUrl}/api/projects/${projectId}/architecture`)
    },

    async createArchitectureElement(projectId: string, fields: CreateArchitectureElementFields) {
      return requestJson<ArchitectureElement>(
        `${baseUrl}/api/projects/${projectId}/architecture/elements`,
        { method: 'POST', body: JSON.stringify(fields) },
      )
    },

    async updateArchitectureElement(
      projectId: string,
      elementId: string,
      fields: UpdateArchitectureElementFields,
    ) {
      return requestJson<ArchitectureElement>(
        `${baseUrl}/api/projects/${projectId}/architecture/elements/${elementId}`,
        { method: 'PUT', body: JSON.stringify(fields) },
      )
    },

    async deleteArchitectureElement(projectId: string, elementId: string) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/architecture/elements/${elementId}`,
        { method: 'DELETE' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Deleting architecture element ${elementId} failed`)
      }
    },

    async addArchitectureLayer(projectId: string, label: string) {
      return requestJson<Architecture>(`${baseUrl}/api/projects/${projectId}/architecture/layers`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      })
    },

    async removeArchitectureLayer(projectId: string, rowIndex: number) {
      return requestJson<Architecture>(
        `${baseUrl}/api/projects/${projectId}/architecture/layers/${rowIndex}`,
        { method: 'DELETE' },
      )
    },

    async checkArchitectureConflicts(projectId: string) {
      try {
        currentOperation = { text: 'Architect is checking for conflicts...' }
        const result = await requestJson<{ conflicts: ArchitectureConflict[] }>(
          `${baseUrl}/api/projects/${projectId}/architecture/check-conflicts`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result.conflicts
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async autoConfigureAndAllocate(projectId: string) {
      try {
        currentOperation = { text: 'Architect is grouping requirements into modules...' }
        const result = await requestJson<AutoConfigureAndAllocateResult>(
          `${baseUrl}/api/projects/${projectId}/architecture/auto-configure`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async autoAllocate(projectId: string, mode: 'llm') {
      try {
        currentOperation = {
          text: 'Architect is allocating requirements...',
        }
        const result = await requestJson<AutoAllocateResult>(
          `${baseUrl}/api/projects/${projectId}/architecture/auto-allocate`,
          { method: 'POST', body: JSON.stringify({ mode }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async architectChat(projectId: string, message: string, sessionId?: string) {
      try {
        currentOperation = { text: 'Architect is thinking...' }
        const result = await requestJson<ArchitectChatResult>(
          `${baseUrl}/api/projects/${projectId}/architecture/chat`,
          { method: 'POST', body: JSON.stringify({ message, sessionId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async acceptProposedArchitectureElement(
      projectId: string,
      fields: { kind: ArchitectureElementKind; name: string; layer: string; responsibility: string },
    ) {
      return requestJson<ArchitectureElement>(
        `${baseUrl}/api/projects/${projectId}/architecture/elements/from-proposal`,
        { method: 'POST', body: JSON.stringify(fields) },
      )
    },

    async acceptProposedArchitectureInterface(projectId: string, fromId: string, toId: string) {
      return requestJson<ArchitectureElement>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces/from-proposal`,
        { method: 'POST', body: JSON.stringify({ fromId, toId }) },
      )
    },

    async removeArchitectureInterface(projectId: string, fromId: string, toId: string) {
      return requestJson<ArchitectureElement>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces`,
        { method: 'DELETE', body: JSON.stringify({ fromId, toId }) },
      )
    },

    async checkArchitectureInterfaceConflict(projectId: string, fromId: string, toId: string) {
      try {
        currentOperation = { text: 'Architect is checking the interface...' }
        const result = await requestJson<{ conflict: ArchitectureConflict | null }>(
          `${baseUrl}/api/projects/${projectId}/architecture/interfaces/check-conflict`,
          { method: 'POST', body: JSON.stringify({ fromId, toId }) },
        )
        currentOperation = { text: null }
        return result.conflict
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async defineArchitectureInterfaceDefinition(projectId: string, fromId: string, toId: string) {
      try {
        currentOperation = { text: 'Architect is defining the interface...' }
        const result = await requestJson<{ definition: InterfaceDefinition }>(
          `${baseUrl}/api/projects/${projectId}/architecture/interfaces/define`,
          { method: 'POST', body: JSON.stringify({ fromId, toId }) },
        )
        currentOperation = { text: null }
        return result.definition
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async setArchitectureInterfaceDefinition(
      projectId: string,
      definitionId: string | undefined,
      name: string,
      participants: Array<{ elementId: string; role: InterfaceRole }>,
      operations: InterfaceContractOperation[],
    ) {
      const result = await requestJson<{ definition: InterfaceDefinition }>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces`,
        { method: 'PUT', body: JSON.stringify({ definitionId, name, participants, operations }) },
      )
      return result.definition
    },

    async reconcileArchitectureElementInterface(
      projectId: string,
      definitionId: string,
      elementId: string,
      operations: InterfaceContractOperation[],
    ) {
      const result = await requestJson<{ elementInterface: ElementInterfaceDefinition }>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces/${definitionId}/reconcile`,
        { method: 'PUT', body: JSON.stringify({ elementId, operations }) },
      )
      return result.elementInterface
    },

    async defineAllArchitectureInterfaceDefinitions(projectId: string, force = false) {
      try {
        currentOperation = { text: force ? 'Architect is redefining all interfaces...' : 'Architect is defining interfaces...' }
        const result = await requestJson<{ definitions: InterfaceDefinition[] }>(
          `${baseUrl}/api/projects/${projectId}/architecture/interfaces/define-all`,
          { method: 'POST', body: JSON.stringify({ force }) },
        )
        currentOperation = { text: null }
        return result.definitions
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async checkArchitectureInterfaces(projectId: string) {
      return requestJson<CheckInterfacesResult>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces/check`,
        { method: 'POST' },
      )
    },

    async checkArchitectureInterfaceCodeAlignment(projectId: string) {
      return requestJson<CheckInterfaceCodeAlignmentResult>(
        `${baseUrl}/api/projects/${projectId}/architecture/interfaces/check-code-alignment`,
        { method: 'POST' },
      )
    },

    async analyzeCodeAlignment(projectId: string) {
      try {
        currentOperation = { text: 'Architect is analysing code alignment...' }
        const result = await requestJson<{ codeAlignment: CodeAlignmentRecord }>(
          `${baseUrl}/api/projects/${projectId}/analyze-code-alignment`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result.codeAlignment
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async scaffoldSourceTree(projectId: string) {
      return requestJson<{ createdFolders: string[] }>(`${baseUrl}/api/projects/${projectId}/coding/scaffold`, {
        method: 'POST',
      })
    },

    async listCodingRuns(projectId: string) {
      return requestJson<CodingRun[]>(`${baseUrl}/api/projects/${projectId}/coding/runs`)
    },

    async getCodingRun(projectId: string, runId: string) {
      return requestJson<CodingRun>(`${baseUrl}/api/projects/${projectId}/coding/runs/${runId}`)
    },

    // Element-scoped Coding — every Coding run always targets exactly one
    // architecture element's own folder.
    async runCoding(
      projectId: string,
      architectureElementId: string,
      runToken: string,
      recode?: boolean,
      fromScratch?: boolean,
    ) {
      try {
        currentOperation = {
          text: `${fromScratch ? 'Recoding from scratch' : recode ? 'Recoding' : 'Coding'} ${architectureElementId}...`,
        }
        const result = await requestJson<{ codingRun: CodingRun }>(
          `${baseUrl}/api/projects/${projectId}/architecture/elements/${architectureElementId}/run-coding`,
          {
            method: 'POST',
            body: JSON.stringify({
              runToken,
              ...(recode ? { recode: true } : {}),
              ...(fromScratch ? { fromScratch: true } : {}),
            }),
          },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async analyzeElementCode(projectId: string, architectureElementId: string) {
      try {
        currentOperation = { text: `Analysing code for ${architectureElementId}...` }
        const result = await requestJson<{ coverage: ElementRequirementCoverage[] }>(
          `${baseUrl}/api/projects/${projectId}/architecture/elements/${architectureElementId}/analyze-code`,
          { method: 'POST', body: JSON.stringify({}) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async getCodingRunLog(runToken: string) {
      // cache: 'no-store' is required here — this is polled every ~1.5s at
      // the same URL while the response body keeps changing, but Express's
      // default ETag on a JSON response can momentarily match between two
      // polls (e.g. two consecutive empty-log responses before the first
      // chunk arrives), and the browser then serves a 304 with the
      // *cached* (stale) body instead of fetching fresh content — silently
      // freezing the live log at whatever it last showed.
      return requestJson<{ text: string; done: boolean; msSinceLastActivity: number }>(
        `${baseUrl}/api/coding/runs/${runToken}/log`,
        { cache: 'no-store' },
      )
    },

    async getCodingRunLock(projectId: string) {
      return requestJson<{
        locked: boolean
        architectureElementId?: string
        userId?: string
        startedAt?: number
      }>(`${baseUrl}/api/projects/${projectId}/coding/run-lock`, { cache: 'no-store' })
    },

    async cancelCodingRun(projectId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/coding/run-lock`, { method: 'DELETE' })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Cancelling the Coding run failed')
      }
    },

    async getCodingConventions(projectId: string) {
      const result = await requestJson<{ conventions: string }>(
        `${baseUrl}/api/projects/${projectId}/coding-conventions`,
      )
      return result.conventions
    },

    async setCodingConventions(projectId: string, text: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/coding-conventions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conventions: text }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Setting coding conventions failed')
      }
    },

    async getProjectOverview(projectId: string) {
      return requestJson<{ description: string; runInstructions: string }>(
        `${baseUrl}/api/projects/${projectId}/overview`,
      )
    },

    async setProjectOverview(projectId: string, description: string, runInstructions: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/overview`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, runInstructions }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Setting project overview failed')
      }
    },

    async autoPopulateProjectOverview(projectId: string) {
      try {
        currentOperation = { text: 'Architect is drafting the project overview...' }
        const result = await requestJson<{ description: string; runInstructions: string }>(
          `${baseUrl}/api/projects/${projectId}/overview/auto-populate`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async getSourceTree(projectId: string) {
      return requestJson<{ root: string; files: Array<{ path: string; size: number }> }>(
        `${baseUrl}/api/projects/${projectId}/source-tree`,
      )
    },

    sourceFileUrl(projectId: string, relativePath: string) {
      return `${baseUrl}/api/projects/${projectId}/source-tree/file?path=${encodeURIComponent(relativePath)}`
    },

    // URL of the generated project served as a runnable site (Run Local
    // preview) — ES modules load over http here, unlike a file:// open.
    previewUrl(projectId: string) {
      return `${baseUrl}/preview/${encodeURIComponent(projectId)}/`
    },

    async downloadSourceTree(projectId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/source-tree/download`)
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Downloading source tree for project ${projectId} failed`)
      }
      const blob = await response.blob()
      const filename = filenameFromContentDisposition(response.headers.get('Content-Disposition'))
      return { blob, filename }
    },

    async getTestSuite(projectId: string) {
      return requestJson<TestSuite | null>(`${baseUrl}/api/projects/${projectId}/test-suite`)
    },

    async getTestScopeReadiness(projectId: string) {
      return requestJson<ScopeReadinessEntry[]>(`${baseUrl}/api/projects/${projectId}/test-suite/readiness`)
    },

    async getPhaseReadiness(projectId: string) {
      return requestJson<{ statuses: Record<PhaseId, Status>; blockers: PhaseBlocker[] }>(
        `${baseUrl}/api/projects/${projectId}/phase-readiness`,
      )
    },

    async createTestCase(projectId: string, fields: CreateTestCaseFields) {
      return requestJson<{ testCase: TestCase | null; rejected?: TraceabilityRejectionReason }>(
        `${baseUrl}/api/projects/${projectId}/test-suite/tests`,
        { method: 'POST', body: JSON.stringify(fields) },
      )
    },

    async updateTestCase(projectId: string, testId: string, fields: UpdateTestCaseFields) {
      return requestJson<TestCase>(`${baseUrl}/api/projects/${projectId}/test-suite/tests/${testId}`, {
        method: 'PUT',
        body: JSON.stringify(fields),
      })
    },

    async deleteTestCase(projectId: string, testId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/test-suite/tests/${testId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Deleting test case ${testId} failed`)
      }
    },

    async generateFunctionalTests(projectId: string, architectureElementId: string) {
      try {
        currentOperation = { text: 'QA is proposing functional tests...' }
        const result = await requestJson<{ tests: TestCase[]; rejected: RejectedProposal[] }>(
          `${baseUrl}/api/projects/${projectId}/test-suite/generate-functional`,
          { method: 'POST', body: JSON.stringify({ architectureElementId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async generateIntegrationTests(projectId: string, fromId: string, toId: string) {
      try {
        currentOperation = { text: 'QA is proposing integration tests...' }
        const result = await requestJson<{ tests: TestCase[]; rejected: RejectedProposal[] }>(
          `${baseUrl}/api/projects/${projectId}/test-suite/generate-integration`,
          { method: 'POST', body: JSON.stringify({ fromId, toId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async generateAllTests(projectId: string) {
      try {
        currentOperation = { text: 'QA is proposing tests...' }
        const result = await requestJson<{ tests: TestCase[]; rejected: RejectedProposal[] }>(
          `${baseUrl}/api/projects/${projectId}/test-suite/generate-all`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async generateTestFile(projectId: string, testId: string) {
      try {
        currentOperation = { text: `QA is writing the test file for ${testId}...` }
        const result = await requestJson<{
          status: 'success' | 'rejected-scope' | 'rejected-multi-element' | 'cli-error'
          testCase: TestCase
          diff: string
          rawLog: string
          rejectedFiles?: string[]
        }>(`${baseUrl}/api/projects/${projectId}/test-suite/tests/${testId}/generate-file`, { method: 'POST' })
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async testCreationChat(projectId: string, architectureElementId: string | null, message: string, sessionId?: string) {
      try {
        currentOperation = { text: 'QA is thinking...' }
        const result = await requestJson<TestCreationChatResult>(
          `${baseUrl}/api/projects/${projectId}/test-suite/chat`,
          { method: 'POST', body: JSON.stringify({ architectureElementId, message, sessionId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async acceptProposedTest(projectId: string, proposal: ProposedTest, architectureElementId: string | null) {
      return requestJson<TestCase>(
        `${baseUrl}/api/projects/${projectId}/test-suite/tests/from-proposal`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: proposal.title,
            requirementIds: proposal.requirementIds,
            architectureElementId,
          }),
        },
      )
    },

    async getImportedTestCases(projectId: string) {
      return requestJson<ImportedTestCaseSet | null>(`${baseUrl}/api/projects/${projectId}/imported-test-cases`)
    },

    async importLegacyTestCases(projectId: string, folderPath: string) {
      try {
        currentOperation = { text: 'Analyzing legacy test files...' }
        const result = await requestJson<{ imported: ImportedTestCase[] }>(
          `${baseUrl}/api/projects/${projectId}/imported-test-cases/import`,
          { method: 'POST', body: JSON.stringify({ folderPath }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async deleteImportedTestCase(projectId: string, testId: string) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/imported-test-cases/${testId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Deleting imported test case ${testId} failed`)
      }
    },

    async listTestRuns(projectId: string) {
      return requestJson<TestRun[]>(`${baseUrl}/api/projects/${projectId}/test-runs`)
    },

    async getTestRun(projectId: string, runId: string) {
      return requestJson<TestRun>(`${baseUrl}/api/projects/${projectId}/test-runs/${runId}`)
    },

    async listTestRegressionRuns(projectId: string) {
      return requestJson<TestRegressionRun[]>(`${baseUrl}/api/projects/${projectId}/test-regression-runs`)
    },

    async runElementTests(projectId: string, scope: TestCommandScope, only?: 'requirement' | 'sw') {
      try {
        currentOperation = { text: 'Running tests...' }
        const result = await requestJson<{ testRun: TestRun }>(
          `${baseUrl}/api/projects/${projectId}/test-suite/run-element`,
          { method: 'POST', body: JSON.stringify(only ? { ...scope, only } : scope) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async runFullRegression(projectId: string) {
      try {
        currentOperation = { text: 'Running full regression...' }
        const result = await requestJson<{ regressionRun: TestRegressionRun }>(
          `${baseUrl}/api/projects/${projectId}/test-suite/run-regression`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async triageTestFailure(projectId: string, runId: string, testCaseId: string) {
      try {
        currentOperation = { text: 'QA is triaging the failing test...' }
        const result = await requestJson<{ triage: TestOutcomeTriage; triageRationale?: string }>(
          `${baseUrl}/api/projects/${projectId}/test-runs/${runId}/outcomes/${testCaseId}/triage`,
          { method: 'POST' },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async confirmTestCaseFailure(projectId: string, runId: string, testCaseId: string) {
      const response = await fetch(
        `${baseUrl}/api/projects/${projectId}/test-runs/${runId}/outcomes/${testCaseId}/confirm-test-case-failure`,
        { method: 'POST' },
      )
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Confirming test-case-failure failed')
      }
    },

    async testExecutionChat(
      projectId: string,
      testCaseId: string | null,
      runId: string | null,
      message: string,
      sessionId?: string,
    ) {
      try {
        currentOperation = { text: 'QA is thinking...' }
        const result = await requestJson<TestExecutionChatResult>(
          `${baseUrl}/api/projects/${projectId}/test-runs/chat`,
          { method: 'POST', body: JSON.stringify({ testCaseId, runId, message, sessionId }) },
        )
        currentOperation = { text: null }
        return result
      } catch (err) {
        currentOperation = toOperationError(err)
        throw err
      }
    },

    async listChatSessions(projectId: string, surface: ChatSurface, includeArchived?: boolean) {
      const qs = new URLSearchParams({ surface })
      if (includeArchived) qs.set('includeArchived', '1')
      return requestJson<ChatSession[]>(`${baseUrl}/api/projects/${projectId}/chat-sessions?${qs.toString()}`)
    },

    async createChatSession(projectId: string, surface: ChatSurface, focus?: ChatSessionFocus, title?: string) {
      return requestJson<ChatSession>(`${baseUrl}/api/projects/${projectId}/chat-sessions`, {
        method: 'POST',
        body: JSON.stringify({ surface, focus, title }),
      })
    },

    async updateChatSession(
      projectId: string,
      sessionId: string,
      updates: { title?: string; focus?: ChatSessionFocus; archivedAt?: string | null },
    ) {
      return requestJson<ChatSession>(`${baseUrl}/api/projects/${projectId}/chat-sessions/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      })
    },

    async deleteChatSession(projectId: string, sessionId: string) {
      await requestJson<void>(`${baseUrl}/api/projects/${projectId}/chat-sessions/${sessionId}`, { method: 'DELETE' })
    },

    async generateMigrationPlan(projectId: string) {
      const result = await requestJson<{ migrationPlan: MigrationPlanRecord }>(
        `${baseUrl}/api/projects/${projectId}/generate-migration-plan`,
        { method: 'POST' },
      )
      return result.migrationPlan
    },

    async updateProjectSettings(
      projectId: string,
      updates: Partial<Pick<ProjectSettings, 'phaseTabGating' | 'unitTestMode'>>,
    ) {
      const persisted = await requestJson<Partial<ProjectSettings>>(
        `${baseUrl}/api/projects/${projectId}/settings`,
        { method: 'PUT', body: JSON.stringify(updates) },
      )
      return { ...defaultSettings, ...persisted }
    },

    async listPluginSettings() {
      return requestJson<PluginSettings[]>(`${baseUrl}/api/settings/plugins`)
    },

    async savePluginSettings(pluginId: string, values: Record<string, string>) {
      const response = await fetch(`${baseUrl}/api/settings/plugins/${pluginId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Saving settings for ${pluginId} failed`)
      }
    },

    async checkPluginStatus(pluginId: string) {
      return requestJson<PluginInstallStatus>(`${baseUrl}/api/settings/plugins/${pluginId}/status`)
    },

    async getPluginUsage(pluginId: string) {
      return requestJson<PluginUsage>(`${baseUrl}/api/settings/plugins/${pluginId}/usage`)
    },

    async getStorageInfo() {
      return requestJson<StorageInfo>(`${baseUrl}/api/system/storage`)
    },

    async setProjectsRootOverride(projectsRootOverride: string | null) {
      const response = await fetch(`${baseUrl}/api/system/storage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectsRootOverride }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Saving storage folder setting failed')
      }
    },

    async listProjectParts() {
      return PROJECT_PARTS
    },

    async exportProjectParts(projectId: string, partIds: ProjectPartId[]) {
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partIds }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Exporting project ${projectId} failed`)
      }
      const blob = await response.blob()
      const filename = filenameFromContentDisposition(response.headers.get('Content-Disposition'))
      return { blob, filename }
    },

    async importProjectParts(projectId: string, partIds: ProjectPartId[], file: Blob) {
      const query = new URLSearchParams({ partIds: partIds.join(',') })
      const response = await fetch(`${baseUrl}/api/projects/${projectId}/import?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Importing into project ${projectId} failed`)
      }
      const result = await response.json()
      return result.importedCounts as Partial<Record<ProjectPartId, number>>
    },

    async listPersonaSettings() {
      return requestJson<{ admin?: PersonaSettings[]; user: PersonaSettings[] }>(
        `${baseUrl}/api/settings/personas`,
      )
    },

    async savePersonaSettings(
      scope: PersonaScope,
      personaId: string,
      values: Record<string, string>,
      pluginId?: string,
      agentValues?: Record<string, string>,
      agentPluginId?: string,
    ) {
      const requestBody: Record<string, unknown> = { scope, values }
      if (pluginId !== undefined) requestBody.pluginId = pluginId
      if (agentValues !== undefined) requestBody.agentValues = agentValues
      if (agentPluginId !== undefined) requestBody.agentPluginId = agentPluginId
      const response = await fetch(`${baseUrl}/api/settings/personas/${personaId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(currentUserId ? { 'X-VIC-User': currentUserId } : {}),
        },
        body: JSON.stringify(requestBody),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? `Saving settings for ${personaId} failed`)
      }
    },

    async autoAdoptRecommendedModels(scope: PersonaScope) {
      const response = await fetch(`${baseUrl}/api/settings/personas/auto-adopt`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(currentUserId ? { 'X-VIC-User': currentUserId } : {}),
        },
        body: JSON.stringify({ scope }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error ?? 'Auto-adopting recommended models failed')
      }
      return response.json() as Promise<{
        applied: Array<{ personaId: string; pluginId: string; values: Record<string, string> }>
      }>
    },
  }
}
