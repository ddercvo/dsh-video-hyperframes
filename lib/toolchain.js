/**
 * Where the external toolchain lives, and how to reach it.
 *
 * HyperFrames shells out to `ffmpeg` by bare name. On Windows ffmpeg often comes
 * from a WinGet package directory that never made it onto PATH, so a bare spawn
 * fails with ENOENT. Every child process here goes through `withToolchainPath`,
 * which prepends the known install locations.
 *
 * Nothing here may hardcode a specific account: the plugin is published, so
 * every machine-specific location is derived from the environment instead.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

/** Directories that may hold winget-installed binaries, PATH not guaranteed. */
const EXTRA_TOOL_DIRS = [
  join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
  'C:\\Program Files',
  'C:\\Program Files (x86)',
]

/**
 * Locate an executable by name, scanning PATH plus the winget package tree.
 * @param name - bare executable name, e.g. `ffmpeg` or `node`.
 * @returns absolute path, or null when the tool is absent.
 */
export function findExecutable(name) {
  if (process.platform !== 'win32') return which(name)
  const direct = which(name)
  if (direct) return direct
  for (const root of EXTRA_TOOL_DIRS) {
    const found = scanDir(root, name, 3)
    if (found) return found
  }
  return null
}

/**
 * PATH lookup for the current platform.
 * @param name - bare executable name.
 * @returns absolute path, or null.
 */
function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Bounded-depth directory scan for an executable.
 * @param root - directory to search.
 * @param name - bare executable name.
 * @param depth - how many levels to descend.
 * @returns absolute path, or null.
 */
function scanDir(root, name, depth) {
  if (!existsSync(root) || depth < 0) return null
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = scanDir(full, name, depth - 1)
      if (nested) return nested
    } else if (exts.some((ext) => entry.name.toLowerCase() === name + ext)) {
      return full
    }
  }
  return null
}

/**
 * Build an environment whose PATH also covers the located toolchain, and point
 * HyperFrames at a browser if one can be found.
 *
 * The browser matters as much as ffmpeg: `check` and `render` drive headless
 * Chrome, and HyperFrames resolves it from HYPERFRAMES_BROWSER_PATH, then the
 * `~/.cache/hyperframes/chrome/chrome-headless-shell` tree, then system Chrome.
 * Setting the env var ourselves means the harness does not depend on the user
 * having exported it in their own shell.
 * @returns child env with the augmented PATH and, when found, the browser path.
 */
export function toolchainEnv() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const ffmpegDir = findExecutable('ffmpeg')
  if (ffmpegDir) {
    const binDir = dirname(ffmpegDir)
    if (!dirs.includes(binDir)) dirs.unshift(binDir)
  }
  const env = { ...process.env, PATH: dirs.join(delimiter) }
  if (!env.HYPERFRAMES_BROWSER_PATH) {
    const browser = findHeadlessShell()
    if (browser) env.HYPERFRAMES_BROWSER_PATH = browser
  }
  return env
}

/**
 * Locate a chrome-headless-shell or Chrome binary HyperFrames can drive.
 *
 * Only the headless shell is accepted here. Substituting a regular Chromium
 * build looks like it works — the path is accepted and even the browser probe
 * passes — but rendering then stalls on a Puppeteer profile lock, because those
 * builds do not answer the `--version` probe HyperFrames uses to verify them.
 * @returns absolute path, or null.
 */
export function findHeadlessShell() {
  if (process.platform !== 'win32') return null
  const shells = join(
    process.env.HYPERFRAMES_HOME ?? join(homedir(), '.cache', 'hyperframes'),
    'chrome',
    'chrome-headless-shell',
  )
  if (!existsSync(shells)) return null
  let entries
  try {
    entries = readdirSync(shells, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // The zip unpacks to win64-<version>/chrome-headless-shell-win64/chrome-headless-shell.exe,
    // so the executable sits two levels below the version directory.
    const nested = join(shells, entry.name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    if (existsSync(nested)) return nested
    const flat = join(shells, entry.name, 'chrome-headless-shell.exe')
    if (existsSync(flat)) return flat
  }
  return null
}

/**
 * Spawn a command, capturing stdout and stderr.
 * @param cmd - executable to run.
 * @param args - argument vector.
 * @param opts - cwd for the child, plus an optional abort signal.
 * @returns the exit code and captured streams.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: toolchainEnv(),
      signal: opts.signal,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
