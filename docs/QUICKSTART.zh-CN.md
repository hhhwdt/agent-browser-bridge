# 快速开始

从零到让 agent 操控你的浏览器。八步，其中两步必须你自己点。

简体中文 · [English](QUICKSTART.md)

---

## 开始之前

- **Node.js 18 或更高。** 桥接服务和 MCP 服务都跑在 Node 上，没有第三方依赖。
- **Chrome、Edge 或其他 Chromium 内核浏览器。**
- 先读 [免责声明](DISCLAIMER.zh-CN.md)。一句话版本：本机上任何能访问桥接端口的程序，都能用你
  的登录态在浏览器里操作，包括你没在看着的时候。

## 1. 拿到代码

```bash
git clone https://github.com/hhhwdt/agent-browser-bridge.git
cd agent-browser-bridge
```

## 2. 跑一次自检

```bash
node src/setup.js
```

它逐层检查（Node、桥接服务、扩展、站点授权、MCP 注册），告诉你缺的是哪一层、下一步做什么。
后面每做完一步都可以再跑一次，重复跑没有副作用。它最后会真的开一个后台标签页读一遍再关掉，
所以它全绿就说明整条链路是通的。它只读不写：需要执行的命令会打印出来，不替你改配置。

## 3. 加载扩展

- Chrome：`chrome://extensions` → 打开右上角**开发者模式** → **加载已解压的扩展程序** → 选本仓库的
  `extension/` 目录。
- Edge：`edge://extensions` → **开发人员模式** → **加载解压缩的扩展** → 同一个目录。

加载后工具栏会出现一个拼图图标，可以固定出来。

> 没有商店版本，也不会有：这工具需要 `debugger` 权限、会执行本机程序在运行时传入的代码、还要
> 求站点访问权限。这几条放在一起会被商店审核判为远程代码执行与远程控制。加载已解压是唯一
> 受支持的安装方式。

## 4. 授权你要它操作的站点

点扩展图标。默认什么都没授权。这一步没有任何程序能替你做，浏览器要求必须由你亲手点。

- 填一个主机名（例如 `confluence.example.com`）后点**授权**，或者
- 直接点**授权所有站点**，省得一个个加。

可选：需要用 `session` 工具（读 Cookie 和站点存储）时，在"可选权限"那一行点**授予**。不需要就别给。

## 5. 粘贴桥接 token

桥接服务首次启动时会生成 token。扩展需要它来证明身份。

1. 找到 token 文件（桥接服务启动时会打印路径）：
   - Windows：`%APPDATA%\agent-browser-bridge\token`
   - macOS/Linux：`~/.config/agent-browser-bridge/token`
2. 复制 token（64 位十六进制字符串）。
3. 粘贴到扩展弹窗的"桥接 token"输入框，点**保存 token**。

或者运行 `node src/cli.js token --show` 打印 token。

## 6. 加上 MCP 服务

在仓库根目录执行，路径交给 shell 填，不用手打也不用写死：

```bash
claude mcp add -s user browser -- node "$PWD/src/mcp.js"      # macOS / Linux / Git Bash
claude mcp add -s user browser -- node "%CD%\src\mcp.js"      # Windows cmd
```

`-s user` 表示所有项目里都能用，不只是这个目录。换别的 MCP 宿主、或者不想动全局配置，也可以用项目里的
`.mcp.json`，路径是相对的：

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["src/mcp.js"] }
  }
}
```

`node src/setup.js --install` 可以代你注册，不行时会退回打印手动命令。

**不需要手动启动桥接服务。** 端口上没有服务时，MCP 会在第一次调用时把它拉起来，之后一直留着。

## 7. 确认能用

让 agent 调一次 `browser_status`，应该返回在线的浏览器和扩展版本。然后让它干件真事：

> 列出我打开的标签页，然后读其中 URL 含 confluence 的那个，总结一下。

报 `extension_not_connected` 说明扩展没加载或没启用。报 `permission_denied` 说明第 3 步没覆盖到
那个站点。

## 8. 告诉它该怎么干活

agent 连上来时，MCP 服务会自己下发一套工作纪律（先列标签页、新页面开在后台、自己开的自己关、
收尾清标记、不可逆动作先问），这些不用你在提示词里重复。你该说的还是你自己的要求：允许它碰
哪些站点、哪些动作必须先问你。

---

## 出问题时

```bash
node src/mcp.js --list-tools     # 工具清单与各自必填参数
node test/test-offline.js         # 21 个套件，不需要浏览器也不需要配置，最快的信号
node test/test-live.js            # 会开一个后台标签页，真机跑一遍
node src/cli.js diag            # 扩展版本、id、连接状态、最近错误
```

| 现象 | 原因 |
|---|---|
| `bridge_unavailable` | 18777 端口上没有服务且启动失败。手动跑 `node src/server.js` 看原因。 |
| `extension_not_connected` | 扩展没加载，或加载在另一个浏览器配置里。 |
| `permission_denied` | 该站点从没授权过。回到第 3 步。 |
| `permission_not_granted` | `session` 工具需要可选的 `cookies` 权限。 |
| `token_required` | 桥接服务在运行但扩展没有 token。把 token 粘贴到扩展弹窗（第 5 步）。 |
| `tab_unresponsive` | 该标签页的渲染进程冻结了。先跑 `activate` 再重试，或用 `--auto-activate`。 |
| 全都超时 | 先跑 `node src/cli.js diag`，多半是选错了浏览器或扩展已经掉线。 |

## 各文件是什么

| 文件 | 作用 |
|---|---|
| `extension/` | 浏览器扩展（MV3） |
| `src/server.js` | 本机桥接服务，`127.0.0.1:18777`，零依赖 |
| `src/mcp.js` | MCP 服务，agent 直接对接的就是它 |
| `src/client.js` | 客户端库，想自己写代码调桥接时用 |
| `src/cli.js` | 同样的能力，命令行形态 |
| `scripts/` | Windows 辅助脚本：登录时启动桥接、启动/重启桥接 |
| `test/` | 哪些需要浏览器见 [README](../README.zh-CN.md#测试) |

---

## 交给别人用

对方要按顺序做四件事。其中**两件没法自动化**：加载扩展、授予站点，浏览器要求必须由真人点击，
任何程序都替代不了。这是浏览器的安全模型，不是这个工具的偷懒。

1. **拿到代码**：`git clone https://github.com/hhhwdt/agent-browser-bridge.git`，或者直接把这个
   文件夹打包发给他。
2. **他加载扩展**：`chrome://extensions`（或 `edge://extensions`）→ 开发者模式 → 加载已解压 →
   选 `extension/` 目录。这一步只能他点。
3. **他授权站点**：点扩展图标，把他允许 agent 操作的站点加进去。
4. **注册 MCP 服务**：跑 `node src/setup.js --install` 就能自动注册；不行时它会打印手动命令。

做完让他跑一次 `node src/setup.js`，四层逐个查，缺哪层会直接说出来。

有两件事值得提前告诉他，因为都会让人意外：

- **扩展不在商店里，也不会有。** Chrome 每次启动都会提示"停用开发者模式扩展"。这是 `debugger`
  权限和"执行本机程序运行时传入的代码"的代价：这套组合在商店审核那里等同于远程代码执行加远程控制。
- **它驱动的是他真实登录着的浏览器。** 他登录过的一切，本机上任何能访问桥接端口的程序都够得着。
  [免责声明](DISCLAIMER.zh-CN.md)很短，建议跟链接一起发过去。

如果想要**完全不出现路径**的版本，就先发到 npm，对方 `npm i -g @hhhwdt/agent-browser-bridge` 装完直接用
命令名：`agent-browser-bridge` 起桥接、`agent-browser-bridge-setup` 跑上面的自检、
`agent-browser-bridge-mcp` 是第 4 步的 MCP 服务，既不用 clone 也不用写路径。包里带着
`extension/`，所以第 2 步照旧，自检会把要加载的那个目录打印出来。
