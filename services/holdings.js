// services/holdings.js
// 보유 종목 평가금액(+이익/-손실) 계산 API
const axios = require('axios');
const { keycloak } = require("./keycloak-config.js");
const { tradingPool } = require("./database.js");

// transactions + filled pending_orders 병합 (중복 방지)
const UNION_SQL = `
  SELECT id, user_id, market, side, price, quantity, created_at
    FROM transactions
  UNION ALL
  SELECT po.id, po.user_id, po.market, po.side, po.price, po.quantity,
         CASE WHEN po.status='filled' THEN COALESCE(po.updated_at, po.created_at)
              ELSE po.created_at END AS created_at
    FROM pending_orders po
   WHERE po.status='filled'
     AND NOT EXISTS (
       SELECT 1
         FROM transactions t
        WHERE t.user_id = po.user_id
          AND t.market  = po.market
          AND t.side    = po.side
          AND t.price   = po.price
          AND t.quantity= po.quantity
          AND ABS(TIMESTAMPDIFF(SECOND, t.created_at,
                CASE WHEN po.status='filled' THEN COALESCE(po.updated_at, po.created_at)
                     ELSE po.created_at END)) <= 300
     )
`;

// 문자열 유틸
const norm = s => String(s || '').trim().toUpperCase();
const stripKRW = s => norm(s).replace(/^KRW[-/]/i, '');
const addKRW   = s => norm(s).startsWith('KRW-') ? norm(s) : `KRW-${norm(s)}`;

// FIFO 로트 복원
function bootstrapState(rows){
  const pos = {}, lastPrice = {}, lots = {};
  for (const t of rows || []) {
    const sym = stripKRW(t.market);
    const side = String(t.side||'').toLowerCase();
    const qty  = Number(t.quantity)||0;
    const px   = Number(t.price)||0;

    if (side === 'buy' || side === 'bid') {
      pos[sym] = (pos[sym]||0) + qty;
      lastPrice[sym] = px;
      (lots[sym] ||= []).push({ qty, cost: px });
    } else if (side === 'sell' || side === 'ask') {
      pos[sym] = (pos[sym]||0) - qty;
      lastPrice[sym] = px;
      // FIFO 소진
      let r = qty;
      const q = (lots[sym] ||= []);
      while (r > 1e-12 && q.length) {
        const lot = q[0];
        const take = Math.min(r, lot.qty);
        lot.qty -= take; r -= take;
        if (lot.qty <= 1e-12) q.shift();
      }
    }
  }
  return { pos, lots, lastPrice };
}

// 현재가 조회 (Upbit)
async function fetchTickers(markets){
  if (!markets.length) return {};
  try {
    const { data } = await axios.get('https://api.upbit.com/v1/ticker', {
      params: { markets: markets.join(',') }
    });
    const px = {};
    for (const r of data) px[r.market] = Number(r.trade_price)||0;
    return px;
  } catch {
    return {};
  }
}

module.exports = function registerHoldings(app){
  // 로그인 사용자 보유 요약
  app.get('/api/user/holdings', keycloak.protect(), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });

      // 모든 체결 기반으로 보유 상태 복원
      const [rows] = await tradingPool.query(
        `SELECT market, side, price, quantity, created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id = ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId]
      );

      const state = bootstrapState(rows);
      const symbols = Object.keys(state.pos).filter(s => (state.pos[s]||0) > 0);
      const markets = symbols.map(s => addKRW(s));

      // 현재가
      const tickers = await fetchTickers(markets);

      // 결과 구성
      const positions = symbols.map(sym => {
        const qty = Number(state.pos[sym]) || 0;
        const lots = state.lots[sym] || [];
        let costSum = 0, qtySum = 0;
        for (const l of lots) {
          const q = Number(l.qty)||0, c = Number(l.cost)||0;
          if (q > 0) { costSum += q * c; qtySum += q; }
        }
        const avg_cost = qtySum > 0 ? costSum / qtySum : 0;
        const mkt = addKRW(sym);
        const current_price = Number(tickers[mkt] || state.lastPrice[sym] || 0);
        const current_value = Math.round(qty * current_price);
        const pnl = Math.round((current_price - avg_cost) * qty);

        return {
          symbol: sym,
          quantity: qty,
          avg_cost: Math.round(avg_cost),
          current_price: Math.round(current_price),
          current_value,
          pnl
        };
      }).sort((a,b)=> a.symbol.localeCompare(b.symbol));

      res.json({ positions });
    } catch (e) {
      console.error('holdings api error:', e);
      res.status(500).json({ error: 'Failed to build holdings' });
    }
  });
};
