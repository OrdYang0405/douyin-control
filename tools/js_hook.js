/**
 * js_hook.js — 浏览器内注入的抓签探针（DevTools Console / CDP Runtime.evaluate / 油猴均可）
 *
 * 目的：不脱壳、不读源码，直接把「请求签名」的输入、输出、时序打出来。
 * 用法：
 *   1) 打开目标系统登录页 → DevTools Console → 粘贴本文件 → 回车
 *   2) 正常操作页面，控制台会以 [HOOK] 前缀输出
 *   3) 复制输出 → 存到 captures/sign-trace.txt → 交给签名还原阶段
 *
 * 覆盖点：
 *   window.fetch / XMLHttpRequest / WebSocket / crypto.subtle / CryptoJS / JSEncrypt
 *   JSON.stringify（找签名前的 payload 快照）
 *   Function.prototype.toString 钩子（抓动态生成的签名函数体）
 */
(() => {
  if (window.__HOOK__) {
    console.warn('[HOOK] 已注入，跳过');
    return;
  }
  window.__HOOK__ = true;

  const LOG = [];
  const MAX = 500;
  const push = (tag, data) => {
    const rec = { t: new Date().toISOString(), tag, data };
    LOG.push(rec);
    if (LOG.length > MAX) LOG.shift();
    try {
      console.log('%c[HOOK] ' + tag, 'color:#0a0;font-weight:bold', data);
    } catch (e) {
      console.log('[HOOK] ' + tag, String(data));
    }
  };
  window.__HOOK_LOG__ = LOG;
  window.__HOOK_DUMP__ = () => JSON.parse(JSON.stringify(LOG));

  const clip = (v, n = 4000) => {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s && s.length > n ? s.slice(0, n) + '…(' + s.length + 'B)' : s;
    } catch (e) {
      return String(v);
    }
  };
  const interesting = (url) =>
    /api|gateway|live|room|order|goods|task|login|auth|token|sign|upload|ws/i.test(url || '');
  const redact = (hdrs) => {
    const out = {};
    for (const k of Object.keys(hdrs || {})) {
      const low = k.toLowerCase();
      out[k] = /cookie|authorization|token|secret|session/.test(low)
        ? '<redacted len=' + String(hdrs[k]).length + '>'
        : hdrs[k];
    }
    return out;
  };

  /* ---------------- fetch ---------------- */
  const rawFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === 'string' ? input : input && input.url;
    const t0 = performance.now();
    let res;
    try {
      res = await rawFetch.apply(this, arguments);
    } catch (e) {
      push('fetch:error', { url, error: String(e) });
      throw e;
    }
    if (interesting(url)) {
      let body = null;
      try {
        body = await res.clone().text();
      } catch (e) {}
      push('fetch', {
        url,
        method: (init && init.method) || (input && input.method) || 'GET',
        reqHeaders: redact((init && init.headers) || {}),
        reqBody: clip(init && init.body),
        status: res.status,
        respBody: clip(body, 2000),
        ms: Math.round(performance.now() - t0),
      });
    }
    return res;
  };

  /* ---------------- XHR ---------------- */
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__h = { method: m, url: u, headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__h) this.__h.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__h && interesting(this.__h.url)) {
      const t0 = performance.now();
      this.addEventListener('loadend', () => {
        push('xhr', {
          url: this.__h.url,
          method: this.__h.method,
          reqHeaders: redact(this.__h.headers),
          reqBody: clip(body),
          status: this.status,
          respBody: clip(this.responseText, 2000),
          ms: Math.round(performance.now() - t0),
        });
      });
    }
    return XS.apply(this, arguments);
  };

  /* ---------------- WebSocket ---------------- */
  const RawWS = window.WebSocket;
  function HookWS(url, protocols) {
    const inst = new RawWS(url, protocols);
    push('ws:open', { url: String(url), protocols });
    inst.addEventListener('message', (ev) => {
      const d = typeof ev.data === 'string' ? ev.data : '[binary]';
      push('ws:recv', { url: String(url), data: clip(d, 1500) });
    });
    const rawSend = inst.send.bind(inst);
    inst.send = function (data) {
      push('ws:send', { url: String(url), data: clip(typeof data === 'string' ? data : '[binary]', 1500) });
      return rawSend(data);
    };
    return inst;
  }
  HookWS.prototype = RawWS.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => (HookWS[k] = RawWS[k]));
  window.WebSocket = HookWS;

  /* ---------------- crypto ---------------- */
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    const d = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async function (alg, data) {
      const out = await d(alg, data);
      const hex = Array.from(new Uint8Array(out)).map((b) => b.toString(16).padStart(2, '0')).join('');
      push('subtle.digest', { alg: String(alg).slice(0, 40), input: clip(data), hex });
      return out;
    };
    for (const fn of ['sign', 'encrypt', 'decrypt', 'importKey', 'deriveBits']) {
      if (typeof crypto.subtle[fn] !== 'function') continue;
      const orig = crypto.subtle[fn].bind(crypto.subtle);
      crypto.subtle[fn] = async function (...a) {
        const out = await orig(...a);
        push('subtle.' + fn, { alg: String(a[0]).slice(0, 60), arg1: clip(a[1], 300), arg2: clip(a[2], 300) });
        return out;
      };
    }
  }

  /* ---------------- CryptoJS ---------------- */
  const hookCryptoJS = () => {
    const CJ = window.CryptoJS;
    if (!CJ || CJ.__hooked) return;
    CJ.__hooked = true;
    for (const alg of ['MD5', 'SHA1', 'SHA256', 'SHA512', 'HmacMD5', 'HmacSHA256']) {
      if (typeof CJ[alg] !== 'function') continue;
      const orig = CJ[alg];
      CJ[alg] = function (...a) {
        const out = orig.apply(this, a);
        push('CryptoJS.' + alg, { input: clip(a[0]), key: clip(a[1], 200), out: out && out.toString() });
        return out;
      };
    }
    for (const alg of ['AES', 'DES', 'TripleDES']) {
      if (!CJ[alg]) continue;
      for (const mode of ['encrypt', 'decrypt']) {
        if (typeof CJ[alg][mode] !== 'function') continue;
        const orig = CJ[alg][mode];
        CJ[alg][mode] = function (...a) {
          const out = orig.apply(this, a);
          push('CryptoJS.' + alg + '.' + mode, { input: clip(a[0]), out: out && out.toString && out.toString() });
          return out;
        };
      }
    }
    push('hook:ready', { lib: 'CryptoJS', version: CJ.lib && CJ.lib.WordArray ? 'present' : 'unknown' });
  };
  hookCryptoJS();
  setTimeout(hookCryptoJS, 2000);
  setTimeout(hookCryptoJS, 6000);

  /* ---------------- JSEncrypt / forge ---------------- */
  const hookRSA = () => {
    const JE = window.JSEncrypt;
    if (JE && JE.prototype && !JE.prototype.__hooked) {
      JE.prototype.__hooked = true;
      const enc = JE.prototype.encrypt;
      JE.prototype.encrypt = function (s) {
        const out = enc.apply(this, arguments);
        push('JSEncrypt.encrypt', { plain: clip(s), cipher: clip(out) });
        return out;
      };
    }
    const forge = window.forge;
    if (forge && forge.pki && !forge.__hooked) {
      forge.__hooked = true;
      push('hook:ready', { lib: 'forge' });
    }
  };
  hookRSA();
  setTimeout(hookRSA, 3000);

  /* ---------------- 动态函数体 ---------------- */
  const FTS = Function.prototype.toString;
  Function.prototype.toString = function () {
    const src = FTS.call(this);
    if (src && src.length > 60 && /sign|encrypt|nonce|timestamp|hmac|md5/i.test(src) && src.length < 20000) {
      push('fn:source', { name: this.name || '(anon)', src: clip(src, 8000) });
    }
    return src;
  };

  /* ---------------- 常用全局探测 ---------------- */
  const probe = () => {
    const names = Object.keys(window).filter((k) =>
      /sign|encrypt|token|auth|api|request|axios|http/i.test(k)
    );
    push('globals', { names: names.slice(0, 120) });
    if (window.axios && window.axios.interceptors) push('axios', { present: true });
  };
  probe();
  setTimeout(probe, 3000);

  push('hook:ready', { version: '1.0', note: '操作页面后执行 __HOOK_DUMP__() 取全部记录' });
  console.log(
    '%c[HOOK] 已注入。操作页面后执行 __HOOK_DUMP__() 复制全部记录；或 console.save(__HOOK_DUMP__())',
    'color:#0a0;font-weight:bold'
  );
})();
