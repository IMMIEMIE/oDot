# oDot Bridge —— JetBrains IDE 插件

把 JetBrains 系 IDE（IntelliJ IDEA / PyCharm / WebStorm / GoLand / Rider 等）接入 oDot 桌面应用，
功能与 `oDotVscode` 扩展一致：

- **实时窗口监测**：本 IDE 窗口出现在 oDot 的「已连接 IDE」面板，可被点击切换为活动项目。
- **发送到 Prompt**：把当前选区 / 文件 / 文件夹发送到 oDot 的输入框。

依赖 oDot 桌面应用处于运行状态（它会在 `~/.odot/bridge.json` 暴露本地 bridge，协议 v2、Bearer Token 鉴权）。

## 环境要求

- JDK 17（构建工具链）。若本机没有，Gradle 会通过 foojay 自动下载。
- 首次构建需要联网：下载 Gradle 8.10.2 发行版与 IntelliJ Platform（IC 2023.2，数百 MB）。
- 目标兼容：`since-build 232`（2023.2）及以上，无上限。

## 构建 / 运行

Gradle 需用 JDK 17 运行（JDK 25 过新，Gradle 8.x 不支持）。示例（Git Bash）：

```bash
cd oDotJetbrains
JAVA_HOME="$HOME/.jdks/jdk-17" ./gradlew test          # 运行纯逻辑单元测试
JAVA_HOME="$HOME/.jdks/jdk-17" ./gradlew buildPlugin    # 产物：build/distributions/oDotJetbrains-0.1.0.zip
JAVA_HOME="$HOME/.jdks/jdk-17" ./gradlew runIde         # 启动带插件的沙箱 IDE
```

PowerShell：

```powershell
$env:JAVA_HOME="$env:USERPROFILE\.jdks\jdk-17"; .\gradlew.bat buildPlugin
```

> 最省事的方式：用 IntelliJ IDEA 打开 `oDotJetbrains` 目录，IDE 会自动配置 Gradle JVM 与工具链，
> 直接跑 `runIde` / `buildPlugin` 任务即可。

安装：`Settings ▸ Plugins ▸ ⚙ ▸ Install Plugin from Disk…`，选择 `build/distributions` 里的 zip。

## 使用

- 编辑器内选中代码 → 右键 **oDot: Send Selection/File to Prompt**（或 Tools 菜单）。
- 项目视图右键文件/文件夹 → **oDot: Send File/Folder to Prompt**。
- **oDot: Check Bridge** 检查 bridge 是否可达。
- 配置：`Settings ▸ Tools ▸ oDot Bridge`（HTTP 超时、最大 payload 字节数）。

### 快捷键

发送快捷键使用 IDE 原生 Keymap 管理，默认 `Ctrl+Shift+L`（macOS 为 `Cmd+Shift+L`）。
在 `Settings ▸ Keymap` 搜索 `oDot`（或对着 `oDot: Send Selection/File to Prompt` 右键 → `Add Keyboard Shortcut`）即可改成任意组合。Keymap 原生支持多修饰键与两段式 chord，因此三键及以上组合都能设置，也可移除绑定。
快捷方式：`Find Action` 或 Tools 菜单里的 `oDot: Configure Send Shortcut` 会直接打开已过滤到 oDot 的 Keymap 页。

## 结构

`src/main/kotlin/dev/odot/bridge/`：

- `BridgeProtocol` / `BridgeDiscovery` / `BridgeHttp` —— 协议常量、发现文件解析、HTTP 客户端。
- `BridgeSyncService` —— 4s 心跳 + workspace-activate（120ms 去抖）+ 关闭时 disconnect。
- `WakeService` —— bridge 不可达时按 15s 节流重启 oDot（或回退 `odot://bridge/wake`）。
- `ReferenceItems` / `PromptReferenceSender` —— 构造并发送引用项（含 payload 限流）。
- `*Action` —— 三个命令。`BridgeSettings` / `BridgeConfigurable` —— 设置。
