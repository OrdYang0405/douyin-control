/**
 * tts-clone.mjs — 本地 XTTS 克隆音色（A 方案）
 *
 * 机制：
 *   - 首次使用时拉起 python 常驻进程（加载模型 ~13s，只发生一次）
 *   - 之后每次合成走 stdio 单行 JSON，省掉模型加载
 *   - 进程挂了自动重启
 *
 * 为什么不每句都起 python：模型加载 13 秒，每句都等根本没法用。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PY = path.join(ROOT, 'tools', 'gpt-sovits', '.venv', 'Scripts', 'python.exe');
const SCRIPT = path.join(ROOT, 'tools', 'gpt-sovits', 'xtts_server.py');
const REF_DIR = path.join(ROOT, 'tools', 'gpt-sovits', 'refs');
/** 备用参考目录：纯 ASCII 路径，规避 Windows 下 python stdio 的中文路径问题 */
const REF_DIR_ASCII = 'D:\\tts-refs';

let proc = null;
let seq = 0;
const pending = new Map();
let readyPromise = null;
let starting = false;

export function cloneAvailable() {
  return fs.existsSync(PY) && fs.existsSync(SCRIPT);
}

/** 列出可用参考音频（.wav 优先，mp3 需先转 wav） */
export function listRefs() {
  const dirs = [REF_DIR_ASCII, REF_DIR];
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!/\.(wav)$/i.test(f)) continue;          // 只要 wav，mp3 需先转
      const key = f.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const full = path.join(dir, f);
      out.push({ file: f, path: full, isWav: true, size: fs.statSync(full).size, ascii: dir === REF_DIR_ASCII });
    }
  }
  return out;
}

/** 把参考音频解析成可用的 wav 路径（优先 ASCII 目录） */
export function resolveRef(voiceId) {
  const refs = listRefs();
  if (!refs.length) return '';
  const want = String(voiceId || '').replace(/^clone:/, '').trim();
  const hit = refs.find((r) => r.file === want || r.file.replace(/\.[^.]+$/, '') === want);
  return (hit || refs[0]).path;
}

function start() {
  if (proc || starting) return;
  starting = true;
  proc = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) {
        console.log('[clone] XTTS 服务就绪');
        starting = false;
        readyPromise?.resolve(true);
        continue;
      }
      if (msg.log) { console.log('[clone]', msg.log); continue; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || 'unknown'));
      }
    }
  });

  proc.stderr.on('data', (d) => {
    const s = d.toString().trim();
    // Coqui 的进度日志很多，只保留错误相关
    if (/error|Error|Traceback|failed/i.test(s)) console.warn('[clone:py]', s.slice(0, 300));
  });

  proc.on('exit', (code) => {
    console.warn('[clone] python 退出, code =', code);
    proc = null;
    starting = false;
    readyPromise = null;
    for (const [, p] of pending) p.reject(new Error('克隆服务已退出'));
    pending.clear();
  });

  readyPromise = {};
  readyPromise.promise = new Promise((resolve, reject) => {
    readyPromise.resolve = resolve;
    readyPromise.reject = reject;
    setTimeout(() => reject(new Error('克隆服务启动超时(120s)')), 120000);
  });
}

async function ensureReady() {
  if (!cloneAvailable()) throw new Error('克隆环境未安装');
  if (!proc) start();
  await readyPromise.promise;
}

/**
 * 合成一条
 * @returns {Promise<{ext:'wav', file:string, cost:number, audioSec:number}>}
 */
export async function speakClone({ text, voice, base, speed = 1.0 }) {
  await ensureReady();
  const ref = resolveRef(voice);
  if (!ref) throw new Error('没有可用的参考音频（D:\\tts-refs\\ 或 tools/gpt-sovits/refs/）');

  // 输出也走 ASCII 路径：python 侧写中文路径容易出问题
  const outDir = 'D:\\tts-refs\\out';
  fs.mkdirSync(outDir, { recursive: true });
  const id = String(++seq);
  const fileName = `c${Date.now()}_${id}.wav`;
  const tmpOut = path.join(outDir, fileName);

  const res = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, text, ref, out: tmpOut, speed }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('克隆合成超时(180s)'));
      }
    }, 180000);
  });

  // 把结果搬到最终位置（base 目录可能在含中文的工程目录下，由 node 搬运没问题）
  const finalPath = base + '.wav';
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.copyFileSync(res.path, finalPath);
  try { fs.unlinkSync(res.path); } catch {}

  return { ext: 'wav', file: finalPath, cost: res.cost, audioSec: res.audioSec };
}

export function stopClone() {
  try { proc?.stdin.end(); } catch {}
  try { proc?.kill(); } catch {}
  proc = null;
}
