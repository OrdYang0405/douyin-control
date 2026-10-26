"""
xtts_server.py — XTTS v2 常驻推理服务（stdio 长连接）

为什么要常驻：模型加载要 13 秒。如果每句都重载，直播根本没法用。
真正的设计：
  - 模型只加载一次
  - 通过 stdin 逐行收 JSON 任务，stdout 逐行回 JSON 结果
  - 后台可以预生成多条，前端按队列播放

协议（每行一个 JSON）：
  请求: {"id":"1","text":"要播的话","ref":"参考音频路径","out":"输出.wav","speed":1.0}
  响应: {"id":"1","ok":true,"path":"...","bytes":123,"cost":3.2,"audioSec":2.1}
  失败: {"id":"1","ok":false,"error":"..."}
  就绪: {"ready":true}
"""
import json
import os
import sys
import time
import traceback

os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("OMP_NUM_THREADS", str(os.cpu_count() or 8))

import torch

from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
from TTS.config.shared_configs import BaseDatasetConfig

# torch>=2.6 默认 weights_only=True，Coqui checkpoint 含自定义类，必须放行
torch.serialization.add_safe_globals([XttsConfig, XttsAudioConfig, XttsArgs, BaseDatasetConfig])
torch.set_num_threads(os.cpu_count() or 8)

_api = None


def api():
    global _api
    if _api is None:
        t = time.time()
        from TTS.api import TTS
        _api = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        print(json.dumps({"log": f"model loaded in {time.time()-t:.1f}s"}), flush=True)
    return _api


def audio_seconds(path):
    try:
        import wave
        with wave.open(path) as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except Exception:
        return None


def handle(req):
    text = (req.get("text") or "").strip()
    ref = req.get("ref") or ""
    out = req.get("out") or ""
    if not text:
        raise ValueError("text 为空")
    if not ref or not os.path.exists(ref):
        raise ValueError(f"参考音频不存在: {ref}")
    if not out:
        raise ValueError("out 为空")

    a = api()
    t = time.time()
    a.tts_to_file(
        text=text,
        speaker_wav=ref,
        language=req.get("lang", "zh-cn"),
        file_path=out,
        speed=float(req.get("speed", 1.0)),
        split_sentences=True,
    )
    cost = time.time() - t
    size = os.path.getsize(out)
    return {
        "path": out,
        "bytes": size,
        "cost": round(cost, 2),
        "audioSec": audio_seconds(out),
    }


def main():
    # Windows 下 stdio 默认按本地代码页解码，中文路径会变乱码 → 强制 UTF-8
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    # 启动即加载，让第一条请求就不用等
    api()
    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if req.get("cmd") == "ping":
                print(json.dumps({"id": rid, "ok": True, "pong": True}), flush=True)
                continue
            res = handle(req)
            res.update({"id": rid, "ok": True})
            print(json.dumps(res, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({
                "id": rid,
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc()[-600:],
            }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
