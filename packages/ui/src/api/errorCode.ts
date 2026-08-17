import type { CurrentOperation } from './types'

// Duck-typed extraction of the optional `code` an ApiError (httpApi.ts)
// carries — screens catch whatever VicCoreApi implementation is wired in
// (http or mock) and must not import a concrete implementation's class to
// check this, so a property check stands in for `instanceof ApiError`.
export function toOperationError(err: unknown, message?: string): CurrentOperation {
  const code = (err as { code?: unknown })?.code
  return {
    text: null,
    error: message ?? (err as Error).message,
    errorCode:
      code === 'llm-not-configured' ? 'llm-not-configured' : code === 'project-run-locked' ? 'project-run-locked' : undefined,
  }
}
