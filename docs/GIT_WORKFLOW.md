# Git 协作约定

## 1. 仓库关系

- 原始基准仓库：`Bruce-Yii/vivic-team`，用于提供产品源码和历史基线。
- 实际协作仓库：由协作者复刻到自己账号下的仓库，具体 owner/name 在开工前登记。
- **所有后续开发都在实际协作仓库内完成。** 原始仓库不是本轮 Issue、分支、PR 或集成目标。

详细规则见 [前端源码留存与协作仓库版本同步规范](team/FRONTEND_SOURCE_AND_VERSION_SYNC.md)。

## 2. Clone 与 remote

所有成员和 Agent 都 clone 同一个实际协作仓库，不能各自从原始仓库重新 clone 后再靠手工传文件合并。

- `origin`：实际协作仓库，是日常 fetch / pull / push 的目标。
- 如果协作仓库是 GitHub Fork，可选配置 `upstream` 指向 `Bruce-Yii/vivic-team`，只用于比较来源变化；不作为 PR 目标。
- 如果协作仓库是独立复制，不要求配置原始仓库 remote。

开工前核对：

```bash
git status --short --branch
git remote -v
git fetch --all --prune
git branch --show-current
git rev-parse HEAD
```

确认 `origin` 指向实际协作仓库后，从它的默认分支创建任务分支：

```bash
git switch main
git pull --ff-only origin main
git rev-parse HEAD
git switch -c task/<issue>-<scope>
```

若默认分支不是 `main`，以 GitHub 仓库设置为准。

## 3. Issue、分支、PR 和合并

1. Issue 在实际协作仓库创建，写明目标、范围、禁止事项、接口和验收标准。
2. 每个独立任务从实际协作仓库最新默认分支创建独立分支。
3. commit 并 push 到实际协作仓库。
4. PR 的 base 和 head 都属于实际协作仓库；默认 base 是该仓库自己的默认分支。
5. 在实际协作仓库完成评审和合并。合并后其他成员从该仓库更新基线。

**不要**把 PR 的 base 设为 `Bruce-Yii/vivic-team:main`，除非用户明确要求向原始仓库贡献代码。

## 4. 多设备和多 Agent 同步

- 本地未提交改动不会自动同步给其他设备或 Agent。
- commit 但未 push，其他人仍无法获取。
- 跨设备交接时，先 push，再提供仓库名、分支和精确 SHA。
- 每个 Agent 使用独立 worktree / 工作目录和独立任务分支；不允许多个 Agent 在同一个目录中同时切分支或覆盖文件。
- 同一任务需要接力时，后续执行者先 fetch 指定分支，核对 SHA 和工作区状态，再继续。
- 任务分支合并后，下一项任务从实际协作仓库最新默认分支创建。

## 5. 原始仓库更新如何同步

不能无条件把原始仓库的 `main` merge 到实际协作仓库。需要同步来源更新时，先 compare commit 和文件差异，再明确选择需要的提交或文件；检查不会带入无关窗口产物、实验配置或自动化设置后，才在实际协作仓库集成。

## 6. 安全与保护

- 不用 `git reset --hard`、`git clean -fdx` 或强推清理他人工作。
- 不提交凭据、生产数据库、个人画布或线上配置。
- 不因解决冲突而整文件覆盖他人的有效改动。
- 不擅自部署、重启服务器或修改生产配置。
- 自动化工作流、仓库权限和分支保护由协作仓库所有者单独决定；本协作规范不迁移或修改这些设置。
