/**
 * Build the system prompt that makes the model reply "as you".
 * 实际逻辑已迁到 persona-presets.js（可视化性格编辑），这里保持向后兼容的入口。
 */
import { buildSystemPrompt } from './persona-presets.js';

/**
 * @param {object} config 完整配置
 * @param {'private'|'group'} scene 场景
 */
export function buildPersona(config, scene = 'private') {
  return buildSystemPrompt(config, scene);
}

export { buildSystemPrompt };
