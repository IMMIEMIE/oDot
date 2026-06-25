中文 | **[English](README.md)**

# ![image](https://github.com/IMMIEMIE/oDot/blob/master/src-tauri/icons/128x128.png)  **oDot**

跨 IDE的 AI 编程助手，创新的悬浮球模式。不再需要在各个IDE之间切换各种编程插件，也不会被各种对话框界面占用大量的屏幕空间，配置任意兼容 OpenAI格式的模型服务，打开项目目录，即可开始编码会话。

---

当前项目处于起步阶段，因此用户的反馈和建议非常重要！如果你在使用过程中遇到了任何问题，或者希望未来能够添加新的功能，请尽快进行反馈。

## 核心功能

**三种 Agent 模式**

- **Ask（问答）**——Agent 可以读取和搜索项目文件，但不会修改任何内容。适合向 AI 提问关于代码库的问题。
- **Plan（计划）**——在问答基础上，还可以运行经过审批的 shell 命令进行调研，最终输出一份具体的实施方案，但不修改任何文件。
- **Agent（执行）**——完整的自主模式。可以读取、编辑、创建、删除文件，并运行验证命令。

**安全的文件变更**

每次文件修改（编辑、创建、删除）都会生成快照，包含变更前后的完整内容和 unified diff。支持一键回滚任意单个变更。路径级互斥锁防止同一文件被并发修改。

**Shell 命令审批**

两种 shell 模式：`manual`（每条命令都需要审批）和 `auto`（低风险命令自动执行，危险命令仍需审批）。自动允许列表可按会话配置。

**上下文压缩**

长会话在事件数超过阈值时会自动压缩。压缩生成结构化摘要（目标、约束、进展、决策、下一步），并注入到后续对话中，确保 Agent 不会丢失工作上下文。

**子 Agent 会话**

可以启动隔离的子 Agent 会话，用于专注的并行工作。每个子 Agent 运行在独立的会话中，拥有自己的事件时间线。

**快照与回滚**

所有变更都会记录 SHA-256 哈希和 unified diff。回滚系统会将文件恢复到变更前的状态——如果文件是被创建的，回滚会删除它；如果文件是被删除的，回滚会重新创建它。

**悬浮 Agent 窗口**

一个置顶的透明悬浮窗，可以在不离开编辑器或浏览器的情况下快速与 Agent 交互。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x（Rust） |
| 前端 | React 18 + TypeScript + Vite |
| 状态管理 | Zustand |
| 数据库 | SQLite（WAL 模式，基于 rusqlite） |
| 密钥存储 | 系统钥匙串（Windows 凭据管理器 / macOS Keychain） |
| LLM 流式传输 | reqwest + futures-util（SSE 解析） |
| 文件完整性 | SHA-256（sha2 crate） |
| Markdown 渲染 | react-markdown + remark-gfm |

## 快速开始

### 前置要求

- Node.js 18+
- Rust 工具链（edition 2021，最低 rustc 1.77.2）
- Tauri 2.x 前置依赖（[安装指南](https://tauri.app/start/prerequisites/)）

### 开发模式

```bash
# 克隆仓库
git clone https://github.com/your-username/oDot.git
cd oDot

# 安装依赖
npm install

# 启动开发模式
npm run tauri:dev
```

### 构建

```bash
# 构建桌面应用（不使用打包器）
npm run tauri:build:app
```

构建产物位于 `src-tauri/target/release/odot.exe`（Windows）。

### 仅浏览器开发（可选）

用于快速迭代前端而无需启动 Tauri：

```bash
npm run dev:web
```

这会同时运行 Vite 和 Express。Express 服务器在 4317 端口代理 API 请求，方便在浏览器中调试。

## 配置

oDot 使用项目根目录（或应用数据目录）下的 `odot.json` 文件来配置 Provider 和模型。配置格式兼容 [OpenCode](https://opencode.ai)。

### 示例

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-4o",
  "provider": {
    "openai": {
      "name": "OpenAI",
      "api": "https://api.openai.com/v1",
      "options": {
        "baseURL": "https://api.openai.com/v1",
        "apiKey": "sk-..."
      },
      "models": {
        "gpt-4o": {
          "limit": {
            "context": 128000
          }
        }
      }
    }
  }
}
```

### Provider 类型

⚠注意：由于当前版本对Anthropic API的兼容性不佳（基本不可用）建议使用OpenAI以及兼容 OpenAI 的接口

oDot 会根据 `api` URL 或 `npm` 字段自动检测 Provider 类型：

- `openai`——原生 OpenAI API
- `anthropic`——原生 Anthropic API
- `openai-compatible`——任意兼容 OpenAI 的接口
- `anthropic-compatible`——任意兼容 Anthropic 的接口

可以为每个 Provider 或每个模型单独设置工具模式（`native`、`json` 或 `auto`）。

### API Key 管理

API Key 的获取按以下顺序检查：

1. `odot.json` 中的 `options.apiKey`
2. `env` 字段指定的环境变量
3. 系统钥匙串（首次通过设置界面使用时存储）

## 项目结构

```
oDot/
├── apps/
│   ├── desktop/          # React + Vite 前端
│   │   └── src/
│   │       ├── App.tsx           # 主应用界面
│   │       ├── FloatBall.tsx     # 悬浮 Agent 窗口
│   │       ├── api.ts            # Tauri invoke 封装
│   │       ├── sessionStore.ts   # Zustand 实时事件存储
│   │       └── styles.css        # 应用样式
│   └── server/           # 可选的 Express 回退服务
├── packages/
│   └── core/             # 共享 TypeScript 类型（Web 回退用）
├── src-tauri/            # Rust 后端
│   └── src/
│       ├── lib.rs                # Tauri 命令处理器（32 个命令）
│       ├── runner.rs             # Agent 循环、LLM 编排、上下文压缩
│       ├── tools.rs              # 工具执行引擎
│       ├── provider.rs           # LLM API 调用（OpenAI + Anthropic）
│       ├── llm_runtime.rs        # SSE 流解析器
│       ├── storage.rs            # SQLite 数据库层
│       ├── mutation.rs           # 文件操作与快照追踪
│       ├── config_file.rs        # odot.json 配置解析
│       ├── event_bus.rs          # 实时事件广播
│       └── error_model.rs        # 结构化错误类型
├── odot.json             # 项目配置示例
└── package.json          # 根 Monorepo 配置
```

## 数据存储

oDot 将所有会话数据存储在本地 SQLite 数据库中（Windows 下位于 `%APPDATA%/dev.odot.desktop/odot.db`）。数据库包含以下核心表：

- `session`——会话记录，包含模式、Provider、Token 统计等
- `event`——时间线事件（提示词、工具调用、模型响应、快照等）
- `snapshot`——文件变更记录，包含变更前后内容和 diff
- `context_summary`——长会话的压缩摘要
- `permission_request`——Shell 命令审批记录
- `background_job`——后台 detached 进程追踪

## 许可证

本项目基于 MIT 许可证开源。
