# dsh-tool-hyperframes

给 DeepSeek Harness 加一套**用 HTML 写动画、逐帧渲染成 MP4** 的工具。

底层是 [HyperFrames](https://hyperframes.app)：组合（composition）就是普通 HTML，
元素挂 `class="clip"` + `data-start` / `data-duration` 控制出场时间；渲染时不录屏、
不实时播放抓帧，而是 `frame = floor(time * fps)` 逐帧向页面索要某一帧
（Chrome `beginFrame`），再交 FFmpeg 编码。所以慢机器只是渲染更久，**不会掉帧**，
同输入必同输出。

## 安装

前置：**Node 20+**、**ffmpeg**、**Chrome headless shell**（后两个见下面「工具链」）。

```bash
git clone https://github.com/lxy/dsh-video-hyperframes.git
cd dsh-video-hyperframes
pnpm install          # link: 是 pnpm 语法，npm install 会报 EUNSUPPORTEDPROTOCOL
```

然后在**你的 dsh profile** 里（`$DSH_HOME/profiles/<profile>/`）声明依赖、
挂工具行——细节见下面[「接入 dsh profile」](#接入-dsh-profile)。

前置三件套：**Node 20+**、**ffmpeg**、**Chrome headless shell**
（后两个见下面「三个实测到的坑」）。想先验证工具链，跑 `video_doctor`
或 `video_env_check`——它们会直接告诉你缺什么、改哪。

## 七个工具

| 工具 | 作用 |
| --- | --- |
| `video_env_check` | 报告 node / ffmpeg / hyperframes CLI / 项目根目录是否就绪 |
| `video_new_project` | 建项目骨架：`hyperframes.json`、`meta.json`、`index.html`、`compositions/`、`assets/` |
| `video_write_scene` | 写一个场景 HTML，并**当场做 9 类组合契约检查** |
| `video_list_scenes` | 按数字序（不是字典序）列出场景与时序属性计数、契约违规数 |
| `video_check` | 调官方 `hyperframes check`：lint + 运行时校验 + 无头 Chrome 布局检查 |
| `video_doctor` | 调官方 `hyperframes doctor`：按 HyperFrames 自己的方式体检工具链 |
| `video_render` | 调 `hyperframes render` 出 MP4，回传退出码、字节数、日志尾部 |

`video_write_scene` 的契约检查是这个插件最有价值的部分——下面这些错误在预览里
几乎看不出来，但会直接毁掉成片。**第 9 条最阴险**：

1. 场景内容没包在 `<template>` 里
2. 挂载宿主元素缺 `data-composition-id`，或缺自己的 `id`
3. 根元素没有 `data-composition-id`（必须是 `"main"`，不是项目名）
4. 完全没有 `data-start` → 整段渲染成静止图
5. `data-start` 与 `data-duration` 数量不等 → 缺 `data-duration` 的元素**永不退场**
6. 有 `data-start` 但没挂 `class="clip"` → 该元素被渲染器忽略
7. 用了 GSAP 却没注册 `window.__timelines[id]` → 渲染器找不到 timeline，动画不动
   （只写 `paused: true` **不够**，它要按 composition id 查表）
8. 时序元素没有 `id` → Studio 找不到稳定编辑目标
9. **GSAP timeline 写在了场景文件里** → 渲染 `exit 0`、MP4 正常、linter 全绿，
   但**每一帧都是同一张静止图**。任何静态检查都发现不了

## 组合契约

`video_new_project` 产出的骨架与官方 `hyperframes init` 一致，两个工具可以互相接手
同一个项目。根元素**自己也是一个 timed clip**，`data-start` + `data-duration`
决定整个项目时长：

```html
<div id="root"
     data-composition-id="main"
     data-start="0" data-duration="10"
     data-width="1920" data-height="1080"></div>
```

`composition-id` 固定是 `"main"`（**不是项目名**）。`hyperframes.json` 是让目录
成为合法 HyperFrames 项目的关键：

```json
{ "paths": { "blocks": "compositions", "components": "compositions/components", "assets": "assets" } }
```

## 写场景的硬约束

动画必须**可 seek**——渲染器是逐帧索要某一帧，不是实时播放：

```js
const tl = gsap.timeline({ paused: true })
tl.to('#a', { opacity: 1, duration: 0.4 }, 0)
window.__timelines = window.__timelines || {}
window.__timelines['main'] = tl   // 渲染器按 composition id 查这张表
```

- GSAP：`{ paused: true }` + 注册到 `window.__timelines[id]`，靠 `.time(t)` seek
- Lottie：`goToAndStop(frame, true)`
- 纯 CSS：`animation-delay: -2s`（负延迟），并且 `animation-play-state: paused` 更稳
- ❌ 不要用 `setTimeout` / `setInterval` / `requestAnimationFrame` 驱动——它跟真实时钟走，
  逐帧 seek 会错位

### ⚠️ timeline 必须写在 index.html，不能写进场景

这是唯一一条**静态检查和 linter 都发现不了**的规则，也是最容易踩的：

把 GSAP timeline 注册在 `<template>` 子组合里，渲染会 **`exit 0`、MP4 正常、
linter 全绿——但每一帧都是同一张静止图**。

项目级的 timeline 归 `index.html` 所有，它驱动挂载进来的场景元素。
`writeIndex()` 生成的骨架就是这么做的，`starterScene()` 里刻意不放任何 `<script>`。

验证办法只有一个——抽帧算哈希：

```bash
ffmpeg -v error -i out.mp4 -vf "select='eq(n\,0)+eq(n\,30)+eq(n\,59)'" -fps_mode passthrough f%02d.png
md5sum f*.png    # 全部相同 = timeline 没被 seek
```

`tests/live-render.mjs` 每次都会做这件事。

### 场景怎么挂进 index.html

场景写在 `compositions/scene-NN.html` 里，**默认的 check / render / preview / publish
全都只开 `index.html`**，所以必须让 index.html 显式挂载它，否则渲染出来只有背景色，
而且 hyperframes 会直接 `Aborting render because the default index.html entry is blank`。

两处都要对：

```html
<!-- index.html：宿主元素用 data-composition-src 挂载。
     宿主自己要带 data-composition-id 和 id，两者都不能少。 -->
<div id="root"
     data-composition-id="main"
     data-start="0" data-duration="2"
     data-width="1920" data-height="1080">
  <div id="scene-01-host" class="scene-host"
       data-composition-id="scene-01"
       data-composition-src="compositions/scene-01.html"></div>
</div>
```

**⚠️ 宿主的 `data-composition-id` 必须和场景内注册 timeline 的 id 不同。**
都写 `main` 时，hyperframes 会把宿主当成同名嵌套组合、重映射成 `main__hf1`，
然后死等一个永远不会被注册的 `window.__timelines["main__hf1"]` —— 白等 45 秒。
实测同一支 2 秒片子：宿主写 `main` → 1 分 45 秒；写 `scene-01` → 15 秒，输出一模一样。

```html
<!-- compositions/scene-01.html：内容包在 <template> 里，不要放 script -->
<template id="scene-01">
  <div data-composition-id="main" data-width="1920" data-height="1080">
    <h1 id="hero-title" class="clip" data-start="0" data-duration="2" data-track-index="0">A</h1>
  </div>
</template>
```

**时序元素还要有 `id`**（`studio_missing_editable_id`）。没有 `id`，Studio 的时间轴和
画布控件找不到稳定编辑目标。

## 接入 dsh profile

profile 里声明：

```json
{
  "dependencies": { "dsh-tool-hyperframes": "link:<你的 dsh sources 目录>/dsh-video-hyperframes" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tool-hyperframes"] } }
}
```

`cordis.patch.yml` 里挂工具行，并引入「视频制作模式」preset。

**两个 id 必须写在 `- insert:` 列表里**，这是官方 preset 用的形式：

```yaml
- insert:
    - id: tool-hyperframes
      name: 'dsh-tool-hyperframes'
      config:
        # 产出落在会话的工作目录下的 videos/
        projectRoot: !!js "process.getBuiltinModule('node:path').join(process.cwd(), 'videos')"
        previewPort: 3002
        # 指向你本地的 hyperframes CLI 安装位置（下面写的是 npx 缓存里的那份）
        cliRoot: !!js "process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), 'AppData', 'Local', 'npm-cache', '_npx', '<hash>', 'node_modules', '@deepseek-ai', 'hyperframes')"
    - id: preset-video
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: video
        # ...
```

`cliRoot` 留空也能跑——插件会依次找部署配置、同级安装、PATH 上的 `hyperframes`，
最后才放弃。写死只是省掉几次探测。

写成顶层的 `- id:` 是**覆盖**语义：dsh 只在该 id 已被某个 bundle 贡献时才保留它，
否则打一行 `patch: entry "<id>" not found` 就把整行丢掉——**不报错**。
`insert` 是无条件添加，不依赖 bundles 声明了什么。

`insert` 列表里不能夹空行（YAML 会报 `bad indentation of a sequence entry`），
所有条目必须连续。

不需要 `agent-preset-registry` 行：`dsh-web-app` 已依赖
`@deepseek-ai/dsh-agent-preset-registry`，registry 随 bundle 一起加载。

`previewPort` 默认 **3002**（HyperFrames 自己的 preview server 默认值）。
`link:` 是 pnpm 语法，用 `pnpm install` 装（`npm install` 会报 `EUNSUPPORTEDPROTOCOL`）。

改完记得**重启 dsh**，然后**开新会话** —— preset 是会话级不可变的
（`agent-preset/locked`），老会话不会变。产出落在会话工作目录的 `videos/` 下。

CLI 装在独立目录，不进 profile 的依赖树：

```bash
cd ~/.dsh/tools/hyperframes && npm install --ignore-scripts
```

`--ignore-scripts` 是为了绕开 esbuild 的 postinstall —— 它会 spawnSync 校验二进制，
managed node.exe 被占用时直接 `EBUSY`，而二进制本来就随包下来了，脚本只做版本验证。

## 三个实测到的坑

**ffmpeg 不在 PATH**。它来自 WinGet 包目录，安装器没写进 PATH。
`src/toolchain.js` 的 `findExecutable()` 会先查 PATH，再扫
`%LOCALAPPDATA%\Microsoft\WinGet\Packages`（深度 3），所以裸 `ffmpeg` 也能跑通。
实测定位到的是这类路径（`Gyan.FFmpeg_...` 开头的包目录）：

```
%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_..._8wekyb3d8bbwe\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe
```

**Chrome headless shell 要单独下，ffmpeg 装了不代表能渲染**。`check` / `render`
都依赖它。`hyperframes browser ensure` 在本机只有 ~59 KB/s，而且**不支持断点续传**
（内部走 puppeteer `install()` 写进全新 staging 目录，中断就白下）。curl 官方源快一倍多：

```bash
mkdir -p ~/.cache/hyperframes/chrome && cd ~/.cache/hyperframes/chrome
curl -L -C - --retry 10 --retry-delay 3 --retry-all-errors \
  -o chrome-headless-shell-152.0.7977.30.zip \
  "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.30/win64/chrome-headless-shell-win64.zip"
```

解压到 `~/.cache/hyperframes/chrome/chrome-headless-shell/win64-152.0.7977.30/`，
`toolchain.js` 的 `findHeadlessShell()` 会发现它并注入 `HYPERFRAMES_BROWSER_PATH`。

**不要拿普通 Chromium 顶替**。`HYPERFRAMES_BROWSER_PATH` 指向 Playwright 的 Chromium
会被接受，`browser_probe` 甚至能过（37ms）——但渲染会卡死在 Puppeteer profile 锁上，
6 分钟 0 帧然后失败。根因：hyperframes 用 `spawn(binary, ["--version"])` 验证浏览器，
而那些 build 不认 `--version`，5 秒超时被 SIGKILL。`video_render` 现在会提前拒绝，
不再让你白等 6 分钟。

**preset 是会话级不可变的**。`agent-preset/locked` 错误码写明了：会话一旦开始对话，
组合就固定。改 preset 要开新会话，不会热更新。

## 开发

```bash
node scripts/build.mjs                      # src/*.js 是纯 ESM，构建只是拷到 lib/
node --test tests/plugin.test.mjs tests/e2e.test.mjs   # 23 个测试
node tests/live-render.mjs                   # 真实端到端：建项目→linter→渲染→抽帧比对
node scripts/validate-patch.mjs <patch.yml>  # 用 dsh 自己的解析器验 patch
```

测试分三层：`tests/plugin.test.mjs`（22 个）用桩 `ctx.tools` 测逻辑与契约检查，
`tests/e2e.test.mjs`（1 个）在**真实 Cordis 上下文**里挂载并跑完整项目生命周期，
`tests/live-render.mjs` **真的调 CLI 出片**并验证帧在动。
后两者都需要 headless shell。

`e2e` 需要 `dsh-system-prompt`（`ToolRuntime` 声明了 `inject: ['systemPrompt']`，
少一个服务 fiber 就停在半路，`ctx.tools` 是 undefined）。

`validate-patch.mjs` 分两层：第一层调 dsh 自己的 `--dump-config` 解析 patch
（能抓到 YAMLException 和被静默丢弃的行），第二层才做结构报告和 `!!js` 语法检查。
注意 `desktop` profile 由 Electron 独占、CLI 拒绝 boot，所以校验时把 patch
`--patch` 叠加到 `web` profile 上——两者走同一条解析路径。

契约本身是实测校准的，不是读文档推测的——第 1/2/5 条（`<template>`、
宿主的 composition-id、元素 `id`）都是被官方 linter 报出来才发现代码里没实现，
第 9 条（timeline 不能放子组合）连 linter 都查不出，靠抽帧比对才暴露。
