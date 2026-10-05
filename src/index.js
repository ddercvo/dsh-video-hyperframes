/**
 * Model-facing tools for driving HyperFrames HTML-to-video rendering.
 *
 * A composition is an ordinary HTML document. The rules that matter, per the
 * official docs and the linter (`hyperframes check`):
 *   - the root element carries `data-composition-id` (always "main", never the
 *     project name), `data-width`, `data-height`
 *   - the root is itself a timed clip: `data-start="0"` plus `data-duration`
 *     giving the project length
 *   - every timed element needs `class="clip"` plus
 *     `data-start` / `data-duration` / `data-track-index`, and an `id` so Studio
 *     has a stable edit target
 *   - a GSAP timeline is created `{ paused: true }` and registered on
 *     `window.__timelines[compositionId]` — pausing alone is not enough,
 *     the renderer looks the timeline up by composition id
 *   - scenes under compositions/ are sub-compositions: their content is wrapped
 *     in a `<template>`, and index.html mounts them through `data-composition-src`.
 *     The default check/render/preview/publish commands only open index.html, so
 *     an unmounted scene renders as a blank background — and a blank entry
 *     aborts the render outright.
 *   - a composition host element needs BOTH `data-composition-src` and
 *     `data-composition-id` (plus its own `id` for Studio). Omitting the
 *     composition id is a lint *error*, not a warning. The host's id must also
 *     differ from the id its scene registers a timeline under — sharing "main"
 *     makes hyperframes remap the host to "main__hf1" and wait 45 s for a
 *     registration that never arrives (measured: 1m45s vs 15s for the same
 *     2-second output).
 *   - the GSAP timeline lives in index.html, never inside a scene. A timeline
 *     registered in a <template>-wrapped sub-composition is never seeked: the
 *     render reports success with a plausible MP4 and every frame identical.
 *     This is the one failure no static check catches — verifying it needs
 *     hashing extracted frames.
 *
 * Rendering is deterministic: the engine asks the page for frame
 * `floor(time * fps)` via Chrome's beginFrame API rather than recording live
 * playback, so animation must be seekable and never clock-driven.
 *
 * @module dsh-tool-hyperframes
 */
import { mkdirSync, readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { findExecutable, findHeadlessShell, run, toolchainEnv } from './toolchain.js'

const require = createRequire(import.meta.url)

/** Loader identity. */
const name = 'dsh-tool-hyperframes'
/** Waits for the tool registry. */
const inject = ['tools']

/** Where projects live unless a call overrides it. */
const DEFAULT_ROOT = join(process.cwd(), 'videos')

/** HyperFrames' own preview server default, per its docs. */
const DEFAULT_PREVIEW_PORT = 3002

/**
 * Schemastery configuration. Schemastery has no `optional()`: a field is
 * optional exactly when `.required()` is absent, and a declared `default()`
 * makes the loader fill it when the row omits it.
 */
const Config = z.object({
  projectRoot: z.string().default(DEFAULT_ROOT),
  ffmpegPath: z.string(),
  previewPort: z.number().default(DEFAULT_PREVIEW_PORT),
  /** Directory holding the `hyperframes` CLI; resolved by discovery when absent. */
  cliRoot: z.string(),
})

/** Scene file naming: scene-01.html, scene-02.html, ... */
const SCENE_RE = /^scene-(\d+)\.html$/

/** Timed elements must carry this class for the renderer to pick them up. */
const CLIP_RE = /class\s*=\s*"[^"]*\bclip\b[^"]*"/g

/** GSAP build pinned so a project's timing does not shift between runs. */
const GSAP_CDN = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js'

/**
 * A minimal but *valid* first scene.
 *
 * It has to satisfy the whole contract, because hyperframes lints and renders the
 * project the moment it is created: a blank index.html aborts a render outright,
 * and a scene missing the `clip` class or its `id` fails the lint gate.
 *
 * Note there is deliberately no <script> here. A GSAP timeline registered inside
 * a <template>-wrapped sub-composition never gets seeked: the render completes,
 * exit code is 0, and every frame comes out identical. Timelines live in
 * index.html, which owns the animation for the whole project.
 * @returns an HTML document.
 */
function starterScene() {
  return `<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <!-- A sub-composition's content must sit inside a <template>; hyperframes
         unwraps it when mounting. Keep animation out of here — see above. -->
    <template id="scene-01">
      <div
        data-composition-id="main"
        style="position:relative;width:100%;height:100%;background:#0a0a0a;overflow:hidden;"
      >
        <div
          id="title-01"
          class="clip"
          data-start="0"
          data-duration="2"
          data-track-index="0"
          style="position:absolute;left:8%;top:42%;font:700 48px sans-serif;color:#ffffff;"
        >Title</div>
      </div>
    </template>
  </body>
</html>
`
}

/**
 * Write index.html so the entry document actually mounts the project's scenes.
 *
 * The default `check` / `render` / `preview` / `publish` commands all open
 * index.html and nothing else, so scenes sitting unused in compositions/ would
 * render as a blank background. The root element is itself a timed clip whose
 * data-duration is the project length, and each scene is mounted through a host
 * element carrying data-composition-src.
 * @param dir - the project directory.
 * @param meta - the project metadata carrying canvas geometry and duration.
 * @param scenes - scene filenames to mount, in timeline order.
 */
function writeIndex(dir, meta, scenes) {
  // A composition host needs BOTH data-composition-src and data-composition-id
  // (hyperframes lint: host_missing_composition_id), plus an id of its own for
  // Studio (studio_missing_editable_id).
  //
  // The host's composition id must differ from the id the scene registers its
  // timeline under. When both say "main", hyperframes treats the host as a
  // nested composition of the same id, remaps it to something like "main__hf1",
  // and then waits 45 seconds for a window.__timelines["main__hf1"] that the
  // scene never registers. Measured: 1m45s render with the id shared, 15s once
  // the host got its own id — same output, six times the speed.
  const hosts = scenes
    .map((scene) => {
      const key = scene.replace(/\.html$/, '')
      return `    <div id="${key}-host" class="scene-host" data-composition-id="${key}" data-composition-src="compositions/${scene}"></div>`
    })
    .join('\n')
  const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${meta.width}, height=${meta.height}" />
    <script src="${GSAP_CDN}"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${meta.width}px; height: ${meta.height}px; overflow: hidden; background: #0a0a0a; }
      #root { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <!-- Root composition. It is itself a timed clip: data-start plus
         data-duration set the project's total length. Each scene below is
         mounted from compositions/ via data-composition-src. -->
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${meta.duration}"
      data-width="${meta.width}"
      data-height="${meta.height}"
    >
${hosts}
    </div>
    <script>
      // The project timeline lives HERE, not in a scene. A timeline registered
      // inside a <template>-wrapped sub-composition is never seeked, and the
      // render still reports success while every frame comes out identical.
      const tl = gsap.timeline({ paused: true });
      // Animate whatever the mounted scenes expose. Extend this per project.
      if (document.querySelector('#title-01')) {
        tl.from('#title-01', { opacity: 0, y: -40, duration: 0.5 }, 0);
      }
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
`
  writeFileSync(join(dir, 'index.html'), index, 'utf8')
}

/**
 * Locate the hyperframes CLI. Prefers the deployment's `cliRoot`, then a
 * sibling install, then a global npm prefix — a bare `hyperframes` on PATH is
 * the last resort because the harness may run without the user's PATH.
 * @param config - deployment configuration.
 * @returns absolute path to the CLI entry, or null.
 */
function resolveCli(config) {
  const candidates = []
  if (config.cliRoot) {
    candidates.push(join(config.cliRoot, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'))
  }
  candidates.push(
    join(import.meta.dirname, '..', '..', '..', 'tools', 'hyperframes', 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'),
  )
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir) continue
    candidates.push(join(dir, 'node_modules', 'hyperframes', 'bin', 'hyperframes.mjs'))
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * List the scenes of a project, ordered by their numeric suffix.
 * @param dir - the project directory.
 * @returns sorted scene filenames.
 */
function listScenes(dir) {
  const compDir = join(dir, 'compositions')
  if (!existsSync(compDir)) return []
  return readdirSync(compDir)
    .filter((f) => SCENE_RE.test(f))
    .sort((a, b) => Number(SCENE_RE.exec(a)[1]) - Number(SCENE_RE.exec(b)[1]))
}

/**
 * Inspect a scene against the composition contract: the root attributes, the
 * `clip` class on timed elements, and whether a timeline is registered.
 *
 * These four checks catch the failure modes that silently produce a static or
 * empty render — invisible in a preview, fatal in the final MP4.
 * @param dir - the project directory.
 * @param scene - scene filename.
 * @returns the file text plus a structured report.
 */
function inspectScene(dir, scene) {
  const text = readFileSync(join(dir, 'compositions', scene), 'utf8')
  const starts = [...text.matchAll(/data-start\s*=\s*"([^"]*)"/g)].map((m) => m[1])
  const durations = [...text.matchAll(/data-duration\s*=\s*"([^"]*)"/g)].map((m) => m[1])
  const clips = text.match(CLIP_RE) ?? []
  const problems = []

  if (!/data-composition-id\s*=/.test(text)) {
    problems.push('root element is missing data-composition-id')
  }
  if (starts.length === 0) {
    problems.push('no data-start found: this scene renders as a static image')
  } else if (starts.length !== durations.length) {
    problems.push(`data-start count (${starts.length}) != data-duration count (${durations.length}); elements without data-duration never exit`)
  }
  if (clips.length < starts.length) {
    problems.push(`only ${clips.length} element(s) carry class="clip" but ${starts.length} are timed; untimed elements are ignored`)
  }
  if (/gsap/i.test(text) && !/window\.__timelines/.test(text)) {
    problems.push('GSAP is present but no window.__timelines registration; the renderer cannot seek the animation')
  }
  if (/setTimeout|setInterval|requestAnimationFrame/.test(text)) {
    problems.push('clock-driven animation (setTimeout/setInterval/requestAnimationFrame) cannot be seeked; drive it from the registered timeline instead')
  }
  // A scene file is a sub-composition: hyperframes only unwraps its content when
  // that content sits inside a <template>. Without the wrapper the mount finds
  // nothing and the scene contributes nothing to the render.
  if (!/<template[\s>]/.test(text)) {
    problems.push('scene content is not wrapped in a <template>; hyperframes mounts a sub-composition by unwrapping it, so an unwrapped scene renders empty')
  }
  // The one failure static checks cannot catch: a timeline registered inside a
  // <template>-wrapped sub-composition is never seeked. The render reports
  // success, exit code 0, a plausible MP4 — and every frame is identical. Only
  // comparing extracted frame hashes reveals it, so warn at write time.
  if (/<template[\s>][\s\S]*<\/template>/i.test(text) && /gsap|window\.__timelines/i.test(text)) {
    problems.push('GSAP/timeline code inside the <template> will not be seeked: the render will succeed but produce a static image. Put the timeline in index.html, which owns the project-wide animation.')
  }
  // Timed elements need an id for Studio's timeline and canvas controls.
  const ids = new Set([...text.matchAll(/\sid\s*=\s*"([^"]*)"/g)].map((m) => m[1]))
  const untagged = [...text.matchAll(/<[a-zA-Z][^>]*\bclass\s*=\s*"[^"]*\bclip\b[^"]*"[^>]*>/g)]
    .filter((tag) => !/\sid\s*=\s*"/.test(tag[0]))
  if (untagged.length > 0) {
    problems.push(`${untagged.length} clip element(s) have no id; Studio cannot build a stable edit target for them (known ids: ${[...ids].slice(0, 5).join(', ') || 'none'})`)
  }

  return {
    text,
    dataStartCount: starts.length,
    dataDurationCount: durations.length,
    clipCount: clips.length,
    problems,
  }
}

/**
 * Check index.html's composition hosts against the scenes they mount.
 *
 * A host's `data-composition-id` must differ from the id its scene registers a
 * timeline under. When both say `main`, hyperframes treats the host as a nested
 * composition of the same id, remaps it (to something like `main__hf1`), and
 * waits 45 s for a `window.__timelines["main__hf1"]` that never arrives.
 * Measured on the same 2-second clip: 1m45s sharing the id, 15s once the host
 * had its own.
 *
 * This is the one rule nothing else covers. The official linter's check reads
 * the attribute and moves on if it is present -- it never looks at the value --
 * and every check above this function inspects a single scene file, so none of
 * them can see index.html. The render still succeeds; it just takes six times
 * as long, which is easy to blame on a slow machine.
 *
 * @param dir - the project directory.
 * @param scenes - scene filenames to consider, as `listScenes` returns them.
 * @returns problems keyed by the scene a bad host mounts; scenes absent from the
 *   map are fine.
 */
function inspectMounts(dir, scenes) {
  const problems = new Map()
  const indexPath = join(dir, 'index.html')
  if (!existsSync(indexPath)) return problems

  const hosts = readFileSync(indexPath, 'utf8')
    .match(/<[a-zA-Z][^>]*\bdata-composition-src\s*=\s*"[^"]*"[^>]*>/g) ?? []

  for (const host of hosts) {
    const src = /\bdata-composition-src\s*=\s*"([^"]*)"/.exec(host)?.[1]
    if (!src) continue
    const scene = src.split(/[\\/]/).pop()
    if (!scenes.includes(scene)) continue

    const hostId = /\bdata-composition-id\s*=\s*"([^"]*)"/.exec(host)?.[1]
    // A host with no composition id at all is the linter's business
    // (host_missing_composition_id); this check is only about the collision.
    if (hostId === undefined) continue

    const sceneText = readFileSync(join(dir, 'compositions', scene), 'utf8')
    // The first declaration in a scene file is its root element's.
    const sceneId = /data-composition-id\s*=\s*"([^"]*)"/.exec(sceneText)?.[1]
    if (sceneId !== hostId) continue

    problems.set(scene, [
      `mount host for ${scene} uses data-composition-id="${hostId}", which is the same id the scene registers its timeline under. hyperframes treats the host as a nested composition of that id, remaps it, and then waits 45s for a timeline registration that never arrives (a 2s clip goes from 15s to 1m45s). Give the host a distinct id, e.g. data-composition-id="${scene.replace(/\.html$/, '')}".`,
    ])
  }

  return problems
}

/**
 * Platform-specific install commands for the parts of the toolchain that are
 * missing.
 *
 * These were hardcoded to Windows -- `winget`, and a win64 download URL -- so a
 * Linux or macOS user running video_env_check was handed instructions that
 * could not work. Chrome for Testing also names its platforms differently from
 * `process.platform`, and splits macOS by architecture.
 *
 * Deliberately no version numbers: a pinned one goes stale and then the command
 * fails in a way that reads as "the download is broken" rather than "the URL is
 * old". The caller points at the version index instead.
 *
 * @param platform - a `process.platform` value.
 * @param arch - a `process.arch` value.
 * @returns the commands that apply; null where there is nothing useful to say.
 */
function installHints(platform, arch) {
  const ffmpeg = {
    win32: 'winget install Gyan.FFmpeg',
    darwin: 'brew install ffmpeg',
    linux: "sudo apt install ffmpeg    # or this distro's equivalent",
  }[platform] ?? null

  const chromePlatform = platform === 'win32'
    ? 'win64'
    : platform === 'darwin'
      ? (arch === 'arm64' ? 'mac-arm64' : 'mac-x64')
      : platform === 'linux'
        ? 'linux64'
        : null

  return { ffmpeg, chromePlatform }
}

/**
 * Register the video production tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment paths and ports.
 */
function apply(ctx, config) {
  const root = resolve(config.projectRoot)
  mkdirSync(root, { recursive: true })

  /** Absolute path of a project, guarded against escaping the root. */
  const projectDir = (nameArg) => {
    const full = isAbsolute(nameArg) ? resolve(nameArg) : resolve(root, nameArg)
    if (full !== root && !full.startsWith(root + '\\') && !full.startsWith(root + '/')) {
      throw new Error(`project path escapes ${root}: ${nameArg}`)
    }
    return full
  }

  /** Absolute path of a scene file inside a project. */
  const scenePath = (project, scene) => {
    if (!SCENE_RE.test(scene)) {
      throw new Error(`scene must match scene-NN.html, got ${scene}`)
    }
    return join(project, 'compositions', scene)
  }

  ctx.tools.register(defineTool({
    name: 'video_env_check',
    description: 'Report whether the HyperFrames toolchain is ready: the CLI, ffmpeg, the headless Chrome shell, Node, and the project root. Run this first whenever rendering fails — ffmpeg alone is not enough, check and render also need the headless shell.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          node: { type: 'string', required: true },
          cli: { type: 'string', required: true },
          ffmpeg: { type: 'string', required: true },
          browser: { type: 'string', required: true },
          projectRoot: { type: 'string', required: true },
          previewPort: { type: 'integer', required: true },
          ready: { type: 'boolean', required: true },
          canRender: { type: 'boolean', required: true },
          hints: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ready
          ? `Toolchain OK. CLI: ${value.cli}\n  Can render: ${value.canRender ? 'yes' : 'no — headless Chrome shell missing'}${value.canRender ? '' : `\n  browser: ${value.browser}`}`
          : `Toolchain incomplete.\n  CLI: ${value.cli}\n  ffmpeg: ${value.ffmpeg}\n  browser: ${value.browser}\n${value.hints.map((h) => '  - ' + h).join('\n')}`,
      }],
    },
    execute() {
      const cli = resolveCli(config)
      const ffmpeg = config.ffmpegPath ?? findExecutable('ffmpeg') ?? null
      const browser = process.env.HYPERFRAMES_BROWSER_PATH ?? findHeadlessShell()
      const { ffmpeg: ffmpegCmd, chromePlatform } = installHints(process.platform, process.arch)
      const hints = []
      if (!cli) hints.push('install it: cd ~/.dsh/tools/hyperframes && npm install --ignore-scripts')
      if (!ffmpeg) {
        hints.push(ffmpegCmd
          ? `install it: ${ffmpegCmd}`
          : "install ffmpeg with this platform's package manager: https://ffmpeg.org/download.html")
      }
      if (!browser) {
        hints.push('hyperframes check and render need the Chrome headless shell (~130MB). Do NOT point HYPERFRAMES_BROWSER_PATH at a regular Chromium/Chrome: those builds ignore the --version probe HyperFrames uses, and rendering stalls on a Puppeteer profile lock.')
        hints.push('Easiest, and cross-platform: `hyperframes browser ensure`. It cannot resume a partial download and runs at roughly half speed.')
        if (chromePlatform) {
          hints.push(`Faster for ${chromePlatform}: fetch it with curl, which resumes. Get the current stable version from https://googlechromelabs.github.io/chrome-for-testing/ (the "chrome-headless-shell" entry for ${chromePlatform}):`)
          hints.push('  mkdir -p ~/.cache/hyperframes/chrome && cd ~/.cache/hyperframes/chrome')
          hints.push('  curl -L -C - --retry 10 --retry-all-errors -o shell.zip \\')
          hints.push(`    "https://storage.googleapis.com/chrome-for-testing-public/<version>/${chromePlatform}/chrome-headless-shell-${chromePlatform}.zip"`)
          hints.push(`  then unzip it anywhere under ~/.cache/hyperframes/chrome/chrome-headless-shell/ — that directory is searched, so the name does not matter.`)
        }
      }
      return {
        node: process.version,
        cli: cli ?? 'not found',
        ffmpeg: ffmpeg ?? 'not found',
        browser: browser ?? 'not found',
        projectRoot: root,
        previewPort: config.previewPort,
        ready: Boolean(cli && ffmpeg),
        canRender: Boolean(cli && ffmpeg && browser),
        hints,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_new_project',
    description: 'Create a HyperFrames project. Run this first, once per video, then write scenes with video_write_scene. The generated skeleton matches what `hyperframes init` produces, so the CLI can be used on it interchangeably.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Project directory name, e.g. "intro-2026". Created under the project root.',
      },
      duration: {
        type: 'number',
        required: true,
        description: 'Total video length in seconds. The root composition gets this as data-duration.',
      },
      width: {
        type: 'number',
        required: true,
        description: 'Canvas width: 1920 landscape, 1080 portrait or square, 3840 for 4K.',
      },
      height: {
        type: 'number',
        required: true,
        description: 'Canvas height: 1080 landscape, 1920 portrait, 2160 for 4K.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          path: { type: 'string', required: true },
          scenesDir: { type: 'string', required: true },
          compositionId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created project "${value.project}" at ${value.path} (composition id "${value.compositionId}"). Next: video_write_scene.`,
      }],
    },
    execute(args) {
      const dir = projectDir(args.name)
      mkdirSync(join(dir, 'compositions'), { recursive: true })
      mkdirSync(join(dir, 'assets', 'audio'), { recursive: true })
      mkdirSync(join(dir, 'assets', 'img'), { recursive: true })
      // Matches what `hyperframes init` emits, so a project created here and one
      // created by the CLI are interchangeable.
      const config = {
        $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
        registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
        paths: {
          blocks: 'compositions',
          components: 'compositions/components',
          assets: 'assets',
        },
        media: { autoProxy: true },
      }
      // Canvas geometry lives in meta.json because video_write_scene has to
      // regenerate index.html on every write, and it needs these numbers.
      const meta = {
        id: args.name,
        name: args.name,
        createdAt: new Date().toISOString(),
        width: args.width,
        height: args.height,
        duration: args.duration,
      }
      writeFileSync(join(dir, 'hyperframes.json'), JSON.stringify(config, null, 2), 'utf8')
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')
      // Seed a first scene so index.html is never blank: hyperframes aborts a
      // render outright with "the default index.html entry is blank", and a
      // blank root plus a standalone scene file is a lint error.
      writeFileSync(
        join(dir, 'compositions', 'scene-01.html'),
        starterScene(),
        'utf8',
      )
      writeIndex(dir, meta, ['scene-01.html'])
      return {
        project: args.name,
        path: dir,
        scenesDir: join(dir, 'compositions'),
        compositionId: 'main',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_write_scene',
    description: 'Write one scene as a HyperFrames sub-composition, then re-mount index.html so the scene is actually reachable. The scene content must be wrapped in a <template>. Its root element needs data-composition-id ("main"), data-width, data-height. Every timed element needs class="clip" with data-start (seconds from project start), data-duration, data-track-index, and an id. A GSAP timeline must be created { paused: true } and registered as window.__timelines["main"] = tl. Reports every contract violation found.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name from video_new_project.' },
      scene: { type: 'string', required: true, description: 'Filename, must match scene-NN.html.' },
      html: { type: 'string', required: true, description: 'The complete HTML for this scene.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scene: { type: 'string', required: true },
          path: { type: 'string', required: true },
          dataStartCount: { type: 'integer', required: true },
          dataDurationCount: { type: 'integer', required: true },
          clipCount: { type: 'integer', required: true },
          problems: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.problems.length === 0
          ? `Wrote ${value.scene}: ${value.dataStartCount} timed element(s), contract satisfied.`
          : `Wrote ${value.scene} but the composition contract is broken:\n${value.problems.map((p) => '  - ' + p).join('\n')}`,
      }],
    },
    execute(args) {
      const dir = projectDir(args.project)
      const file = scenePath(dir, args.scene)
      mkdirSync(join(dir, 'compositions'), { recursive: true })
      writeFileSync(file, args.html, 'utf8')
      const report = inspectScene(dir, args.scene)
      // Keep index.html in step with the scene list. Without this the entry
      // document keeps rendering a blank background, because check/render/preview
      // only ever open index.html.
      const metaPath = join(dir, 'meta.json')
      const scenes = listScenes(dir)
      if (existsSync(metaPath)) {
        try {
          writeIndex(dir, JSON.parse(readFileSync(metaPath, 'utf8')), scenes)
        } catch {
          // A malformed meta.json must not block writing a scene; the next
          // video_list_scenes run will surface whatever is inconsistent.
        }
      }
      // Read index.html only after writeIndex: the host markup this checks is
      // whatever that call just wrote, or whatever the user edited on top of it.
      const mounts = inspectMounts(dir, scenes)
      return {
        scene: args.scene,
        path: file,
        dataStartCount: report.dataStartCount,
        dataDurationCount: report.dataDurationCount,
        clipCount: report.clipCount,
        problems: [...report.problems, ...(mounts.get(args.scene) ?? [])],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_list_scenes',
    description: 'List a project\'s scenes in timeline order with their timing and clip coverage. Run this before video_render to catch contract violations.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          path: { type: 'string', required: true },
          sceneCount: { type: 'integer', required: true },
          brokenCount: { type: 'integer', required: true },
          scenes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scene: { type: 'string', required: true },
                dataStartCount: { type: 'integer', required: true },
                dataDurationCount: { type: 'integer', required: true },
                clipCount: { type: 'integer', required: true },
                bytes: { type: 'integer', required: true },
                problems: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => value.brokenCount === 0
        ? [{
          type: 'text',
          text: `Project ${value.project}: ${value.sceneCount} scene(s), all contracts satisfied. ` + value.scenes.map((s) => `${s.scene}[${s.dataStartCount} timed]`).join(' '),
        }]
        : [{
          type: 'text',
          text: `Project ${value.project}: ${value.brokenCount} of ${value.sceneCount} scene(s) violate the composition contract.\n${value.scenes.flatMap((s) => s.problems.map((p) => `  ${s.scene}: ${p}`)).join('\n')}`,
        }],
    },
    execute(args) {
      const dir = projectDir(args.project)
      const files = listScenes(dir)
      // Project-level, not per-scene: a bad mount belongs to the scene it
      // mounts, so it is folded into that scene's problem list below.
      const mounts = inspectMounts(dir, files)
      const scenes = files.map((scene) => {
        const report = inspectScene(dir, scene)
        return {
          scene,
          dataStartCount: report.dataStartCount,
          dataDurationCount: report.dataDurationCount,
          clipCount: report.clipCount,
          bytes: statSync(join(dir, 'compositions', scene)).size,
          problems: [...report.problems, ...(mounts.get(scene) ?? [])],
        }
      })
      return {
        project: args.project,
        path: dir,
        sceneCount: scenes.length,
        brokenCount: scenes.filter((s) => s.problems.length > 0).length,
        scenes,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_render',
    description: 'Render a project to MP4. Deterministic: frames are captured one at a time, so it cannot drop frames, but it is slow — minutes per minute of video. Always run video_list_scenes first and fix reported problems. Requires ffmpeg and the HyperFrames CLI.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name.' },
      output: { type: 'string', required: true, description: 'Output filename, e.g. "intro-2026.mp4".' },
      width: {
        type: 'number',
        description: 'Override canvas width. Omit to use the project default.',
      },
      height: {
        type: 'number',
        description: 'Override canvas height. Omit to use the project default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          output: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          log: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exitCode === 0
          ? `Rendered ${value.output} (${value.bytes} bytes).`
          : `Render failed (exit ${value.exitCode}):\n${value.log.slice(-1500)}`,
      }],
    },
    async execute(args, exec) {
      const cli = resolveCli(config)
      if (!cli) {
        throw new Error('hyperframes CLI not found. Run video_env_check for the install command.')
      }
      if (!findExecutable('ffmpeg') && !config.ffmpegPath) {
        throw new Error('ffmpeg not found; HyperFrames needs it to encode the MP4. Run video_env_check.')
      }
      // Fail fast. Without the headless shell the render pipeline stalls for
      // minutes on a Puppeteer profile lock and then errors out, so there is no
      // point paying that cost to learn something checkable up front.
      if (!process.env.HYPERFRAMES_BROWSER_PATH && !findHeadlessShell()) {
        throw new Error('Chrome headless shell not found, so the render would stall and fail. Run video_env_check for the download command.')
      }
      const dir = projectDir(args.project)
      const out = isAbsolute(args.output) ? args.output : join(dir, args.output)
      const flag = []
      if (args.width && args.height) flag.push('--width', String(args.width), '--height', String(args.height))
      const result = await run(process.execPath, [cli, 'render', '--output', out, ...flag], {
        cwd: dir,
        signal: exec.signal,
      })
      return {
        project: args.project,
        output: out,
        exitCode: result.code,
        bytes: existsSync(out) ? statSync(out).size : 0,
        log: (result.stdout + result.stderr).slice(-4000),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_check',
    description: 'Run the official `hyperframes check` on a project: lint plus runtime validation plus layout inspection in headless Chrome. Authoritative — it catches JS errors, missing assets, and contrast problems that static inspection cannot. Requires the Chrome headless shell; run video_doctor if it reports a browser problem.',
    parameters: {
      project: { type: 'string', required: true, description: 'Project name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          exitCode: { type: 'integer', required: true },
          passed: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.passed
          ? `hyperframes check passed for ${value.project}.`
          : `hyperframes check reported problems for ${value.project}:\n${value.report.slice(-2500)}`,
      }],
    },
    async execute(args, exec) {
      const cli = resolveCli(config)
      if (!cli) throw new Error('hyperframes CLI not found. Run video_env_check for the install command.')
      const result = await run(process.execPath, [cli, 'check'], {
        cwd: projectDir(args.project),
        signal: exec.signal,
      })
      const report = (result.stdout + result.stderr).replace(/^[\s\S]*?Disable anytime:.*$/m, '').trim()
      return {
        project: args.project,
        exitCode: result.code,
        passed: result.code === 0,
        report: report.slice(-6000),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_doctor',
    description: 'Run `hyperframes doctor` to check the toolchain the way HyperFrames itself does, including its bundled Chrome. Use this when video_env_check passes but rendering still fails.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer', required: true },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report.slice(-3000) }],
    },
    async execute(_args, exec) {
      const cli = resolveCli(config)
      if (!cli) throw new Error('hyperframes CLI not found. Run video_env_check for the install command.')
      const result = await run(process.execPath, [cli, 'doctor'], { signal: exec.signal })
      return { exitCode: result.code, report: (result.stdout + result.stderr).slice(-6000) }
    },
  }))
}

export { Config, apply, inject, installHints, name, toolchainEnv }
