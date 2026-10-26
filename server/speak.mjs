/**
 * speak.mjs — 语音合成门面（按配置决定链路，失败自动降级）
 *
 * 音色 id 用前缀区分引擎：  openai:xxx  /  edge:zh-CN-XxxNeural  /  sapi:Microsoft Huihui Desktop
 * 不带前缀时按 tts-config.json 的 provider 走。
 *
 * 降级顺序（保证永远有声音）：
 *   openai（克隆/自定义） → edge（云端自然） → sapi（本机离线）
 */
import { load, hasOpenai } from './tts-config.mjs';
import { synthOpenai, OPENAI_VOICES } from './tts-openai.mjs';
import { speakSapi, SAPI_VOICES, sapiAvailable } from './tts-sapi.mjs';
import { speakClone, cloneAvailable, listRefs } from './tts-clone.mjs';

let edgeMod = null;
async function edge() {
  if (edgeMod === null) edgeMod = await import('./tts.mjs').catch(() => false);
  return edgeMod || null;
}

export const DEFAULT_VOICE = 'edge:zh-CN-XiaoxiaoNeural';

/** 控制台可选音色表（按引擎分组） */
export async function voices() {
  const cfg = load();
  const out = [];

  // A 方案：本地克隆音色（放最前，最接近真人）
  if (cloneAvailable()) {
    for (const r of listRefs()) {
      if (!r.isWav) continue;                     // mp3 参考音色需要先转 wav
      const name = r.file.replace(/\.wav$/i, '');
      out.push({ id: 'clone:' + name, name: `${name} · 本地克隆` });
    }
  }

  if (hasOpenai(cfg)) {
    for (const v of OPENAI_VOICES) out.push({ id: 'openai:' + v.id, name: v.name + ' · 自定义/克隆' });
  }
  const m = await edge();
  if (m?.VOICES) {
    for (const v of m.VOICES) out.push({ id: 'edge:' + v.id, name: v.name + ' · 云端' });
  }
  if (sapiAvailable()) {
    for (const v of SAPI_VOICES) out.push({ id: v.id, name: v.name });
  }
  return out;
}

/**
 * @param {{text:string, voice?:string, base:string}} p base 为不含扩展名的输出路径
 * @returns {Promise<{ext:'mp3'|'wav', file?:string, size?:number, engine?:string}>}
 */
export async function speak({ text, voice, base }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('[speak] 文本为空');

  const cfg = load();
  const wanted = String(voice || defaultOf(cfg));
  const idx = wanted.indexOf(':');
  const prefix = idx > 0 ? wanted.slice(0, idx) : '';
  const vname = idx > 0 ? wanted.slice(idx + 1) : wanted;

  const attempts = [];
  const pushOpenai = () => {
    if (!hasOpenai(cfg)) return;
    attempts.push(async () => {
      const r = await synthOpenai({ text: t, voice: vname, outPath: base + '.mp3', cfg: cfg.openai });
      return { ...r, engine: 'openai' };
    });
  };
  const pushEdge = async () => {
    const m = await edge();
    if (!m?.synthesize) return;
    attempts.push(async () => {
      await m.synthesize({ text: t, voice: vname, outPath: base + '.mp3' });
      return { ext: 'mp3', engine: 'edge' };
    });
  };
  const pushSapi = () => {
    if (!sapiAvailable()) return;
    attempts.push(async () => {
      const r = await speakSapi({
        text: t,
        outPath: base + '.wav',
        voice: /^Microsoft/i.test(vname) ? vname : cfg.sapi.voice,
        rate: Number(cfg.sapi.rate || 0),
      });
      return { ...r, engine: 'sapi' };
    });
  };

  const pushClone = () => {
    if (!cloneAvailable()) return;
    attempts.push(async () => {
      const r = await speakClone({ text: t, voice: vname || wanted, base });
      return { ...r, engine: 'clone' };
    });
  };

  if (prefix === 'clone') {
    // A+C 混合：克隆优先，失败自动回落 Edge（保证永远有声音）
    pushClone(); await pushEdge(); pushOpenai(); pushSapi();
  } else if (prefix === 'openai') {
    pushOpenai(); await pushEdge(); pushSapi();
  } else if (prefix === 'edge') {
    await pushEdge(); pushOpenai(); pushSapi();
  } else if (prefix === 'sapi') {
    pushSapi();
  } else if (cfg.provider === 'openai') {
    pushOpenai(); await pushEdge(); pushSapi();
  } else if (cfg.provider === 'sapi') {
    pushSapi();
  } else {
    await pushEdge(); pushOpenai(); pushSapi();
  }

  const errors = [];
  for (const fn of attempts) {
    try {
      return await fn();
    } catch (e) {
      errors.push(String(e.message || e).slice(0, 300));
    }
  }
  throw new Error('[speak] 全部通道失败:\n - ' + (errors.join('\n - ') || '无可用的语音引擎'));
}

function defaultOf(cfg) {
  if (cfg.provider === 'sapi') return 'sapi:' + (cfg.sapi.voice || 'Microsoft Huihui Desktop');
  if (cfg.provider === 'openai' && hasOpenai(cfg)) return 'openai:' + (cfg.openai.voice || 'alloy');
  if (cfg.provider === 'edge') return 'edge:' + (cfg.edge.voice || 'zh-CN-XiaoxiaoNeural');
  return DEFAULT_VOICE;
}

/** 让上层切换配置后立刻生效（当前实现每次 speak 都读文件，这里留个钩子） */
export function reload() {
  edgeMod = null;
}
