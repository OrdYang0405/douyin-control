"""
clone_tts.py — XTTS v2 声音克隆（CPU 推理）

用法:
  python clone_tts.py --text "要说的话" --ref 参考音频.wav --out 输出.wav [--lang zh-cn]

设计要点（都是踩坑换来的）:
  1. torch>=2.6 默认 weights_only=True，Coqui 的 checkpoint 含自定义类，
     必须先 add_safe_globals 放行，否则 UnpicklingError
  2. transformers 必须 <4.42，新版删了 BeamSearchScorer
  3. CPU 推理慢，模型只加载一次并常驻（--serve 模式走 stdio 反复合成）
"""
import argparse
import os
import sys
import time

os.environ.setdefault("COQUI_TOS_AGREED", "1")

import torch

from TTS.tts.configs.xtts_config import XttsConfig
from TTS.tts.models.xtts import XttsAudioConfig, XttsArgs
from TTS.config.shared_configs import BaseDatasetConfig

torch.serialization.add_safe_globals([XttsConfig, XttsAudioConfig, XttsArgs, BaseDatasetConfig])

_MODEL = None


def get_model():
    """模型只加载一次，复用"""
    global _MODEL
    if _MODEL is None:
        from TTS.api import TTS
        t = time.time()
        _MODEL = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        print(f"[clone] model loaded in {time.time()-t:.1f}s", file=sys.stderr, flush=True)
    return _MODEL


def synth(text, ref, out, lang="zh-cn", speed=1.0):
    api = get_model()
    t = time.time()
    api.tts_to_file(
        text=text,
        speaker_wav=ref,
        language=lang,
        file_path=out,
        speed=speed,
        split_sentences=True,
    )
    cost = time.time() - t
    size = os.path.getsize(out) if os.path.exists(out) else 0
    print(f"[clone] {len(text)}字 → {size/1024:.0f}KB in {cost:.1f}s", file=sys.stderr, flush=True)
    return cost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--lang", default="zh-cn")
    ap.add_argument("--speed", type=float, default=1.0)
    a = ap.parse_args()
    if not os.path.exists(a.ref):
        sys.exit(f"参考音频不存在: {a.ref}")
    synth(a.text, a.ref, a.out, a.lang, a.speed)
    print(a.out)


if __name__ == "__main__":
    main()
