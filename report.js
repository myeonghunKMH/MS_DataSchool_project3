// report.js
const db = require("./services/database.js");
const { keycloak } = require("./services/keycloak-config.js");

module.exports = function registerReport(app) {
  const pool = db.pool;

  app.get("/api/user/report", keycloak.protect(), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const [[{ now }]] = await pool.query("SELECT NOW() AS now");
      const today = new Date(now);
      const y = today.getFullYear(), m = today.getMonth() + 1;

      const thisStart = `${y}-${String(m).padStart(2, "0")}-01 00:00:00`;
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      const nextStart = `${nextY}-${String(nextM).padStart(2, "0")}-01 00:00:00`;

      const prevY = m === 1 ? y - 1 : y;
      const prevM = m === 1 ? 12 : m - 1;
      const prevStart = `${prevY}-${String(prevM).padStart(2, "0")}-01 00:00:00`;
      const prevEnd = thisStart;

      // 거래수/거래액 (이번달/지난달)
      const [[{ trades_curr }]] = await pool.query(
        `SELECT COUNT(*) AS trades_curr FROM transactions
         WHERE user_id=? AND created_at>=? AND created_at<?`,
        [userId, thisStart, nextStart]
      );
      const [[{ trades_prev }]] = await pool.query(
        `SELECT COUNT(*) AS trades_prev FROM transactions
         WHERE user_id=? AND created_at>=? AND created_at<?`,
        [userId, prevStart, prevEnd]
      );

      const [[{ vol_curr }]] = await pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS vol_curr FROM transactions
         WHERE user_id=? AND created_at>=? AND created_at<?`,
        [userId, thisStart, nextStart]
      );
      const [[{ vol_prev }]] = await pool.query(
        `SELECT COALESCE(SUM(total_amount),0) AS vol_prev FROM transactions
         WHERE user_id=? AND created_at>=? AND created_at<?`,
        [userId, prevStart, prevEnd]
      );

      // Top 종목 (이번달, 거래액 상위 5개)
      const [topRows] = await pool.query(
        `SELECT market, COALESCE(SUM(total_amount),0) AS vol
           FROM transactions
          WHERE user_id=? AND created_at>=? AND created_at<?
          GROUP BY market
          ORDER BY vol DESC
          LIMIT 5`,
        [userId, thisStart, nextStart]
      );
      const volSum = topRows.reduce((s, r) => s + Number(r.vol || 0), 0);
      const topSymbols = topRows.map(r => ({
        symbol: r.market,
        share: volSum > 0 ? Number(r.vol) / volSum : 0
      }));

      // 최근 체결 10건
      const [recent] = await pool.query(
        `SELECT created_at, market, side, quantity, price
           FROM transactions
          WHERE user_id=?
          ORDER BY created_at DESC
          LIMIT 10`,
        [userId]
      );
      const recentFills = recent.map(r => ({
        ts: r.created_at,
        sym: r.market,
        side: r.side === 'buy' ? '매수' : (r.side === 'sell' ? '매도' : r.side),
        qty: Number(r.quantity),
        price: Number(r.price)
      }));

      // 최근 30일 일별 현금흐름
      const [daily] = await pool.query(
        `SELECT DATE(created_at) AS d,
                SUM(CASE WHEN side='buy' THEN -total_amount
                         WHEN side='sell' THEN  total_amount
                         ELSE 0 END) AS cashflow
           FROM transactions
          WHERE user_id=? AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
          GROUP BY DATE(created_at)
          ORDER BY d ASC`,
        [userId]
      );

      const labels = Array.from({ length: 30 }, (_, i) => {
        const dt = new Date(); dt.setDate(dt.getDate() - (29 - i));
        return dt.toISOString().slice(0, 10);
      });
      const map = new Map(daily.map(r => [r.d.toISOString().slice(0,10), Number(r.cashflow||0)]));
      const dailyCashflow = labels.map(day => map.get(day) ?? 0);

      const [[me]] = await pool.query(
        `SELECT krw_balance FROM users WHERE id=?`,
        [userId]
      );
      let equity = Number(me?.krw_balance || 0);
      const equityCurve = new Array(30);
      for (let i = 29; i >= 0; i--) {
        equityCurve[i] = equity;
        equity = equity - dailyCashflow[i];
      }
      const returnSeries = equityCurve.map((v, i, arr) => i === 0 ? 0 : ((v - arr[i-1]) / (arr[i-1] || 1)) * 100);
      const marketReturnSeries = new Array(30).fill(0);

      const resp = {
        days: labels.map(s => s.slice(5)), // 'MM-DD'
        my: {
          monthlyTrades: trades_curr,
          monthlyTradesDiff: trades_curr - trades_prev,
          monthlyVolume: Number(vol_curr),
          monthlyVolumeDiff: (vol_prev === 0) ? (vol_curr > 0 ? 100 : 0) : ((vol_curr - vol_prev) / vol_prev) * 100,
          monthlyReturnPct: (returnSeries.slice(-1)[0] || 0),
          returnRankPctile: 50, // 집단 비교 데이터 없으니 임시
          topSymbols,
          equityCurve,
          returnSeries,
          marketReturnSeries,
          recentFills
        }
      };
      res.json(resp);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to build report" });
    }
  });
};
