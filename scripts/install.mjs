#!/usr/bin/env node
/**
 * Register this plugin in a dsh profile.
 *
 * Usage:
 *   node scripts/install.mjs                  # default profile (desktop)
 *   node scripts/install.mjs --profile web    # a different profile
 *   node scripts/install.mjs --dry-run        # print the plan, change nothing
 *   node scripts/install.mjs --force          # rewrite the patch block
 *   node scripts/install.mjs --uninstall      # remove it again
 *
 * All logic lives in scripts/lib/profile-install.mjs so it can be unit-tested
 * without spawning a process (spawning is unreliable in some sandboxes).
 */
import { run } from './lib/profile-install.mjs'

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  const next = argv[i + 1]
  return i !== -1 && next && !next.startsWith('--') ? next : fallback
}

if (hasFlag('help') || hasFlag('h')) {
  console.log(`Register dsh-tool-hyperframes in a dsh profile.

Usage:
  node scripts/install.mjs [--profile <name>] [--dry-run] [--force] [--uninstall]

Options:
  --profile <name>   dsh profile to modify (default: desktop)
  --dry-run          print the plan without writing anything
  --force            rewrite the plugin's patch block from the current template,
                     even if one is already there. Use this to pick up a newer
                     template; a plain re-run leaves an existing block untouched.
  --uninstall        remove the plugin's rows and dependency again
  --help             show this message

Both edited files are copied to <file>.bak-<timestamp> before being written.`)
  process.exit(0)
}

const uninstall = hasFlag('uninstall')
const dryRun = hasFlag('dry-run')
const force = hasFlag('force')
const profile = flagValue('profile', 'desktop')

const result = run({ profile, uninstall, dryRun, force, log: console.log })

if (!result.ok) {
  console.error(`\n✗ ${result.message}`)
  if (result.hint) console.error(`  ${result.hint}`)
  process.exit(1)
}

if (!result.changed) {
  if (!uninstall) {
    console.log('Reminder: the plugin is not hot-reloaded. Restart dsh, then open a')
    console.log('NEW session so the preset appears (presets are session-scoped).\n')
  }
  process.exit(0)
}

if (uninstall) {
  console.log('\nThen restart dsh. If you also want the package unlinked:')
  console.log(`  cd ${result.paths.dir} && pnpm install\n`)
} else {
  console.log('\nNext:')
  console.log(`  1. cd ${result.paths.dir} && pnpm install`)
  console.log('  2. restart dsh')
  console.log('  3. open a NEW session — presets are session-scoped and will not')
  console.log('     appear in sessions that already started')
  console.log('\nTo undo: node scripts/install.mjs --uninstall\n')
}
