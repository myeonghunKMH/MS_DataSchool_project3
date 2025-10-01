require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const session = require("express-session");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
const { keycloak, memoryStore } = require("./config/keycloak.js");

const db = require("./config/database.js");
// 메인(크립토) DB 풀
const pool = db.pool;
// QnA 전용 풀
const { qnaPool } = require("./config/database.js");
const { sendDeletionConfirmationEmail } = require("./utils/email.js");
const mysql = require("mysql2");

// ===== Azure MySQL (뉴스 DB) 연결 설정 =====
const newsDbConnection = mysql.createPool({
  host: process.env.AZURE_MYSQL_HOST,
  port: parseInt(process.env.AZURE_MYSQL_PORT) || 3306,
  user: process.env.AZURE_MYSQL_USER,
  password: process.env.AZURE_MYSQL_PASSWORD,
  database: process.env.AZURE_MYSQL_DATABASE,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

newsDbConnection.getConnection((err, conn) => {
  if (err) {
    console.error('❌ Azure MySQL (뉴스 DB) 연결 실패:', err);
  } else {
    console.log('✅ Azure MySQL (뉴스 DB) 연결 성공!');
    conn.release();
  }
});

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: "replace-with-strong-secret",
    resave: false,
    saveUninitialized: true,
    store: memoryStore,
  })
);
app.use(keycloak.middleware({ logout: "/logout" }));

// 보호 페이지 (리포트 추가)
app.get('/report.html', keycloak.protect()); // ← 추가
app.get('/mypage.html', keycloak.protect());
app.get('/realtime.html', keycloak.protect());
app.get('/crypto.html', keycloak.protect());
app.get('/news.html', keycloak.protect());
app.get('/historical.html', keycloak.protect());
app.get('/scenario1.html', keycloak.protect());
app.get('/scenario2.html', keycloak.protect());
app.get('/scenario3.html', keycloak.protect());
app.use(express.static("public"));

// ---------------------- 공통 헬퍼 ----------------------
function getTokenContent(req) {
  return req?.kauth?.grant?.access_token?.content || null;
}
function isAdmin(req) {
  const t = getTokenContent(req);
  const roles = t?.realm_access?.roles || [];
  return roles.includes("admin");
}
function getLoginEmail(req) {
  return getTokenContent(req)?.email || null;
}
function getLoginName(req) {
  const t = getTokenContent(req);
  return t?.preferred_username || t?.name || "user";
}

// Keycloak 토큰에서 커스텀 속성(age, gender, city 등) 안전 추출
function getUserAttribute(tokenContent, key) {
  if (!tokenContent) return null;
  if (tokenContent[key] != null) return tokenContent[key];
  const attrs = tokenContent.attributes;
  if (attrs && attrs[key] != null) {
    const v = attrs[key];
    if (Array.isArray(v)) return v[0];
    return v;
  }
  return null;
}

// Keycloak admin 토큰
async function getKeycloakAdminToken() {
  const params = new URLSearchParams();
  params.append("client_id", process.env.KEYCLOAK_ADMIN_CLIENT_ID);
  params.append("client_secret", process.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");

  const { data } = await axios.post(
    `${process.env.KEYCLOAK_SERVER_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
    params
  );
  return data.access_token;
}

// ---------------------- 로그인 사용자 동기화 ----------------------
app.use(async (req, res, next) => {
  if (req.kauth && req.kauth.grant) {
    try {
      const userProfile = req.kauth.grant.access_token.content;
      let user = await db.findOrCreateUser(userProfile);

      // 로그인 시 Keycloak의 age, gender, city를 가져와 DB(users)에 누락 시 채움
      const rawAge = getUserAttribute(userProfile, 'age');
      const age = rawAge != null && `${rawAge}`.trim() !== '' ? parseInt(`${rawAge}`, 10) : null;
      const gender = getUserAttribute(userProfile, 'gender');
      const city = getUserAttribute(userProfile, 'city');
      try {
        await db.updateUserDemographicsIfNull(user.keycloak_uuid, { age, gender, city });
      } catch (e) {
        console.warn('사용자 인구통계 업데이트 실패(무시 가능):', e?.message || e);
      }

      if (user.status === "deletion_scheduled") {
        await db.cancelDeletion(user.id);
        user = await db.getUserById(user.keycloak_uuid);
        user.deletion_cancelled = true;
      }

      await initializeUserTradingBalance(user);
      req.user = user;
    } catch (error) {
      console.error("User sync failed:", error);
      return res.status(500).json({ error: "Failed to sync user data." });
    }
  }
  next();
});

async function initializeUserTradingBalance(user) {
  try {
    await db.pool.execute(`
      UPDATE users 
      SET 
        krw_balance = COALESCE(krw_balance, 10000000),
        btc_balance = COALESCE(btc_balance, 0.00000000),
        eth_balance = COALESCE(eth_balance, 0.00000000),
        xrp_balance = COALESCE(xrp_balance, 0.00000000)
      WHERE id = ?
    `, [user.id]);
  } catch (error) {
    console.log("거래 관련 컬럼 초기화 생략 (정상 동작)");
  }
}

app.get("/api/user", keycloak.protect(), (req, res) => {
  if (req.user) res.json(req.user);
  else res.status(404).json({ error: "User not found" });
});

// ---------------------- 탈퇴 요청/확정 ----------------------
app.post("/api/user/request-deletion", keycloak.protect(), async (req, res) => {
  try {
    const { reason } = req.body;
    const user = req.user;
    const adminToken = await getKeycloakAdminToken();

    const { data: federatedIdentities } = await axios.get(
      `${process.env.KEYCLOAK_SERVER_URL}/admin/realms/${process.env.KEYCLOAK_REALM}/users/${user.keycloak_uuid}/federated-identity`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    const isSocialLogin = Array.isArray(federatedIdentities) && federatedIdentities.length > 0;

    if (reason) await db.createWithdrawalReason(user.id, reason);

    if (isSocialLogin) {
      await db.scheduleDeletionImmediately(user.id);
      res.status(200).json({ scheduled: true, message: "Deletion scheduled immediately." });
    } else {
      const token = crypto.randomBytes(32).toString("hex");
      await db.requestDeletion(user.id, token);
      const userProfile = req.kauth.grant.access_token.content;
      await sendDeletionConfirmationEmail(userProfile.email, token);
      res.status(200).json({ scheduled: false, message: "Deletion confirmation email sent." });
    }
  } catch (error) {
    console.error("Failed to request deletion:", error?.response?.data || error);
    res.status(500).json({ message: "Failed to request deletion." });
  }
});

app.get("/api/user/confirm-deletion", async (req, res) => {
  try {
    const { token } = req.query;
    const user = await db.confirmDeletion(token);
    if (user) {
      res.send("<h1>회원 탈퇴가 예약되었습니다.</h1><p>14일 이내에 다시 로그인하시면 탈퇴가 취소됩니다. 이 창은 닫으셔도 좋습니다.</p>");
    } else {
      res.status(400).send("<h1>잘못된 요청입니다.</h1><p>유효하지 않거나 만료된 토큰입니다.</p>");
    }
  } catch (error) {
    console.error("Failed to confirm deletion:", error);
    res.status(500).send("<h1>오류 발생</h1><p>탈퇴 처리 중 오류가 발생했습니다.</p>");
  }
});

// ---------------------- 보호 디렉토리 ----------------------
app.use('/secure', keycloak.protect(),
  express.static(path.join(__dirname, 'public', 'secure'))
);

// ---------------------- 헬스체크 ----------------------
app.get("/api/health", async (req, res) => {
  const ok = await db.testDBConnection();
  res.json({
    status: "ok",
    database: ok ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ===== qna 라우트 연결 =====
const registerQnaRoutes = require('./routes/qna');
registerQnaRoutes(app);

// ===== 실시간 거래 모듈 연결 =====
let tradingWebSocketManager = null;
let tradingService = null;
try {
  const APIRouter = require('./trading/routes/api-router');
  const TradingService = require('./trading/services/trading-service');

  tradingService = new TradingService(db, null);
  const apiRouter = new APIRouter(db, tradingService);
  app.use('/api', keycloak.protect(), apiRouter.router);

  console.log('✅ Trading 모듈이 성공적으로 통합되었습니다.');

  db.syncKeycloakUsers()
    .then(() => console.log('✅ 키클락 사용자 동기화 완료'))
    .catch(syncError => console.error('⚠️ 키클락 사용자 동기화 실패:', syncError.message));

  setInterval(async () => {
    try {
      console.log('🔄 정기 키클락 사용자 동기화 실행...');
      await db.syncKeycloakUsers();
    } catch (syncError) {
      console.error('⚠️ 정기 키클락 사용자 동기화 실패:', syncError.message);
    }
  }, 30 * 60 * 1000);
} catch (error) {
  console.error('❌ Trading 모듈 통합 실패:', error.message);
  console.log('⚠️ 기본 realtime.js 모듈로 대체합니다.');
}

// ===== 시나리오 라우트 연결 =====
const registerScenarioRoutes = require("./routes/scenario");
registerScenarioRoutes(app);

// ===== 실시간 기능 연결 =====
const registerRealtime = require("./routes/realtime");
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (tradingWebSocketManager === null) {
  try {
    const WebSocketManager = require('./trading/managers/websocket-manager');
    tradingWebSocketManager = new WebSocketManager(wss, db);
    tradingWebSocketManager.connect();
    if (tradingService) {
      tradingService.setWebSocketManager(tradingWebSocketManager);
      console.log('✅ TradingService에 WebSocket 매니저가 연결되었습니다.');
    }
    console.log('✅ Trading WebSocket 매니저가 초기화되었습니다.');
  } catch (error) {
    console.error('❌ Trading WebSocket 매니저 초기화 실패:', error.message);
  }
}

const realtimeDisposer = registerRealtime(app, wss);

// ===== 뉴스 라우트 연결 =====
const registerNews = require("./routes/news");
registerNews(app, newsDbConnection);

// ===== 리포트 라우트 연결 =====
const registerReport = require("./routes/report");
registerReport(app);

// ===== 보유자산(마이페이지) 라우트 연결 =====
const registerHoldings = require("./routes/holdings");
registerHoldings(app);
app.use('/mypage.js', express.static(path.join(__dirname, 'routes', 'mypage.js')));


// ===== AI 챗봇 프록시 =====
app.post("/api/chat", keycloak.protect(), async (req, res) => {
  const { model, messages } = req.body;
  const apiKey = process.env.LLM_API_KEY;
  const apiEndpoint = 'https://chat.itc.today/api/v1/chat/completions';

  if (!apiKey) {
    return res.status(500).json({ error: "LLM_API_KEY가 서버에 설정되지 않았습니다." });
    // server.js에 등록해 리포트 라우트를 활성화합니다. :contentReference[oaicite:11]{index=11}
  }

  try {
    const response = await axios.post(
      apiEndpoint,
      { model, messages, stream: false },
      { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    console.error("LLM API 프록시 오류:", error.response ? error.response.data : error.message);
    res.status(error.response?.status || 500).json({ error: "LLM API 호출 중 오류가 발생했습니다." });
  }
});

// 종료 시 정리
process.on('SIGINT', () => { realtimeDisposer.close(); process.exit(0); });
process.on('SIGTERM', () => { realtimeDisposer.close(); process.exit(0); });

// ---------------------- 탈퇴 스케줄러 ----------------------
async function deleteUserFromKeycloak(keycloak_uuid, adminToken) {
  try {
    await axios.delete(
      `${process.env.KEYCLOAK_SERVER_URL}/admin/realms/${process.env.KEYCLOAK_REALM}/users/${keycloak_uuid}`,
      { headers: { Authorization: `Bearer ${adminToken}` } }
    );
    console.log(`Successfully deleted user ${keycloak_uuid} from Keycloak.`);
  } catch (error) {
    console.error(`Failed to delete user ${keycloak_uuid} from Keycloak:`, error?.response?.data);
  }
}

async function runDeletionJob() {
  console.log("Running scheduled deletion job...");
  try {
    const usersToDelete = await db.findUsersToDelete();
    if (usersToDelete.length === 0) {
      console.log("No users to delete.");
      return;
    }
    const adminToken = await getKeycloakAdminToken();
    for (const user of usersToDelete) {
      console.log(`Processing deletion for user ID: ${user.id}`);
      await deleteUserFromKeycloak(user.keycloak_uuid, adminToken);
      await db.deleteUser(user.id);
      console.log(`Successfully deleted user ${user.id} from local database.`);
    }
  } catch (error) {
    console.error("Error during deletion job:", error);
  }
}
setInterval(runDeletionJob, 3600 * 1000);
runDeletionJob();

// ---------------------- 서버 기동 ----------------------
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, async () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  const ok = await db.testDBConnection();
  if (ok) console.log("데이터베이스 연결 확인됨");
  else console.warn("데이터베이스 연결 실패 - 일부 기능 제한 가능");
});

async function gracefulShutdown() {
  console.log("서버 종료 중...");
  try { if (upbitWs && upbitWs.readyState === WebSocket.OPEN) upbitWs.close(); } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
