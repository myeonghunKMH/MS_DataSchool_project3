// news.js
// Azure MySQL 암호화폐 뉴스 API + /news 페이지 라우트

const path = require("path");

// news.html의 '절대경로' (환경변수 우선)
const NEWS_HTML_PATH =
  process.env.NEWS_HTML_PATH || path.resolve(__dirname, "public", "news.html");

// 서버에서 생성한 Azure MySQL 풀(newsDbConnection)을 의존성으로 주입받아 사용
module.exports = function registerNews(app, newsDbConnection) {
  // ======= 뉴스 HTML 페이지 (오직 /news 만) =======
  app.get("/news", (req, res) => {
    res.sendFile(NEWS_HTML_PATH, (err) => {
      if (err) {
        console.error("news.html 전송 오류:", err?.message || err);
        res.status(err.statusCode || 500).send("페이지를 불러오지 못했습니다.");
      }
    });
  });

  // ======= 목록 API =======
  app.get("/api/crypto-news", (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const countQuery = "SELECT COUNT(*) as total FROM crypto_news";
    const dataQuery = `
      SELECT 
        id, title, link, description,
        DATE_FORMAT(pubDate, '%Y-%m-%d %H:%i:%s') as pubDate,
        originallink, source, keyword,
        DATE_FORMAT(crawled_at, '%Y-%m-%d %H:%i:%s') as crawled_at,
        content_hash, sentiment
      FROM crypto_news
      ORDER BY pubDate DESC
      LIMIT ? OFFSET ?`;

    newsDbConnection.query(countQuery, (countErr, countResults) => {
      if (countErr) {
        console.error("데이터 개수 조회 오류:", countErr);
        return res.status(500).json({ success: false, error: "데이터 조회 중 오류가 발생했습니다." });
      }
      const totalCount = countResults[0].total;
      const totalPages = Math.ceil(totalCount / limit);

      newsDbConnection.query(dataQuery, [limit, offset], (dataErr, dataResults) => {
        if (dataErr) {
          console.error("데이터 조회 오류:", dataErr);
          return res.status(500).json({ success: false, error: "데이터 조회 중 오류가 발생했습니다." });
        }
        res.json({
          success: true,
          data: dataResults,
          pagination: { page, limit, totalCount, totalPages },
        });
      });
    });
  });

  // ======= 검색 API =======
  app.get("/api/crypto-news/search", (req, res) => {
    const { keyword, startDate, endDate, sentiment } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (keyword) { where.push("(title LIKE ? OR description LIKE ?)"); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (startDate) { where.push("DATE(pubDate) >= ?"); params.push(startDate); }
    if (endDate)   { where.push("DATE(pubDate) <= ?"); params.push(endDate); }
    if (sentiment) { where.push("sentiment = ?"); params.push(sentiment); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countQuery = `SELECT COUNT(*) as total FROM crypto_news ${whereSql}`;
    const dataQuery = `
      SELECT 
        id, title, link, description,
        DATE_FORMAT(pubDate, '%Y-%m-%d %H:%i:%s') as pubDate,
        originallink, source, keyword,
        DATE_FORMAT(crawled_at, '%Y-%m-%d %H:%i:%s') as crawled_at,
        sentiment
      FROM crypto_news
      ${whereSql}
      ORDER BY pubDate DESC
      LIMIT ? OFFSET ?`;

    newsDbConnection.query(countQuery, params, (countErr, countResults) => {
      if (countErr) {
        console.error("검색 카운트 오류:", countErr);
        return res.status(500).json({ success: false, error: "검색 중 오류가 발생했습니다." });
      }
      const totalCount = countResults[0].total;
      const totalPages = Math.ceil(totalCount / limit);

      const dataParams = [...params, limit, offset];
      newsDbConnection.query(dataQuery, dataParams, (dataErr, dataResults) => {
        if (dataErr) {
          console.error("검색 데이터 오류:", dataErr);
          return res.status(500).json({ success: false, error: "검색 중 오류가 발생했습니다." });
        }
        res.json({
          success: true,
          data: dataResults,
          pagination: { page, limit, totalCount, totalPages },
        });
      });
    });
  });
};
