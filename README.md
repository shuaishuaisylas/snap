# Snap

本地优先的 AI 桌面工作台。围绕项目上下文、Agent 执行、任务跟进和知识沉淀组织工作。

[官网与功能演示](https://shuaishuaisylas.github.io/snap/) · [下载 Snap 0.20.0](https://github.com/shuaishuaisylas/snap/releases/tag/v0.20.0) · [轨迹说明](docs/agent-trace.md)

## 主要能力

- 上下文引用：文件、历史会话、项目规则、记忆、Todo 与日程。
- 执行轨迹：输入、模型、工具三条泳道，查看参数、结果和上下文；按需开启 AI 说明。
- 工作跟进：Todo、日历、本地定时任务、探索分支和协作子会话。
- 知识与工作环境：Obsidian Vault、文件预览、Git 改动、终端和 Skills/MCP。

## 下载与首次使用

本次提供 **macOS Apple Silicon（M 系列芯片）** 的 DMG 与 ZIP。Intel Mac、Windows 和 Linux 未在本轮提供已验证的安装包。

1. 从 [Releases](https://github.com/shuaishuaisylas/snap/releases/tag/v0.20.0) 下载 macOS arm64 的 DMG。
2. 打开 DMG，把 Snap 拖入“应用程序”，再启动 Snap。
3. 在设置中配置自己的模型渠道与 API Key，然后新建项目和会话。

安装包采用本地临时签名，未做 Apple Developer ID 签名或公证。macOS 若阻止打开，请在“系统设置 → 隐私与安全性”中确认来源后选择“仍要打开”。不要关闭系统整体安全保护。

这是使用全新资料的独立版本：正式业务数据为 `~/.snap`，macOS 应用数据为 `~/Library/Application Support/Snap`，开发数据为 `~/.snap-dev`。不会导入其他客户端的账户、密钥或项目。发布包不包含作者的账户、会话或模型凭据。

模型调用需要使用者自己的渠道与额度。AI 说明默认关闭，开启后产生额外模型用量；本地提醒和定时任务依赖应用运行。浏览器任务依赖另行安装的 Ego Lite。

## 从源码运行

使用 Bun 1.3.14 或兼容版本，在仓库根目录运行：

```sh
bun install --frozen-lockfile
bun run electron:dev
```

类型检查与本机 macOS arm64 打包：

```sh
bun run typecheck
bun run electron:build
cd apps/electron
bun run sync:runtime-deps
bun run rebuild:node-pty
CSC_IDENTITY_AUTO_DISCOVERY=false bun x electron-builder --mac dmg zip --arm64 --publish never
```

打包前需安装 Xcode Command Line Tools。构建会准备 CLI、原生帮助程序、PTY 和 OfficeCLI；不把这些生成文件提交到源码仓库。

## 版本与边界

0.20.0 移除了启动风景背景，统一独立的 Snap 名称和资料环境。原生图片输入保留；语音听写、独立视觉中转、声音库等已移除的功能不在本版中。四个不允许再分发的文档 Skill 未随包提供，文档预览与文本提取功能继续保留。

官网的部分演示来自更早的实机操作，品牌文字已后期统一为 Snap。它们不表示本版每项功能都重新完成端到端测试。每个发布版本的已执行检查与限制见对应 Release 说明。

## 版权与许可

本项目包含基于既有开源桌面应用的修改。原作者署名、修改说明和第三方归属见 [NOTICE](NOTICE)，许可见 [LICENSE](LICENSE)。同版对应源码可从 Release 的源码归档或本仓库 tag 获取。
