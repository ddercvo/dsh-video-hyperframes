/**
 * Validate a dsh profile patch file.
 *
 * Two layers, because they catch different mistakes:
 *
 *  1. The harness's own parser, via `dsh --dump-config`. This is the real
 *     acceptance test: a bare `- id:` row that no bundle contributed is silently
 *     dropped with `entry "<id>" not found`, and a mis-indented `insert` list
 *     throws a YAMLException. Neither shows up in a hand-rolled check.
 *  2. js-yaml with the `!!js` tag registered, for a readable structural report
 *     and to syntax-check the JavaScript expressions. Plain js-yaml rejects the
 *     unknown tag, so the tag has to be registered before anything is verified.
 *
 * Usage: node validate-patch.mjs <path/to/cordis.patch.yml>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
/**
 * js-yaml ships with the harness; borrow its copy instead of adding a dep.
 *
 * dsh runs through npx, so its real package tree lives in a per-install cache
 * directory whose hash changes. Glob for it rather than hardcoding one — a
 * hardcoded path makes this script work on exactly one machine and breaks
 * silently when npx rehashes.
 */
const NPM_CACHE = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'npm-cache', '_npx')
  : join(homedir(), 'AppData', 'Local', 'npm-cache', '_npx')

function findHarnessModules() {
  if (process.env.HYPERFRAMES_HARNESS_MODULES) return process.env.HYPERFRAMES_HARNESS_MODULES
  if (!existsSync(NPM_CACHE)) return null
  for (const entry of readdirSync(NPM_CACHE, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const modules = join(NPM_CACHE, entry.name, 'node_modules')
    if (existsSync(join(modules, '@deepseek-ai', 'dsh'))) return modules
  }
  return null
}

const HARNESS_MODULES = findHarnessModules()
const DSH_BIN = HARNESS_MODULES ? join(HARNESS_MODULES, '@deepseek-ai', 'dsh', 'lib', 'bin.js') : null
/** A CLI-bootable profile to compose the patch onto for the parser check. */
const REFERENCE_PROFILE = process.env.HYPERFRAMES_REFERENCE_PROFILE ?? 'web'

const require = createRequire(import.meta.url)
let yaml
try {
  yaml = require('js-yaml')
} catch {
  if (!HARNESS_MODULES) {
    console.error('FAIL  js-yaml not found and the dsh harness tree could not be located.')
    console.error('      Install js-yaml locally, or set HYPERFRAMES_HARNESS_MODULES to the')
    console.error('      directory holding @deepseek-ai/dsh.')
    process.exit(2)
  }
  yaml = await import(pathToFileURL(join(HARNESS_MODULES, 'js-yaml', 'index.js')).href).then(
    (m) => m.default ?? m,
  )
}

// The harness reads `!!js` as raw JavaScript expression source, evaluated later
// by the loader. Mirror that: keep the scalar text under a marker key.
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpression: data }),
  instanceOf: (data) => typeof data?.__jsExpression === 'string',
  represent: (value) => value?.__jsExpression,
})

const file = process.argv[2]
if (!file) {
  console.error('usage: node validate-patch.mjs <patch.yml>')
  process.exit(2)
}



// --- layer 1: the harness parser -------------------------------------------------
// `desktop` is owned by the Electron app and refuses CLI boot, so compose the
// patch onto a CLI-bootable profile instead. `--patch` applies it as an overlay,
// which exercises the same parse path a real boot takes.
const schema = yaml.DEFAULT_SCHEMA.extend([JS_TAG])

let rows = []
try {
  const doc = yaml.load(readFileSync(file, 'utf8'), { schema })
  if (!Array.isArray(doc)) {
    console.error(`FAIL: 顶层必须是数组，实际是 ${typeof doc}`)
    process.exit(1)
  }
  // Rows live either directly under a top-level id (an override) or inside an
  // `insert` list (an addition). The distinction decides whether the row can be
  // dropped by the loader, so keep track of it.
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue
    if (Array.isArray(entry.insert)) {
      for (const row of entry.insert) rows.push({ ...row, __bare: false })
    } else {
      rows.push({ ...entry, __bare: true })
    }
  }
} catch (e) {
  console.error(`FAIL  ${file}\n      ${e.message}`)
  process.exit(1)
}

if (DSH_BIN && existsSync(DSH_BIN)) {
  try {
    // stderr carries the diagnostics (dropped rows, YAML errors), so it must be
    // piped; stdout holds the composed tree and is discarded.
    execFileSync(
      process.execPath,
      [DSH_BIN, '--profile', REFERENCE_PROFILE, '--patch', file, '--dump-config'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 },
    )
    console.log('OK  harness parser accepted the patch (no dropped rows, no YAML errors)')
  } catch (e) {
    // execFileSync throws when dsh exits non-zero. Its stderr is the only place
    // the parse diagnostics appear, and it can come back null depending on how
    // the failure surfaced — never treat that as "fine".
    const out = [e.stderr, e.stdout, e.message].filter(Boolean).map(String).join('\n')
    if (/YAMLException|not found/.test(out)) {
      const detail = out.split('\n').filter((l) => /YAMLException|not found/.test(l))
      console.error(`FAIL  harness parser rejected the patch:\n      ${detail.join('\n      ')}`)
      if (/not found/.test(out)) {
        console.error('      Rows declared with a bare `- id:` are overrides: they vanish unless a')
        console.error('      bundle already contributed that id. Declare them under `- insert:` instead.')
      }
      process.exit(1)
    }
    if (out.trim()) {
      console.error(`FAIL  harness could not compose the patch:\n      ${out.split('\n').filter(Boolean).slice(0, 5).join('\n      ')}`)
      process.exit(1)
    }
    console.log('SKIP  harness parser check (dsh produced no diagnostics)')
  }
} else {
  console.log('SKIP  harness parser check (dsh bin not found)')
}

// What this check cannot cover: dsh only reports a dropped row for a bare
// `- id:` when some bundle already contributed that id. Composed onto a profile
// that lacks the bundle, the row is silently absent from the tree and dsh stays
// quiet. So a clean harness run does not prove a bare row survives on the real
// profile — but a bare row naming a bundle-provided id is a deliberate override
// of that bundle, which is legitimate. Flag only the ones that are neither:
// unknown to every bundle here, so nothing can be overriding.
{
  const known = new Set([
    'ui-settings-general', 'agent-default-model', 'ui-chat', 'ui-settings',
    'ui-settings-account',
  ])
  const suspicious = rows.filter((r) => r.__bare && r?.id && !known.has(r.id))
  if (suspicious.length) {
    console.error(`FAIL  ${suspicious.length} row(s) look like overrides of ids no bundle provides: ${suspicious.map((r) => r.id).join(', ')}`)
    console.error('      A bare `- id:` is dropped unless a bundle already contributed that id, and')
    console.error('      dsh stays silent when none does. Move these under `- insert:` — the form the')
    console.error('      shipped presets in dsh-web-app/presets/*.patch.yml use.')
    process.exit(1)
  }
}

// --- structure report + !!js syntax ---------------------------------------------
try {
  console.log(`OK  ${file}`)
  console.log(`    ${rows.length} 个条目（其中 ${rows.filter((r) => r.__bare).length} 个是裸 - id: 覆盖）`)
  console.log('    ids:', rows.map((r) => r?.id ?? '(no id)').join(', '))

  const preset = rows.find((r) => r?.id?.startsWith('preset-'))
  if (preset) {
    const plugins = preset.config?.plugins
    if (!Array.isArray(plugins)) {
      console.error(`FAIL: ${preset.id} 缺少 config.plugins 数组`)
      process.exit(1)
    }
    console.log(`    ${preset.id}: ${plugins.length} 个子插件`)
    const bad = plugins.filter((p) => !p?.id || !p?.name)
    if (bad.length) {
      console.error(`FAIL: ${preset.id} 有 ${bad.length} 个子插件缺 id 或 name`)
      process.exit(1)
    }
  }

  const jsExprs = readFileSync(file, 'utf8').match(/!!js\s+"[^"]*"/g) ?? []
  for (const raw of jsExprs) {
    const expr = raw.replace(/^!!js\s+/, '').slice(1, -1)
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (${expr})`)
    } catch (e) {
      console.error(`FAIL: !!js 表达式语法错误: ${expr}\n      ${e.message}`)
      process.exit(1)
    }
  }
  if (jsExprs.length) console.log(`    ${jsExprs.length} 个 !!js 表达式语法均正确`)
} catch (e) {
  console.error(`FAIL  ${file}\n      ${e.message}`)
  process.exit(1)
}
