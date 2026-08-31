import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArchitectureElement,
  PlatformDescriptor,
} from "vic-requirements-elicitation";
import { elementSubfolderName, SOURCE_TREE_DIRNAME } from "./scaffold.js";

// Reads the ACTUAL exported API of a non-harness element from its entry
// file, so the harness Coding prompt can list concrete signatures instead
// of making the agent glob for and read every element's source (see
// buildHarnessCodingPrompt). Deliberately a best-effort text scan, not an
// AST parse — same stance as interfaceCodeCheck.ts / codeOutline.ts (no
// per-language parser dependency), and the input here is far more
// constrained: one file, at a known path, whose shape VIC's own element
// prompt mandates ("a single entry file at index.js … using named
// exports"). A missed export just means the harness falls back to reading
// that one file — the pre-existing behaviour — so there is no correctness
// cliff.

export interface ElementExport {
  name: string;
  kind: "function" | "class" | "const";
  // Raw parameter text with whitespace collapsed, e.g. "width, height" or
  // "{ x = 0 }, cb". Empty string for a no-arg function/class; undefined
  // for kind:'const'.
  params?: string;
  // kind:'class' only — "name(params)" strings for the class's own
  // methods, constructor first if present. Capped (a class with dozens of
  // methods signals a broken element and defeats the token saving).
  methods?: string[];
}

export interface ElementApi {
  elementId: string;
  folder: string;
  // Relative to the element's folder, e.g. 'index.js'. Undefined when no
  // entry-file convention applies (non-web platform) or none was found.
  entryFile?: string;
  exports: ElementExport[];
  // false = never scanned (non-web platform, folder/file missing) OR the
  // file is a bare re-export barrel we can't resolve. Distinguishes "no
  // code yet" (entryFile undefined) from "file present but unreadable"
  // (entryFile set, scanned false) — the prompt degrades differently for
  // each.
  scanned: boolean;
}

const MAX_METHODS_PER_CLASS = 12;

// Lines that look like a method signature but are control flow.
const CONTROL_FLOW = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
]);

// Strips // line comments and /* */ block comments so commented-out
// `export` lines aren't harvested. Not string/regex-literal aware — good
// enough for a best-effort scan of a mandated-shape entry file.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// From the index of an opening '(' in `src`, returns the substring between
// it and its matching ')', with whitespace collapsed. Balances nested
// parens so a default value like `(a = fn(1))` or `({ x = 0 })` isn't
// truncated. Returns undefined if unbalanced.
function balancedParams(src: string, openParen: number): string | undefined {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return src
          .slice(openParen + 1, i)
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }
  return undefined;
}

// Given `src` positioned just after `class Name`, returns that class's own
// method signatures from its brace-balanced body.
function classMethods(src: string, afterName: number): string[] {
  const open = src.indexOf("{", afterName);
  if (open === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = src.slice(open + 1, end);
  const methods: string[] = [];
  const METHOD_LINE =
    /(^|\n)\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\*\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of body.matchAll(METHOD_LINE)) {
    const name = m[3];
    if (CONTROL_FLOW.has(name)) continue;
    const parenIdx = m.index! + m[0].lastIndexOf("(");
    const params = balancedParams(body, parenIdx) ?? "";
    const sig = `${name}(${params})`;
    if (name === "constructor") methods.unshift(sig);
    else methods.push(sig);
    if (methods.length >= MAX_METHODS_PER_CLASS) break;
  }
  return methods;
}

// Parses the named exports of one entry-file source. Pure — the unit tests
// exercise this directly with string input, no filesystem.
export function parseElementExports(source: string): ElementExport[] {
  const src = stripComments(source);
  const seen = new Set<string>();
  const exports: ElementExport[] = [];
  const add = (e: ElementExport) => {
    if (seen.has(e.name)) return;
    seen.add(e.name);
    exports.push(e);
  };

  // export [async] function NAME(...)
  for (const m of src.matchAll(
    /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    const parenIdx = m.index! + m[0].lastIndexOf("(");
    add({ name: m[1], kind: "function", params: balancedParams(src, parenIdx) ?? "" });
  }

  // export class NAME
  for (const m of src.matchAll(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/g)) {
    add({
      name: m[1],
      kind: "class",
      methods: classMethods(src, m.index! + m[0].length),
    });
  }

  // export const|let|var NAME = ...
  for (const m of src.matchAll(
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,40})/g,
  )) {
    const name = m[1];
    const rhs = m[2];
    // Arrow or function-expression assigned to the name -> treat as a
    // callable with params; otherwise a plain const value.
    const arrow = rhs.match(/^\s*(?:async\s+)?\(/);
    const fnExpr = rhs.match(/^\s*(?:async\s+)?function\s*\*?\s*[A-Za-z_$]*\s*\(/);
    if (arrow || fnExpr) {
      // rhs is m[2], the last capture group — it ends where the whole
      // match ends, so its start in `src` is (match end − rhs length).
      const rhsStart = m.index! + m[0].length - rhs.length;
      const globalOpen = rhsStart + rhs.indexOf("(");
      add({
        name,
        kind: "function",
        params: balancedParams(src, globalOpen) ?? "",
      });
    } else {
      add({ name, kind: "const" });
    }
  }

  // export { a, b as c }  — re-exported names, no signature available.
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const bit = part.trim();
      if (!bit) continue;
      const asMatch = bit.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      const name = asMatch ? asMatch[1] : bit.split(/\s+/)[0];
      if (name && name !== "default") add({ name, kind: "const" });
    }
  }

  return exports;
}

// Web is the only built-in platform whose element prompt
// (nonHarnessPlatformPackaging in runCoding.ts) mandates a single named
// entry file. Every other platform's native toolchain resolves its own
// imports, so there is no reliable file to point the scanner at — return
// scanned:false rather than guess.
function entryFileForPlatform(platform?: PlatformDescriptor): string | undefined {
  return platform?.id === "web" ? "index.js" : undefined;
}

// Scans one non-harness element's entry file. Never throws — a missing
// folder/file or an unreadable entry yields scanned:false.
export async function scanElementApi(
  srcRoot: string,
  element: ArchitectureElement,
  platform?: PlatformDescriptor,
): Promise<ElementApi> {
  const folder = elementSubfolderName(element);
  const entryFile = entryFileForPlatform(platform);
  const base: ElementApi = {
    elementId: element.id,
    folder,
    entryFile,
    exports: [],
    scanned: false,
  };
  if (!entryFile) return base;

  let source: string;
  try {
    source = await readFile(path.join(srcRoot, folder, entryFile), "utf-8");
  } catch {
    return base; // folder or index.js not written yet
  }

  // A bare re-export barrel (`export * from './x.js'`) yields no named
  // exports we can list — mark unscanned so the prompt tells the harness
  // to open this one file rather than presenting an empty-looking API.
  if (/\bexport\s*\*\s*from\b/.test(stripComments(source))) {
    return { ...base, scanned: false };
  }

  return { ...base, exports: parseElementExports(source), scanned: true };
}

// Scans every non-harness element. Order matches architecture.elements.
export async function scanElementApis(
  srcRoot: string,
  elements: ArchitectureElement[],
  platform?: PlatformDescriptor,
): Promise<ElementApi[]> {
  const others = elements.filter((e) => e.kind !== "harness");
  return Promise.all(others.map((e) => scanElementApi(srcRoot, e, platform)));
}

export { SOURCE_TREE_DIRNAME };
