# dsh-ops-context

**dsh-ops-context** 是一个 DSH Host 插件，为 DeepSeek Harness（DSH）会话提供**有界的上下文检索工具**（`context_search` / `context_read`）：

- 把每次工具调用的上下文交付**封顶**（读 ≤12,000 字符、搜 ≤16,000 字符），杜绝"一次贪婪检索注入 13 万 token"引发的自动压缩与内容丢失；
- 搜索无截断时**自证完整**（全量扫描标记），一次调用即完整答案；
- **默认拦截**隐藏路径与凭据文件（内容 0 泄露，仅列文件名）；
- 同轮重复读取**去重**（实测省 52.5%）；
- **跨平台**：一个纯 JS 包同时支持 Linux / macOS / Windows 的 DSH 网页版与桌面版，无原生依赖、无分平台编译。

> **当前版本**：V0.5（package `dsh-ops-context@0.5.0`）
> **作者**：[kkgace](https://github.com/kkgace) · **License**：MIT（[LICENSE](LICENSE)）
> **状态**：公开试用中（收集反馈 2 天），之后提交 npm 官方供 DSH 插件市场下载安装。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [授权方式](#授权方式)
- [工具与配置](#工具与配置)
- [测试报告概览](#测试报告概览)
- [跨平台支持](#跨平台支持)
- [维护与升级](#维护与升级)
- [版本历史](#版本历史)
- [License](#license)

---

## 它解决什么问题

长会话里，一次"贪婪"的文件检索（例如 grep 命中 368KB 的压缩单行 bundle）可能向模型上下文注入超过 13 万 token，直接触发自动压缩、丢失早期内容。本插件把工具交付从"无上限"变为"有硬上限 + 可自证完整 + 安全默认"：

| 能力 | 说明 |
|---|---|
| 单次封顶 | 读 ≤12,000 / 搜 ≤16,000 字符；最坏实测 135,538 → 455 token（298:1） |
| 全量自证 | `[全量扫描：N 个文件、M 个目录，共 K 处命中，无遗漏]` |
| 同行聚合 | 同一行多次命中合并为一条并标注 `×次数` |
| 安全默认 | 隐藏/凭据文件内容一律拒绝，搜索仅列文件名 |
| 同轮去重 | 同参数重读返回"已读去重"提示，压缩后自动失效，`force=true` 强制重读 |
| 平台中立 | 工作区根为不透明前缀，Windows 盘符根（`C:\`）直接可用 |

## 安装

跨全平台、web / desktop 同一命令：

```sh
# 1. 获取安装包（三选一）
#    a) 从 GitHub Release 下载：https://github.com/kkgace/dsh-ops-context/releases
#    b) 从仓库克隆后本地打包：
git clone https://github.com/kkgace/dsh-ops-context.git
cd dsh-ops-context && npm install && npm pack --ignore-scripts --pack-destination packages
#    c) （npm 上线后）npm pack dsh-ops-context

# 2. 安装到目标 DSH profile
dsh plugin --profile web install ./packages/dsh-ops-context-0.5.0.tgz
#    桌面版使用其对应 profile，例如：
dsh plugin --profile desktop install ./packages/dsh-ops-context-0.5.0.tgz

# 3. 重启 DSH（插件不热加载，重启后新代码才生效）
```

要求 DSH `>=0.2.0-rc.2`。

## 授权方式

本插件是 **Host 插件**，运行在 DSH Host 进程内，**不引入新的网络端点、不采集任何数据、不需要用户级 token 或 API key**。

| 层面 | 说明 |
|---|---|
| 包安装授权 | 由 DSH 的 `dsh plugin install` 完成，使用你**已有的 DSH 安装权限**（web/desktop 管理员或拥有 profile 写权限的用户）。本插件本身不额外要求 OAuth/SSO/token。 |
| 运行时权限 | 插件经 Host 注入的 `tools` / `workspaceFiles` / `sessionProjections` / `fs` 服务操作**当前会话授权的工作区**，不越出该工作区（`fs.resolve/contains` containment 兜底）。 |
| 敏感文件 | 隐藏路径与凭据命名文件**默认拒绝读取**；搜索结果仅列出文件名，不泄露内容。 |
| 数据外发 | 无。所有检索/读取均在本地工作区完成，无遥测、无上传。 |

简言之：**安装 = 你授权 DSH 改一个 profile；运行 = 插件在 DSH 已有的工作区权限内只读检索。** 没有任何"插件向第三方请求授权"的环节。

## 工具与配置

### 工具

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `context_search` | 工作区有界字面搜索（大小写不敏感，非正则） | 400 文件/400 行/60 匹配/16,000 字符预算；无遗漏时返回全量扫描标记；凭据文件仅列名 |
| `context_read` | 按行读取工作区文件 | 默认 120 行 / 12,000 字符；同轮同版本同范围去重 |

路径只接受工作区相对路径（参数中的 `\` 自动归一化为 `/`）；每次读取都用 DSH `fs.resolve/contains` 验证规范目标在工作区内——平台语义由 Host 负责，插件零平台分支。

### 配置

所有参数有默认值，可在 profile 插件配置中调节：

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `maxReadLines` | 120 | 单次读取最大行数（1–500） |
| `maxReadChars` | 12,000 | 单次读取最大字符数 |
| `maxSearchFiles` | 400 | 搜索最多扫描文件数 |
| `maxSearchDirs` | 400 | 搜索最多遍历目录数 |
| `maxSearchLinesPerFile` | 400 | 每文件最多检查行数 |
| `maxSearchMatches` | 60 | 搜索最多返回匹配行数 |
| `maxLineChars` | 240 | 单行匹配预览上限 |
| `maxSearchChars` | 16,000 | 搜索输出总字符上限 |

超限时结果带截断说明；可缩窄目录或查询，不会静默声称搜索完整。

## 测试报告概览

完整可复现基准见 [docs/](docs/)（真实 Host 实例 + 模型 API usage，非估算）：

| 维度 | 结果 | 报告 |
|---|---|---|
| 任务级节省（V0.4 相对 0.1.1，同测试用例） | token 442,228 → 37,419，**省 91.5%**；调用 26 → 5 | [v4](docs/BENCHMARK-REPORT-v4.md) |
| 单次交付（双 tokenizer 实测） | 常规检索省 31–46%、摘览省 84%、去重省 95%+、压缩 bundle 省 99.7% | [v2](docs/BENCHMARK-REPORT.md) |
| 诚实边界 | 与"聪明模型 + 小语料"原生强基线任务级持平（原生工具交付仅占该场景约 3%）；插件价值在最坏情况封顶与安全拦截 | [v3](docs/BENCHMARK-REPORT-v3.md) |
| 正确性 | T1–T4 全对，凭据内容 0 泄露 | v4 附录 |

> 一句话总结：**保险层 > 普适节省器**——它保证单次上下文有上限、敏感文件不泄露、重复读取不重复计费；并非所有场景都省 token（小语料 + 强模型时与原生持平）。

## 跨平台支持

| 平台 | 支持 | 验证方式 |
|---|---|---|
| Linux web | ✅ 现状 | 本机长期实测 |
| macOS 桌面/网页 | ✅ V0.5 | CI `macos-latest` 真机跑测试 + 桌面冒烟清单（[docs/SMOKE-CHECKLIST.md](docs/SMOKE-CHECKLIST.md)） |
| Windows 桌面/网页 | ✅ V0.5 | 工作区根不透明化（Windows 盘符根可用）+ CI `windows-latest` 真机跑测试 |

测试矩阵：`.github/workflows/test.yml` 在 ubuntu/macos/windows × node 22/24 跑同一套 22 项单测；Release 工作流先跑三平台测试、全绿才发布。

## 维护与升级

### 开发

```sh
npm install
npm test          # 22/22 单测（含 POSIX + Windows 双风格路径矩阵）
npm run check     # 语法 + 单测
npm pack          # 生成 packages/*.tgz
```

### 升级（已安装用户）

```sh
# 下载新版本 tgz（GitHub Release 或 npm）
dsh plugin --profile web remove dsh-ops-context
dsh plugin --profile web install ./packages/dsh-ops-context-0.x.0.tgz
# 重启 DSH 生效
```

若从旧包名 `dsh-context-lite-macos` 升级：

```sh
dsh plugin --profile web remove dsh-context-lite-macos   # 移除旧 entry
dsh plugin --profile web install ./packages/dsh-ops-context-0.5.0.tgz
# 重启 DSH
```

> **不要热加载**：重装插件包后，运行中的 DSH 进程不会自动加载新代码，必须重启 DSH。验收"运行代码 = 磁盘代码"：先核对 DSH 进程启动时间晚于安装时间。

### 贡献

- 路径逻辑改动务必通过 `test/plugin.test.js` 的**双风格矩阵**（POSIX 根 + Windows 盘符根）全绿。
- 新增敏感文件类型：在 `src/core.js` 的 `SECRET_NAME` / `EXCLUDED_NAMES` 维护，并补测试。
- 提交信息用约定式前缀（`feat:` / `fix:` / `ci:` / `docs:`）。
- 详见 [docs/PLATFORM-PLAN.md](docs/PLATFORM-PLAN.md)（跨平台设计）、[docs/SMOKE-CHECKLIST.md](docs/SMOKE-CHECKLIST.md)（桌面验收）与 [docs/MAINTENANCE-NPM.md](docs/MAINTENANCE-NPM.md)（npm 发布与维护红线）。

## 版本历史

| 版本 | 要点 |
|---|---|
| 0.1.0 | 初版：`context_search` / `context_read`、敏感路径拦截、会话投影去重 |
| 0.1.1 | 修复行钳制读取被误缓存为完整的去重缺陷 |
| 0.1.2 | "搜索不完整"提示列出被跳过路径 |
| 0.2.0 | 同行 ×次数聚合、全量扫描自证标记、凭据文件名可见（内容必拦截）、预算放宽 |
| 0.4.0（V0.4） | 首个 GitHub 发布版本（包名 dsh-context-lite-macos） |
| **0.5.0（V0.5）** | 跨平台版：工作区根不透明化（Windows 盘符根可用）、包名 dsh-ops-context、CI 三平台真机矩阵、peer 契约放宽至 >=0.2.0-rc.2 |

## License

[MIT](LICENSE) © [kkgace](https://github.com/kkgace)。

> 关于 npm 发布：本包即将提交 npm 官方供 DSH 插件市场下载安装。届时可用 `npm view dsh-ops-context` 校验、`npm pack dsh-ops-context` 取包，再走上面的 `dsh plugin install` 流程。发布走标准 npm 流程（`npm publish` 需 npm 账号 + publish 权限），仓库保持 MIT 开源。
