// server/tts.mjs —— 零依赖中文 TTS 合成模块（Node 24 自带 fetch / crypto）
// 主路径（实测可用）：微软 Edge「大声朗读」WebSocket 接口
//   * 2026-10 起微软要求 Sec-MS-GEC v2 令牌（旧 v1 算法一律 403）
//   * 令牌格式 "<CS64 16hex>-<SHA256 64hex>"，算法见下方 secMsGecV2()
//   * WebSocket 用自写最小客户端（node:tls + 帧编解码）：内置 undici WebSocket 会吞掉 403 并拒绝该握手
// FALLBACK 备用链路（仅在主路径失败时启用）：百度 text2audio → 有道 dictvoice，输出同为 mp3
import crypto from 'node:crypto';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ---------- 常量 ----------
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WSS_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;
const CONNECT_TIMEOUT_MS = 20000;
const IDLE_TIMEOUT_MS = 15000;

// 中文音色表（id 用于 SSML voice name，name 为中文显示名）
export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓·女声（温柔通用）' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊·女声（活泼少女）' },
  { id: 'zh-CN-YunxiNeural', name: '云希·男声（阳光青年）' },
  { id: 'zh-CN-YunjianNeural', name: '云健·男声（浑厚解说）' },
  { id: 'zh-CN-YunyangNeural', name: '云扬·男声（专业播报）' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北·女声（东北口音）' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮·女声（陕西口音）' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼·女声（粤语）' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻·女声（台湾国语）' },
];

// ---------- Sec-MS-GEC v2（CS64 + 加盐 SHA256） ----------
const u32 = (x) => x >>> 0;
const rotl = (x, n) => u32((x << n) | (x >>> (32 - n)));
const rotr = (x, n) => u32((x >>> n) | (x << (32 - n)));
const rol16 = (x) => rotl(u32(x), 16);

const WIN_EPOCH = 11644473600; // 1601-01-01 → 1970-01-01 秒差

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const K_BLOCK = [...K.slice(0, 14), SHA256_ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJ = 0x059c0b80;
const SIGMA1_ADJ = 0x000b92c0;

const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf], [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb], [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

// 小写 sigma（合并旋转形式，供 W 扩展与初始块使用）
const sg0 = (v) => u32((v >>> 7) ^ (v << 25) ^ (v >>> 18) ^ (v << 14) ^ (v >>> 3));
const sg1 = (v) => u32((v >>> 17) ^ (v << 15) ^ (v >>> 19) ^ (v << 13) ^ (v >>> 10));

function expandSchedule(words, first) {
  for (let i = first; i < 64; i++) {
    words.push(u32(sg1(words[i - 2]) + words[i - 7] + sg0(words[i - 15]) + words[i - 16]));
  }
}

// SHA-256 压缩函数（firstRound=14 时用被替换过的 K[14]）
function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const kt = firstRound === 14 ? K_BLOCK : K;
  for (let i = firstRound; i < 64; i++) {
    const s1 = u32(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25));
    const ch = u32(g ^ (e & (f ^ g)));
    const t1 = u32(h + s1 + ch + kt[i] + words[i]);
    const s0 = u32(rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22));
    const maj = u32((a & b) | (c & (a | b)));
    const t2 = u32(s0 + maj);
    h = g; g = f; f = e; e = u32(d + t1); d = c; c = b; b = a; a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

// 由 token 前 7 字节构造初始状态
function sha256Init(data) {
  const words = new Array(14).fill(0);
  words.push(data.readUIntBE(0, 3));
  words.push(data.readUIntBE(3, 4));
  for (let index = 16; index < 30; index++) {
    let v = SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) v += index === 16 ? sg1(words[index - 2]) ^ SIGMA1_ADJ : sg1(words[index - 2]);
    if (index - 7 >= 14) v += words[index - 7];
    if (index - 15 >= 14) v += index === 29 ? sg0(words[index - 15]) ^ SIGMA0_ADJ : sg0(words[index - 15]);
    words.push(u32(v));
  }
  words.push(u32(sg1(words[28]) + words[23] + sg0(words[15]) + words[14] + SHA256_ADJUSTMENT - K[14]));
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((v, i) => u32(v + working[i]));
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error('GEC 盐长度不足 7 字节');
  const bitLen = 57 + data.length; // 与上游一致的自定义长度字段
  const tail = data.subarray(7);
  const padLen = (((55 - bitLen) % 64) + 64) % 64;
  const body = Buffer.concat([tail, Buffer.from([0x80]), Buffer.alloc(padLen)]);
  const msg = Buffer.alloc(body.length + 8);
  body.copy(msg, 0);
  msg.writeBigUInt64BE(BigInt(bitLen) * 8n, body.length);

  let state = sha256Init(data);
  for (let off = 0; off < msg.length; off += 64) {
    const words = [];
    for (let j = 0; j < 16; j++) words.push(msg.readUInt32BE(off + j * 4));
    expandSchedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((v, i) => u32(v + working[i]));
  }
  const out = Buffer.alloc(32);
  state.forEach((v, i) => out.writeUInt32BE(u32(v), i * 4));
  return out;
}

function cs64Digest(data, digest) {
  let keyA = u32(digest.readUInt32LE(0) | 1);
  let keyB = u32(digest.readUInt32LE(4) | 1);
  const factors = [u32(Math.imul(keyA, CS64_FACTOR)), u32(Math.imul(keyB, CS64_FACTOR))];
  const terms = CS64_COEFFICIENTS.map((c, i) => u32(Math.imul(c[0], factors[i % 2])));
  const offsets = CS64_COEFFICIENTS.map((c) => u32(c[1]));

  // 小端 32 位字，前补一个 0x00 字节，奇数个则再补 0
  const src = Buffer.concat([Buffer.from([0x00]), data]);
  const pad = Buffer.alloc((4 - (src.length % 4)) % 4);
  const wordBuf = Buffer.concat([src, pad]);
  const nWords = wordBuf.length / 4 + (wordBuf.length / 4) % 2;

  for (let index = 0; index < nWords; index++) {
    const word = index < wordBuf.length / 4 ? wordBuf.readUInt32LE(index * 4) : 0;
    const even = index % 2 === 0;
    let term = u32(Math.imul(word, even ? keyA : keyB));
    let offset = u32(Math.imul(rol16(word), even ? 0xef0569fb : 0xc31713db));
    if (index === 0) {
      term = u32(term + u32(Math.imul(CS64_ADJUSTMENT0, factors[0])));
      offset = u32(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index];
    const y = terms[index + 1];

    let t = rol16(u32(offsets[index] + x));
    let q = u32(Math.imul(t, 0x76f50f34));
    swapAcc = u32(swapAcc + u32(u32(Math.imul(rol16(q), 0xc3efea97)) + q));

    t = rol16(u32(offsets[index + 1] + y));
    q = u32(Math.imul(t, 0x1881ce3c));
    swapLast = u32(u32(Math.imul(rol16(q), 0x35bd1ec9)) + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(u32(Math.imul(state, keyA)) + x);
    state = u32(Math.imul(rol16(state), 0xcf98b111));
    state = u32(Math.imul(rol16(state), 0x87085b9f));
    state = u32(Math.imul(rol16(state), 0x12ceb96d));
    state = u32(Math.imul(rol16(state), 0x257e1d83));
    acc = u32(acc + state);

    t = u32(u32(Math.imul(state, keyB)) + y);
    t = u32(Math.imul(rol16(t), 0xa27416f5));
    t = u32(Math.imul(rol16(t), 0xd38396ff));
    state = u32(Math.imul(rol16(u32(Math.imul(rol16(t), 0x7c932b89))), 0xbfa49f69));
    acc = u32(acc + state);
  }
  const w0 = u32(swapLast ^ state);
  const w1 = u32(swapAcc ^ acc);
  const out = Buffer.alloc(8);
  out.writeUInt32LE(w0, 0);
  out.writeUInt32LE(w1, 4);
  return out.toString('hex').toUpperCase();
}

/** 生成 Sec-MS-GEC v2 令牌：<CS64 16hex>-<SHA256 64hex> */
export function secMsGecV2(unixSeconds = Math.floor(Date.now() / 1000)) {
  let ticks = Math.floor((unixSeconds + WIN_EPOCH) / 300) * 300;
  ticks *= 1e7; // 秒 → 100ns 计数
  const data = Buffer.from(`${ticks}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = sha256Digest(data);
  return `${cs64Digest(data, digest)}-${digest.toString('hex').toUpperCase()}`;
}

// ---------- 工具 ----------
const nowStamp = () => new Date().toString();
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const stripBom = (s) => String(s ?? '').replace(/^\uFEFF/, '').trim();

// 长文本按句切块，避免单条 SSML 过大
function chunkText(text, max = 1200) {
  const t = String(text).trim();
  if (t.length <= max) return [t];
  const out = [];
  let rest = t;
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ['。', '！', '？', '；', '\n', '，', '、', ' ']) {
      const i = rest.lastIndexOf(sep, max);
      if (i > cut) cut = i;
    }
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function buildSsml({ text, voice, rate, pitch }) {
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN">` +
    `<voice name="${xmlEscape(voice)}">` +
    `<prosody rate="${xmlEscape(rate)}" pitch="${xmlEscape(pitch)}">` +
    xmlEscape(text) +
    `</prosody></voice></speak>`
  );
}

const buildConfig = () =>
  JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  });

const textFrame = (pathName, contentType, body) =>
  `X-RequestId:${crypto.randomUUID().replace(/-/g, '').toUpperCase()}\r\n` +
  `X-Timestamp:${nowStamp()}\r\nContent-Type:${contentType}\r\nPath:${pathName}\r\n\r\n${body}`;

// 服务端二进制帧：前 2 字节（大端）为头长度，头之后是音频数据
function parseServerFrame(buf) {
  if (buf.length < 2) return { header: '', payload: Buffer.alloc(0) };
  const headerLen = buf.readUInt16BE(0);
  const end = Math.min(2 + headerLen, buf.length);
  return { header: buf.subarray(2, end).toString('utf8'), payload: buf.subarray(end) };
}

const isMp3 = (buf) =>
  buf.length > 0 &&
  (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));

// ---------- Edge 通道 ----------
function edgeWsUrl() {
  const connectionId = crypto.randomUUID().replace(/-/g, '');
  return (
    `${WSS_ENDPOINT}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGecV2()}` +
    `&Sec-MS-GEC-Version=${GEC_VERSION}` +
    `&ConnectionId=${connectionId}`
  );
}

function edgeWsHeaders() {
  return {
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Origin: ORIGIN,
    'Sec-WebSocket-Version': '13',
    'User-Agent': UA,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${crypto.randomBytes(16).toString('hex').toUpperCase()};`,
  };
}

// ---------- 最小 WebSocket 客户端（undici 内置实现会吞掉 403 且拒绝该握手，故自写） ----------
function wsConnect(rawUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u = new URL(rawUrl);
    const host = u.hostname;
    const target = u.pathname + u.search;
    const key = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect({ host, port: Number(u.port) || 443, servername: host });
    const em = new EventEmitter();
    let ready = false;
    let buf = Buffer.alloc(0);
    let fragments = [];
    let fragOpcode = 0;

    const sendFrame = (opcode, payload) => {
      if (sock.destroyed) return;
      const len = payload.length;
      let head;
      if (len < 126) {
        head = Buffer.from([0x80 | opcode, 0x80 | len]);
      } else if (len < 65536) {
        head = Buffer.alloc(4);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(len, 2);
      } else {
        head = Buffer.alloc(10);
        head[0] = 0x80 | opcode;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
      }
      const mask = crypto.randomBytes(4);
      const body = Buffer.alloc(len);
      for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
      sock.write(Buffer.concat([head, mask, body]));
    };

    const emitMessage = (opcode, payload) => {
      if (opcode === 0x1) em.emit('message', { text: payload.toString('utf8') });
      else em.emit('message', { binary: payload });
    };

    // 解析服务端帧（服务端帧不加掩码）
    const drainFrames = () => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) return;
          maskKey = buf.subarray(off, off + 4);
          off += 4;
        }
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
        buf = buf.subarray(off + len);

        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          em.emit('close', code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '');
          sock.destroy();
          return;
        }
        if (opcode === 0x9) {
          sendFrame(0xa, payload); // ping → pong
          continue;
        }
        if (opcode === 0xa) continue; // pong
        if (opcode === 0x0) {
          fragments.push(payload);
          if (fin) {
            const whole = Buffer.concat(fragments);
            fragments = [];
            emitMessage(fragOpcode, whole);
          }
          continue;
        }
        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            emitMessage(opcode, payload);
          } else {
            fragOpcode = opcode;
            fragments = [payload];
          }
        }
      }
    };

    sock.on('secureConnect', () => {
      const lines = [
        `GET ${target} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      const used = new Set(['host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version']);
      for (const [k, v] of Object.entries(extraHeaders || {})) {
        if (used.has(k.toLowerCase())) continue; // 重复的握手头会被服务端判 400
        lines.push(`${k}: ${v}`);
      }
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });

    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (!ready) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const headText = buf.subarray(0, idx).toString('latin1');
        buf = buf.subarray(idx + 4);
        const status = Number((headText.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0);
        const headers = {};
        for (const line of headText.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        if (status !== 101) {
          sock.destroy();
          const err = new Error(
            `[tts][edge] WebSocket 握手失败，HTTP ${status}` +
              (status === 403 || status === 401 ? '（Sec-MS-GEC v2 / Sec-MS-GEC-Version / Origin 不匹配）' : '')
          );
          err.httpStatus = status;
          return reject(err);
        }
        const expect = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        if (headers['sec-websocket-accept'] && headers['sec-websocket-accept'] !== expect) {
          sock.destroy();
          return reject(new Error('[tts][edge] Sec-WebSocket-Accept 校验失败'));
        }
        ready = true;
        sock.setTimeout(60000); // 合成阶段放宽空闲超时
        resolve({
          send: (text) => sendFrame(0x1, Buffer.from(text, 'utf8')),
          onMessage: (cb) => em.on('message', cb),
          onClose: (cb) => em.on('close', cb),
          onError: (cb) => em.on('error', cb),
          close: (code = 1000) => {
            if (sock.destroyed) return;
            const p = Buffer.alloc(2);
            p.writeUInt16BE(code, 0);
            sendFrame(0x8, p);
            setTimeout(() => sock.destroy(), 120);
          },
          destroy: () => sock.destroy(),
        });
        drainFrames();
        return;
      }
      drainFrames();
    });

    sock.on('error', (e) => {
      if (!ready) reject(new Error(`[tts][edge] TLS 连接失败: ${e.message}`));
      else em.emit('error', e);
    });
    sock.on('close', () => {
      if (!ready) reject(new Error('[tts][edge] 连接在握手前关闭'));
      else em.emit('close', 1006, '');
    });
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => {
      sock.destroy();
      if (!ready) reject(new Error('[tts][edge] TLS 握手超时'));
    });
  });
}

async function synthesizeEdge({ text, voice, rate, pitch }) {
  const pieces = chunkText(stripBom(text));
  if (!pieces.length) throw new Error('[tts][edge] 文本为空');

  const ws = await wsConnect(edgeWsUrl(), edgeWsHeaders());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    let timer = setTimeout(() => fail(new Error('[tts][edge] 连接超时（20s）')), CONNECT_TIMEOUT_MS);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('[tts][edge] 等待音频帧超时（15s）')), IDLE_TIMEOUT_MS);
    };
    function stop() {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      setTimeout(() => ws.destroy(), 200);
    }
    function fail(err) {
      if (done) return;
      done = true;
      stop();
      reject(err);
    }
    function succeed() {
      if (done) return;
      done = true;
      stop();
      const buf = Buffer.concat(chunks);
      if (!buf.length) return reject(new Error('[tts][edge] 未收到音频数据（0 字节）'));
      resolve(buf);
    }

    ws.onMessage(({ text: t, binary }) => {
      if (done) return;
      kick();
      if (t !== undefined) {
        if (t.includes('Path:turn.end')) succeed();
        return;
      }
      const { header, payload } = parseServerFrame(binary);
      if (/Path:\s*turn\.end/i.test(header)) {
        if (payload.length) chunks.push(payload);
        succeed();
      } else if (/Path:\s*audio/i.test(header) && payload.length) {
        chunks.push(payload);
      }
    });
    ws.onClose((code, reason) => {
      if (done) return;
      if (code === 1000 && chunks.length) return succeed();
      fail(new Error(`[tts][edge] 连接关闭 WS close code=${code}${reason ? ` reason=${reason}` : ''}`));
    });
    ws.onError((e) => fail(new Error(`[tts][edge] 传输错误: ${e?.message || e}`)));

    try {
      ws.send(textFrame('speech.config', 'application/json; charset=utf-8', buildConfig()));
      kick();
      for (const piece of pieces) {
        ws.send(textFrame('ssml', 'application/ssml+xml', buildSsml({ text: piece, voice, rate, pitch })));
      }
    } catch (e) {
      fail(new Error(`[tts][edge] 发送配置/SSML 失败: ${e?.message || e}`));
    }
  });
}


// ---------- FALLBACK 通道（仅在 edge 通道失败时启用；输出同样是 mp3） ----------
// 候选 1：百度 text2audio（实测可读整句）；候选 2：有道 dictvoice（仅短词可用，故放后面）
const FALLBACK_CHUNK = 90;

function splitForFallback(text, max = FALLBACK_CHUNK) {
  const clean = stripBom(text).replace(/[\r\n]+/g, ' ');
  const parts = clean.split(/(?<=[，。！？、；：,.!?;:…])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts.length ? parts : [clean]) {
    for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
  }
  return out.slice(0, 60);
}

async function fetchMp3(label, url) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://fanyi.baidu.com/' } });
  } catch (e) {
    throw new Error(`[tts][fallback:${label}] 请求异常: ${e?.message || e}`);
  }
  if (!res.ok) throw new Error(`[tts][fallback:${label}] HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 512 || !isMp3(buf)) {
    throw new Error(`[tts][fallback:${label}] 返回的不是有效 mp3（${buf.length} 字节）`);
  }
  return buf;
}

async function synthesizeBaidu({ text }) {
  const bufs = [];
  for (const seg of splitForFallback(text)) {
    bufs.push(await fetchMp3('baidu', `https://tts.baidu.com/text2audio?tex=${encodeURIComponent(seg)}&lan=zh&cuid=baike&ctp=1&pdt=301&vol=9&rate=32&per=0`));
  }
  return Buffer.concat(bufs);
}

async function synthesizeYoudao({ text }) {
  const bufs = [];
  for (const seg of splitForFallback(text, 30)) {
    bufs.push(await fetchMp3('youdao', `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(seg)}&le=zh`));
  }
  return Buffer.concat(bufs);
}

// ---------- 对外主函数 ----------
/**
 * 合成中文语音并写 mp3
 * @param {{text:string, voice?:string, rate?:string, pitch?:string, outPath:string, allowFallback?:boolean}} opts
 * @returns {Promise<{ok:true, bytes:number, engine:'edge'|'youdao-fallback', outPath:string}>}
 */
export async function synthesize({
  text,
  voice = 'zh-CN-XiaoxiaoNeural',
  rate = '+0%',
  pitch = '+0Hz',
  outPath,
  allowFallback = true,
} = {}) {
  if (!text || !String(text).trim()) throw new Error('[tts] text 不能为空');
  if (!outPath) throw new Error('[tts] outPath 不能为空');

  const errors = [];
  let buf = null;
  let engine = 'edge';

  try {
    buf = await synthesizeEdge({ text, voice, rate, pitch });
  } catch (e) {
    errors.push(e?.message || String(e));
    if (!allowFallback) throw e;
    // FALLBACK 链路：百度 → 有道
    for (const [name, fn] of [
      ['baidu-fallback', synthesizeBaidu],
      ['youdao-fallback', synthesizeYoudao],
    ]) {
      try {
        buf = await fn({ text });
        engine = name;
        break;
      } catch (e2) {
        errors.push(e2?.message || String(e2));
      }
    }
    if (!buf) {
      const err = new Error(`[tts] 全部通道失败:\n - ${errors.join('\n - ')}`);
      err.attempts = errors;
      throw err;
    }
  }

  if (!isMp3(buf)) {
    throw new Error(`[tts] 输出不是 mp3（首字节 ${buf.subarray(0, 4).toString('hex')}）`);
  }

  const abs = path.resolve(outPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, buf);
  return { ok: true, bytes: buf.length, engine, outPath: abs };
}

export default { synthesize, VOICES, secMsGecV2 };
