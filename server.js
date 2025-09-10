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
const { keycloak, memoryStore } = require("./keycloak-config.js");

const db = require("./database.js");
// 메인(크립토) DB 풀
const pool = db.pool;
// QnA 전용 풀 (questions/answers/comments/categories)
const { qnaPool } = require("./database.js");
const { sendDeletionConfirmationEmail } = require("./email.js");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

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
      req.user = user;
    } catch (error) {
      console.error("User sync failed:", error);
      return res.status(500).json({ error: "Failed to sync user data." });
    }
  }
  next();
});

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

// ===================================================================
// ============================ QnA API ===============================
// ===================================================================

// ✅ 한글 대표 카테고리 (결제/영수증, 데이터/ETL 제외) + '기타'
const KOREAN_QNA_CATEGORIES = [
  ["로그인/계정", 10],
  ["버그 신고", 20],
  ["기능 요청", 30],
  ["이용 방법", 40],
  ["보고서", 50],
  ["보안", 60],
  ["기타", 999],
];

// (카테고리) 비어 있으면 자동 시드, '기타'가 없으면 보강
app.get("/api/qna/categories", async (req, res) => {
  try {
    const [rows] = await qnaPool.query(
      "SELECT id, name AS label FROM categories ORDER BY sort_order, id"
    );

    if (rows.length > 0) {
      const hasEtc = rows.some((r) => r.label === "기타");
      if (!hasEtc) {
        await qnaPool.query(
          "INSERT IGNORE INTO categories (name, sort_order) VALUES (?, ?)",
          ["기타", 999]
        );
        const [rows2] = await qnaPool.query(
          "SELECT id, name AS label FROM categories ORDER BY sort_order, id"
        );
        return res.json(rows2);
      }
      return res.json(rows);
    }

    // 최초 비어있으면 시드
    await qnaPool.query("INSERT INTO categories (name, sort_order) VALUES ?", [
      KOREAN_QNA_CATEGORIES,
    ]);
    const [seeded] = await qnaPool.query(
      "SELECT id, name AS label FROM categories ORDER BY sort_order, id"
    );
    res.json(seeded);
  } catch (e) {
    console.error("QnA categories error:", e);
    res.status(500).json({ error: "카테고리 조회 실패" });
  }
});

// (질문 생성) category_id 없거나 잘못되면 자동으로 '기타'로 귀속
app.post("/api/qna/questions", keycloak.protect(), async (req, res) => {
  try {
    let {
      title,
      body,
      category_id,
      visibility = "public",
      notify_email,
      secret_password,
    } = req.body;

    if (!title || !body || !notify_email) {
      return res
        .status(400)
        .json({ error: "title, body, notify_email은 필수입니다." });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(notify_email))) {
      return res.status(400).json({ error: "유효한 이메일을 입력하세요." });
    }

    // 카테고리 유효성 체크 → '기타' 대체
    let catId = Number(category_id);
    if (!catId || Number.isNaN(catId)) {
      const [[etc]] = await qnaPool.query(
        "SELECT id FROM categories WHERE name='기타' LIMIT 1"
      );
      catId = etc?.id || null;
    } else {
      const [[ok]] = await qnaPool.query(
        "SELECT id FROM categories WHERE id=? LIMIT 1",
        [catId]
      );
      if (!ok) {
        const [[etc]] = await qnaPool.query(
          "SELECT id FROM categories WHERE name='기타' LIMIT 1"
        );
        catId = etc?.id || null;
      }
    }
    if (!catId) return res.status(400).json({ error: "카테고리를 찾지 못했습니다." });

    // 비공개면 비밀번호 해시
    let secret_password_hash = null;
    if (visibility === "private") {
      if (!secret_password || String(secret_password).length < 4) {
        return res
          .status(400)
          .json({ error: "비공개 글은 비밀번호(4자 이상)가 필요합니다." });
      }
      const salt = await bcrypt.genSalt(10);
      secret_password_hash = await bcrypt.hash(String(secret_password), salt);
    }

    const author_name = getLoginName(req);
    const author_email = getLoginEmail(req) || "";

    const [r] = await qnaPool.query(
      `INSERT INTO questions
       (category_id, title, body, author_name, author_email, status, visibility, notify_email, secret_password_hash)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [catId, title, body, author_name, author_email, visibility, notify_email, secret_password_hash]
    );

    res.status(201).json({ id: r.insertId });
  } catch (e) {
    console.error("QnA create error:", e);
    res.status(500).json({ error: "질문 생성 실패" });
  }
});

// (질문 목록)
app.get("/api/qna/questions", async (req, res) => {
  try {
    const { status, category_id, visibility, sort = "recent", page = 1, size = 20, mine } =
      req.query;
    const limit = Math.min(parseInt(size, 10) || 20, 100);
    const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const sorts = {
      recent: "q.created_at DESC",
      upvotes: "q.upvotes DESC, q.created_at DESC",
      views: "q.views DESC, q.created_at DESC",
    };
    const orderBy = sorts[sort] || sorts.recent;

    const where = [];
    const params = [];

    if (status) {
      where.push("q.status = ?");
      params.push(status);
    }
    if (category_id) {
      where.push("q.category_id = ?");
      params.push(Number(category_id));
    }
    if (visibility) {
      where.push("q.visibility = ?");
      params.push(visibility);
    }

    const email = getLoginEmail(req);
    if (mine === "1" && email) {
      where.push("q.author_email = ?");
      params.push(email);
    } else if (!isAdmin(req)) {
      if (email) {
        where.push(
          "(q.visibility = 'public' OR (q.visibility = 'private' AND q.author_email = ?))"
        );
        params.push(email);
      } else {
        where.push("q.visibility = 'public'");
      }
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await qnaPool.query(
      `SELECT 
          q.id, q.title, q.author_name, q.author_email, q.category_id, q.status, q.visibility,
          q.created_at, q.upvotes, q.views,
          IFNULL(a.cnt, 0) AS answers_count
       FROM questions q
       LEFT JOIN (
         SELECT question_id, COUNT(*) AS cnt
         FROM answers
         GROUP BY question_id
       ) a ON a.question_id = q.id
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error("QnA list error:", e);
    res.status(500).json({ error: "목록 조회 실패" });
  }
});

// (질문 상세)
app.get("/api/qna/questions/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[q]] = await qnaPool.query("SELECT * FROM questions WHERE id = ?", [id]);
    if (!q) return res.status(404).json({ error: "not found" });

    if (q.visibility === "private" && !isAdmin(req)) {
      const email = getLoginEmail(req);
      if (!email || email !== q.author_email) {
        return res.status(403).json({ error: "forbidden" });
      }
    }

    await qnaPool.query("UPDATE questions SET views = views + 1 WHERE id = ?", [id]);
    res.json(q);
  } catch (e) {
    console.error("QnA detail error:", e);
    res.status(500).json({ error: "상세 조회 실패" });
  }
});

// (상태 변경, 관리자)
app.patch("/api/qna/questions/:id/status", keycloak.protect(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    const id = Number(req.params.id);
    const { status } = req.body; // 'pending' | 'answered'
    if (!["pending", "answered"].includes(status)) {
      return res.status(400).json({ error: "status must be pending|answered" });
    }
    await qnaPool.query("UPDATE questions SET status = ? WHERE id = ?", [status, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("QnA status error:", e);
    res.status(500).json({ error: "상태 변경 실패" });
  }
});

// (답변 생성, 관리자 → answered 갱신)
app.post("/api/qna/answers", keycloak.protect(), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: "admin only" });
    const { question_id, body } = req.body;
    if (!question_id || !body) return res.status(400).json({ error: "question_id, body 필요" });

    const responder_name = getLoginName(req);
    const responder_email = getLoginEmail(req) || "";

    const [[q]] = await qnaPool.query("SELECT id FROM questions WHERE id = ?", [
      Number(question_id),
    ]);
    if (!q) return res.status(404).json({ error: "question not found" });

    const [r] = await qnaPool.query(
      `INSERT INTO answers (question_id, responder_name, responder_email, body)
       VALUES (?, ?, ?, ?)`,
      [Number(question_id), responder_name, responder_email, body]
    );

    await qnaPool.query('UPDATE questions SET status = "answered" WHERE id = ?', [
      Number(question_id),
    ]);
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    console.error("QnA answer create error:", e);
    res.status(500).json({ error: "답변 생성 실패" });
  }
});

// (답변 목록)
app.get("/api/qna/answers", async (req, res) => {
  try {
    const { question_id } = req.query;
    if (!question_id) return res.status(400).json({ error: "question_id 필요" });
    const [rows] = await qnaPool.query(
      `SELECT id, question_id, responder_name, responder_email, body, created_at, updated_at
       FROM answers
       WHERE question_id = ?
       ORDER BY created_at ASC`,
      [Number(question_id)]
    );
    res.json(rows);
  } catch (e) {
    console.error("QnA answers list error:", e);
    res.status(500).json({ error: "답변 목록 조회 실패" });
  }
});

// (댓글 생성)
app.post("/api/qna/comments", keycloak.protect(), async (req, res) => {
  try {
    const { parent_type, parent_id, parent_comment_id = null, body } = req.body;
    if (!["question", "answer"].includes(parent_type)) {
      return res.status(400).json({ error: "parent_type must be question|answer" });
    }
    if (!parent_id || !body) return res.status(400).json({ error: "parent_id, body 필요" });

    const author_name = getLoginName(req);
    const author_email = getLoginEmail(req) || "";

    if (parent_type === "question") {
      const [[q]] = await qnaPool.query(
        "SELECT id, visibility, author_email FROM questions WHERE id = ?",
        [Number(parent_id)]
      );
      if (!q) return res.status(404).json({ error: "question not found" });
      if (q.visibility === "private" && !isAdmin(req)) {
        const email = getLoginEmail(req);
        if (!email || email !== q.author_email) {
          return res.status(403).json({ error: "forbidden" });
        }
      }
    } else {
      const [[a]] = await qnaPool.query(
        "SELECT id, question_id FROM answers WHERE id = ?",
        [Number(parent_id)]
      );
      if (!a) return res.status(404).json({ error: "answer not found" });
    }

    if (parent_comment_id) {
      const [[pc]] = await qnaPool.query("SELECT id FROM comments WHERE id = ?", [
        Number(parent_comment_id),
      ]);
      if (!pc) return res.status(400).json({ error: "parent_comment_id not found" });
    }

    const [r] = await qnaPool.query(
      `INSERT INTO comments (parent_type, parent_id, parent_comment_id, author_name, author_email, body)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        parent_type,
        Number(parent_id),
        parent_comment_id ? Number(parent_comment_id) : null,
        author_name,
        author_email,
        body,
      ]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    console.error("QnA comment create error:", e);
    res.status(500).json({ error: "댓글 생성 실패" });
  }
});

// (댓글 목록)
app.get("/api/qna/comments", async (req, res) => {
  try {
    const { parent_type, parent_id } = req.query;
    if (!["question", "answer"].includes(parent_type)) {
      return res.status(400).json({ error: "parent_type must be question|answer" });
    }
    if (!parent_id) return res.status(400).json({ error: "parent_id 필요" });

    const [rows] = await qnaPool.query(
      `SELECT id, parent_type, parent_id, parent_comment_id, author_name, author_email, body, created_at, updated_at
       FROM comments
       WHERE parent_type = ? AND parent_id = ?
       ORDER BY COALESCE(parent_comment_id, id), created_at ASC`,
      [parent_type, Number(parent_id)]
    );
    res.json(rows);
  } catch (e) {
    console.error("QnA comments list error:", e);
    res.status(500).json({ error: "댓글 목록 조회 실패" });
  }
});

// ===================================================================
// ============================ #시나리오1 ============================
// (예전 코드/엔드포인트 보존: history, markets, scenario1/news)
// ===================================================================
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
    });
  }
});

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

// (예전 뉴스 — 상세 서술 포함)
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
    if (start) {
      where.push(`candle_date_time_kst >= ?`);
      params.push(start);
    }
    if (end) {
      where.push(`candle_date_time_kst <= ?`);
      params.push(end);
    }
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

// (예전 뉴스 — 시나리오2)
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
// (BTC/XRP 일봉 비교)
// ===================================================================
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
// =============================== realtime ==========================
// (업비트 캔들 프록시 + WS 브릿지)
// ===================================================================

// 캔들 프록시
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

// 업비트 WebSocket → 프론트로 브로드캐스트
const marketCodes = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];
const upbitWs = new WebSocket("wss://api.upbit.com/websocket/v1");

upbitWs.on("open", () => {
  console.log("업비트 웹소켓 서버에 연결되었습니다.");
  const reqMsg = [
    { ticket: uuidv4() },
    { type: "ticker", codes: marketCodes },
    { type: "orderbook", codes: marketCodes, level: 0 },
    // (예전 코드 유지: 누적 호가 레벨 예시)
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
