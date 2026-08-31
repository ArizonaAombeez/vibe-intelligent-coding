import type {
  HarnessChecklistKey,
  PlatformDescriptor,
  PlatformId,
} from "./types.js";

// Built-in project platforms (project harness feature) — single source of
// truth. packages/ui/src/api/types.ts mirrors PlatformDescriptor by hand
// and packages/server serves this list; user-added custom platforms live in
// PROJECTS_ROOT/platforms.json and are concatenated onto this list at the
// API layer. Mirrors the shape of architectureTypes.ts's ARCHITECTURE_TYPES.
export const BUILT_IN_PLATFORMS: PlatformDescriptor[] = [
  {
    id: "embedded",
    label: "Embedded / Firmware",
    entryPointHint:
      "A single main() / entry function on the target MCU; no OS process model.",
    wiringHint:
      "Direct function calls and statically-owned shared buffers; every datum has one owning module, nothing global.",
    lifecycleHint:
      "start only — init all modules then enter the run loop; there is no stop.",
    builtIn: true,
  },
  {
    id: "web",
    label: "Web App",
    entryPointHint:
      "index.html at the src root with <script type=\"module\" src=\"./main.js\"></script>; main.js is the single entry module that imports each element and starts the app. NO bundler, framework, or build step — plain ES modules only, run by serving the src folder over http (VIC's Run Local preview does this). Never assume it is opened as a file:// path.",
    wiringHint:
      "Native ES module imports: main.js does `import { Thing } from './element-folder/index.js'` for each element's own entry file, constructs them explicitly, and passes dependencies in. Every path is relative and ends in .js (browsers do not resolve extensionless imports). No ambient globals, no window.* namespace object, no import maps.",
    lifecycleHint:
      "start only — main.js runs on load and wires everything; stop is not a distinct phase (page unload).",
    builtIn: true,
  },
  {
    id: "android",
    label: "Android App",
    entryPointHint:
      "Application.onCreate and the launcher Activity.onCreate; AndroidManifest declares the entry point.",
    wiringHint:
      "Dependency injection scopes and lifecycle-owned holders (ViewModel + observable state); scope = which component owns the holder.",
    lifecycleHint:
      "start + stop — bound to Activity/Application lifecycle callbacks.",
    builtIn: true,
  },
  {
    id: "desktop",
    label: "Desktop / PC App",
    entryPointHint:
      "A single process entry (main) that constructs the object graph and shows the main window.",
    wiringHint:
      "Explicit constructor wiring in the composition root; dependencies passed in, never self-constructed, no module-level singletons.",
    lifecycleHint:
      "start + stop — construct on launch, dispose on window close / quit.",
    builtIn: true,
  },
  {
    id: "cli",
    label: "CLI Tool",
    entryPointHint:
      "A single executable entry (main) parsing argv and dispatching to a command. If written in TypeScript, assume it is run with `tsx main.ts` (no separate compile step is generated); if plain JS, `node main.js`. Use relative imports with explicit file extensions so it runs without a bundler.",
    wiringHint:
      "Explicit construction in main(); dependencies passed as function/constructor arguments. Native module imports only — no build tooling.",
    lifecycleHint:
      "start + stop — run the command, then exit; SIGINT is the only stop signal.",
    builtIn: true,
  },
  {
    id: "server",
    label: "Backend Service",
    entryPointHint:
      "A process entry (main) that builds the app, binds a port, and starts listening. If TypeScript, assume `tsx main.ts` at run time (no compile step is generated); if plain JS, `node main.js`. Relative imports with explicit extensions, no bundler.",
    wiringHint:
      "Explicit construction / a DI container in the composition root; request-scoped vs singleton lifetimes made explicit. Native module imports only.",
    lifecycleHint: "start + stop — listen on boot, drain and close on SIGTERM.",
    builtIn: true,
  },
];

// The fixed harness responsibility checklist (project harness feature).
// deriveHarnessSpec marks each key 'applies' or 'not-applicable' for the
// selected platform and records a one-sentence realisation. Order here is
// the order the UI renders them in.
export const DEFAULT_HARNESS_CHECKLIST: ReadonlyArray<{
  key: HarnessChecklistKey;
  description: string;
}> = [
  {
    key: "entry-point",
    description:
      'Provides the platform entry point ("run this" for the target).',
  },
  {
    key: "element-instantiation",
    description: "Instantiates every functional element.",
  },
  {
    key: "inter-element-links",
    description:
      "Establishes the declared data links / function-call connections between elements.",
  },
  {
    key: "lifecycle-start",
    description: "Drives the run lifecycle start (init order, then go).",
  },
  {
    key: "lifecycle-stop",
    description:
      "Drives the run lifecycle stop / teardown, where the platform has one.",
  },
  {
    key: "config-load",
    description:
      "Loads whatever configuration the elements need before they start.",
  },
  {
    key: "dependency-order",
    description:
      "Constructs elements in dependency order so each has what it needs.",
  },
  {
    key: "error-surface",
    description:
      "Surfaces a fatal error from any element rather than swallowing it.",
  },
];

// The fixed, platform-invariant responsibility string for the harness
// element. Set once at creation and never edited by the user (unlike a
// normal element's responsibility) — the harness's job is defined, only its
// realisation varies.
export function buildHarnessResponsibility(): string {
  return (
    "Owns the platform entry point; instantiates every functional element; " +
    "establishes the declared inter-element connections; drives the run " +
    "lifecycle. Contains no functional logic of its own."
  );
}

// The permissible root-relative paths the harness Coding prompt suggests as
// entry-point locations for a given platform — a HINT for the prompt, not a
// hard whitelist (the harness may write any root file; only element folders
// are off-limits, enforced by post-run revert). Falls back to a generic set
// for custom platforms.
export function harnessRootWritePrefixesForPlatform(
  platformId: PlatformId,
): string[] {
  switch (platformId) {
    case "web":
      return ["index.html", "main.js", "styles.css"];
    case "android":
      return ["MainActivity.kt", "AndroidManifest.xml", "Application.kt"];
    case "cli":
    case "server":
      return ["main.ts", "index.ts", "cli.ts"];
    case "desktop":
      return ["main.ts", "index.ts"];
    case "embedded":
      return ["main.c", "main.cpp", "main.rs"];
    default:
      return ["main.ts", "index.ts", "index.html"];
  }
}

// Resolve a platform id against the built-in list plus a caller-supplied
// list of custom descriptors (from the server-side platform store).
export function findPlatform(
  id: PlatformId | null | undefined,
  customPlatforms: PlatformDescriptor[] = [],
): PlatformDescriptor | undefined {
  if (!id) return undefined;
  return [...BUILT_IN_PLATFORMS, ...customPlatforms].find((p) => p.id === id);
}

// Whether an id names one of the six built-ins (which cannot be deleted).
export function isBuiltInPlatformId(id: PlatformId): boolean {
  return BUILT_IN_PLATFORMS.some((p) => p.id === id);
}

// Filesystem-safe slug of a platform label, used both for the "custom:<slug>"
// id and for the "-<platform>" suffix appended to project names on a branch.
export function platformSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "platform"
  );
}
