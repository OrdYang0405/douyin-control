/**
 * tts-sapi.mjs — 本机离线 TTS（Windows System.Speech）
 *
 * 为什么留着它：云端 TTS 会挂、会被墙、会限流；这条链路在 Windows 上永远可用，
 * 音质一般但**绝不中断**，适合做兜底与本地联调。
 * 输出 WAV（浏览器/直播伴侣都能直接吃）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'sapi.ps1');
const PS = process.env.SYSTEMROOT + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export const SAPI_VOICES = [
  { id: 'sapi:Microsoft Huihui Desktop', name: '慧慧 · 本机离线（稳）' },
];

export function sapiAvailable() {
  return fs.existsSync(PS) && fs.existsSync(SCRIPT);
}

/** @returns {Promise<{ext:'wav', file:string}>} */
export function speakSapi({ text, outPath, voice = 'Microsoft Huihui Desktop', rate = 0 }) {
  const b64 = Buffer.from(String(text || ''), 'utf8').toString('base64');
  const out = outPath.endsWith('.wav') ? outPath : outPath.replace(/\.[a-z0-9]+$/i, '') + '.wav';
  fs.mkdirSync(path.dirname(out), { recursive: true });

  return new Promise((resolve, reject) => {
    const p = spawn(PS, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-TextB64', b64,
      '-OutFile', out,
      '-Voice', voice.replace(/^sapi:/, ''),
      '-Rate', String(rate),
    ], { windowsHide: true });

    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 1000) {
        return resolve({ ext: 'wav', file: out, size: fs.statSync(out).size });
      }
      reject(new Error(`[sapi] exit=${code} ${err.slice(0, 300)}`));
    });
  });
}
