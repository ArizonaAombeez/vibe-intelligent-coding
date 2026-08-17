import { useEffect, useState } from 'react'
import type { CurrentOperation, PluginUsage, Status, TokenUsage } from '../api/types'
import { STATUS_COLOR, STATUS_LABEL } from '../statusColor'
import './StatusStrip.css'

interface StatusStripProps {
  currentOperation: CurrentOperation
  projectStatus: Status
  tokenUsage: TokenUsage
  // Keyed by plugin id. See App.tsx's polling effect — only plugins that
  // successfully reported usage appear here.
  pluginUsage: Record<string, { label: string; usage: PluginUsage }>
  onRetry: () => void
  onOpenSettings: () => void
}

// Formats the time remaining until an ISO timestamp as a short countdown
// ("2h 14m", "38m", "<1m"). Returns null once it's passed — a stale
// countdown reading "-5m" is more confusing than just hiding it, and the
// next poll (see PLUGIN_USAGE_POLL_INTERVAL_MS in App.tsx) will bring back
// a fresh window shortly after the real reset happens.
function formatResetCountdown(resetsAt: string | undefined, now: number): string | null {
  if (!resetsAt) return null
  const remainingMs = new Date(resetsAt).getTime() - now
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null
  const totalMinutes = Math.ceil(remainingMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0 && minutes === 0) return '<1m'
  if (hours === 0) return `${minutes}m`
  return `${hours}h ${minutes}m`
}

function PluginUsageBadge({ label, usage, now }: { label: string; usage: PluginUsage; now: number }) {
  const windows: Array<{ key: string; shortLabel: string; percentUsed: number; resetsAt?: string }> = []
  if (usage.currentWindow) {
    windows.push({ key: 'current', shortLabel: '5h', percentUsed: usage.currentWindow.percentUsed, resetsAt: usage.currentWindow.resetsAt })
  }
  if (usage.weekly) {
    windows.push({ key: 'weekly', shortLabel: '7d', percentUsed: usage.weekly.percentUsed, resetsAt: usage.weekly.resetsAt })
  }
  if (windows.length === 0) return null
  return (
    <span className="status-strip-plugin-usage" title={`${label} usage`}>
      <span className="status-strip-plugin-usage-label">{label}</span>
      {windows.map((w) => {
        const countdown = formatResetCountdown(w.resetsAt, now)
        return (
          <span key={w.key} className="status-strip-usage-window">
            {w.shortLabel} {Math.round(w.percentUsed)}%
            {countdown ? <span className="status-strip-usage-reset"> (resets in {countdown})</span> : null}
          </span>
        )
      })}
    </span>
  )
}

export function StatusStrip({
  currentOperation,
  projectStatus,
  tokenUsage,
  pluginUsage,
  onRetry,
  onOpenSettings,
}: StatusStripProps) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // Ticks the countdown labels once a minute — coarser than a per-second
    // clock since the displayed granularity is already minutes, and this
    // avoids a re-render cadence with no visible effect on the text shown.
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const busy = currentOperation.text != null
  const hasError = !!currentOperation.error
  const stripState = hasError ? 'error' : busy ? 'busy' : 'idle'
  return (
    <div className={`status-strip status-strip-${stripState}`}>
      <div className="status-strip-row operation">
        {currentOperation.error ? (
          <>
            <span className="status-strip-dot" style={{ background: 'var(--status-red)' }} />
            <span className="operation-error">{currentOperation.error}</span>
            {currentOperation.errorCode === 'llm-not-configured' ? (
              <button type="button" className="retry-button" onClick={onOpenSettings}>
                Open Settings
              </button>
            ) : (
              <button type="button" className="retry-button" onClick={onRetry}>
                Retry
              </button>
            )}
          </>
        ) : (
          <>
            <span
              className={`status-strip-dot ${busy ? 'status-strip-dot-busy' : ''}`}
              style={{ background: busy ? 'var(--status-amber)' : 'var(--status-grey)' }}
            />
            <span className={busy ? 'operation-text-busy' : 'operation-text'}>
              {currentOperation.text ?? 'Idle'}
            </span>
          </>
        )}
      </div>
      <div className="status-strip-row project">
        <span
          className="status-strip-dot"
          style={{ background: STATUS_COLOR[projectStatus] }}
        />
        <span>Project status: {STATUS_LABEL[projectStatus]}</span>
        <span
          className="status-strip-token-usage"
          title="Running total across this session (estimated). Accumulated from the LLM API when the server reports it."
        >
          ~{tokenUsage.totalTokens.toLocaleString()} tokens · ~$
          {tokenUsage.estimatedCostUsd.toFixed(2)}
        </span>
        {Object.entries(pluginUsage).map(([pluginId, { label, usage }]) => (
          <PluginUsageBadge key={pluginId} label={label} usage={usage} now={now} />
        ))}
      </div>
    </div>
  )
}
