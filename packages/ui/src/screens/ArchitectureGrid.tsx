import { useEffect, useRef, useState } from 'react'
import * as d3 from 'd3'
import { EXTERNAL_CONTEXT_ROW, type Architecture, type ArchitectureElement, type ArchitectureElementKind, type Status } from '../api/types'
import { STATUS_COLOR } from '../statusColor'

interface ArchitectureGridProps {
  architecture: Architecture
  statusByElementId: Map<string, Status>
  conflictedElementIds: Set<string>
  requirementCountByElementId: Map<string, number>
  statusFilter: Status | null
  selectedElementId: string | null
  dropTargetElementId: string | null
  onSelectElement: (elementId: string) => void
  onDropRequirement: (elementId: string, requirementIds: string[]) => void
  onDropTargetChange: (elementId: string | null) => void
}

function parseDraggedRequirementIds(dataTransfer: DataTransfer | null): string[] {
  const raw = dataTransfer?.getData('text/plain')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    // Not JSON — treat the raw string as a single requirement id (legacy/plain drag source).
  }
  return [raw]
}

const CELL_WIDTH = 200
const CELL_HEIGHT = 130
const CELL_GAP = 16
const MARGIN_LEFT = 140
const MARGIN_TOP = 24
// Extra vertical gap separating the external-context band from the main
// layer grid below it (Area B, "external modules shown outside the main
// architecture, as context") — on top of the usual CELL_GAP.
const EXTERNAL_BAND_GAP = 28

// Shape/colour convention (Area B, resolved): functional = rect, interface
// spine = rect with a distinct accent border, services = rect with a
// pill/tab, external/environment = grey rect, runtime = rect with a dashed
// border (scheduling-significant). Deterministic per-kind, not per-instance.
const KIND_FILL: Record<ArchitectureElementKind, string> = {
  functional: 'var(--accent-bg)',
  'interface-spine': 'var(--bg-alt)',
  service: 'var(--accent-bg)',
  external: 'var(--bg-alt)',
  runtime: 'var(--accent-bg)',
}

const KIND_STROKE: Record<ArchitectureElementKind, string> = {
  functional: 'var(--border)',
  'interface-spine': 'var(--accent)',
  service: 'var(--border)',
  external: 'var(--text-muted)',
  runtime: 'var(--accent)',
}

const KIND_DASH: Record<ArchitectureElementKind, string> = {
  functional: '',
  'interface-spine': '',
  service: '',
  external: '',
  runtime: '6,4',
}

function elementX(col: number): number {
  return MARGIN_LEFT + col * (CELL_WIDTH + CELL_GAP)
}

// Each logical layer (architecture.layers[row]) can wrap into more than one
// visual band once its elements' columns no longer fit the available width —
// this is what lets the grid grow downward (more rows) instead of sideways
// (horizontal scroll) as elements are added to a layer.
interface WrappedBand {
  row: number
  wrapIndex: number
}

// row -1 (EXTERNAL_CONTEXT_ROW) renders as its own band above row 0, offset
// by the extra EXTERNAL_BAND_GAP so it's visually distinct from the main
// layer grid rather than just "another row." The offset only applies when
// an external band actually exists, so projects with no external elements
// render identically to before this concept was introduced.
function elementY(bandIndex: number, row: number, hasExternalBand: boolean): number {
  if (row === EXTERNAL_CONTEXT_ROW) return MARGIN_TOP
  const mainTop = hasExternalBand ? MARGIN_TOP + CELL_HEIGHT + EXTERNAL_BAND_GAP : MARGIN_TOP
  return mainTop + bandIndex * (CELL_HEIGHT + CELL_GAP)
}

// Computes, for a given max columns-per-row, how many wrapped visual bands
// each layer needs and which band + wrapped column every element lands in.
// Elements keep their relative left-to-right order within a layer; a wide
// (colSpan > 1) element that wouldn't fit in the remaining columns of the
// current band pushes onto the next band rather than overlapping.
function computeWrappedLayout(elements: ArchitectureElement[], layerCount: number, maxColsPerRow: number) {
  const elementsByRow = new Map<number, ArchitectureElement[]>()
  for (const el of elements) {
    if (el.row === EXTERNAL_CONTEXT_ROW) continue
    const list = elementsByRow.get(el.row) ?? []
    list.push(el)
    elementsByRow.set(el.row, list)
  }

  const bands: WrappedBand[] = []
  const bandIndexByElementId = new Map<string, number>()
  const colByElementId = new Map<string, number>()

  for (let row = 0; row < layerCount; row++) {
    const rowElements = [...(elementsByRow.get(row) ?? [])].sort((a, b) => a.col - b.col)
    let wrapIndex = 0
    let cursor = 0
    let bandStart = bands.length
    bands.push({ row, wrapIndex })
    for (const el of rowElements) {
      if (cursor + el.colSpan > maxColsPerRow && cursor > 0) {
        wrapIndex += 1
        cursor = 0
        bandStart = bands.length
        bands.push({ row, wrapIndex })
      }
      bandIndexByElementId.set(el.id, bandStart)
      colByElementId.set(el.id, cursor)
      cursor += el.colSpan
    }
  }

  return { bands, bandIndexByElementId, colByElementId }
}

// Deterministic row/column grid render (Area B, "Grid-based architecture
// structure") — same input always renders identically, no force layout.
export function ArchitectureGrid({
  architecture,
  statusByElementId,
  conflictedElementIds,
  requirementCountByElementId,
  statusFilter,
  selectedElementId,
  dropTargetElementId,
  onSelectElement,
  onDropRequirement,
  onDropTargetChange,
}: ArchitectureGridProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  // Mirrors dropTargetElementId so drag handlers registered by the (expensive,
  // full-rebuild) draw effect below can read the latest value without that
  // effect depending on dropTargetElementId itself — see the dedicated
  // highlight-update effect further down, which avoids rebuilding the whole
  // SVG (and restarting its entrance transitions) on every dragenter/dragleave.
  const dropTargetElementIdRef = useRef<string | null>(dropTargetElementId)
  dropTargetElementIdRef.current = dropTargetElementId

  // Available width drives how many columns fit per visual row before a
  // layer wraps onto an additional band — the grid grows downward, not
  // sideways, as the container is resized or elements are added.
  const [containerWidth, setContainerWidth] = useState(0)
  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()

    const externalElements = architecture.elements.filter((e) => e.row === EXTERNAL_CONTEXT_ROW)
    const hasExternalBand = externalElements.length > 0

    const maxColByWidth = Math.max(1, Math.floor((containerWidth - MARGIN_LEFT + CELL_GAP) / (CELL_WIDTH + CELL_GAP)))
    const widestElementSpan = Math.max(1, ...architecture.elements.map((e) => e.colSpan))
    const maxColsPerRow = Math.max(widestElementSpan, maxColByWidth)

    const { bands, bandIndexByElementId, colByElementId } = computeWrappedLayout(
      architecture.elements,
      architecture.layers.length,
      maxColsPerRow,
    )
    const colFor = (el: ArchitectureElement) => (el.row === EXTERNAL_CONTEXT_ROW ? el.col : colByElementId.get(el.id) ?? el.col)
    const bandIndexFor = (el: ArchitectureElement) => (el.row === EXTERNAL_CONTEXT_ROW ? 0 : bandIndexByElementId.get(el.id) ?? 0)
    // First/last band index occupied by each logical layer — a layer that
    // wrapped into multiple bands gets one contiguous background strip
    // spanning all of them, plus a single label on its first band.
    const layerBandRanges = architecture.layers.map((_layer, row) => {
      const rowBands = bands.map((b, i) => ({ b, i })).filter(({ b }) => b.row === row)
      const first = rowBands[0]?.i ?? 0
      const last = rowBands[rowBands.length - 1]?.i ?? first
      return { first, last }
    })

    const maxCol = maxColsPerRow - 1
    const width = elementX(maxCol + 1) + CELL_GAP
    const height = elementY(bands.length, 0, hasExternalBand) + CELL_GAP

    svg.attr('width', width).attr('height', Math.max(height, MARGIN_TOP))
    svg.attr('viewBox', `0 0 ${width} ${Math.max(height, MARGIN_TOP)}`)

    // External-context band: its own grey strip + label, separated from the
    // main layer grid by EXTERNAL_BAND_GAP rather than mixed in with the
    // striped layer rows below.
    if (hasExternalBand) {
      const externalG = svg.append('g').attr('class', 'architecture-grid-external-band')
      externalG
        .append('rect')
        .attr('x', 0)
        .attr('y', elementY(0, EXTERNAL_CONTEXT_ROW, hasExternalBand) - CELL_GAP / 2)
        .attr('width', width)
        .attr('height', CELL_HEIGHT + CELL_GAP)
        .attr('fill', 'var(--bg-alt)')
        .attr('stroke', 'var(--border)')
        .attr('stroke-dasharray', '4,4')
      externalG
        .append('text')
        .attr('x', 12)
        .attr('y', elementY(0, EXTERNAL_CONTEXT_ROW, hasExternalBand) + CELL_HEIGHT / 2)
        .attr('dominant-baseline', 'middle')
        .attr('fill', 'var(--text-muted)')
        .attr('font-size', 12)
        .attr('font-weight', 600)
        .text('External Context')
    }

    // Layer row labels + background bands — one background strip per layer,
    // spanning every wrapped band that layer occupies.
    const layerG = svg.append('g').attr('class', 'architecture-grid-layers')
    layerG
      .selectAll('rect')
      .data(architecture.layers)
      .join('rect')
      .attr('x', 0)
      .attr('y', (_d, i) => elementY(layerBandRanges[i].first, 0, hasExternalBand) - CELL_GAP / 2)
      .attr('width', width)
      .attr(
        'height',
        (_d, i) =>
          elementY(layerBandRanges[i].last, 0, hasExternalBand) +
          CELL_HEIGHT +
          CELL_GAP / 2 -
          (elementY(layerBandRanges[i].first, 0, hasExternalBand) - CELL_GAP / 2),
      )
      .attr('fill', (_d, i) => (i % 2 === 0 ? 'var(--bg-alt)' : 'transparent'))

    layerG
      .selectAll('text')
      .data(architecture.layers)
      .join('text')
      .attr('x', 12)
      .attr('y', (_d, i) => elementY(layerBandRanges[i].first, 0, hasExternalBand) + CELL_HEIGHT / 2)
      .attr('dominant-baseline', 'middle')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', 12)
      .attr('font-weight', 600)
      .text((d) => d)

    // Soft drop-shadow + hover-glow filters for the card-style element
    // boxes (Area B modernisation: no connector lines/arrows — relatedness
    // is conveyed by layer grouping alone, per product decision).
    const defs = svg.append('defs')
    const shadow = defs.append('filter').attr('id', 'architecture-card-shadow').attr('x', '-40%').attr('y', '-40%').attr('width', '180%').attr('height', '180%')
    shadow.append('feDropShadow').attr('dx', 0).attr('dy', 2).attr('stdDeviation', 3).attr('flood-color', '#000').attr('flood-opacity', 0.18)
    const glow = defs.append('filter').attr('id', 'architecture-card-glow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    glow.append('feDropShadow').attr('dx', 0).attr('dy', 0).attr('stdDeviation', 5).attr('flood-color', 'var(--accent)').attr('flood-opacity', 0.55)

    for (const kind of Object.keys(KIND_FILL) as ArchitectureElementKind[]) {
      const gradient = defs
        .append('linearGradient')
        .attr('id', `architecture-card-gradient-${kind}`)
        .attr('x1', '0%')
        .attr('y1', '0%')
        .attr('x2', '100%')
        .attr('y2', '100%')
      gradient.append('stop').attr('offset', '0%').attr('stop-color', KIND_FILL[kind]).attr('stop-opacity', 1)
      gradient.append('stop').attr('offset', '100%').attr('stop-color', KIND_FILL[kind]).attr('stop-opacity', 0.55)
    }

    // Element boxes.
    const visibleElements = statusFilter
      ? architecture.elements.filter((e) => statusByElementId.get(e.id) === statusFilter)
      : architecture.elements

    const elementG = svg
      .append('g')
      .attr('class', 'architecture-grid-elements')
      .selectAll('g')
      .data(visibleElements, (d) => (d as ArchitectureElement).id)
      .join('g')
      .attr('class', 'architecture-card')
      .attr('transform', (d) => `translate(${elementX(colFor(d))}, ${elementY(bandIndexFor(d), d.row, hasExternalBand)}) scale(0.92)`)
      .attr('opacity', 0)
      .style('cursor', 'pointer')
      .style('transform-box', 'fill-box')
      .style('transform-origin', 'center')
      .on('click', (_event, d) => onSelectElement(d.id))
      .on('mouseenter', function (_event, d) {
        if (d.id === dropTargetElementIdRef.current) return
        d3.select(this).select('rect.architecture-card-bg').attr('filter', 'url(#architecture-card-glow)')
      })
      .on('mouseleave', function (_event, d) {
        if (d.id === dropTargetElementIdRef.current) return
        d3.select(this).select('rect.architecture-card-bg').attr('filter', 'url(#architecture-card-shadow)')
      })
      .on('dragover', function (event: DragEvent) {
        event.preventDefault()
      })
      .on('dragenter', function (event: DragEvent, d) {
        event.preventDefault()
        onDropTargetChange(d.id)
      })
      .on('dragleave', function (event: DragEvent, d) {
        // Child nodes (text, circles) inside this card's <g> fire their own
        // dragleave when the pointer crosses onto a sibling child — that's
        // not actually leaving the card, so ignore it unless relatedTarget
        // is truly outside this group (or absent, e.g. leaving the window).
        const related = event.relatedTarget as Node | null
        if (related && (this as Element).contains(related)) return
        if (d.id === dropTargetElementIdRef.current) onDropTargetChange(null)
      })
      .on('drop', function (event: DragEvent, d) {
        event.preventDefault()
        const requirementIds = parseDraggedRequirementIds(event.dataTransfer)
        onDropTargetChange(null)
        if (requirementIds.length > 0) onDropRequirement(d.id, requirementIds)
      })

    // Entrance animation: cards fade + scale in, staggered slightly per
    // element so the grid feels alive on load/filter change rather than
    // popping in all at once.
    elementG
      .transition()
      .duration(320)
      .delay((_d, i) => i * 22)
      .ease(d3.easeCubicOut)
      .attr('opacity', 1)
      .attr('transform', (d) => `translate(${elementX(colFor(d))}, ${elementY(bandIndexFor(d), d.row, hasExternalBand)}) scale(1)`)

    elementG
      .append('rect')
      .attr('class', 'architecture-card-bg')
      .attr('width', (d) => d.colSpan * CELL_WIDTH + (d.colSpan - 1) * CELL_GAP)
      .attr('height', (d) => d.rowSpan * CELL_HEIGHT + (d.rowSpan - 1) * CELL_GAP)
      .attr('rx', 14)
      .attr('fill', (d) => `url(#architecture-card-gradient-${d.kind})`)
      .attr('stroke', (d) =>
        d.id === dropTargetElementIdRef.current ? 'var(--accent)' : d.id === selectedElementId ? 'var(--accent)' : KIND_STROKE[d.kind],
      )
      .attr('stroke-width', (d) => (d.id === selectedElementId || d.id === dropTargetElementIdRef.current ? 3 : 1.5))
      .attr('stroke-dasharray', (d) => (d.id === dropTargetElementIdRef.current ? '' : KIND_DASH[d.kind]))
      .attr('filter', (d) => (d.id === dropTargetElementIdRef.current ? 'url(#architecture-card-glow)' : 'url(#architecture-card-shadow)'))

    // Status dot, top-right of each box — a soft pulse ring behind
    // in-progress elements gives the grid a "live" heartbeat without
    // being distracting on settled (complete/not-started) work.
    elementG
      .filter((d) => statusByElementId.get(d.id) === 'in-progress')
      .append('circle')
      .attr('class', 'architecture-card-status-pulse')
      .attr('cx', (d) => d.colSpan * CELL_WIDTH + (d.colSpan - 1) * CELL_GAP - 14)
      .attr('cy', 14)
      .attr('r', 5)
      .attr('fill', 'none')
      .attr('stroke', STATUS_COLOR['in-progress'])
      .attr('stroke-width', 1.5)
      .style('transform-box', 'fill-box')
      .style('transform-origin', 'center')

    elementG
      .append('circle')
      .attr('cx', (d) => d.colSpan * CELL_WIDTH + (d.colSpan - 1) * CELL_GAP - 14)
      .attr('cy', 14)
      .attr('r', 5)
      .attr('fill', (d) => STATUS_COLOR[statusByElementId.get(d.id) ?? 'not-started'])

    // Requirement-count badge, bottom-right — reflects drop-and-drop
    // allocations from the unallocated-requirements tray at a glance.
    const badged = elementG.filter((d) => (requirementCountByElementId.get(d.id) ?? 0) > 0)
    const badgeCx = (d: ArchitectureElement) => d.colSpan * CELL_WIDTH + (d.colSpan - 1) * CELL_GAP - 16
    const badgeCy = (d: ArchitectureElement) => d.rowSpan * CELL_HEIGHT + (d.rowSpan - 1) * CELL_GAP - 14
    badged
      .append('circle')
      .attr('class', 'architecture-card-req-badge')
      .attr('cx', badgeCx)
      .attr('cy', badgeCy)
      .attr('r', 9)
      .attr('fill', 'var(--accent)')
    badged
      .append('text')
      .attr('x', badgeCx)
      .attr('y', badgeCy)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', 10)
      .attr('font-weight', 700)
      .attr('fill', '#fff')
      .text((d) => String(requirementCountByElementId.get(d.id) ?? 0))

    // Conflict badge, top-left, only for flagged elements.
    elementG
      .filter((d) => conflictedElementIds.has(d.id))
      .append('text')
      .attr('x', 10)
      .attr('y', 18)
      .attr('font-size', 13)
      .text('⚠')
      .attr('fill', 'var(--status-red)')

    // Name text, wrapped to the box width and truncated (with an ellipsis)
    // past two lines rather than overflowing the card.
    elementG.each(function (d) {
      const boxWidth = d.colSpan * CELL_WIDTH + (d.colSpan - 1) * CELL_GAP
      const maxCharsPerLine = Math.max(1, Math.floor((boxWidth - 24) / 7.2))
      const words = d.name.split(' ')
      const lines: string[] = []
      let current = ''
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxCharsPerLine) {
          if (current) lines.push(current.trim())
          current = word
        } else {
          current = `${current} ${word}`.trim()
        }
      }
      if (current) lines.push(current)

      const truncated = lines.length > 2
      const nameLines = lines.slice(0, 2)
      if (truncated) {
        const last = nameLines[1]
        nameLines[1] = last.length > 1 ? `${last.slice(0, -1).trimEnd()}…` : `${last}…`
      }

      d3.select(this)
        .selectAll('text.architecture-card-name-line')
        .data(nameLines)
        .join('text')
        .attr('class', 'architecture-card-name-line')
        .attr('x', 12)
        .attr('y', (_line, i) => 22 + i * 16)
        .attr('font-size', 13)
        .attr('font-weight', 600)
        .attr('fill', 'var(--text-h)')
        .text((line) => line)
    })

    elementG
      .append('text')
      .attr('x', 12)
      .attr('y', 60)
      .attr('font-size', 10)
      .attr('fill', 'var(--text-muted)')
      .text((d) => d.kind)

    // Responsibility text, wrapped naively to the box width, truncated with
    // an ellipsis on the last visible line if it doesn't all fit.
    elementG.each(function (d) {
      const words = d.responsibility.split(' ')
      const maxCharsPerLine = Math.floor((d.colSpan * CELL_WIDTH) / 6.5)
      const lines: string[] = []
      let current = ''
      for (const word of words) {
        if ((current + ' ' + word).trim().length > maxCharsPerLine) {
          if (current) lines.push(current.trim())
          current = word
        } else {
          current = `${current} ${word}`.trim()
        }
      }
      if (current) lines.push(current)
      const boxHeight = d.rowSpan * CELL_HEIGHT + (d.rowSpan - 1) * CELL_GAP
      const maxLines = Math.max(1, Math.floor((boxHeight - 78) / 14))

      const truncated = lines.length > maxLines
      const visibleLines = lines.slice(0, maxLines)
      if (truncated && visibleLines.length > 0) {
        const last = visibleLines[visibleLines.length - 1]
        visibleLines[visibleLines.length - 1] = last.length > 1 ? `${last.slice(0, -1).trimEnd()}…` : `${last}…`
      }

      d3.select(this)
        .selectAll('text.responsibility-line')
        .data(visibleLines)
        .join('text')
        .attr('class', 'responsibility-line')
        .attr('x', 12)
        .attr('y', (_line, i) => 88 + i * 14)
        .attr('font-size', 11)
        .attr('fill', 'var(--text)')
        .text((line) => line)
    })
  }, [
    architecture,
    statusByElementId,
    conflictedElementIds,
    requirementCountByElementId,
    statusFilter,
    selectedElementId,
    containerWidth,
    onSelectElement,
    onDropRequirement,
    onDropTargetChange,
  ])

  // Cheap highlight-only update: toggles the drop-target styling on the
  // affected card(s) in place, instead of tearing down and rebuilding the
  // whole SVG (which the effect above does, including its 320ms entrance
  // transition) on every dragenter/dragleave while a drag is in progress.
  useEffect(() => {
    if (!svgRef.current) return
    const svg = d3.select(svgRef.current)
    svg.selectAll<SVGGElement, ArchitectureElement>('g.architecture-card').each(function (d) {
      const isDropTarget = d.id === dropTargetElementId
      const isSelected = d.id === selectedElementId
      d3.select(this)
        .classed('architecture-card-drop-active', isDropTarget)
        .select('rect.architecture-card-bg')
        .attr('stroke', isDropTarget ? 'var(--accent)' : isSelected ? 'var(--accent)' : KIND_STROKE[d.kind])
        .attr('stroke-width', isSelected || isDropTarget ? 3 : 1.5)
        .attr('stroke-dasharray', isDropTarget ? '' : KIND_DASH[d.kind])
        .attr('filter', isDropTarget ? 'url(#architecture-card-glow)' : 'url(#architecture-card-shadow)')
    })
  }, [dropTargetElementId, selectedElementId])

  if (architecture.elements.length === 0) {
    return (
      <div className="architecture-grid-scroll" ref={containerRef}>
        <div className="architecture-grid-empty">
          No elements yet — use "Add element" to place the first block, spine, or service on the grid.
        </div>
      </div>
    )
  }

  return (
    <div className="architecture-grid-scroll" ref={containerRef}>
      <svg ref={svgRef} className="architecture-grid-svg" />
    </div>
  )
}
