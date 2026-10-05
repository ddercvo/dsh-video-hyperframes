# Installing this plugin — notes for an agent

This repository is a plugin for the **DeepSeek Harness (dsh)**. Installing it
means registering it in a dsh profile so the harness loads it on next start.

Everything below is written for an automated agent. Read the whole thing before
acting — in particular, **there are two steps you cannot do yourself**, and
attempting them will break the session you are running in.

---

## What you can do end to end

```bash
# 1. Get the code
git clone https://github.com/ddercvo/dsh-video-hyperframes.git
cd dsh-video-hyperframes

# 2. Install its dependencies (either works; pnpm is what dsh itself uses)
npm install            # or: pnpm install

# 3. Register it in the user's dsh profile
node scripts/install.mjs
```

Step 3 is idempotent and safe to re-run. It edits two files and backs each one
up to `<name>.bak-<timestamp>` first:

- `$DSH_HOME/profiles/<profile>/package.json` — adds the dependency and lists
  the plugin in `dsh.profile.bundles`
- `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — appends the tool row and the
  "视频制作模式" session preset

`$DSH_HOME` defaults to `~/.dsh`; the profile defaults to `desktop`. Useful
flags: `--profile <name>`, `--dry-run` (print the plan, write nothing),
`--uninstall`, `--help`.

To check whether it is already configured, run `--dry-run` and read the output.

---

## What you CANNOT do — hand these to the user

**1. Restarting dsh.**

You are running *inside* a dsh session. Restarting the harness terminates that
session, which means terminating yourself mid-task. Do not attempt it, and do
not kill or signal dsh processes to force it.

Tell the user, in their language, that dsh must be restarted and that you cannot
do it from inside the session.

**2. Opening a new session.**

Presets are fixed when a session starts (`agent-preset/locked`), so the new
"视频制作模式" preset will not appear in any session that already exists —
including the one you are in. This is also something only the user can do.

So the correct ending to your work is: confirm steps 1–3 succeeded, then tell
the user to **restart dsh and open a new session**. Do not report the plugin as
"ready" before that happens — it is installed, but not yet loaded.

---

## Prerequisites

| Requirement | Why | Notes |
| --- | --- | --- |
| Node **20.11+** | the plugin uses `import.meta.dirname` | check with `node --version` |
| pnpm or npm | to install dependencies | if dsh runs at all, pnpm is already present — dsh requires it |
| ffmpeg + Chrome headless shell | to actually **render video** | **not needed to install** |

That last row is worth being precise about: `install.mjs` does not need ffmpeg
or a browser. They matter only once someone tries to render. Install first; if
rendering is the goal, sort the toolchain out after.

---

## Verifying

`install.mjs` prints what it changed. After that:

1. `cd $DSH_HOME/profiles/<profile> && pnpm install` — links the package
2. restart dsh, open a new session
3. in the new session, run the tool **`video_doctor`** or **`video_env_check`**

Those two report the toolchain state and print the exact install command for
whatever is missing, for the platform they are running on. Prefer them over
instructions copied from anywhere else, including this file — they read the real
machine, and this file cannot.

If rendering is the goal and the headless shell is missing, `video_env_check`
will tell you how to get it. Do not point `HYPERFRAMES_BROWSER_PATH` at an
ordinary Chromium or Chrome build: those ignore the `--version` probe
HyperFrames uses and rendering stalls on a Puppeteer profile lock.

---

## If something goes wrong

- **`install.mjs` says "no such dsh profile"** — it lists the profiles that do
  exist. Pass the right one with `--profile <name>`.
- **`cordis.patch.yml` looks wrong afterwards** — every edit made a backup next
  to the original. Restore it, or run `--uninstall` to remove the plugin's rows.
- **The tools do not appear in a session** — the two steps above. dsh has to be
  restarted and a *new* session opened; this is not hot-reloaded.
- **`pnpm install` is rejected** — in the *profile* directory, use pnpm.
  `link:` is a pnpm protocol and npm reports `EUNSUPPORTEDPROTOCOL` for it.

---

## Working on the plugin itself

```bash
npm run build                 # src/ -> lib/ (a straight copy; src is the source of truth)
npm test                      # 45 tests, needs no toolchain
node tests/live-render.mjs    # renders a real MP4; needs ffmpeg + headless shell
node scripts/install.mjs --dry-run
```

`lib/` is committed on purpose: it is what `package.json#exports` points at, so
a clone works without a build step. Edit `src/`, then build.

`tests/live-render.mjs` is the only test that can catch a render that produces a
still image instead of video — it extracts frames and compares hashes. It is not
in CI because it needs the headless shell.
