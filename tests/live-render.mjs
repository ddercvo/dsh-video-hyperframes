// End-to-end drive of the plugin against a real HyperFrames install: build a
// project with video_new_project, write a scene with video_write_scene, verify
// the contract checks pass, then render an actual MP4. This is the only test
// that proves the whole chain works, as opposed to the unit tests which stub
// ctx.tools.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { findExecutable, run } from '../lib/toolchain.js'

// Both paths are overridable so the script works on any machine and in CI.
// Defaults target a throwaway directory, never a real workspace.
const PROJECT_ROOT = process.env.HYPERFRAMES_TEST_ROOT
  ?? join(tmpdir(), 'hyperframes-live-render', 'videos')
const CLI_ROOT = process.env.HYPERFRAMES_CLI_ROOT
  ?? join(homedir(), '.dsh', 'tools', 'hyperframes')

const registered = []
apply({ tools: { register: (t) => registered.push(t) } }, {
  projectRoot: PROJECT_ROOT,
  previewPort: 3002,
  cliRoot: CLI_ROOT,
})
const tool = Object.fromEntries(registered.map((t) => [t.name, t]))

const log = (...a) => console.log(...a)
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

// 1. Environment. Skips the expensive render when the toolchain is incomplete.
const env = await tool.video_env_check.execute({}, {})
log(`env: canRender=${env.canRender} browser=${env.browser}`)
if (!env.canRender) {
  log('SKIP: toolchain incomplete, cannot render. Run video_env_check output above.')
  process.exit(0)
}

// 2. A project built entirely by the plugin, then a real scene.
const name = `e2e-${Date.now()}`
const proj = await tool.video_new_project.execute(
  { name, duration: 2, width: 640, height: 360 },
  {},
)
log(`proj: ${proj.path}`)

// The animation lives in index.html, not here. A timeline registered inside a
// <template>-wrapped sub-composition is never seeked: the render still exits 0
// with a plausible MP4, but every frame is byte-identical.
//
// The element id is title-01 because that is what the generated index.html
// timeline animates. A scene whose ids do not match the timeline's selectors
// animates nothing, and the render still succeeds — the same silent failure in
// a different shape.
const scene = `<!doctype html>
<html><body>
  <template id="scene-01">
    <div data-composition-id="main" data-width="640" data-height="360"
         style="position:relative;width:640px;height:360px;background:#101010;overflow:hidden;">
      <div id="title-01" class="clip" data-start="0" data-duration="2" data-track-index="0"
           style="position:absolute;left:40px;top:140px;width:160px;height:80px;background:#ff3b30;border-radius:8px;"></div>
    </div>
  </template>
</body></html>`

const written = await tool.video_write_scene.execute(
  { project: name, scene: 'scene-01.html', html: scene },
  {},
)
log(`write: problems=${JSON.stringify(written.problems)}`)
if (written.problems.length > 0) fail('the plugin flagged its own starter contract')

const listed = await tool.video_list_scenes.execute({ project: name }, {})
log(`list: ${listed.sceneCount} scene(s), ${listed.brokenCount} broken`)
if (listed.brokenCount !== 0) fail('a freshly written scene should not be broken')

// 3. The authoritative linter, then the render.
const check = await tool.video_check.execute({ project: name }, {})
log(`check: exit=${check.exitCode} passed=${check.passed}`)
if (!check.passed) log(check.report.slice(-1500))

const out = `e2e-${name}.mp4`
const t0 = Date.now()
const rendered = await tool.video_render.execute({ project: name, output: out }, {})
log(`render: exit=${rendered.exitCode} bytes=${rendered.bytes} in ${Math.round((Date.now() - t0) / 1000)}s`)

if (rendered.exitCode === 0 && existsSync(rendered.output)) {
  const bytes = statSync(rendered.output).size
  if (bytes < 1000) fail(`output is only ${bytes} bytes, expected a real video`)
  else log(`OK: wrote ${rendered.output} (${bytes} bytes)`)
} else {
  fail('render did not produce an output file')
  log(rendered.log.slice(-2500))
}

// A video whose frames are all identical means the timeline was never seeked:
// the render "succeeds" and yields a plausible MP4 of a still image. Comparing
// extracted frame hashes is the only way to catch it, so do exactly that when
// ffmpeg is reachable.
if (rendered.exitCode === 0 && existsSync(rendered.output)) {
  const ffmpeg = findExecutable('ffmpeg')
  if (!ffmpeg) {
    log('NOTE: ffmpeg not found, cannot verify frames differ. Check the MP4 by hand.')
  } else {
    const dir = join(rendered.output, '..', 'framecheck')
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
    await run(ffmpeg, [
      '-v', 'error', '-i', rendered.output,
      '-vf', "select='eq(n\\,0)+eq(n\\,15)+eq(n\\,30)+eq(n\\,45)+eq(n\\,59)'",
      '-fps_mode', 'passthrough', join(dir, 'f%02d.png'),
    ], {})
    const hashes = new Set(readdirSync(dir).map((f) =>
      createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')))
    log(`frames sampled: ${readdirSync(dir).length}, distinct: ${hashes.size}`)
    if (hashes.size <= 1) {
      fail('every sampled frame is identical — the timeline was never seeked, so the MP4 is a still image')
    } else {
      log('OK: frames differ, the animation is really being rendered')
    }
  }
}

// Cleanup is opt-in. A recursive delete can trip a safety guard, and leaving a
// throwaway project behind is cheaper than a failed verification run.
if (process.env.KEEP_E2E) log(`kept: ${proj.path}`)
else log('(set KEEP_E2E=1 to keep the project directory)')
