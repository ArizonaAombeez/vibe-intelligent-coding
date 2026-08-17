import type { Project, ProjectSettings } from './types.js'

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  phaseTabGating: 'always-accessible',
}

export function getProjectSettings(project: Project): ProjectSettings {
  return project.settings ?? DEFAULT_PROJECT_SETTINGS
}

export function updateProjectSettings(
  project: Project,
  updates: Partial<ProjectSettings>,
): ProjectSettings {
  project.settings = { ...getProjectSettings(project), ...updates }
  return project.settings
}
