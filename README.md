# 逆向直播后台助手

**目标**：飞书知识库 `Dhb0wn12XiGY6ekMqzTckYsRnPh` 指向的软件系统 —— 已逆向完成，**并已复刻出一套能跑的本地版本**。

- 逆向结论：[docs/03-逆向结论.md](docs/03-逆向结论.md)
- 零账号摸底：[docs/04-未注册摸底.md](docs/04-未注册摸底.md)
- **复刻方案与上手指南：[docs/05-复刻方案.md](docs/05-复刻方案.md)**
- REA 工具辅助逆向记录：[docs/06-REA辅助逆向.md](docs/06-REA辅助逆向.md)
- 声音克隆落地：[docs/07-声音克隆落地.md](docs/07-声音克隆落地.md)
- **克隆方案交付（A+C 混合）：[docs/08-克隆方案交付.md](docs/08-克隆方案交付.md)**

> ⚠️ **关于凭据**：本仓库不包含任何第三方服务的 API Key / Secret。
> 需要凭据的功能（抖音弹幕签名、自定义 TTS）通过环境变量注入，见下文「环境变量」。

## 先跑起来（3 步）

```powershell
pwsh -File start.ps1 -Client        # 起服务 + 拉起改好的采集端
# 浏览器 http://127.0.0.1:8080  → admin / admin123 → 新增直播位 → 复制 live_id
# 客户端填「直播间地址」+ 该 live_id → 开始监听
```

弹幕会实时进控制台，命中关键词自动合成语音并在浏览器播放（配 VB-Cable 即可进直播伴侣）。抖音也可以不装客户端，直接在控制台填直播间地址走「直连」。

## 环境变量

| 变量 | 用途 | 是否必需 |
|---|---|---|
| `AIOBS_API_KEY` | 抖音弹幕 WSS 签名服务密钥 | 用抖音直连时必需 |
| `UNICLOUD_SPACE_ID` / `UNICLOUD_CLIENT_SECRET` | uniCloud 空间探测（仅调试工具用） | 否 |
| `PORT` | 服务端口，默认 8080 | 否 |

```powershell
$env:AIOBS_API_KEY = 'apikey-dy-xxxx'
```

## 声音克隆（可选）

需要本地跑 XTTS v2（CPU 推理，RTF≈2.1）：

```powershell
# 1) 准备 6~15 秒清晰人声（必须 wav，放 ASCII 路径）
ffmpeg -i 你的录音.mp3 -ar 22050 -ac 1 D:\tts-refs\ref1.wav

# 2) 建环境（torch 必须是 2.4.x，transformers <4.42）
uv venv tools\gpt-sovits\.venv --python 3.11
uv pip install --python tools\gpt-sovits\.venv\Scripts\python.exe `
  "torch==2.4.1" "torchaudio==2.4.1" --index-url https://download.pytorch.org/whl/cpu
uv pip install --python tools\gpt-sovits\.venv\Scripts\python.exe "TTS" "transformers>=4.33,<4.42"
```

模型首次运行会自动下载（约 2GB）。详细踩坑记录见 [docs/07](docs/07-声音克隆落地.md)。

**A+C 混合策略**：克隆慢（10 秒/句），所以先用 Edge 即时出声，克隆后台生成后推送播放；预热过的句子 **19ms** 返回。

**两条路都实测通了**：

| 路径 | 验证结果 |
|---|---|
| 抖音直连（不装客户端） | 20 秒入库 141 条、18 秒 129 条，发言/进入/关注/点赞/在线人数全覆盖 |
| 重打包客户端 | GUI 正常启动；回调已指向本地 |
| 语音 | edge 云端 24KB mp3/1.3s；sapi 本机 254KB wav/0.58s；自定义/克隆走 OpenAI 兼容接口 |
| 全链路 | 25 秒 → 172 条弹幕 → 自动生成 44 个语音文件，零错误 |
| **双人对播** | 主播/助播按占比交替；0~100% 共 21 档全部命中（误差 ≤3%） |

## 系统是什么

「星辰语音」（河北凯树科技有限公司 / `xcai1618.com` / `xc58.icu`）：一套 AI 语音助播系统，四件套闭环。

| 组件 | 形态 | 逆向要点 |
|---|---|---|
| Web 控制台 | uni-app(Vue3+Vite) + uniCloud 阿里云 | 登录发 token、建"直播位"、卡密计费、浏览器内播语音 |
| PHP API | `live.xc58.icu`，`api/v1.<controller>/<action>` | 12 个已确认接口，`Authorization` 头鉴权 |
| 弹幕采集端 | Electron（NSIS 安装包 → `app-64.7z` → `app.asar`） | 13 平台 DOM 抓取，无签名 HTTP 上报 `socket/index/bullet` |
| 虚拟声卡 | VB-Audio Voicemeeter 封装 | 把浏览器里的 AI 语音变成直播伴侣的"麦克风" |

数据流：`直播间页面 → webview 抓弹幕 → POST live_id 上报 → 云端会话 → 浏览器播语音 → 虚拟声卡 → 直播伴侣`。

## 关键结果（速览）

- **弹幕协议**：`POST /socket/index/bullet`，字段 `live_id,type,nickname,content,ext,platformKey`；`type` 映射 `1发言/2进入/3关注/4点赞/6礼物/-1告警`；服务端**只校验 live_id 存在**，无签名无 token。
- **登录**：`POST api/v1.token/build {username,merchant,password}` → `access_token`（明文 HTTP）。
- **客户端零保护**：`app.asar` 未加密，抓取选择器、容灾切换、反检测手法全部可读；更新链为 HTTP + Ed25519 签名 + sha256。
- **零账号摸底结果**（详见 04）：uniCloud 空间 `InvalidSpace.Deleted` 已废弃（前端凭据实为死凭据）；`api/v1.member/tmymember?merchid=N` 无鉴权可遍历，泄露全部白牌租户配置；APK 内硬编码抖音弹幕签名服务 `ApiKey`，实测可换取 `wss://webcast…signature=` 弹幕流地址。
- **修正**：早前判断的"uniCloud clientSecret 泄露"风险实际为 0（空间已删除），保留判断依据备查。

## 目录

```
docs/
  01-逆向路线图.md    六阶段方法论（文档→测绘→抓包→签名→复刻→自动化）
  02-接口台账.md      接口复刻台账（模板，已确认项见 03）
  03-逆向结论.md      ★ 本次逆向的完整结论、协议规格、缺陷清单、复刻方案
  04-未注册摸底.md    ★ 零账号可获取面：uniCloud 探测、租户 IDOR、APK 全景、抖音弹幕签名
tools/
  feishu_login.ps1    启动带 DevTools 端口的专用 Chrome profile
  capture.mjs         通用 CDP 抓取：正文 + 内嵌状态 + 全部请求 + WebSocket 帧
  recon.py            前端测绘：bundle / sourcemap / 接口 / 签名特征
  js_hook.js          浏览器抓签探针：fetch/XHR/WS/WebCrypto/CryptoJS/RSA
  asar_extract.mjs    零依赖 asar 解包
captures/
  00-访问性取证.md     飞书链接登录墙取证
  feishu-wiki/        文档正文与请求（page.md / dom.html / requests.jsonl）
  target/             安装包、asar 解包结果、前端 bundle
  web-assets/         控制台各页面 chunk
  target-web-home/ tut/ live/   控制台三个路由的抓包
```

## 复现

```powershell
# 1) 文档（登录墙后，靠专用 profile + CDP 渲染抓取）
pwsh -File tools/feishu_login.ps1
node tools/capture.mjs --url "https://lcnsgu439rca.feishu.cn/wiki/Dhb0wn12XiGY6ekMqzTckYsRnPh" --scroll --wait 12000 --out captures/feishu-wiki

# 2) 前端测绘
python tools/recon.py http://www.xcai1618.com/web/ --out captures/recon

# 3) 客户端解包
curl.exe -o captures/target/client.zip "https://douyoss.xcai1618.com/uploads/%E6%98%9F%E8%BE%B0%E5%BC%B9%E5%B9%95%E5%8A%A9%E6%89%8B.zip"
& "D:\7-Zip\7z.exe" x captures/target/client.zip -ocaptures/target/client
& "D:\7-Zip\7z.exe" x "captures\target\client\星辰弹幕助手-双击安装.exe" -ocaptures/target/client/installer
& "D:\7-Zip\7z.exe" x "captures\target\client\installer\`$PLUGINSDIR\app-64.7z" -ocaptures/target/client/app
node tools/asar_extract.mjs "captures\target\client\app\resources\app.asar" "captures\target\client\asar"
```

## 环境

- Node ≥ 22（`capture.mjs` 用内置 WebSocket，零依赖）、Python 3.10+（`httpx`）、Chrome/Edge、7-Zip

## 边界

原始物证只读（`captures/`）；对第三方服务只做协议验证用的一次性探测，不写入真实业务数据。
