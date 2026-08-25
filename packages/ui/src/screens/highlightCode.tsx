// Lightweight, dependency-free syntax highlighter for the Coding screen's
// file preview and diff views. Not a real tokenizer/parser for any of these
// languages -- a handful of ordered regexes per language family, good enough
// to color comments/strings/keywords/numbers for a quick read, not intended
// to be grammatically perfect (e.g. it won't handle every escape sequence or
// nested-template-literal edge case). Kept dependency-free deliberately --
// this dev machine has previously failed to install new (uncached) npm/
// Gradle packages over a broken SSL path, so a real highlighter library
// (Prism/Shiki) is a real risk here, not just extra weight.

type TokenClass = 'comment' | 'string' | 'keyword' | 'number' | 'type' | 'tag' | 'attr' | 'punct' | 'plain'

interface Token {
  text: string
  cls: TokenClass
}

const CURLY_KEYWORDS = new Set([
  // C-family / JS-TS-JSX-TSX / Java / C# / Go / Rust shared core
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'const', 'let', 'var', 'class', 'extends', 'implements', 'interface',
  'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'try', 'catch', 'finally', 'throw',
  'import', 'export', 'from', 'as', 'default', 'async', 'await', 'yield', 'static', 'public',
  'private', 'protected', 'readonly', 'abstract', 'enum', 'namespace', 'declare', 'type',
  'void', 'null', 'undefined', 'true', 'false', 'this', 'super', 'get', 'set',
  // C/C++
  'int', 'char', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'struct', 'union',
  'sizeof', 'const', 'volatile', 'extern', 'inline', 'template', 'namespace', 'using', 'auto',
  'nullptr', 'bool', 'virtual', 'override', 'friend', 'operator', 'constexpr',
  // Java/C#
  'package', 'void', 'final', 'synchronized', 'throws',
  // Go
  'func', 'defer', 'go', 'chan', 'select', 'range', 'package', 'map', 'interface',
  // Rust
  'fn', 'let', 'mut', 'impl', 'trait', 'pub', 'match', 'loop', 'mod', 'crate', 'unsafe',
])

const PY_KEYWORDS = new Set([
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with',
  'as', 'import', 'from', 'return', 'yield', 'lambda', 'pass', 'break', 'continue', 'raise',
  'global', 'nonlocal', 'del', 'assert', 'and', 'or', 'not', 'in', 'is', 'None', 'True',
  'False', 'async', 'await', 'self', 'print',
])

// Order matters: earlier patterns win. Each language builds a single
// alternation regex from its own piece patterns, run once per line (the
// live-log/diff panes already split into lines before calling this).
function tokenizeGeneric(line: string, keywords: Set<string>, extra?: { types?: RegExp }): Token[] {
  const pattern =
    /(\/\/.*$)|(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|(\b[A-Za-z_]\w*\b)|([{}()[\];,.:<>+\-*/%=!&|^~?])/g
  const tokens: Token[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(line))) {
    if (m.index > lastIndex) tokens.push({ text: line.slice(lastIndex, m.index), cls: 'plain' })
    const [full, lineComment, hashComment, str, num, word, punct] = m
    if (lineComment || hashComment) tokens.push({ text: full, cls: 'comment' })
    else if (str) tokens.push({ text: full, cls: 'string' })
    else if (num) tokens.push({ text: full, cls: 'number' })
    else if (word) {
      if (keywords.has(word)) tokens.push({ text: full, cls: 'keyword' })
      else if (extra?.types?.test(word)) tokens.push({ text: full, cls: 'type' })
      else tokens.push({ text: full, cls: 'plain' })
    } else if (punct) tokens.push({ text: full, cls: 'punct' })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), cls: 'plain' })
  return tokens
}

const TYPE_LIKE = /^[A-Z]\w*$/

function tokenizeJson(line: string): Token[] {
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(\b-?\d+\.?\d*\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])/g
  const tokens: Token[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(line))) {
    if (m.index > lastIndex) tokens.push({ text: line.slice(lastIndex, m.index), cls: 'plain' })
    const [full, key, colonAfterKey, num, lit] = m
    if (key) tokens.push({ text: full, cls: colonAfterKey ? 'attr' : 'string' })
    else if (num) tokens.push({ text: full, cls: 'number' })
    else if (lit) tokens.push({ text: full, cls: 'keyword' })
    else tokens.push({ text: full, cls: 'punct' })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), cls: 'plain' })
  return tokens
}

function tokenizeCss(line: string): Token[] {
  const pattern = /(\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[0-9a-fA-F]{3,8}\b)|(-?\d+\.?\d*(?:px|em|rem|%|vh|vw|s|ms)?)|([.#]?[A-Za-z_-][\w-]*)(?=\s*[:{,])|([{}:;,])/g
  const tokens: Token[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(line))) {
    if (m.index > lastIndex) tokens.push({ text: line.slice(lastIndex, m.index), cls: 'plain' })
    const [full, comment, str, color, num, selectorOrProp, punct] = m
    if (comment) tokens.push({ text: full, cls: 'comment' })
    else if (str) tokens.push({ text: full, cls: 'string' })
    else if (color) tokens.push({ text: full, cls: 'number' })
    else if (num) tokens.push({ text: full, cls: 'number' })
    else if (selectorOrProp) tokens.push({ text: full, cls: 'attr' })
    else if (punct) tokens.push({ text: full, cls: 'punct' })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), cls: 'plain' })
  return tokens
}

function tokenizeHtml(line: string): Token[] {
  const pattern = /(<!--.*?-->)|(<\/?[A-Za-z][\w-]*)|([A-Za-z-]+)(=)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\/?>)/g
  const tokens: Token[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(line))) {
    if (m.index > lastIndex) tokens.push({ text: line.slice(lastIndex, m.index), cls: 'plain' })
    const [full, comment, tagOpen, attrName, eq, attrVal, tagClose] = m
    if (comment) tokens.push({ text: full, cls: 'comment' })
    else if (tagOpen) tokens.push({ text: full, cls: 'tag' })
    else if (attrName) {
      tokens.push({ text: attrName, cls: 'attr' })
      tokens.push({ text: eq, cls: 'punct' })
      tokens.push({ text: attrVal, cls: 'string' })
    } else if (tagClose) tokens.push({ text: full, cls: 'tag' })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), cls: 'plain' })
  return tokens
}

function tokenizeMarkdown(line: string): Token[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, cls: 'keyword' }]
  const pattern = /(`[^`]*`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]*\]\([^)]*\))/g
  const tokens: Token[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(line))) {
    if (m.index > lastIndex) tokens.push({ text: line.slice(lastIndex, m.index), cls: 'plain' })
    const [full, code, bold, italic, link] = m
    if (code) tokens.push({ text: full, cls: 'string' })
    else if (bold || italic) tokens.push({ text: full, cls: 'keyword' })
    else if (link) tokens.push({ text: full, cls: 'type' })
    lastIndex = pattern.lastIndex
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), cls: 'plain' })
  return tokens
}

export type CodeLang =
  | 'js' | 'json' | 'css' | 'html' | 'python' | 'markdown' | 'c' | 'shell' | 'plain'

const EXT_LANG: Record<string, CodeLang> = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  json: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html',
  py: 'python',
  md: 'markdown', markdown: 'markdown',
  c: 'c', h: 'c', cpp: 'c', cc: 'c', cxx: 'c', hpp: 'c',
  java: 'c', cs: 'c', go: 'c', rs: 'c',
  sh: 'shell', bash: 'shell',
}

export function langForFilePath(filePath: string): CodeLang {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return EXT_LANG[ext] ?? 'plain'
}

function tokenizeLine(line: string, lang: CodeLang): Token[] {
  switch (lang) {
    case 'json':
      return tokenizeJson(line)
    case 'css':
      return tokenizeCss(line)
    case 'html':
      return tokenizeHtml(line)
    case 'python':
      return tokenizeGeneric(line, PY_KEYWORDS, { types: TYPE_LIKE })
    case 'markdown':
      return tokenizeMarkdown(line)
    case 'shell':
      return line.trimStart().startsWith('#')
        ? [{ text: line, cls: 'comment' }]
        : tokenizeGeneric(line, new Set(['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'echo', 'export', 'local', 'return']))
    case 'js':
    case 'c':
      return tokenizeGeneric(line, CURLY_KEYWORDS, { types: TYPE_LIKE })
    default:
      return [{ text: line, cls: 'plain' }]
  }
}

const CLASS_NAME: Record<TokenClass, string> = {
  comment: 'code-tok-comment',
  string: 'code-tok-string',
  keyword: 'code-tok-keyword',
  number: 'code-tok-number',
  type: 'code-tok-type',
  tag: 'code-tok-tag',
  attr: 'code-tok-attr',
  punct: 'code-tok-punct',
  plain: '',
}

function renderTokens(line: string, lang: CodeLang) {
  return tokenizeLine(line, lang).map((tok, j) =>
    tok.cls === 'plain' ? tok.text : (
      <span key={j} className={CLASS_NAME[tok.cls]}>
        {tok.text}
      </span>
    ),
  )
}

// Highlights a single line's worth of text as inline spans, no wrapping
// element -- for callers that manage their own per-line row already (e.g.
// DiffView, which needs its own +/- background per row).
export function HighlightedLine({ line, lang }: { line: string; lang: CodeLang }) {
  return <>{renderTokens(line, lang)}</>
}

// Renders `code` as a series of highlighted per-line rows. Safe to call
// with any text (including non-code raw logs) -- an unrecognised language
// just renders as plain, uncolored lines.
export function HighlightedCode({ code, lang }: { code: string; lang: CodeLang }) {
  const lines = code.split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="code-line">
          {renderTokens(line, lang)}
          {line === '' ? ' ' : null}
        </div>
      ))}
    </>
  )
}
