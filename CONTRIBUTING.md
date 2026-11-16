# 开发与协作

## 1. 先进入正确的仓库

`Bruce-Yii/vivic-team` 是原始基准仓库。后续协作前，由协作者将它复刻到自己的 GitHub 账号下，并把复刻后的仓库作为唯一工作区。

开始前先确认实际仓库完整名称：`<COLLABORATOR_OWNER>/<COLLABORATOR_REPO>`。确认所有参与者都已获得该仓库访问权限，再开始创建任务。

**不要把本文件中的原始仓库地址当作后续开发的 clone、push 或 PR 目标。**

详细规则见 [前端源码留存与协作仓库版本同步规范](docs/team/FRONTEND_SOURCE_AND_VERSION_SYNC.md) 和 [Git 协作约定](docs/GIT_WORKFLOW.md)。

## 2. 用 GitHub Desktop 或命令行开始

在 GitHub Desktop 中选择 **File → Clone repository**，输入协作者仓库地址：

```text
https://github.com/<COLLABORATOR_OWNER>/<COLLABORATOR_REPO>.git
```

核对 remote：

- `origin` 必须指向协作者仓库；
- 若是 GitHub Fork，可选配置 `upstream` 指向原始仓库 `Bruce-Yii/vivic-team`，只用于比较来源变化；
- 不要把 `upstream` 当成 PR 目标。

在终端核对：

```bash
git status --short --branch
git remote -v
git fetch --all --prune
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

如果协作者仓库的默认分支不是 `main`，使用仓库实际配置的分支名。

## 3. 开发与提交

1. 在协作者仓库创建 Issue，写明 Goal、Scope、Non-scope、允许修改的文件、接口、验收条件和禁止事项。
2. 从协作者仓库最新默认分支创建独立任务分支，例如 `task/42-resume-parser`。
3. 用编辑器或 Agent 开发；每个 Agent 使用独立工作目录 / worktree，不要共享一个目录同时切分支。
4. 检查差异和实际验证结果，commit 后 push 到协作者仓库。
5. 创建 PR，确认 base 是协作者仓库自己的默认分支，而不是 `Bruce-Yii/vivic-team:main`。
6. 在协作者仓库完成 Review 和合并；合并后所有成员同步该仓库的最新默认分支。

Commit 只保存在本机；没有 push 的内容，其他设备和 Agent 无法获取。跨设备交接时必须提供仓库名、分支和精确 SHA。

## 4. 两个仓库之间的边界

- 原始仓库只作为来源参考；后续任务、Issue、分支、PR 和集成都在协作者仓库。
- 不自动把原始仓库的 `main` merge 到协作者仓库。需要来源更新时先比较差异，再选择明确需要的提交或文件。
- 不擅自把原始仓库的临时运行状态、单次检查结果、自动化配置或其他窗口产物带入协作者仓库。
- 不擅自部署、修改生产配置或覆盖线上文件。

## 5. 开发约束

- 前端源码以协作者仓库中的 `apps/web/` 为准，不把服务器 `dist/` 或压缩 bundle 当作源码。
- 后端任务未明确涉及前端时，不改 Web 页面、不重打前端包。
- API 变化先对齐 `packages/contracts/`，并写清向后兼容策略。
- 不提交凭据、生产数据库、个人画布或线上配置。
- 不用 `git reset --hard`、`git clean -fdx` 或强推清理他人工作。
