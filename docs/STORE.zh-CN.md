# Edge Add-ons 上架材料

发布到 Edge Add-ons 商店所需的全部材料。上架免费（注册不收费），`debugger` 改为可选权限后，
权限答辩也变得直接。Chrome Web Store 不上架，理由在 README。

## 开始前

- 一个微软账号，并在 Partner Center 注册 Edge Add-ons 开发者账号。注册免费，这是唯一需要的账号。
- 1.9.0 起 `debugger` 是可选权限，商店审核只看必需权限（`tabs`、`scripting`、`storage`、
  `alarms`、`downloads`）。

## 第 1 步：打包

把 `extension/` 的**内容**打成 zip，`manifest.json` 必须在 zip 根目录，不能套一层文件夹：

```powershell
Compress-Archive -Path extension\* -DestinationPath agent-browser-bridge.zip -Force   # Windows
# zip -r agent-browser-bridge.zip extension                                          # macOS / Linux，改名即可
```

manifest 里的 `key` 字段保留：Chromium 从它派生扩展 ID，商店版本因此仍是
`nbopjoejgialcnmjcefaciebicahjhpp`，与服务端允许列表一致。发布后核对一次；万一 ID 变了，
用户在服务端允许列表里加一行就能解决。

## 第 2 步：提交

1. 登录 Edge Add-ons 门户（partner.microsoft.com/dashboard/microsoftedge）。
2. "Create new extension" → 上传 zip。
3. 按下面的字段填完 listing，Overview → submit for review。

审核通常按天算。定价免费，全程不收费。

## Listing 字段

| 字段 | 值 |
|---|---|
| 显示名 | Agent Browser Bridge |
| 简介短文 | manifest 的 `appDesc`（`_locales/en/messages.json`） |
| 详细描述 | 见下 |
| 类别 | Developer Tools |
| 语言 | English（默认） |
| 网站 | GitHub 仓库地址 |
| 支持邮箱 | 你的邮箱 |
| 隐私政策 | 仓库里 `docs/PRIVACY.md` 的链接（GitHub 渲染页或 raw） |

详细描述（直接粘贴）：

> Agent Browser Bridge lets a local agent you control read and operate tabs in your own browser —
> in the background, without switching tabs or stealing focus. It pairs with a small bridge server
> on your machine (`npm i -g @hhhwdt/agent-browser-bridge`).
>
> - Read page text, links, and frames from tabs you authorise, one site at a time or all sites
> - Click, type, and scroll with a visible cursor and staged confirmation for destructive actions
> - Screenshots, downloads, upload of local files, and media fetching with anti-hotlink headers
> - Site access is denied by default and granted per site from this popup; nothing is authorised at
>   install time
> - No telemetry, no external requests beyond the local bridge and the URLs you ask it to fetch

英文 listing 面向国际用户，中文描述不必另写。

## 权限答辩

商店按权限逐项问，每项把下面这句抄进去。写用户能得到什么，不写 API 细节：

| 权限 | 答辩文案 |
|---|---|
| `tabs` | Find the tab a request targets, open or close tabs on request, and show which tabs are being operated on. |
| `scripting` | Inject the read/click/type functions into the tab the user addresses. |
| `storage` | Store the site grants, token and error log. |
| `alarms` | Keep the connection to the local bridge alive when the browser suspends the service worker. |
| `downloads` | Save files through the browser's own download stack (`save` action). |
| 可选 `cookies` | The `session` action reads cookies of tabs the user has authorised, so the agent can carry an authenticated session. Off until the user grants it. |
| 可选 `debugger` | Powers full-page and background-tab screenshots, filling local files into an upload control, and brief per-call media fetching that bypasses CORS. Off until the user grants it. |
| 可选主机 `http://127.0.0.1:18777/*` | Required to talk to the local bridge server; that is the only required host entry. |

"是否收集或传输个人数据"：页面内容只发给你本机的桥接服务和你要求抓取的地址，无任何遥测。
见 `docs/PRIVACY.md`。

## 截图

至少一张，1280×800 或 640×480 的 PNG。建议这组：

1. 弹窗：桥接在线、站点列表、可选权限区。
2. 浏览器在别的页面时后台读取成功（把桥接终端输出一起截进去）。
3. 点击/输入流程里可见光标停留在目标元素上。

## 发布之后

- 把文档里还残留的"没有商店版本"说法改成"Chrome 没有，Edge 有"。
- 用户从商店正常安装，不需要手动加载；manifest 的 `key` 保证扩展 ID 不变，服务端允许列表照常生效。
- 商店版本只在你上传新 zip 时更新，npm 包不会自动带上。扩展代码有变化时，CHANGELOG 里记一笔。
