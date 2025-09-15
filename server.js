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
const { keycloak, memoryStore } = require("./services/keycloak-config.js");

const db = require("./services/database.js");
// 메인(크립토) DB 풀
const pool = db.pool;
// QnA 전용 풀 (questions/answers/comments/categories)
const { qnaPool } = require("./services/database.js");
const { sendDeletionConfirmationEmail } = require("./services/email.js");

const app = express();

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(
  session({
    secret: "replace-with-strong-secret", // 실제 운영용 키로 교체
    resave: false,
    saveUninitialized: true,
    store: memoryStore,
  })
);
app.use(keycloak.middleware({ logout: "/logout" }));

app.get('/mypage.html', keycloak.protect());
app.get('/realtime.html', keycloak.protect());
app.get('/crypto.html', keycloak.protect());
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
    // 거래 관련 컬럼이 없으면 추가 (사용자별로 초기 잔고 설정)
    await db.pool.execute(`
      UPDATE users 
      SET 
        krw_balance = COALESCE(krw_balance, 1000000),
        btc_balance = COALESCE(btc_balance, 0.00000000),
        eth_balance = COALESCE(eth_balance, 0.00000000),
        xrp_balance = COALESCE(xrp_balance, 0.00000000)
      WHERE id = ?
    `, [user.id]);
  } catch (error) {
    // 컬럼이 없는 경우 무시 (테이블 스키마가 아직 업데이트되지 않음)
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
      res.send(
        "<h1>회원 탈퇴가 예약되었습니다.</h1><p>14일 이내에 다시 로그인하시면 탈퇴가 취소됩니다. 이 창은 닫으셔도 좋습니다.</p>"
      );
    } else {
      res
        .status(400)
        .send("<h1>잘못된 요청입니다.</h1><p>유효하지 않거나 만료된 토큰입니다.</p>");
    }
  } catch (error) {
    console.error("Failed to confirm deletion:", error);
    res.status(500).send("<h1>오류 발생</h1><p>탈퇴 처리 중 오류가 발생했습니다.</p>");
  }
});

// ---------------------- 보호 페이지 ----------------------
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

// ===== qna 라우트 연결 (qna.js) =====
const registerQnaRoutes = require('./qna');
registerQnaRoutes(app);

// ===== 실시간 거래 모듈 연결 (trading 통합) =====
let tradingWebSocketManager = null;
try {
  const APIRouter = require('./trading/routes/api-router');
  const TradingService = require('./trading/services/trading-service');
  
  // DB 매니저와 서비스 초기화
  const tradingService = new TradingService(db, null); // WebSocket 매니저는 나중에 설정
  const apiRouter = new APIRouter(db, tradingService);
  
  // API 라우터 등록
  app.use('/api', apiRouter.router);
  
  console.log('✅ Trading 모듈이 성공적으로 통합되었습니다.');
} catch (error) {
  console.error('❌ Trading 모듈 통합 실패:', error.message);
  console.log('⚠️ 기본 realtime.js 모듈로 대체합니다.');
}

// ===== 시나리오 라우트 연결 (scenario.js) =====
const registerScenarioRoutes = require("./scenario");
registerScenarioRoutes(app);

// ===== 실시간 기능 연결 (realtime.js) =====
const registerRealtime = require("./realtime");

// server & wss는 여기서 '한 번만' 생성
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Trading WebSocket 매니저 초기화 (통합된 경우에만)
if (tradingWebSocketManager === null) {
  try {
    const WebSocketManager = require('./trading/managers/websocket-manager');
    tradingWebSocketManager = new WebSocketManager(wss, db);
    tradingWebSocketManager.connect();
    console.log('✅ Trading WebSocket 매니저가 초기화되었습니다.');
  } catch (error) {
    console.error('❌ Trading WebSocket 매니저 초기화 실패:', error.message);
  }
}

// 실시간 기능 부착 후 disposer 받기
const realtimeDisposer = registerRealtime(app, wss);

// ===== 뉴스 리우트 연결(news.js) =====
const registerNews = require("./news");
registerNews(app);


// 종료 시 정리
process.on('SIGINT', () => { realtimeDisposer.close(); process.exit(0); });
process.on('SIGTERM', () => { realtimeDisposer.close(); process.exit(0); });

// 🔧 새로 추가: 사용자 거래 잔고 초기화 함수 (로그인 라우트들 뒤쪽에 추가)
async function initializeUserTradingBalance(user) {
  try {
    // 거래 관련 컬럼이 없으면 추가 (사용자별로 초기 잔고 설정)
    await db.pool.execute(`
      UPDATE users 
      SET 
        krw_balance = COALESCE(krw_balance, 1000000),
        btc_balance = COALESCE(btc_balance, 0.00000000),
        eth_balance = COALESCE(eth_balance, 0.00000000),
        xrp_balance = COALESCE(xrp_balance, 0.00000000)
      WHERE id = ?
    `, [user.id]);
  } catch (error) {
    // 컬럼이 없는 경우 무시 (테이블 스키마가 아직 업데이트되지 않음)
    console.log("거래 관련 컬럼 초기화 생략 (정상 동작)");
  }
}

// ---------------------- 탈퇴 스케줄러/종료 처리 ----------------------
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

// ---------------------- 서버 기동/종료 ----------------------
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, async () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  const ok = await db.testDBConnection();
  if (ok) console.log("데이터베이스 연결 확인됨");
  else console.warn("데이터베이스 연결 실패 - 일부 기능 제한 가능");
});

async function gracefulShutdown() {
  console.log("서버 종료 중...");
  try {
    if (upbitWs && upbitWs.readyState === WebSocket.OPEN) upbitWs.close();
  } catch {}
  try {
    await pool.end();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
