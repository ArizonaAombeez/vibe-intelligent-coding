import path from "node:path";
import {
  checkInterfaces,
  findPlatform,
  harnessRootWritePrefixesForPlatform,
} from "vic-requirements-elicitation";
import type {
  ArchitectureElement,
  CodingRun,
  CodingRunStatus,
  ElementInterfaceDefinition,
  PlatformDescriptor,
  Project,
} from "vic-requirements-elicitation";
import type { CodingAgentClient } from "./agentClient.js";
import {
  elementSubfolderName,
  HARNESS_SUBFOLDER_NAME,
  scaffoldProjectSourceTree,
  sourceTreeRoot,
  wipeScopedSubfolder,
} from "./scaffold.js";
import { gitCommitAll, gitInitIfNeeded } from "./gitDiff.js";
import {
  withHarnessWorkspace,
  withIsolatedElementWorkspace,
} from "./isolatedWorkspace.js";
import { openLocalSourceTree } from "./localSourceTree.js";
import {
  runElementInlineTests,
  uncoveredRequirementIds,
} from "./inlineTestRun.js";
import { scanElementApis } from "./elementApiScan.js";
import type { ElementApi, ElementExport } from "./elementApiScan.js";

// Modularity rule (resolved): a Coding run may only touch a module (the
// code implementing one architecture element) that's actually impacted by
// a failing test or a requirement change — both of which surface as one of
// this element's allocated requirements sitting at 'allocated'
// (Architecture's resting status, restored either by requirementStatusFlip's
// applyPassThreshold on a failing test, or by updateRequirementText's
// regression on an edit — see elicitation.ts). An element with no
// 'allocated' requirement allocated to it has nothing pending and should
// not re-run Coding.
export function isElementEligibleForCoding(
  project: Project,
  architectureElementId: string,
): boolean {
  return project.requirements.some(
    (r) =>
      !r.deletedAt &&
      r.architectureElements.includes(architectureElementId) &&
      r.status === "allocated",
  );
}

// "An element cannot be coded until its I/O interface is defined" (Area B),
// plus the newer hard-block rule (Area B/D, resolved): the instant a master
// InterfaceDefinition changes, every participant is flagged aligned:false
// (architecture.ts's markParticipantsMisaligned) and stays blocked here
// until a human reconciles that element's own copy against the new master
// AND against this element's own requirements (reconcileElementInterface).
// Unlike checkInterfaces itself (advisory, never blocks a phase transition),
// this is a hard gate specifically on Coding — undefined, incomplete, or
// misaligned interfaces all refuse the run, regardless of requirement-
// allocation status. Returns a human-readable reason (for the rejected
// run's rawLog) when blocked, or undefined when the element's own
// interfaces are fully specified and aligned. Only this element's own
// connections are considered — an unrelated element's problem elsewhere in
// the architecture never blocks this one.
export function interfaceGateReasonForElement(
  project: Project,
  architectureElementId: string,
): string | undefined {
  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (!element) return undefined;
  const {
    undefinedPairs,
    incompleteOperations,
    misalignedElements,
    danglingElementInterfaces,
  } = checkInterfaces(project);
  const ownUndefined = undefinedPairs.filter(
    (p) =>
      p.fromId === architectureElementId || p.toId === architectureElementId,
  );
  const ownIncomplete = incompleteOperations.filter(
    (o) =>
      o.fromId === architectureElementId || o.toId === architectureElementId,
  );
  const ownMisaligned = misalignedElements.filter(
    (m) => m.elementId === architectureElementId,
  );
  const ownDangling = danglingElementInterfaces.filter(
    (d) => d.elementId === architectureElementId,
  );
  if (
    ownUndefined.length === 0 &&
    ownIncomplete.length === 0 &&
    ownMisaligned.length === 0 &&
    ownDangling.length === 0
  ) {
    return undefined;
  }

  const parts: string[] = [];
  if (ownUndefined.length > 0) {
    parts.push(
      `undefined interface(s) with ${ownUndefined.map((p) => (p.fromId === architectureElementId ? p.toId : p.fromId)).join(", ")}`,
    );
  }
  if (ownIncomplete.length > 0) {
    parts.push(
      `operation(s) missing I/O detail (${ownIncomplete.map((o) => `${o.operationName}: ${o.missingFields.join(", ")}`).join("; ")})`,
    );
  }
  if (ownMisaligned.length > 0) {
    const names = ownMisaligned
      .map(
        (m) =>
          (project.architecture?.interfaceDefinitions ?? []).find(
            (d) => d.id === m.masterDefinitionId,
          )?.name ?? m.masterDefinitionId,
      )
      .join(", ");
    parts.push(
      `out-of-date copy of ${names} — a master interface changed since this element's own understanding of it was last reconciled`,
    );
  }
  if (ownDangling.length > 0) {
    // A corrupted/broken reference, not merely out of date — the id this
    // element's own copy points at doesn't exist anywhere in the project's
    // interfaceDefinitions, so there is no master content to reconcile
    // against. Distinct wording (and a concrete fix) rather than folding
    // this into the "out-of-date" message above, which would wrongly imply
    // reconciling against a real master would resolve it.
    parts.push(
      `broken reference to a deleted or corrupted interface (${ownDangling.map((d) => d.masterDefinitionId).join(", ")}) — this connection has no master interface content behind it. Re-define this connection from the Architecture screen (Check Interfaces, then Define) to replace it with a real interface, or remove the connection if it's no longer needed`,
    );
  }
  return `This element's I/O interfaces are not fully defined yet — ${parts.join("; ")}. Define and complete every interface (range, resolution, unit, and minimum update frequency or driven-directly), and review any out-of-date interface against this element's own requirements before Coding can proceed.`;
}

function formatElement(project: Project, elementId: string): string {
  const element = project.architecture?.elements.find(
    (e) => e.id === elementId,
  );
  if (!element) return elementId;
  return `${element.id} (${element.kind}): ${element.name} — ${element.responsibility}`;
}

// Every requirement currently allocated to this element — queried live from
// requirement.architectureElements, never a cached/derived list. A
// requirement allocated to multiple elements appears in each element's own
// list independently.
export function requirementsAllocatedToElement(
  project: Project,
  architectureElementId: string,
) {
  return project.requirements.filter(
    (r) =>
      !r.deletedAt && r.architectureElements.includes(architectureElementId),
  );
}

function formatRequirements(requirements: Project["requirements"]): string {
  return requirements.map((r) => `${r.id}: ${r.text}`).join("\n");
}

// This element's own local copy of every interface it participates in —
// context only (not a scope expansion): the element still only ever writes
// to its own subfolder, but seeing each copy's operations and role
// (produces/consumes/both) helps the agent implement its own side
// compatibly with the other participants. Reads element.elementInterfaces
// directly (Tier 2) rather than the project-wide interfaceDefinitions list
// (Tier 1) — the whole point of the two-tier model is that the coding
// prompt only ever needs what's already denormalized onto this element.
function relevantInterfaceDefinitions(
  project: Project,
  architectureElementId: string,
): ElementInterfaceDefinition[] {
  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  return element?.elementInterfaces ?? [];
}

function otherParticipantNames(
  project: Project,
  architectureElementId: string,
  masterDefinitionId: string,
): string {
  const definition = (project.architecture?.interfaceDefinitions ?? []).find(
    (d) => d.id === masterDefinitionId,
  );
  if (!definition) return masterDefinitionId;
  return definition.participants
    .filter((p) => p.elementId !== architectureElementId)
    .map((p) => formatElement(project, p.elementId))
    .join(", ");
}

// Self-review/refactor is baked into the outbound prompt unconditionally
// (Area D, resolved) — there is no separate manual review step in this
// pipeline, so the Dev persona is always instructed to review and refactor
// its own change before finishing.
const SELF_REVIEW_INSTRUCTION = `Before finishing, review your own changes for correctness, and refactor for
clarity. Favour reusing existing code already in this subfolder over
duplicating logic.`;

// The harness's counterpart. SELF_REVIEW_INSTRUCTION's "reuse code in this
// subfolder" is wrong for the harness (it writes at the src root plus
// _harness/, not one subfolder), and "review your own changes" with no
// stated source invited a re-read of the file it had just written. This
// variant reviews from context against the manifest instead.
const HARNESS_SELF_REVIEW_INSTRUCTION = `Before finishing, review the wiring you just wrote for correctness — from what you already have in context, without re-reading your own files. Check that every element in the manifest is constructed, every declared connection is actually made, and every import path and imported name matches the manifest exactly.`;

// Mandatory SW-test instruction (Area F follow-up): every Coding run must
// leave behind at least one directly-runnable test file for the element it
// just built, so Test Execution's "SW tests (Coding)" column is never empty
// and the code's own behaviour is checked as part of the run. The runner
// (vic-testing/runExecution.ts) executes each "*.test.<ext>" file as a plain
// standalone script picked by extension (.mjs/.cjs/.js -> node, .py ->
// python) — NOT through a framework runner — so the files must be
// self-contained and exit non-zero on failure, exactly like the files Test
// Creation's own generator produces. runCodingForElement hard-rejects a run
// that produced none (see the test-file guard below), the same way it
// already rejects a run that wrote no code at all.
//
// No path prefix is interpolated here anymore (T1.1): the CLI already runs
// with cwd == this element's own folder (see withIsolatedElementWorkspace —
// fs.cp of a directory copies its CONTENTS, so the isolated root IS the
// element folder). Telling the agent to write "under <prefix>/" made it
// create a doubled <element>/<element>/ folder.
function swTestInstruction(): string {
  return `You MUST also write at least one automated test file for this element, alongside the code, directly in your working directory. Requirements for these test files:
- Name each one "<something>.test.<ext>" (e.g. movement.test.mjs, ai-opponent.test.py) so the runner can discover it — a file whose name does not contain ".test." will never be found or run.
- Use one of these extensions ONLY: .mjs, .cjs, or .js (run with \`node\`), or .py (run with \`python\`). A .test.ts / .test.jsx file IS discovered but is then silently skipped — it will never run. If the code under test is TypeScript, write the test in .mjs against the plain-JS entry point.
- It must be a single, self-contained, directly-runnable script: runnable on its own as "node <file>" (for .mjs/.cjs/.js) or "python <file>" (for .py), from your working directory, with no framework runner, no package.json script, and no external test dependency. Node's built-in "node:assert" / "node:test", or Python's "assert" / "unittest", are fine.
- It must exit with a non-zero status code when any assertion fails and zero when all pass.
- Cover this element's core behaviour and its side of every interface contract listed above.
- Tag each test with the requirement id(s) it covers as a leading comment, e.g. \`// covers: IMP_REQ-007\` — one such comment per requirement the test exercises. Every requirement listed above must be covered by at least one test.
- Do NOT append any non-code text (no "RUN:" line, no notes) to the test file — it has to execute cleanly by itself.
- Before you finish, ACTUALLY RUN each test file you wrote (e.g. \`node <file>\` / \`python <file>\` from your working directory) and make sure every one exits zero. If a test fails, fix the code (or the test, if the test itself is wrong) and re-run until all pass. Do not finish with a failing or un-run test.`;
}

// Most recent run with status 'success' for this element, or undefined if
// it has never successfully completed one — the single lookup both
// interfaceChangedSinceLastCoding and classifyCodingTaskReason need to know
// whether this is the element's first build.
function lastSuccessfulCodingRun(
  project: Project,
  architectureElementId: string,
) {
  return (project.codingRuns ?? [])
    .filter(
      (r) =>
        r.architectureElementId === architectureElementId &&
        r.status === "success",
    )
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .at(-1);
}

// What kind of Coding task this run actually is, driving buildCodingPrompt's
// task-specific framing sentence (Area D follow-up: "tell the LLM what it's
// doing" instead of sending the identical prompt for every trigger).
// Priority order matters: fromScratch is a hard UI choice that overrides
// everything else; interfaceChangedSinceLastCoding is a live, always-
// current signal so it's checked before the one-shot stored
// pendingRecodeReason flag; initial-build only applies with no prior
// success at all; manual-recode is the fallback when nothing more specific
// is known (plain "Update Code" click with no fresh driver).
export type CodingTaskReason =
  | "rebuild-from-scratch"
  | "interface-update"
  | "initial-build"
  | "requirement-update"
  | "user-reported-issue"
  | "manual-recode";

export function classifyCodingTaskReason(
  project: Project,
  architectureElementId: string,
  fromScratch: boolean,
): CodingTaskReason {
  if (fromScratch) return "rebuild-from-scratch";
  if (interfaceChangedSinceLastCoding(project, architectureElementId))
    return "interface-update";
  if (!lastSuccessfulCodingRun(project, architectureElementId))
    return "initial-build";
  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (element?.pendingRecodeReason === "requirement-update")
    return "requirement-update";
  if (element?.pendingRecodeReason === "user-reported-issue")
    return "user-reported-issue";
  return "manual-recode";
}

const TASK_REASON_FRAMING: Record<CodingTaskReason, string> = {
  "initial-build":
    "You are implementing this architecture element for the first time — there is no existing code yet.",
  "requirement-update":
    "You are updating this element's existing code because one of its requirements changed. Review the current implementation, then make the necessary changes — preserve working behavior for anything not affected by the requirement change below.",
  "interface-update":
    "You are updating this element's existing code because one of its interface contracts changed. Update this element's side of the contract to match; do not change unrelated behavior.",
  "rebuild-from-scratch":
    "You are rebuilding this element's code from scratch — its folder has just been cleared. Ignore any assumptions about prior code; write a complete fresh implementation.",
  "user-reported-issue":
    "You are fixing this element's existing code because a user testing it reported a problem (see their description below). Review the current implementation, reproduce the issue in your head against their description, then make the necessary changes — preserve working behavior for anything not affected by the reported issue.",
  "manual-recode":
    "You are revising this element's existing code (a manual re-code request). Review the current implementation and the requirements/interfaces below, then make the necessary changes.",
};

// Standing framing for every NON-harness element (project harness feature)
// — makes the write-scope isolation semantic, not just a filesystem wall.
// Without this, an element with nothing telling it otherwise sometimes
// invents an index.html / main() of its own, which is exactly the run-to-
// run variability the harness element exists to remove.
const NON_HARNESS_ELEMENT_FRAMING = `You are implementing ONE element of a larger project. Do NOT create an
entry point, index.html, main(), bootstrap, or any wiring/composition
between elements — a separate Harness element owns all of that. Implement
only this element's own defined functionality, exposed through its defined
interfaces below. Assume the other elements and the Harness already exist
and call you through those interfaces.

Do NOT run \`npm install\`, \`npm init\`, \`pip install\`, or add any package
manifest or dependency. This element must run with only the language's
standard library — no node_modules, no external packages. If you think you
need a dependency, you have misread the task: use built-ins instead.`;

// Extra, platform-specific packaging rules for a non-harness element — how
// its folder must be shaped so the Harness can wire it on that platform
// without a build step. Only 'web' currently needs this (native ES modules
// served over http, so every import path is explicit and each element has
// exactly one predictable entry file); other platforms' native toolchains
// resolve imports themselves and need no extra instruction here.
function nonHarnessPlatformPackaging(
  platform?: PlatformDescriptor,
): string | undefined {
  if (platform?.id === "web") {
    return `This is a browser Web App run as plain ES modules served over http — there is NO bundler or build step. Package this element's folder so the Harness can import it directly:
- Expose everything the Harness or other elements need through a single entry file at \`index.js\` in the root of your working directory, using named \`export\`s. Do not rely on a default export.
- Every import you write (here or in any other file in this folder) must be a RELATIVE path ending in \`.js\` (e.g. \`import { grid } from './grid.js'\`) — browsers do not resolve extensionless or bare specifiers.
- Split into as many files in your working directory as is natural, but they must all be plain \`.js\` ES modules that load with no transform.
- No \`window.*\` globals, no \`require\`, no CommonJS, no reference to \`process\` or Node built-ins. Browser APIs only.`;
  }
  return undefined;
}

// T3.3: what the previous iteration of the coding loop left behind, so
// iteration N+1's prompt can name exactly what still needs fixing rather
// than re-sending the identical brief. Distinct from the persisted
// project.codingRuns history (which serves the NEXT manual click) —
// in-loop, the previous iteration's result is passed directly.
export interface PriorAttemptFeedback {
  attemptNumber: number; // 1-based index of the attempt that just finished
  maxAttempts: number;
  status: CodingRunStatus;
  failingTests?: Array<{ name: string; output: string }>;
  uncoveredRequirementIds?: string[];
  wroteNoTestFile?: boolean;
}

export function buildCodingPrompt(
  project: Project,
  architectureElementId: string,
  allowedRelativePrefix: string,
  reason: CodingTaskReason,
  platform?: PlatformDescriptor,
  priorAttempt?: PriorAttemptFeedback,
  // Per-element exported-API manifest, read fresh from the source tree by
  // runHarnessCoding just before this call. Only meaningful for the
  // kind:'harness' element; ignored otherwise. Absent = fall back to the
  // pre-manifest behaviour (declared contract only, agent reads files).
  elementApis?: ElementApi[],
): string {
  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (element?.kind === "harness") {
    return buildHarnessCodingPrompt(project, element, platform, elementApis);
  }

  const parts: string[] = [];

  if (project.description) {
    parts.push(`Project overview:\n${project.description}`);
  }
  if (project.runInstructions) {
    parts.push(`How this project is built/run:\n${project.runInstructions}`);
  }

  parts.push(TASK_REASON_FRAMING[reason]);
  if (reason === "user-reported-issue") {
    if (element?.pendingRecodeDetail) {
      parts.push(`User's reported issue:\n${element.pendingRecodeDetail}`);
    }
  }
  parts.push(NON_HARNESS_ELEMENT_FRAMING);
  const platformPackaging = nonHarnessPlatformPackaging(platform);
  if (platformPackaging) parts.push(platformPackaging);
  // T1.1: the CLI's cwd already IS this element's own folder (the isolated
  // workspace is a copy of just this folder's contents), so "your working
  // directory" is the whole scope — there is no <prefix>/ to nest under.
  parts.push(
    `Your working directory IS this element's own folder. Create and modify files directly in it. Do NOT create a "${allowedRelativePrefix}" subfolder inside it (or any other wrapper folder) — everything you write is already scoped to this element. You cannot reach any other element's files from here.`,
  );

  parts.push("This is the architecture element you are implementing:");
  parts.push(formatElement(project, architectureElementId));

  const requirements = requirementsAllocatedToElement(
    project,
    architectureElementId,
  );
  if (requirements.length > 0) {
    parts.push("Requirements currently allocated to this element:");
    parts.push(formatRequirements(requirements));
  }

  const interfaces = relevantInterfaceDefinitions(
    project,
    architectureElementId,
  );
  for (const entry of interfaces) {
    if (entry.operations.length === 0) continue;
    const others = otherParticipantNames(
      project,
      architectureElementId,
      entry.masterDefinitionId,
    );
    const roleText =
      entry.role === "both"
        ? "both produces and consumes it"
        : `${entry.role} it`;
    parts.push(`Interface contract with ${others} (this element ${roleText}):`);
    parts.push(
      entry.operations
        .map((op) => {
          const ioDetail = [
            op.range && `range: ${op.range}`,
            op.resolution && `resolution: ${op.resolution}`,
            op.unit && `unit: ${op.unit}`,
            op.drivenDirectly
              ? "driven directly (not periodic)"
              : op.updateFrequency &&
                `min update frequency: ${op.updateFrequency}`,
          ]
            .filter(Boolean)
            .join(", ");
          return `- ${op.name}: ${op.description} (request: ${op.request}; response: ${op.response}${ioDetail ? `; ${ioDetail}` : ""})`;
        })
        .join("\n"),
    );
  }

  if (project.codingConventions) {
    parts.push(`Coding conventions to follow:\n${project.codingConventions}`);
  }

  // Feedback for iteration N+1 of the coding loop (T3.3). When priorAttempt
  // is given it is authoritative and specific; otherwise fall back to the
  // persisted history lookup, which still serves a plain "Update Code" click
  // that follows an earlier failing run.
  if (priorAttempt) {
    parts.push(
      `This is attempt ${priorAttempt.attemptNumber + 1} of up to ${priorAttempt.maxAttempts} for this element. Your previous attempt did not finish the job — details below. Fix the code (or the test, if the test itself is wrong), re-run every test file, and do not stop until they all pass and every requirement is covered.`,
    );
    if (priorAttempt.wroteNoTestFile) {
      parts.push(
        `Your previous attempt wrote code but NO runnable "*.test.<ext>" file. You MUST write at least one this time.`,
      );
    }
    if (priorAttempt.failingTests && priorAttempt.failingTests.length > 0) {
      parts.push(
        `These test files FAILED on the previous attempt — make them pass:\n` +
          priorAttempt.failingTests
            .map((f) => `- ${f.name}:\n${f.output.split("\n").slice(0, 20).join("\n")}`)
            .join("\n\n"),
      );
    }
    if (priorAttempt.uncoveredRequirementIds && priorAttempt.uncoveredRequirementIds.length > 0) {
      parts.push(
        `These allocated requirements have NO test covering them yet — add tests (tagged \`// covers: <id>\`) that exercise them: ${priorAttempt.uncoveredRequirementIds.join(", ")}.`,
      );
    }
  } else {
    const lastRun = (project.codingRuns ?? [])
      .filter((r) => r.architectureElementId === architectureElementId)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
      .at(-1);
    if (lastRun?.swTestResult && !lastRun.swTestResult.passed) {
      const failing = lastRun.swTestResult.files.filter((f) => !f.passed);
      parts.push(
        `The previous Coding run for this element left FAILING automated tests. You MUST make these pass this time (fix the code, or the test if the test itself is wrong), and re-run them to confirm:\n` +
          failing
            .map((f) => `- ${f.name}:\n${f.output.split("\n").slice(0, 20).join("\n")}`)
            .join("\n\n"),
      );
    }
  }

  parts.push(swTestInstruction());
  parts.push(SELF_REVIEW_INSTRUCTION);
  return parts.join("\n\n");
}

// One element's InterfaceElementDeclaration, merged across every interface
// definition it participates in (see the merge block in
// buildHarnessCodingPrompt and the InterfaceElementDeclaration doc comment
// in types.ts).
interface MergedElementDeclaration {
  does: string;
  exposes: string[];
  owns: string[];
  visibleTo: string[];
}

// Renders a merged declaration into the one-line "contract:" summary shown
// per element in the harness's "Elements to instantiate and wire" block.
// Omits any of the four parts that carry nothing rather than printing an
// empty placeholder.
function formatMergedDeclaration(decl: MergedElementDeclaration): string {
  const bits: string[] = [];
  bits.push(`exposes: ${decl.exposes.join("; ") || "none"}`);
  if (decl.owns.length > 0) bits.push(`owns: ${decl.owns.join("; ")}`);
  if (
    decl.visibleTo.length > 0 &&
    decl.visibleTo[0] !== "none" &&
    decl.visibleTo[0] !== "all"
  ) {
    bits.push(`data visible to: ${decl.visibleTo.join(", ")}`);
  } else if (decl.visibleTo[0] === "all") {
    bits.push("data visible to: all");
  }
  return `contract: ${bits.join(" — ")}`;
}

// Renders one export as the JS keyword the harness will type, e.g.
// "function createEngine(width, height)" or
// "class World { constructor(w, h); advance(dt) }".
function formatElementExport(e: ElementExport): string {
  if (e.kind === "class") {
    const methods = e.methods ?? [];
    return methods.length > 0
      ? `class ${e.name} { ${methods.join("; ")} }`
      : `class ${e.name}`;
  }
  if (e.kind === "function") return `function ${e.name}(${e.params ?? ""})`;
  return `const ${e.name}`;
}

// The "code:" line(s) for one element, driven by the freshly-read API
// manifest. Three degradation branches, each with a different instruction
// to the harness so the prompt never implies an API that wasn't observed:
//   - no manifest / non-web platform  -> caller omits the code line entirely
//   - manifest present, entryFile set, not scanned  -> "open this one file"
//   - manifest present, no entryFile (folder/file missing)  -> "NOT YET WRITTEN"
//   - scanned with exports  -> the real signatures, indented
function formatElementCodeLines(api: ElementApi | undefined): string[] {
  if (!api || !api.entryFile) return [];
  const importPath = `./${api.folder}/${api.entryFile}`;
  if (!api.scanned) {
    return [
      `  code: ${importPath} — NOT YET WRITTEN (no code here yet, or its exports can't be read); open this file if it exists, otherwise wire from the contract above`,
    ];
  }
  if (api.exports.length === 0) {
    return [
      `  code: ${importPath} — no named exports found; open this file to check what it exports`,
    ];
  }
  return [
    `  code: ${importPath}`,
    ...api.exports.map((e) => `    ${formatElementExport(e)}`),
  ];
}

// The harness element's own prompt (project harness feature). It is the
// composition root: it may write the src-tree root (the entry point) and
// its own _harness/ folder, may READ every element's folder, and must NOT
// modify any element's folder — if it thinks one needs changing it must
// stop and say so (it may signal a missing requirement or interface).
function buildHarnessCodingPrompt(
  project: Project,
  harness: ArchitectureElement,
  platform?: PlatformDescriptor,
  elementApis?: ElementApi[],
): string {
  const parts: string[] = [];
  const architecture = project.architecture;
  const others = (architecture?.elements ?? []).filter(
    (e) => e.kind !== "harness",
  );
  const definitions = architecture?.interfaceDefinitions ?? [];

  if (project.description)
    parts.push(`Project overview:\n${project.description}`);
  if (project.runInstructions)
    parts.push(`How this project is built/run:\n${project.runInstructions}`);

  parts.push(
    "You are the HARNESS — the single composition root and entry point for this whole project. " +
      "Your only job: own the platform entry point, instantiate every element, wire the declared " +
      "connections between elements, and drive the run lifecycle. You write NO functional logic of your own.",
  );

  if (platform) {
    parts.push(
      [
        `Target platform: ${platform.label}`,
        `Entry point on this platform: ${platform.entryPointHint}`,
        `Wiring on this platform: ${platform.wiringHint}`,
        `Run lifecycle on this platform: ${platform.lifecycleHint}`,
      ].join("\n"),
    );
  }

  if (platform?.id === "web") {
    parts.push(
      `Concrete web wiring (NO bundler, NO framework, NO build step — plain ES modules served over http):
1. Write index.html at the src root. Its ONLY script tag is: <script type="module" src="./main.js"></script>. Put any needed DOM scaffold (a <canvas>, root <div>, etc.) and a <link rel="stylesheet"> if the elements need shared CSS.
2. Write main.js at the src root. Import each element from the exact path given on its "code:" line in the element manifest below, using the exact exported names listed there, then construct each element, connect them per the interface contracts, and start the run loop / event listeners.
3. EVERY import path in main.js is relative and ends in ".js" (browsers do not resolve extensionless or bare specifiers). If an element's manifest entry says its API is not yet readable, STOP and report it rather than reaching into its internal files.
4. Do NOT create a package.json, bundler config, index.mjs, or any Node-only code. main.js runs directly in the browser.`,
    );
  }

  const entryHints = platform
    ? harnessRootWritePrefixesForPlatform(platform.id)
    : ["main.ts", "index.ts", "index.html"];
  // Whether the manifest below actually carries scanned APIs — drives the
  // read-discipline wording. On non-web platforms (no manifest, or every
  // entry unscanned) keep the old "read the folders" permission.
  const manifestHasApis = (elementApis ?? []).some(
    (a) => a.scanned && a.exports.length > 0,
  );
  const readDiscipline = manifestHasApis
    ? `The element manifest below lists every element's folder, its declared contract, and its ACTUAL exported API — read straight from each entry file moments ago. Treat it as current and correct: do NOT glob, list, or read element folders to rediscover what the manifest already states. Read inside an element's folder ONLY when its manifest entry says the API is not yet readable, or when you have tried the manifest's API and it demonstrably does not match the file.`
    : `You MAY READ every element's folder to see what it exports.`;
  parts.push(
    `You MAY create or modify: (a) any file under ${HARNESS_SUBFOLDER_NAME}/; (b) the project entry point at the ` +
      `root of your working directory — suggested name(s) for this platform: ${entryHints.join(", ")}. ` +
      `${readDiscipline} You MUST NOT modify any file inside another ` +
      `element's folder — if you believe an element's code needs to change, STOP and say so in your output ` +
      `(it may mean a requirement or interface is missing). Also (re)write ${HARNESS_SUBFOLDER_NAME}/HARNESS.md ` +
      `containing the narrative below and a table of each connection's realisation.`,
  );

  const spec = harness.harnessSpec;
  if (spec) {
    if (spec.narrative)
      parts.push(
        `Harness narrative (write this into HARNESS.md):\n${spec.narrative}`,
      );
    const applies = spec.checklist.filter((c) => c.status === "applies");
    if (applies.length > 0) {
      parts.push(
        "Harness concerns that apply on this platform:\n" +
          applies.map((c) => `- ${c.key}: ${c.realisation}`).join("\n"),
      );
    }
    if (spec.linkRealisations.length > 0) {
      const byId = new Map(definitions.map((d) => [d.id, d]));
      parts.push(
        "How each inter-element connection is realised (implement the wiring to match, and list these in HARNESS.md):\n" +
          spec.linkRealisations
            .map((lr) => {
              const def = byId.get(lr.masterDefinitionId);
              const label = def
                ? `${def.name} (${def.participants.map((p) => p.elementId).join(" <-> ")})`
                : lr.masterDefinitionId;
              return `- ${label}: ${lr.summary}`;
            })
            .join("\n"),
      );
    }
  }

  if (others.length > 0) {
    // Merge each element's InterfaceElementDeclaration across EVERY definition
    // it participates in — union of exposes/owns, last-writer-wins for
    // does/visibleTo — exactly as types.ts's InterfaceElementDeclaration doc
    // comment specifies ("Merged by elementId across every definition… The
    // harness reads these to know what to wire without having to read every
    // element's source"). mergeDeclarations in vic-requirements-elicitation
    // does this WITHIN one definition; the cross-definition merge was always
    // meant to happen here, at read time, and previously didn't (only the
    // first declaration was used).
    const declByElement = new Map<string, MergedElementDeclaration>();
    for (const def of definitions) {
      for (const decl of def.declarations ?? []) {
        const prev = declByElement.get(decl.elementId);
        declByElement.set(decl.elementId, {
          does: decl.does || prev?.does || "",
          exposes: Array.from(
            new Set([...(prev?.exposes ?? []), ...decl.exposes]),
          ),
          owns: Array.from(new Set([...(prev?.owns ?? []), ...decl.owns])),
          visibleTo:
            decl.visibleTo.length > 0 && decl.visibleTo[0] !== "none"
              ? decl.visibleTo
              : (prev?.visibleTo ?? []),
        });
      }
    }
    const apiById = new Map((elementApis ?? []).map((a) => [a.elementId, a]));
    // "NOT YET WRITTEN" is rendered when the manifest expects an entry file
    // (entryFile set) but couldn't read it (scanned false).
    const anyNotWritten = others.some((e) => {
      const api = apiById.get(e.id);
      return !!api && !!api.entryFile && !api.scanned;
    });
    const header = manifestHasApis
      ? `Elements to instantiate and wire. The "code:" line for each element is its ACTUAL exported API, read from its entry file just now — import exactly those names, with those parameters, from that path.`
      : `Elements to instantiate and wire. This platform has no single mandated entry file per element, so no concrete API is listed — read each element's folder to see what it exposes before wiring it.`;
    const stanzas = others.map((e) => {
      const decl = declByElement.get(e.id);
      const lines = [`- ${e.id} ${e.name} — folder: ${elementSubfolderName(e)}`];
      if (decl?.does) lines.push(`  does: ${decl.does}`);
      else if (e.responsibility) lines.push(`  does: ${e.responsibility}`);
      if (decl) lines.push(`  ${formatMergedDeclaration(decl)}`);
      lines.push(...formatElementCodeLines(apiById.get(e.id)));
      return lines.join("\n");
    });
    const footer = anyNotWritten
      ? `\n\nSome elements have no code yet (marked NOT YET WRITTEN). Wire them from their declared contract above, importing the names it lists from that path, and note in HARNESS.md that the wiring is provisional.`
      : "";
    parts.push(`${header}\n${stanzas.join("\n")}${footer}`);
  }

  if (project.codingConventions)
    parts.push(`Coding conventions to follow:\n${project.codingConventions}`);
  // The harness must also leave behind at least one runnable test file, so
  // Test Execution's harness SW-tests column isn't permanently empty. It
  // lives at the source-tree root or under _harness/ (the runner sweeps
  // both — see vic-testing/runExecution.ts findHarnessTestFiles). The rules
  // here mirror the per-element swTestInstruction()'s hard-won specifics
  // (the silently-skipped .test.ts trap, the extension whitelist, no
  // trailing non-code text) plus one harness-only hazard: the test runs
  // under node while the app's code, on web, is browser ES modules.
  parts.push(
    `You MUST also write at least one automated test file for the assembled app. Requirements:
- Name it "<something>.test.<ext>" (e.g. wiring.test.mjs), placed either at the source-tree root or under ${HARNESS_SUBFOLDER_NAME}/. A file whose name does not contain ".test." will never be discovered or run.
- Use one of these extensions ONLY: .mjs, .cjs, or .js (run with \`node\`), or .py (run with \`python\`). A .test.ts / .test.jsx file IS discovered but is then silently skipped — it will never run.
- It must be a single, self-contained, directly-runnable script (\`node <file>\` / \`python <file>\`, no framework runner, no package.json script, no external test dependency — node:assert / node:test or Python's assert / unittest are fine), and exit non-zero on failure, zero on success.
- Do NOT append any non-code text (no "RUN:" line, no notes) to the test file — it has to execute cleanly by itself.
- It must verify the elements are wired together correctly: that the harness constructs each element and the declared connections are actually made.
- Your test runs under \`node\`, but on the web platform the app's code is browser ES modules — importing a module that touches \`document\`/\`window\`/\`canvas\` at load time throws a ReferenceError before any assertion runs. Do NOT import index.html or any module whose top level touches the DOM. Instead import each element's ./<folder>/index.js directly, assert the exports main.js depends on exist and are callable, and assert the connections the contracts describe can be made. If a connection genuinely cannot be exercised without a DOM, assert the structural precondition instead and say so in a comment.
- Run it before finishing and make sure it passes. If it fails, fix the code (or the test, if the test itself is wrong) and re-run until it passes.`,
  );
  parts.push(HARNESS_SELF_REVIEW_INSTRUCTION);
  return parts.join("\n\n");
}

// The harness Coding gate (project harness feature) — replaces
// isElementEligibleForCoding for the kind:'harness' element. The harness
// has no allocated requirements, and (by user decision) may be coded early,
// before every element has been built. All it needs is a chosen platform
// and a harness spec derived for that same platform. Returns a
// human-readable reason when blocked, or undefined when good to run.
export function harnessGateReason(
  project: Project,
  platform?: PlatformDescriptor,
): string | undefined {
  if (!project.platform) {
    return "No platform is selected for this project — pick one on the Architecture screen before coding the Harness.";
  }
  if (!platform) {
    return `The selected platform (${project.platform}) could not be resolved — it may be a custom platform that was deleted.`;
  }
  const harness = project.architecture?.elements.find(
    (e) => e.kind === "harness",
  );
  const spec = harness?.harnessSpec;
  if (!spec) {
    return "The Harness has not been derived yet — run Define Harness on the Architecture screen first.";
  }
  if (spec.derivedForPlatform !== project.platform) {
    return `The Harness was derived for platform "${spec.derivedForPlatform}" but the project's platform is now "${project.platform}" — run Define Harness again first.`;
  }
  return undefined;
}

// The Coding-tab "needs re-coding" trigger (Area B/D, resolved) — distinct
// from, and sequenced after, interfaceGateReasonForElement's hard block:
// while any of this element's own interface copies is aligned:false, the
// element is blocked (surfaced by the gate above), not "needs re-coding".
// Only once every copy is back to aligned:true (a human has reconciled it)
// AND the master moved since this element's code was last generated does
// this report true — the review is done, the block is lifted, but the
// element's actual source still reflects the pre-change interface.
export function interfaceChangedSinceLastCoding(
  project: Project,
  architectureElementId: string,
): boolean {
  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (!element) return false;
  if (element.elementInterfaces.some((ei) => !ei.aligned)) return false;

  const lastSuccess = (project.codingRuns ?? [])
    .filter(
      (r) =>
        r.architectureElementId === architectureElementId &&
        r.status === "success",
    )
    .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt))
    .at(-1);
  if (!lastSuccess) return false;

  const definitionsById = new Map(
    (project.architecture?.interfaceDefinitions ?? []).map((d) => [d.id, d]),
  );
  return element.elementInterfaces.some((ei) => {
    const definition = definitionsById.get(ei.masterDefinitionId);
    return definition ? definition.updatedAt > lastSuccess.finishedAt : false;
  });
}

export interface RunCodingOptions {
  model?: string;
  effort?: string;
  permissionMode?: string;
  // Whether the caller already wiped this element's folder before this call
  // (server route's wipeScopedSubfolder, "Code All") — purely a prompt-
  // classification signal here (classifyCodingTaskReason), the wipe itself
  // already happened by the time runCodingForElement runs.
  fromScratch?: boolean;
  // Test injection seam, threaded through to the agent client.
  binary?: string;
  binaryArgs?: string[];
  // Provider-routing fields, only meaningful to OpenCodeAgentClient (ignored
  // by ClaudeCodeAgentClient) — see CodingAgentClient/AgentRunOptions.
  apiKey?: string;
  baseUrl?: string;
  thinking?: string;
  reasoningEffort?: string;
  // Forwarded straight through to the agent client's own onChunk — lets a
  // caller (the server route) observe live CLI output while this run is
  // still in progress. See AgentRunOptions.onChunk for the full rationale.
  onChunk?: (chunk: string) => void;
  // Forwarded straight through to the agent client's own signal — lets a
  // caller (the server route) time out or cancel the underlying CLI
  // subprocess. See AgentRunOptions.signal for the full rationale.
  signal?: AbortSignal;
  // Resolved PlatformDescriptor for project.platform, incl. custom
  // platforms (project harness feature). The server route resolves this
  // from BUILT_IN_PLATFORMS + its custom-platform store and passes it in —
  // runCoding can't resolve a custom platform on its own. Only consulted
  // for a kind:'harness' element; ignored otherwise.
  platform?: PlatformDescriptor;
  // T3.4: override the loop's iteration cap / wall-clock budget. Defaults
  // MAX_CODING_ITERATIONS / ITERATION_BUDGET_MS. A project setting could
  // feed these; the server route passes them through.
  maxIterations?: number;
  iterationBudgetMs?: number;
}

// T3.4: backstops against a pathological non-terminating loop — NOT the
// primary control (stall detection is). With a resumed session and a real
// done-signal, a converging element finishes in 2-3 iterations.
export const MAX_CODING_ITERATIONS = 8;
export const ITERATION_BUDGET_MS = 40 * 60 * 1000;

// Top-level orchestration for one "Run Coding" invocation against a single
// architecture element: check eligibility up front (no CLI cost for an
// element with nothing pending), scaffold, snapshot, invoke the agent, and
// either commit an in-scope change or revert an out-of-scope one. Every
// path returns a fully-populated CodingRun — the caller (server route) is
// responsible for persisting it and advancing requirement status. No
// scope-resolution/rejection step exists anymore — every run targets
// exactly one element's own folder (elementSubfolderName), so there is
// nothing to reject before invoking the CLI.
export async function runCodingForElement(
  project: Project,
  projectDir: string,
  architectureElementId: string,
  agentClient: CodingAgentClient,
  options: RunCodingOptions = {},
): Promise<CodingRun> {
  const startedAt = new Date().toISOString();

  const targetElement = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (targetElement?.kind === "harness") {
    return runHarnessCoding(
      project,
      projectDir,
      targetElement,
      agentClient,
      options,
      startedAt,
    );
  }

  if (!isElementEligibleForCoding(project, architectureElementId)) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "rejected-not-eligible",
      diff: "",
      rawLog:
        "None of this element's allocated requirements are at 'allocated' status — nothing impacted by a failing test or a requirement change, so this module has no pending work for Coding to do.",
      exitCode: null,
      allowedSubfolder: "",
    };
  }

  const interfaceGateReason = interfaceGateReasonForElement(
    project,
    architectureElementId,
  );
  if (interfaceGateReason) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "rejected-not-eligible",
      diff: "",
      rawLog: interfaceGateReason,
      exitCode: null,
      allowedSubfolder: "",
    };
  }

  const element = project.architecture?.elements.find(
    (e) => e.id === architectureElementId,
  );
  if (!element) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "rejected-not-eligible",
      diff: "",
      rawLog: `Architecture element ${architectureElementId} not found.`,
      exitCode: null,
      allowedSubfolder: "",
    };
  }

  const allowedRelativePrefix = elementSubfolderName(element);

  // Every filesystem operation this run performs (scaffold, git init/commit,
  // the per-element isolate/merge cycle) happens against a LOCAL working
  // copy of the project's src/ tree, not directly against projectDir (which
  // is commonly a mapped network/SMB drive — see localSourceTree.ts for why:
  // in-place churn there has independently produced five different
  // reproducible SMB errors across mkdir/rm/rename). The real projectDir is
  // only touched twice — once to copy this tree down, once to sync the
  // finished result back up — both via openLocalSourceTree/
  // syncBackAndDispose. syncBackAndDispose must run on every exit path once
  // the local session is open, success or failure, so the local temp copy
  // never leaks and (on failure) the real srcRoot is left exactly as it was
  // — hence the try/finally wrapping the entire remainder of this function.
  const requirementIds = requirementsAllocatedToElement(
    project,
    architectureElementId,
  ).map((r) => r.id);
  const maxIterations = options.maxIterations ?? MAX_CODING_ITERATIONS;
  const iterationBudgetMs = options.iterationBudgetMs ?? ITERATION_BUDGET_MS;

  const localSession = await openLocalSourceTree(sourceTreeRoot(projectDir));
  try {
    // "Recode from scratch" (fromScratch:true) wipes this element's own
    // folder once, before the loop — a wipe must not repeat per iteration
    // (iteration N+1 builds on N's committed code).
    if (options.fromScratch) {
      await wipeScopedSubfolder(
        localSession.localProjectDir,
        allowedRelativePrefix,
      );
    }
    await scaffoldProjectSourceTree(project, localSession.localProjectDir);
    const srcRoot = localSession.localSrcRoot;
    await gitInitIfNeeded(srcRoot);

    const reason = classifyCodingTaskReason(
      project,
      architectureElementId,
      options.fromScratch ?? false,
    );
    // Consumed by the first iteration's prompt; a follow-up manual click
    // falls back to classifyCodingTaskReason's other live signals.
    element.pendingRecodeReason = undefined;
    element.pendingRecodeDetail = undefined;

    const t0 = Date.now();
    const iterationHistory: NonNullable<CodingRun["iterationHistory"]> = [];
    let resumeSessionId: string | undefined;
    let prevFailingNames: string[] | null = null;
    let lastResult: CodingRun | null = null;
    // The most complete run seen so far — a committed 'success'/'rejected-
    // no-tests' beats a later 'rejected-empty-output' (a no-op follow-up
    // iteration must not erase the real work an earlier one landed).
    let bestResult: CodingRun | null = null;
    const rank = (s: CodingRunStatus): number =>
      s === "success"
        ? 3
        : s === "rejected-no-tests"
          ? 2
          : s === "rejected-empty-output"
            ? 1
            : 0;

    for (let attempt = 0; attempt < maxIterations; attempt++) {
      if (options.signal?.aborted) {
        return finalizeLoop(lastResult, iterationHistory, "cancelled");
      }
      if (attempt > 0 && Date.now() - t0 > iterationBudgetMs) {
        return finalizeLoop(lastResult, iterationHistory, "budget");
      }

      options.onChunk?.(`\n=== Iteration ${attempt + 1}/${maxIterations} ===\n`);

      const priorAttempt: PriorAttemptFeedback | undefined =
        attempt === 0 || !lastResult
          ? undefined
          : {
              attemptNumber: attempt,
              maxAttempts: maxIterations,
              status: lastResult.status,
              failingTests: lastResult.swTestResult?.files
                .filter((f) => !f.passed)
                .map((f) => ({ name: f.name, output: f.output })),
              uncoveredRequirementIds:
                iterationHistory[attempt - 1]?.uncoveredRequirementIds,
              wroteNoTestFile: lastResult.status === "rejected-no-tests",
            };

      // A resumed session already carries the full prior context, so its
      // prompt is a short continuation. A fresh (attempt 0, or post-resume-
      // rejection) prompt is the complete brief.
      const prompt = buildCodingPrompt(
        project,
        architectureElementId,
        allowedRelativePrefix,
        reason,
        options.platform,
        priorAttempt,
      );

      const iterResult = await runOneCodingIteration({
        project,
        element,
        architectureElementId,
        allowedRelativePrefix,
        srcRoot,
        agentClient,
        options,
        prompt,
        startedAt,
        resumeSessionId,
        requirementIds,
      });
      lastResult = iterResult.run;
      if (!bestResult || rank(iterResult.run.status) >= rank(bestResult.status)) {
        bestResult = iterResult.run;
      }
      resumeSessionId = iterResult.sessionId ?? resumeSessionId;

      iterationHistory.push({
        status: iterResult.run.status,
        swTestsPassed: iterResult.run.swTestResult?.passed,
        failingTestNames: iterResult.run.swTestResult?.files
          .filter((f) => !f.passed)
          .map((f) => f.name),
        uncoveredRequirementIds: iterResult.uncoveredRequirementIds,
      });

      // --- exit conditions (T3.4) --------------------------------------
      const s = iterResult.run.status;
      if (s === "cli-error") {
        // A crashed/timed-out CLI will crash again — return the best earlier
        // run if there is one, else the error itself.
        return finalizeLoop(bestResult ?? iterResult.run, iterationHistory, "cli-error");
      }
      if (s === "rejected-not-eligible") {
        return finalizeLoop(iterResult.run, iterationHistory, "rejected");
      }
      if (s === "rejected-empty-output" && attempt > 0) {
        // A repeat no-op after a real prior attempt isn't going to unstick.
        return finalizeLoop(bestResult, iterationHistory, "stalled");
      }

      const done =
        s === "success" &&
        iterResult.run.swTestResult?.passed === true &&
        (iterResult.uncoveredRequirementIds?.length ?? 0) === 0;
      if (done) {
        return finalizeLoop(iterResult.run, iterationHistory, "done");
      }

      // Stall: same failing-test set as last iteration AND no new code.
      const failingNames = (iterResult.run.swTestResult?.files ?? [])
        .filter((f) => !f.passed)
        .map((f) => f.name)
        .sort();
      const sameFailingSet =
        prevFailingNames !== null &&
        prevFailingNames.length === failingNames.length &&
        prevFailingNames.every((n, i) => n === failingNames[i]);
      const noNewCode = attempt > 0 && iterResult.run.diff === bestResult?.diff;
      if (attempt > 0 && sameFailingSet && noNewCode) {
        return finalizeLoop(bestResult, iterationHistory, "stalled");
      }
      prevFailingNames = failingNames;
    }

    return finalizeLoop(bestResult, iterationHistory, "cap");
  } finally {
    await localSession.syncBackAndDispose();
  }

  // Attaches the loop-level bookkeeping to whichever CodingRun the last
  // iteration produced, and downgrades a 'success' whose done-criteria
  // weren't met to 'success-tests-failing' so requirement status doesn't
  // advance and the element badge shows 'blocked' (T3.5).
  function finalizeLoop(
    last: CodingRun | null,
    history: NonNullable<CodingRun["iterationHistory"]>,
    stoppedBecause: NonNullable<CodingRun["stoppedBecause"]>,
  ): CodingRun {
    if (!last) {
      // No iteration ran at all (e.g. cancelled before attempt 0).
      return {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "cli-error",
        diff: "",
        rawLog: "Coding loop stopped before any iteration ran.",
        exitCode: null,
        allowedSubfolder: allowedRelativePrefix,
        iterations: 0,
        iterationHistory: history,
        stoppedBecause,
      };
    }
    // Coverage state for `last`: the most recent history entry whose status
    // matches `last` (best-effort — only a 'success' entry carries an
    // uncovered list anyway). If the done-criteria weren't met, downgrade
    // 'success' to 'success-tests-failing' so requirement status doesn't
    // advance and the element badge shows 'blocked' (T3.5).
    const matchingIter = [...history]
      .reverse()
      .find((h) => h.status === last.status);
    const codeButNotDone =
      last.status === "success" &&
      (last.swTestResult?.passed !== true ||
        (matchingIter?.uncoveredRequirementIds?.length ?? 0) > 0);
    return {
      ...last,
      status: codeButNotDone
        ? ("success-tests-failing" satisfies CodingRunStatus)
        : last.status,
      iterations: history.length,
      iterationHistory: history,
      stoppedBecause: codeButNotDone && stoppedBecause === "done" ? "cap" : stoppedBecause,
    };
  }
}

// One pass of the coding loop: invoke the agent (in the physical write-scope
// isolation of just this element's folder), classify the outcome exactly as
// the pre-loop single-shot code did, and — on a committed run with a test
// file — run the inline tests and compute requirement coverage. Returns the
// CodingRun for this iteration plus the loop-only extras (sessionId to
// resume, uncovered requirement ids). Does NOT itself decide whether to
// loop again — that's runCodingForElement's exit-condition block.
async function runOneCodingIteration(ctx: {
  project: Project;
  element: ArchitectureElement;
  architectureElementId: string;
  allowedRelativePrefix: string;
  srcRoot: string;
  agentClient: CodingAgentClient;
  options: RunCodingOptions;
  prompt: string;
  startedAt: string;
  resumeSessionId?: string;
  requirementIds: string[];
}): Promise<{
  run: CodingRun;
  sessionId?: string;
  uncoveredRequirementIds?: string[];
}> {
  const {
    element,
    architectureElementId,
    allowedRelativePrefix,
    srcRoot,
    agentClient,
    options,
    prompt,
    startedAt,
    resumeSessionId,
    requirementIds,
  } = ctx;

  let runResult;
  let diff: string;
  let changedPaths: string[];
  try {
    const runOnce = () =>
      withIsolatedElementWorkspace(srcRoot, allowedRelativePrefix, (isolatedCwd) =>
        agentClient.runAgentTask(prompt, {
          cwd: isolatedCwd,
          permissionMode: options.permissionMode ?? "acceptEdits",
          model: options.model,
          effort: options.effort,
          binary: options.binary,
          binaryArgs: options.binaryArgs,
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          thinking: options.thinking,
          reasoningEffort: options.reasoningEffort,
          onChunk: options.onChunk,
          signal: options.signal,
          resumeSessionId,
        }),
      );

    let isolated = await runOnce();
    // Legacy GLM-only single retry on a clean-but-empty run (kept — see the
    // original comment: opencode/z.ai can drop tool-call deltas mid-stream).
    if (
      isolated.changedPaths.length === 0 &&
      isolated.result.providerId === "opencode"
    ) {
      isolated = await runOnce();
    }
    runResult = isolated.result;
    diff = isolated.diff;
    changedPaths = isolated.changedPaths;
  } catch (err) {
    const rawLog = (err as { rawLog?: string }).rawLog ?? (err as Error).message;
    const exitCode = (err as { exitCode?: number | null }).exitCode ?? null;
    const timing = (err as { timing?: CodingRun["timing"] }).timing;
    return {
      run: {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "cli-error" satisfies CodingRunStatus,
        diff: "",
        rawLog,
        exitCode,
        allowedSubfolder: allowedRelativePrefix,
        model: options.model,
        timing,
      },
    };
  }

  const hasAddedContent = /^\+(?!\+\+)/m.test(diff);
  if (changedPaths.length === 0 || (diff.length > 0 && !hasAddedContent)) {
    return {
      run: {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "rejected-empty-output" satisfies CodingRunStatus,
        diff: "",
        rawLog: runResult.rawLog,
        exitCode: runResult.exitCode,
        allowedSubfolder: allowedRelativePrefix,
        usage: runResult.usage,
        providerId: runResult.providerId,
        model: options.model,
        timing: runResult.timing,
      },
      sessionId: runResult.sessionId,
    };
  }

  await gitCommitAll(srcRoot, `Coding: ${element.id} ${element.name}`);

  const TEST_FILE_PATTERN = /\.test\.[^./\\]+$/;
  const wroteTestFile = changedPaths.some((p) => TEST_FILE_PATTERN.test(p));
  if (!wroteTestFile) {
    return {
      run: {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "rejected-no-tests" satisfies CodingRunStatus,
        diff,
        rawLog: runResult.rawLog,
        exitCode: runResult.exitCode,
        allowedSubfolder: allowedRelativePrefix,
        usage: runResult.usage,
        providerId: runResult.providerId,
        model: options.model,
        timing: runResult.timing,
      },
      sessionId: runResult.sessionId,
    };
  }

  const scopeCwd = path.join(srcRoot, allowedRelativePrefix);
  const swTestResult = await runElementInlineTests(scopeCwd);
  const uncovered = await uncoveredRequirementIds(scopeCwd, requirementIds);

  return {
    run: {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "success",
      diff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      allowedSubfolder: allowedRelativePrefix,
      usage: runResult.usage,
      providerId: runResult.providerId,
      model: options.model,
      timing: runResult.timing,
      swTestResult,
    },
    sessionId: runResult.sessionId,
    uncoveredRequirementIds: uncovered,
  };
}

// The kind:'harness' element's own run path (project harness feature).
// Differs from the per-element path in three ways: (1) the gate is
// harnessGateReason, not requirement-eligibility + interface alignment;
// (2) the isolated workspace is the WHOLE src tree via withHarnessWorkspace
// (the harness must read every element to wire it) with element folders
// protected by post-run revert rather than a physical wall; (3) an
// out-of-scope write reverts but does NOT fail the run — it is surfaced as
// a warning on the CodingRun.
async function runHarnessCoding(
  project: Project,
  projectDir: string,
  harness: ArchitectureElement,
  agentClient: CodingAgentClient,
  options: RunCodingOptions,
  startedAt: string,
): Promise<CodingRun> {
  const allowedSubfolder = elementSubfolderName(harness); // '_harness'

  const gateReason = harnessGateReason(project, options.platform);
  if (gateReason) {
    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId: harness.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "rejected-not-eligible",
      diff: "",
      rawLog: gateReason,
      exitCode: null,
      allowedSubfolder,
    };
  }

  const localSession = await openLocalSourceTree(sourceTreeRoot(projectDir));
  try {
    await scaffoldProjectSourceTree(project, localSession.localProjectDir);
    const srcRoot = localSession.localSrcRoot;
    await gitInitIfNeeded(srcRoot);

    // Read every non-harness element's exported API fresh from the local
    // source tree (already copied to fast local disk by openLocalSourceTree
    // above, and folders exist after scaffoldProjectSourceTree). Inlined
    // into the harness prompt so the agent gets concrete signatures up
    // front instead of globbing for and reading each element's entry file.
    const elementApis = await scanElementApis(
      srcRoot,
      project.architecture?.elements ?? [],
      options.platform,
    );

    const prompt = buildCodingPrompt(
      project,
      harness.id,
      allowedSubfolder,
      "manual-recode",
      options.platform,
      undefined,
      elementApis,
    );
    const elementSlugs = (project.architecture?.elements ?? []).map((e) =>
      elementSubfolderName(e),
    );

    let runResult;
    let diff: string;
    let changedPaths: string[];
    let outOfScopeReverted: string[];
    try {
      const runHarnessOnce = () =>
        withHarnessWorkspace(
          srcRoot,
          allowedSubfolder,
          elementSlugs,
          (isolatedCwd) =>
            agentClient.runAgentTask(prompt, {
              cwd: isolatedCwd,
              permissionMode: options.permissionMode ?? "acceptEdits",
              model: options.model,
              effort: options.effort,
              binary: options.binary,
              binaryArgs: options.binaryArgs,
              apiKey: options.apiKey,
              baseUrl: options.baseUrl,
              thinking: options.thinking,
              reasoningEffort: options.reasoningEffort,
              onChunk: options.onChunk,
              signal: options.signal,
            }),
        );
      let harnessRun = await runHarnessOnce();
      // Same GLM/opencode single retry as the per-element path — a
      // dropped-tool-call-delta produces a clean exit with nothing written.
      if (
        harnessRun.changedPaths.length === 0 &&
        harnessRun.result.providerId === "opencode"
      ) {
        harnessRun = await runHarnessOnce();
      }
      runResult = harnessRun.result;
      diff = harnessRun.diff;
      changedPaths = harnessRun.changedPaths;
      outOfScopeReverted = harnessRun.outOfScopeReverted;
    } catch (err) {
      const rawLog =
        (err as { rawLog?: string }).rawLog ?? (err as Error).message;
      const exitCode = (err as { exitCode?: number | null }).exitCode ?? null;
      const timing = (err as { timing?: CodingRun["timing"] }).timing;
      return {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId: harness.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "cli-error" satisfies CodingRunStatus,
        diff: "",
        rawLog,
        exitCode,
        allowedSubfolder,
        model: options.model,
        timing,
      };
    }

    const warnings =
      outOfScopeReverted.length > 0
        ? outOfScopeReverted.map(
            (p) =>
              `Harness attempted to modify ${p}, which is inside an element's folder — reverted. This may indicate a missing requirement or interface for that element.`,
          )
        : undefined;

    const hasAddedContent = /^\+(?!\+\+)/m.test(diff);
    if (changedPaths.length === 0 || (diff.length > 0 && !hasAddedContent)) {
      return {
        id: `CODINGRUN-${startedAt}`,
        architectureElementId: harness.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "rejected-empty-output" satisfies CodingRunStatus,
        diff: "",
        rawLog: runResult.rawLog,
        exitCode: runResult.exitCode,
        allowedSubfolder,
        usage: runResult.usage,
        providerId: runResult.providerId,
        model: options.model,
        timing: runResult.timing,
        warnings,
      };
    }

    await gitCommitAll(srcRoot, `Coding: ${harness.id} Harness`);

    return {
      id: `CODINGRUN-${startedAt}`,
      architectureElementId: harness.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "success",
      diff,
      rawLog: runResult.rawLog,
      exitCode: runResult.exitCode,
      allowedSubfolder,
      usage: runResult.usage,
      providerId: runResult.providerId,
      model: options.model,
      timing: runResult.timing,
      rejectedFiles:
        outOfScopeReverted.length > 0 ? outOfScopeReverted : undefined,
      warnings,
    };
  } finally {
    await localSession.syncBackAndDispose();
  }
}
