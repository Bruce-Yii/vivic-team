# 天气无城市时按客户端 IP 兜底（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `d806fc7`。
- 范围：只改后端源码/测试/文档；**不部署、不碰服务器、不跑线上 60 条**；单测本地跑。
- 结论：天气请求没说城市时，优先级从"浏览器定位 → 追问城市"改为
  **新鲜浏览器定位 → 客户端 IP 城市 → 追问城市**；服务器自己的出口位置不再被当成用户位置。

## 1. 问题：服务器拿到的是机房位置

线上入口是 nginx 在同机回环上反代到应用，nginx 只转发了 `Host` 与
`X-Forwarded-Proto`。应用侧看到的 socket 对端一直是本机/容器网关，原来的
`https://ipinfo.io/json` 查询（不带 IP）解析的是**服务器出口**，也就是机房或云厂商
出口城市，不是用户所在城市。用这个结果回答"我这边天气"会稳定地答错城市。

修法必须从源头做：让请求带上用户 IP，再按这个 IP 查城市。只在应用里换一个
"网络位置"实现是治不好的，因为真实 IP 根本没到应用。

## 2. 客户端 IP 怎么取、什么时候信

新增 `apps/local-api/src/clientIp.ts`，是唯一的 IP 边界：

1. 取 `X-Real-IP`；没有或不是合法 IP 时取 `X-Forwarded-For` 的**第一跳**。
2. 只接受 IPv4/IPv6 字面量（`node:net` 的 `isIP`），去掉方括号与 `%zone`，
   `::ffff:1.2.3.4` 归一成 `1.2.3.4`。主机名、端口、路径、超长值一律视为没有 IP。
3. **只有请求的 socket 远端地址是回环时才相信这两个头**（nginx 与应用同机）。
   非回环来源伪造 `X-Real-IP` 会被忽略，按"没有 IP"处理。
4. `VIVIC_TRUST_PROXY_IP=off` 完全关闭这条信任（默认 on；unset 也是 on）。
   配置写在 `LocalApiConfig.trustProxyIp`，`loadConfig()` 与
   `online/appFactory.ts` 都读取同一个环境变量。

取到的 IP **只存在于当前请求的内存里**：不写日志、不进 intent log、不落库、
不返回给客户端；区域缓存只拿它当 Map 的 key。

### 2.1 在线会话的桥接

线上 `online/index.ts` 是唯一看得到 socket 的边界。它按上面的规则解析一次，然后把
结果放进内部头 `x-vivic-client-ip`（先删掉浏览器可能自带的值）传给 hosted service；
hosted service 只在转发 `/api/intent`、`/api/weather/here`、`/api/locale` 这些路由时
把它交给会话 app。会话 app 在 online 模式下接受这个内部头；本地模式永远不接受它
（本地 app 直接可达，客户端可以伪造）。

普通浏览器请求在 online 链路上进不了这个头：hosted service 与会话桥都是重新构造
Request、只复制白名单头。

## 3. 按 IP 查城市

`data/deviceRegion.ts` 的 `createRegionLocator` 现在接受 `{ ip?: string }`：

| 情况 | 请求 | 说明 |
|---|---|---|
| 有合法 IP | `https://ipinfo.io/<ip>/json` | IPinfo 是权威 IP 库；缓存按 IP 分键 |
| 无 IP（本地开发） | `https://ipinfo.io/json` | 与改动前完全一致 |
| `VIVIC_IP_REGION_ENDPOINT` 覆盖 | `new URL("<ip>/json", endpoint)` | 覆盖点必须是 ipinfo 兼容路径，便于以后换成自建 MaxMind 服务 |

解析 schema、只取 `city/region/country/loc`、30 分钟内存缓存、失败不缓存，全部保持
原样。新增两点：

- 缓存是 `Map<ip, region>`，空字符串代表"服务器自己的网络"；最多 256 条，超出按插入
  顺序淘汰最旧的一条，避免公网大量不同 IP 把内存撑大。
- 只有城市与坐标估计进入后续 GeoNames 匹配；IP、ISP、邮编仍被 schema 丢弃。
  非法 IP 不会拼进 URL，直接按"没有 IP"处理。

## 4. 天气链路与口播

`data/index.ts` 的 `weatherHere(position, signal, ip?, day?, timeZone?)`：

```
config.deviceLocation 关闭        → clarify
position 且 isFreshPosition       → 用浏览器定位（lookupWeatherAt）
networkRegionFallback 关闭        → clarify
online 且没有可信 IP               → clarify（网络回退需要 IP）
否则                              → 按 IP 查城市 → lookupWeatherNear
查不到/请求失败                    → clarify
```

- `WeatherEvidence.basis` 标注 `"device"` 或 `"network"`；用户自己说了城市时不标。
- 网络城市的口播改成 **"已按你的网络位置显示上海当前天气"**，与设备定位的
  "已按当前位置显示…"区分开；`localeAnswer` 仍是"按网络大致判断你在…附近"。
- `weatherCardFields` 的 `sourceData` 语义不变：设备定位仍是
  `locationBasis: "device-geolocation"` 并带取整坐标，网络估计仍是
  `network-region-estimate` 且不存 IP/坐标估计。
- `/api/intent` 的请求在 `app.ts` 边界解析 IP，经内部 `IntentRequest.clientIp` 传到
  pipeline，再传给 `handleDataIntent` / `locale`；`clientIp` 不接受 HTTP body 提供。
- `/api/weather/here` 与 `/api/locale` 走同一条信任链。

### 4.1 在线配置

`app.ts` 的 online 分支从

```ts
config: { deviceLocation: true, networkRegionFallback: false }
```

改为

```ts
config: { deviceLocation: true, networkRegionFallback: true, networkRegionFallbackRequiresIp: true }
```

即：**有可信 IP 才允许网络回退；没有 IP 时行为与今天完全一致（追问城市）**。
本地开发仍允许不带 IP 的 `ipinfo.io/json`，方便本机调试。

## 5. 隐私

- IP 不写日志、不进 intent log、不落库、不返回客户端；只作为本次请求的一次查询参数
  和 30 分钟缓存 key。
- 卡片与 envelope 里没有 IP、ISP、邮编；单测直接断言序列化后的卡片不含测试 IP。
- 缓存是进程内的，重启即清空；没有跨用户共享的城市结果（key 是 IP 本身，但值只有城市）。
- nginx 侧不要新增包含 query/body/Authorization/Cookie 的日志；本方案只增加两个转发头。

## 6. 部署时 nginx 需要补的两行

仓库里的 `deploy/online/nginx-location.conf` 在 IP 相关头上目前只有
`X-Forwarded-For $remote_addr`，没有 `X-Real-IP`。部署时在现有 `location /` 里补上
（本轮不改服务器）：

```nginx
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

第二行会覆盖已有的 `X-Forwarded-For $remote_addr`；应用只取第一跳，所以即使上游还有
代理，取到的也是最近一跳的真实客户端地址。其余行（`Host`、`X-Forwarded-Proto`、
`proxy_buffering off` 等）保持不动。

**未验证 / 部署注意**：`deploy/online/compose.yaml` 把容器端口发布在
`127.0.0.1:8790`。Docker 的端口发布会让容器内看到的 socket 对端是网桥网关
（如 `172.17.0.1`），不是回环，因此当前"只信回环"的规则在该拓扑下会**拿不到 IP**
（行为回退为追问城市，不会用错城市）。可选做法：

1. 让服务使用 host network，使 nginx 与应用的 socket 对端确实是 `127.0.0.1`；
2. 或后续增加"可信代理网段"配置（本轮未实现）。

这一点必须在真正部署前在目标机器上用 `ss`/日志确认，本轮没有碰服务器，属于未验证项。

## 7. 更权威的方向：MaxMind GeoLite2-City

IPinfo 是权威库，但生产可换成 **MaxMind GeoLite2-City 离线库**：把 `.mmdb` 放在本机、
定期更新，由一个本地只读服务（或进程内 `maxmind` 读取器）实现与
`https://ipinfo.io/<ip>/json` 相同的响应形状，然后把 `VIVIC_IP_REGION_ENDPOINT`
指向它。好处是查询不出网、没有第三方配额、城市精度更高；代价是要引入二进制库与
数据库更新流程，因此**本轮不引入二进制依赖**。当前实现把"按 IP 取城市"收敛在一个
locator 与一个可覆盖 endpoint 上，届时只需替换 endpoint 与解析实现，天气链路不需要改。

## 8. 测试

新增 `apps/local-api/tests/ip-region.test.ts`（15 条，mock fetch）：

- IP 字面量归一与非法值拒绝；回环才信任、非回环/关闭开关忽略；
  `X-Real-IP` 优先、`X-Forwarded-For` 取第一跳；
- online + `x-vivic-client-ip: 1.2.3.4`：天气无城市 → 用 IP 城市出卡，口播含"网络位置"，
  URL 是 `/1.2.3.4/json`，卡片不含 IP；
- online 无 IP → 追问城市，provider 一次都没调用；
- 伪造/非法内部头 → 追问，不查询；
- local 回环 + `X-Real-IP` → 用 IP；非回环伪造 → 退回 `/json`，从不使用伪造 IP；
- `VIVIC_TRUST_PROXY_IP=off` → 忽略头；
- 新鲜浏览器定位优先于 IP，且不请求 IPinfo；
- `/api/weather/here` 与 `/api/locale` 共用同一 IP，区域只查一次；
- 30 分钟缓存按 IP 分键，换 IP 会重新查询；非法 IP 不会被拼进 URL；
- `VIVIC_IP_REGION_ENDPOINT` 覆盖后，按 IP 请求解析为覆盖端点下的 `<ip>/json`，
  `basis` 为 `network`。

更新 `data.test.ts` 两处旧口播断言（"已按网络定位…" → "已按你的网络位置…"）。
`online-app.test.ts` 的既有断言（无 IP 时 clarify、新鲜定位优先）保持不变并通过。

## 9. 验证与未验证项

实际执行（日志在 `work/ip-region/`）：

- 定向：`vitest run tests/ip-region.test.ts tests/data.test.ts tests/online-app.test.ts` → 133 passed；
- 全量：`pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  - HEAD `d806fc7` 基线：**8 failed / 2604 passed / 3 skipped**（5 个文件失败）；
  - 本轮：**8 failed / 2619 passed / 3 skipped**（同样 5 个文件失败）；
  - `Compare-Object` 逐条比对失败集合：**差集 0**（清单 `work/ip-region/baseline-failures.txt`、
    `after-failures.txt`）；新增 15 条断言全部通过；
- `pnpm --filter @vivic/local-api typecheck`：只剩既有 `tests/helpers.ts` 错误；
- `oxlint` 改动文件：0。

未验证：

- 真实 nginx → 应用的 IP 透传（没碰服务器）；
- Docker 端口发布拓扑下的 socket 对端（见 §6，预计需要 host network 或网段信任）；
- 线上 60 条验收（硬约束禁止本轮运行）。
