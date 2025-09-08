// server.js (완전 병합본: #시나리오1 + #시나리오2 + #realtime + #시나리오3)
// -------------------------------------------------------------------
// 환경 변수 로드 (.env의 MariaDB/PORT만 사용)
// -------------------------------------------------------------------
require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const session = require('express-session');
const crypto = require('crypto');
const { keycloak, memoryStore } = require('./keycloak-config.js');
const db = require('./database.js');
const pool = db.pool;
const { sendDeletionConfirmationEmail } = require('./email.js');

const app = express();
app.use(express.json()); // Add this line to parse JSON bodies
const server = http.createServer(app);
app.set('trust proxy', true);
const wss = new WebSocket.Server({ server });


app.use(cors());

app.use(session({
  secret: 'some secret', // TODO: Use a proper secret in a real app
  resave: false,
  saveUninitialized: true,
  store: memoryStore
}));

app.use(keycloak.middleware({
  logout: '/logout'
}));



// Middleware to sync user and handle deletion cancellation
app.use(async (req, res, next) => {
  if (req.kauth && req.kauth.grant) {
    try {
      const userProfile = req.kauth.grant.access_token.content;
      let user = await db.findOrCreateUser(userProfile);

      // Check if user has a scheduled deletion
      if (user.status === 'deletion_scheduled') {
        await db.cancelDeletion(user.id);
        // Re-fetch user to get the updated status
        user = await db.getUserById(user.keycloak_uuid);
        user.deletion_cancelled = true; // Add a flag for the frontend
      }
      req.user = user;

    } catch (error) {
      console.error('User sync failed:', error);
      return res.status(500).json({ error: 'Failed to sync user data.' });
    }
  }
  next();
});

app.get('/api/user', keycloak.protect(), (req, res) => {
    if (req.user) {
        res.json(req.user);
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Request deletion endpoint (handles both social and local users)
app.post('/api/user/request-deletion', keycloak.protect(), async (req, res) => {
    try {
        const { reason } = req.body;
        const user = req.user;
        const adminToken = await getKeycloakAdminToken();

        // Check for federated identities to determine if it's a social login
        const { data: federatedIdentities } = await axios.get(
            `${process.env.KEYCLOAK_SERVER_URL}/admin/realms/${process.env.KEYCLOAK_REALM}/users/${user.keycloak_uuid}/federated-identity`,
            { headers: { Authorization: `Bearer ${adminToken}` } }
        );

        const isSocialLogin = federatedIdentities && federatedIdentities.length > 0;

        // Store the reason regardless of the path
        if (reason) {
            await db.createWithdrawalReason(user.id, reason);
        }

        if (isSocialLogin) {
            // Path B: Social login user -> Schedule deletion immediately
            await db.scheduleDeletionImmediately(user.id);
            res.status(200).json({ scheduled: true, message: 'Deletion scheduled immediately.' });
        } else {
            // Path A: Local user with password -> Send confirmation email
            const token = crypto.randomBytes(32).toString('hex');
            await db.requestDeletion(user.id, token);
            const userProfile = req.kauth.grant.access_token.content;
            await sendDeletionConfirmationEmail(userProfile.email, token);
            res.status(200).json({ scheduled: false, message: 'Deletion confirmation email sent.' });
        }

    } catch (error) {
        console.error('Failed to request deletion:', error.response ? error.response.data : error);
        res.status(500).json({ message: 'Failed to request deletion.' });
    }
});



// Confirm deletion endpoint
app.get('/api/user/confirm-deletion', async (req, res) => {
    try {
        const { token } = req.query;
        const user = await db.confirmDeletion(token);

        if (user) {
            res.send('<h1>회원 탈퇴가 예약되었습니다.</h1><p>14일 이내에 다시 로그인하시면 탈퇴가 취소됩니다. 이 창은 닫으셔도 좋습니다.</p>');
        } else {
            res.status(400).send('<h1>잘못된 요청입니다.</h1><p>유효하지 않거나 만료된 토큰입니다.</p>');
        }
    } catch (error) {
        console.error('Failed to confirm deletion:', error);
        res.status(500).send('<h1>오류 발생</h1><p>탈퇴 처리 중 오류가 발생했습니다.</p>');
    }
});





app.get('/mypage.html', keycloak.protect());
app.get('/realtime.html', keycloak.protect());
app.use(express.static("public"));





// ===================================================================
// (공용) 헬스체크만 공통 유지
//   GET /api/health
// ===================================================================
app.get("/api/health", async (req, res) => {
  const ok = await db.testDBConnection();
  res.json({
    status: "ok",
    database: ok ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ===================================================================
// ============================ #시나리오1 ============================
// 사용 페이지: crypto.html, scenario1.html
// 포함 엔드포인트: /api/history, /api/markets, /api/scenario1/news
//  ※ "crypto" 관련 전부 시나리오1로 귀속
// ===================================================================

// (시나리오1) 과거 시간봉 조회
//   GET /api/history?market=btc|eth|xrp&limit=10000
app.get("/api/history", async (req, res) => {
  const { market, limit = 10000 } = req.query;
  if (!market) return res.status(400).json({ error: "market 파라미터가 필요합니다." });

  const tableMap = {
    btc: "crypto_60m_KRW_BTC",
    eth: "crypto_60m_KRW_ETH",
    xrp: "crypto_60m_KRW_XRP",
  };
  const table = tableMap[(market || "").toLowerCase()];
  if (!table) {
    return res.status(400).json({
      error: "지원하지 않는 market입니다. 사용 가능: btc, eth, xrp",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT 
        candle_date_time_kst,
        opening_price,
        high_price,
        low_price,
        trade_price,
        candle_acc_trade_volume AS volume
       FROM ${table}
       ORDER BY candle_date_time_kst ASC
       LIMIT ?`,
      [parseInt(limit)]
    );

    if (!rows.length) {
      return res.status(404).json({ error: `${market.toUpperCase()} 데이터를 찾을 수 없습니다.` });
    }
    res.json(rows);
  } catch (error) {
    console.error(`${market.toUpperCase()} 데이터 조회 오류:`, error);
    res.status(500).json({
      error: "데이터베이스 조회 중 오류가 발생했습니다.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// (시나리오1) 마켓 요약
//   GET /api/markets
app.get("/api/markets", async (req, res) => {
  try {
    const tableMap = {
      btc: "crypto_60m_KRW_BTC",
      eth: "crypto_60m_KRW_ETH",
      xrp: "crypto_60m_KRW_XRP",
    };

    const markets = [];
    for (const [market, table] of Object.entries(tableMap)) {
      try {
        const [cnt] = await pool.query(`SELECT COUNT(*) AS cnt FROM ${table}`);
        const [last] = await pool.query(
          `SELECT candle_date_time_kst, trade_price
           FROM ${table}
           ORDER BY candle_date_time_kst DESC
           LIMIT 1`
        );
        markets.push({
          market: market.toUpperCase(),
          symbol: `${market.toUpperCase()}/KRW`,
          dataCount: cnt[0].cnt,
          latestPrice: last[0]?.trade_price || 0,
          latestTime: last[0]?.candle_date_time_kst || null,
        });
      } catch (e) {
        console.error(`${market} 마켓 정보 조회 오류:`, e);
        markets.push({
          market: market.toUpperCase(),
          symbol: `${market.toUpperCase()}/KRW`,
          dataCount: 0,
          latestPrice: 0,
          latestTime: null,
          error: "데이터 조회 실패",
        });
      }
    }
    res.json(markets);
  } catch (err) {
    console.error("마켓 목록 조회 오류:", err);
    res.status(500).json({ error: "마켓 목록 조회 실패" });
  }
});

// (시나리오1) 뉴스 타임라인 — 하나도 빠짐없이 보존
//   GET /api/scenario1/news
app.get("/api/scenario1/news", (req, res) => {
  res.json([
    {
      time: "2021-05-20 15:00:00",
      title: "중국 금융기관, 암호화폐 서비스 전면 금지 지침",
      description:
        "중국 금융당국은 은행과 결제업체가 암호화폐 거래 및 결제 서비스를 제공하지 못하도록 공식 지침을 발표했다. 이 조치에는 계좌 개설, 거래 중개, 청산, 결제 지원 등이 모두 포함되며, 개인 보유 자체는 금지되지 않았으나 제도권 금융권과의 연결 고리가 완전히 차단됐다. 발표 직후 시장은 불안심리가 급격히 커지며 주요 코인의 가격이 흔들렸다.",
    },
    {
      time: "2021-05-21 15:00:00",
      title: "중국 국무원, 비트코인 채굴·거래 단속 공식화",
      description:
        "중국 국무원 금융안정발전위원회가 류허 부총리 주재 회의 후 비트코인 채굴과 거래를 단속하겠다고 발표했다. 이는 최초로 중앙 정부 차원에서 채굴을 직접 겨냥한 규제 발언으로, 발표 직후 비트코인 가격은 4만 달러 초반에서 3만 달러 중반대로 급락했다. 일주일 동안 20% 이상 하락한 시장은 패닉 상태에 빠졌다.",
    },
  ]);
});

// ===================================================================
// ============================ #시나리오2 ============================
// 사용 페이지: scenario2.html
// 포함 엔드포인트: /api/scenario2, /api/scenario2/news
// ===================================================================
app.get("/api/scenario2", async (req, res) => {
  try {
    const { market = "KRW-ETH", start, end } = req.query;
    const tableMap = { "KRW-ETH": "ETH_hourly" }; // 현재 ETH만 사용
    const table = tableMap[market];
    if (!table) {
      return res.status(400).json({ error: "지원하지 않는 market입니다. 현재는 KRW-ETH만 지원합니다." });
    }

    const where = [];
    const params = [];
    if (start) { where.push(`candle_date_time_kst >= ?`); params.push(start); }
    if (end)   { where.push(`candle_date_time_kst <= ?`); params.push(end); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const sql = `
      SELECT
        candle_date_time_kst AS candle_time,
        opening_price        AS \`open\`,
        high_price           AS \`high\`,
        low_price            AS \`low\`,
        trade_price          AS \`close\`,
        IFNULL(candle_acc_trade_volume, 0) AS volume
      FROM ${table}
      ${whereSql}
      ORDER BY candle_date_time_kst ASC
    `;
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("시나리오2 데이터 조회 오류:", err);
    res.status(500).json({ error: "시나리오2 데이터 조회 실패" });
  }
});

app.get("/api/scenario2/news", (req, res) => {
  res.json([
    {
      time: "2025-07-20 00:00:00",
      title: "이더리움 $3,800 돌파",
      description: "대형 투자자 매수와 기술적 모멘텀으로 24시간 내 6% 이상 급등"
    },
    {
      time: "2025-07-23 01:00:00",
      title: "SharpLink, 79,949 ETH 매입",
      description: "평균 $3,238에 매수, 총 보유량 360,807 ETH로 증가"
    },
    {
      time: "2025-07-26 12:00:00",
      title: "Ethereum Foundation 'Torch' NFT 발행",
      description: "창립 10주년 기념 NFT, 7월 30일 소각 예정"
    },
    {
      time: "2025-07-29 18:00:00",
      title: "ETH 수요 급증 분석",
      description: "7월 한 달 65% 상승, 공급 부족으로 강세 지속 전망"
    },
    {
      time: "2025-08-02 03:00:00",
      title: "ETH ETF 20일 연속 순유입 종료",
      description: "$1.53억 순유출 발생, 시장 변동성 증가"
    },
    {
      time: "2025-08-09 11:00:00",
      title: "미국 스테이블코인 규제 명확화 발표",
      description: "시장 불확실성 해소, ETH 가격 상승에 긍정적 영향"
    },
    {
      time: "2025-08-12 22:00:00",
      title: "기업 보유 ETH 127% 급증",
      description: "기업 보유량 2.7M ETH(116억 달러) 도달"
    }
  ]);
});

// ===================================================================
// ============================ #시나리오3 ============================
// 사용 페이지: scenario3.html
// 포함 엔드포인트: /api/daily (BTC/XRP 일봉 비교)
// (※ realtime과 엮이지 않음 — 완전 별도 섹션)
// ===================================================================

// (시나리오3) BTC/XRP 일봉 데이터
//   GET /api/daily?asset=btc|xrp&start=YYYY-MM-DD&end=YYYY-MM-DD[&table=화이트리스트]
const dailyTableMap = { btc: "btc_daily_0601", xrp: "xrp_daily_0601" };
const allowedDailyTables = new Set(Object.values(dailyTableMap));

app.get("/api/daily", async (req, res) => {
  try {
    const { asset, start, end, table } = req.query;
    if (!asset || !start || !end) {
      return res.status(400).json({ error: "asset, start, end 파라미터가 필요합니다." });
    }
    let tableName = dailyTableMap[(asset || "").toLowerCase()];
    if (table) {
      const safe = /^[A-Za-z0-9_]+$/.test(table) && allowedDailyTables.has(table);
      if (!safe) return res.status(400).json({ error: "허용되지 않은 테이블명입니다." });
      tableName = table;
    }
    if (!tableName) return res.status(400).json({ error: "지원하지 않는 asset입니다. (btc|xrp)" });

    const [rows] = await pool.query(
      `
      SELECT
        CAST(candle_date_time_kst AS DATETIME) AS candle_date_time_kst,
        opening_price,
        high_price,
        low_price,
        trade_price,
        IFNULL(candle_acc_trade_volume, 0) AS volume
      FROM ${tableName}
      WHERE DATE(candle_date_time_kst) >= ?
        AND DATE(candle_date_time_kst) <= ?
      ORDER BY candle_date_time_kst ASC
      `,
      [start, end]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        error: "해당 구간 데이터가 없습니다.",
        meta: { asset, start, end, table: tableName },
      });
    }
    res.json(rows);
  } catch (err) {
    console.error("일봉 데이터 조회 오류:", err);
    res.status(500).json({ error: "일봉 데이터 조회 중 오류가 발생했습니다." });
  }
});


// ===================================================================
// =============================== #realtime ==========================
// 사용 페이지: realtime.html
// 포함 엔드포인트: /api/candles, WebSocket
// (※ 시나리오3와 엮이지 않음 — 완전 별도 섹션)
// ===================================================================

// (realtime) 업비트 캔들 프록시
//   GET /api/candles?unit=1D|5|15|60|240&market=KRW-BTC
app.get("/api/candles", async (req, res) => {
  const { unit, market } = req.query;
  if (!unit || !market) {
    return res.status(400).json({ error: "unit과 market 쿼리 파라미터가 필요합니다." });
  }
  try {
    const url =
      unit === "1D"
        ? `https://api.upbit.com/v1/candles/days?market=${market}&count=200`
        : `https://api.upbit.com/v1/candles/minutes/${unit}?market=${market}&count=200`;
    const { data } = await axios.get(url, { headers: { "Accept-Encoding": "gzip, deflate" } });
    res.json(data);
  } catch (err) {
    console.error("캔들 프록시 오류:", err.message);
    res.status(500).json({ error: "업비트 캔들을 가져오지 못했습니다." });
  }
});

// (realtime) 업비트 WebSocket 프록시 → 프론트엔드 브로드캐스트
const marketCodes = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
const upbitWs = new WebSocket("wss://api.upbit.com/websocket/v1");

upbitWs.on("open", () => {
  console.log("업비트 웹소켓 서버에 연결되었습니다.");
  const reqMsg = [
    { ticket: uuidv4() },
    { type: "ticker", codes: marketCodes },
    // 일반 호가(level:0)
    { type: "orderbook", codes: marketCodes, level: 0 },
    // 누적 호가 예시 (원문 유지)
    { type: "orderbook", codes: ["KRW-BTC"], level: 1000000 },
    { type: "orderbook", codes: ["KRW-ETH"], level: 10000 },
    { type: "orderbook", codes: ["KRW-XRP"], level: 1 },
    { format: "DEFAULT" },
  ];
  upbitWs.send(JSON.stringify(reqMsg));
});

upbitWs.on("message", (msg) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
});
upbitWs.on("close", () => console.log("업비트 웹소켓 연결 끊김"));
upbitWs.on("error", (e) => console.error("업비트 웹소켓 오류:", e));

wss.on("connection", (ws) => {
  console.log("프론트엔드 클라이언트 연결됨");
  ws.on("close", () => console.log("프론트엔드 클라이언트 연결 끊김"));
});

// -------------------------------------------------------------------
// 서버 실행/종료
// -------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, async () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  const ok = await db.testDBConnection();
  if (ok) console.log("데이터베이스 연결 확인됨");
  else console.warn("데이터베이스 연결 실패 - 일부 기능 제한 가능");
});


// --- Deletion Scheduler ---

async function getKeycloakAdminToken() {
    const params = new URLSearchParams();
    params.append('client_id', process.env.KEYCLOAK_ADMIN_CLIENT_ID);
    params.append('client_secret', process.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
    params.append('grant_type', 'client_credentials');

    try {
        const { data } = await axios.post(
            `${process.env.KEYCLOAK_SERVER_URL}/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
            params
        );
        return data.access_token;
    } catch (error) {
        console.error('Could not get Keycloak admin token:', error.response?.data);
        throw error;
    }
}

async function deleteUserFromKeycloak(keycloak_uuid, adminToken) {
    try {
        await axios.delete(
            `${process.env.KEYCLOAK_SERVER_URL}/admin/realms/${process.env.KEYCLOAK_REALM}/users/${keycloak_uuid}`,
            {
                headers: { Authorization: `Bearer ${adminToken}` },
            }
        );
        console.log(`Successfully deleted user ${keycloak_uuid} from Keycloak.`);
    } catch (error) {
        console.error(`Failed to delete user ${keycloak_uuid} from Keycloak:`, error.response?.data);
        // Don't re-throw, as we want to continue if the user is already deleted from Keycloak
    }
}

async function runDeletionJob() {
    console.log('Running scheduled deletion job...');
    try {
        const usersToDelete = await db.findUsersToDelete();
        if (usersToDelete.length === 0) {
            console.log('No users to delete.');
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
        console.error('Error during deletion job:', error);
    }
}

// Run the deletion job every hour
setInterval(runDeletionJob, 3600 * 1000);
// Run once on startup for testing
runDeletionJob();

async function gracefulShutdown() {

  console.log("서버 종료 중...");
  try { if (upbitWs && upbitWs.readyState === WebSocket.OPEN) upbitWs.close(); } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
