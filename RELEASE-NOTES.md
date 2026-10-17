# Release Notes

## V0.5（package dsh-ops-context@0.5.0）— 2026-10-19

跨平台版本：一个纯 JS 包同时支持 **Linux / macOS / Windows** 的 DSH 网页版与桌面版。包名由 `dsh-context-lite-macos` 更名为中性的 `dsh-ops-context`（旧包 ≤0.4.0 为历史版本）。

### 平台无关化

- **工作区根不透明化**：`resolveWorkspaceRelative` 不再断言 POSIX 绝对路径——Windows 盘符根（`C:\Users\...`）与 UNC 根直接可用；插件只校验逻辑相对路径（`/` 统一），平台路径语义全部由 Host 负责。修复 Windows 客户端上所有工具调用首步即抛错的根因。
- **绝对输入拒绝跨平台**：POSIX `/`、Windows 盘符 `C:`、UNC `\\server` 形式一律拒绝。
- **CRLF 归一化**（既有）+ `.gitattributes`（`* text=auto eol=lf`）防 Windows 检出差异。
- 测试矩阵从 20 项扩到 **22 项**：新增"双风格路径矩阵"（同一组断言在 POSIX 与 Windows 根下各跑一遍）+ Windows 绝对/UNC 输入拒绝。

### 分发与 CI

- 包声明 `"os": ["linux","darwin","win32"]`，`engines` node 22/24；**一个 tgz 通吃三平台**（纯 JS、无原生依赖）。
- peer 契约放宽为 `>=0.2.0-rc.2`（适配桌面客户端 >0.2.0-rc.2 的版本）。
- 新增 `.github/workflows/test.yml`：ubuntu/macos/windows × node 22/24 真机矩阵跑同一套测试；Release 工作流先跑三平台测试、全绿才发布 tgz。

### 继承自 V0.4 的核心能力（不变）

- 单次封顶（读 ≤12,000 / 搜 ≤16,000 字符，最坏 135,538 → 455 token，298:1）；全量扫描自证；同行 ×次数聚合；凭据名可见内容必拦截；同轮去重（实测 52.5%）。

### 安装

```sh
# 全平台同一命令（桌面用对应 profile）
dsh plugin --profile web install ./packages/dsh-ops-context-0.5.0.tgz
# 升级自 dsh-context-lite-macos 可先：dsh plugin remove dsh-context-lite-macos
```

---

## V0.4（package dsh-context-lite-macos@0.4.0）— 2026-10-17

首个 GitHub 发布版本。DSH Host 插件，为会话提供有界上下文检索工具（`context_search` / `context_read`），同时支持 DSH macOS 网页版与桌面版。

### 核心能力

- **单次上下文封顶**：读取 ≤12,000 字符、搜索 ≤16,000 字符；实测最坏情况（命中 368KB 压缩单行 bundle）一次交付从 135,538 token 降至 455 token（上限比 298:1）。
- **全量扫描自证**：搜索无截断时返回 `[全量扫描：N 个文件、M 个目录，共 K 处命中，无遗漏]`——一次调用即完整答案。
- **同行命中聚合**：同一行多次命中合并为一条并标注 `×次数`。
- **敏感路径拦截**：隐藏路径与凭据命名文件内容一律拒绝（读取在 stat 之前拦截）；搜索仅列出文件名，0 内容泄露。
- **同轮读取去重**：同参数重读返回简短提示，实测省 52.5%；上下文压缩后自动失效，支持 `force=true`。
- **会话投影状态**：经 DSH `sessionProjections` 跟踪轮次与压缩代际，去重仅对"本轮且未压缩"的完整结果生效。

### 量化验证（真实 Host 实例 + 模型 API usage）

- 同测试用例下，插件组任务级 token：0.1.1 的 442,228 → V0.4 的 37,419（**节省 91.5%**），信息获取调用 26 → 5，正确性 T1–T4 全对（见 `docs/BENCHMARK-REPORT-v4.md`）。
- 单次交付双 tokenizer 实测：常规检索省 31–46%、摘览省 84%、去重省 95%+、bundle 场景省 99.7%（见 `docs/BENCHMARK-REPORT.md`）。
- 诚实边界：与原生强基线（聪明模型+小语料）任务级持平；价值在最坏情况封顶与安全拦截（见 `docs/BENCHMARK-REPORT-v3.md`）。

### 演进路径

| 版本 | 要点 |
|---|---|
| 0.1.0 | 初版工具与安全模型 |
| 0.1.1 | 修复行钳制读取被误缓存为完整的去重缺陷 |
| 0.1.2 | 搜索不完整提示列出被跳过路径 |
| 0.2.0 | 同行 ×次数聚合、全量自证标记、凭据文件名可见、预算放宽 |
| 0.4.0 | V0.4：首个 GitHub 发布版本（代码基线同 0.2.0） |

### 安装

```sh
dsh plugin --profile web install ./packages/dsh-context-lite-macos-0.4.0.tgz
```

要求 DSH `>=0.2.0-rc.2 <0.3.0`，安装后重启 DSH 生效。单测 20/20。

---
作者：kkgace <21516470+kkgace@users.noreply.github.com>
