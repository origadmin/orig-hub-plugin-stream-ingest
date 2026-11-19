# stream-ingest（在线流入库插件）

orig-hub 的通用 service 型插件：把「网页 HLS 流」经本机处理后生成 orig-hub 原生可播的 `.ohc` 合集。链路是「浏览 → 播放（切片转视频）→ 入库 ohc」。

## 脱敏与地址可变（硬约束）

- **本包内不含任何具体站点域名、品牌或专有路径**。站点特征只作为运行期用户输入存在，写到插件数据目录的 `config.json`（不进版本库，已被 `.gitignore` 忽略）。
- **主页地址不绑定、可变**：用户在配置中手动输入 `baseUrl`（含协议与可选路径前缀）。换站只改这个地址与三个路径模板，不改代码、不重新打包。

## 形态

- `kind = "service"`：独立 Node.js 进程，绑定回环 `127.0.0.1:19814`，由 hub daemon 代理到 `/api/plugin/stream-ingest/*`（BUG-855）。
- `provides = ["tasks","health"]`：入库/洗流进度走 `GET /tasks`（daemon 2s activity 节拍聚合），就绪走 `GET /health`。
- 零 npm 依赖：`node server.js` 即可启动（`crypto`/`http`/`https`/`child_process` 均为 Node 内置）。需要本机装有 `ffmpeg` / `ffprobe`（仅「准备期」用，播放期不调用）。

## 配置（用户手动输入）

启动后通过 `GET/POST /config` 或插件页设置（若宿主提供）写入，落 `ORIG_PLUGIN_DATA_DIR/config.json`（缺省 `./.stream-ingest-data/config.json`）：

```jsonc
{
  "baseUrl": "",                 // 必填：站点主页地址，可含路径前缀
  "paths": {
    "list": "/api/home/latest",
    "detail": "/api/videos/{id}",
    "playback": "/api/videos/{id}/episodes/{ep}/playback"
  },
  "headers": {},                 // 可选：附加请求头（如站点要求的 token）
  "outputDir": ""                // 可选：产物根目录，缺省插件数据目录/output
}
```

代理**不在本配置里**：插件清单只声明 `proxy_support = "optional"`，代理地址由 hub「网络与代理」里动态生成的插件通道统一保存；daemon 在启动插件时注入 `ORIG_PLUGIN_PROXY` / `ORIG_PLUGIN_PROXY_SOURCE`，插件只读注入值出网。`/health` 会回报 `proxyConfigured` / `proxySource`，不回显地址本身。

`{id}` / `{ep}` 是路径模板占位符，按目标站点实际结构修改。鉴权头名/值由 playback 响应给出，插件透传，不写死。

## 端点（经 daemon 代理 `/api/plugin/stream-ingest/*`）

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/config` | — | 当前配置（扁平键） |
| POST | `/config` | 配置对象 | 保存后的配置 |
| GET | `/health` | — | `{available, configured, proxyConfigured, proxySource, port, reason}` |
| GET | `/list?page=1` | — | `{items:[{id,title,score,episodeCount,playAt,desc,cover}]}` |
| GET | `/detail?id=` | — | `{id,title,desc,cover,episodes:[{ep,title,duration}]}` |
| GET | `/tasks` | — | `{rows:[ActivityTask]}` |
| POST | `/prepare` | `{id,ep}` | `{itemId,file,...codec}`（单集可播） |
| POST | `/ingest` | `{id,fromEp,toEp}` | `{ohcId,ohcPath,items}` |

## 切片转视频（怎么做的）

1. `POST` playback 路径模板 → 解析出 m3u8 地址 + 运行期鉴权头。
2. 拉 m3u8 → 解析 `EXT-X-KEY`（AES-128 / key URI / IV）与分片列表。
3. 有界并发（4）下载分片 + AES-128-CBC 解密（key 来自运行期 URL）。
4. `ffmpeg -f concat -c copy -movflags +faststart` 合并成自含 moov、可随机定位的单集 MP4（零重编码）。
5. `ffprobe` 实测 codec/时长/分辨率，写入 ohc 的 `codec` 字段；探测失败则该集 `playable=false` + `note`。

## ohc 与播放

- 入库产物：`<outputDir>/<id>/ep-<ep>.mp4` + `<outputDir>/<id>/collection.ohc`（schema=2，字段真源见 `orig-hub/docs/standards/ohc-format.md §2`）。一集一文件，base=0、total=文件大小。
- 播放不经过本插件：由 orig-hub 原生 `/ohc/meta` + `/ohc/segment/:id/:n` 做 206 Range 直投，`<video>` 原生播放、`ended` 连播，**播放期 ffmpeg = 0**（BUG-1044 A / playback-delivery-choice A′）。
- 本插件不引入 hls.js / MSE / `MediaSource`（A′ 红线）。

## 打包 / 安装

```
node scripts/package.cjs        # 生成 stream-ingest.ohplug
```

在 orig-hub「设置 → 插件 → 本地安装 .ohplug」安装；`service.base_url` 指向回环端口，daemon 自动代理。运行期用户输入（`.stream-ingest-data/`）不会被打进包。

## 设计文档

- `orig-hub/docs/design/decisions/stream-ingest-plugin-2026-11-19.md`（架构裁定 + 讨论节点台账）
- `orig-hub/docs/design/specs/feature-stream-ingest.md`（功能设计书，检索主线）
