const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

// 钟表校表默认要求的仪器精度等级（数值越小精度越高，如 0.2 级优于 0.5 级）
const DEFAULT_REQUIRED_GRADE = 0.5;

const initialData = {
  certificates: [
    {
      id: "cert_witsim_01",
      instrumentName: "Witschi CH-318 校表仪",
      certificateNo: "JL-2026-0188",
      accuracyGrade: 0.2,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      status: "active",
      note: "在有效期内，精度等级满足常规机械表复测",
      createdAt: "2026-01-02T00:00:00.000Z",
      disabledAt: null
    },
    {
      id: "cert_witsim_expired",
      instrumentName: "老式机械校表仪",
      certificateNo: "JL-2024-0066",
      accuracyGrade: 0.5,
      validFrom: "2024-01-01T00:00:00.000Z",
      validUntil: "2024-12-31T00:00:00.000Z",
      status: "active",
      note: "证书已过期，仅用于门禁校验测试",
      createdAt: "2024-01-05T00:00:00.000Z",
      disabledAt: null
    }
  ],
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      requiredAccuracyGrade: 0.5,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      certificateId: "cert_witsim_01",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /certificates",
  "POST /certificates",
  "POST /certificates/:id/disable",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function conflict(message, code) {
  return httpError(409, message, code);
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在", "CLOCK_NOT_FOUND");
  return clock;
}

function findCertificate(db, certificateId) {
  const cert = db.certificates.find((item) => item.id === certificateId);
  if (!cert) throw httpError(404, "校准仪证书不存在", "CERTIFICATE_NOT_FOUND");
  return cert;
}

function requiredGrade(clock) {
  return Number(clock.requiredAccuracyGrade ?? DEFAULT_REQUIRED_GRADE);
}

// 取某日期的 UTC 零点时间戳，按“天”比较，证书有效期首尾两天均视为有效
function dayTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(400, `日期格式无效：${value}`, "INVALID_DATE");
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function certificateValidOnDay(cert, isoAt) {
  const day = dayTimestamp(isoAt);
  return day >= dayTimestamp(cert.validFrom) && day <= dayTimestamp(cert.validUntil);
}

// 证书能否在某次复测中支撑“合格”：启用中 + 复测当天在有效期内 + 精度等级达标。
// 这是列表 / 历史 / 最新复测等所有接口共用的唯一判定口径。
function evaluateCertificate(db, clock, retest) {
  const cert = db.certificates.find((item) => item.id === retest.certificateId) || null;
  if (!cert) {
    return { valid: false, reason: "NO_CERTIFICATE", message: "复测未关联校准仪证书", certificate: null };
  }
  const snapshot = {
    id: cert.id,
    instrumentName: cert.instrumentName,
    certificateNo: cert.certificateNo,
    accuracyGrade: cert.accuracyGrade,
    validFrom: cert.validFrom,
    validUntil: cert.validUntil,
    status: cert.status
  };
  if (cert.status !== "active") {
    return { valid: false, reason: "CERTIFICATE_DISABLED", message: "校准仪证书已停用，历史复测不再支撑合格", certificate: snapshot };
  }
  if (!certificateValidOnDay(cert, retest.testedAt)) {
    return { valid: false, reason: "CERTIFICATE_NOT_VALID_ON_DAY", message: "校准仪证书在复测当天不在有效期内", certificate: snapshot };
  }
  if (Number(cert.accuracyGrade) > requiredGrade(clock)) {
    return { valid: false, reason: "GRADE_NOT_QUALIFIED", message: `校准仪精度等级 ${cert.accuracyGrade} 不满足要求（需优于 ${requiredGrade(clock)} 级）`, certificate: snapshot };
  }
  return { valid: true, reason: null, message: null, certificate: snapshot };
}

// 统一的复测序列化：qualified 为动态生效结果（测量达标且证书仍有效支撑），
// measurementQualified 保留落库时的测量判定，旧记录始终可查。
function serializeRetest(db, retest) {
  const clock = db.clocks.find((item) => item.id === retest.clockId);
  const fallbackClock = clock || { requiredAccuracyGrade: DEFAULT_REQUIRED_GRADE };
  const measurementQualified = Boolean(retest.qualified);
  const certCheck = evaluateCertificate(db, fallbackClock, retest);
  const qualified = measurementQualified && certCheck.valid;
  const reason = !certCheck.valid
    ? certCheck.reason
    : measurementQualified ? null : "MEASUREMENT_NOT_QUALIFIED";
  const message = !certCheck.valid
    ? certCheck.message
    : measurementQualified ? null : "测量结果超出目标日差，未达标";
  return {
    ...retest,
    measurementQualified,
    certificateValid: certCheck.valid,
    certificate: certCheck.certificate,
    notQualifiedReason: reason,
    notQualifiedMessage: message,
    qualified
  };
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const rawRetest = latestRetest(db, clock.id);
  const retest = rawRetest ? serializeRetest(db, rawRetest) : null;
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/certificates") {
    const status = url.searchParams.get("status");
    const data = db.certificates.filter((item) => !status || item.status === status);
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/certificates") {
    const body = await parseBody(req);
    required(body, ["instrumentName", "certificateNo", "accuracyGrade", "validFrom", "validUntil"]);
    const accuracyGrade = Number(body.accuracyGrade);
    if (Number.isNaN(accuracyGrade) || accuracyGrade <= 0) {
      throw httpError(400, "accuracyGrade 必须是正数", "INVALID_GRADE");
    }
    // 复用日期校验（非法格式抛 400），并保证起止顺序
    const validFrom = new Date(body.validFrom);
    const validUntil = new Date(body.validUntil);
    dayTimestamp(body.validFrom);
    dayTimestamp(body.validUntil);
    if (dayTimestamp(body.validFrom) > dayTimestamp(body.validUntil)) {
      throw httpError(400, "validFrom 不能晚于 validUntil", "INVALID_VALIDITY_RANGE");
    }
    if (db.certificates.some((item) => item.certificateNo === body.certificateNo)) {
      throw conflict(`校准仪证书编号已存在：${body.certificateNo}`, "CERTIFICATE_NO_DUPLICATED");
    }
    const certificate = {
      id: makeId("cert"),
      instrumentName: body.instrumentName,
      certificateNo: body.certificateNo,
      accuracyGrade,
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
      status: "active",
      note: body.note || "",
      createdAt: new Date().toISOString(),
      disabledAt: null
    };
    db.certificates.push(certificate);
    await writeDb(db);
    return send(res, 201, { data: certificate });
  }

  const certDisableMatch = pathname.match(/^\/certificates\/([^/]+)\/disable$/);
  if (certDisableMatch && req.method === "POST") {
    const certificate = findCertificate(db, certDisableMatch[1]);
    if (certificate.status !== "active") {
      return send(res, 200, { data: certificate }); // 停用是幂等操作
    }
    certificate.status = "disabled";
    certificate.disabledAt = new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: certificate });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const requiredAccuracyGrade = Number(body.requiredAccuracyGrade ?? DEFAULT_REQUIRED_GRADE);
    if (Number.isNaN(requiredAccuracyGrade) || requiredAccuracyGrade <= 0) {
      throw httpError(400, "requiredAccuracyGrade 必须是正数", "INVALID_GRADE");
    }
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      requiredAccuracyGrade,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt))
      .map((item) => serializeRetest(db, item));
    const rawLatest = latestRetest(db, clock.id);
    const latestSerialized = rawLatest ? serializeRetest(db, rawLatest) : null;
    return send(res, 200, {
      data: {
        clock: { ...clock, qualified: latestSerialized ? latestSerialized.qualified : false },
        adjustments,
        retests,
        latestRetest: latestSerialized
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude", "certificateId"]);

    // 门禁校验先行，任一不满足直接 409，且在 writeDb 之前抛出 → 不落库
    const certificate = findCertificate(db, body.certificateId);
    const testedAt = body.testedAt || new Date().toISOString();
    dayTimestamp(testedAt); // 回填历史复测时校验日期格式
    if (certificate.status !== "active") {
      throw conflict("校准仪证书已停用，不能用于复测", "CERTIFICATE_DISABLED");
    }
    if (!certificateValidOnDay(certificate, testedAt)) {
      throw conflict("校准仪证书在复测当天不在有效期内（过期或未生效）", "CERTIFICATE_NOT_VALID_ON_DAY");
    }
    if (Number(certificate.accuracyGrade) > requiredGrade(clock)) {
      throw conflict(
        `校准仪精度等级 ${certificate.accuracyGrade} 不满足该表要求（需优于 ${requiredGrade(clock)} 级）`,
        "GRADE_NOT_QUALIFIED"
      );
    }

    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    // qualified 落库的是“测量判定”；最终生效合格状态在读取时结合证书动态计算
    const measurementQualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      certificateId: certificate.id,
      testedAt: new Date(testedAt).toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified: measurementQualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: serializeRetest(db, retest), clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    const rawLatest = latestRetest(db, latestMatch[1]);
    return send(res, 200, { data: rawLatest ? serializeRetest(db, rawLatest) : null });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests
      .filter((item) => !clockId || item.clockId === clockId)
      .map((item) => serializeRetest(db, item))
      .filter((item) => qualified === null || item.qualified === (qualified === "true"));
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    send(res, error.status || 500, {
      error: error.message || "服务器错误",
      ...(error.code ? { code: error.code } : {})
    });
  });
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
