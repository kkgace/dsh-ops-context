# npm 发布与维护指南

> 目标：把 `dsh-ops-context` 提交到 npm 官方，供 DSH 插件市场下载安装。本仓库保持 MIT 开源，发布走标准 npm 流程。

## 1. 发布前置条件

| 项 | 说明 |
|---|---|
| npm 账号 | 需 npm 账号；`dsh-ops-context` 包名未注册时由账号 owner 首发，已存在则需是 owner/collaborator。 |
| 发布权限 | `npm login`（浏览器或 token）后 `npm publish`。私有 registry / 组织 scope 另论。 |
| CI 绿 | 发布前 `.github/workflows/test.yml` 三平台（ubuntu/macos/windows）必须全绿。 |
| 版本一致 | `package.json` 的 `version` 与 tag（`V0.x`）语义一致；npm 不允许同版本重复发布。 |

## 2. 标准发布流程

```sh
# 1. 升版本（patch/minor/major）
npm version patch            # 0.5.0 -> 0.5.1（自动加 git tag v0.5.1）
#    或手动改 package.json 的 version 后 git commit

# 2. 本地三平台测试（CI 已覆盖，发布前再跑一遍确认）
npm run check

# 3. 生成可发布包并校验
npm pack                    # 生成 dsh-ops-context-<ver>.tgz
tar -tzf dsh-ops-context-<ver>.tgz          # 核对 files 白名单
node -e "console.log(require('./package.json').version)"

# 4. 发布
npm publish                 # 首发到 public；--dry-run 可先试跑

# 5. 校验
npm view dsh-ops-context version dist.tarball
```

## 3. DSH 插件市场接入

- DSH 插件市场从 npm 拉取 `dsh-ops-context` 的 dist tarball，再走 `dsh plugin install` 安装到 profile。
- 插件市场侧需要的 manifest 字段已在 `package.json`：`name`、`version`、`exports`、`files`、`peerDependencies`、`dsh.bundle.patch`（指向 `cordis.patch.yml`）、`repository`/`homepage`/`author`/`bugs`。
- **不发布原生依赖**：纯 JS、零平台分支，`engines.node` 约束 Node 22/24。

## 4. 升级与回滚

- **升级**：`npm publish` 新版本后，DSH 侧用 `dsh plugin install` 拉新版本；旧版本 tgz 保留在 GitHub Release 供回溯。
- **回滚**：npm 不支持真回滚（同版本号不可覆盖）。策略 = 发一个更高的 fix 版本（如 0.5.1），DSH 侧重装。
- **紧急停用**：`npm unpublish dsh-ops-context`（仅限 24h 内、同包 owner）或在 profile 侧 `dsh plugin remove dsh-ops-context`。

## 5. 维护红线

| 红线 | 原因 |
|---|---|
| 路径逻辑改动必须过双风格测试矩阵（POSIX + Windows 盘符根） | Windows 客户端回归高发区 |
| 新增敏感文件类型必须补 `SECRET_NAME`/`EXCLUDED_NAMES` + 测试 | 防止凭据泄露回归 |
| 不引入网络端点 / 遥测 / 用户 token | "授权方式"承诺：插件只做本地只读检索 |
| 重装后必须重启 DSH（不热加载） | 运行中进程不会加载新代码 |
| 内部路径/凭据/UUID 不得进入仓库 | 公开前用 `git ls-files` + 敏感模式 grep 复审（本次已做） |

## 6. 时间线

| 阶段 | 状态 |
|---|---|
| V0.5 跨平台版（仓库 + Release） | ✅ 已发布 |
| 仓库公开（public）+ 试用/评测开放 | 开放 2 天（收集反馈） |
| npm 官方发布（`dsh-ops-context`） | 开放 2 天后执行 |
| DSH 插件市场上架 | npm 发布后接入 |
