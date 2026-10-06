/**
 * Register this plugin in a dsh profile.
 *
 * Installing by hand means editing two files that fail in ways that are hard to
 * diagnose:
 *
 *   * `package.json` -- the dependency must use the `link:` protocol (a bare
 *     path is read as a registry name), and the name must also appear in
 *     `dsh.profile.bundles`, or the plugin is never loaded even though it
 *     resolves.
 *   * `cordis.patch.yml` -- the rows must go under `- insert:`, not a bare
 *     `- id:`. A bare id is an *override*: dsh drops it with
 *     `patch: entry "<id>" not found` and reports nothing else. Silent failure.
 *
 * The logic below is exported as plain functions so it can be unit-tested
 * without spawning a process; `scripts/install.mjs` is the CLI wrapper.
 *
 * Every file it writes is copied to `<file>.bak-<timestamp>` first. Running it
 * twice is safe: an already-configured profile is detected and reported.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-tool-hyperframes'
/** Row ids the installer owns, for detection and uninstall. */
export const OWNED_IDS = ['tool-hyperframes', 'preset-video']

const MARK_BEGIN = '# >>> dsh-tool-hyperframes'
const MARK_END = '# <<< dsh-tool-hyperframes'

/**
 * Where the repo itself lives -- derived from this file, so a clone anywhere
 * works. `scripts/lib/` -> repo root is two levels up.
 */
export function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function templatePath() {
  return join(packageRoot(), 'templates', 'cordis.patch.yml')
}

export function defaultDshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function profilePaths(dshHome, profile) {
  const dir = join(dshHome, 'profiles', profile)
  return { dir, packageJson: join(dir, 'package.json'), patch: join(dir, 'cordis.patch.yml') }
}

/** True when any of the installer's rows is present in the patch text. */
export function hasOwnRows(text) {
  return OWNED_IDS.some((id) => new RegExp(`^\\s*- id: ${id}\\s*$`, 'm').test(text))
}

/**
 * Remove the managed block, markers included.
 *
 * The markers are the primary key: the template writes them, so the block is
 * exactly delimited no matter how much the surrounding file has been edited.
 * Without them we fall back to indentation -- an `- insert:` block runs until
 * the next column-0 row -- which also covers a block someone pasted by hand.
 * Returns null when neither applies, so the caller can stop rather than guess.
 */
export function removeOwnBlock(text) {
  const lines = text.split('\n')

  const begins = lines.findIndex((l) => l.trim().startsWith(MARK_BEGIN))
  const ends = lines.findIndex((l) => l.trim().startsWith(MARK_END))

  let from = -1
  let to = -1
  if (begins !== -1 && ends > begins) {
    from = begins
    to = ends
  } else {
    const start = lines.findIndex((l) => l.startsWith('- insert:'))
    if (start !== -1) {
      let stop = lines.length
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^-\s/.test(lines[i])) { stop = i; break }
      }
      if (hasOwnRows(lines.slice(start, stop).join('\n'))) {
        from = start
        to = stop - 1
      }
    }
  }
  if (from === -1) return null

  // Absorb the blank lines that separated the block from what preceded it.
  let head = from
  while (head > 0 && lines[head - 1].trim() === '') head -= 1

  const kept = [...lines.slice(0, head), ...lines.slice(to + 1)].join('\n').replace(/\n{3,}/g, '\n\n')
  // A file that is now only whitespace should end up empty, not a lone newline.
  return kept.trim() === '' ? '' : `${kept.trimEnd()}\n`
}

/**
 * Work out what the profile files should become, without touching disk.
 *
 * Pure: takes current file contents and returns the next ones. Returns
 * `{ changed: false }` when the profile is already in the desired state.
 *
 * @param state - `{ pkgText, patchText, template, linkPath, uninstall }`
 * @returns next file contents plus a per-item description for the report
 */
export function planProfileChange(state) {
  const { pkgText, patchText, template, linkPath, uninstall, force } = state

  let pkg
  try {
    pkg = JSON.parse(pkgText)
  } catch (e) {
    return { error: `could not parse package.json: ${e.message}` }
  }

  pkg.dependencies ??= {}
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  pkg.dsh.profile.bundles ??= []

  const hadDep = Boolean(pkg.dependencies[PLUGIN_NAME])
  const hadBundle = pkg.dsh.profile.bundles.includes(PLUGIN_NAME)
  const patchHasRows = hasOwnRows(patchText)

  if (uninstall) {
    delete pkg.dependencies[PLUGIN_NAME]
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PLUGIN_NAME)
  } else {
    pkg.dependencies[PLUGIN_NAME] = linkPath
    if (!hadBundle) pkg.dsh.profile.bundles.push(PLUGIN_NAME)
  }

  let nextPatch = patchText
  let error

  if (uninstall) {
    if (patchHasRows) {
      const removed = removeOwnBlock(patchText)
      if (removed === null) {
        error = 'found the plugin rows but could not identify the block owning them; '
          + 'remove them by hand — refusing to guess at the boundaries'
      } else {
        nextPatch = removed
      }
    }
  } else if (patchHasRows && !force) {
    // Leave an existing block alone unless asked. A re-run must not quietly
    // rewrite rows the user may have edited -- or, worse, report "already
    // configured" while an older template stays in place.
    nextPatch = patchText
  } else {
    // A fresh install, or --force replacing whatever is there with the current
    // template. This is how a profile set up from an older template gets the
    // new one without a round trip through --uninstall.
    const base = patchHasRows ? removeOwnBlock(patchText) : patchText
    if (base === null) {
      error = 'found the plugin rows but could not identify the block to replace; '
        + 'run without --force first, or remove the leftovers by hand'
    } else {
      const separator = base.trim() === '' ? '' : '\n\n'
      nextPatch = `${base.trimEnd()}${separator}${template.trimEnd()}\n`
    }
  }

  const changed = error
    ? false
    : uninstall
      ? (hadDep || hadBundle || patchHasRows)
      : force
        ? true
        : (!hadDep || !hadBundle || !patchHasRows)

  return {
    error,
    changed,
    nextPackageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    nextPatch,
    hadDep,
    hadBundle,
    patchHasRows,
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** Copy `file` aside, returning the backup path (or null when absent). */
export function backupFile(file, dryRun = false) {
  if (!existsSync(file)) return null
  const target = `${file}.bak-${timestamp()}`
  if (!dryRun) copyFileSync(file, target)
  return target
}

/**
 * Run install or uninstall against a real profile.
 *
 * @param options - `{ profile, uninstall, dryRun, dshHome, log }`
 * @returns `{ ok, code, ... }` — `ok: false` carries a `message` for the caller to print
 */
export function run({ profile = 'desktop', uninstall = false, dryRun = false, force = false, dshHome, log = () => {} } = {}) {
  const home = dshHome ?? defaultDshHome()
  const root = packageRoot()
  const paths = profilePaths(home, profile)

  if (!existsSync(root) || !existsSync(join(root, 'package.json'))) {
    return { ok: false, message: `plugin root looks wrong: ${root}` }
  }

  if (!existsSync(paths.dir)) {
    const profilesDir = join(home, 'profiles')
    const available = existsSync(profilesDir)
      ? readdirSync(profilesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : []
    return {
      ok: false,
      message: `no such dsh profile: ${paths.dir}`,
      hint: available.length
        ? `Available: ${available.join(', ')} — pass one with --profile <name>.`
        : `Is dsh installed? Expected profiles under ${profilesDir}.`,
    }
  }

  if (!existsSync(paths.packageJson)) {
    return { ok: false, message: `profile has no package.json: ${paths.packageJson}` }
  }

  let template = ''
  if (!uninstall) {
    const tpl = templatePath()
    if (!existsSync(tpl)) {
      return { ok: false, message: `missing patch template: ${tpl}`, hint: 'templates/ ships with the repository.' }
    }
    template = readFileSync(tpl, 'utf8')
  }

  // `link:` is a pnpm protocol; a bare path would be read as a registry name.
  // Forward slashes keep the value valid JSON on Windows.
  const linkPath = `link:${root.replace(/\\/g, '/')}`

  const patchText = existsSync(paths.patch) ? readFileSync(paths.patch, 'utf8') : ''
  const plan = planProfileChange({
    pkgText: readFileSync(paths.packageJson, 'utf8'),
    patchText,
    template,
    linkPath,
    uninstall,
    force,
  })

  if (plan.error) return { ok: false, message: plan.error }

  const mode = uninstall ? 'uninstall' : (force && plan.patchHasRows) ? 'update' : 'install'
  log(`\ndsh-video-hyperframes — ${mode}${dryRun ? ' (dry run, nothing will be written)' : ''}`)
  log(`  profile              ${paths.dir}`)
  log(`  plugin root          ${root}\n`)

  if (!plan.changed) {
    log(uninstall
      ? '  nothing to remove — the plugin is not registered in this profile.\n'
      : '  already configured — dependency, bundle and patch rows are all present.\n')
    if (!uninstall) {
      log('If you meant to refresh an older template in this profile, use --force.\n')
    }
    return { ok: true, changed: false, mode }
  }

  const label = (present, absent, action) => (present ? absent : action)
  log(`  dependency           ${uninstall ? 'remove' : label(plan.hadDep, 'already present', `add ${PLUGIN_NAME}`)}`)
  log(`  bundle               ${uninstall ? 'remove' : label(plan.hadBundle, 'already listed', `append ${PLUGIN_NAME}`)}`)
  if (uninstall) {
    log(`  patch rows           remove`)
  } else if (force && plan.patchHasRows) {
    log(`  patch rows           replace with the current template`)
  } else {
    log(`  patch rows           ${label(plan.patchHasRows, 'already present', `append ${OWNED_IDS.length} rows under - insert:`)}`)
  }
  log('')

  const backups = []
  for (const [file, content] of [[paths.packageJson, plan.nextPackageJson], [paths.patch, plan.nextPatch]]) {
    const b = backupFile(file, dryRun)
    if (b) backups.push(b)
    if (!dryRun) writeFileSync(file, content, 'utf8')
  }

  log(dryRun ? '  [dry-run] no files were written' : `  wrote                package.json, cordis.patch.yml`)
  if (!dryRun) {
    log(backups.length
      ? `  backups              ${backups.map((b) => b.split(/[\\/]/).pop()).join(', ')}`
      : '  backups              (none — the files did not exist)')
  }

  return { ok: true, changed: true, mode, backups, paths }
}
