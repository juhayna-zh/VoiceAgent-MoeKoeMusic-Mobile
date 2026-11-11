<div align="center">

<img src="assets/images/icon.png" width="240" alt="MoeKoe Music" />

# **Voice Agent** for *MoeKoeMusic-Mobile*

把「语音 Agent 助手」带进音乐 App —— 在 [MoeKoe Music Mobile](README_origin.md) 的基础上，
新增一个可以**边听歌边对话、能用语音直接控制播放和歌曲列表**的常驻助手「千问」。

[![Expo SDK](https://img.shields.io/badge/Expo-SDK%2057-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.86-61DAFB?logo=react&logoColor=white)](https://reactnative.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-GPL--2.0-blue.svg)](LICENSE)

</div>

---

## ✨ 这是什么

一个第三方音乐移动端播放器，**内嵌了实时语音助手**。你可以在听歌时随时唤起它聊天，
也可以直接用一句话让它帮你操作播放器——切歌、搜歌、放歌单、点喜欢、看歌词等等。

> 底座播放器（首页/发现/搜索/歌单/播放页/登录等）的完整说明见 [README_origin.md](README_origin.md)。
> 本 README 聚焦「语音 Agent」这部分能力与部署。

## 🎙️ 语音助手能做什么

- **实时语音对话**：实时语音上行下行 + 转写字幕，服务端 VAD，支持随时打断。
- **常驻可用**：唤醒后跨页面持续运行；悬浮球 + 独立 Tab，状态一目了然。
- **语音控制播放**（App 本地执行，助手发指令、前端干活并回报结果）：
  - 播放控制：播放 / 暂停 / 上一首 / 下一首 / 停止清空队列
  - 播放模式：顺序 / 随机 / 单曲循环
  - 进度：跳到指定时间点，或相对快进 / 快退
  - 音量：调高 / 调低 / 设为指定值
- **找歌与播放**：
  - 搜索歌曲、搜索歌单、建播放列表
  - 播放指定歌曲、播放指定歌单、播放「每日推荐」
- **查询与收藏**：当前在放什么 / 队列里有哪些歌 / 当前歌曲的歌词（并标记正在唱的那句）/ 把当前歌曲加入「我喜欢」。
- **世界知识问答**：问到歌曲、歌手、专辑等信息时，助手会组合歌词 + 联网搜索 + 世界知识多步查证后回答。
- **可视化调试**：对话界面会显示每一次工具调用，点开可查看入参与返回结果。

## 🧩 架构

语音能力由「**App 客户端**」+「**Gateway 后台**」两部分组成，通过 GCP WebSocket 协议通信：

| 部分 | 职责 | 所在仓库 |
| --- | --- | --- |
| App 客户端 (iOS或Android) | 麦克风采集、PCM 播放、UI、**播放器工具的实际执行** | 本仓库 |
| Gateway 后台 | 会话管理、语音模型（DashScope Realtime）、VAD、音频转码、人设注入、内置联网搜索 | [qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent)（**不在本仓库**） |

数据流：客户端麦克风 PCM16 → Gateway → DashScope Realtime → 语音 / 字幕回传客户端。
当助手决定操作播放器时，Gateway 下发 `client.tool.*` 指令，**由 App 本地执行**（切歌、搜索、
播放歌单等），再把结果回传给助手。API key 只配置在 Gateway 侧，客户端不接触。

## 🚀 部署与运行

整体分三步：**① 部署后台 Gateway → ② 运行 App → ③ 在 App 里填后台地址与 token**。

### 第一步：部署后台 Gateway

后台代码不在本仓库。请参考官方示例部署一个「音乐陪伴助手」Gateway：

👉 **https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/music-assistant**

按该示例准备好 `.env`（填入 `DASHSCOPE_API_KEY`）后启动 Gateway。要点：

- 默认监听 `ws://127.0.0.1:3101`（仅本机）。**手机真机接入**需在后台 `.env` 里设 `HOST=0.0.0.0`，
  并设置一个访问密钥 `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN`（≥ 24 字符），客户端连接时经
  `Authorization: Bearer` 携带。
- 真机调试：
  - 局域网：记下后台所在机器的局域网 IP（手机需与它处于同一网络，例如手机个人热点）。
  - 公网：需要后台服务器有公网 IP 并且开放对应的TCP端口。

### 第二步：运行 App

本项目使用[Expo SDK 57](https://expo.dev/) + [React Native 0.86](https://reactnative.dev/) 的跨端UI框架，支持在 iOS 和 Android 手机端部署。

环境要求：[Node.js](https://nodejs.org/) ≥ 22、[Git](https://git-scm.com/)。

```bash
# 克隆仓库（包含 api submodule）
git clone --recurse-submodules https://github.com/MoeKoeMusic/MoeKoeMusic-Mobile.git
cd MoeKoeMusic-Mobile

# 安装依赖
npm install
npm --prefix api install

# 生成移动端 API 入口（api/ 更新后需重新执行）
npm run generate:mobile-api

# 启动开发服务器
npx expo start
```

> 如果克隆时遗漏了 submodule，可执行 `git submodule update --init` 补齐。

### 第三步：在 App 里连接后台

打开 App 的「**设置**」页，填写语音助手的连接信息：

| 字段 | 填什么 |
| --- | --- |
| **Gateway 地址** | 后台的 ws 地址，形如 `ws://<后台机器IP>:3101`（例如手机与电脑同一 Wi-Fi 时形如 `ws://192.168.1.100:3101`）。只填到端口即可，App 会自动补 `/api/realtime`。iOS 模拟器与 Mac 共享网络栈，用 `ws://127.0.0.1:3101` 即可。 |
| **Token** | 后台 `.env` 里 `QWEN_AUDIO_GATEWAY_ACCESS_TOKEN` 的值，默认是 `agent-token-1234567890ab`。**回环连接（模拟器 / 本机）免 token**；手机等跨设备连接必须填，且要与后台一致。 |

填好后进入底部「**语音**」Tab，点「**唤醒**」，说一句话即可听到助手回复；之后切到其他页面
助手仍常驻运行（悬浮球可见），随时可回到对话或点「暂停」。

## 🔗 相关

- [README_origin.md](README_origin.md) — 底座音乐播放器的完整说明
- [qwen-audio-agent · music-assistant 示例](https://github.com/QwenAudio/qwen-audio-agent/tree/main/examples/music-assistant) — 语音后台部署参考
- [MoeKoeMusic](https://github.com/iAJue/MoeKoeMusic) — 桌面版播放器

## ⚠️ 免责声明

1. 本项目仅供**学习与技术研究**使用，请勿用于任何商业用途。
2. 本项目不存储、不分发任何音频资源，所有音乐数据均来自官方接口。
3. 音乐版权归酷狗音乐及相应版权方所有，请支持正版音乐。
4. 语音功能会调用第三方大模型服务（DashScope），产生的费用与数据政策以其服务条款为准。
5. 使用本项目产生的一切后果由使用者自行承担，与开发者无关。

## 📄 License

本项目基于 [MoeKoeMusic](https://github.com/iAJue/MoeKoeMusic) 开发，并遵循 [GPL-2.0 License](LICENSE) 开源协议。
