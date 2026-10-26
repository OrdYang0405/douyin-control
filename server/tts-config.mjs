/**
 * tts-config.mjs — 语音引擎配置（server/tts-config.json）
 *
 * provider:
 *   auto   —— 有 OpenAI 兼容配置就先用它，失败依次回落 edge → sapi
 *   openai —— 只用 OpenAI 兼容接口（火山/MiniMax/SiliconFlow/本地 GPT-SoVITS 等都能接）
 *   edge   —— 只用微软 Edge 朗读（免费、自然）
 *   sapi   —— 只用本机 Windows SAPI（断网兜底）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'tts-config.json');

const DEFAULTS = {
  provider: 'auto',
  openai: {
    // 例：https://api.siliconflow.cn/v1 、http://127.0.0.1:9880 (GPT-SoVITS api)
    baseUrl: '',
    apiKey: '',
    model: 'tts-1',
    voice: 'alloy',
  },
  edge: { voice: 'zh-CN-XiaoxiaoNeural' },
  sapi: { voice: 'Microsoft Huihui Desktop', rate: 0 },
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(base?.[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

export function load() {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(patch) {
  const cur = load();
  // 前端回传的掩码 key（含 *）不覆盖真实 key
  if (patch?.openai?.apiKey && /[*]{2,}/.test(patch.openai.apiKey)) delete patch.openai.apiKey;
  const next = merge(cur, patch || {});
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 给前端看的版本：key 打码 */
export function masked(cfg = load()) {
  const key = cfg.openai?.apiKey || '';
  return {
    ...cfg,
    openai: {
      ...cfg.openai,
      apiKey: key ? `${key.slice(0, 3)}****${key.slice(-4)}` : '',
      configured: !!(cfg.openai?.baseUrl && key),
    },
  };
}

export function hasOpenai(cfg = load()) {
  return !!(cfg.openai?.baseUrl && cfg.openai?.apiKey);
}
