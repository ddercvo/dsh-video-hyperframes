# dsh-tool-hyperframes

[![CI](https://github.com/ddercvo/dsh-video-hyperframes/actions/workflows/ci.yml/badge.svg)](https://github.com/ddercvo/dsh-video-hyperframes/actions/workflows/ci.yml)

给 DeepSeek Harness 加一套**用 HTML 写动画、逐帧渲染成 MP4** 的工具。

底层是 [HyperFrames](https://hyperframes.app)：组合（composition）就是普通 HTML，
元素挂 `class="clip"` + `data-start` / `data-duration` 控制出场时间；渲染时不录屏、
不实时播放抓帧，而是 `frame = floor(time * fps)` 逐帧向页面索要某一帧
（Chrome `beginFrame`），再交 FFmpeg 编码。所以慢机器只是渲染更久，**不会掉帧**，
同输入必同输出。

## 安装

前置：**Node 20.11+**、**ffmpeg**、**Chrome headless shell**
（后两个见下面「三个实测到的坑」）。

```bash
git clone https://github.com/ddercvo/dsh-video-hyperframes.git
cd dsh-video-hyperframes
pnpm install                # link: 是 pnpm 语法；npm install 会报 EUNSUPPORTEDPROTOCOL
node scripts/install.mjs    # 注册进 dsh profile
```

`install.mjs` 会改 profile 的 `package.json`（加依赖 + bundle）和
`cordis.patch.yml`（挂工具行 + preset），**两个文件改前都各自备份**成
`<文件名>.bak-<时间戳>`。重复跑是幂等的；`--uninstall` 会把文件还原成安装前的样子
（逐字节一致，有测试守着）。

| 参数 | 作用 |
| --- | --- |
| `--profile <name>` | 目标 profile，默认 `desktop` |
| `--dry-run` | 只打印计划，不写任何文件 |
| `--uninstall` | 移除插件，还原两个文件 |
| `--help` | 用法 |

然后三步生效：

1. `cd $DSH_HOME/profiles/<profile> && pnpm install`
2. **重启 dsh**
3. **开新会话** —— preset 是会话级不可变的（`agent-preset/locked`），
   老会话里不会出现「视频制作模式」

装完跑一次 `video_doctor` 或 `video_env_check` 验证工具链。

<details>
<summary>为什么要有这个脚本：手改会踩两个静默失败</summary>

**1. `cordis.patch.yml` 里的行必须写在 `- insert:` 下面。**

顶层裸 `- id:` 是**覆盖**语义 —— 只有当某个 bundle 已经贡献了同名 id 时才保留。
否则 dsh 打一行 `patch: entry "<id>" not found` 就把整行丢掉，**不报错**。
`insert` 是无条件添加。另外 `insert` 下每个条目缩进必须一致（本仓库用 4 空格），
某行退回 2 空格会 `bad indentation of a sequence entry`。
（空行和注释在列表里**没问题** —— 实测过，不是猜的。）

**2. `package.json` 的依赖必须用 `link:` 协议，且要同时进 `bundles`。**

裸路径会被 pnpm 当成 registry 上的包名；只写 `dependencies` 不进 `dsh.profile.bundles`
的话，包能解析但**插件永远不会被加载**。

脚本把这两件事一起做了，并打印它改了什么。

</details>

## 七个工具

| 工具 | 作用 |
| --- | --- |
| `video_env_check` | 报告 node / ffmpeg / hyperframes CLI / 项目根目录是否就绪 |
| `video_new_project` | 建项目骨架：`hyperframes.json`、`meta.json`、`index.html`、`compositions/`、`assets/` |
| `video_write_scene` | 写一个场景 HTML，并**当场做 10 类组合契约检查** |
| `video_list_scenes` | 按数字序（不是字典序）列出场景与时序属性计数、契约违规数 |
| `video_check` | 调官方 `hyperframes check`：lint + 运行时校验 + 无头 Chrome 布局检查 |
| `video_doctor` | 调官方 `hyperframes doctor`：按 HyperFrames 自己的方式体检工具链 |
| `video_render` | 调 `hyperframes render` 出 MP4，回传退出码、字节数、日志尾部 |

`video_write_scene` 的契约检查是这个插件最有价值的部分——下面这些错误在预览里
几乎看不出来，但会直接毁掉成片。前 9 条只读场景文件，第 10 条要看 index.html
（**第 9、10 条最阴险**，一个出静帧，一个白等 45 秒，都不报错）：

1. 场景内容没包在 `<template>` 里
2. 根元素没有 `data-composition-id`（必须是 `"main"`，不是项目名）
3. 完全没有 `data-start` → 整段渲染成静止图
4. `data-start` 与 `data-duration` 数量不等 → 缺 `data-duration` 的元素**永不退场**
5. 有 `data-start` 但没挂 `class="clip"` → 该元素被渲染器忽略
6. 用了 GSAP 却没注册 `window.__timelines[id]` → 渲染器找不到 timeline，动画不动
   （只写 `paused: true` **不够**，它要按 composition id 查表）
7. 用 `setTimeout` / `setInterval` / `requestAnimationFrame` 驱动动画 → 不可 seek，
   渲染器逐帧索要画面时拿到的是中间态
8. 时序元素没有 `id` → Studio 找不到稳定编辑目标
9. **GSAP timeline 写在了场景文件里** → 渲染 `exit 0`、MP4 正常、linter 全绿，
   但**每一帧都是同一张静止图**。任何静态检查都发现不了
10. **挂载宿主的 `data-composition-id` 和它挂载的场景内部用的 id 撞名** →
   hyperframes 把宿主当成同名嵌套组合、重映射成 `main__hf1`，然后死等一个永远
   不注册的 timeline id。**渲染不报错，只是白等 45 秒**
   （实测同一支 2 秒片子：撞名 1 分 45 秒，不撞 15 秒）。
   官方 lint 帮不上忙 —— 它的规则是「有 `data-composition-id` 就放行」，
   只查字段存在、不查取值。这条只能靠插件自己读 index.html 比对

<details>
<summary>另外两条只有官方 lint 抓</summary>

挂载宿主缺 `data-composition-id`（`host_missing_composition_id`）、
宿主缺自己的 `id`（`studio_missing_editable_id`）。

插件只报**撞名**（第 10 条），不报**缺失**：缺了字段就没有可撞的值，
而且官方 lint 已经把这两种情况都报出来了，重复一遍只会增加噪音。

</details>

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

## 手动接入（`install.mjs` 做的事）

平时不用看这节 —— `node scripts/install.mjs` 会自动完成。这里留作参考，
以及脚本跑不了时（比如 profile 布局不标准）的手改依据。

profile 里声明：

```json
{
  "dependencies": { "dsh-tool-hyperframes": "link:<你的 dsh sources 目录>/dsh-video-hyperframes" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-tool-hyperframes"] } }
}
```

`cordis.patch.yml` 里追加一段。**完整内容见
[`templates/cordis.patch.yml`](templates/cordis.patch.yml)** —— 直接复制粘贴那整份，
它是安装脚本用的同一个模板（含 `>>>` / `<<<` 标记，脚本靠标记做精确卸载）。
形状是这样：

```yaml
# >>> dsh-tool-hyperframes >>> managed by scripts/install.mjs

- insert:
    - id: tool-hyperframes
      name: 'dsh-tool-hyperframes'
      config:
        # 产出落在会话工作目录下的 videos/
        projectRoot: !!js "process.getBuiltinModule('node:path').join(process.cwd(), 'videos')"
        previewPort: 3002
        # 可不写 —— 插件自己会找 CLI（部署配置 → 同级安装 → PATH）
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

`insert` 下每个条目**缩进必须一致**（本仓库用 4 空格）。某行退回 2 空格会报
`bad indentation of a sequence entry`。**空行和注释在列表里是合法的** —— 实测过。
（一开始把那个报错归因于空行，是错的：真正的原因是缩进层级。）

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
node scripts/build.mjs                       # src/*.js 是纯 ESM，构建只是拷到 lib/
node --test tests/plugin.test.mjs tests/install.test.mjs   # 不需要 dsh 运行时
node --test tests/e2e.test.mjs               # 需要 dsh 运行时
node tests/live-render.mjs                   # 真实出片：建项目→linter→渲染→抽帧比对
node scripts/validate-patch.mjs <patch.yml>  # 用 dsh 自己的解析器验 patch
node scripts/install.mjs --dry-run           # 打印安装计划，不写文件
```

测试分四层，**前三层都在 CI 里跑**（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）：

| 文件 | 数量 | 需要什么 | CI |
| --- | --- | --- | --- |
| `tests/plugin.test.mjs` | 26 | 能加载 `lib/index.js` → 要 dsh 运行时 | ✅ |
| `tests/install.test.mjs` | 15 | 无（纯函数 + 临时目录） | ✅ |
| `tests/e2e.test.mjs` | 1 | dsh 运行时（真实 Cordis 上下文），**不渲染** | ✅ |
| `tests/live-render.mjs` | — | dsh + headless shell，会真的渲染 MP4 | ❌ |

CI 里一个 `npm install` 就够：**测试要的包全在公共 registry 上**，
包括 `@deepseek-ai/*` 那套运行时（`peerDependencies` 会一起装上）。
装完 `npm test` 跑 42 个。

> ⚠️ 这里踩过一个坑，记下来免得复犯：
> `npm view @deepseek-ai/dsh-tools version` 只显示 **`latest` dist-tag**，
> 而这个包钉的是 `0.2.0-rc.2` —— **预发布版本不打 latest 标签**，
> 所以看起来"不存在"（显示 `0.0.1-rc.1`）。
> 要查真实版本列表得用 `npm view <pkg> versions`。
> 我当初据此以为装不上，还写了个 stub 顶上 —— 其实一直都在。

只有 `live-render.mjs` 留在本地 —— 它会**抽帧算哈希**，渲染成静止图时直接失败
（这是唯一能发现第 9 条契约违规的方法，需要 Chrome headless shell）。

`e2e` 需要 `dsh-system-prompt`（`ToolRuntime` 声明了 `inject: ['systemPrompt']`，
少一个服务 fiber 就停在半路，`ctx.tools` 是 undefined）——
它作为传递依赖由 `npm install` 带上。

`install.mjs` 的逻辑放在 `scripts/lib/profile-install.mjs` 里，是纯函数，
测试直接调用而不起子进程 —— **本机沙箱下 Node spawn 会 EBUSY**，
起子进程的测试根本跑不起来。

`validate-patch.mjs` 分两层：第一层调 dsh 自己的 `--dump-config` 解析 patch
（能抓到 YAMLException 和被静默丢弃的行），第二层才做结构报告和 `!!js` 语法检查。
注意 `desktop` profile 由 Electron 独占、CLI 拒绝 boot，所以校验时把 patch
`--patch` 叠加到 `web` profile 上——两者走同一条解析路径。

契约本身是实测校准的，不是读文档推测的——第 1/2/5 条（`<template>`、
宿主的 composition-id、元素 `id`）都是被官方 linter 报出来才发现代码里没实现，
第 9 条（timeline 不能放子组合）连 linter 都查不出，靠抽帧比对才暴露，
第 10 条（宿主 id 撞名）是渲染慢得反常、顺着计时查出来的 —— 三条的发现路径都不一样，
这也是为什么这份清单不照文档写。
