# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录与校准仪证书。

## 启动

```bash
PORT=3021 node server.js
```

## 接口

- `GET /health`
- `GET /certificates?status=active`
- `POST /certificates`
- `POST /certificates/:id/disable`
- `GET /clocks?qualified=true|false`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 校准仪证书门禁

复测（`POST /clocks/:id/retests`）必须携带 `certificateId`，且证书需同时满足：

1. **启用中**（`status === "active"`）——停用证书不得再用于复测；
2. **复测当天在有效期内**（`validFrom ~ validUntil`，按 UTC 自然日，首尾两天均有效，过期或未生效都不行）；
3. **精度等级达标**——证书 `accuracyGrade` 数值不大于钟表 `requiredAccuracyGrade`（数值越小精度越高，如 0.2 级优于 0.5 级，默认要求 0.5 级）。

任一不满足返回 **409**（错误体带 `code`：`CERTIFICATE_DISABLED` / `CERTIFICATE_NOT_VALID_ON_DAY` / `GRADE_NOT_QUALIFIED`），缺少 `certificateId` 返回 400；校验失败的复测**不会写入数据库**。

### 合格判定（全接口同一口径）

复测落库时只保存**测量判定**（`measurementQualified`：日差是否达标）。对外的最终合格状态 `qualified` 在读取时动态计算：

```
qualified = measurementQualified && 证书当前有效支撑
          （证书仍启用 + 复测当天在有效期内 + 精度等级达标）
```

因此：

- 证书被停用（或自然过期）后，依赖它的历史复测**不再支撑合格**，钟表随之变为不合格，旧记录仍然保留可查；
- 换用新的有效证书重新复测且测量达标后，钟表才恢复合格（以最新一次复测为准）；
- `GET /clocks`、`GET /clocks/not-qualified`、`GET /clocks/:id/history`、`GET /clocks/:id/latest-retest`、`GET /retests` 的 `qualified` 判断完全一致，均由同一序列化函数输出；
- 每条复测额外返回：`measurementQualified`（测量判定原值）、`certificateValid`、`certificate`（证书快照）、`notQualifiedReason` / `notQualifiedMessage`（不合格原因，如 `CERTIFICATE_DISABLED`、`MEASUREMENT_NOT_QUALIFIED`）。

## 闭环示例

```bash
# 1. 用有效证书复测，测量达标 -> qualified: true
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"certificateId":"cert_witsim_01","note":"复测进入目标范围"}'

# 2. 停用证书（幂等）
curl -X POST http://127.0.0.1:3021/certificates/cert_witsim_01/disable

# 3. 再看列表/历史/最新复测，该复测 qualified 变为 false，原因 CERTIFICATE_DISABLED
curl http://127.0.0.1:3021/clocks
curl http://127.0.0.1:3021/clocks/clock_demo/history

# 4. 过期证书复测 -> 409，不落库
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":10,"amplitude":250,"certificateId":"cert_witsim_expired"}'

# 5. 登记新证书并重测 -> 恢复合格
curl -X POST http://127.0.0.1:3021/certificates \
  -H 'Content-Type: application/json' \
  -d '{"instrumentName":"Witschi CH-320","certificateNo":"JL-2026-0301","accuracyGrade":0.2,"validFrom":"2026-09-01","validUntil":"2027-09-01"}'
```
