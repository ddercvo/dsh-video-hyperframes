/**
 * End-to-end load test: mount the plugin on a real Cordis context with the real
 * tool registry, and drive one full project lifecycle. Unit tests stub
 * `ctx.tools`; this proves the plugin actually loads through the loader's
 * `apply` convention, that its declared schemas compile, and that the skeleton
 * it writes is the one the HyperFrames CLI expects.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../lib/index.js'

/**
 * Cordis services start asynchronously; give the fibers a few turns to settle
 * before asserting on the resulting context.
 * @param ctx - the context to wait on.
 */
async function settle(ctx) {
  for (let i = 0; i < 20; i += 1) {
    if (ctx.tools) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('plugin mounts on a real Cordis context and composes a project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hf-e2e-'))
  const ctx = new Context({ Config: {} })
  // ToolRuntime declares `inject: ['systemPrompt']`, so the prompt service has to
  // be mounted too — otherwise the fiber stays parked and ctx.tools is undefined.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await settle(ctx)
  assert.ok(ctx.tools, 'ctx.tools should be available after the service initializes')

  apply(ctx, { projectRoot: root, previewPort: 3002 })

  for (const expected of [
    'video_check',
    'video_doctor',
    'video_env_check',
    'video_list_scenes',
    'video_new_project',
    'video_render',
    'video_write_scene',
  ]) {
    assert.ok(ctx.tools.get(expected), `registry should expose ${expected}`)
  }

  const call = (name) => ctx.tools.get(name)

  // Full lifecycle against the real tool definitions. The registry validates
  // arguments against the declared parameter schema, so a wrong shape fails here
  // rather than inside a render.
  const proj = await call('video_new_project').execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  // `hyperframes init` uses "main" as the root composition id, not the project name.
  assert.equal(proj.compositionId, 'main')
  for (const f of ['index.html', 'meta.json', 'hyperframes.json']) {
    assert.ok(existsSync(join(proj.path, f)), `${f} should exist`)
  }

  // The three files are what make the directory a real HyperFrames project.
  const config = JSON.parse(readFileSync(join(proj.path, 'hyperframes.json'), 'utf8'))
  assert.equal(config.paths.blocks, 'compositions')
  const meta = JSON.parse(readFileSync(join(proj.path, 'meta.json'), 'utf8'))
  assert.equal(meta.id, 'demo')
  const index = readFileSync(join(proj.path, 'index.html'), 'utf8')
  assert.match(index, /data-composition-id="main"/)
  assert.match(index, /data-duration="10"/)

  // A real scene following the documented contract: the <template> wrapper a
  // sub-composition needs, clip class, timing and ids. Markup only — the
  // timeline belongs to index.html, since a timeline inside a <template> is
  // never seeked and renders a still image.
  const sceneHtml = `<!doctype html>
<html><body>
  <template id="scene-01">
    <div data-composition-id="main" data-width="1920" data-height="1080">
      <h1 id="title-a" class="clip" data-start="0" data-duration="2" data-track-index="0">A</h1>
      <h2 id="title-b" class="clip" data-start="2" data-duration="3" data-track-index="1">B</h2>
    </div>
  </template>
</body></html>`
  const written = await call('video_write_scene').execute(
    { project: 'demo', scene: 'scene-01.html', html: sceneHtml },
    {},
  )
  assert.deepEqual(written.problems, [], 'a contract-satisfying scene should report no problems')
  assert.equal(written.dataStartCount, 2)
  assert.equal(written.dataDurationCount, 2)
  assert.equal(written.clipCount, 2)

  // The entry document must actually reach the scene, or a render aborts on a
  // blank index.html, and it is where the project timeline has to live.
  const remounted = readFileSync(join(proj.path, 'index.html'), 'utf8')
  assert.match(remounted, /data-composition-src="compositions\/scene-01\.html"/)
  assert.match(remounted, /window\.__timelines\["main"\]/)

  const listed = await call('video_list_scenes').execute({ project: 'demo' }, {})
  assert.equal(listed.sceneCount, 1)
  assert.equal(listed.brokenCount, 0)
  assert.equal(listed.scenes[0].scene, 'scene-01.html')

  const env = await call('video_env_check').execute({}, {})
  assert.equal(env.previewPort, 3002)
  assert.ok(env.projectRoot)

  // The CLI probe is reported honestly either way: on this machine the CLI
  // lives in ~/.dsh/tools/hyperframes, outside any PATH the harness may see.
  assert.equal(typeof env.cli, 'string')
  assert.equal(typeof env.ready, 'boolean')

  rmSync(root, { recursive: true, force: true })
})
