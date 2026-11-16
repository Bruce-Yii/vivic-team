# 服务器清理记录（2026-11-05）

> 目标：服务器磁盘 38G/40G（93%），部署要求至少 2G 空闲。先备份“稳定可删”内容到本机，再删除。

## 1. 备份

- 位置（本机）：`vivic/backups/server-cleanup-20261105/`
- 内容：27 个文件，共 **1,977 MiB**（`tmp/` 12 个、`backend/` 15 个）
- 校验清单：[server-cleanup-20261105-manifest.json](server-cleanup-20261105-manifest.json)（每个文件的来源路径、字节数、SHA256）
- 备份时间：2026-11-05

## 2. 删除内容（A 类：无回滚价值）

| 来源 | 内容 | 大小 |
|---|---|---:|
| `/tmp` | 10-29~11-01 的打包备份/调试包（`vivic-*.tgz`、`ppt-*`、`claude-*` 等） | ~1.5G |
| `backend/`（根目录） | 10-30/31 的前端备份 zip/tar（`frontend-before-*`、`frontend-voice-v4`、`android-ui-*` 等） | ~450M |
| `/var/log` | 7 天前的轮转日志 | ~300M |
| Docker | 悬空镜像 + 构建缓存（保留当前与上一版镜像） | 数 G |

**不删**：当前 release、`frontend-current`、当前后端镜像、最新 DB 备份、`env.list`、生产数据、nginx/TLS。

## 3. 结果（2026-11-05 执行）

| 指标 | 清理前 | 清理后 |
|---|---:|---:|
| 磁盘已用 | 38G（93%，剩 3.0G） | **35G（88%，剩 5.1G）** |
| `/tmp` | 1.6G | **68M** |
| `/var/log` | 550M | 414M |
| `backend/`（根目录归档） | 684M | **213M** |
| `/var/lib/docker` | 15G | 15G（无悬空镜像可清，构建缓存仅回收 1.8M） |

- 回收约 **2.1G**；线上 `/healthz` 仍为 200，当前 release 与数据未动；
- Docker 的 15G 主要是历史 tagged 镜像层（保留回滚用），属于 B 类，未动；
- 备份与校验见 §1、§2。

## 4. 如果后面需要找回

从本机 `backups/server-cleanup-20261105/` 取对应文件，按 manifest 里的 `remote` 路径放回服务器即可；SHA256 可校验完整性。
