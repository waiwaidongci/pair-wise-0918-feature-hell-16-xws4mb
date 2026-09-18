# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录和校准仪证书。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /certificates?status=`
- `POST /certificates`
- `GET /certificates/:id`
- `POST /certificates/:id/deactivate`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 仪表证书门禁

- 复测（`POST /clocks/:id/retests`）必须提供 `certificateId`，引用已登记的校准仪证书。
- 证书必须同时满足：
  - 状态为 `active`（未停用）；
  - 在复测当天（`testedAt`，默认当前时间）处于 `validFrom` ~ `validUntil` 有效期内（起止日均含当天）；
  - 精度等级达标：`accuracyGrade <= 0.5`（数值越小精度越高）。
- 证书过期、停用或精度等级不达标时返回 `409`，复测记录不落库；证书不存在返回 `404`。
- 证书停用（`POST /certificates/:id/deactivate`）后，引用它的历史复测不再支撑合格：`/clocks`、`/clocks/not-qualified`、`/clocks/:id/history`、`/clocks/:id/latest-retest`、`/retests` 的合格判定一致变为不合格。
- 旧记录保留可查：复测输出中 `qualified` 为当前有效判定，`recordedQualified` 保留复测当时的记录，`certificateStatus` 标识所引用证书的当前状态。
- 换用新证书重新复测合格后，钟表恢复合格。

## 闭环示例

```bash
# 登记校准仪证书（精度0.2级，2026年有效）
curl -X POST http://127.0.0.1:3021/certificates \
  -H 'Content-Type: application/json' \
  -d '{"instrumentCode":"CAL-9000-02","accuracyGrade":0.2,"validFrom":"2026-01-01","validUntil":"2026-12-31"}'

# 查看待合格钟表
curl http://127.0.0.1:3021/clocks/not-qualified

# 引用证书复测
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"certificateId":"cert_demo","note":"复测进入目标范围"}'

# 证书停用后，依赖它的历史复测不再支撑合格
curl -X POST http://127.0.0.1:3021/certificates/cert_demo/deactivate
```
