// server/ws-client.mjs —— 零依赖 WebSocket 客户端（node:tls / node:crypto / node:net）
// 为什么不用内置 WebSocket(undici)：它不允许改 UA / Origin，抖音直播 wss 握手会失败，
// 且失败时拿不到真实 HTTP 状态码。本模块照抄 tts.mjs 里实测可用的最小实现并做通用化。
//
// 用法：
//   const ws = connectWS(url, { headers: { 'User-Agent': ..., Origin: ... } });
//   ws.onOpen(() => ws.send('hi'));
//   ws.onMessage(({ data, isBinary }) => ...);
//   await ws.opened; // 需要同步等待握手时用；失败会 reject(e.httpStatus)
import crypto from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 由本模块自己生成、不允许被 headers 覆盖的握手头（重复发送会被服务端判 400）
const OWNED_HEADERS = new Set([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'content-length',
  'transfer-encoding',
]);

/** 解析 URL，校验协议 */
function parseTarget(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new WebSocketHandshakeError(`WebSocket 地址非法: ${rawUrl}`, { httpStatus: 0, reason: '地址非法' });
  }
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  if (!secure && u.protocol !== 'ws:' && u.protocol !== 'http:') {
    throw new WebSocketHandshakeError(`不支持的协议: ${u.protocol}`, { httpStatus: 0, reason: '协议不支持' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (secure ? 443 : 80);
  return {
    secure,
    host,
    port,
    // Host 头需保留非默认端口
    hostHeader: u.port ? `${host}:${u.port}` : host,
    path: (u.pathname || '/') + u.search,
  };
}

/** 握手失败错误：带 httpStatus 与响应头/响应体片段，便于排查 400/403 */
export class WebSocketHandshakeError extends Error {
  constructor(message, { httpStatus = 0, rawHeaders = '', headers = {}, body = '' } = {}) {
    super(message);
    this.name = 'WebSocketHandshakeError';
    this.httpStatus = httpStatus;
    this.rawHeaders = rawHeaders; // 原始状态行 + 响应头文本
    this.headers = headers; // 小写键的响应头对象
    this.body = body; // 非 101 响应体片段（最多 2KB）
    this.status = httpStatus; // 兼容 res.status 风格
  }
}

/**
 * 建立 WebSocket 连接
 * @param {string} url ws:// 或 wss:// 地址
 * @param {{headers?:Record<string,string>, timeoutMs?:number, binaryType?:'buffer'|'arraybuffer'|'nodebuffer'}} opts
 */
export function connectWS(url, { headers = {}, timeoutMs = 15000, binaryType = 'buffer' } = {}) {
  const t = parseTarget(url);
  const key = crypto.randomBytes(16).toString('base64');
  const wantArrayBuffer = binaryType === 'arraybuffer';

  // 回调队列（用户可能在连接建立后才注册，故先注册的也存起来）
  const listeners = { open: [], message: [], close: [], error: [] };
  const pending = { open: null, message: [], close: null, error: null };
  const fire = (type, arg) => {
    const list = listeners[type];
    if (list.length) for (const cb of list.slice()) safeCall(cb, arg);
    else if (type !== 'open' && type !== 'message') pending[type] = arg;
    else if (type === 'message') pending.message.push(arg);
  };

  let readyState = 'connecting';
  let settled = false; // 握手是否已成功（决定 resolve/reject）
  let destroyed = false;
  let closeEmitted = false;
  let closeCode = null; // 已发出/已收到的关闭码，避免重复触发 onClose
  let recvBuf = Buffer.alloc(0);
  let fragments = [];
  let fragOpcode = 0;
  let fragBytes = 0;

  // 底层 socket：wss 走 tls，ws 走 tcp
  const sock = t.secure
    ? tls.connect({ host: t.host, port: t.port, servername: t.host, ALPNProtocols: ['http/1.1'] })
    : net.connect({ host: t.host, port: t.port });

  let resolveOpen, rejectOpen;
  const opened = new Promise((res, rej) => {
    resolveOpen = res;
    rejectOpen = rej;
  });
  // 未 await 时避免 unhandledRejection
  opened.catch(() => {});

  const api = {
    get readyState() {
      return readyState;
    },
    get binaryType() {
      return binaryType;
    },
    opened,
    send,
    close,
    onOpen: (cb) => (listeners.open.push(cb), flush('open')),
    onMessage: (cb) => (listeners.message.push(cb), flush('message')),
    onClose: (cb) => (listeners.close.push(cb), flush('close')),
    onError: (cb) => (listeners.error.push(cb), flush('error')),
    /** 直接断开（不发 close 帧），不触发用户的 onError */
    destroy: () => hardDestroy(),
  };

  function flush(type) {
    if (type === 'open' && (readyState === 'open')) listeners.open.forEach((cb) => safeCall(cb, undefined));
    if (type === 'message') {
      const q = pending.message;
      pending.message = [];
      q.forEach((m) => listeners.message.forEach((cb) => safeCall(cb, m)));
    }
    if (pending[type] && (type === 'close' || type === 'error')) {
      const v = pending[type];
      pending[type] = null;
      listeners[type].forEach((cb) => safeCall(cb, v));
    }
  }

  // ---------- 发送 ----------
  /** 发送字符串（文本帧）或 Buffer/TypedArray/ArrayBuffer（二进制帧） */
  function send(data) {
    if (readyState !== 'open') throw new Error(`WebSocket 未就绪（readyState=${readyState}）`);
    if (typeof data === 'string') return writeFrame(0x1, Buffer.from(data, 'utf8'));
    const buf = toBuffer(data);
    return writeFrame(0x2, buf);
  }

  function writeFrame(opcode, payload) {
    if (sock.destroyed) return false;
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
    // 客户端帧必须掩码
    const mask = crypto.randomBytes(4);
    const body = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
    return sock.write(Buffer.concat([head, mask, body]));
  }

  // ---------- 接收 ----------
  function drainFrames() {
    for (;;) {
      if (recvBuf.length < 2) return;
      const b0 = recvBuf[0];
      const b1 = recvBuf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (recvBuf.length < 4) return;
        len = recvBuf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (recvBuf.length < 10) return;
        const big = recvBuf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail(new Error('WebSocket 帧长度超出可处理范围'));
          return;
        }
        len = Number(big);
        off = 10;
      }
      let maskKey = null;
      if (masked) {
        if (recvBuf.length < off + 4) return;
        maskKey = recvBuf.subarray(off, off + 4);
        off += 4;
      }
      // 数据未到齐就返回，保留缓冲等下一个 chunk（大帧就在这里分段到达）
      if (recvBuf.length < off + len) return;
      // 拷贝一份，切片后原缓冲可能被回收
      const payload = Buffer.allocUnsafe(len);
      recvBuf.copy(payload, 0, off, off + len);
      if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
      recvBuf = recvBuf.subarray(off + len);

      if (opcode === 0x8) {
        // close：回应 close 帧后收尾
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        closeCode = code;
        if (readyState === 'open' || readyState === 'connecting') writeFrame(0x8, payload.subarray(0, 2));
        readyState = 'closing';
        sock.end();
        emitClose(code, reason);
        // 服务端可能不再回数据，兜底销毁
        setTimeout(() => hardDestroy(), 300).unref?.();
        return;
      }
      if (opcode === 0x9) {
        // ping → 自动 pong，pong 不足 125 字节按标准截断
        writeFrame(0xa, payload.length > 125 ? payload.subarray(0, 125) : payload);
        continue;
      }
      if (opcode === 0xa) continue; // pong 忽略
      if (opcode === 0x0) {
        // 续帧
        if (!fragOpcode) continue; // 无起始帧的孤儿续帧，忽略
        fragments.push(payload);
        fragBytes += payload.length;
        if (fin) {
          const whole = Buffer.concat(fragments, fragBytes);
          const op = fragOpcode;
          fragments = [];
          fragBytes = 0;
          fragOpcode = 0;
          emitMessage(op, whole);
        }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          emitMessage(opcode, payload);
        } else {
          fragOpcode = opcode;
          fragments = [payload];
          fragBytes = payload.length;
        }
      }
      // 其他 opcode 忽略
    }
  }

  function emitMessage(opcode, payload) {
    if (opcode === 0x1) {
      fire('message', { data: payload.toString('utf8'), isBinary: false });
    } else {
      const data = wantArrayBuffer
        ? payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength)
        : payload;
      fire('message', { data, isBinary: true });
    }
  }

  // ---------- 握手 ----------
  const handshakeLines = [
    `GET ${t.path} HTTP/1.1`,
    `Host: ${t.hostHeader}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null || v === '') continue;
    // 这些头由本模块生成；重复发送会被服务端判 400
    if (OWNED_HEADERS.has(k.toLowerCase())) continue;
    handshakeLines.push(`${k}: ${v}`);
  }
  const handshake = handshakeLines.join('\r\n') + '\r\n\r\n';

  const timer = setTimeout(() => {
    fail(
      new WebSocketHandshakeError(`WebSocket 握手超时（${timeoutMs}ms，${t.host}${t.path}）`, {
        httpStatus: 0,
        reason: '握手超时',
      })
    );
  }, timeoutMs);
  timer.unref?.();

  function onConnected() {
    sock.setNoDelay?.(true);
    sock.write(handshake);
  }
  if (t.secure) sock.once('secureConnect', onConnected);
  else sock.once('connect', onConnected);

  sock.on('data', (chunk) => {
    recvBuf = recvBuf.length ? Buffer.concat([recvBuf, chunk]) : chunk;
    if (readyState === 'connecting') {
      const idx = recvBuf.indexOf('\r\n\r\n');
      if (idx < 0) {
        // 防止畸形响应撑爆内存
        if (recvBuf.length > 65536) fail(new WebSocketHandshakeError('握手响应头过长', { httpStatus: 0, reason: '响应头超长' }));
        return;
      }
      const headText = recvBuf.subarray(0, idx).toString('latin1');
      recvBuf = recvBuf.subarray(idx + 4);
      const status = Number((headText.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/) || [])[1] || 0);
      const respHeaders = {};
      for (const line of headText.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) respHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }

      if (status !== 101) {
        // 非 101：把状态码和响应头交给调用方，便于排查 400/403
        const bodySnip = recvBuf.subarray(0, 2048).toString('utf8');
        const err = new WebSocketHandshakeError(
          `WebSocket 握手失败：HTTP ${status}${status ? '' : '（无响应状态行）'}` +
            `（${t.host}${t.path}）`,
          { httpStatus: status, rawHeaders: headText, headers: respHeaders, body: bodySnip }
        );
        hardDestroy();
        return fail(err);
      }

      // 校验 Sec-WebSocket-Accept
      const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (respHeaders['sec-websocket-accept'] && respHeaders['sec-websocket-accept'] !== expect) {
        hardDestroy();
        return fail(
          new WebSocketHandshakeError('Sec-WebSocket-Accept 校验失败（收到与期望不一致）', {
            httpStatus: 101,
            rawHeaders: headText,
            headers: respHeaders,
            reason: 'accept 不匹配',
          })
        );
      }

      clearTimeout(timer);
      settled = true;
      readyState = 'open';
      resolveOpen({
        httpStatus: 101,
        headers: respHeaders,
        rawHeaders: headText,
      });
      listeners.open.forEach((cb) => safeCall(cb, undefined));
      drainFrames();
      return;
    }
    drainFrames();
  });

  sock.on('error', (e) => {
    if (!settled) {
      const err = new WebSocketHandshakeError(`WebSocket 连接失败：${e.code || ''} ${e.message}`.trim(), {
        httpStatus: 0,
        reason: e.code || '连接错误',
      });
      err.code = e.code;
      hardDestroy();
      return fail(err);
    }
    // 已建立后出错：交给用户的 onError，并最终触发 onClose
    fire('error', e);
    emitClose(closeCode ?? 1006, '');
  });

  sock.on('close', () => {
    destroyed = true;
    // 握手阶段断开 → 视为失败
    if (!settled) {
      return fail(
        new WebSocketHandshakeError(`连接在握手完成前被关闭（${t.host}${t.path}）`, {
          httpStatus: 0,
          reason: '握手前断开',
        })
      );
    }
    emitClose(closeCode ?? 1006, '');
  });

  function emitClose(code, reason) {
    if (closeEmitted) return;
    closeEmitted = true;
    if (readyState === 'open') readyState = 'closing';
    readyState = 'closed';
    fire('close', { code, reason: reason || '', wasClean: code !== 1006 });
  }

  function fail(err) {
    if (settled || closeEmitted) {
      // 已经 open 过，出错走 error 事件
      if (settled) fire('error', err);
      return;
    }
    clearTimeout(timer);
    closeEmitted = true;
    readyState = 'closed';
    settled = true;
    rejectOpen(err);
    // 有 onError 回调就回调，没有则保留在 pending，注册时补发
    fire('error', err);
    fire('close', { code: 1006, reason: err.message, wasClean: false });
  }

  function hardDestroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      sock.destroy();
    } catch {}
  }

  // ---------- 关闭 ----------
  /** 主动关闭：发 close 帧，等对端回应或 1s 后强制断开 */
  function close(code = 1000, reason = '') {
    if (readyState === 'closed' || readyState === 'closing') return;
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const p = Buffer.alloc(2 + reasonBuf.length);
    p.writeUInt16BE(code & 0xffff, 0);
    reasonBuf.copy(p, 2);
    closeCode = code;
    readyState = 'closing';
    writeFrame(0x8, p);
    setTimeout(() => {
      hardDestroy();
      emitClose(code, '');
    }, 1000).unref?.();
  }

  return api;
}

/** 把各种二进制输入统一成 Buffer */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('send() 只支持 string / Buffer / TypedArray / ArrayBuffer');
}

/** 回调异常不打断帧解析 */
function safeCall(cb, arg) {
  try {
    cb(arg);
  } catch (e) {
    // 用户回调抛错不应中断连接
    queueMicrotask(() => {
      throw e;
    });
  }
}

export default connectWS;
