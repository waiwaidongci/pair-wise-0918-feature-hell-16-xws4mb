const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

// 复测引用的校准仪证书精度等级门槛：数值越小精度越高，需 <= 该值
const REQUIRED_ACCURACY_GRADE = 0.5;

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
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
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  certificates: [
    {
      id: "cert_demo",
      instrumentCode: "CAL-9000-01",
      instrumentName: "机械表校表仪",
      accuracyGrade: 0.2,
      validFrom: "2026-01-01",
      validUntil: "2026-12-31",
      status: "active",
      note: "示例校准仪证书",
      createdAt: new Date().toISOString()
    }
  ]
};

const routes = [
  "GET /health",
  "GET /certificates",
  "POST /certificates",
  "GET /certificates/:id",
  "POST /certificates/:id/deactivate",
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
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  db.clocks = db.clocks || [];
  db.adjustments = db.adjustments || [];
  db.retests = db.retests || [];
  db.certificates = db.certificates || [];
  return db;
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

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) fail(404, "钟表不存在");
  return clock;
}

function findCertificate(db, certificateId) {
  const certificate = db.certificates.find((item) => item.id === certificateId);
  if (!certificate) fail(404, "校准仪证书不存在");
  return certificate;
}

// 取 ISO 日期（UTC 天），非法输入返回 null
function dayOf(value) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

// 证书在复测使用当天是否处于有效期内（起止日均含当天）
function certificateValidOn(certificate, testedAt) {
  const day = dayOf(testedAt);
  const from = dayOf(certificate.validFrom);
  const until = dayOf(certificate.validUntil);
  if (!day || !from || !until) return false;
  return day >= from && day <= until;
}

function certificateOf(db, retest) {
  if (!retest || !retest.certificateId) return null;
  return db.certificates.find((item) => item.id === retest.certificateId) || null;
}

// 复测当前是否支撑合格：证书停用后，依赖它的历史复测不再支撑合格；
// 证书门禁上线前未引用证书的历史记录保留原判定
function effectiveQualified(db, retest) {
  if (!retest || !retest.qualified) return false;
  if (!retest.certificateId) return true;
  const certificate = certificateOf(db, retest);
  return Boolean(certificate && certificate.status === "active");
}

// 输出视图：qualified 为当前有效判定，recordedQualified 保留复测当时的记录
function serializeRetest(db, retest) {
  if (!retest) return null;
  const certificate = certificateOf(db, retest);
  return {
    ...retest,
    recordedQualified: Boolean(retest.qualified),
    qualified: effectiveQualified(db, retest),
    certificateStatus: certificate ? certificate.status : null,
    certificate
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
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: serializeRetest(db, retest),
    qualified: retest ? effectiveQualified(db, retest) : false
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
    required(body, ["instrumentCode", "accuracyGrade", "validFrom", "validUntil"]);
    const accuracyGrade = Number(body.accuracyGrade);
    if (!Number.isFinite(accuracyGrade) || accuracyGrade <= 0) {
      fail(400, "accuracyGrade 必须是正数，数值越小精度越高");
    }
    const validFrom = dayOf(body.validFrom);
    const validUntil = dayOf(body.validUntil);
    if (!validFrom || !validUntil) fail(400, "validFrom/validUntil 必须是合法日期");
    if (validFrom > validUntil) fail(400, "validFrom 不能晚于 validUntil");
    const certificate = {
      id: makeId("cert"),
      instrumentCode: body.instrumentCode,
      instrumentName: body.instrumentName || "",
      accuracyGrade,
      validFrom,
      validUntil,
      status: "active",
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.certificates.push(certificate);
    await writeDb(db);
    return send(res, 201, { data: certificate });
  }

  const deactivateMatch = pathname.match(/^\/certificates\/([^/]+)\/deactivate$/);
  if (deactivateMatch && req.method === "POST") {
    const certificate = findCertificate(db, deactivateMatch[1]);
    const body = await parseBody(req);
    if (certificate.status !== "deactivated") {
      certificate.status = "deactivated";
      certificate.deactivatedAt = new Date().toISOString();
      certificate.deactivateReason = body.reason || "";
      await writeDb(db);
    }
    return send(res, 200, { data: certificate });
  }

  const certificateMatch = pathname.match(/^\/certificates\/([^/]+)$/);
  if (certificateMatch && req.method === "GET") {
    return send(res, 200, { data: findCertificate(db, certificateMatch[1]) });
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
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
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
      .map((item) => serializeRetest(db, item));
    return send(res, 200, {
      data: { clock, adjustments, retests, latestRetest: serializeRetest(db, latestRetest(db, clock.id)) }
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
    const certificate = findCertificate(db, body.certificateId);
    const testedAt = body.testedAt || new Date().toISOString();
    if (!dayOf(testedAt)) fail(400, "testedAt 不是合法时间");
    if (certificate.status !== "active") fail(409, "校准仪证书已停用，不能用于复测");
    if (!certificateValidOn(certificate, testedAt)) fail(409, "校准仪证书在复测当天不在有效期内");
    if (Number(certificate.accuracyGrade) > REQUIRED_ACCURACY_GRADE) {
      fail(409, `校准仪证书精度等级不达标，需达到 ${REQUIRED_ACCURACY_GRADE} 级或更高精度`);
    }
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      certificateId: certificate.id,
      testedAt,
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: serializeRetest(db, retest), clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: serializeRetest(db, latestRetest(db, latestMatch[1])) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests
      .map((item) => serializeRetest(db, item))
      .filter((item) => {
        const matchClock = !clockId || item.clockId === clockId;
        const matchQualified = qualified === null || item.qualified === (qualified === "true");
        return matchClock && matchQualified;
      });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
