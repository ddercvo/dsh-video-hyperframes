/**
 * Tests for the composition contract checks and path guards.
 *
 * The contract is the thing worth testing: a scene that violates it renders as
 * a static or empty video while looking fine in an editor, so these assertions
 * pin down which violations the plugin catches.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, inject, name } = await import('../lib/index.js')

/** Minimal stand-in for ctx.tools that records what the plugin registers. */
function fakeRegistry() {
  const registered = []
  return { registered, ctx: { tools: { register: (t) => registered.push(t) } } }
}

/** Build a mounted plugin set over a throwaway project root. */
function mount() {
  const root = mkdtempSync(join(tmpdir(), 'vh-'))
  const { ctx, registered } = fakeRegistry()
  apply(ctx, { projectRoot: root, previewPort: 3002 })
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  return { root, byName, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * A scene that satisfies every rule.
 *
 * Markup only: a scene must not carry a timeline. The project animation lives
 * in index.html, because a timeline registered inside a <template>-wrapped
 * sub-composition is never seeked and the render silently yields a still image.
 */
const GOOD_SCENE = `<!doctype html>
<html><body>
  <template id="demo-scene">
    <div data-composition-id="main" data-width="1920" data-height="1080">
      <h1 id="demo-title" class="clip" data-start="0" data-duration="2" data-track-index="0">Hello</h1>
    </div>
  </template>
</body></html>`

test('plugin declares loader metadata', () => {
  assert.equal(name, 'dsh-tool-hyperframes')
  assert.ok(inject.includes('tools'))
  assert.equal(typeof apply, 'function')
})

test('registers the seven video tools', () => {
  const { byName, cleanup } = mount()
  assert.deepEqual(Object.keys(byName).sort(), [
    'video_check',
    'video_doctor',
    'video_env_check',
    'video_list_scenes',
    'video_new_project',
    'video_render',
    'video_write_scene',
  ])
  cleanup()
})

test('video_new_project writes the same skeleton as hyperframes init', async () => {
  const { byName, cleanup } = mount()
  const out = await byName.video_new_project.execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  // The official init uses composition id "main", not the project name.
  assert.equal(out.compositionId, 'main')
  for (const f of ['index.html', 'meta.json', 'hyperframes.json']) {
    assert.ok(existsSync(join(out.path, f)), `${f} should exist`)
  }
  assert.ok(existsSync(join(out.path, 'compositions')))
  assert.ok(existsSync(join(out.path, 'assets', 'audio')))

  const index = readFileSync(join(out.path, 'index.html'), 'utf8')
  assert.match(index, /data-composition-id="main"/)
  assert.match(index, /data-start="0"/)
  assert.match(index, /data-duration="10"/, 'the root composition carries the project duration')
  assert.match(index, /data-width="1920"/)
  assert.match(index, /data-height="1080"/)
  assert.match(index, /window\.__timelines\["main"\]/, 'a timeline must be registered up front')

  // hyperframes.json is what makes the directory a real HyperFrames project.
  const config = JSON.parse(readFileSync(join(out.path, 'hyperframes.json'), 'utf8'))
  assert.equal(config.paths.blocks, 'compositions')
  assert.equal(config.paths.assets, 'assets')
  cleanup()
})

test('a contract-satisfying scene reports no problems', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'demo', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute(
    { project: 'demo', scene: 'scene-01.html', html: GOOD_SCENE },
    {},
  )
  assert.deepEqual(out.problems, [])
  assert.equal(out.dataStartCount, 1)
  assert.equal(out.clipCount, 1)
  cleanup()
})

test('catches a missing data-composition-id', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div class="clip" data-start="0" data-duration="1">x</div>',
  }, {})
  assert.ok(out.problems.some((x) => /data-composition-id/.test(x)))
  cleanup()
})

test('catches a missing data-duration', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div data-composition-id="p" data-width="1920" data-height="1080">'
      + '<h1 class="clip" data-start="0" data-track-index="0">a</h1>'
      + '<h2 class="clip" data-start="1" data-duration="2" data-track-index="1">b</h2></div>',
  }, {})
  assert.ok(out.problems.some((x) => /data-duration count/.test(x)))
  cleanup()
})

test('catches timed elements missing class="clip"', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div data-composition-id="p" data-width="1920" data-height="1080">'
      + '<h1 data-start="0" data-duration="1">no clip class</h1></div>',
  }, {})
  assert.ok(out.problems.some((x) => /class="clip"/.test(x)))
  cleanup()
})

test('catches a timeline that is never registered on window.__timelines', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  // GSAP present but not registered: outside a template, so this isolates the
  // registration rule from the sub-composition rule above.
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div data-composition-id="main" data-width="1920" data-height="1080">'
      + '<h1 id="a" class="clip" data-start="0" data-duration="1">a</h1></div>'
      + '<script>const tl = gsap.timeline({paused:true});</script>',
  }, {})
  assert.ok(out.problems.some((x) => /__timelines/.test(x)))
  cleanup()
})

test('catches clock-driven animation that cannot be seeked', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div data-composition-id="p" data-width="1920" data-height="1080">'
      + '<h1 class="clip" data-start="0" data-duration="1">a</h1></div>'
      + '<script>setTimeout(() => console.log(1), 100);</script>',
  }, {})
  assert.ok(out.problems.some((x) => /clock-driven/.test(x)))
  cleanup()
})

test('video_write_scene rejects a non-scene filename', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  await assert.rejects(
    () => byName.video_write_scene.execute({ project: 'p', scene: '../escape.html', html: '<div/>' }, {}),
    /scene must match/,
  )
  cleanup()
})

test('video_list_scenes orders scenes numerically and counts violations', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  for (const scene of ['scene-10.html', 'scene-02.html', 'scene-01.html']) {
    await byName.video_write_scene.execute({ project: 'p', scene, html: GOOD_SCENE }, {})
  }
  const out = await byName.video_list_scenes.execute({ project: 'p' }, {})
  assert.equal(out.sceneCount, 3)
  assert.equal(out.brokenCount, 0)
  assert.deepEqual(out.scenes.map((s) => s.scene), ['scene-01.html', 'scene-02.html', 'scene-10.html'])
  cleanup()
})

test('video_list_scenes flags a broken scene', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  await byName.video_write_scene.execute({ project: 'p', scene: 'scene-01.html', html: '<div>bare</div>' }, {})
  const out = await byName.video_list_scenes.execute({ project: 'p' }, {})
  assert.equal(out.brokenCount, 1)
  cleanup()
})

test('video_new_project refuses to escape the project root', async () => {
  const { byName, cleanup } = mount()
  await assert.rejects(
    () => byName.video_new_project.execute({ name: '../escaped', duration: 10, width: 1920, height: 1080 }, {}),
    /escapes/,
  )
  cleanup()
})

test('catches a scene that is not wrapped in a <template>', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<div data-composition-id="main" data-width="1920" data-height="1080">'
      + '<h1 id="a" class="clip" data-start="0" data-duration="1">a</h1></div>',
  }, {})
  assert.ok(out.problems.some((x) => /<template>/.test(x)), 'an unwrapped sub-composition mounts nothing')
  cleanup()
})

test('catches a clip element with no id', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<template><div data-composition-id="main" data-width="1920" data-height="1080">'
      + '<h1 class="clip" data-start="0" data-duration="1">a</h1></div></template>',
  }, {})
  assert.ok(out.problems.some((x) => /have no id/.test(x)))
  cleanup()
})

test('a fresh project is renderable: index.html mounts a valid scene', async () => {
  const { byName, cleanup } = mount()
  const out = await byName.video_new_project.execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  // A blank entry document aborts a render outright, so the skeleton must not
  // ship one: index.html mounts scene-01.html, and that scene is valid.
  const index = readFileSync(join(out.path, 'index.html'), 'utf8')
  assert.match(index, /data-composition-src="compositions\/scene-01\.html"/)
  // A composition host needs data-composition-id as well as the src, plus its
  // own id for Studio. Omitting either is a lint error, not a warning. The host
  // id must also differ from the id the scene registers its timeline under:
  // sharing "main" makes hyperframes remap the host to "main__hf1" and stall 45s.
  assert.match(index, /data-composition-id="scene-01"[^>]*data-composition-src="compositions\/scene-01\.html"/)
  assert.match(index, /id="scene-01-host"/)
  const sceneHtml = readFileSync(join(out.path, 'compositions', 'scene-01.html'), 'utf8')
  assert.match(sceneHtml, /data-composition-id="main"/, 'the scene keeps the project id')

  const listed = await byName.video_list_scenes.execute({ project: 'demo' }, {})
  assert.equal(listed.brokenCount, 0, 'the seeded scene should satisfy the contract')
})

test('every mounted host carries its own composition id and element id', async () => {
  const { byName, cleanup } = mount()
  const proj = await byName.video_new_project.execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  for (const scene of ['scene-01.html', 'scene-02.html']) {
    await byName.video_write_scene.execute({ project: 'demo', scene, html: GOOD_SCENE }, {})
  }
  const index = readFileSync(join(proj.path, 'index.html'), 'utf8')
  const hosts = index.match(/<div[^>]*data-composition-src[^>]*>/g) ?? []
  assert.equal(hosts.length, 2)
  for (const host of hosts) {
    assert.match(host, /data-composition-id=/, 'host_missing_composition_id is a lint error')
    assert.match(host, /\sid="/, 'Studio needs a stable edit target')
  }
  cleanup()
})

test('writing a scene re-mounts index.html with every scene', async () => {
  const { byName, cleanup } = mount()
  const proj = await byName.video_new_project.execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  for (const scene of ['scene-01.html', 'scene-02.html', 'scene-03.html']) {
    await byName.video_write_scene.execute({ project: 'demo', scene, html: GOOD_SCENE }, {})
  }
  const index = readFileSync(join(proj.path, 'index.html'), 'utf8')
  for (const scene of ['scene-01.html', 'scene-02.html', 'scene-03.html']) {
    assert.match(index, new RegExp(`data-composition-src="compositions/${scene.replace('.', '\\.')}"`))
  }
  cleanup()
})

test('catches a timeline inside a <template> that will never be seeked', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'p', width: 1920, height: 1080, duration: 10 }, {})
  const out = await byName.video_write_scene.execute({
    project: 'p',
    scene: 'scene-01.html',
    html: '<template><div data-composition-id="main" data-width="1920" data-height="1080">'
      + '<h1 id="a" class="clip" data-start="0" data-duration="1">a</h1></div></template>'
      + '<script>const tl = gsap.timeline({paused:true});'
      + "window.__timelines['main'] = tl;</script>",
  }, {})
  // This is the failure no linter reports: exit code 0, valid MP4, static image.
  assert.ok(
    out.problems.some((x) => /will not be seeked/.test(x)),
    'a timeline inside a sub-composition must be flagged',
  )
  cleanup()
})

test('the starter project keeps animation out of the scene', async () => {
  const { byName, cleanup } = mount()
  const out = await byName.video_new_project.execute(
    { name: 'demo', duration: 10, width: 1920, height: 1080 },
    {},
  )
  // index.html owns the timeline; the scene is markup only. If a scene ever
  // grows a <script> again, the fresh project silently renders a still image.
  const scene = readFileSync(join(out.path, 'compositions', 'scene-01.html'), 'utf8')
  assert.ok(!/<script/.test(scene), 'the seeded scene must not carry a timeline')
  const index = readFileSync(join(out.path, 'index.html'), 'utf8')
  assert.match(index, /window\.__timelines\["main"\]/, 'the project timeline belongs in index.html')
  cleanup()
})

test('video_env_check reports the toolchain state', async () => {
  const { byName, cleanup } = mount()
  const out = await byName.video_env_check.execute({}, {})
  assert.match(out.node, /^v\d+\./)
  assert.equal(out.previewPort, 3002)
  assert.equal(typeof out.cli, 'string')
  assert.equal(typeof out.ffmpeg, 'string')
  assert.equal(typeof out.browser, 'string')
  assert.equal(typeof out.ready, 'boolean')
  // ffmpeg alone is not enough: the render pipeline also needs the headless shell.
  assert.equal(typeof out.canRender, 'boolean')
  if (out.ready && !out.canRender) {
    assert.ok(out.hints.some((h) => /headless shell/i.test(h)), 'a missing browser must come with instructions')
  }
  cleanup()
})

test('video_render refuses to start without the headless shell', async () => {
  const { byName, cleanup } = mount()
  await byName.video_new_project.execute({ name: 'demo', duration: 10, width: 1920, height: 1080 }, {})
  // Only meaningful when the shell is genuinely absent from this machine.
  const env = await byName.video_env_check.execute({}, {})
  if (env.canRender) {
    cleanup()
    return
  }
  await assert.rejects(
    () => byName.video_render.execute({ project: 'demo', output: 'out.mp4' }, {}),
    /headless shell/i,
  )
  cleanup()
})
