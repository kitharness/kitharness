// `khp check`: the phases of KHP's conformance page (spec/conformance.md) against a kit's MCP
// server, at a tier. Every phase starts the server afresh on a new copy of the fixtures, so one
// phase's edits never reach another, in an empty folder with an environment khp check controls
// (containment.ts), so what the server does outside its workspace shows.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { environment, environmentNames, envProblem, Guard, OWNED, PRIVATE } from './containment.ts'
import { compare, decodePng, readTolerance, uniformity, type Picture } from './image.ts'
import { readIndependently } from './readers.ts'
import { a18Problems, commandParameters, isFreeString, minimalValue, parameterProblems, parametersOf, validateJson, type Parameter } from './schema.ts'
import { KitSession, splitCommand, type CallResult } from './session.ts'

/** The kit-layer version this tool checks, what a kit's manifest names in `khp` (K2): KHP 1.1 adds no requirement on kits, so it is 1.0. */
export const KIT_LAYER_VERSION = '1.0'
export const TOOL = { name: 'khp', version: '0.1.0' }
export const LEVELS = ['basic', 'agent-ready', 'agent-ready-complete'] as const
export type Level = (typeof LEVELS)[number]
const rank = (level: Level) => LEVELS.indexOf(level)

export interface CheckOptions {
  /** The command that starts the kit's MCP server over stdio. */
  kit: string
  level?: Level
  /** The kit's package: `kit.json` and `agent/`. */
  package?: string
  /** The conformance fixtures; default `conformance/` beside `kit.json`. */
  fixtures?: string
  kitId?: string
  sandbox?: boolean
  /** Variables passed to the kit server beside PATH (`--env NAME=VALUE`); never HOME, TMPDIR, or XDG_*. */
  env?: Record<string, string>
  /** Where khp check makes its folders; default `/tmp` on macOS and Linux, else the system's temporary folder. */
  tempDir?: string
  /** Phase 12, the probes of string parameters; default true (`--no-probes` sets it false). */
  probes?: boolean
  /**
   * Folders of the kit's own install outside `package` that its server reads under `--sandbox`
   * (`--allow-read`): an interpreter's libraries, the server's code when it is not in the package.
   */
  allowRead?: string[]
}

export interface PhaseResult {
  phase: number
  name: string
  passed: boolean
  failures: string[]
  /** What khp check could not verify or did not need to, so a pass is never overstated. */
  notes: string[]
}

/**
 * The tier the kit's manifest claims (K19) beside the tier tested. `--level` tests any tier (to try
 * one before claiming it), but only a pass at the claimed tier verifies the claim, so a report of a
 * pass at another tier is never read as "this kit conforms at that tier".
 */
export interface Claim {
  /** The manifest's `level`: a missing or unknown one reads as `basic` (K19); null when no manifest was read. */
  level: Level | null
  /** True only when the tier tested is the claimed one and every phase passed. */
  verified: boolean
  note: string
}

export interface Report {
  khp: string
  kit: { id: string | null; version: string | null }
  /** The tier tested. */
  level: Level
  passed: boolean
  claim: Claim
  tool: typeof TOOL
  platform: string
  sandboxed: boolean
  networkDenied: boolean
  /** The names of the variables the kit server got (containment.ts); values are not reported. */
  environment: string[]
  phases: PhaseResult[]
  attested: string[]
}

export class UsageError extends Error {}
/** The server did not start or did not answer `initialize` in time: exit status 2. */
export class StartError extends Error {}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** What every phase knows about the kit under test. */
interface Context {
  options: CheckOptions
  level: Level
  manifest: Json
  /** The manifest as `kit.json` in the package, when a package was given. */
  packageManifest: Json | undefined
  packageDir: string | undefined
  fixtures: string
  prefix: string
  basic: string
  extension: string
  edit: { command: string; params?: Json }[]
  catalogue: { code: string; severity?: string; summary?: string; fixture?: string; overflow?: unknown }[] | undefined
  denyNetwork: boolean
  argv: string[]
  /** What the server did outside its workspace in phases 1 to 11, by phase; phase 11 reports them. */
  containment: string[]
  /** Entries the server made in its private runtime folder (A58), at every tier. */
  runtimeWrites: number
  /** What the server left in its private runtime folder when it exited (A58 SHOULD), by name. */
  leftovers: Set<string>
}

class Phase {
  readonly failures: string[] = []
  readonly notes: string[] = []
  readonly phase: number
  readonly name: string
  /** Whether this phase reports what the server did outside its workspace itself, instead of phase 11. */
  readonly ownsContainment: boolean
  constructor(phase: number, name: string, ownsContainment = false) {
    this.phase = phase
    this.name = name
    this.ownsContainment = ownsContainment
  }
  fail(message: string) {
    this.failures.push(message)
  }
  note(message: string) {
    this.notes.push(message)
  }
  result(): PhaseResult {
    return { phase: this.phase, name: this.name, passed: this.failures.length === 0, failures: this.failures, notes: this.notes }
  }
}

// ---- Starting the server --------------------------------------------------------------------

interface Workspace {
  root: string
  dir: string
  /** A folder outside the workspace, for the path rules of A29. */
  outside: string
  /** The folders and canaries around the workspace (containment.ts). */
  guard: Guard
}

/**
 * Where khp check makes its folders by default. The server's TMPDIR is one of them, and a server
 * that puts a Unix socket there cannot start when the path is long (a socket path is at most 104
 * bytes on macOS, whose per-user temporary folder alone is about 50), so on macOS and Linux it is
 * `/tmp`. Each folder khp check makes there is readable by its owner only (mkdtemp).
 */
function tempBase(options: CheckOptions): string {
  if (options.tempDir) return options.tempDir
  if (process.platform !== 'win32' && fs.existsSync('/tmp')) return fs.realpathSync('/tmp')
  return os.tmpdir()
}

function newWorkspace(context: Context): Workspace {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempBase(context.options), 'khp-')))
  const dir = path.join(root, 'workspace')
  fs.cpSync(context.fixtures, dir, { recursive: true })
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  // The private runtime folder of A58 is the kit server's at every tier.
  const guard = new Guard(root, dir)
  return { root, dir, outside, guard }
}

/** What the sandbox of Agent-ready complete lets a kit server read and write (section 10.6). */
export interface SandboxPaths {
  /** khp check's folder around the workspace: its current folder is `<root>/cwd`. */
  root: string
  workspace: string
  /** The private runtime folder (A58): TMPDIR, XDG_RUNTIME_DIR, and XDG_CACHE_HOME (containment.ts). */
  runtime: string
  /** The kit's package and the `--allow-read` folders. */
  reads: string[]
  /** The start command's executable and, for a script, its interpreter. */
  executables: string[]
}

/**
 * What any process on macOS reads to start and run: the root folder itself (path lookup reads it),
 * the system's frameworks, libraries, and executables (a script's `/usr/bin/env`, `/bin/sh`),
 * shared data such as locales and time zones, the dyld cache, and the few devices a process uses.
 * Nothing here holds a person's files: user-installed fonts (`/Library/Fonts`), Homebrew
 * (`/opt/homebrew`, `/usr/local`), and home folders are not readable (A37: a kit ships its fonts).
 */
const DARWIN_SYSTEM = {
  literal: ['/', '/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/dtracehelper'],
  subpath: ['/System', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/Library/Apple', '/private/var/db/dyld', '/private/var/db/timezone', '/dev/fd'],
}

const quoted = (file: string) => `"${file.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

/**
 * The macOS sandbox profile: the network denied (A37); with `paths` (`--sandbox`, Agent-ready
 * complete) also every read of a file's content outside the workspace, the package, the private
 * runtime folder (A58), the start command's executables, and what the system needs (DARWIN_SYSTEM),
 * and every write outside the workspace and the private runtime folder (section 10.6). Reading a file's metadata (that it exists, its
 * size) stays allowed, since resolving any path reads the metadata of each folder on it.
 */
export function darwinProfile(paths: SandboxPaths | undefined): string {
  const rules = ['(version 1)', '(allow default)', '(deny network-outbound (remote ip))', '(deny network-inbound (local ip))']
  if (!paths) return rules.join('')
  const readable = [
    ...DARWIN_SYSTEM.literal.map((file) => `(literal ${quoted(file)})`),
    ...DARWIN_SYSTEM.subpath.map((folder) => `(subpath ${quoted(folder)})`),
    ...[paths.workspace, path.join(paths.root, 'cwd'), paths.runtime, ...paths.reads].map((folder) => `(subpath ${quoted(folder)})`),
    ...paths.executables.map((file) => `(literal ${quoted(file)})`),
  ]
  const writable = [
    ...[paths.workspace, paths.runtime].map((folder) => `(subpath ${quoted(folder)})`),
    ...['/dev/null', '/dev/tty', '/dev/dtracehelper'].map((file) => `(literal ${quoted(file)})`),
    '(subpath "/dev/fd")',
  ]
  rules.push(`(deny file-read-data (require-not (require-any ${readable.join(' ')})))`)
  rules.push(`(deny file-write* (require-not (require-any ${writable.join(' ')})))`)
  return rules.join('')
}

/** A command's file: as given when it has a folder in it, else the first match on PATH. */
function onPath(command: string, env: Record<string, string>): string | undefined {
  if (command.includes('/')) return fs.existsSync(command) ? command : undefined
  for (const folder of (env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(folder, command)
    try {
      if (fs.statSync(file).isFile()) return file
    } catch {
      // not in this folder
    }
  }
  return undefined
}

/**
 * The files the start command's executable needs to be read to start: the executable, and for a
 * script its interpreter (`#!/usr/bin/env node` also the `node` on PATH), each as found and as its
 * real path. Libraries an executable loads from outside the system folders (a Homebrew build's) are
 * not followed; such a folder is passed with `--allow-read`.
 */
function startFiles(command: string, env: Record<string, string>): string[] {
  const files: string[] = []
  const add = (file: string | undefined) => {
    if (!file) return undefined
    files.push(file)
    try {
      files.push(fs.realpathSync(file))
    } catch {
      // a dangling link: the kit will not start, which phase 2 reports
    }
    return file
  }
  const executable = add(onPath(command, env))
  if (!executable) return files
  let first = ''
  try {
    first = fs.readFileSync(executable).subarray(0, 256).toString('utf8').split('\n')[0] ?? ''
  } catch {
    return files
  }
  if (!first.startsWith('#!')) return files
  const [interpreter, ...rest] = first.slice(2).trim().split(/\s+/)
  add(interpreter)
  if (interpreter && path.basename(interpreter) === 'env') {
    const named = rest.find((word) => !word.startsWith('-') && !word.includes('='))
    if (named) add(onPath(named, env))
  }
  return [...new Set(files)]
}

/**
 * How the kit is started: `{workspace}` replaced, in khp check's empty current folder with the
 * environment of containment.ts, with the network denied (Agent-ready, A37) and under the sandbox.
 */
function wrapped(context: Context, workspace: Workspace, extraEnv: Record<string, string> = {}): { argv: string[]; env: Record<string, string>; cwd: string } {
  const argv = context.argv.map((word) => word.replaceAll('{workspace}', workspace.dir))
  const env = environment(workspace.root, { ...(context.options.env ?? {}), ...extraEnv })
  const cwd = workspace.guard.folder('cwd')
  if (!context.denyNetwork && !context.options.sandbox) return { argv, env, cwd }
  if (process.platform === 'darwin') {
    const paths: SandboxPaths | undefined = context.options.sandbox
      ? {
          root: workspace.root,
          workspace: workspace.dir,
          runtime: workspace.guard.folder(PRIVATE),
          reads: [...(context.packageDir ? [context.packageDir] : []), ...(context.options.allowRead ?? [])].map(realFolder),
          executables: startFiles(argv[0] as string, env),
        }
      : undefined
    return { argv: ['sandbox-exec', '-p', darwinProfile(paths), ...argv], env, cwd }
  }
  if (process.platform === 'linux') return { argv: ['unshare', '--map-root-user', '--net', ...argv], env, cwd }
  return { argv, env, cwd }
}

/** A folder as the sandbox sees it: its real path, which on macOS resolves /var and /tmp to /private. */
function realFolder(folder: string): string {
  try {
    return fs.realpathSync(path.resolve(folder))
  } catch {
    return path.resolve(folder)
  }
}

/** Whether khp check can deny the network on this platform. */
function canDenyNetwork(): boolean {
  if (process.platform === 'darwin') return spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', 'true']).status === 0
  if (process.platform === 'linux') return spawnSync('unshare', ['--map-root-user', '--net', 'true']).status === 0
  return false
}

/** What a server start needs beyond the usual: more variables, and something done before it starts. */
interface Setup {
  env?: Record<string, string>
  before?: (workspace: Workspace) => void
}

/**
 * Starts the server on a new workspace, runs `run`, stops it, and checks what it did outside the
 * workspace (containment.ts): `phase` reports it itself when it owns containment, else phase 11 does.
 */
async function withServer<T>(context: Context, phase: Phase | string, run: (session: KitSession, workspace: Workspace) => Promise<T>, setup: Setup = {}): Promise<T> {
  const workspace = newWorkspace(context)
  setup.before?.(workspace)
  const { argv, env, cwd } = wrapped(context, workspace, setup.env)
  let session: KitSession
  try {
    session = await KitSession.start({ argv, cwd, env })
  } catch (error) {
    fs.rmSync(workspace.root, { recursive: true, force: true })
    throw new StartError(error instanceof Error ? error.message : String(error))
  }
  try {
    return await run(session, workspace)
  } finally {
    // Once before the server stops, so what it removes when it exits (A58) is seen too, and once after.
    const findings = workspace.guard.check(session)
    await session.close()
    findings.push(...workspace.guard.check(session))
    if (typeof phase !== 'string' && phase.ownsContainment) for (const finding of findings) phase.fail(finding)
    else {
      const label = typeof phase === 'string' ? phase : `${phase.phase} ${phase.name}`
      for (const finding of findings) context.containment.push(`${label}: ${finding}`)
    }
    context.runtimeWrites += workspace.guard.runtimeWrites
    for (const left of workspace.guard.leftovers()) context.leftovers.add(left)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
}

// ---- Shared checks --------------------------------------------------------------------------

const tool = (context: Context, action: string) => `${context.prefix}_${action}`

/** Records why a result is not a valid success: an error, a failure to answer, or a result its own outputSchema rejects. */
function expectSuccess(phase: Phase, session: KitSession, name: string, result: CallResult, what: string): boolean {
  if (result.failure) {
    phase.fail(`${what}: ${name} did not answer (${result.failure})`)
    return false
  }
  if (result.isError) {
    const error = result.structured?.error as Json | undefined
    phase.fail(`${what}: ${name} answered an error: ${error?.code ?? '?'} ${error?.message ?? textOf(result).slice(0, 200)}`)
    return false
  }
  checkOutput(phase, session, name, result, what)
  return true
}

/** A18: the call failed with a structured error that its tool's outputSchema accepts. */
function expectError(phase: Phase, session: KitSession, name: string, result: CallResult, what: string, code?: string): boolean {
  if (result.failure) {
    phase.fail(`${what}: ${name} did not answer (${result.failure})`)
    return false
  }
  if (!result.isError) {
    phase.fail(`${what}: ${name} succeeded; it must fail${code ? ` with ${code}` : ''}`)
    return false
  }
  const problems = a18Problems(result.structured)
  if (problems.length > 0) {
    phase.fail(`${what}: ${name}'s error is not an A18 error: ${problems.join('; ')}`)
    return false
  }
  checkOutput(phase, session, name, result, what)
  const actual = (result.structured?.error as Json).code
  if (code && actual !== code) {
    phase.fail(`${what}: ${name} failed with ${String(actual)}, not ${code}`)
    return false
  }
  return true
}

function checkOutput(phase: Phase, session: KitSession, name: string, result: CallResult, what: string) {
  const schema = session.tool(name)?.outputSchema
  if (!schema || !result.structured) return
  const problems = validateJson(schema, result.structured)
  if (problems.length > 0) phase.fail(`${what}: ${name}'s structuredContent does not match its outputSchema (${problems.join('; ')})`)
}

const textOf = (result: CallResult) => result.content.map((item) => item.text ?? '').join('\n')

function images(result: CallResult): Buffer[] {
  return result.content.filter((item) => item.type === 'image' && item.data).map((item) => Buffer.from(item.data as string, 'base64'))
}

function diagnostics(result: CallResult): Json[] | undefined {
  const list = result.structured?.diagnostics
  return Array.isArray(list) ? (list.filter(isObject) as Json[]) : undefined
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file) : undefined)
const same = (a: Buffer | undefined, b: Buffer | undefined) => !!a && !!b && a.equals(b)
const stable = (value: unknown) => JSON.stringify(value)

/** The most commands a page of `<prefix>_commands` may be asked for (A5b). */
const PAGE_LIMIT = 200

/**
 * Every agent-facing command, listed without a query a page at a time (A5b), in the compact form
 * and again in the full one (`detail: true`, A5a). Problems with the listing itself fail `phase`.
 */
async function allCommands(
  session: KitSession,
  context: Context,
  phase: Phase,
): Promise<{ compact: Map<string, Json>; full: Map<string, Json>; total: number | undefined }> {
  const name = tool(context, 'commands')
  const list = async (detail: boolean) => {
    const listed = new Map<string, Json>()
    let total: number | undefined
    let cursor: string | undefined
    for (let pages = 0; pages < 1000; pages++) {
      const args: Json = { path: context.basic, limit: PAGE_LIMIT, ...(detail ? { detail: true } : {}), ...(cursor === undefined ? {} : { cursor }) }
      const result = await session.call(name, args)
      if (!expectSuccess(phase, session, name, result, `listing every command${detail ? ' in full' : ''}${cursor === undefined ? '' : ` from cursor ${stable(cursor)}`} (A5b)`)) break
      const structured = result.structured as Json
      if (!Number.isInteger(structured.total)) phase.fail(`${name} without a query answers no integer \`total\` (A5b)`)
      else total = structured.total as number
      const rows = Array.isArray(structured.commands) ? structured.commands : []
      if (rows.length > PAGE_LIMIT) phase.fail(`${name} answered ${rows.length} commands for limit ${PAGE_LIMIT} (A5b)`)
      let previous: string | undefined
      for (const row of rows) {
        if (!isObject(row) || typeof row.id !== 'string') {
          phase.fail(`${name} listed a command without a string id: ${stable(row).slice(0, 120)} (A5a)`)
          continue
        }
        if (previous !== undefined && row.id < previous) phase.fail(`${name} without a query is not ordered by id: ${row.id} after ${previous} (A5b)`)
        previous = row.id
        if (listed.has(row.id)) phase.fail(`${name} listed ${row.id} twice while paging (A5b)`)
        listed.set(row.id, row)
      }
      if (structured.next === undefined) break
      if (typeof structured.next !== 'string') {
        phase.fail(`${name}'s \`next\` is ${stable(structured.next)}, not a cursor string (A5b)`)
        break
      }
      if (rows.length === 0) {
        phase.fail(`${name} gave a \`next\` with an empty page (A5b)`)
        break
      }
      cursor = structured.next
    }
    if (total !== undefined && listed.size !== total) phase.fail(`${name} counts ${total} commands but its pages list ${listed.size} (A5b)`)
    return { listed, total }
  }
  const compact = await list(false)
  const full = await list(true)
  for (const id of compact.listed.keys()) if (!full.listed.has(id)) phase.fail(`${id} is listed but not with \`detail: true\` (A5a)`)
  // A cursor the kit never gave is invalid-params (A5b, A18).
  const bad = await session.call(name, { path: context.basic, cursor: 'not-a-cursor-khp-check' })
  if (!bad.failure && !bad.isError) phase.fail(`${name} accepted a cursor it never gave (A5b)`)
  else if (bad.isError && (bad.structured?.error as Json | undefined)?.code !== 'invalid-params') {
    phase.fail(`${name} answered a cursor it never gave with ${stable((bad.structured?.error as Json | undefined)?.code)}, not invalid-params (A5b, A18)`)
  }
  return { compact: compact.listed, full: full.listed, total: compact.total }
}

/** What a compact row of `<prefix>_commands` lacks (A5a). */
function compactProblems(id: string, row: Json): string[] {
  const problems: string[] = []
  if (typeof row.title !== 'string' || !row.title) problems.push(`${id}: the compact listing has no title (A5a)`)
  const params = row.params
  if (typeof params !== 'string' && !isObject(params)) problems.push(`${id}: the compact listing names no parameters (\`params\`, A5a)`)
  if ('enabled' in row && typeof row.enabled !== 'boolean') problems.push(`${id}: \`enabled\` is ${stable(row.enabled)}, not a boolean (A5a)`)
  if ('description' in row && typeof row.description !== 'string') problems.push(`${id}: the compact description is not text (A5a)`)
  return problems
}

// ---- Phase 1: manifest ----------------------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const KIT_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const EXTENSION = /^[a-z0-9][a-z0-9.+-]*$/

function manifestProblems(manifest: Json): string[] {
  const problems: string[] = []
  if (typeof manifest.khp !== 'string' || !/^\d+\.\d+$/.test(manifest.khp)) problems.push(`khp is ${stable(manifest.khp)}, not major.minor (K2)`)
  else if (manifest.khp !== KIT_LAYER_VERSION) problems.push(`khp is ${manifest.khp}; it names the kit-layer version the kit conforms to, and this tool checks kit layer ${KIT_LAYER_VERSION} (K2)`)
  if (typeof manifest.id !== 'string' || !KIT_ID.test(manifest.id)) problems.push(`id ${stable(manifest.id)} is not a reverse-domain identifier (K1)`)
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('name is missing')
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) problems.push(`version ${stable(manifest.version)} is not semver`)
  const formats = manifest.formats
  if (!Array.isArray(formats) || formats.length === 0) problems.push('formats is not a non-empty list')
  else {
    formats.forEach((format, index) => {
      if (!isObject(format)) return problems.push(`formats[${index}] is not an object`)
      if (typeof format.id !== 'string') problems.push(`formats[${index}] has no id`)
      if (!Array.isArray(format.extensions) || format.extensions.length === 0 || format.extensions.some((ext) => typeof ext !== 'string' || !EXTENSION.test(ext))) {
        problems.push(`formats[${index}].extensions are not extensions without a dot (K4)`)
      }
      if (format.role !== 'edit' && format.role !== 'view') problems.push(`formats[${index}].role is ${stable(format.role)}, not edit or view (K4)`)
    })
  }
  const list = (key: string, required: string[]) => {
    const value = manifest[key]
    if (value === undefined) return
    if (!Array.isArray(value)) return problems.push(`${key} is not a list`)
    value.forEach((entry, index) => {
      if (!isObject(entry)) return problems.push(`${key}[${index}] is not an object`)
      for (const field of required) if (typeof entry[field] !== 'string') problems.push(`${key}[${index}] has no ${field} (${key === 'exports' ? 'K5' : 'A41'})`)
      if (typeof entry.extension === 'string' && !EXTENSION.test(entry.extension)) problems.push(`${key}[${index}].extension has a dot or is empty`)
    })
  }
  list('creates', ['id', 'extension'])
  list('exports', ['extension'])
  if (manifest.level !== undefined && !LEVELS.includes(manifest.level as Level)) problems.push(`level ${stable(manifest.level)} is not a tier; it reads as basic (K19)`)
  if (!isObject(manifest.agent) || typeof manifest.agent.prefix !== 'string' || !/^[a-z][a-z0-9]*$/.test(manifest.agent.prefix)) problems.push('agent.prefix is missing or not lowercase letters and digits (A2)')
  if (isObject(manifest.agent) && 'links' in manifest.agent && typeof manifest.agent.links !== 'boolean') problems.push(`agent.links is ${stable(manifest.agent.links)}, not true or false (K21)`)
  return problems
}

async function manifestPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(1, 'manifest')
  for (const problem of manifestProblems(context.manifest)) phase.fail(problem)
  const agent = isObject(context.manifest.agent) ? context.manifest.agent : {}
  if (rank(context.level) >= 1) {
    if (context.manifest.level === undefined) phase.fail('level is missing; an Agent-ready kit says its tier (K16)')
    for (const key of ['objectModel', 'layout']) if (typeof agent[key] !== 'boolean') phase.fail(`agent.${key} is not said; an Agent-ready kit says it (K16)`)
    if (!context.catalogue) phase.fail('agent/checks.json is missing (K17)')
    else {
      if (context.catalogue.length === 0) phase.fail('agent/checks.json lists no codes (A38)')
      for (const entry of context.catalogue) {
        if (typeof entry.code !== 'string' || typeof entry.severity !== 'string' || typeof entry.summary !== 'string' || typeof entry.fixture !== 'string') {
          phase.fail(`agent/checks.json entry ${stable(entry)} lacks code, severity, summary or fixture (A38)`)
        } else if (!fs.existsSync(path.join(context.fixtures, entry.fixture))) phase.fail(`${entry.code}: its fixture ${entry.fixture} is missing (K17, A38)`)
        if ('overflow' in entry && !OVERFLOW_KINDS.includes(entry.overflow as string)) {
          phase.fail(`${String(entry.code)}: overflow ${stable(entry.overflow)} in agent/checks.json is not one of text, off-page, or page-break (A38, A40)`)
        }
      }
    }
  }
  if (rank(context.level) >= 2) {
    const guide = context.packageDir && fs.existsSync(path.join(context.packageDir, 'agent', 'guide.md'))
    if (!guide) phase.fail('agent/guide.md is missing (K17, Agent-ready complete)')
  }
  // K20: the same manifest as the MCP resource.
  await withServer(context, phase, async (session) => {
    const id = String(context.manifest.id)
    const uri = `khp://kits/${id}/kit.json`
    const listed = await session.resources()
    const entry = listed.find((resource) => resource.uri === uri)
    if (!entry) return phase.fail(`resources/list does not list ${uri} (K20)`)
    if (entry.mimeType && entry.mimeType !== 'application/json') phase.fail(`${uri} has mimeType ${entry.mimeType}, not application/json (K20)`)
    const resource = await session.readResource(uri)
    if (!resource) return phase.fail(`${uri} cannot be read (K20)`)
    let served: unknown
    try {
      served = JSON.parse(resource.text)
    } catch {
      return phase.fail(`${uri} is not JSON (K20)`)
    }
    if (context.packageManifest && stable(sortKeys(served)) !== stable(sortKeys(context.packageManifest))) phase.fail(`${uri} differs from the package's kit.json (K20)`)
  })
  return phase.result()
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
}

// ---- Phase 2: launch ------------------------------------------------------------------------

async function launchPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(2, 'launch')
  await withServer(context, phase, async (session) => {
    phase.note(`initialize answered within 10 s (server ${session.serverVersion?.name ?? '?'} ${session.serverVersion?.version ?? '?'})`)
    if (rank(context.level) >= 1 && session.serverVersion?.version !== context.manifest.version) {
      phase.fail(`serverInfo.version is ${stable(session.serverVersion?.version)}, the manifest's version ${stable(context.manifest.version)} (A34)`)
    }
  })
  if (rank(context.level) >= 1) {
    if (context.denyNetwork) phase.note(`every phase ran with the network denied (${process.platform === 'darwin' ? 'sandbox-exec' : 'unshare --net'}, A37)`)
    else phase.fail(`khp check cannot deny the network on ${process.platform}, so A37 is not verified`)
  }
  if (rank(context.level) >= 2 && !context.options.sandbox) phase.fail('Agent-ready complete runs under the sandbox: pass --sandbox (section 10.6)')
  if (context.options.sandbox && process.platform === 'darwin') {
    const reads = [...(context.packageDir ? [context.packageDir] : []), ...(context.options.allowRead ?? [])]
    phase.note(`under --sandbox the server read files only in the workspace, its private runtime folder (TMPDIR, A58), ${reads.length > 0 ? `${reads.join(', ')}, ` : ''}its executable, and the system's folders, and wrote only in the workspace and the private runtime folder (section 10.6)`)
  }
  if (context.options.sandbox && process.platform !== 'darwin') phase.fail(`--sandbox is implemented with sandbox-exec on macOS only, not on ${process.platform}`)
  return phase.result()
}

// ---- Phase 3: tools -------------------------------------------------------------------------

function requiredTools(context: Context): string[] {
  const agent = isObject(context.manifest.agent) ? context.manifest.agent : {}
  const actions = ['inspect', 'commands', 'run', 'check']
  if (agent.drafts === true) actions.push('draft_ready', 'draft_reopen')
  if (rank(context.level) >= 1) {
    actions.push('create', 'export')
    if (agent.objectModel === true) actions.push('query', 'batch')
  }
  return actions.map((action) => tool(context, action))
}

async function toolsPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(3, 'tools')
  const agent = isObject(context.manifest.agent) ? context.manifest.agent : {}
  await withServer(context, phase, async (session) => {
    const names = session.tools.map((entry) => entry.name)
    for (const name of requiredTools(context)) if (!names.includes(name)) phase.fail(`${name} is missing (A3, A22, A35)`)
    if (agent.drafts !== true) {
      for (const action of ['draft_ready', 'draft_reopen']) if (names.includes(tool(context, action))) phase.fail(`${tool(context, action)} is offered but agent.drafts is not true (A35)`)
    }
    for (const entry of session.tools) {
      if (!/^[A-Za-z0-9_]+$/.test(entry.name)) phase.fail(`${entry.name}: a name outside [A-Za-z0-9_] (A2)`)
      if (/merge|discard/i.test(entry.name)) phase.fail(`${entry.name}: merge and discard are the person's, never agent tools (A14)`)
      if (!entry.inputSchema) phase.fail(`${entry.name} has no inputSchema`)
      if (!entry.outputSchema) {
        phase.fail(`${entry.name} has no outputSchema (A18, section 8)`)
        continue
      }
      // An error result, from a call with invalid arguments, validates against its own outputSchema.
      let result = await session.call(entry.name, {})
      if (!result.isError && !result.failure) result = await session.call(entry.name, { path: { invalid: true } })
      if (!result.isError && !result.failure) {
        phase.note(`${entry.name}: no invalid arguments khp check tried made it fail, so its error result was not checked`)
        continue
      }
      expectError(phase, session, entry.name, result, 'invalid arguments')
    }
  })
  return phase.result()
}

// ---- Phase 4: schemas -----------------------------------------------------------------------

async function schemasPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(4, 'schemas')
  await withServer(context, phase, async (session, workspace) => {
    const { compact, full, total } = await allCommands(session, context, phase)
    phase.note(`${compact.size} commands listed by ${tool(context, 'commands')} without a query${total !== undefined ? ` (it counts ${total})` : ''}`)
    for (const [id, row] of compact) for (const problem of compactProblems(id, row)) phase.fail(problem)
    for (const [id, command] of full) {
      const params = commandParameters(command)
      if (typeof params === 'string') {
        phase.fail(`${id}: \`detail: true\` lists its parameters as text, not their schema (A5a, A5)`)
        continue
      }
      for (const problem of parameterProblems(params, id)) phase.fail(problem)
    }
    // A5a: a query that is a command's id answers that command in full.
    const first = [...compact.keys()][0]
    if (first !== undefined) {
      const exact = await session.call(tool(context, 'commands'), { path: context.basic, query: first })
      const rows = Array.isArray(exact.structured?.commands) ? (exact.structured?.commands as unknown[]).filter(isObject) : []
      const row = rows.find((candidate) => candidate.id === first)
      if (!row) phase.fail(`${tool(context, 'commands')} with the query ${first} does not list ${first} (A5a)`)
      else if (typeof commandParameters(row) === 'string') phase.fail(`${first}: a query that is its id lists its parameters as text, not their schema (A5a)`)
    }
    // A49: a query that matches no command still answers the nearest ones.
    if (compact.size > 0) {
      const nothing = await session.call(tool(context, 'commands'), { path: context.basic, query: 'khpchecknosuchword' })
      if (expectSuccess(phase, session, tool(context, 'commands'), nothing, 'a query that matches no command (A49)')) {
        const rows = Array.isArray(nothing.structured?.commands) ? (nothing.structured?.commands as unknown[]) : []
        if (rows.length === 0) phase.fail(`${tool(context, 'commands')} answered no commands for a query that matches none; it answers the nearest (A49)`)
      }
    }
    const commands = full
    if (rank(context.level) < 1) return
    // A36: every listed command answers `{}` with a result or a typed error, and a failure leaves the file.
    const file = path.join(workspace.dir, context.basic)
    const original = read(file)
    for (const id of commands.keys()) {
      const before = read(file)
      const result = await session.call(tool(context, 'run'), { path: context.basic, steps: [{ command: id, params: {} }] })
      if (result.failure) {
        phase.fail(`${id} with {}: no answer (${result.failure}); a call never waits (A36, A45)`)
        continue
      }
      if (result.isError) {
        const problems = a18Problems(result.structured)
        if (problems.length > 0) phase.fail(`${id} with {}: not a typed error (${problems.join('; ')}) (A36)`)
        if (!same(read(file), before)) phase.fail(`${id} with {}: failed and changed the file (A36, A18)`)
      } else if (original && !same(read(file), original)) {
        fs.writeFileSync(file, original)
      }
    }
  })
  return phase.result()
}

// ---- Phase 5: act ---------------------------------------------------------------------------

async function actPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(5, 'act')
  const agent = isObject(context.manifest.agent) ? context.manifest.agent : {}
  await withServer(context, phase, async (session, workspace) => {
    const file = path.join(workspace.dir, context.basic)
    const inspect = (args: Json = {}) => session.call(tool(context, 'inspect'), { path: context.basic, preview: false, ...args })
    const first = await inspect()
    if (!expectSuccess(phase, session, tool(context, 'inspect'), first, 'inspect basic')) return
    const before = read(file)
    const run = await session.call(tool(context, 'run'), { path: context.basic, steps: context.edit })
    if (expectSuccess(phase, session, tool(context, 'run'), run, 'edit.json')) {
      if (same(read(file), before)) phase.fail('edit.json ran but the saved file is byte for byte as before (A3: run saves unless asked otherwise)')
      const after = await inspect()
      if (expectSuccess(phase, session, tool(context, 'inspect'), after, 'inspect after edit.json') && stable(after.structured) === stable(first.structured)) {
        phase.fail(`${tool(context, 'inspect')} answers the same before and after edit.json`)
      }
    }
    const saved = read(file)
    const unknown = await session.call(tool(context, 'run'), { path: context.basic, steps: [{ command: 'khp.check.no-such-command', params: {} }] })
    expectError(phase, session, tool(context, 'run'), unknown, 'an unknown command', 'unknown-command')
    if (!same(read(file), saved)) phase.fail('an unknown command changed the file (A18)')
    const step = context.edit[0]
    if (step) {
      const bad = Object.fromEntries(Object.keys(step.params ?? { value: 1 }).map((key) => [key, { 'khp-check': 'not a valid value' }]))
      const badResult = await session.call(tool(context, 'run'), { path: context.basic, steps: [{ command: step.command, params: bad }] })
      expectError(phase, session, tool(context, 'run'), badResult, `${step.command} with bad params`)
      if (!same(read(file), saved)) phase.fail(`${step.command} with bad params changed the file (A18)`)
    }
    // A53: a run whose last step fails changes nothing, on disk or in the session's document.
    if (context.edit.length > 0 && context.edit.length < 50) {
      const inspected = await inspect()
      const failing = await session.call(tool(context, 'run'), { path: context.basic, steps: [...context.edit, { command: 'khp.check.no-such-command', params: {} }] })
      expectError(phase, session, tool(context, 'run'), failing, 'edit.json then an unknown command (A53)', 'unknown-command')
      if (!same(read(file), saved)) phase.fail('a run whose last step failed changed the file: the steps before it were saved (A53)')
      const again = await inspect()
      if (expectSuccess(phase, session, tool(context, 'inspect'), again, 'inspect after a failed run') && stable(withoutHistory(again.structured)) !== stable(withoutHistory(inspected.structured))) {
        phase.fail(`${tool(context, 'inspect')} answers differently after a run whose last step failed: the steps before it were not rolled back (A53)`)
      }
    }
    if (rank(context.level) >= 1) await outsideChange(phase, session, context, file)
    if (rank(context.level) >= 1 && agent.objectModel === true) await batchRoundTrip(phase, session, context, file)
    if (rank(context.level) >= 2) phase.fail('A44 (names and paths that match nothing or several answer the candidates) has no automated check yet; khp check does not pass Agent-ready complete')
  })
  return phase.result()
}

/** An answer without the counters a rollback may move (A53): `version`, `revision`, `canUndo`, `canRedo`. */
function withoutHistory(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutHistory)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['version', 'revision', 'canUndo', 'canRedo'].includes(key))
      .map(([key, item]) => [key, withoutHistory(item)]),
  )
}

/** Object ids a root object's fields refer to: ids in lists, plain or as `{ object }`. */
function referencedIds(fields: Json): string[] {
  const ids: string[] = []
  for (const value of Object.values(fields)) {
    if (!Array.isArray(value)) continue
    for (const item of value.slice(0, 5)) {
      if (typeof item === 'string') ids.push(item)
      else if (isObject(item) && typeof item.object === 'string') ids.push(item.object)
      else if (isObject(item) && typeof item.id === 'string') ids.push(item.id)
    }
  }
  return ids
}

/**
 * A56: after another process rewrites the file, the next inspect says so (`changedOutside`), the
 * next run is refused once (`failed`, `retryable`) and leaves the file as the other process left it,
 * and the run after that works.
 */
async function outsideChange(phase: Phase, session: KitSession, context: Context, file: string) {
  const inspect = tool(context, 'inspect')
  const run = tool(context, 'run')
  const looked = await session.call(inspect, { path: context.basic, preview: false })
  if (!expectSuccess(phase, session, inspect, looked, 'inspect before an outside change (A56)')) return
  const theirs = read(path.join(context.fixtures, context.basic))
  const ours = read(file)
  if (!theirs || !ours || same(theirs, ours)) return
  fs.writeFileSync(file, theirs)
  const told = await session.call(inspect, { path: context.basic, preview: false })
  if (expectSuccess(phase, session, inspect, told, 'inspect after an outside change (A56)') && !isObject(told.structured?.changedOutside)) {
    phase.fail(`${inspect} after another process changed the file answers no \`changedOutside\` (A56)`)
  }
  fs.writeFileSync(file, ours)
  const refused = await session.call(run, { path: context.basic, steps: context.edit })
  if (expectError(phase, session, run, refused, 'a run after an outside change (A56)', 'failed')) {
    const error = refused.structured?.error as Json | undefined
    if (error?.retryable !== true) phase.fail(`${run}'s refusal after an outside change is not \`retryable\` (A56)`)
  }
  if (!same(read(file), ours)) phase.fail(`${run} after an outside change changed the file instead of being refused once (A56)`)
  const again = await session.call(run, { path: context.basic, steps: context.edit })
  expectSuccess(phase, session, run, again, 'the run after the refused one (A56)')
}

/** Field names that name an object instead of holding content: ids, handles, references (A16). */
const IDENTITY = /^(id|ids|uuid|guid|handle|ref)$|(Id|Ids|_id|_ids|Uuid|_uuid|Handle|_handle|Ref|_ref)$/
/** The A18 codes with which a kit refuses a value it does not take for a field, leaving the file. */
const REFUSALS = ['invalid-value', 'invalid-op', 'read-only']
/** How many fields the round trip tries before it gives up. */
const ROUND_TRIP_TRIES = 8

/**
 * The object types' JSON Schemas in a `describe: "*"` answer (A16a): the first `$defs` (or
 * `definitions`) in it whose members are object schemas with `properties`. KHP does not say where
 * in the answer the JSON Schema is, so khp check looks for it rather than at one key.
 */
function typeSchemas(answer: unknown, depth = 0): Record<string, Json> | undefined {
  if (!isObject(answer) || depth > 4) return undefined
  for (const key of ['$defs', 'definitions']) {
    const defs = answer[key]
    if (isObject(defs) && Object.values(defs).some((def) => isObject(def) && isObject(def.properties))) return defs as Record<string, Json>
  }
  for (const value of Object.values(answer)) {
    const found = typeSchemas(value, depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * Why a field is not a free string the round trip may write, or undefined when it is one: the
 * field's JSON Schema (when the kit described its type) rules out `readOnly`, `enum` and `const`,
 * anything but a plain string, and constraints; its name rules out ids, handles, and references;
 * its value rules out an object's id. JSON Schema cannot say that a string is a container (text the
 * kit edits with its own operations), so a field the kit refuses is skipped when it is tried.
 */
function unfitField(name: string, value: string, schema: Json | undefined, typed: boolean, ids: Set<string>): string | undefined {
  if (typed && !schema) return 'not in its type\'s schema'
  if (schema) {
    if (schema.readOnly === true) return 'read-only'
    if ('enum' in schema || 'const' in schema) return 'enum'
    if ('$ref' in schema) return 'a reference'
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.includes('string') || types.some((type) => type !== 'string' && type !== 'null')) return 'not a string in its schema'
    if (['anyOf', 'oneOf', 'allOf', 'not', 'pattern', 'format', 'contentEncoding', 'contentMediaType'].some((key) => key in schema)) return 'constrained by its schema'
    if (typeof schema.maxLength === 'number' && schema.maxLength < ROUND_TRIP_VALUE.length) return 'constrained by its schema'
  }
  if (IDENTITY.test(name)) return 'an identity'
  if (ids.has(value)) return "an object's id"
  return undefined
}

const ROUND_TRIP_VALUE = 'khp check'

/**
 * A16: `<prefix>_batch` sets one free string field (of the root object, else of an object the root
 * lists) and `<prefix>_query` reads it back. The field is chosen from what the kit's own
 * `describe: "*"` answer says (A16a), never an identity, enum, reference, or constrained field; a
 * field the kit refuses with a typed error (a container, a closed set it did not describe) is
 * skipped, as long as the refusal is an A18 error that leaves the file.
 */
async function batchRoundTrip(phase: Phase, session: KitSession, context: Context, file: string) {
  const query = tool(context, 'query')
  const batch = tool(context, 'batch')
  const ops = session.tool(batch)?.inputSchema?.properties?.ops as Json | undefined
  const opEnum = isObject(ops?.items) && isObject((ops.items as Json).properties) ? ((((ops.items as Json).properties as Json).op as Json | undefined)?.enum as unknown[] | undefined) : undefined
  if (!opEnum?.includes('set')) {
    phase.fail(`${batch}: its input schema names no \`set\` operation, so khp check cannot round-trip one edit (A16)`)
    return
  }
  const objectOf = async (id: string): Promise<{ id?: string; type?: string; fields: Json } | undefined> => {
    const result = await session.call(query, { path: context.basic, objects: [id] })
    if (id === 'root' && !expectSuccess(phase, session, query, result, 'query root')) return undefined
    const objects = result.structured?.objects
    const object = Array.isArray(objects) && isObject(objects[0]) ? (objects[0] as Json) : undefined
    if (!object || !isObject(object.fields)) return undefined
    return { id: typeof object.id === 'string' ? object.id : undefined, type: typeof object.type === 'string' ? object.type : undefined, fields: object.fields as Json }
  }
  const root = await objectOf('root')
  if (!root) return
  const described = await session.call(query, { path: context.basic, objects: ['root'], describe: '*' })
  const schemas = !described.failure && !described.isError ? typeSchemas(described.structured) : undefined
  if (!schemas) phase.note(`${query} with \`describe: "*"\` answered no JSON Schema of the types (A16a), so khp check chose the field by its name and value alone`)
  const listed = referencedIds(root.fields)
  const ids = new Set(['root', ...(root.id ? [root.id] : []), ...listed])
  const candidates: { id: string; field: string; value: string }[] = []
  const skipped: string[] = []
  for (const id of ['root', ...listed]) {
    const object = id === 'root' ? root : await objectOf(id)
    if (!object) continue
    const typeSchema = schemas && object.type ? schemas[object.type] : undefined
    const properties = isObject(typeSchema?.properties) ? (typeSchema.properties as Json) : undefined
    for (const [field, value] of Object.entries(object.fields)) {
      if (typeof value !== 'string') continue
      const schema = properties && isObject(properties[field]) ? (properties[field] as Json) : undefined
      const why = unfitField(field, value, schema, !!properties, ids)
      if (why) skipped.push(`${id}.${field} (${why})`)
      else candidates.push({ id, field, value })
    }
  }
  if (skipped.length > 0) phase.note(`the A16 round trip skipped ${skipped.join(', ')}`)
  const refused: string[] = []
  /** The field as `<prefix>_query` reads it now; `read: false` when the query failed (and failed the phase). */
  const valueOf = async (target: { id: string; field: string }, what: string): Promise<{ read: boolean; value?: unknown }> => {
    const back = await session.call(query, { path: context.basic, objects: [target.id], fields: [target.field] })
    if (!expectSuccess(phase, session, query, back, what)) return { read: false }
    const object = Array.isArray(back.structured?.objects) && isObject(back.structured.objects[0]) ? (back.structured.objects[0] as Json) : undefined
    return { read: true, value: isObject(object?.fields) ? (object.fields as Json)[target.field] : undefined }
  }
  for (const target of candidates.slice(0, ROUND_TRIP_TRIES)) {
    const before = read(file)
    const result = await session.call(batch, { path: context.basic, ops: [{ op: 'set', target: target.id, field: target.field, value: ROUND_TRIP_VALUE }] })
    const error = result.isError && isObject(result.structured?.error) ? (result.structured.error as Json) : undefined
    if (error && REFUSALS.includes(error.code as string)) {
      // A refusal is an answer, not a defect, when it is an A18 error that leaves the file.
      if (!expectError(phase, session, batch, result, `batch set ${target.id}.${target.field}`)) return
      if (!same(read(file), before)) return phase.fail(`${batch} refused ${target.id}.${target.field} with ${String(error.code)} but changed the file (A18)`)
      const why = `${String(error.code)}: ${String(error.message ?? '').slice(0, 120)}`
      // A batch is one change (A16): a refused one leaves the object as it was, in the session too.
      const after = await valueOf(target, `query ${target.id} after the refused batch`)
      if (!after.read) return
      if (after.value !== target.value) {
        return phase.fail(`${batch} refused ${target.id}.${target.field} (${why}) but ${query} reads ${stable(after.value)}, not ${stable(target.value)}: the refused change stayed in the session's document (A16, A18)`)
      }
      refused.push(`${target.id}.${target.field} (${why})`)
      phase.note(`${batch} refused ${target.id}.${target.field} (${why}); khp check does not round-trip a field the kit refuses`)
      continue
    }
    if (!expectSuccess(phase, session, batch, result, `batch set ${target.id}.${target.field}`)) return
    const back = await valueOf(target, `query ${target.id} after the batch`)
    if (!back.read) return
    if (back.value !== ROUND_TRIP_VALUE) phase.fail(`${batch} set ${target.id}.${target.field} to ${stable(ROUND_TRIP_VALUE)} but ${query} reads ${stable(back.value)} (A16)`)
    else phase.note(`${batch} set ${target.id}.${target.field} and ${query} read it back (A16)`)
    return
  }
  const said = [skipped.length > 0 ? `skipped ${skipped.join(', ')}` : '', refused.length > 0 ? `refused ${refused.join(', ')}` : ''].filter(Boolean).join('; ')
  phase.fail(`${batch}: the root object and the objects it lists have no free string field khp check may write, so it cannot round-trip one edit (A16)${said ? `: ${said}` : ''}`)
}

// ---- Phase 6: verify ------------------------------------------------------------------------

async function verifyPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(6, 'verify')
  await withServer(context, phase, async (session, workspace) => {
    const check = tool(context, 'check')
    const file = path.join(workspace.dir, context.basic)
    const bytes = read(file)
    const before = await session.call(tool(context, 'inspect'), { path: context.basic, preview: false })
    const result = await session.call(check, { path: context.basic })
    if (expectSuccess(phase, session, check, result, 'check basic')) {
      const list = diagnostics(result)
      if (!list) phase.fail(`${check} answers no diagnostics list (A22)`)
      else {
        const errors = list.filter((entry) => entry.severity === 'error')
        if (errors.length > 0) phase.fail(`${context.basic} has error diagnostics: ${errors.map((entry) => entry.code).join(', ')}`)
        list.forEach((entry, index) => {
          if (typeof entry.code !== 'string' || !['error', 'warning', 'info'].includes(entry.severity as string) || !isObject(entry.target) || typeof entry.message !== 'string') {
            phase.fail(`diagnostic ${index} is not { code, severity, target, message } (A21)`)
          }
        })
      }
      if (!textOf(result).trim()) phase.fail(`${check} answers no summary beside the diagnostics (A22)`)
    }
    if (!same(read(file), bytes)) phase.fail(`${check} changed the file (A21)`)
    const after = await session.call(tool(context, 'inspect'), { path: context.basic, preview: false })
    if (stable(before.structured) !== stable(after.structured)) phase.fail(`${tool(context, 'inspect')} answers differently after ${check} (A21)`)
    if (rank(context.level) < 1 || !context.catalogue) return
    const known = new Set(context.catalogue.map((entry) => entry.code))
    for (const entry of context.catalogue) {
      if (!entry.fixture) continue
      const fixture = await session.call(check, { path: entry.fixture })
      if (!expectSuccess(phase, session, check, fixture, `check ${entry.fixture}`)) continue
      const codes = (diagnostics(fixture) ?? []).map((diagnostic) => diagnostic.code)
      if (!codes.includes(entry.code)) phase.fail(`${entry.fixture} does not yield ${entry.code}: ${codes.join(', ') || 'nothing'} (A38)`)
      for (const code of codes) if (!known.has(code as string)) phase.fail(`${entry.fixture} yields ${String(code)}, which is not in agent/checks.json (A38)`)
    }
  })
  return phase.result()
}

// ---- Phase 7: preview -----------------------------------------------------------------------

async function previewPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(7, 'preview')
  const expected = path.join(context.fixtures, 'expected')
  const tolerance = readTolerance(readJson(path.join(expected, 'tolerance.json')))
  if (!fs.existsSync(path.join(expected, 'tolerance.json'))) phase.fail('expected/tolerance.json is missing')
  await withServer(context, phase, async (session) => {
    const inspect = tool(context, 'inspect')
    // A55: without `preview: true`, no image.
    const plain = await session.call(inspect, { path: context.basic })
    if (expectSuccess(phase, session, inspect, plain, 'inspect basic without preview (A55)') && images(plain).length > 0) {
      phase.fail(`${inspect} attached a preview without \`preview: true\` (A55)`)
    }
    const picture = async (args: Json, what: string, whole = true): Promise<Picture | undefined> => {
      const result = await session.call(inspect, { preview: true, ...args })
      if (!expectSuccess(phase, session, inspect, result, what)) return undefined
      const [png] = images(result)
      if (!png) {
        phase.fail(`${what}: no image content in the result (A39)`)
        return undefined
      }
      try {
        const decoded = decodePng(png)
        const flat = whole ? uniformity(decoded) : undefined
        if (flat) phase.fail(`${what}: ${flat} (A39)`)
        return decoded
      } catch (error) {
        phase.fail(`${what}: the image is not a PNG (${error instanceof Error ? error.message : String(error)})`)
        return undefined
      }
    }
    const against = (actual: Picture | undefined, name: string, what: string) => {
      const file = path.join(expected, name)
      if (!actual) return
      if (!fs.existsSync(file)) return phase.note(`expected/${name} is not there, so ${what} was not compared`)
      const difference = compare(actual, decodePng(fs.readFileSync(file)), tolerance)
      if (difference) phase.fail(`${what} differs from expected/${name}: ${difference} (A39)`)
    }
    const whole = await picture({ path: context.basic }, 'preview of basic')
    if (whole && !fs.existsSync(path.join(expected, 'basic.png'))) phase.fail('expected/basic.png is missing: the expected preview of basic, which shows it is framed to the content (A39)')
    against(whole, 'basic.png', 'the preview of basic')
    const double = await picture({ path: context.basic, scale: 2 }, 'preview at scale 2')
    if (whole && double && (Math.abs(double.width - 2 * whole.width) > 1 || Math.abs(double.height - 2 * whole.height) > 1)) {
      phase.fail(`scale 2 gives ${double.width} × ${double.height}, not twice ${whole.width} × ${whole.height} (A39)`)
    }
    against(double, 'basic-scale-2.png', 'the preview at scale 2')
    const small = await picture({ path: context.basic, maxSize: 64 }, 'preview with maxSize 64')
    if (small && Math.max(small.width, small.height) > 64) phase.fail(`maxSize 64 gives ${small.width} × ${small.height} (A39)`)
    // A target: the target of a diagnostic the catalogue's fixtures yield (A24, A39).
    const target = await diagnosticTarget(session, context)
    if (!target) phase.fail('no catalogue fixture yields a diagnostic with a target, so khp check has no target to preview (A24)')
    else {
      const full = await picture({ path: target.file }, `preview of ${target.file}`)
      // A target may be one flat-coloured object, so only the whole preview must not be uniform.
      const part = await picture({ path: target.file, target: target.target }, `preview of ${target.file} at ${stable(target.target)}`, false)
      if (full && part && full.width === part.width && full.height === part.height && full.data.equals(part.data)) {
        phase.fail(`the preview of ${target.file} at target ${stable(target.target)} is the whole preview: the target is not honoured (A24)`)
      }
    }
    if (fs.existsSync(path.join(expected, 'basic-target.png'))) {
      phase.note('expected/basic-target.png is not compared: KHP does not say which target it shows')
    }
  })
  return phase.result()
}

async function diagnosticTarget(session: KitSession, context: Context): Promise<{ file: string; target: Json } | undefined> {
  for (const entry of context.catalogue ?? []) {
    if (!entry.fixture) continue
    const result = await session.call(tool(context, 'check'), { path: entry.fixture })
    const found = (diagnostics(result) ?? []).find((diagnostic) => isObject(diagnostic.target) && Object.keys(diagnostic.target).length > 0)
    if (found) return { file: entry.fixture, target: found.target as Json }
  }
  return undefined
}

// ---- Phase 8: layout ------------------------------------------------------------------------

/** The kinds of overflow (A40's `layout.overflow[].kind`), which a catalogue entry's `overflow` names (A38). */
const OVERFLOW_KINDS = ['text', 'off-page', 'page-break']

/** The codes the catalogue tags as overflow codes (A38), with their kind. */
function overflowCodes(context: Context): Map<string, string> {
  const tagged = (context.catalogue ?? []).filter((entry) => typeof entry.code === 'string' && OVERFLOW_KINDS.includes(entry.overflow as string))
  return new Map(tagged.map((entry) => [entry.code, entry.overflow as string]))
}

/**
 * A40: the check reports the overflow in `overflow.<ext>` with a code the catalogue tags `overflow`
 * (A38), and a target; at Agent-ready complete the layout answer reports it with `by` > 0, and the
 * kind of each overflow agrees with the tag of the code the check reports for its object.
 */
async function layoutPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(8, 'layout')
  const overflow = `overflow.${context.extension}`
  if (!fs.existsSync(path.join(context.fixtures, overflow))) {
    phase.fail(`${overflow} is missing: a layout kit's fixture with text that overflows its box (A40)`)
    return phase.result()
  }
  const tags = overflowCodes(context)
  await withServer(context, phase, async (session) => {
    const result = await session.call(tool(context, 'check'), { path: overflow })
    let found: Json[] = []
    if (expectSuccess(phase, session, tool(context, 'check'), result, `check ${overflow}`)) {
      const reported = diagnostics(result) ?? []
      found = reported.filter((entry) => typeof entry.code === 'string' && tags.has(entry.code))
      const codes = [...new Set(reported.map((entry) => String(entry.code)))]
      const tagged = tags.size > 0 ? `it tags ${[...tags].map(([code, kind]) => `${code} (${kind})`).join(', ')}` : 'it tags no code'
      if (codes.length === 0) {
        phase.fail(`${overflow}: the check reports no diagnostic, but the fixture overflows: the check reports every overflow with a code agent/checks.json tags \`overflow\` (${tagged}) (A38, A40)`)
      } else if (found.length === 0) {
        phase.fail(
          `${overflow}: the check reports ${codes.join(', ')}, but none of these codes carries \`overflow\` in agent/checks.json (${tagged}), so khp check sees no overflow diagnostic (A40). ` +
            'Add "overflow": "text" (or "off-page", "page-break") to the catalogue entry of the code that reports this overflow (A38)',
        )
      } else if (!found.some((entry) => isObject(entry.target) && Object.keys(entry.target).length > 0)) {
        phase.fail(`${overflow}: the overflow diagnostic ${[...new Set(found.map((entry) => String(entry.code)))].join(', ')} has no target (A40)`)
      }
    }
    if (rank(context.level) < 2) return
    const layout = await session.call(tool(context, 'inspect'), { path: overflow, preview: false, layout: true })
    if (!expectSuccess(phase, session, tool(context, 'inspect'), layout, `inspect ${overflow} with layout`)) return
    const entries = isObject(layout.structured?.layout) ? ((layout.structured.layout as Json).overflow as unknown[] | undefined) : undefined
    if (!Array.isArray(entries) || !entries.some((entry) => isObject(entry) && typeof entry.by === 'number' && entry.by > 0)) {
      phase.fail(`inspect ${overflow} with layout: true reports no overflow with \`by\` greater than 0 (A40)`)
    }
    for (const entry of (entries ?? []).filter(isObject)) {
      if (typeof entry.id !== 'string' || typeof entry.kind !== 'string') continue
      const about = found.filter((diagnostic) => isObject(diagnostic.target) && (diagnostic.target as Json).objectId === entry.id)
      if (about.length === 0) {
        phase.note(`no overflow diagnostic of ${overflow} targets objectId ${entry.id}, so khp check did not compare the kind of its ${entry.kind} overflow with a code's tag`)
      } else if (!about.some((diagnostic) => tags.get(diagnostic.code as string) === entry.kind)) {
        const said = about.map((diagnostic) => `${String(diagnostic.code)} (tagged ${tags.get(diagnostic.code as string)})`).join(', ')
        phase.fail(`inspect ${overflow} with layout: true reports a ${entry.kind} overflow of ${entry.id}, but the check reports it as ${said} in agent/checks.json (A38, A40)`)
      }
    }
  })
  return phase.result()
}

// ---- Phase 9: files -------------------------------------------------------------------------

async function filesPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(9, 'files')
  await withServer(context, phase, async (session, workspace) => {
    const ext = context.extension
    const basicBytes = fs.readFileSync(path.join(workspace.dir, context.basic))
    workspace.guard.plant(path.join(workspace.outside, `outside.${ext}`), basicBytes)
    fs.symlinkSync(workspace.outside, path.join(workspace.dir, 'khp-link'))
    fs.mkdirSync(path.join(workspace.dir, '.khp-hidden'))
    fs.writeFileSync(path.join(workspace.dir, '.khp-hidden', `hidden.${ext}`), basicBytes)
    // [how, an existing file, a missing file]; reports show `<outside>` for the absolute folder.
    const pairs: [string, string, string][] = [
      ['through ..', `../outside/outside.${ext}`, `../outside/missing.${ext}`],
      ['outside the workspace', path.join(workspace.outside, `outside.${ext}`), path.join(workspace.outside, `missing.${ext}`)],
      ['through a symbolic link', `khp-link/outside.${ext}`, `khp-link/missing.${ext}`],
      ['with a hidden segment', `.khp-hidden/hidden.${ext}`, `.khp-hidden/missing.${ext}`],
    ]
    const outsideFile = path.join(workspace.outside, `outside.${ext}`)
    for (const [how, existing, missing] of pairs) {
      for (const action of ['inspect', 'run'] as const) {
        const answers: { target: string; result: CallResult }[] = []
        for (const [which, target] of [['an existing file', existing], ['a missing file', missing]] as const) {
          const args: Json = action === 'run' ? { path: target, steps: context.edit } : { path: target, preview: false }
          const result = await session.call(tool(context, action), args)
          expectError(phase, session, tool(context, action), result, `a path ${how} (${which}, ${shownPath(workspace, target)})`, 'not-allowed')
          answers.push({ target, result })
        }
        const differs = refusedDifferently(answers[0] as Refusal, answers[1] as Refusal)
        if (differs) phase.fail(`${tool(context, action)}: a path ${how} is refused differently for an existing and a missing file: ${differs} (A29)`)
      }
    }
    if (!same(read(outsideFile), basicBytes)) phase.fail('a refused call changed a file outside the workspace (A29: nothing runs)')
    await fileParameters(phase, session, context, workspace)
    if (rank(context.level) < 1) return
    for (const entry of (context.manifest.creates as Json[] | undefined) ?? []) await createRound(phase, session, context, workspace, entry)
    for (const entry of (context.manifest.exports as Json[] | undefined) ?? []) await exportRound(phase, session, context, workspace, entry)
  })
  return phase.result()
}

export type Refusal = { target: string; result: Pick<CallResult, 'structured'> }

/** A path as a report shows it: `<outside>` for khp check's folder outside the workspace. */
const shownPath = (workspace: Workspace, target: string) => (target.startsWith(workspace.root) ? `<root>${target.slice(workspace.root.length)}` : target)

/**
 * How two refusals of the same kind of path, one to an existing file and one to a missing one,
 * differ (A29: "the same way whether the file exists or not"), or undefined when they do not: their
 * codes, else their messages once the path given (whole, or its file name) is taken out. Only
 * the whole name is taken out: a stem such as `outside` or `hidden` is also a word of the prose.
 */
export function refusedDifferently(existing: Refusal, missing: Refusal): string | undefined {
  const error = (refusal: Refusal) => (isObject(refusal.result.structured?.error) ? (refusal.result.structured.error as Json) : undefined)
  const [a, b] = [error(existing), error(missing)]
  if (!a || !b) return undefined
  if (a.code !== b.code) return `${String(a.code)}, ${String(b.code)}`
  const plain = (refusal: Refusal, message: unknown) => {
    const name = path.basename(refusal.target)
    return String(message ?? '').replaceAll(refusal.target, '<path>').replaceAll(name, '<name>')
  }
  const [first, second] = [plain(existing, a.message), plain(missing, b.message)]
  return first === second ? undefined : `${stable(a.message)} and ${stable(b.message)}`
}

/** The most calls phase 9 makes for `file` parameters. */
const FILE_PARAMETER_CALLS = 96

/** Required parameters filled with the least each takes; a `file` one names `probe` when it may. */
function filled(parameters: Parameter[], probe: string, context: Context): Json {
  const params: Json = {}
  for (const parameter of parameters) {
    if (!parameter.required) continue
    if (!parameter.file) params[parameter.name] = minimalValue(parameter.schema)
    else if (parameter.file.access === 'create') params[parameter.name] = `khp-probe-new.${parameter.file.accept[0] ?? context.extension}`
    else params[parameter.name] = parameter.file.accept.length === 0 || parameter.file.accept.includes(context.extension) ? probe : `khp-probe-missing.${parameter.file.accept[0]}`
  }
  return params
}

/** A throwaway copy of `basic` in the workspace, which probes run on with `save: false`. */
function probeCopy(context: Context, workspace: Workspace): { name: string; file: string; bytes: Buffer } {
  const name = `khp-probe.${context.extension}`
  const file = path.join(workspace.dir, name)
  const bytes = fs.readFileSync(path.join(workspace.dir, context.basic))
  fs.writeFileSync(file, bytes)
  return { name, file, bytes }
}

/**
 * A29 for every `file` parameter of every listed command: a path through `..`, absolute, through a
 * symbolic link, or with a hidden segment is refused with `not-allowed`, the same way for an existing
 * and a missing file. Each call runs on a throwaway copy of `basic` with `save: false`.
 */
async function fileParameters(phase: Phase, session: KitSession, context: Context, workspace: Workspace) {
  const { full } = await allCommands(session, context, new Phase(9, 'files'))
  const probe = probeCopy(context, workspace)
  const run = tool(context, 'run')
  let calls = 0
  const checked: string[] = []
  const left: string[] = []
  for (const [id, command] of full) {
    const parameters = parametersOf(commandParameters(command))
    for (const parameter of parameters.filter((entry) => entry.file)) {
      if (calls >= FILE_PARAMETER_CALLS) {
        left.push(`${id}.${parameter.name}`)
        continue
      }
      const folder = parameter.file?.kind === 'folder'
      const ext = parameter.file?.accept[0] ?? context.extension
      const named = (stem: string) => (folder ? stem : `${stem}.${ext}`)
      if (!folder && !fs.existsSync(path.join(workspace.outside, named('outside')))) workspace.guard.plant(path.join(workspace.outside, named('outside')), `khp check: a file outside the workspace
`)
      if (folder) workspace.guard.plantFolder(path.join(workspace.outside, 'outside'))
      fs.mkdirSync(path.join(workspace.dir, '.khp-hidden'), { recursive: true })
      if (!folder) fs.writeFileSync(path.join(workspace.dir, '.khp-hidden', named('hidden')), probe.bytes)
      else fs.mkdirSync(path.join(workspace.dir, '.khp-hidden', 'hidden'), { recursive: true })
      const pairs: [string, string, string][] = [
        ['through ..', `../outside/${named('outside')}`, `../outside/${named('missing')}`],
        ['outside the workspace', path.join(workspace.outside, named('outside')), path.join(workspace.outside, named('missing'))],
        ['through a symbolic link', `khp-link/${named('outside')}`, `khp-link/${named('missing')}`],
        ['with a hidden segment', `.khp-hidden/${named('hidden')}`, `.khp-hidden/${named('missing')}`],
      ]
      checked.push(`${id}.${parameter.name}`)
      for (const [how, existing, missing] of pairs) {
        const answers: Refusal[] = []
        for (const [which, target] of [['an existing file', existing], ['a missing file', missing]] as const) {
          calls++
          const params = { ...filled(parameters, probe.name, context), [parameter.name]: target }
          const result = await session.call(run, { path: probe.name, steps: [{ command: id, params }], save: false })
          expectError(phase, session, run, result, `${id} ${parameter.name}: a path ${how} (${which}, ${shownPath(workspace, target)})`, 'not-allowed')
          answers.push({ target, result })
          if (!same(read(probe.file), probe.bytes)) fs.writeFileSync(probe.file, probe.bytes)
        }
        const differs = refusedDifferently(answers[0] as Refusal, answers[1] as Refusal)
        if (differs) phase.fail(`${id} ${parameter.name}: a path ${how} is refused differently for an existing and a missing file: ${differs} (A29)`)
      }
    }
  }
  if (checked.length > 0) phase.note(`the file parameters ${checked.join(', ')} were given paths outside the workspace through ${run} (A29)`)
  else phase.note('no listed command has a `file` parameter, so A29 was checked through `path` alone')
  if (left.length > 0) phase.note(`khp check stopped at ${FILE_PARAMETER_CALLS} calls, so ${left.join(', ')} were not given paths outside the workspace`)
}

function writtenFiles(phase: Phase, result: CallResult, what: string): { path: string; created?: boolean }[] {
  const files = result.structured?.files
  if (!Array.isArray(files) || files.length === 0) {
    phase.fail(`${what}: the result lists no files (A30)`)
    return []
  }
  return files.filter(isObject).map((file) => ({ path: String(file.path), created: file.created as boolean | undefined }))
}

function reopen(phase: Phase, file: string, extension: string, what: string) {
  const verdict = readIndependently(extension, fs.readFileSync(file))
  if (verdict === null) phase.note(`${what}: khp check has no independent reader for .${extension}`)
  else if (verdict) phase.fail(`${what}: ${verdict}`)
}

async function createRound(phase: Phase, session: KitSession, context: Context, workspace: Workspace, entry: Json) {
  const kind = String(entry.id)
  const extension = String(entry.extension)
  const name = `khp-new-${kind}.${extension}`
  const create = tool(context, 'create')
  const first = await session.call(create, { path: name, kind })
  if (!expectSuccess(phase, session, create, first, `create ${kind}`)) return
  const listed = writtenFiles(phase, first, `create ${kind}`)
  const target = path.join(workspace.dir, name)
  if (!fs.existsSync(target)) return phase.fail(`create ${kind}: ${name} was not written`)
  if (!listed.some((file) => file.path === name)) phase.fail(`create ${kind}: files does not list ${name} (A30)`)
  const bytes = fs.readFileSync(target)
  const opened = await session.call(tool(context, 'inspect'), { path: name, preview: false })
  expectSuccess(phase, session, tool(context, 'inspect'), opened, `inspect the created ${name}`)
  const again = await session.call(create, { path: name, kind })
  if (!expectSuccess(phase, session, create, again, `create ${kind} again at ${name}`)) return
  if (!same(read(target), bytes)) phase.fail(`create ${kind} replaced the existing ${name} (A29, A41)`)
  const second = writtenFiles(phase, again, `create ${kind} again`)
  if (second.some((file) => file.path === name)) phase.fail(`create ${kind} again lists ${name} as written; it must pick an unused name (A29)`)
  for (const file of second) if (!fs.existsSync(path.join(workspace.dir, file.path))) phase.fail(`create ${kind} again lists ${file.path}, which is not there (A30)`)
}

async function exportRound(phase: Phase, session: KitSession, context: Context, workspace: Workspace, entry: Json) {
  const format = String(entry.extension)
  const to = `khp-export.${format}`
  const exporter = tool(context, 'export')
  const first = await session.call(exporter, { path: context.basic, to, format })
  if (!expectSuccess(phase, session, exporter, first, `export ${format}`)) return
  const listed = writtenFiles(phase, first, `export ${format}`)
  const target = path.join(workspace.dir, to)
  if (!fs.existsSync(target)) return phase.fail(`export ${format}: ${to} was not written`)
  if (!listed.some((file) => file.path === to)) phase.fail(`export ${format}: files does not list ${to} (A30)`)
  reopen(phase, target, format, `export ${format}`)
  const bytes = fs.readFileSync(target)
  const again = await session.call(exporter, { path: context.basic, to, format })
  if (!expectSuccess(phase, session, exporter, again, `export ${format} again to ${to}`)) return
  if (!same(read(target), bytes)) phase.fail(`export ${format} replaced the existing ${to} (K5, A41)`)
  const second = writtenFiles(phase, again, `export ${format} again`)
  if (second.some((file) => file.path === to)) phase.fail(`export ${format} again lists ${to} as written; it must pick an unused name (A29)`)
}

// ---- Phase 10: drafts -----------------------------------------------------------------------

async function draftsPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(10, 'drafts')
  await withServer(context, phase, async (session, workspace) => {
    const file = path.join(workspace.dir, context.basic)
    const bytes = read(file)
    const run = await session.call(tool(context, 'run'), { path: context.basic, steps: context.edit, draft: true })
    expectSuccess(phase, session, tool(context, 'run'), run, 'edit.json on a draft')
    if (!same(read(file), bytes)) phase.fail('an edit with draft: true changed the file (A12, A15)')
    const state = async (action: 'draft_ready' | 'draft_reopen', expected: string, what: string) => {
      const result = await session.call(tool(context, action), { path: context.basic })
      if (!expectSuccess(phase, session, tool(context, action), result, what)) return
      if (result.structured?.state !== expected) phase.fail(`${what}: the draft's state is ${stable(result.structured?.state)}, not ${expected} (A12)`)
    }
    await state('draft_ready', 'ready', 'draft_ready')
    await state('draft_reopen', 'open', 'draft_reopen')
    await state('draft_ready', 'ready', 'draft_ready again')
    const later = await session.call(tool(context, 'run'), { path: context.basic, steps: context.edit, draft: true })
    expectSuccess(phase, session, tool(context, 'run'), later, 'an edit on a ready draft')
    const draftState = isObject(later.structured?.draft) ? (later.structured.draft as Json).state : undefined
    if (draftState === undefined) phase.note('no tool reads a draft\'s state without changing it, so "a later edit reopens a ready draft" is not observed (A12)')
    else if (draftState !== 'open') phase.fail(`an edit on a ready draft leaves it ${stable(draftState)}, not open (A12)`)
    if (!same(read(file), bytes)) phase.fail('the draft reached the file before a person merged it (A15)')
  })
  return phase.result()
}

// ---- Running a check ------------------------------------------------------------------------

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

async function manifestFromServer(context: Context, kitId: string | undefined): Promise<Json> {
  return withServer(context, 'reading the manifest from the server', async (session) => {
    const listed = (await session.resources()).filter((resource) => /^khp:\/\/kits\/[^/]+\/kit\.json$/.test(resource.uri))
    const chosen = kitId ? listed.find((resource) => resource.uri === `khp://kits/${kitId}/kit.json`) : listed[0]
    if (!chosen) throw new UsageError(kitId ? `the server serves no khp://kits/${kitId}/kit.json; pass --package` : 'the server serves no khp://kits/<id>/kit.json resource (K20); pass --package')
    if (!kitId && listed.length > 1) throw new UsageError(`the server serves ${listed.length} kits; pass --kit-id`)
    const text = (await session.readResource(chosen.uri))?.text
    const manifest = text ? (JSON.parse(text) as unknown) : undefined
    if (!isObject(manifest)) throw new UsageError(`${chosen.uri} is not a JSON object`)
    return manifest
  })
}

// ---- Phase 12: probes -----------------------------------------------------------------------

/** The most calls phase 12 makes, and how long it may take. */
const PROBE_CALLS = 200
const PROBE_SECONDS = 120
/** How many unknown command ids and check fixtures phase 12 asks to learn of commands the listing hides. */
const LEARN_CALLS = 5

/**
 * How `<prefix>_batch`'s published input schema lets an operation run a command, if it does: an
 * operation (the `ops` items, or one of their `oneOf` or `anyOf` branches) with a `command` property;
 * `op` is the discriminator's value for it (a `const`, a one-value `enum`, or `command` or `run` in
 * an `enum`), and the parameters go under `params`, `args`, or `arguments`, whichever it declares.
 */
function commandOperation(schema: unknown): { op: unknown; make: (command: string, params: Json) => Json } | undefined {
  const ops = isObject(schema) && isObject(schema.properties) ? (schema.properties as Json).ops : undefined
  const items = isObject(ops) ? ops.items : undefined
  if (!isObject(items)) return undefined
  const variants = [items, ...['oneOf', 'anyOf'].flatMap((key) => (Array.isArray(items[key]) ? (items[key] as unknown[]) : []))].filter(isObject)
  for (const variant of variants) {
    const properties = isObject(variant.properties) ? (variant.properties as Json) : undefined
    if (!properties || !isObject(properties.command)) continue
    const discriminator = properties.op
    let op: unknown
    if (isObject(discriminator)) {
      if ('const' in discriminator) op = discriminator.const
      else if (Array.isArray(discriminator.enum)) op = discriminator.enum.length === 1 ? discriminator.enum[0] : discriminator.enum.find((value) => value === 'command' || value === 'run')
      if (op === undefined) continue
    }
    const key = ['params', 'args', 'arguments'].find((name) => name in properties) ?? 'params'
    return { op, make: (command, params) => ({ ...(op === undefined ? {} : { op }), command, [key]: params }) }
  }
  return undefined
}

/** Words of a text that may be command ids: quoted or backticked words, and dotted names. */
function idsIn(text: string): string[] {
  const quoted = [...text.matchAll(/[`"']([^`"'\s]{1,100})[`"']/g)].map((match) => match[1] as string)
  const dotted = [...text.matchAll(/[A-Za-z][\w-]*(?:\.[\w-]+)+/g)].map((match) => match[0])
  return [...quoted, ...dotted]
}

/**
 * Command ids the kit's own KHP answers name that `<prefix>_commands` does not list: the nearest ids
 * an unknown-command error names (A49) and the commands of diagnostics' `fix` (A21), with where each
 * was named. File names (an extension the manifest names) are not taken for ids.
 */
async function unlistedCommands(session: KitSession, context: Context, listed: Map<string, Json>, probe: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const extensions = new Set(
    [...((context.manifest.formats as Json[] | undefined) ?? []).flatMap((format) => (Array.isArray(format.extensions) ? format.extensions : [])), ...((context.manifest.exports as Json[] | undefined) ?? []).map((entry) => entry.extension)].map(String),
  )
  const take = (id: string, where: string) => {
    if (listed.has(id) || found.has(id) || id.includes('khp-check') || extensions.has(id.split('.').pop() as string) || /[\s/\\]/.test(id)) return
    found.set(id, where)
  }
  const words = [...new Set([...listed.keys()].map((id) => id.split('.')[0] as string))].slice(0, LEARN_CALLS)
  for (const word of words) {
    const unknown = `${word}.khp-check-unknown`
    const result = await session.call(tool(context, 'run'), { path: probe, steps: [{ command: unknown, params: {} }], save: false })
    const error = isObject(result.structured?.error) ? (result.structured.error as Json) : undefined
    if (error) for (const id of idsIn(JSON.stringify(error))) take(id, `the unknown-command error for ${unknown}`)
  }
  const fixtures = [probe, ...(context.catalogue ?? []).map((entry) => entry.fixture).filter((file): file is string => typeof file === 'string')].slice(0, LEARN_CALLS)
  for (const file of fixtures) {
    const result = await session.call(tool(context, 'check'), { path: file })
    for (const diagnostic of diagnostics(result) ?? []) {
      if (isObject(diagnostic.fix) && typeof diagnostic.fix.command === 'string') take(diagnostic.fix.command, `the fix of ${String(diagnostic.code)} in ${file}`)
    }
  }
  return found
}

/**
 * Every free string parameter of every listed command (not a `file`, `enum`, or constant) is given the
 * canary beside the workspace, by absolute path and as a `file:` URL, through `<prefix>_run` and, when
 * the batch admits a command operation, through `<prefix>_batch`; a command id the listing hides but
 * the kit's answers name is run through the batch, which must refuse it. After every call khp check
 * looks outside the workspace (containment.ts): a refusal is fine, an accepted call too, as long as
 * nothing outside the workspace was read, written, or deleted.
 */
async function probesPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(12, 'probes', true)
  await withServer(context, phase, async (session, workspace) => {
    const guard = workspace.guard
    const run = tool(context, 'run')
    const batch = tool(context, 'batch')
    const probe = probeCopy(context, workspace)
    const { full } = await allCommands(session, context, new Phase(12, 'probes'))
    const values: [string, string][] = [
      ['the absolute path of outside-canary.bin', guard.outsideCanary],
      ['a file: URL of outside-canary.bin', pathToFileURL(guard.outsideCanary).href],
    ]
    const planned: { id: string; name: string; what: string; params: Json }[] = []
    const strings: string[] = []
    const closed: string[] = []
    for (const [id, command] of full) {
      const parameters = parametersOf(commandParameters(command))
      for (const parameter of parameters) {
        if (parameter.file) continue
        if (!isFreeString(parameter)) {
          if ('enum' in parameter.schema) closed.push(`${id}.${parameter.name}`)
          continue
        }
        strings.push(`${id}.${parameter.name}`)
        for (const [what, value] of values) planned.push({ id, name: parameter.name, what, params: { ...filled(parameters, probe.name, context), [parameter.name]: value } })
      }
    }
    const deadline = Date.now() + PROBE_SECONDS * 1000
    let calls = 0
    let cut = false
    /** One probe call and what it did outside the workspace; false when the cap or the time is spent. */
    const probeOnce = async (name: string, args: Json, label: string): Promise<CallResult | undefined> => {
      if (calls >= PROBE_CALLS || Date.now() >= deadline) {
        cut = true
        return undefined
      }
      calls++
      const result = await session.call(name, args, Math.max(1000, Math.min(20_000, deadline - Date.now())))
      for (const finding of guard.check(session)) phase.fail(`${label}: ${finding}`)
      if (!same(read(probe.file), probe.bytes)) fs.writeFileSync(probe.file, probe.bytes)
      return result
    }
    for (const entry of planned) {
      if (!(await probeOnce(run, { path: probe.name, steps: [{ command: entry.id, params: entry.params }], save: false }, `${entry.id} { ${entry.name}: ${entry.what} } through ${run}`))) break
    }
    phase.note(
      strings.length > 0
        ? `the string parameters ${strings.join(', ')} were given ${values.map(([what]) => what).join(' and ')} through ${run}, on a copy of ${context.basic} with save: false`
        : 'no listed command has a free string parameter, so none was given a path outside the workspace',
    )
    if (closed.length > 0) phase.note(`string parameters with an enum were not probed: ${closed.join(', ')}`)
    const batchTool = session.tool(batch)
    const operation = batchTool ? commandOperation(batchTool.inputSchema) : undefined
    if (!batchTool) phase.note(`${batch} is not offered, so no command ran through a batch`)
    else if (!operation) phase.note(`${batch}'s input schema admits no command operation (an operation with a \`command\`), so no command ran through it`)
    else {
      phase.note(`${batch}'s input schema admits a command operation${operation.op === undefined ? '' : ` (op ${stable(operation.op)})`}; the string probes ran through it too`)
      for (const entry of planned) {
        const args = { path: probe.name, ops: [operation.make(entry.id, entry.params)], save: false }
        if (!(await probeOnce(batch, args, `${entry.id} { ${entry.name}: ${entry.what} } through ${batch}'s command operation`))) break
      }
      const hidden = cut ? new Map<string, string>() : await unlistedCommands(session, context, full, probe.name)
      for (const finding of guard.check(session)) phase.fail(`learning of commands the listing hides: ${finding}`)
      if (!cut && hidden.size === 0) {
        phase.note(`no command id outside ${tool(context, 'commands')}'s listing appeared in the kit's answers (unknown-command errors, diagnostics' fix), so running a hidden command through ${batch} was not applicable`)
      }
      for (const [id, where] of hidden) {
        const result = await probeOnce(batch, { path: probe.name, ops: [operation.make(id, {})], save: false }, `${id} through ${batch}'s command operation`)
        if (!result) break
        if (result.isError || result.failure) {
          const code = isObject(result.structured?.error) ? (result.structured.error as Json).code : result.failure
          phase.note(`${id}, which ${tool(context, 'commands')} does not list (named in ${where}), was refused by ${batch} (${String(code)})`)
          continue
        }
        const bogus = await probeOnce(batch, { path: probe.name, ops: [operation.make('khp.check.no-such-command', {})], save: false }, `khp.check.no-such-command through ${batch}`)
        if (bogus && (bogus.isError || bogus.failure)) {
          phase.fail(`${batch} ran ${id}, which ${tool(context, 'commands')} does not list (named in ${where}): a command operation runs only the agent-facing commands the listing names (A5b, A9)`)
        } else if (bogus) phase.note(`${batch} accepted ${id}, which ${tool(context, 'commands')} does not list, but also a command id no kit has, so khp check cannot tell whether it ran it`)
      }
    }
    if (cut) phase.note(`the probe stopped after ${calls} calls (at most ${PROBE_CALLS} calls and ${PROBE_SECONDS} s), so some probes were not run`)
  })
  return phase.result()
}

// ---- Phase 11: containment ------------------------------------------------------------------

/** What the targets of the links-outside fixture's links outside the workspace contain. */
const OUTSIDE_TARGET = 'outside-canary'

/**
 * A listener khp check names as the kit server's HTTP proxy while it opens the links-outside fixture,
 * so a request for a link's remote target (`http://outside-canary.invalid/…`) reaches it and shows
 * (A42). It answers nothing useful. Where the network is denied (A37) the request cannot reach it.
 */
async function proxyListener(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const server = http.createServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? ''}`)
    response.writeHead(502).end()
  })
  server.on('connect', (request: http.IncomingMessage, socket: Duplex) => {
    requests.push(`CONNECT ${request.url ?? ''}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { url: `http://127.0.0.1:${port}`, requests, close }
}

/** The links of an inspect answer whose target lies outside the workspace in the links-outside fixture. */
function outwardLinks(result: CallResult | undefined): Json[] {
  const links = Array.isArray(result?.structured?.links) ? (result.structured.links as unknown[]).filter(isObject) : []
  return links.filter((link) => String(link.target ?? '').includes(OUTSIDE_TARGET))
}

/** Links as A42 compares them across runs: without their `id`, in a stable order. */
function linkAnswer(links: Json[]): string {
  const shown = links.map((link) => stable(sortKeys(Object.fromEntries(Object.entries(link).filter(([key]) => key !== 'id')))))
  return `[${shown.sort().join(',')}]`
}

/**
 * The links-outside fixture (conformance.md): a document that links `../outside-canary.bin`, the
 * canary beside the workspace, and may link the remote `http://outside-canary.invalid/outside-canary.bin`.
 * khp check inspects it (with and without a preview), checks it, exports it to every `exports`
 * format, and creates every `creates` kind from it, where the kit offers those tools; refusals are
 * fine. The canary's content may appear in no answer and no file (containment.ts). A42: each link
 * to a target outside the workspace is answered `exists: false`, without `path` or `kit`, and with
 * `outside: true` when it has `outside` at all; the answer is the same in a second run in which
 * the canary does not exist; and no request for the remote target reaches khp check's proxy.
 */
async function linksOutside(phase: Phase, context: Context) {
  const fixture = `links-outside.${context.extension}`
  const agent = isObject(context.manifest.agent) ? context.manifest.agent : {}
  const declared = agent.links === true
  const inspect = tool(context, 'inspect')
  if (!declared && fs.existsSync(path.join(context.fixtures, context.basic))) {
    // K21: a kit that does not declare links has documents that link nothing, so its basic fixture answers none.
    await withServer(context, phase, async (session) => {
      if (!session.tool(inspect)) return
      const answered = (await session.call(inspect, { path: context.basic, preview: false })).structured?.links
      if (Array.isArray(answered) && answered.length > 0) {
        const says = agent.links === false ? 'false' : 'not said'
        phase.fail(
          `agent.links is ${says}, but ${inspect} of ${context.basic} answers ${answered.length} link${answered.length === 1 ? '' : 's'} (K21): ` +
            `a kit whose documents link other files declares agent.links: true and ships ${fixture}`,
        )
      }
    })
  }
  if (!fs.existsSync(path.join(context.fixtures, fixture))) {
    if (declared) phase.fail(`agent.links is true, but the fixtures have no ${fixture} (K21): a kit whose documents link other files ships it (conformance.md, Fixtures)`)
    else phase.note(`not checked: no links-outside fixture (${fixture}); the manifest does not declare agent.links (K21, A42)`)
    return
  }
  const proxy = await proxyListener()
  const env = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].map((name) => [name, proxy.url]))
  const failed = phase.failures.length
  try {
    let withCanary: Json[] = []
    await withServer(
      context,
      phase,
      async (session) => {
        const used: string[] = []
        const call = async (action: string, args: Json) => {
          const name = tool(context, action)
          if (!session.tool(name)) return undefined
          if (!used.includes(name)) used.push(name)
          return session.call(name, { path: fixture, ...args })
        }
        const inspected = await call('inspect', { preview: false })
        await call('inspect', { preview: true })
        await call('check', {})
        for (const entry of (context.manifest.exports as Json[] | undefined) ?? []) await call('export', { to: `khp-links-export.${String(entry.extension)}`, format: entry.extension })
        for (const entry of (context.manifest.creates as Json[] | undefined) ?? []) await call('create', { path: `khp-links-created.${String(entry.extension)}`, kind: entry.id, from: fixture })
        phase.note(`${fixture} (it links ../outside-canary.bin) was opened with ${used.join(', ')}; the canary's content may appear in no answer and no file (A42, A29)`)
        const links = Array.isArray(inspected?.structured?.links) ? (inspected.structured.links as unknown[]).filter(isObject) : []
        withCanary = outwardLinks(inspected)
        if (declared && withCanary.length === 0) {
          phase.fail(`${inspect} of ${fixture} answers no link to ../outside-canary.bin: a kit that declares agent.links reports its documents' links (A42, K21)`)
        } else if (links.length > 0 && withCanary.length === 0) phase.note(`${inspect} of ${fixture} lists links, but none to ../outside-canary.bin (A42)`)
      },
      { env },
    )
    for (const link of withCanary) {
      const target = String(link.target)
      if (link.exists !== false) {
        phase.fail(`${inspect} of ${fixture}: its link to ${target} is answered with exists: ${link.exists === undefined ? 'nothing' : stable(link.exists)}; a target outside the workspace is answered exists: false (A42, A29)`)
      }
      for (const key of ['path', 'kit']) {
        if (key in link) phase.fail(`${inspect} of ${fixture}: its link to ${target} is answered with ${key} ${stable(link[key])}; a link to a target outside the workspace has no ${key} (A42, A29)`)
      }
      if ('outside' in link && link.outside !== true) {
        phase.fail(`${inspect} of ${fixture}: its link to ${target} is answered with outside ${stable(link.outside)}; ${target} is outside the workspace by its form, so outside, when given, is true (A42)`)
      }
    }
    if (withCanary.length > 0) {
      // The same answer when the target is not there at all: nothing may tell the two apart (A42, A29).
      let withoutCanary: Json[] = []
      await withServer(
        context,
        phase,
        async (session) => {
          if (session.tool(inspect)) withoutCanary = outwardLinks(await session.call(inspect, { path: fixture, preview: false }))
        },
        { env, before: (workspace) => workspace.guard.withholdOutsideCanary() },
      )
      const [present, absent] = [linkAnswer(withCanary), linkAnswer(withoutCanary)]
      if (present !== absent) {
        phase.fail(`${inspect} of ${fixture} answers its links outside the workspace differently when ../outside-canary.bin exists and when it does not (A42, A29): ${present} / ${absent}`)
      }
    }
    const fetched = [...new Set(proxy.requests.filter((request) => request.includes(OUTSIDE_TARGET)))]
    if (fetched.length > 0) phase.fail(`the kit fetched the remote target of a link (A42): ${fetched.join(', ')}`)
    if (withCanary.length > 0 && phase.failures.length === failed) {
      phase.note(
        `${inspect} of ${fixture} answered its links outside the workspace (${withCanary.map((link) => String(link.target)).join(', ')}) with exists: false and no path, ` +
          'the same with and without ../outside-canary.bin (A42)',
      )
    }
    if (context.denyNetwork) phase.note('the network was denied (A37), so a request for a link\'s remote target could not reach khp check\'s proxy and was not looked for')
    else phase.note('HTTP_PROXY, HTTPS_PROXY, and ALL_PROXY named a listener of khp check\'s own while the links-outside fixture was open; a request for a link\'s remote target fails (A42)')
  } finally {
    await proxy.close()
  }
}

/** What every phase's server did outside its workspace (section 10.6, containment.ts). */
async function containmentPhase(context: Context): Promise<PhaseResult> {
  const phase = new Phase(11, 'containment', true)
  for (const finding of context.containment) phase.fail(finding)
  if (context.extension) await linksOutside(phase, context)
  const names = Object.entries(OWNED).map(([name, folder]) => `${name} is ${folder}/`).join(', ')
  phase.note(
    `every server started in an empty folder of khp check's own (cwd/) with ${names}, each empty but for the canaries home/khp-canary.txt and ${PRIVATE}/khp-canary.txt, ` +
      `and from khp check's environment only ${environmentNames(context.options.env ?? {}).filter((name) => !(name in OWNED)).join(', ') || 'nothing'}; ` +
      'outside-canary.bin lies beside the workspace. After each phase khp check listed these folders, compared the canaries, and searched every tool result and every file written for their content',
  )
  if (context.options.probes === false) phase.note('phase 12 (probes) was skipped (--no-probes)')
  phase.note(
    `${PRIVATE}/ is the kit server's private runtime folder (A58), named by TMPDIR, TEMP, TMP, XDG_RUNTIME_DIR, and XDG_CACHE_HOME, at every tier: ` +
      `the kit wrote ${context.runtimeWrites} entries there, which is allowed; the canary ${PRIVATE}/khp-canary.txt, there before each start, may be read by no answer and no file`,
  )
  const leftovers = [...context.leftovers].sort()
  if (leftovers.length > 0) {
    const shown = leftovers.length > 8 ? `${leftovers.slice(0, 8).join(', ')} and ${leftovers.length - 8} more` : leftovers.join(', ')
    phase.note(`the kit left ${shown} in its private runtime folder when it exited (A58: a kit server SHOULD remove what it created there)`)
  }
  phase.note('a file the server wrote and removed again between two listings is not seen; the sandbox of Agent-ready complete denies such writes outside the workspace and the private runtime folder')
  phase.note('child processes and network connections are not watched here: the network is denied from Agent-ready on (A37), and the sandbox confines files at Agent-ready complete')
  return phase.result()
}

export async function runCheck(options: CheckOptions): Promise<{ report: Report; exit: 0 | 1 | 2 }> {
  const argv = splitCommand(options.kit)
  if (argv.length === 0) throw new UsageError('--kit needs the command that starts the kit')
  if (!argv.some((word) => word.includes('{workspace}'))) {
    throw new UsageError(
      'the start command names no {workspace}: khp check starts the kit server in an empty folder of its own, not in the workspace, so it sees what the server writes there (section 10.6). ' +
        'Pass the workspace with the placeholder, for example --kit "my-kit-server --workspace {workspace}"',
    )
  }
  for (const name of Object.keys(options.env ?? {})) {
    const problem = envProblem(name)
    if (problem) throw new UsageError(problem)
  }
  // Under the sandbox, a readable folder that holds khp check's own folders would let the server read the canaries.
  if (options.sandbox) {
    const base = realFolder(tempBase(options))
    for (const folder of [...(options.package ? [options.package] : []), ...(options.allowRead ?? [])]) {
      const real = realFolder(folder)
      if (base === real || base.startsWith(real + path.sep)) {
        throw new UsageError(`${folder} holds khp check's temporary folder (${base}), so under --sandbox the kit server could read outside its workspace; pass a narrower --allow-read or --package`)
      }
    }
  }
  // The server starts in an empty folder, so a relative executable is resolved here.
  if (/[\\/]/.test(argv[0] as string) && !path.isAbsolute(argv[0] as string)) argv[0] = path.resolve(argv[0] as string)
  const packageDir = options.package ? path.resolve(options.package) : undefined
  const packageManifest = packageDir ? readJson(path.join(packageDir, 'kit.json')) : undefined
  if (packageDir && !isObject(packageManifest)) throw new UsageError(`${path.join(packageDir, 'kit.json')} is not a JSON object`)
  const fixtures = path.resolve(options.fixtures ?? (packageDir ? path.join(packageDir, 'conformance') : ''))
  if (!options.fixtures && !packageDir) throw new UsageError('pass --package or --fixtures')
  if (!fs.existsSync(fixtures)) throw new UsageError(`the fixtures folder ${fixtures} is not there`)
  const containment: string[] = []
  let manifest: Json
  try {
    const reading = { argv, fixtures, denyNetwork: false, options, level: options.level ?? 'basic', containment, runtimeWrites: 0, leftovers: new Set() } as unknown as Context
    manifest = isObject(packageManifest) ? packageManifest : await manifestFromServer(reading, options.kitId)
  } catch (error) {
    if (error instanceof StartError) return startFailure(options, error)
    throw error
  }
  const declared = LEVELS.includes(manifest.level as Level) ? (manifest.level as Level) : 'basic'
  const level = options.level ?? declared
  const agent = isObject(manifest.agent) ? manifest.agent : {}
  const formats = Array.isArray(manifest.formats) ? manifest.formats.filter(isObject) : []
  const editFormat = formats.find((format) => format.role === 'edit') ?? formats[0]
  const extension = Array.isArray(editFormat?.extensions) ? String(editFormat.extensions[0]) : ''
  const editJson = readJson(path.join(fixtures, 'edit.json'))
  const steps = isObject(editJson) && Array.isArray(editJson.steps) ? (editJson.steps.filter(isObject) as { command: string; params?: Json }[]) : []
  const catalogueFile = packageDir ? path.join(packageDir, 'agent', 'checks.json') : undefined
  const catalogue = catalogueFile && fs.existsSync(catalogueFile) ? readJson(catalogueFile) : undefined
  const denyNetwork = rank(level) >= 1 && canDenyNetwork()
  const context: Context = {
    options,
    level,
    manifest,
    packageManifest: isObject(packageManifest) ? packageManifest : undefined,
    packageDir,
    fixtures,
    prefix: typeof agent.prefix === 'string' ? agent.prefix : '',
    basic: `basic.${extension}`,
    extension,
    edit: steps,
    catalogue: Array.isArray(catalogue) ? (catalogue.filter(isObject) as Context['catalogue']) : undefined,
    denyNetwork,
    argv,
    containment,
    runtimeWrites: 0,
    leftovers: new Set(),
  }
  const phases: PhaseResult[] = []
  const missing: string[] = []
  if (!fs.existsSync(path.join(fixtures, context.basic))) missing.push(`${context.basic} is missing from the fixtures`)
  if (steps.length === 0) missing.push('edit.json has no steps')
  const run = async (fn: (context: Context) => Promise<PhaseResult>, phase: number, name: string) => {
    try {
      phases.push(await fn(context))
    } catch (error) {
      if (error instanceof StartError) throw error
      phases.push({ phase, name, passed: false, failures: [`khp check stopped: ${error instanceof Error ? error.message : String(error)}`], notes: [] })
    }
  }
  try {
    await run(manifestPhase, 1, 'manifest')
    await run(launchPhase, 2, 'launch')
    await run(toolsPhase, 3, 'tools')
    if (missing.length > 0) {
      phases.push({ phase: 4, name: 'fixtures', passed: false, failures: missing, notes: ['phases 4 to 10 need the fixtures'] })
    } else {
      await run(schemasPhase, 4, 'schemas')
      await run(actPhase, 5, 'act')
      await run(verifyPhase, 6, 'verify')
      if (rank(level) >= 1) await run(previewPhase, 7, 'preview')
      if (rank(level) >= 1 && agent.layout === true) await run(layoutPhase, 8, 'layout')
      await run(filesPhase, 9, 'files')
      if (agent.drafts === true) await run(draftsPhase, 10, 'drafts')
    }
    await run(containmentPhase, 11, 'containment')
    if (missing.length === 0 && context.options.probes !== false) await run(probesPhase, 12, 'probes')
  } catch (error) {
    if (error instanceof StartError) return startFailure(options, error, manifest, level, phases)
    throw error
  }
  const passed = phases.every((phase) => phase.passed)
  return { report: report(options, manifest, level, phases, passed, denyNetwork), exit: passed ? 0 : 1 }
}

/** The manifest's claim (K19) against the tier tested and its result. */
export function claimOf(manifest: Json | undefined, level: Level, passed: boolean): Claim {
  if (!manifest) return { level: null, verified: false, note: 'no manifest was read, so this run verifies no claim (K19)' }
  const claimed = LEVELS.includes(manifest.level as Level) ? (manifest.level as Level) : 'basic'
  const says = manifest.level === undefined ? `kit.json claims ${claimed} (no level: basic)` : `kit.json claims ${claimed}`
  if (level === claimed) {
    return passed
      ? { level: claimed, verified: true, note: `${says}; this run tested ${claimed} and passed, which verifies the claim (K19)` }
      : { level: claimed, verified: false, note: `${says}, but the kit does not pass the tier it claims (K19)` }
  }
  if (rank(level) > rank(claimed)) {
    return {
      level: claimed,
      verified: false,
      note: `${says}; this run tested ${level} (--level), above the claim, so its result is not a conformance claim at ${level}: a kit claims a tier in its manifest's level and passes khp check at that tier (K19)`,
    }
  }
  return passed
    ? { level: claimed, verified: false, note: `${says}; this run tested only ${level} (--level), so it does not verify the claim: run khp check at ${claimed} (K19)` }
    : { level: claimed, verified: false, note: `${says}, but the kit does not pass ${level}, so it does not pass the tier it claims either: each tier includes the one before (K19)` }
}

function report(options: CheckOptions, manifest: Json | undefined, level: Level, phases: PhaseResult[], passed: boolean, denyNetwork: boolean): Report {
  return {
    khp: KIT_LAYER_VERSION,
    kit: { id: typeof manifest?.id === 'string' ? manifest.id : null, version: typeof manifest?.version === 'string' ? manifest.version : null },
    level,
    passed,
    claim: claimOf(manifest, level, passed),
    tool: TOOL,
    platform: `${process.arch}-${process.platform}`,
    sandboxed: !!options.sandbox,
    networkDenied: denyNetwork,
    environment: environmentNames(options.env ?? {}),
    phases,
    attested: ['A7', 'A26'],
  }
}

function startFailure(options: CheckOptions, error: Error, manifest?: Json, level: Level = options.level ?? 'basic', phases: PhaseResult[] = []): { report: Report; exit: 2 } {
  const launch: PhaseResult = {
    phase: 2,
    name: 'launch',
    passed: false,
    failures: [`the server did not start or answer initialize: ${error.message}`],
    notes: [
      'khp check starts the server in an empty folder with only PATH, --env and its own HOME and temporary folders: a relative path in --kit does not resolve there, and a variable the server needs is passed with --env NAME=VALUE',
      ...(options.sandbox
        ? ['under --sandbox the server reads only the workspace, its package, its private runtime folder (A58), its executable (and a script\'s interpreter), and the system\'s folders: pass the other folders of its own install, such as its code or an interpreter\'s libraries, with --allow-read <folder>']
        : []),
    ],
  }
  return { report: report(options, manifest, level, [...phases, launch], false, false), exit: 2 }
}
