const bcrypt = require("bcryptjs");
const { qnaPool } = require("../config/database.js");
const { keycloak } = require("../config/keycloak.js");

// ---------------------- 헬퍼 (기존 로직 그대로) ----------------------
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

module.exports = function registerQnaRoutes(app) {
  // =========================== 카테고리 ===============================
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

  // ============================ 질문 생성 =============================
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

      // ✅ status 컬럼/값 제거된 INSERT (원본 유지)
      const [r] = await qnaPool.query(
        `INSERT INTO questions
         (category_id, title, body, author_name, author_email, visibility, notify_email, secret_password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [catId, title, body, author_name, author_email, visibility, notify_email, secret_password_hash]
      );

      res.status(201).json({ id: r.insertId });
    } catch (e) {
      console.error("QnA create error:", e);
      res.status(500).json({ error: "질문 생성 실패" });
    }
  });

  // ============================= 질문 목록 ============================
  // (질문 목록) — 비공개도 목록에는 노출 (상세 접근은 별도 인증)
  app.get("/api/qna/questions", async (req, res) => {
    try {
      const {category_id, visibility, sort = "recent", page = 1, size = 20, mine } = req.query;
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

      if (category_id) { where.push("q.category_id = ?"); params.push(Number(category_id)); }
      if (visibility)  { where.push("q.visibility = ?"); params.push(visibility); }

      // ✅ 비공개도 목록 노출: 기존의 공개/작성자 제한 필터 제거
      // 단, "내 글만" 필터는 유지 가능
      const email = getLoginEmail(req);
      if (mine === "1" && email) {
        where.push("q.author_email = ?"); params.push(email);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [rows] = await qnaPool.query(
        `SELECT 
           q.id, q.title, q.author_name, q.author_email, q.category_id, q.visibility,
           q.created_at, q.upvotes, q.views
         FROM questions q
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

  // ============================= 질문 상세 ============================
  // (질문 상세) — 비공개는 세션 플래그가 있거나 본인/관리자만 접근 허용
  app.get("/api/qna/questions/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const [[q]] = await qnaPool.query("SELECT * FROM questions WHERE id = ?", [id]);
      if (!q) return res.status(404).json({ error: "not found" });

      if (q.visibility === "private" && !isAdmin(req)) {
        const email = getLoginEmail(req);
        const hasSessionPass = req.session?.qnaPrivateAccess && req.session.qnaPrivateAccess[id];
        if (!hasSessionPass && (!email || email !== q.author_email)) {
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

  // ============================== 댓글 ===============================
  // (댓글 생성) — 질문 전용
  app.post("/api/qna/comments", keycloak.protect(), async (req, res) => {
    try {
      const { question_id, parent_comment_id = null, body } = req.body;
      if (!question_id || !body) return res.status(400).json({ error: "question_id, body 필요" });

      const author_name = getLoginName(req);
      const author_email = getLoginEmail(req) || "";

      // 질문 존재/권한 체크
      const [[q]] = await qnaPool.query(
        "SELECT id, visibility, author_email FROM questions WHERE id = ?",
        [Number(question_id)]
      );
      if (!q) return res.status(404).json({ error: "question not found" });
      if (q.visibility === "private" && !isAdmin(req)) {
        const email = getLoginEmail(req);
        if (!email || email !== q.author_email) {
          return res.status(403).json({ error: "forbidden" });
        }
      }

      // 부모 댓글(대댓글) 유효성
      if (parent_comment_id) {
        const [[pc]] = await qnaPool.query("SELECT id FROM comments WHERE id = ?", [Number(parent_comment_id)]);
        if (!pc) return res.status(400).json({ error: "parent_comment_id not found" });
      }

      const [r] = await qnaPool.query(
        `INSERT INTO comments (question_id, parent_comment_id, author_name, author_email, body)
         VALUES (?, ?, ?, ?, ?)`,
        [Number(question_id), parent_comment_id ? Number(parent_comment_id) : null, author_name, author_email, body]
      );
      res.status(201).json({ id: r.insertId });
    } catch (e) {
      console.error("QnA comment create error:", e);
      res.status(500).json({ error: "댓글 생성 실패" });
    }
  });

  // (댓글 목록) — 질문 전용
  app.get("/api/qna/comments", async (req, res) => {
    try {
      const { question_id } = req.query;
      if (!question_id) return res.status(400).json({ error: "question_id 필요" });

      const [rows] = await qnaPool.query(
        `SELECT id, question_id, parent_comment_id, author_name, author_email, body, created_at, updated_at
         FROM comments
         WHERE question_id = ?
         ORDER BY COALESCE(parent_comment_id, id), created_at ASC`,
        [Number(question_id)]
      );
      res.json(rows);
    } catch (e) {
      console.error("QnA comments list error:", e);
      res.status(500).json({ error: "댓글 목록 조회 실패" });
    }
  });

  // ============================ 비공개 인증 ===========================
  // (비공개 인증) 비밀번호 확인 후 세션에 통과 플래그 저장
  app.post("/api/qna/questions/:id/authorize", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { secret_password } = req.body || {};
      if (!id || !secret_password) return res.status(400).json({ error: "secret_password 필요" });

      const [[q]] = await qnaPool.query(
        "SELECT id, visibility, author_email, secret_password_hash FROM questions WHERE id = ?",
        [id]
      );
      if (!q) return res.status(404).json({ error: "not found" });
      if (q.visibility !== "private") return res.status(400).json({ error: "private post only" });
      if (!q.secret_password_hash) return res.status(400).json({ error: "no password set" });

      const ok = await bcrypt.compare(String(secret_password), q.secret_password_hash);
      if (!ok) return res.status(401).json({ error: "wrong password" });

      // 세션 플래그
      if (!req.session.qnaPrivateAccess) req.session.qnaPrivateAccess = {};
      req.session.qnaPrivateAccess[id] = true;

      res.json({ ok: true });
    } catch (e) {
      console.error("QnA authorize error:", e);
      res.status(500).json({ error: "인증 실패" });
    }
  });

  // ============================== 추천 ===============================
  app.get("/api/qna/questions/:id/upvote-state", keycloak.protect(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const email = getLoginEmail(req);
      if (!id || !email) return res.json({ voted: false });
      const [[row]] = await qnaPool.query(
        "SELECT 1 FROM question_upvotes WHERE question_id=? AND user_email=? LIMIT 1",
        [id, email]
      );
      res.json({ voted: !!row });
    } catch (e) {
      console.error("upvote-state error", e);
      res.status(500).json({ error: "상태 조회 실패" });
    }
  });

  app.post("/api/qna/questions/:id/upvote", keycloak.protect(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const email = getLoginEmail(req);
      if (!id || !email) return res.status(400).json({ error: "bad request" });

      // 중복 방지: PK( question_id, user_email )
      await qnaPool.query(
        "INSERT INTO question_upvotes (question_id, user_email) VALUES (?, ?)",
        [id, email]
      ).catch(err => {
        if (err && err.code === "ER_DUP_ENTRY") {
          throw Object.assign(new Error("already voted"), { status: 409 });
        }
        throw err;
      });

      await qnaPool.query("UPDATE questions SET upvotes = upvotes + 1 WHERE id = ?", [id]);
      const [[q]] = await qnaPool.query("SELECT upvotes FROM questions WHERE id = ?", [id]);
      res.json({ ok: true, upvotes: q?.upvotes || 0 });
    } catch (e) {
      const status = e.status || 500;
      const msg = e.message === "already voted" ? "이미 추천했습니다." : "추천 실패";
      if (status !== 409) console.error("upvote error", e);
      res.status(status).json({ error: msg });
    }
  });
};
