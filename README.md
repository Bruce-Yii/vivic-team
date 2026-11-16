# VIVIC

VIVIC 是一个 Web 信息画布产品：用户用自然语言让 Agent 在画布上创建/操作卡片，并支持实时语音交互。

本仓库是团队协作基线（Public 开源可见，含第三方素材使用限制，见 LICENSES.md），包含服务器后端部署基线对应的源码、当前可取得的 Web 可编辑源码，以及 MOSS-Live 方向的全双工阶段成果。服务器 2026-11-08 Web release 的部分内容只有构建产物，没有完整可编辑源码，不属于本仓库可重建范围。

- 快速开始与能力边界：见 [README_FIRST.md](README_FIRST.md)
- 交接范围与验收状态：见 [HANDOFF.md](HANDOFF.md)
- 协作规则：见 [AGENTS.md](AGENTS.md)、[CONTRIBUTING.md](CONTRIBUTING.md)

## 组成

| 目录 | 说明 |
| --- | --- |
| `apps/web` | Web 前端（控制页 `/`、设置页 `/control`、展示页 `/display`） |
| `apps/local-api` | 本地 API：意图管线、卡片构建、Hosted Tasks、Space、语音/识别网关 |
| `apps/android` | Android WebView 壳（原 Android 客户端） |
| `contrib/mobile-console` | 手机遥控原型 |
| `packages/contracts` | 共享 Zod 契约（Action / Card / Space / ASR 传输） |
| `packages/card-runtime` | 卡片定义与运行时 |

## 技术栈

React 19 + Vite + Tailwind + Hark UI；Hono + SQLite；TypeScript；vitest + Playwright。

## 状态

功能可用性、真实/Mock 边界和已知失败见 [README_FIRST.md](README_FIRST.md) 第 3 节。不要把阶段成果当作完整产品。

## 许可证与第三方素材

见 [LICENSES.md](LICENSES.md)。使用前请核对第三方素材的授权范围。
