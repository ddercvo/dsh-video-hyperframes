// Installer covers the step users get wrong most often: editing a dsh profile's
// package.json and cordis.patch.yml by hand. A bare `- id:` row there is dropped
// silently, and `link:` vs a bare path is the difference between a plugin that
// loads and one that does not.
//
// These tests exercise the logic directly (no process spawning, which is
// unreliable in some sandboxes) and a real install/uninstall round trip against
// a throwaway DSH_HOME.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_NAME,
  OWNED_IDS,
  hasOwnRows,
  packageRoot,
  planProfileChange,
  removeOwnBlock,
  run,
} from '../scripts/lib/profile-install.mjs'

const BASE_PKG = JSON.stringify({
  name: 'dsh-profile-test',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}, null, 2)

const TEMPLATE = readFileSync(
  join(import.meta.dirname, '..', 'templates', 'cordis.patch.yml'),
  'utf8',
)

const planWith = (over = {}) => planProfileChange({
  pkgText: BASE_PKG,
  patchText: '',
  template: TEMPLATE,
  linkPath: 'link:/repo/path',
  uninstall: false,
  ...over,
})

test('template carries both owned rows under a single insert', () => {
  // The whole point of the template: rows must be `insert`, never bare `id`.
  assert.match(TEMPLATE, /^- insert:/m, 'template must start its rows with a top-level insert key')
  assert.equal(TEMPLATE.match(/^- insert:/gm).length, 1, 'exactly one insert key')
  for (const id of OWNED_IDS) {
    assert.match(TEMPLATE, new RegExp(`^\\s*- id: ${id}\\s*$`, 'm'), `template declares ${id}`)
  }
  // Markers delimit the managed block for clean uninstall.
  assert.match(TEMPLATE, /^# >>> dsh-tool-hyperframes/m)
  assert.match(TEMPLATE, /^# <<< dsh-tool-hyperframes/m)
})

test('template has no bare top-level id rows', () => {
  const bare = TEMPLATE.split('\n').filter((l) => /^- id: /.test(l))
  assert.deepEqual(bare, [], 'a bare top-level `- id:` is an override and gets dropped by dsh')
})

test('the insert rows sit one level below the insert key', () => {
  // dsh parses the `- insert:` list positionally: a row that slips back to the
  // top level fails with `bad indentation of a sequence entry`. Only the rows
  // this installer owns are checked here -- the preset's own child plugins are
  // nested deeper on purpose, under `plugins:`.
  const lines = TEMPLATE.split('\n')
  for (const id of OWNED_IDS) {
    const line = lines.find((l) => l.trim() === `- id: ${id}`)
    assert.ok(line, `${id} is present`)
    assert.equal(line.length - line.trimStart().length, 4, `${id} must be indented 4 spaces`)
  }
})

test('plan adds dependency, bundle and patch rows for a fresh profile', () => {
  const plan = planWith()
  assert.equal(plan.changed, true)
  const pkg = JSON.parse(plan.nextPackageJson)
  assert.equal(pkg.dependencies[PLUGIN_NAME], 'link:/repo/path')
  assert.ok(pkg.dsh.profile.bundles.includes(PLUGIN_NAME), 'bundle must be listed or the plugin never loads')
  assert.equal(hasOwnRows(plan.nextPatch), true)
})

test('plan is a no-op once installed', () => {
  const first = planWith()
  const second = planWith({ pkgText: first.nextPackageJson, patchText: first.nextPatch })
  assert.equal(second.changed, false, 're-running must not duplicate anything')
})

test('plan keeps existing bundle order and unrelated config', () => {
  const pkgText = JSON.stringify({
    name: 'p',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    dependencies: { somethingElse: 'link:/other' },
  })
  const pkg = JSON.parse(planWith({ pkgText }).nextPackageJson)
  assert.deepEqual(pkg.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME,
  ])
  assert.equal(pkg.dependencies.somethingElse, 'link:/other', 'unrelated dependencies survive')
})

test('append preserves the user\'s existing patch content', () => {
  const mine = '# mine\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n'
  const plan = planWith({ patchText: mine })
  assert.ok(plan.nextPatch.startsWith(mine.trimEnd()), 'existing rows stay first')
  assert.equal(hasOwnRows(plan.nextPatch), true)
})

test('uninstall restores the file byte for byte', () => {
  const mine = '# mine\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n'
  const installed = planWith({ patchText: mine })
  const removed = planProfileChange({
    pkgText: installed.nextPackageJson,
    patchText: installed.nextPatch,
    template: TEMPLATE,
    linkPath: 'link:/repo/path',
    uninstall: true,
  })
  assert.equal(removed.nextPatch, mine, 'the managed block and its markers must go, nothing else')
  const pkg = JSON.parse(removed.nextPackageJson)
  assert.equal(pkg.dependencies[PLUGIN_NAME], undefined)
  assert.ok(!pkg.dsh.profile.bundles.includes(PLUGIN_NAME))
})

test('uninstall leaves no residue in a file that was empty before', () => {
  const installed = planWith()
  const removed = planProfileChange({
    pkgText: installed.nextPackageJson,
    patchText: installed.nextPatch,
    template: TEMPLATE,
    linkPath: 'link:/repo/path',
    uninstall: true,
  })
  assert.equal(removed.nextPatch, '', 'an originally-empty patch file must come back empty')
})

test('removeOwnBlock falls back to indentation when markers are gone', () => {
  // Someone pasted the rows by hand and dropped the comments.
  const text = '- id: keep-me\n  name: x\n\n- insert:\n    - id: tool-hyperframes\n      name: dsh-tool-hyperframes\n    - id: preset-video\n      name: y\n'
  const result = removeOwnBlock(text)
  assert.ok(result !== null)
  assert.match(result, /- id: keep-me/)
  assert.doesNotMatch(result, /preset-video/)
})

test('removeOwnBlock returns null rather than guessing at an unknown shape', () => {
  assert.equal(removeOwnBlock('- id: unrelated\n  name: x\n'), null)
})

// --- --force: refreshing a profile installed from an older template --------------
//
// Without this the installer is a dead end for upgrades: it sees the rows, says
// "already configured", and leaves the old block in place -- while sounding like
// it just checked everything. The profile then keeps running stale instructions.

/**
 * A block from an earlier template: no markers, no preset, and `previewPort`
 * set to a value the current template does not use, so a leftover is visible.
 */
const OLD_BLOCK = [
  '- insert:',
  '    - id: tool-hyperframes',
  "      name: 'dsh-tool-hyperframes'",
  '      config:',
  '        previewPort: 9999',
  '',
].join('\n')

test('a plain re-run leaves an existing block untouched', () => {
  // Start from a package.json that is already set up -- otherwise `changed` is
  // true for an unrelated reason (the dependency is missing) and the assertion
  // would pass or fail on something this test is not about.
  const setUp = planWith()
  const plan = planWith({ pkgText: setUp.nextPackageJson, patchText: OLD_BLOCK })
  assert.equal(plan.changed, false)
  assert.equal(plan.nextPatch, OLD_BLOCK)
})

test('--force replaces an older block with the current template', () => {
  const plan = planWith({ patchText: OLD_BLOCK, force: true })
  assert.equal(plan.changed, true)
  assert.match(plan.nextPatch, /# >>> dsh-tool-hyperframes >>>/, 'the marker the new template carries')
  assert.match(plan.nextPatch, /preset-video/, 'the preset the old block lacked')
  assert.match(plan.nextPatch, /# <<< dsh-tool-hyperframes <<</)
  assert.equal(
    plan.nextPatch.match(/^- insert:/gm).length,
    1,
    'the old block must be removed, not left alongside the new one',
  )
  assert.doesNotMatch(plan.nextPatch, /previewPort: 9999/, 'no leftovers from the old block')
})

test('--force preserves unrelated rows the user has in the file', () => {
  const mine = '# mine\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n'
  const plan = planWith({ patchText: `${mine}\n${OLD_BLOCK}`, force: true })
  assert.ok(plan.nextPatch.startsWith(mine.trimEnd()), "the user's own rows stay first")
  assert.equal(plan.nextPatch.match(/^- insert:/gm).length, 1)
})

test('--force on a profile with no block just installs it', () => {
  const plan = planWith({ patchText: '', force: true })
  assert.equal(plan.changed, true)
  assert.equal(plan.nextPatch.match(/^- insert:/gm).length, 1)
})

test('--force does not duplicate the dependency or bundle entry', () => {
  const first = planWith()
  const forced = planWith({ pkgText: first.nextPackageJson, patchText: first.nextPatch, force: true })
  const pkg = JSON.parse(forced.nextPackageJson)
  assert.equal(pkg.dsh.profile.bundles.filter((b) => b === PLUGIN_NAME).length, 1)
})

test('bad JSON is reported, not thrown', () => {
  const plan = planWith({ pkgText: '{ not json' })
  assert.match(plan.error, /could not parse/)
  assert.equal(plan.changed, undefined)
})

test('run() performs a real install and uninstall round trip', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-install-test-'))
  try {
    const dir = join(home, 'profiles', 'testprofile')
    mkdirSync(dir, { recursive: true })
    const pkgFile = join(dir, 'package.json')
    const patchFile = join(dir, 'cordis.patch.yml')
    const mine = '# mine\n- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n'
    writeFileSync(pkgFile, BASE_PKG)
    writeFileSync(patchFile, mine)

    const installed = run({ profile: 'testprofile', dshHome: home })
    assert.equal(installed.ok, true)
    assert.equal(installed.changed, true)
    assert.ok(hasOwnRows(readFileSync(patchFile, 'utf8')))
    // `link:` + the repo root this test is running from, with forward slashes
    // so the value stays valid JSON on Windows.
    assert.equal(
      JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies[PLUGIN_NAME],
      `link:${packageRoot().replace(/\\/g, '/')}`,
    )
    assert.ok(installed.backups.length >= 2, 'both edited files are backed up')

    const again = run({ profile: 'testprofile', dshHome: home })
    assert.equal(again.changed, false, 'second run is a no-op')

    const dry = run({ profile: 'testprofile', dshHome: home, uninstall: true, dryRun: true })
    assert.equal(dry.ok, true)
    assert.ok(hasOwnRows(readFileSync(patchFile, 'utf8')), 'dry run must not write')

    const removed = run({ profile: 'testprofile', dshHome: home, uninstall: true })
    assert.equal(removed.ok, true)
    assert.equal(readFileSync(patchFile, 'utf8'), mine, 'user content restored exactly')
    assert.equal(JSON.parse(readFileSync(pkgFile, 'utf8')).dependencies[PLUGIN_NAME], undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('run() reports what it changed through the log callback', () => {
  // The whole point of the script is telling the user which files it touched.
  // A run() without a log callback is silent -- that shipped once and the CLI
  // printed nothing, so pin it here.
  const home = mkdtempSync(join(tmpdir(), 'dsh-install-test-'))
  try {
    const dir = join(home, 'profiles', 'quiet')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), BASE_PKG)

    const lines = []
    run({ profile: 'quiet', dshHome: home, log: (...a) => lines.push(a.join(' ')) })
    const output = lines.join('\n')
    assert.match(output, /dependency/)
    assert.match(output, /bundle/)
    assert.match(output, /patch rows/)
    assert.match(output, /backups/, 'the user should be told where the backups are')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('run() reports an unknown profile instead of creating one', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-install-test-'))
  try {
    mkdirSync(join(home, 'profiles', 'real'), { recursive: true })
    const result = run({ profile: 'nope', dshHome: home })
    assert.equal(result.ok, false)
    assert.match(result.message, /no such dsh profile/)
    assert.match(result.hint, /real/, 'the hint should list profiles that do exist')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
