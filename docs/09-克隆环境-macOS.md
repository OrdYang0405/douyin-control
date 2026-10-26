# 声音克隆环境落地 · macOS arm64

> 本文记录在本机（macOS 27.2 / Apple Silicon）把 XTTS v2 克隆环境装通的完整过程。
> 与 [07-声音克隆落地.md](07-声音克隆落地.md)（Windows + CPU）互补，**版本结论不同，以本文为准**。

---

## 0. 结论

| 项 | 结果 |
|---|---|
| 状态 | ✅ 装通，已接入 Web 控制台（音色 `clone:ref1`） |
| 推理设备 | CPU（MPS 未启用） |
| 模型加载 | 19.0 秒（一次性，常驻） |
| 单句合成 | 4.0~6.6 秒（RTF **0.82**，比文档记录的 2.1 快约 2.6 倍） |
| 缓存命中 | **0 ms**（同文本同音色直接返回磁盘文件） |
| 显存/内存占用 | venv 1.6 GB + 模型 1.8 GB |

> 文档 07 的 RTF 2.1 是 Windows + Ryzen 7800X3D；本机 Apple Silicon 单核更强，实际 **RTF < 1（合成比播放快）**，
> 这意味着克隆音色**可以做到实时不排队**，A+C 混合方案里的"慢轨"在本机不再是慢轨。

---

## 1. 版本组合（关键，和文档 07 不同）

文档 07 要求 `torch==2.4.1`。在本机**不要照抄**，原因：

- torchaudio **≥ 2.9** 的 `torchaudio.load()` 强制依赖 `torchcodec`，而 torchcodec 与本项目不兼容
- torch 2.4.1 的 macOS arm64 wheel 可用，但会连带把整套依赖降得过旧

**本机验证可用的组合：**

```
torch        2.8.0      ← 最后一个「torchaudio.load 仍走 soundfile」的版本线
torchaudio   2.8.0
transformers 4.41.2     ← 必须 <4.42（新版删了 BeamSearchScorer）
tts          0.22.0     ← Coqui TTS
```

完整锁定见 `tools/gpt-sovits/requirements-macos-arm64.lock`（148 个包）。

### 复现命令

```bash
# 1) 建 venv（必须 3.11，3.12+ 部分依赖无 wheel）
uv venv tools/gpt-sovits/.venv --python 3.11

# 2) 装依赖（注意顺序：先 torch 2.8，TTS 会沿用该版本）
uv pip install --python tools/gpt-sovits/.venv/bin/python "torch==2.8.0" "torchaudio==2.8.0"
uv pip install --python tools/gpt-sovits/.venv/bin/python "TTS" "transformers>=4.33,<4.42"

# 3) 验证：不要装 torchcodec
tools/gpt-sovits/.venv/bin/python -c "import torchcodec"   # 应当 ImportError
```

---

## 2. 踩坑记录（本机实际遇到）

| # | 现象 | 原因 | 解法 |
|---|---|---|---|
| 1 | `UnpicklingError: Weights only load failed`，报 `Unsupported global: TTS.tts.configs.xtts_config.XttsConfig` | torch≥2.6 默认 `weights_only=True`；且 `add_safe_globals` **必须在 `from TTS.api import TTS` 之前**执行 | 直接用项目自带的 `xtts_server.py` / `clone_tts.py`，它们顺序是对的。自己写测试脚本时容易踩 |
| 2 | `ImportError: TorchCodec is required for load_with_torchcodec` | torchaudio 2.11 的 `load()` 已改为 torchcodec 后端 | 降到 torchaudio **2.8.0**；**不要**装 torchcodec |
| 3 | 模型下载只拿到 `model.pth` 等 4 个文件，没有 `dvae.pth` / `mel_stats.pth` | Coqui 主清单 `.models.json` 里本就没有这两个，首次**推理时**才拉 | 无需处理，跑一次推理即自动补齐 |
| 4 | 克隆音色不出现在控制台 | 服务进程在改代码前启动，`cloneAvailable()` 在启动时就已求值 | 改完代码必须重启 node 服务 |

> 坑 1 和坑 2 与文档 07 记录一致，说明这两个坑**跨平台复现**，是 XTTS + 新 torch 的通用问题。

---

## 3. 为 macOS 改的代码

`server/tts-clone.mjs` 原有两处 Windows 硬编码，已改为跨平台：

```js
// 原：const PY = path.join(ROOT, 'tools', 'gpt-sovits', '.venv', 'Scripts', 'python.exe');
const PY = process.platform === 'win32'
  ? path.join(ROOT, 'tools', 'gpt-sovits', '.venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'tools', 'gpt-sovits', '.venv', 'bin', 'python');

// 原：const REF_DIR_ASCII = 'D:\\tts-refs';
const REF_DIR_ASCII = process.platform === 'win32' ? 'D:\\tts-refs' : '/tmp/tts-refs';
```

其余逻辑（常驻进程、stdio 单行 JSON、自动重启）无需改动，跨平台可用。

---

## 4. 参考音频

位置：`tools/gpt-sovits/refs/ref1.wav`（6~15 秒、单声道、22.05 kHz）

本机样本由 macOS `say` 生成，**仅用于验证链路可用**，不是真人音色：

```bash
say -v Tingting -o /tmp/ref.aiff "大家好，欢迎来到我们的直播间……"
ffmpeg -y -i /tmp/ref.aiff -ar 22050 -ac 1 tools/gpt-sovits/refs/ref1.wav
```

要克隆真人音色：换成 6~15 秒清晰人声即可（任意 mp3 → ffmpeg 转 wav）。
多个音色放多个 wav，控制台会全部列出（`clone:ref1`、`clone:ref2`…）。

---

## 5. 实测数据（本机）

| 场景 | 耗时 | 输出 |
|---|---|---|
| 模型首次加载 | 19.0 s | 仅一次 |
| 短句 15 字 → 4.0 s 音频 | 4.05 s | RTF 1.01 |
| 长句 20 字 → 5.9 s 音频 | 6.64 s | **RTF 0.89** |
| 长句 21 字 → 5.2 s 音频 | 4.63 s | **RTF 0.82** |
| 通过 Web API 首次调用（含加载） | 26.2 s | — |
| 通过 Web API 常驻调用 | 2.63 s | — |
| 同文本重复请求（缓存） | **0.00 s** | 直接返回磁盘文件 |

**RTF < 1 的意义**：克隆合成速度超过音频播放速度，理论上可以连续生成不积压。
文档 08 的 A+C 混合方案（Edge 快轨 + 克隆慢轨）在本机仍有价值（因为单句仍有 2~7 秒延迟），
但不再需要"生成完观众已错过"这种补救设计。

---

## 6. 使用

```bash
# 起服务
node server/index.mjs

# 浏览器 http://127.0.0.1:8080  →  admin / admin123
# 音色下拉里选「ref1 · 本地克隆」，输入文本点「试听」
```

首次选克隆音色点试听会等约 20 秒（模型加载），之后每句 2~7 秒。
点「预热克隆」可把常用话术提前合成，直播时命中即 **0 ms**。

---

## 7. 未做的事

- **未启用 MPS / GPU 加速**。理论上 Apple Silicon 可走 MPS，但 XTTS 与 MPS 算子兼容性需逐个验证（文档 07 记录 Windows 上 DirectML 失败），当前 CPU 已满足 RTF<1，暂不折腾。
- **未做真人音色克隆**。refs 里是 `say` 生成的合成音，仅供链路验证。
- 未验证长时间直播稳定性（内存是否随句数增长）。
