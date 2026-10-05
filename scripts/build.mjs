/**
 * Build step: `src/*.js` is already plain ESM, so the build copies sources to
 * `lib/` alongside the generated type declarations. Keeping the transform to a
 * copy means the plugin runs on the same Node the harness already uses, with no
 * toolchain to install and nothing to drift.
 */
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

mkdirSync(join(lib, 'types'), { recursive: true })
cpSync(join(root, 'src'), lib, { recursive: true })
writeFileSync(
  join(lib, 'types', 'index.d.ts'),
  `export * from '../../src/types.ts'\n`,
  'utf8',
)
for (const entry of readdirSync(lib, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    process.stdout.write(`built lib/${entry.name}\n`)
  }
}
