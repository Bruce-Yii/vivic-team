# 前端源码留存与版本协作规范

> 状态：当前协作规范。适用于 VIVIC Web 前端、后端 API、共享契约及服务器发布。
> 当前仓库：`Bruce-Yii/vivic-team`；唯一协作主线：`main`。

## 1. 目标与当前边界

本规范解决两类问题：

1. 服务器不能只留下前端构建产物，必须能从仓库恢复、修改和重新构建对应源码。
2. 多人、多设备和多个 Agent 不能基于不同提交各自开发，最后才发现代码或接口版本不一致。

当前开发优先级是后端协作。前端近期改动较少，因此：

- 后端任务默认不改 Web 页面、不重打前端包，也不顺手升级前端依赖。
- 只有任务明确涉及页面、浏览器行为或前后端接口时，才修改对应前端文件。
- 后端改动影响 API 契约时，必须先说明兼容策略；不能让前端、后端各自猜字段。
- 本文不授权部署、重启服务器、修改生产配置或覆盖线上文件。

## 2. 源码与构建产物：必须分清

### 2.1 唯一源码真值

Web 前端可编辑源码以仓库中的 `apps/web/` 为准，包括：

- `apps/web/src/`：页面、组件、状态、请求和交互实现；
- `apps/web/public/`：随应用发布的静态资源；
- `apps/web/package.json`、Vite 配置及根目录 `package.json`；
- 根目录 `pnpm-lock.yaml`：依赖版本的锁定依据；
- 必要的测试、类型、样式和构建配置。

任何准备交付、部署或让其他人继续开发的前端修改，都必须先进入对应源码文件，并通过 Git commit 留在仓库中。

### 2.2 构建产物不是源码

以下内容属于生成结果，不是可维护的源代码：

- `dist/`；
- `assets/*.js`、压缩后的 chunk；
- 带 hash 的 CSS、JS、图片及其他静态 bundle；
- 服务器 Web 根目录中直接复制的发布文件。

禁止把线上 bundle 当作正常开发入口，禁止直接编辑压缩 JS 后声称源码已更新。Source map 也不能替代完整源码、依赖清单和构建配置。

服务器 2026-11-08 Web release 的部分内容目前只有构建产物，缺少完整可编辑源码。这是历史交接缺口，不代表这些 bundle 可以作为新的源码基线。需要复用其行为时，先对照现有 `apps/web` 源码和线上页面，明确差异；不能直接用旧源码全量构建覆盖服务器补丁。

### 2.3 每次前端交付必须留下什么

一个前端任务至少留下：

1. 可编辑源码及必要静态资源；
2. 对应测试或明确的人工验收步骤；
3. 依赖与锁文件变化（没有变化就不改锁文件）；
4. 构建命令和实际结果；
5. PR 对应的 commit SHA；
6. 如果部署，另留发布记录，标明实际部署的构建产物来自哪个 SHA。

构建产物可以作为 CI artifact、Release 附件或服务器发布包保存，不要求把每次生成的 bundle 反复提交到源码目录。关键是必须能够从记录的源码 SHA 和锁文件重建它。

## 3. 版本到底以什么为准

### 3.1 不以“最新文件”“昨天的版本”作为版本号

Git commit SHA 是代码版本的唯一定位依据。分支名（例如 `main`）会移动，SHA 不会。

任何任务开始、PR 验收和发布记录，都要明确写出：

- 仓库：`Bruce-Yii/vivic-team`；
- 分支；
- 基线 SHA；
- 当前任务 HEAD SHA；
- 对应 PR / CI run。

“我本地是最新的”不是证据；“CI 通过”也必须对应当前 PR 的最新 HEAD SHA。新 push 后，旧 SHA 的绿灯不能代表新代码通过。

### 3.2 开工前同步

先检查本地状态和 remote，不允许直接照抄其他人的 Git 命令。

```bash
git status --short --branch
git remote -v
git fetch --all --prune
git log -1 --oneline --decorate
```

维护者的 `origin` 指向主仓库时：

```bash
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git switch -c task/<issue>-<scope>
```

从个人 fork 协作的贡献者：

- `origin` 指向自己的 fork；
- `upstream` 指向 `Bruce-Yii/vivic-team`；
- 开工前从 `upstream/main` 同步，不要误把个人 fork 的旧 `origin/main` 当作团队最新主线。

```bash
git fetch upstream --prune
git switch main
git pull --ff-only upstream main
git rev-parse HEAD
git switch -c task/<issue>-<scope>
```

如果本地有未提交改动，先确认归属并妥善提交或分离，再切换分支；禁止用 `reset --hard`、`clean -fdx` 或整目录覆盖来“同步”。

### 3.3 开发过程中同步

Git 不会自动把一个人的本地修改同步给其他人：

- 只在本地修改：别人看不到；
- commit 但没有 push：GitHub 和其他设备仍看不到；
- push 到个人 fork：其他人需要 fetch 对应远端分支；
- PR 合入 `main`：团队才有共同的新基线。

需要跨设备继续同一任务时，先 commit 并 push；另一台设备 fetch 后切到同一任务分支继续。不同 Agent 不得在同一个工作目录里同时切分支或覆盖同一批文件。

开发期间若 `main` 已前进：

1. 先保存当前任务改动；
2. fetch 主仓库；
3. 按仓库 Git 约定将最新 `main` 合入任务分支；
4. 解决冲突时保留双方意图，不用整文件覆盖；
5. 重新运行受影响的检查，再 push 更新 PR。

每个独立任务使用独立分支和 PR。PR 合入后，下一项任务从更新后的 `main` 新建分支，不继续复用旧基线。

## 4. 前后端接口必须按同一份契约协作

- `packages/contracts/` 是共享 API / 数据契约的维护入口；生成文件按仓库脚本更新，不能手工制造前后端两套定义。
- 后端新增字段或接口时，先定义类型、必填性、默认值、错误形状和兼容策略，再分别实现后端与前端。
- 优先采用向后兼容的增量变更：先让后端同时兼容旧、新调用，再更新前端；确认旧调用退出后，才考虑移除旧字段。
- 破坏性变更必须拆成迁移步骤，不能在同一个发布动作里让旧前端突然调用新后端，或让新前端依赖尚未部署的后端字段。
- Mock、fixture 和 Demo 数据必须标明；不能用 Mock 结果证明线上 API 已经可用。

后端任务如果没有修改 API 契约，不应要求前端跟着重构或重新发布。

## 5. 前端发布与服务器版本记录

发布必须遵循“从一个确定的源码 SHA 构建一次，再部署这一份产物”，不能在服务器上临时改源码、临时拼 bundle，最后无法追溯。

每次正式发布，在 `docs/operations/releases/` 下新增一份简短记录（目录不存在时再创建），至少包含：

| 字段 | 记录内容 |
| --- | --- |
| Release 时间 | 实际部署时间与时区 |
| Frontend source | 前端源码 commit SHA |
| Frontend artifact | 构建包名称及 SHA-256 |
| Backend source | 后端 commit SHA / 部署版本 |
| Contract | 使用的契约版本或对应 commit SHA |
| Build | Node、pnpm 版本及实际构建命令 |
| CI | 对应 PR、最新 HEAD SHA 和 CI run |
| Database | 是否涉及迁移；无迁移写明无 |
| Rollback | 上一个可恢复的前端/后端版本 |

发布前后都要记录服务器实际运行版本。不能只记录“已更新”或某个可变分支名。

如果发现服务器有仓库里没有的前端补丁：

1. 先备份并核对线上实际文件，不覆盖；
2. 确认差异属于哪个页面、资源和行为；
3. 尽可能恢复为可编辑源码，补入仓库并经 PR 审查；
4. 若无法恢复，明确标注为不可重建的历史补丁，保留其发布包和 hash；
5. 在源码补齐前，不得用旧源码构建产物覆盖它。

## 6. 任务验收清单

### 前端任务

- [ ] 修改落在 `apps/web` 的可编辑源码中，不是只改服务器 bundle。
- [ ] 任务分支来自已记录的最新 `main` SHA。
- [ ] API 调用与 `packages/contracts` 对齐。
- [ ] 运行受影响的前端测试、类型检查和构建。
- [ ] PR 的最新 HEAD SHA 与检查结果一致。
- [ ] 若发布，发布记录能追溯到源码 SHA 和构建产物 hash。

### 后端任务

- [ ] 明确本次是否影响前端/API 契约。
- [ ] 未涉及前端时，不改前端文件、不重打前端包。
- [ ] 涉及契约时，先更新共享契约并提供兼容策略。
- [ ] 后端测试与集成验证对应当前任务 SHA。
- [ ] 不用前端旧 bundle、Mock 页面或静态截图冒充后端真实验收。

## 7. CI 当前基线与处理原则（2026-11-16）

本节记录首次恢复真实 GitHub Actions 运行后的事实，后续以更新的 CI run 为准。

- Run：`43903081638`；触发方式：`workflow_dispatch`；运行 HEAD：`84f878929e22cd2e8cca6c140a10923084c49089`。
- Ubuntu 和 Windows 的 install、contracts、typecheck、lint 均通过。
- 两个平台的 `pnpm test` 都明确暴露了 `contrib/mobile-console/tests/relay.test.ts:134` 的权限断言差异：测试期望 5 项，实际协议包含 6 项（新增 `image.read`）。应先确认权限设计，再更新实现或测试，不能直接放宽断言。
- Linux 的 web / local-api 测试进程在并行测试失败后被 `SIGKILL`；本次 CI 日志没有独立给出 web 25 个、local-api 15 个失败的完整报告。因此“41 个失败”不能仅凭这次 run 作为已核实结论，需按 workspace 独立复跑并保存日志。
- Build 步骤因前面的 Unit tests 失败而被跳过；本次 run 不构成构建通过证据。
- Browser smoke 为 9/10 通过。B02 在点击“关闭全屏提示”时，`.vivic-space-loading` 遮罩拦截了指针事件。需确认等待条件是否不足，或加载遮罩是否错误阻断交互；在修复并复跑前不能标记 Browser smoke 通过。

### CI 分层方案（尚待落实到 workflow）

下一次修改 CI workflow 时按以下结构落地，而不是删测试或把失败伪装成绿色。目前仓库 workflow 仍将 Unit tests 和 Build 放在同一个 checks job 中；本节是协作决策，不代表分层已经生效：

1. **Required quality gate**：依赖安装、契约检查、类型检查、Lint、构建。构建必须独立于单测失败运行，不能因为测试失败而被跳过。
2. **Unit test diagnostics**：web、local-api、mobile-console 分开运行并保留各自日志；存量失败未核清前可暂不作为全仓合并阻断项，但必须显示真实失败，不得标记为通过。
3. **Browser smoke**：独立展示和验收。B02 问题修复前保留失败状态，不得并入“41 个单测失败”统计。
4. **恢复门槛**：每个 workspace 的基线失败被复现、归因并修复后，再逐步把相应测试提升为 Required gate。

CI 工作流和 GitHub 分支保护的实际设置必须通过 GitHub 运行结果核实；写入本文不代表规则已经自动生效。

## 8. 给 Agent 的固定开工指令

```text
先读 README_FIRST.md、AGENTS.md、docs/GIT_WORKFLOW.md 和本文件。
开工前核对仓库、remote、分支、工作区状态及 main 的最新 SHA，并把基线 SHA 写入任务记录。
本任务以 Git 源码为准，不从服务器 dist/assets 反向开发；不得覆盖线上文件或擅自部署。
当前优先后端。只有任务明确要求时才改前端；涉及 API 时先对齐 packages/contracts，并写清向后兼容策略。
开发中通过 commit/push/PR 同步，不假设其他设备或 Agent 能看到本地未推送改动。
结束时报告改动文件、HEAD SHA、PR、实际测试/构建结果、未验证项及需要集成的接口。
```
