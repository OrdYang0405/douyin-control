#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
recon.py — 目标系统前端指纹 / JS 资产 / 接口 / 加密特征测绘

用途：拿到文档里描述的系统域名后，第一步把它的前端资产全部摊开，
     为「签名还原」和「接口复刻」提供物料。

用法:
  python tools/recon.py TARGET_ORIGIN [--out captures/recon] [--threads 8]
  例: python tools/recon.py https://demo.example.com

产出:
  index.html            首页原始 HTML
  js/                   下载的前端 bundle（含 .map 若存在）
  endpoints.txt         从 JS 里抽出的接口路径 / 完整 URL
  crypto-hints.txt      签名/加密/时间戳相关代码片段（带上下文）
  sourcemaps.txt        sourceMappingURL 命中情况（有 map 等于源码级还原）
  report.md             测绘摘要
"""
import argparse
import json
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    import httpx
except ImportError:
    sys.exit("需要 httpx：python -m pip install httpx")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

SCRIPT_RE = re.compile(r'<script[^>]+src=["\']([^"\']+)["\']', re.I)
LINK_RE = re.compile(r'<link[^>]+href=["\']([^"\']+\.css[^"\']*)["\']', re.I)
INLINE_RE = re.compile(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', re.I | re.S)

ENDPOINT_PATTERNS = [
    re.compile(r'["\'`](/(?:api|gateway|open|v\d|service|inner|admin|backend)[A-Za-z0-9_\-/{}.$:]{2,120})["\'`]'),
    re.compile(r'["\'`](https?://[A-Za-z0-9._\-]+(?::\d+)?/[A-Za-z0-9_\-/{}.$:?=&]{2,140})["\'`]'),
    re.compile(r'url\s*:\s*["\'`]([^"\'`]{3,140})["\'`]'),
    re.compile(r'baseURL\s*:\s*["\'`]([^"\'`]{3,140})["\'`]'),
]

CRYPTO_KEYWORDS = [
    "sign", "signature", "md5", "sha1", "sha256", "hmac", "aes", "des", "rsa",
    "sm2", "sm3", "sm4", "cryptojs", "jsencrypt", "forge", "nonce", "timestamp",
    "x-timestamp", "x-sign", "x-nonce", "appid", "app_key", "appkey", "secret",
    "canvas", "fingerprint", "deviceid", "device_id", "mouse", "encrypt", "decrypt",
]
CRYPTO_LINE_RE = re.compile("|".join(re.escape(k) for k in CRYPTO_KEYWORDS), re.I)
SIGN_FN_RE = re.compile(
    r'(?:function\s+(\w*(?:sign|Sign|encrypt|Encrypt|token|Token)\w*)\s*\(|'
    r'(?:const|let|var)\s+(\w*(?:sign|Sign|encrypt|Encrypt)\w*)\s*=\s*(?:function|\())')

_lock = threading.Lock()
stats = {"ok": 0, "fail": 0}


def fetch(client: httpx.Client, url: str, limit: int = 12 * 1024 * 1024) -> tuple[int, str]:
    try:
        r = client.get(url, follow_redirects=True, timeout=25)
        body = r.text
        if len(body) > limit:
            body = body[:limit]
        return r.status_code, body
    except Exception as e:  # noqa: BLE001
        return 0, f"__ERR__ {type(e).__name__}: {e}"


def snippets(text: str, needle_re, ctx: int = 160, max_hits: int = 400):
    out = []
    for m in needle_re.finditer(text):
        s = max(0, m.start() - ctx)
        e = min(len(text), m.end() + ctx)
        frag = re.sub(r'\s+', ' ', text[s:e]).strip()
        out.append(f"@{m.start()}  ...{frag}...")
        if len(out) >= max_hits:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", help="目标 origin 或首页 URL")
    ap.add_argument("--out", default="captures/recon")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--max-js", type=int, default=80)
    args = ap.parse_args()

    origin = args.target if args.target.startswith("http") else "https://" + args.target
    out = Path(args.out)
    (out / "js").mkdir(parents=True, exist_ok=True)

    headers = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}
    with httpx.Client(headers=headers, verify=False) as client:
        status, html = fetch(client, origin)
        if status == 0:
            sys.exit(f"首页拉取失败: {html}")
        (out / "index.html").write_text(html, encoding="utf-8", errors="ignore")

        scripts = [urljoin(origin, s) for s in SCRIPT_RE.findall(html)]
        styles = [urljoin(origin, s) for s in LINK_RE.findall(html)]
        inline = INLINE_RE.findall(html)
        print(f"[i] 首页 {status}  外链脚本 {len(scripts)}  css {len(styles)}  内联脚本 {len(inline)}")

        # 内联脚本本身常常就带半套签名逻辑
        (out / "inline.js").write_text("\n\n".join(inline), encoding="utf-8", errors="ignore")

        # 二次抓取：入口 bundle 里 import 的 chunk 通常由 webpack runtime 拼出，
        # 这里把已知的 js 再扫一遍，找出同源 js 引用
        todo = list(dict.fromkeys(scripts))[: args.max_js]
        seen, bundles = set(), {}

        def work(u):
            if u in seen:
                return
            seen.add(u)
            st, body = fetch(client, u)
            with _lock:
                if st and not body.startswith("__ERR__"):
                    stats["ok"] += 1
                    bundles[u] = body
                    name = re.sub(r'[^A-Za-z0-9._-]', '_', urlparse(u).path)[-120:] or "bundle.js"
                    (out / "js" / name).write_text(body, encoding="utf-8", errors="ignore")
                else:
                    stats["fail"] += 1
                    bundles[u] = ""

        with ThreadPoolExecutor(max_workers=args.threads) as ex:
            list(ex.map(work, todo))

        # 递归一层：从已下载 bundle 里再找同源 js
        extra = set()
        for u, body in bundles.items():
            if not body:
                continue
            for m in re.finditer(r'["\'`]((?:\.{0,2}/)?[A-Za-z0-9_\-./]+\.js)["\'`]', body):
                cand = urljoin(u, m.group(1))
                if urlparse(cand).netloc == urlparse(origin).netloc and cand not in seen:
                    extra.add(cand)
        extra = list(extra)[:40]
        print(f"[i] 追加发现同源 js {len(extra)}")
        with ThreadPoolExecutor(max_workers=args.threads) as ex:
            list(ex.map(work, extra))

        # 汇总分析
        endpoints, crypto_hits, smaps, sign_fns = set(), [], [], set()
        for u, body in bundles.items():
            if not body:
                continue
            for pat in ENDPOINT_PATTERNS:
                for m in pat.finditer(body):
                    v = m.group(1)
                    if v.startswith("data:") or v.endswith(".js") or v.endswith(".css"):
                        continue
                    endpoints.add(v if v.startswith("http") else urljoin(origin, v))
            crypto_hits.extend(f"[{u}] {s}" for s in snippets(body, CRYPTO_LINE_RE, max_hits=60))
            for m in re.finditer(r'sourceMappingURL=([^\s*]+)', body):
                smaps.append(f"{u} -> {m.group(1)}")
            for m in SIGN_FN_RE.finditer(body):
                sign_fns.add(m.group(1) or m.group(2))

        (out / "endpoints.txt").write_text("\n".join(sorted(endpoints)), encoding="utf-8")
        (out / "crypto-hints.txt").write_text("\n".join(crypto_hits), encoding="utf-8")
        (out / "sourcemaps.txt").write_text("\n".join(smaps), encoding="utf-8")

        report = [
            "# 前端测绘报告",
            "",
            f"- 目标: {origin}",
            f"- 首页状态: {status}",
            f"- 外链脚本: {len(scripts)}，成功下载: {stats['ok']}，失败: {stats['fail']}",
            f"- 内联脚本片段: {len(inline)}",
            f"- 提取接口: {len(endpoints)}",
            f"- 加密/签名特征命中: {len(crypto_hits)}",
            f"- sourceMappingURL 命中: {len(smaps)}（命中即可源码级还原）",
            f"- 疑似签名函数名: {', '.join(sorted(sign_fns)[:40]) or '无'}",
            "",
            "## 接口（前 120）",
            *[f"- {e}" for e in sorted(endpoints)[:120]],
            "",
            "## 脚本清单",
            *[f"- {u}" for u in bundles],
            "",
            "## 下一步",
            "1. 有 sourcemap → 直接还原源码，定位 request 拦截器/签名函数",
            "2. 无 sourcemap → 用 tools/js_hook.js 在浏览器里 hook 出签名入参与结果",
            "3. 接口清单进 docs/02-接口台账.md，逐条补鉴权与签名参数",
        ]
        (out / "report.md").write_text("\n".join(report), encoding="utf-8")
        print("\n".join(report[:12]))
        print(f"\n[i] 输出: {out.resolve()}")

        # 顺带存一份元信息，便于横向对比
        (out / "meta.json").write_text(json.dumps({
            "origin": origin,
            "status": status,
            "scripts": scripts,
            "styles": styles,
            "endpoint_count": len(endpoints),
            "sourcemaps": smaps,
            "sign_fn_candidates": sorted(sign_fns),
        }, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
