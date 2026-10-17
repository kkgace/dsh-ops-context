# 桌面双平台冒烟验收清单（P3）

> 目标：在 macOS 桌面与 Windows 桌面客户端上，对 dsh-ops-context@0.5.0 做安装后冒烟，输出与 Linux 基线**逐字一致**（除路径字面量）。
> 前置：桌面客户端 DSH 版本 >0.2.0-rc.2（已确认）；安装方式为 `dsh plugin`（已确认）。

## 0. 安装

```sh
# macOS 桌面：先完全退出 DSH 桌面应用，再执行
dsh plugin --profile desktop install <tgz 路径>/dsh-ops-context-0.5.0.tgz
# Windows 桌面：从安装目录执行（无需退出应用亦可尝试，装后务必重启应用）
dsh plugin --profile desktop install <tgz 路径>\dsh-ops-context-0.5.0.tgz
# 重启 DSH 桌面应用（插件不热加载）
```

确认：`dsh plugin list` 显示 `dsh-ops-context@0.5.0`；新建带 workspace 的会话中 `context_search` / `context_read` 出现在工具列表。

## 1. 冒烟用例（每平台各跑一遍，记录工具原文输出）

| # | 用例 | 期望 |
|---|---|---|
| S1 | `context_search(query="某个字面词")` 全域 | 返回 `path:line(×N)` 行 + `[全量扫描…]无遗漏` 标记（无截断时） |
| S2 | `context_read(path, startLine=1, lines=50)` | 带行号前缀原文，尾部版本脚注 |
| S3 | S2 同参再读一次 | 返回 `[已读去重：…]` 且版本号与 S2 一致 |
| S4 | `context_read('.env')` 或 `context_read('id_rsa')` | 拒绝：隐藏路径/敏感凭据错误消息 |
| S5 | `context_search(query, path=".env")` | 0 命中 + 凭据文件名列出、内容不读 |
| S6 | 越界输入 `context_read('../outside.txt')` | 拒绝"不允许访问工作区外的路径" |

## 2. Windows 特验

| # | 用例 | 期望 |
|---|---|---|
| W1 | 工作区根为 `C:\...` 时 S1–S6 全通 | 输出与 POSIX 基线逐字一致（路径字面量除外） |
| W2 | 含空格路径（`C:\Users\me\my proj\...`） | 正常读取/搜索 |
| W3 | 中文路径段 | 正常 |
| W4 | 大小写不敏感 FS：同文件 `ABC.ts` 与 `abc.ts` 各读一次 | 两次都读到（去重键不同，属预期无害行为） |
| W5 | 工具参数带反斜杠（`context_read("src\file.ts")`） | `\` 归一化为 `/`，正常读取 |

## 3. macOS 特验

| # | 用例 | 期望 |
|---|---|---|
| M1 | 工作区根为 `/Users/...` 时 S1–S6 全通 | 与 Linux 基线一致 |
| M2 | 桌面 profile 安装后 web profile 不受影响 | 各自独立安装、工具独立注册 |

## 4. 判据与回退

- **通过**：S1–S6 + W1–W5（Windows）/ M1–M2（macOS）全部符合期望，且无工具抛"当前会话没有有效的工作区根目录"类错误。
- **失败回退**：若桌面 DSH 版本与服务契约不匹配（如 inject 服务缺失），记录完整报错并回退到对应版本 meta 包（按 peer 范围拆分），本包保持不变。
- 验收结果回填到 `RELEASE-NOTES.md` V0.5 一节（"桌面真机验收"状态行）。
