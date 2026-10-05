/**
 * A stand-in for `@deepseek-ai/dsh-tools`, for CI only.
 *
 * Why this exists: `lib/index.js` imports `defineTool` at module scope, so
 * without the package present the module cannot even load -- every test that
 * imports the plugin fails, including the ones that never touch dsh.
 *
 * The real package is not usable in CI. It is published, but the version this
 * plugin declares (`0.2.0-rc.2`) is not on npm, and the whole `@deepseek-ai/dsh-*`
 * family is normally supplied by the harness itself: locally, `node_modules/@deepseek-ai/*`
 * are symlinks into dsh's own npx cache, not registry installs.
 *
 * What is reproduced, and why it has to be:
 *
 *   * `execute` is **async**. The real one is too. This is an interface
 *     contract, not an emulation: a synchronous throw escapes `assert.rejects`
 *     (which re-rejects when the callback throws synchronously), so two path
 *     guard tests fail against a plain pass-through.
 *
 * What is deliberately NOT reproduced:
 *
 *   * Argument validation. The real `defineTool` runs the parameters schema
 *     against the args and throws `ToolArgsError` before the tool body. So CI
 *     does not verify that the schemas this plugin declares are well-formed —
 *     only the harness does that. Fixing that means running the real package,
 *     which means a real dsh install.
 *
 * Everything the tests do assert — the composition contract checks, the path
 * guards, what each tool returns — is the plugin's own logic and runs for real.
 * `tests/e2e.test.mjs`, which needs the genuine runtime, stays local.
 *
 * Keep this file this small. The moment it starts emulating tool behaviour,
 * the CI signal stops meaning what it says.
 */
export const defineTool = (definition) => ({
  ...definition,
  async execute(args, exec) {
    return definition.execute(args, exec)
  },
})

export default { defineTool }
