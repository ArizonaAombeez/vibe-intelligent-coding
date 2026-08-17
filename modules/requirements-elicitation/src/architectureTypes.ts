import type { ArchitectureTypeId } from './types.js'

// Preset Architecture types (Area B, resolved) — single source of truth.
// packages/ui/src/api/mockApi.ts and packages/server/src/index.ts mirror
// this list by hand today; new/changed presets should be added here first.
export interface ArchitectureTypeOption {
  id: ArchitectureTypeId
  label: string
  description: string
  defaultLayers: string[]
  dynamicDesignDefault: boolean
}

export const ARCHITECTURE_TYPES: ArchitectureTypeOption[] = [
  {
    id: 'web-app',
    label: 'Web App',
    description: 'Frontend/backend/data layers.',
    defaultLayers: ['UI', 'Service', 'Data'],
    dynamicDesignDefault: false,
  },
  {
    id: 'desktop',
    label: 'Desktop / PC Platform',
    description: 'Native desktop application.',
    defaultLayers: ['UI', 'Application', 'Data'],
    dynamicDesignDefault: false,
  },
  {
    id: 'mobile',
    label: 'Mobile App',
    description: 'iOS/Android application.',
    defaultLayers: ['UI', 'Application', 'Data'],
    dynamicDesignDefault: false,
  },
  {
    id: 'networking',
    label: 'Networking / Protocol Stack',
    description: 'Protocol layers and network services.',
    defaultLayers: ['Application', 'Protocol', 'Transport'],
    dynamicDesignDefault: false,
  },
  {
    id: 'embedded',
    label: 'Embedded / Firmware',
    description: 'Scheduling-significant, mandatory runtime/execution block.',
    defaultLayers: ['Application', 'Driver', 'Runtime/Execution'],
    dynamicDesignDefault: true,
  },
  {
    id: 'cli-library',
    label: 'CLI Tool / Library',
    description: 'Command-line tool or reusable library.',
    defaultLayers: ['Interface', 'Core'],
    dynamicDesignDefault: false,
  },
  {
    id: 'backend-service',
    label: 'Backend Service / API-only',
    description: 'API service with no UI layer.',
    defaultLayers: ['API', 'Service', 'Data'],
    dynamicDesignDefault: false,
  },
  {
    id: 'data-pipeline',
    label: 'Data Pipeline / ETL',
    description: 'Ingest/transform/load stages.',
    defaultLayers: ['Ingest', 'Transform', 'Load'],
    dynamicDesignDefault: false,
  },
  {
    id: 'microservices',
    label: 'Distributed / Microservices',
    description: 'Multiple independently-deployed services.',
    defaultLayers: ['Gateway', 'Service', 'Data'],
    dynamicDesignDefault: false,
  },
  {
    id: 'game-realtime',
    label: 'Game / Real-time Simulation',
    description: 'Real-time loop with time-significant behaviour.',
    defaultLayers: ['Presentation', 'Simulation', 'Runtime/Execution'],
    dynamicDesignDefault: true,
  },
  {
    id: 'custom',
    label: 'Custom / Blank',
    description: 'No preset layers — define the grid from scratch.',
    defaultLayers: [],
    dynamicDesignDefault: false,
  },
]

export function findArchitectureType(id: ArchitectureTypeId): ArchitectureTypeOption | undefined {
  return ARCHITECTURE_TYPES.find((t) => t.id === id)
}
