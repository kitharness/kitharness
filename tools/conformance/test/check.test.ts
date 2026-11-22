import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { spawnSync } from 'node:child_process'

import { darwinProfile, refusedDifferently, runCheck, type Level, type Report } from '../src/check.ts'
import { Guard } from '../src/containment.ts'
import { format } from '../src/cli.ts'
import { decodePng, uniformity } from '../src/image.ts'
import { a18Problems, parameterProblems } from '../src/schema.ts'
import { splitCommand } from '../src/session.ts'
import { catalogue, MANIFEST, render } from './fixture-kit.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const KIT = `node ${JSON.stringify(path.join(here, 'fixture-kit.ts'))} --workspace {workspace}`

/** What the manifest says of `agent.links` (K21): the fixture kit's KHP_LINKS. */
type LinksDeclared = 'true' | 'false' | 'absent'

/**
 * The counter kit's package: kit.json, agent/, and conformance/ with its expected previews; as a
 * layout kit (`layout`, see the fixture's LAYOUTS) also `overflow.counter`. `declared` is what its
 * manifest says of `agent.links`, and `basicLinks` makes `basic.counter` link another counter.
 */
function counterPackage(claim?: Level, layout?: string, links = true, declared: LinksDeclared = 'true', basicLinks = false, khp?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khp-counter-'))
  const agent: Record<string, unknown> = { ...MANIFEST.agent, layout: layout !== undefined }
  delete agent.links
  if (declared !== 'absent') agent.links = declared === 'true'
  const manifest = { ...MANIFEST, ...(claim ? { level: claim } : {}), ...(khp ? { khp } : {}), agent }
  fs.writeFileSync(path.join(root, 'kit.json'), JSON.stringify(manifest, null, 2))
  fs.mkdirSync(path.join(root, 'agent'))
  fs.writeFileSync(path.join(root, 'agent', 'checks.json'), JSON.stringify(catalogue(layout)))
  fs.writeFileSync(path.join(root, 'agent', 'guide.md'), '# Counter\n')
  const fixtures = path.join(root, 'conformance')
  fs.mkdirSync(path.join(fixtures, 'expected'), { recursive: true })
  const basic = { title: 'Basic', count: 3, ...(basicLinks ? { link: ['check-negative.counter'] } : {}) }
  fs.writeFileSync(path.join(fixtures, 'basic.counter'), JSON.stringify(basic))
  fs.writeFileSync(path.join(fixtures, 'check-negative.counter'), JSON.stringify({ title: 'Below zero', count: -2 }))
  if (layout !== undefined) fs.writeFileSync(path.join(fixtures, 'overflow.counter'), JSON.stringify({ title: 'A title far too long for its box', count: 1 }))
  // The counter links files (A42), so it ships the links-outside fixture: the canary beside the workspace and a remote target.
  if (links) {
    const link = ['../outside-canary.bin', 'http://outside-canary.invalid/outside-canary.bin']
    fs.writeFileSync(path.join(fixtures, 'links-outside.counter'), JSON.stringify({ title: 'Links', count: 1, link }))
  }
  fs.writeFileSync(path.join(fixtures, 'edit.json'), JSON.stringify({ steps: [{ command: 'count.add', params: { by: 2 } }] }))
  fs.writeFileSync(path.join(fixtures, 'expected', 'basic.png'), render(basic))
  fs.writeFileSync(path.join(fixtures, 'expected', 'basic-scale-2.png'), render(basic, { scale: 2 }))
  fs.writeFileSync(path.join(fixtures, 'expected', 'tolerance.json'), JSON.stringify({ maxChannelDelta: 0, maxDifferentPixels: 0 }))
  return root
}

interface CheckCase {
  level?: Level
  broken?: string
  kit?: string
  claim?: Level
  model?: string
  layout?: string
  /** Comma-separated KHP_ESCAPE names: what the kit does outside its workspace (see the fixture's ESCAPES). */
  escape?: string
  /** `--no-probes`. */
  noProbes?: boolean
  /** Ship `links-outside.counter` (default true). */
  links?: boolean
  /** `--sandbox`, with `--allow-read` of this package's folder (the fixture kit's code and its node_modules). */
  sandbox?: boolean
  /** KHP_RUNTIME: what the kit keeps in its private runtime folder (see the fixture's RUNTIMES, A58). */
  runtime?: string
  /** KHP_LINKS: what the manifest says of `agent.links` (K21; default `true`). */
  declared?: LinksDeclared
  /** `basic.counter` links another counter in the workspace. */
  basicLinks?: boolean
  /** What the package's kit.json says in `khp` (K2; default the fixture's). */
  khp?: string
  /** Leave out `conformance/expected/`, the expected previews and their tolerance. */
  withoutExpected?: boolean
}

/**
 * Runs khp check on the counter kit. `broken` breaks one phase (KHP_BREAK), `claim` changes the tier
 * its manifest claims (KHP_CLAIM), `model` its object model (KHP_MODEL, see the fixture's MODELS),
 * `layout` makes it a layout kit (KHP_LAYOUT, see the fixture's LAYOUTS), and `escape` makes it reach
 * outside its workspace (KHP_ESCAPE). khp check gives the kit only the variables passed with `env`
 * (`--env`), so these reach it that way. khp check's folders are made inside the test's own temporary
 * folder, which the kit is told as KHP_TEST_ROOT: it touches nothing outside it.
 */
async function check(options: CheckCase = {}): Promise<{ report: Report; exit: number }> {
  const pkg = counterPackage(options.claim, options.layout, options.links ?? true, options.declared ?? 'true', options.basicLinks ?? false, options.khp)
  if (options.withoutExpected) fs.rmSync(path.join(pkg, 'conformance', 'expected'), { recursive: true })
  // Under /tmp where there is one, as khp check's own default, so a socket path in the kit's TMPDIR stays short.
  const base = process.platform !== 'win32' && fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()
  const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(base, 'khp-test-')))
  const values: Record<string, string | undefined> = {
    KHP_RUNTIME: options.runtime,
    KHP_LINKS: options.declared === undefined || options.declared === 'true' ? undefined : options.declared,
    KHP_BREAK: options.broken,
    KHP_CLAIM: options.claim,
    KHP_MODEL: options.model,
    KHP_LAYOUT: options.layout,
    KHP_ESCAPE: options.escape,
    KHP_TEST_ROOT: testRoot,
  }
  const env = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined))
  try {
    return await runCheck({
      kit: options.kit ?? KIT,
      package: pkg,
      level: options.level,
      env,
      tempDir: testRoot,
      ...(options.noProbes ? { probes: false } : {}),
      ...(options.sandbox ? { sandbox: true, allowRead: [path.dirname(here)] } : {}),
    })
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true })
    fs.rmSync(testRoot, { recursive: true, force: true })
  }
}

const failed = (report: Report) => report.phases.filter((phase) => !phase.passed).map((phase) => phase.name)

describe('khp check on a conforming kit', () => {
  test('passes Agent-ready with every phase it runs', async () => {
    const { report, exit } = await check()
    assert.deepEqual(failed(report), [], format(report))
    assert.equal(exit, 0)
    assert.equal(report.passed, true)
    assert.deepEqual(
      report.phases.map((phase) => phase.phase),
      [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12],
      'no layout phase: the kit is not a layout kit',
    )
    assert.deepEqual(report.attested, ['A7', 'A26'])
    assert.equal(report.kit.id, 'org.example.counter')
  })

  test('passes basic too', async () => {
    const { report, exit } = await check({ level: 'basic' })
    assert.equal(exit, 0, format(report))
    assert.deepEqual(
      report.phases.map((phase) => phase.phase),
      [1, 2, 3, 4, 5, 6, 9, 10, 11, 12],
    )
  })

  test('does not pass Agent-ready complete without the sandbox and the A44 check', async () => {
    const { report, exit } = await check({ level: 'agent-ready-complete' })
    assert.equal(exit, 1)
    assert.ok(failed(report).includes('launch'), format(report))
    assert.ok(failed(report).includes('act'))
  })
})

describe('khp check catches each broken phase', () => {
  const cases: [string, string][] = [
    ['manifest', 'manifest'],
    ['launch', 'launch'],
    ['tools', 'tools'],
    ['schemas', 'schemas'],
    ['detail', 'schemas'],
    ['compact', 'schemas'],
    ['act', 'act'],
    ['atomic', 'act'],
    ['outside', 'act'],
    ['preview-on-request', 'preview'],
    ['search', 'schemas'],
    ['verify', 'verify'],
    ['preview', 'preview'],
    ['files', 'files'],
    ['drafts', 'drafts'],
    ['batch', 'act'],
  ]
  for (const [broken, phase] of cases) {
    test(`a kit broken in ${broken} fails ${phase}`, async () => {
      const { report, exit } = await check({ broken })
      assert.equal(exit, 1, format(report))
      assert.ok(failed(report).includes(phase), `${phase} should fail:\n${format(report)}`)
    })
  }

  test('a server that does not start exits 2', async () => {
    const { report, exit } = await check({ broken: 'start' })
    assert.equal(exit, 2)
    assert.equal(report.passed, false)
  })
})

describe('the expected previews are conformance/expected/ (A39)', () => {
  test('without conformance/expected/ the preview phase fails and names the files it needs there', async () => {
    const { report, exit } = await check({ withoutExpected: true })
    assert.equal(exit, 1, format(report))
    assert.deepEqual(failed(report), ['preview'], format(report))
    const failures = report.phases.find((phase) => phase.name === 'preview')?.failures.join('\n') ?? ''
    assert.match(failures, /expected\/tolerance\.json is missing/, failures)
    assert.match(failures, /expected\/basic\.png is missing: the expected preview of basic/, failures)
  })
})

describe('the manifest names the kit-layer version (K2)', () => {
  test('a kit whose khp names KHP 1.1, the protocol version, rather than kit layer 1.0 fails the manifest phase', async () => {
    const { report, exit } = await check({ level: 'basic', khp: '1.1' })
    assert.equal(exit, 1, format(report))
    assert.equal(report.khp, '1.0', 'the report names the kit layer it tested')
    const failures = report.phases.find((phase) => phase.name === 'manifest')?.failures.join('\n') ?? ''
    assert.match(failures, /khp is 1\.1; it names the kit-layer version the kit conforms to, and this tool checks kit layer 1\.0 \(K2\)/, format(report))
  })
})

describe('khp check tells the tier tested from the tier claimed (K19)', () => {
  test('a pass above the claimed tier says it is not a conformance claim', async () => {
    const { report, exit } = await check({ claim: 'basic', level: 'agent-ready' })
    assert.equal(exit, 0, format(report))
    assert.equal(report.level, 'agent-ready')
    assert.equal(report.claim.level, 'basic')
    assert.equal(report.claim.verified, false)
    assert.match(report.claim.note, /not a conformance claim/)
    assert.match(format(report), /kit\.json claims basic.*tested agent-ready.*not a conformance claim/s)
  })

  test('without --level it tests the claimed tier and verifies the claim', async () => {
    const { report, exit } = await check({ claim: 'basic' })
    assert.equal(exit, 0, format(report))
    assert.equal(report.level, 'basic')
    assert.deepEqual([report.claim.level, report.claim.verified], ['basic', true])
  })

  test('a pass below the claimed tier does not verify the claim', async () => {
    const { report, exit } = await check({ level: 'basic' })
    assert.equal(exit, 0, format(report))
    assert.deepEqual([report.claim.level, report.claim.verified], ['agent-ready', false])
    assert.match(format(report), /claims agent-ready.*does not verify/s)
  })

  test('a kit that fails the tier it claims has its claim refuted', async () => {
    const { report, exit } = await check({ broken: 'preview' })
    assert.equal(exit, 1)
    assert.deepEqual([report.claim.level, report.claim.verified], ['agent-ready', false])
    assert.match(report.claim.note, /does not pass the tier it claims/)
  })
})

describe('the A16 round trip writes only a free string field', () => {
  const act = (report: Report) => report.phases.find((phase) => phase.name === 'act')

  test('it skips identity, enum, and reference fields its describe answer shows, and moves past a field the kit refuses', async () => {
    const { report, exit } = await check({ model: 'awkward' })
    assert.equal(exit, 0, format(report))
    const notes = act(report)?.notes.join('\n') ?? ''
    assert.match(notes, /n1\.text/, notes)
    assert.doesNotMatch(notes, /refused root\.(handle|kind|owner)\b/, 'fields its schema or values rule out are never probed')
    assert.match(notes, /root\.handle \(read-only\)/, notes)
    assert.match(notes, /root\.kind \(enum\)/, notes)
    assert.match(notes, /root\.owner \(an object's id\)/, notes)
    assert.match(notes, /refused root\.body \(invalid-op/, 'a refused field is named with its code')
  })

  test('without a describe answer it still skips identity and reference fields', async () => {
    const { report, exit } = await check({ model: 'awkward-undescribed' })
    assert.equal(exit, 0, format(report))
    const notes = act(report)?.notes.join('\n') ?? ''
    assert.match(notes, /n1\.text/, notes)
    assert.doesNotMatch(notes, /refused root\.(handle|owner)\b/, notes)
    assert.match(notes, /refused root\.kind \(invalid-value/, 'without a schema the enum is found by its refusal')
  })

  test('a refusal that stays in the session fails, rather than reading as a field the kit does not take', async () => {
    const { report, exit } = await check({ model: 'awkward', broken: 'refusal' })
    assert.equal(exit, 1)
    const failures = act(report)?.failures.join('\n') ?? ''
    assert.match(failures, /refused root\.body .*reads "khp check"/, failures)
  })

  test('with no free string field it says so instead of probing an unsuitable one', async () => {
    const { report, exit } = await check({ model: 'unfit' })
    assert.equal(exit, 1)
    const failures = act(report)?.failures.join('\n') ?? ''
    assert.match(failures, /no free string field/, failures)
    assert.doesNotMatch(failures, /batch set root\./, failures)
  })
})

describe('overflow diagnostics are the codes the catalogue tags `overflow` (A38, A40)', () => {
  const phaseOf = (report: Report, name: string) => report.phases.find((phase) => phase.name === name)

  test('a code named without "overflow" but tagged in agent/checks.json is an overflow code', async () => {
    const { report, exit } = await check({ layout: 'tagged' })
    assert.equal(exit, 0, format(report))
    assert.deepEqual(
      report.phases.map((phase) => phase.phase),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    )
    assert.equal(phaseOf(report, 'layout')?.passed, true, format(report))
  })

  test('a code named like an overflow but not tagged fails phase 8 and says what to add', async () => {
    const { report, exit } = await check({ layout: 'untagged' })
    assert.equal(exit, 1, format(report))
    assert.deepEqual(failed(report), ['layout'], format(report))
    const failures = phaseOf(report, 'layout')?.failures.join('\n') ?? ''
    assert.match(failures, /overflow\.counter/, 'names the fixture it checked')
    assert.match(failures, /counter\.text-overflow/, 'names the codes the check reported')
    assert.match(failures, /none .*`overflow` in agent\/checks\.json/, 'says none is tagged')
    assert.match(failures, /"overflow": "text"/, 'says what to add')
  })

  test('a tagged overflow code without a target fails phase 8', async () => {
    const { report, exit } = await check({ layout: 'no-target' })
    assert.equal(exit, 1, format(report))
    assert.match(phaseOf(report, 'layout')?.failures.join('\n') ?? '', /counter\.spill.*no target/, format(report))
  })

  test('an overflow that is not text, off-page, or page-break is refused in the manifest phase', async () => {
    const { report, exit } = await check({ layout: 'bad-tag' })
    assert.equal(exit, 1, format(report))
    assert.match(phaseOf(report, 'manifest')?.failures.join('\n') ?? '', /counter\.spill.*overflow "sideways".*text, off-page, or page-break/, format(report))
  })

  test('at Agent-ready complete the layout answer\'s kind agrees with the tag of the code reported for it', async () => {
    const agrees = await check({ level: 'agent-ready-complete', layout: 'tagged' })
    assert.equal(phaseOf(agrees.report, 'layout')?.passed, true, format(agrees.report))
    const { report } = await check({ level: 'agent-ready-complete', layout: 'wrong-kind' })
    assert.match(phaseOf(report, 'layout')?.failures.join('\n') ?? '', /text overflow of root.*counter\.spill.*off-page/, format(report))
  })
})

describe('containment: the kit reads and writes only inside its workspace (section 10.6), at every tier', () => {
  const containment = (report: Report) => report.phases.find((phase) => phase.name === 'containment')

  test('the conforming kit leaves its current folder, HOME and the temporary folders empty', async () => {
    const { report, exit } = await check({ level: 'basic' })
    assert.equal(exit, 0, format(report))
    const notes = containment(report)?.notes.join('\n') ?? ''
    assert.match(notes, /empty folder/, notes)
  })

  test('a kit that writes into HOME whenever it starts fails, naming the file', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'home-write' })
    assert.equal(exit, 1, format(report))
    assert.deepEqual(failed(report), ['containment', 'probes'], 'phase 11 reports phases 1 to 11; phase 12 reports its own start')
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /wrote outside its workspace \(section 10\.6\): home\/\.counter-kit\/state\.json/, failures)
    assert.match(failures, /^1 manifest: /m, 'says in which phase it happened')
  })

  test('a kit that writes beside its workspace fails, naming the file', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'beside-write' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /wrote outside its workspace \(section 10\.6\): counter-kit\.log/, failures)
  })

  test('a kit that keeps a socket and a cache in its private runtime folder and removes them at exit passes at basic (A58)', async () => {
    const { report, exit } = await check({ level: 'basic', runtime: 'tidy' })
    assert.equal(exit, 0, format(report))
    const notes = containment(report)?.notes.join('\n') ?? ''
    assert.match(notes, /private\/ is the kit server's private runtime folder \(A58\).*wrote [1-9]\d* entries there/, notes)
    assert.doesNotMatch(notes, /left .* in its private runtime folder/, notes)
  })

  test('files left in the private runtime folder at exit are a note, not a failure (A58)', async () => {
    const { report, exit } = await check({ level: 'basic', runtime: 'leave' })
    assert.equal(exit, 0, format(report))
    const notes = containment(report)?.notes.join('\n') ?? ''
    assert.match(notes, /left .*private\/counter\.sock.* in its private runtime folder.*SHOULD remove/, notes)
  })

  test('a kit that reads a file that was in its private runtime folder before it started, and answers it, fails (A58)', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'read-private' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /read a file outside its workspace and answered its content \(section 10\.6, A29, A58\): the content of private\/khp-canary\.txt is in the answer of counter_inspect/, failures)
  })

  test('a kit that writes into its current folder on inspect fails, naming the file', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'cwd-write' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /wrote outside its workspace \(section 10\.6\): cwd\/inspect\.log/, failures)
  })

  /** Runs khp check with `options` on the counter package, which it must refuse before starting the kit. */
  const refused = async (options: { kit?: string; env?: Record<string, string> }, message: RegExp) => {
    const pkg = counterPackage()
    try {
      await assert.rejects(runCheck({ kit: KIT, package: pkg, ...options }), message)
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
    }
  }

  test('the links-outside fixture is opened, checked and exported, and the linked canary never shows', async () => {
    const { report, exit } = await check({ level: 'basic' })
    assert.equal(exit, 0, format(report))
    const notes = containment(report)?.notes.join('\n') ?? ''
    assert.match(notes, /links-outside\.counter.*counter_inspect.*counter_check.*counter_export/, notes)
    assert.match(notes, /answered its links outside the workspace .*exists: false.*the same with and without \.\.\/outside-canary\.bin/, notes)
  })

  test('a kit that says a link outside its workspace exists fails (A42)', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'link-exists' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /link to \.\.\/outside-canary\.bin is answered with exists: true; a target outside the workspace is answered exists: false \(A42, A29\)/, failures)
  })

  test('a kit that answers a link outside its workspace differently when its target exists fails (A42)', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'link-probe' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /answers its links outside the workspace differently when \.\.\/outside-canary\.bin exists and when it does not \(A42, A29\)/, failures)
    assert.doesNotMatch(failures, /exists: true/, 'it never says exists: true; only the difference shows it')
  })

  test('a kit that fetches a link\'s remote target fails (A42)', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'fetch-remote' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /fetched the remote target of a link \(A42\): GET http:\/\/outside-canary\.invalid\/outside-canary\.bin/, failures)
  })

  test('a kit that embeds a linked file from outside its workspace in an export fails, naming the file it wrote', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'embed-link' })
    assert.equal(exit, 1, format(report))
    const failures = containment(report)?.failures.join('\n') ?? ''
    assert.match(failures, /read a file outside its workspace and wrote its content \(section 10\.6, A29\): the content of outside-canary\.bin is in workspace\/khp-links-export\.json/, failures)
  })

  test('without the links-outside fixture a kit that does not declare agent.links is not checked, and does not fail', async () => {
    const { report, exit } = await check({ level: 'basic', links: false, declared: 'absent' })
    assert.equal(exit, 0, format(report))
    assert.match(containment(report)?.notes.join('\n') ?? '', /not checked: no links-outside fixture/)
  })

  test('a kit that declares agent.links: true without the links-outside fixture fails (K21)', async () => {
    const { report, exit } = await check({ level: 'basic', links: false })
    assert.equal(exit, 1, format(report))
    assert.deepEqual(failed(report), ['containment'], format(report))
    assert.match(containment(report)?.failures.join('\n') ?? '', /agent\.links is true, but the fixtures have no links-outside\.counter \(K21\)/)
  })

  test('a kit whose manifest does not declare links but whose basic fixture answers links fails (K21)', async () => {
    for (const declared of ['false', 'absent'] as const) {
      const { report, exit } = await check({ level: 'basic', links: false, declared, basicLinks: true })
      assert.equal(exit, 1, format(report))
      assert.match(containment(report)?.failures.join('\n') ?? '', /agent\.links is (false|not said), but counter_inspect of basic\.counter answers 1 link \(K21\)/, format(report))
    }
  })

  test('khp check owns HOME and the temporary folders: --env cannot set them', async () => {
    await refused({ env: { HOME: os.tmpdir() } }, /--env cannot set HOME/)
    await refused({ env: { XDG_CONFIG_HOME: os.tmpdir() } }, /--env cannot set XDG_CONFIG_HOME/)
  })

  test('the start command names the workspace with {workspace}', async () => {
    await refused({ kit: KIT.replace(' --workspace {workspace}', '') }, /\{workspace\}/)
  })
})

describe('probes: string and file parameters that name a file outside the workspace, at every tier', () => {
  const phaseOf = (report: Report, name: string) => report.phases.find((phase) => phase.name === name)
  const failuresOf = (report: Report, name: string) => phaseOf(report, name)?.failures.join('\n') ?? ''

  test('the conforming kit takes the canary\'s path as a title, refuses the hidden command through the batch, and passes', async () => {
    const { report, exit } = await check({ level: 'basic' })
    assert.equal(exit, 0, format(report))
    const notes = phaseOf(report, 'probes')?.notes.join('\n') ?? ''
    assert.match(notes, /title\.set\.title/, notes)
    assert.match(notes, /counter_batch.*command operation/, notes)
    assert.match(notes, /count\.reset.*refused/, 'the hidden id the unknown-command error names is tried and refused')
  })

  test('a kit that reads a file a string parameter names and answers its bytes fails, through run and through the batch', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'read-string' })
    assert.equal(exit, 1, format(report))
    assert.deepEqual(failed(report), ['probes'], format(report))
    const failures = failuresOf(report, 'probes')
    assert.match(failures, /title\.set .*read a file outside its workspace and answered its content \(section 10\.6, A29\): the content of outside-canary\.bin is in the answer of counter_run/, failures)
    assert.match(failures, /file:/, 'the file: URL is tried too')
    assert.match(failures, /in the answer of counter_batch/, 'and through the batch command operation')
  })

  test('a kit that deletes a file a string parameter names fails, naming the canary', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'delete-string' })
    assert.equal(exit, 1, format(report))
    const failures = failuresOf(report, 'probes')
    assert.match(failures, /title\.set .*deleted a file outside its workspace \(section 10\.6, A29\): outside-canary\.bin/, failures)
  })

  test('a file parameter that follows a symbolic link out fails phase 9', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'param-symlink' })
    assert.equal(exit, 1, format(report))
    const failures = failuresOf(report, 'files')
    assert.match(failures, /count\.import from: a path through a symbolic link \(an existing file, khp-link\/outside\.counter\): counter_run succeeded; it must fail with not-allowed/, failures)
  })

  test('a file parameter that tells an existing outside file from a missing one fails phase 9 (A29)', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'param-exists' })
    assert.equal(exit, 1, format(report))
    const failures = failuresOf(report, 'files')
    assert.match(failures, /count\.import from: a path through \.\. is refused differently for an existing and a missing file: not-allowed, not-found \(A29\)/, failures)
  })

  test('a batch that runs a command the listing hides fails', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'batch-hidden' })
    assert.equal(exit, 1, format(report))
    const failures = failuresOf(report, 'probes')
    assert.match(failures, /counter_batch ran count\.reset, which counter_commands does not list/, failures)
  })

  test('--no-probes skips phase 12 and says so', async () => {
    const { report, exit } = await check({ level: 'basic', escape: 'read-string', noProbes: true })
    assert.equal(exit, 0, format(report))
    assert.equal(phaseOf(report, 'probes'), undefined)
    assert.match(phaseOf(report, 'containment')?.notes.join('\n') ?? '', /phase 12 \(probes\) was skipped \(--no-probes\)/)
  })
})

describe('the sandbox of Agent-ready complete denies reads and writes outside the workspace, its package, and its private runtime folder (section 10.6, A58)', () => {
  test('the profile lets a process start and read the workspace, and denies the canary, HOME, and the folder beside the workspace', () => {
    if (process.platform !== 'darwin') return assert.match(darwinProfile({ root: '/r', workspace: '/r/w', runtime: '/r/p', reads: [], executables: [] }), /file-read-data/)
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'khp-profile-')))
    try {
      for (const folder of ['workspace', 'home', 'private', 'package']) fs.mkdirSync(path.join(root, folder))
      fs.writeFileSync(path.join(root, 'workspace', 'basic.txt'), 'in the workspace\n')
      fs.writeFileSync(path.join(root, 'package', 'kit.json'), '{}\n')
      fs.writeFileSync(path.join(root, 'outside-canary.bin'), 'canary\n')
      fs.writeFileSync(path.join(root, 'home', 'khp-canary.txt'), 'canary\n')
      const profile = darwinProfile({ root, workspace: path.join(root, 'workspace'), runtime: path.join(root, 'private'), reads: [path.join(root, 'package')], executables: [] })
      const sh = (script: string) => spawnSync('sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { encoding: 'utf8' })
      const at = (...names: string[]) => `'${path.join(root, ...names)}'`
      assert.equal(sh(`cat ${at('workspace', 'basic.txt')}`).stdout, 'in the workspace\n', 'the workspace is readable')
      assert.equal(sh(`cat ${at('package', 'kit.json')}`).status, 0, 'the package is readable')
      assert.notEqual(sh(`cat ${at('outside-canary.bin')}`).status, 0, 'the canary beside the workspace is not readable')
      assert.notEqual(sh(`cat ${at('home', 'khp-canary.txt')}`).status, 0, 'HOME is not readable')
      assert.notEqual(sh(`ls ${at()}`).status, 0, 'the folder beside the workspace cannot be listed')
      assert.notEqual(sh(`echo x > ${at('home', 'x')}`).status, 0, 'HOME is not writable')
      assert.equal(sh(`echo x > ${at('private', 'x')} && echo x > ${at('workspace', 'x')}`).status, 0, 'the private runtime folder and the workspace are writable')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('a readable folder that holds khp check\'s own folders is refused', async () => {
    const pkg = counterPackage()
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'khp-parent-'))
    try {
      fs.mkdirSync(path.join(parent, 'temp'))
      await assert.rejects(runCheck({ kit: KIT, package: pkg, sandbox: true, tempDir: path.join(parent, 'temp'), allowRead: [parent] }), /holds khp check's temporary folder/)
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true })
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })

  test('the fixture kit passes every phase but A44 under --sandbox, and a read outside its workspace is denied', async () => {
    const { report } = await check({ level: 'agent-ready-complete', sandbox: true, escape: 'read-string' })
    if (process.platform !== 'darwin') return assert.match(report.phases.find((phase) => phase.name === 'launch')?.failures.join('\n') ?? '', /macOS only/)
    assert.deepEqual(failed(report), ['act'], format(report))
    assert.match(report.phases.find((phase) => phase.name === 'act')?.failures.join('\n') ?? '', /A44/)
    assert.equal(report.sandboxed, true)
  })
})

describe('the rules khp check applies', () => {
  test('two refusals differ by code or by message once the path is taken out, not by a word the path shares with the prose (A29)', () => {
    const refusal = (target: string, code: string, message: string) => ({ target, result: { isError: true, structured: { error: { code, message } }, content: [] } })
    const same = (stem: string) => refusal(`../outside/${stem}.md`, 'not-allowed', `\`../outside/${stem}.md\` is outside the workspace`)
    assert.equal(refusedDifferently(same('outside'), same('missing')), undefined)
    const hidden = (stem: string) => refusal(`.khp-hidden/${stem}.md`, 'not-allowed', `\`${stem}.md\` names a hidden file or folder`)
    assert.equal(refusedDifferently(hidden('hidden'), hidden('missing')), undefined)
    assert.match(refusedDifferently(same('outside'), refusal('../outside/missing.md', 'not-found', 'no such file')) ?? '', /not-allowed, not-found/)
    assert.match(refusedDifferently(same('outside'), refusal('../outside/missing.md', 'not-allowed', 'no such file')) ?? '', /no such file/)
  })

  test('a file the kit wrote outside its workspace is reported once, and its removal is not a deletion of khp check\'s files', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'khp-guard-')))
    try {
      fs.mkdirSync(path.join(root, 'workspace'))
      const guard = new Guard(root, path.join(root, 'workspace'))
      fs.writeFileSync(path.join(root, 'home', 'kit.sock'), '')
      fs.writeFileSync(path.join(root, 'xdg-config', 'kit.json'), '{}')
      assert.deepEqual(guard.check(undefined), ['the kit wrote outside its workspace (section 10.6): home/kit.sock, xdg-config/kit.json'])
      fs.rmSync(path.join(root, 'home', 'kit.sock'))
      fs.rmSync(path.join(root, 'xdg-config', 'kit.json'))
      assert.deepEqual(guard.check(undefined), [], 'the kit removed its own files')
      // A58: the private runtime folder is the kit server's own, at every tier.
      fs.writeFileSync(path.join(root, 'private', 'kit.sock'), '')
      assert.deepEqual(guard.check(undefined), [], 'a file in the private runtime folder is allowed')
      assert.equal(guard.runtimeWrites, 1)
      assert.deepEqual(guard.leftovers(), ['private/kit.sock'], 'and listed when it is still there at exit')
      fs.rmSync(path.join(root, 'private', 'khp-canary.txt'))
      assert.deepEqual(guard.check(undefined), ['the kit deleted a file outside its workspace (section 10.6, A29): private/khp-canary.txt'], 'the canary planted there before the start is not the kit\'s')
      fs.rmSync(path.join(root, 'outside-canary.bin'))
      assert.deepEqual(guard.check(undefined), ['the kit deleted a file outside its workspace (section 10.6, A29): outside-canary.bin'])
      assert.ok(fs.existsSync(path.join(root, 'outside-canary.bin')), 'the canary is put back')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('splits a start command like a shell', () => {
    assert.deepEqual(splitCommand(`kit --workspace "./my fixtures" --x 'a b' ""`), ['kit', '--workspace', './my fixtures', '--x', 'a b', ''])
    assert.throws(() => splitCommand('kit "open'))
  })

  test('reads ParameterSchemaSpec, its JSON Schema form, and file parameters (A5, A28, A29)', () => {
    assert.deepEqual(parameterProblems({ x: { type: 'integer', required: true }, style: { type: 'object', additionalProperties: true } }, 'c'), [])
    assert.deepEqual(parameterProblems({ type: 'object', properties: { to: { type: 'string', 'x-khp-file': { access: 'create', accept: ['png'] } } } }, 'c'), [])
    assert.match(parameterProblems('{x, y}', 'c')[0] ?? '', /a text, not a ParameterSchemaSpec/)
    assert.match(parameterProblems(undefined, 'c')[0] ?? '', /no parameter schema/)
    assert.match(parameterProblems({ style: { type: 'object' } }, 'c')[0] ?? '', /additionalProperties/)
    assert.match(parameterProblems({ f: { type: 'file', access: 'read', accept: ['.png'] } }, 'c')[0] ?? '', /dot/)
    assert.match(parameterProblems({ f: { type: 'file', kind: 'folder', access: 'write' } }, 'c')[0] ?? '', /folders are read only/)
  })

  test('knows an A18 error', () => {
    assert.deepEqual(a18Problems({ error: { code: 'not-allowed', message: 'no', index: 0 } }), [])
    assert.ok(a18Problems({ error: { code: 'nope', message: 'no' } }).length > 0)
    assert.ok(a18Problems({ error: { code: 'failed' } }).length > 0)
    assert.ok(a18Problems(undefined).length > 0)
  })

  test('calls a single-colour preview uniform (A39)', () => {
    process.env.KHP_BREAK = 'preview'
    try {
      assert.match(uniformity(decodePng(render({ title: 'x', count: 1 }))) ?? '', /1 colour/)
    } finally {
      delete process.env.KHP_BREAK
    }
    assert.equal(uniformity(decodePng(render({ title: 'x', count: 1 }))), undefined)
  })
})
