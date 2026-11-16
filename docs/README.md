# 文档目录

> **当前入口**：[交接说明](../HANDOFF.md)（基线、范围、验证结果、已知问题）与 [根入口](../README_FIRST.md)（快速开始与能力边界）。
> 协作规则：[前端源码留存与版本同步](team/FRONTEND_SOURCE_AND_VERSION_SYNC.md)、[Git 约定](GIT_WORKFLOW.md)、[贡献指南](../CONTRIBUTING.md)。
> 服务器基线、部署与验收资料见 `operations/`、`deployment/`、[../tooling/](../tooling/)。

当前入口集中在下表。历史报告与归档源码不属于本仓库范围（`archive/`、`outputs/`、`work/` 等目录未纳入本仓库）。

## 开发必读

| 文档 | 用途 |
| --- | --- |
| [根入口](../README_FIRST.md) | 新人/Agent 的阅读顺序 |
| [贡献指南](../CONTRIBUTING.md) | 安装、启动、GitHub Desktop |
| [当前交接](AGENT_HANDOFF.md) | 当前任务与运行边界 |
| [交接说明](../HANDOFF.md) | 源码基线、纳入/排除范围、验证结果与已知问题 |
| [Git 约定](GIT_WORKFLOW.md) | 主仓库、fork、PR 与合入 |
| [团队任务边界](TEAM_TASKS.md) | 按核心依赖分工、接口和代码范围 |
| [历史团队分工快照](team/README.md) | 2026-10-20 的旧人员分工与工单，仅供溯源，不代表当前协作安排 |
| [Agent 协作流程](team/WORKFLOW.md) | 与具体仓库账号无关的通用开工、分支、提交与交接规则 |
| [前端源码留存与版本同步](team/FRONTEND_SOURCE_AND_VERSION_SYNC.md) | 明确原始仓库与协作者复刻仓库的边界，统一源码留存、Git SHA、分支、前后端契约与发布记录 |
| [参考资料交接](team/REFERENCES.md) | 每个人需要的代码、Skill、Hark 资料与缺失项 |
| [卡片开发契约](CARD_DEVELOPMENT.md) | 模型数据、Schema、事实来源、renderer、编辑与保存规则 |
| [单卡设计表](cards/CARD_SPEC_TEMPLATE.md) | 每张卡的参数、编辑权限、视觉、主题与验收模板 |
| [自定义卡片扩展设计](CARD_EXTENSION_DESIGN.md) | 已实现的声明式 v0.1 包协议、组件边界与后续路线 |
| [Vivic Test Space](CARD_TEST_SPACE.md) | 设置导入、校验、弹窗预览试跑、安装流程与隔离要求 |
| [首轮 GitHub 任务](tasks/card-platform-first-sprint.md) | CORE-01 / FE-01 / FE-02 / BE-01 的范围和验收草稿 |
| [飞猪旅游系列卡片](tasks/fliggy-travel-cards.md) | 首项系列卡片任务、MCP 能力核对及前后端分工 |
| [MOSS-Live 全双工架构约束](moss-live-full-duplex-architecture-constraints.md) | 实时音频、语义话轮、前后台协同、任务一致性与产品级 Exit Gate（当前有效） |
| [实施现状](implementation-status.md) | 已有功能与未验证项 |
| [本地功能路线](LOCAL_ROADMAP.md) | 新功能顺序与可分配范围 |
| [本轮整理记录](REPOSITORY_CLEANUP.md) | 保留、删除、归档的理由 |

## 按模块查阅

| 模块 | 文档 |
| --- | --- |
| 用户页与背景 | [用户页](user-page-20261017.md) |
| 画布与内容交互 | [画布](canvas-interaction.md)、[子卡片与选择](interaction-details.md) |
| 卡片 | [20 场景](scene-cards-20261017.md)、[基础数据卡片](data-cards.md) |
| 模型 | [模型与语音职责](provider-voice-architecture.md)、[连接稳定性](llm-connection-stability-20261017.md) |
| 外部数据 | [数据适配](data-providers.md)、[搜索回退](search-fallback-20261016.md)、[图片输入](image-input.md) |
| 语音 | [本地语音](local-speech.md)、[反馈](voice-feedback.md)、[Plan TTS](stepfun-plan-tts.md)、[ASR](stepfun-asr.md) |
| 实验能力 | [决策模型](local-decision.md)、[评估](decision-model-review.md)、[评测包](decision-model-test-kit.md)、[Laya 记录](laya-poc.md) |
| 决策接入候选 | `JevHarness 初步适配`，对应路线 L04 |
| 官网 | [内测入口现状](website-beta-only.md)、[联系信息](website-contact.md)，当前由维护者保管 |
| 许可证与素材 | [项目许可证清单](../LICENSES.md)、[图片来源](images/README.md)、`third-party/` |

## 验证与历史

本轮自动化事实见 [平台验收](verification/platform-20261021.md) 与 [传送门验收](verification/card-portal-20261022.md)；提交 GitHub 时的干净工作区复验结果以对应 PR 正文和当前 head 检查为准。[本地开发基线](verification/local-development-20261019.md) 保留作历史对照。`verification/` 的各报告均标记日期，不将它们合并成一次“全项目已验收”。

`research/`、PoC 文档、旧稳定性记录是按需查阅的研究资料。涉及历史框架/版本或功能行为时，优先查看当前源码和 [实施现状](implementation-status.md)。
