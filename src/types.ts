/**
 * HyperFrames tool plugin: project scaffolding, seekable scene authoring, and
 * deterministic MP4 rendering, exposed as model-facing tools.
 * @module dsh-tool-hyperframes
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export declare const name: 'dsh-tool-hyperframes'
export declare const inject: string[]

/** Deployment paths and ports for the toolchain. */
export interface Config {
  /** Directory under which video projects are created. */
  projectRoot: string
  /** Absolute ffmpeg path, when it is not resolvable on PATH. */
  ffmpegPath?: string
  /** Port the preview server binds. */
  previewPort: number
}

/** Schemastery configuration for this plugin. */
export declare const Config: z<Config>

/**
 * Register `video_new_project`, `video_write_scene`, `video_list_scenes`,
 * `video_render`, and `video_env_check` on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment paths and ports.
 */
export declare function apply(ctx: Context, config: Config): void

export { toolchainEnv, findExecutable, run } from './toolchain.js'
