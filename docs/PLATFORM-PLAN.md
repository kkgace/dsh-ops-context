# 跨平台方案：Windows / macOS 客户端支持（V0.5 规划）

> 状态：设计定稿，待实施 ｜ 目标：同一插件包在 Linux Web（现状）、macOS 桌面/网页、Windows 桌面/网页上行为一致

## 1. 现状判定（为什么现在"只支持 Linux 网页版"）

### 1.1 Windows 不可用的根因（已定位到行）

`src/core.js` 的 `resolveWorkspaceRelative()`（第 45–55 行）**硬编码 POSIX 路径语义**处理工作区根：

```js
if (!posix.isAbsolute(root)) throw new Error('当前会话没有有效的工作区根目录');  // ← Windows 上 C:\Users\x 判为 false，直接抛错
...
const absolute = posix.resolve(root, normalized);   // ← 对 C:\Users\x 做 posix.resolve 产生垃圾路径
```

Windows 客户端的 DSH workspace 根是 `C:\Users\...`（反斜杠 + 盘符），`posix.isAbsolute` 判定失败 → **所有 context_search/context_read 调用在第一步就抛错**。

### 1.2 macOS"名义支持、实际未验收"

- 代码层面 macOS 与 Linux 同为 POSIX 路径，理论上可用；但 peer 契约（`@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0`）在**桌面版 Host** 上是否成立、桌面 profile 的安装命令是否与 web 一致，从未验证。
- 包名 `dsh-context-lite-macos` 语义收窄（Windows 用户装 "-macos" 包不合理）。

### 1.3 已经做对的部分（跨平台设计的既有基础）

- 插件**从不自己读盘**：所有文件访问经 Host `workspaceFiles`/`fs` 服务，`absolutePath` 只透传给 `fs.resolve/contains` 做 containment（`assertWorkspaceTarget` 平台无关）——**平台差异被收敛在插件自己的路径校验层**，Host 负责真正的平台语义。
- 工具参数已做 `\` → `/` 归一化（第 49 行）；CRLF 已统一归一化；去重缓存键使用逻辑相对路径。

## 2. 设计原则（一条主线）

**工作区根（root）是不透明前缀（opaque prefix），插件永远不解析它。**

- 逻辑路径空间：工具参数、渲染、缓存键、匹配结果一律使用 `/` 分隔的相对路径（与平台无关）。
- 绝对路径：只由 Host 生成、只向 Host 透传；插件不做 `posix.resolve(root, ...)` 之类的自检拼接。
- 根校验：`posix.isAbsolute(root)` 改为"非空字符串 + Host 会话头提供"即可（信任 Host 传来的 workspace 根格式）。
- 越界防护：保留现有逻辑相对路径校验（`..`、绝对形式拒绝）+ Host 端 containment 双层。

由此，修复面收敛为 `resolveWorkspaceRelative` 一个函数（约 10 行）+ 测试，**不需要平台分支的大改**。

## 3. 分阶段实施

### P1 平台无关化（代码，预计 0.5 天）

1. `resolveWorkspaceRelative` 移除对 root 的 POSIX 断言与 `posix.resolve(root,...)` 自检；越界校验全部在逻辑相对空间完成。
2. 新增**注入式风格单测**：现有 20 项测试以 `root='/workspace'` 跑一遍，再以 `root='C:\\Users\\me\\proj'`（模拟 Windows Host 返回的根）全量重跑一遍——同一套断言双跑，证明零平台分支泄漏。
3. Windows 附加用例：盘符大小写（`c:\` vs `C:\`）、含空格路径、UNC 路径（`\\server\share`，拒绝透传给 Host 由其裁决）、工具参数含 `\` 的归一化、反斜杠文件名歧义提示。

### P2 包与分发矩阵（预计 0.5 天）

1. **包名**：新增 `dsh-ops-context`（与仓库同名，`"os": ["linux","darwin","win32"]`）；`dsh-context-lite-macos` 保留为兼容别名（同一份源码、两份 package.json 生成产物），README 标注旧名 deprecated。
2. **CI 三平台矩阵**（GitHub 托管真机，非模拟）：

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
runs-on: ${{ matrix.os }}   # 同一套单测在三平台真机执行
```

   Windows runner 会直接暴露路径/大小写/换行类缺陷（比 mock 更硬）。
3. 产物策略：**一个通用 tgz 通吃三平台**（纯 JS、无原生依赖、无平台分支）——不做分平台编译，分平台 meta 包仅在桌面版 peer 契约与 web 不同版本时才引入。

### P3 桌面客户端验收（依赖外部输入，预计 0.5 天）

1. **待确认输入**：macOS/Windows 桌面客户端的 DSH 版本号（peer 契约 `0.2.0-rc.2` 是否覆盖）、桌面 profile 名称与安装命令（`dsh plugin --profile <desktop> install ...` 是否同一 CLI）。
2. 验收清单（每平台）：安装 → 重启 → 新建带 workspace 会话 → T1 检索 / T2 行读取 / T3 去重 / T4 凭据拦截各一条冒烟 → 对照 Linux 基线输出逐字一致（除路径字面量）。
3. Windows 特验：`C:\` 工作区根、含空格与中文路径、大小写不敏感文件系统的去重键行为。

### P4 发布（预计 0.25 天）

V0.5 tag → 既有 Release 工作流自动在 **windows/macos/ubuntu 三平台 runner 上跑测试后发布**（workflow 顺手加矩阵）；README/RELEASE-NOTES 更新平台支持矩阵。

## 4. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 桌面版 Host 契约版本未知 | peer 契约可能需放宽或分叉 | P3 前先取得桌面 DSH 版本号；契约匹配失败时按 dsh 版本拆 meta 包 |
| Host `workspaceFiles` 在 Windows 上的返回格式（`\` vs `/`、盘符大小写） | 影响透传与渲染 | 插件只透传不解析（设计保证）；冒烟用例覆盖 |
| 大小写不敏感 FS 的去重键 | 同文件两种大小写输入重复读取不命中去重 | 无害（多读一次）；可在 P1 一并做键归一化（lower-case 仅当 Host 声明不敏感） |
| CI Windows runner 的行尾/权限差异 | 测试偶发失败 | 仓库加 `.gitattributes`（`* text=auto eol=lf`） |

## 5. 工作量与里程碑

| 阶段 | 内容 | 预估 | 依赖 |
|---|---|---:|---|
| P1 | 代码平台无关化 + 双风格测试矩阵 | 0.5 天 | 无 |
| P2 | 包名/OS 声明 + CI 三平台矩阵 | 0.5 天 | P1 |
| P3 | 桌面双平台真机验收 | 0.5 天 | 用户提供桌面 DSH 版本与安装方式 |
| P4 | V0.5 发布 | 0.25 天 | P1–P3 |
