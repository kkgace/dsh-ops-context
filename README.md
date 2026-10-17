# dsh-ops-context

DSH Host 插件 **dsh-context-lite-macos**：为 DeepSeek Harness（DSH）会话提供**有界的上下文检索工具**（`context_search` / `context_read`），把每次工具调用的上下文交付封顶，默认拦截敏感路径，并对同轮重复读取去重。同一份插件包同时支持 DSH **macOS 网页版与桌面版**（Host 注入机制相同，按 profile 分别安装）。

> 当前版本：**V0.4**（package `dsh-context-lite-macos@0.4.0`）
> 作者：[kkgace](https://github.com/kkgace) · License: MIT

## 它解决什么问题

长会话里，一次"贪婪"的文件检索（例如 grep 命中 368KB 的压缩单行 bundle）可能向模型上下文注入超过 13 万 token，直接触发自动压缩、丢失早期内容。本插件把工具交付从"无上限"变为"有硬上限 + 可自证完整"：

- **单次封顶**：`context_read` 单次 ≤12,000 字符、`context_search` 单次 ≤16,000 字符（实测最坏情况 135,538 → 455 token，上限比 298:1）；
- **全量自证**：搜索无截断时返回 `[全量扫描：N 个文件、M 个目录，共 K 处命中，无遗漏]`，一次调用即完整答案，无需补偿核验；
- **同行聚合**：同一行多次命中合并为一条并标注 `×次数`；
- **安全默认**：隐藏路径与凭据命名文件（`.env*`、`id_rsa`、`*.pem/*.key` 等）内容一律拒绝；搜索结果仅列出文件名（不泄露内容）；
- **同轮去重**：同参数重复读取返回简短"已读去重"提示（实测省 52.5%），上下文压缩后自动失效，`force=true` 可强制重读。

## 安装（DSH 网页版 / 桌面版通用）

```sh
dsh plugin --profile web install ./packages/dsh-context-lite-macos-0.4.0.tgz
# 桌面版使用其对应 profile 同样安装；重启 DSH 后生效（插件不热加载）
```

要求 DSH `>=0.2.0-rc.2 <0.3.0`（在 `0.2.0-rc.2` 服务契约上开发；其他版本先做兼容检查）。

## 工具

| 工具 | 用途 | 关键约束 |
|---|---|---|
| `context_search` | 工作区有界字面搜索（大小写不敏感，非正则） | 400 文件/400 行/60 匹配/16,000 字符预算；无遗漏时返回全量扫描标记；凭据文件仅列名 |
| `context_read` | 按行读取工作区文件 | 默认 120 行 / 12,000 字符；同轮同版本同范围去重 |

路径只接受工作区相对路径；每次读取都用 DSH `fs.resolve/contains` 验证规范目标在工作区内，Host `workspaceFiles` 负责 containment、常规文件类型与 symlink 防护。

## 配置

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

## 量化基准（真实 Host 实例 + 模型 API usage，详见 [docs/](docs/)）

- **V0.4 相对 0.1.1**（同测试用例）：插件组任务级 token **442,228 → 37,419，节省 91.5%**；信息获取调用 26 → 5；正确性从"漏计 + 凭据探测失败"提升为"全部正确"（[v4 报告](docs/BENCHMARK-REPORT-v4.md)）。
- **单次交付**（tiktoken cl100k/o200k 双词典实测）：常规检索省 31–46%，文件摘览省 84%，去重省 95%+，命中压缩 bundle 场景省 99.7%（[v2 报告](docs/BENCHMARK-REPORT.md)）。
- **诚实边界**（[v3 报告](docs/BENCHMARK-REPORT-v3.md)）：与"聪明模型 + 小语料"的原生强基线相比任务级持平（原生工具交付仅占该场景总成本约 3%）；插件的价值在最坏情况封顶、安全拦截与去重，而非所有场景的普适节省。

## 版本历史

| 版本 | 要点 |
|---|---|
| 0.1.0 | 初版：`context_search` / `context_read`、敏感路径拦截、会话投影去重 |
| 0.1.1 | 修复行钳制读取被误缓存为完整的去重缺陷 |
| 0.1.2 | "搜索不完整"提示列出被跳过路径 |
| 0.2.0 | 同行命中 ×次数聚合、全量扫描自证标记、隐藏/凭据文件名可见（内容必拦截）、搜索预算放宽 |
| **0.4.0（V0.4）** | 与 0.2.0 同代码基线的首个 GitHub 发布版本（[Release](../../releases/tag/V0.4)） |

## 开发与测试

```sh
npm install
npm test          # 20/20 单测（含同行聚合、凭据名可见、全量自证回归）
npm run check     # 语法 + 单测
npm pack          # 生成 packages/*.tgz
```

测试覆盖：workspace 路径边界、敏感文件过滤、Unicode 输出上限、搜索文件/目录预算、1-based 行偏移、读取去重与 Projection 压缩失效、截断输出不缓存、取消传播、Host 工具注册/卸载。

## 设计边界

不替代 DSH 自带的 `glob`/`grep`/`read`，也不做 AST 代码骨架或日志压缩；聚焦 workspace 范围的有界查找、部分读取和同轮重复读取识别。需要更宽泛检索时使用 DSH 原生工具。

## License

MIT © [kkgace](https://github.com/kkgace)
