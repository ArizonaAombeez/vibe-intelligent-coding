import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ArchitectureTypeId,
  CurrentOperation,
  OpenProjectResult,
  PhaseId,
  PluginUsage,
  ProjectMode,
  TokenUsage,
  VicCoreApi,
  VicUser,
} from './api/types'
import { createHttpApi, setCurrentUserIdForApi } from './api/httpApi'
import { pendingNavForLink, type PendingChatNav } from './navigation/chatLinkNav'
import type { ChatMessageLink } from './api/types'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { StatusStrip } from './components/StatusStrip'
import { LandingScreen } from './components/LandingScreen'
import { LoginScreen } from './components/LoginScreen'
import { UserBadge } from './components/UserBadge'
import { DashboardScreen } from './screens/DashboardScreen'
import { PhasePlaceholder } from './screens/PhasePlaceholder'
import { RequirementsScreen } from './screens/RequirementsScreen'
import { ArchitectureScreen } from './screens/ArchitectureScreen'
import { CodingScreen } from './screens/CodingScreen'
import { TestCreationScreen } from './screens/TestCreationScreen'
import { TestExecutionScreen } from './screens/TestExecutionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { ImportExportDialog } from './components/ImportExportDialog'
import './App.css'

// No mock fallback: an unset/unreachable API is a real "backend offline"
// state the UI surfaces explicitly (see LandingScreen), not something to
// paper over with fake data — a silent mock made a genuinely offline
// backend indistinguishable from "no projects yet".
//
// Falls back to the page's own hostname (not a hardcoded 'localhost') so
// the same build works whether it's opened on the server machine or by
// another machine on the LAN — VIC is remote-only, so a client loading the
// UI from e.g. http://192.168.1.50:5173 should talk to the API on that same
// host, not the client's own loopback address.
const API_BASE_URL =
  (import.meta.env.VITE_VIC_API_URL as string | undefined) ??
  `http://${window.location.hostname}:3001`

const SIDEBAR_COLLAPSE_WIDTH = 760

// VIC is remote-only and shared across a team, so the app gates on a
// name-only login (see LoginScreen/usersStore.ts) before showing any
// project content. No password, no server session — this key just lets a
// returning browser skip the picker; identity/attribution only.
const CURRENT_USER_STORAGE_KEY = 'vic-current-user'

function loadStoredUser(): VicUser | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_USER_STORAGE_KEY)
    return raw ? (JSON.parse(raw) as VicUser) : null
  } catch {
    return null
  }
}

// How often the status bar re-polls provider rate-limit/quota usage. This
// is an account-wide figure the provider tracks server-side, not something
// that changes with every VIC action — a few minutes' staleness is fine,
// and polling faster would just add load for no visible benefit.
const PLUGIN_USAGE_POLL_INTERVAL_MS = 60_000

interface AppProps {
  api?: VicCoreApi
}

function App({ api: injectedApi }: AppProps) {
  const api = useMemo(() => injectedApi ?? createHttpApi(API_BASE_URL), [injectedApi])

  const [currentUser, setCurrentUser] = useState<VicUser | null>(loadStoredUser)
  // Keeps httpApi's X-VIC-User header in sync with whoever's logged in —
  // this has to be an effect (not inlined into handleLogIn/handleLogOut)
  // because currentUser can also change via the re-sync effect below (a
  // stale isAdmin refreshed from the server) or start already set from
  // loadStoredUser on a page reload, neither of which goes through
  // handleLogIn.
  useEffect(() => {
    setCurrentUserIdForApi(currentUser?.id ?? null)
  }, [currentUser])
  const [project, setProject] = useState<OpenProjectResult | null>(null)
  const [activePhase, setActivePhase] = useState<PhaseId>('dashboard')
  const [activeSubstep, setActiveSubstep] = useState<string | null>(null)
  // Set when a chat link chip is clicked — switches the phase tab and is
  // handed to the destination screen, which applies it to its own local
  // selection then calls onChatNavConsumed to clear it. Screens ignore a
  // pending nav whose kind isn't theirs.
  const [pendingChatNav, setPendingChatNav] = useState<PendingChatNav | null>(null)
  const [architectureType, setArchitectureType] = useState<ArchitectureTypeId | null>(null)
  const [currentOperation, setCurrentOperation] = useState<CurrentOperation>({ text: null })
  const [sidebarNarrow, setSidebarNarrow] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importExportOpen, setImportExportOpen] = useState(false)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage>({ totalTokens: 0, estimatedCostUsd: 0 })
  // Keyed by plugin id, one entry per installed plugin that successfully
  // reported usage. A plugin that 501s (no usage concept, e.g. a future
  // provider) or fails the lookup (network error, expired credentials)
  // simply never gets an entry — the status bar shows whatever succeeded
  // rather than an error per provider.
  const [pluginUsage, setPluginUsage] = useState<Record<string, { label: string; usage: PluginUsage }>>({})

  const handleLogIn = useCallback((user: VicUser) => {
    window.localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(user))
    setCurrentUser(user)
  }, [])

  // Also closes out whatever project was open — a returning/different user
  // shouldn't land back inside the previous person's open project.
  const handleLogOut = useCallback(() => {
    window.localStorage.removeItem(CURRENT_USER_STORAGE_KEY)
    setCurrentUser(null)
    setProject(null)
  }, [])

  useEffect(() => {
    const onResize = () => setSidebarNarrow(window.innerWidth < SIDEBAR_COLLAPSE_WIDTH)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A user picked up from localStorage was a snapshot at login time — if
  // the server's record for them has since changed (e.g. isAdmin flipped
  // because ADMIN_NAMES changed, or this browser's stored copy predates a
  // field being added at all), re-sync against the server's current list
  // once on load rather than trusting the stale snapshot indefinitely. If
  // the stored user no longer exists server-side, log out back to the
  // picker instead of silently operating as a ghost user.
  const currentUserId = currentUser?.id
  useEffect(() => {
    if (!currentUserId) return
    api
      .listUsers()
      .then((users) => {
        const fresh = users.find((u) => u.id === currentUserId)
        if (!fresh) {
          handleLogOut()
          return
        }
        // Functional update + a shallow-equal short-circuit so this only
        // ever writes when something actually changed, even though the
        // effect itself only re-runs when currentUserId changes.
        setCurrentUser((prev) => {
          if (prev && prev.isAdmin === fresh.isAdmin && prev.name === fresh.name) return prev
          window.localStorage.setItem(CURRENT_USER_STORAGE_KEY, JSON.stringify(fresh))
          return fresh
        })
      })
      .catch(() => {
        // Server unreachable — keep the stale snapshot rather than logging
        // the user out just because the sync check failed.
      })
  }, [api, currentUserId, handleLogOut])

  // Polls every installed plugin's rate-limit/quota usage for the status
  // bar. Only runs once a project is open — there's no point spending a
  // network round trip on the landing screen where the status bar isn't
  // shown at all.
  useEffect(() => {
    if (!project) {
      setPluginUsage({})
      return
    }
    let cancelled = false
    const poll = async () => {
      const plugins = await api.listPluginSettings().catch(() => [])
      const results = await Promise.all(
        plugins.map(async (plugin) => {
          const usage = await api.getPluginUsage(plugin.id).catch(() => null)
          return usage ? ([plugin.id, { label: plugin.label, usage }] as const) : null
        }),
      )
      if (cancelled) return
      setPluginUsage(Object.fromEntries(results.filter((r): r is NonNullable<typeof r> => r !== null)))
    }
    poll()
    const timer = setInterval(poll, PLUGIN_USAGE_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [api, project])

  const handleOperationChange = useCallback(
    (op: CurrentOperation) => {
      setCurrentOperation(op)
      // Any operation finishing (idle, success or error) is a point where an
      // LLM-backed call may have just completed — refresh the running token
      // usage total so the status bar stays current.
      if (op.text === null) {
        api.getTokenUsage().then(setTokenUsage)
      }
    },
    [api],
  )

  const handleOpenProject = useCallback(
    async (id: string) => {
      const result = await api.openProject(id)
      setProject(result)
      setArchitectureType(result.architectureType)
      setActivePhase('dashboard')
      setActiveSubstep(null)
    },
    [api],
  )

  const handleCreateProject = useCallback(
    async (name: string, mode?: ProjectMode) => {
      const result = await api.createProject(name, mode)
      setProject(result)
      setArchitectureType(result.architectureType)
      setActivePhase('dashboard')
      setActiveSubstep(null)
    },
    [api],
  )

  const handleCloseProject = useCallback(async () => {
    await api.closeProject()
    setProject(null)
  }, [api])

  const handleRenameProject = useCallback(
    async (name: string) => {
      if (!project) return
      await api.renameProject(project.projectId, name)
      setProject((prev) => (prev ? { ...prev, projectName: name } : prev))
    },
    [api, project],
  )

  const handleSelectPhase = useCallback((id: PhaseId) => {
    setActivePhase(id)
    setActiveSubstep(null)
  }, [])

  const handleChatNavigate = useCallback((link: ChatMessageLink) => {
    const nav = pendingNavForLink(link)
    setActivePhase(nav.phase as PhaseId)
    setActiveSubstep(null)
    setPendingChatNav(nav)
  }, [])

  const handleChatNavConsumed = useCallback(() => setPendingChatNav(null), [])

  const handleProjectSettingsChange = useCallback((settings: OpenProjectResult['settings']) => {
    setProject((prev) => (prev ? { ...prev, settings } : prev))
  }, [])

  if (!currentUser) {
    return <LoginScreen api={api} onLogIn={handleLogIn} />
  }

  if (!project) {
    return (
      <>
        <UserBadge user={currentUser} onLogOut={handleLogOut} />
        <LandingScreen
          api={api}
          onOpenProject={handleOpenProject}
          onCreateProject={handleCreateProject}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        {settingsOpen && (
          <SettingsScreen
            api={api}
            project={null}
            currentUser={currentUser}
            onProjectSettingsChange={handleProjectSettingsChange}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </>
    )
  }

  const activePhaseInfo = project.phases.find((p) => p.id === activePhase) ?? project.phases[0]
  const phaseTabsDisabled = project.settings.phaseTabGating === 'gated'
  const projectStatus =
    project.phases.find((p) => p.status === 'blocked')?.status ??
    project.phases.find((p) => p.status === 'in-progress')?.status ??
    'not-started'

  return (
    <div className="app-shell">
      <UserBadge user={currentUser} onLogOut={handleLogOut} />
      <TopBar
        phases={project.phases}
        activePhase={activePhase}
        onSelectPhase={handleSelectPhase}
        onReturnToProjectList={handleCloseProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImportExport={() => setImportExportOpen(true)}
        onOpenHelp={() => {}}
        phaseTabsDisabled={phaseTabsDisabled}
      />
      <div className="app-body">
        {activePhase !== 'architecture' && (
          <Sidebar
            substeps={activePhaseInfo.substeps}
            activeSubstep={activeSubstep}
            onSelectSubstep={setActiveSubstep}
            collapsed={sidebarNarrow}
          />
        )}
        <main className="app-main">
          {activePhase === 'dashboard' ? (
            <DashboardScreen
              api={api}
              projectId={project.projectId}
              projectName={project.projectName}
              phases={project.phases}
              onSelectPhase={handleSelectPhase}
              onRenameProject={handleRenameProject}
            />
          ) : activePhase === 'requirements' ? (
            <RequirementsScreen
              api={api}
              projectId={project.projectId}
              activeSubstep={activeSubstep}
              onOperationChange={handleOperationChange}
              architectureType={architectureType}
              onGoToArchitecture={() => handleSelectPhase('architecture')}
              onOpenSettings={() => setSettingsOpen(true)}
              projectMode={project.projectMode}
              importedCodePresent={project.importedCode !== undefined}
              onChatNavigate={handleChatNavigate}
              pendingChatNav={pendingChatNav}
              onChatNavConsumed={handleChatNavConsumed}
            />
          ) : activePhase === 'architecture' ? (
            <ArchitectureScreen
              api={api}
              projectId={project.projectId}
              phase={activePhaseInfo}
              activeSubstep={activeSubstep}
              onArchitectureTypeChange={setArchitectureType}
              onOperationChange={handleOperationChange}
              onOpenSettings={() => setSettingsOpen(true)}
              projectMode={project.projectMode}
              onChatNavigate={handleChatNavigate}
              pendingChatNav={pendingChatNav}
              onChatNavConsumed={handleChatNavConsumed}
            />
          ) : activePhase === 'test-creation' ? (
            <TestCreationScreen
              api={api}
              projectId={project.projectId}
              onOperationChange={handleOperationChange}
              settings={project.settings}
              onSettingsChange={handleProjectSettingsChange}
              onOpenSettings={() => setSettingsOpen(true)}
              onChatNavigate={handleChatNavigate}
            />
          ) : activePhase === 'coding' ? (
            <CodingScreen
              api={api}
              projectId={project.projectId}
              onOperationChange={handleOperationChange}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          ) : activePhase === 'test-execution' ? (
            <TestExecutionScreen
              api={api}
              projectId={project.projectId}
              onOperationChange={handleOperationChange}
              onOpenSettings={() => setSettingsOpen(true)}
              onChatNavigate={handleChatNavigate}
              pendingChatNav={pendingChatNav}
              onChatNavConsumed={handleChatNavConsumed}
            />
          ) : (
            <PhasePlaceholder phase={activePhaseInfo} activeSubstep={activeSubstep} />
          )}
        </main>
      </div>
      <StatusStrip
        currentOperation={currentOperation}
        projectStatus={projectStatus}
        tokenUsage={tokenUsage}
        pluginUsage={pluginUsage}
        onRetry={() => setCurrentOperation({ text: null })}
        onOpenSettings={() => {
          setCurrentOperation({ text: null })
          setSettingsOpen(true)
        }}
      />
      {settingsOpen && (
        <SettingsScreen
          api={api}
          project={project}
          currentUser={currentUser}
          onProjectSettingsChange={handleProjectSettingsChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {importExportOpen && (
        <ImportExportDialog
          api={api}
          projectId={project.projectId}
          onClose={() => setImportExportOpen(false)}
        />
      )}
    </div>
  )
}

export default App
