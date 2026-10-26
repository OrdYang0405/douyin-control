/**
 * tts-openai.mjs — OpenAI 兼容语音合成适配器
 *
 * 一个适配器通吃：
 *   - SiliconFlow / 火山方舟 / MiniMax 等国内服务的 OpenAI 兼容 TTS
 *   - 本地 GPT-SoVITS / Fish-Speech / CosyVoice 的 api 模式（同样是 /v1/audio/speech）
 *   - 官方 OpenAI
 *
 * 只要对方实现了 POST {baseUrl}/audio/speech → 返回音频二进制，就能接。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 常见音色提示（不同服务商名字不同，前端可自由填） */
export const OPENAI_VOICES = [
  { id: 'alloy', name: 'alloy（通用）' },
  { id: 'nova', name: 'nova（女声通用）' },
  { id: 'shimmer', name: 'shimmer（女声柔和）' },
  { id: 'onyx', name: 'onyx（男声低沉）' },
  { id: 'echo', name: 'echo（男声）' },
  { id: 'fable', name: 'fable（叙述）' },
];

function endpoint(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) throw new Error('[openai-tts] 未配置 baseUrl');
  if (/\/audio\/speech$/.test(b)) return b;
  if (/\/v1$/.test(b)) return b + '/audio/speech';
  return b + '/v1/audio/speech';
}

/**
 * @param {{text:string, voice?:string, outPath:string, cfg:{baseUrl:string,apiKey:string,model:string,voice:string}}} p
 * @returns {Promise<{ext:'mp3', file:string, size:number}>}
 */
export async function synthOpenai({ text, voice, outPath, cfg }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('[openai-tts] 文本为空');
  const url = endpoint(cfg.baseUrl);
  const body = {
    model: cfg.model || 'tts-1',
    input: t,
    voice: String(voice || cfg.voice || 'alloy').replace(/^openai:/, ''),
    response_format: 'mp3',
    speed: 1,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`[openai-tts] HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 800) throw new Error(`[openai-tts] 返回内容过小 (${buf.length}B)，可能不是音频`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return { ext: 'mp3', file: outPath, size: buf.length };
}
