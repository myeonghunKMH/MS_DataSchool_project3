// report.js — 최근 15일 고정, 내 수익률 MtM(일봉) + 오늘 현재가 반영, 월 실현손익(FIFO), 히스토리 20건
const axios = require('axios');
const { keycloak } = require("./services/keycloak-config.js");
const { tradingPool } = require("./services/database.js");

const INIT_CASH = Number(process.env.INIT_CASH || 10_000_000);
const MS9H = 9 * 60 * 60 * 1000;

// ===== 거래 원본 (중복 제거) =====
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

module.exports = function registerReport(app) {
  app.get("/api/user/report", keycloak.protect(), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      // === 최근 15일(KST) 고정 범위 ===
      const { startUTC: startUTC_15d, endUTC: endUTC_15d, daysKST } = lastNDaysRangeKST(15);

      // === 월초(KST)~오늘(KST) 범위(실현손익 계산용) ===
      const now = new Date();
      const { start: monthStartUTC, end: monthEndUTC } = monthRangeKST(now);
      const endUTC_MTD = clampEndToTodayKST(monthEndUTC);

      // --- 시작 이전 거래로 '시작 시점 상태' 복원 ---
      const [preRows] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at < ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, startUTC_15d]
      );
      const opening = bootstrapState(preRows, INIT_CASH);

      // --- 15일 창 구간의 거래 ---
      const [txWindow] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, startUTC_15d, endUTC_15d]
      );

      // --- (그래프용) 내 수익률/총자산: MtM(일봉 종가) + 마지막 날 현재가 ---
      const marketsNeeded = collectMarkets(opening, txWindow);
      const closes = await fetchDailyCloses(marketsNeeded, daysKST);      // { 'KRW-BTC': { 'YYYY-MM-DD': px, ... }, ... }
      const tickers = await fetchTickers(marketsNeeded);                  // { 'KRW-BTC': px, ... }  (오늘 덮어쓰기용)
      const { equityCurve, returnSeries } = computeMyMtMSeries15D(opening, txWindow, daysKST, closes, tickers);

      // --- (카드용 KPI) 최근 15일 거래 수/Top 종목 비중 ---
      const [[{ trades_curr }]] = await tradingPool.query(
        `SELECT COUNT(*) AS trades_curr
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?`,
        [userId, startUTC_15d, endUTC_15d]
      );

      const [topRows] = await tradingPool.query(
        `SELECT market, SUM(price*quantity) AS vol
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          GROUP BY market ORDER BY vol DESC LIMIT 5`,
        [userId, startUTC_15d, endUTC_15d]
      );
      const volSum = topRows.reduce((s, r) => s + Number(r.vol || 0), 0);
      const topSymbols = topRows.map(r => ({
        symbol: stripKRW(r.market),
        share: volSum ? Number(r.vol) / volSum : 0
      }));

      // --- (그래프 비교선) 전체 평균 수익률: 간단형(트랜잭션 기반, 15일 창) ---
      //     * 정확한 MtM 평균을 내려면 전체 사용자별 시세 매핑이 필요하니 여기선 단순 버전 유지
      const openingEq_base = equityCurve.length ? equityCurve[0] : calcEquityTx(opening.cash, opening.pos, opening.lastPrice);
      const peerAvgReturnSeries = await computePeerAvgReturnSeriesSimple_KST(
        openingEq_base, startUTC_15d, endUTC_15d, daysKST
      );

      // --- (MTD 카드) 월 실현손익(FIFO 재계산) ---
      const [preRowsMonth] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at < ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, monthStartUTC]
      );
      const [txMTD] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, monthStartUTC, endUTC_MTD]
      );
      const monthlyPnL = computeRealizedPnL_FIFO(preRowsMonth, txMTD, INIT_CASH);

      // --- 최근 체결 20건(슬라이더용) ---
      const [recent] = await tradingPool.query(
        `SELECT id,created_at,market,side,price,quantity
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 20`,
        [userId]
      );
      const recentFills = recent.map(r => ({
        id: r.id,
        ts: r.created_at,
        sym: r.market,
        side: r.side,
        price: Number(r.price) || 0,
        qty: Number(r.quantity) || 0
      }));

      // --- 응답 ---
      const monthlyReturnPct = openingEq_base ? safePct((equityCurve.at(-1) ?? openingEq_base) - openingEq_base, openingEq_base) : 0;

      res.json({
        // 모든 그래프는 최근 15일 KST 고정
        days: daysKST,
        my: {
          monthlyTrades: trades_curr,                 // 최근 15일 거래수
          monthlyTradesDiff: 0,                       // (요청사항에 없음: 비교치 제거)
          monthlyPnL: Math.round(monthlyPnL || 0),   // 월초~오늘 실현손익(FIFO)
          monthlyPnLDiff: 0,                         // (요청사항에 없음: 비교치 제거)
          monthlyReturnPct: round1(monthlyReturnPct),
          returnRankPctile: 100,                     // (간단: 백분위 계산 제거 가능)
          topSymbols,
          equityCurve: equityCurve.map(v => Math.round(v || 0)), // 총자산(₩)
          returnSeries: returnSeries.map(round1),                // 내 수익률(%), MtM
          peerAvgReturnSeries: (peerAvgReturnSeries || []).map(round1), // 평균 수익률(%)
          marketReturnSeries: new Array(daysKST.length).fill(0),        // (옵션)
          recentFills                                         // 최근 20건 (슬라이드용)
        }
      });
    } catch (e) {
      console.error('report api error:', e);
      res.status(500).json({ error: 'Failed to build report' });
    }
  });
};

/* ================= Helpers ================= */

function monthRangeKST(anchor){
  const kst = new Date(anchor.getTime() + MS9H);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth();
  const startKST = new Date(Date.UTC(y, m,   1));
  const endKST   = new Date(Date.UTC(y, m+1, 1));
  return { start: new Date(startKST.getTime() - MS9H), end: new Date(endKST.getTime() - MS9H) };
}
function clampEndToTodayKST(endUTC){
  const now = new Date();
  const nowKST = new Date(now.getTime() + MS9H);
  const todayKey = nowKST.toISOString().slice(0,10);
  const kstTomorrow00UTC = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - MS9H + 24*60*60*1000);
  return new Date(Math.min(endUTC.getTime(), kstTomorrow00UTC.getTime()));
}
function kstDayStartUTC(kstYYYYMMDD){
  return new Date(new Date(`${kstYYYYMMDD}T00:00:00Z`).getTime() - MS9H);
}
function lastNDaysRangeKST(n){
  const now = new Date();
  const todayKST = new Date(now.getTime() + MS9H);
  const todayKey = todayKST.toISOString().slice(0,10); // YYYY-MM-DD
  const startKey = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - MS9H - (n-1)*(24*60*60*1000));
  const endUTC   = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - MS9H + (1)*(24*60*60*1000)); // 내일 00:00(KST) UTC
  // daysKST: startKey(KST자정)부터 today까지
  const daysKST=[]; const day=24*60*60*1000;
  for(let t=startKey.getTime()+MS9H; t<endUTC.getTime()+MS9H; t+=day){
    daysKST.push(new Date(t).toISOString().slice(0,10));
  }
  return { startUTC: new Date(startKey), endUTC, daysKST };
}

const round1 = v => Math.round((Number(v)||0)*10)/10;
const safePct = (num,den) => (den && Math.abs(den)>1e-9) ? (num/den)*100 : 0;
const stripKRW = s => String(s||'').replace(/^KRW[-/]/,'');
const addKRW = s => s.startsWith('KRW-') ? s : `KRW-${s}`;

function toKSTDateKey(dt){
  const d = new Date(dt);
  if (isNaN(d)) return String(dt).slice(0,10);
  const k = new Date(d.getTime() + MS9H);
  return k.toISOString().slice(0,10);
}

function bootstrapState(rows, initCash){
  let cash = initCash; const pos={}, lastPrice={}, lots={};
  for (const t of rows){
    const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; lastPrice[sym]=px; (lots[sym] ||= []).push({qty,cost:px}); }
    else if (side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; lastPrice[sym]=px;
      let r=qty; const q=(lots[sym] ||= []);
      while(r>1e-12 && q.length){ const lot=q[0]; const take=Math.min(r,lot.qty); lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift(); }
    }
  }
  return { cash, pos, lots, lastPrice };
}
function calcEquityTx(cash,pos,last){
  let v = Number(cash)||0;
  for (const s of Object.keys(pos||{})){
    v += (Number(pos[s])||0) * (Number(last[s])||0);
  }
  return v;
}
function cloneLots(obj){ const out={}; for(const k of Object.keys(obj||{})){ out[k]=(obj[k]||[]).map(x=>({qty:x.qty, cost:x.cost})); } return out; }

function collectMarkets(opening, txList){
  const set = new Set();
  for (const s of Object.keys(opening.pos||{})) if ((opening.pos[s]||0)!==0) set.add(addKRW(s));
  for (const t of txList){ const s=addKRW(stripKRW(t.market)); set.add(s); }
  return Array.from(set);
}

/* ===== Upbit helpers ===== */
async function fetchDailyCloses(markets, daysKST){
  const out = {};
  if (!markets.length) return out;
  await Promise.all(markets.map(async m=>{
    try{
      const { data } = await axios.get('https://api.upbit.com/v1/candles/days', { params:{ market:m, count: daysKST.length+2 }});
      // data는 최근→과거, candle_date_time_kst 사용
      const map = {};
      for (const c of data){
        const key = String(c.candle_date_time_kst).slice(0,10);
        map[key] = Number(c.trade_price) || 0; // 종가
      }
      out[m] = map;
    }catch{ out[m] = {}; }
  }));
  return out;
}
async function fetchTickers(markets){
  if (!markets.length) return {};
  try{
    const { data } = await axios.get('https://api.upbit.com/v1/ticker', { params:{ markets: markets.join(',') }});
    const px={}; for (const r of data){ px[r.market] = Number(r.trade_price)||0; } return px;
  }catch{ return {}; }
}

/* ===== My MtM (15일) ===== */
function computeMyMtMSeries15D(opening, txList, daysKST, closesByMkt, tickers){
  // 시작 상태 복제
  let cash = opening.cash;
  const pos={...opening.pos}, last={...opening.lastPrice};
  const lots = cloneLots(opening.lots);

  // 거래를 KST 일자별로 그룹
  const byDay = new Map();
  for (const t of txList){
    const day = toKSTDateKey(t.created_at);
    if(!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const equityCurve=[];

  for (let i=0;i<daysKST.length;i++){
    const dayKey = daysKST[i];

    // 1) 당일 거래 반영
    const list = byDay.get(dayKey) || [];
    for (const t of list){
      const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
      const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
      if (side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; (lots[sym] ||= []).push({qty,cost:px}); }
      else if (side==='sell'||side==='ask'){
        cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px;
        let r=qty; const q=(lots[sym] ||= []);
        while(r>1e-12 && q.length){ const lot=q[0]; const take=Math.min(r,lot.qty); lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift(); }
      }
    }

    // 2) 당일 평가가격: 종가(오늘은 현재가 우선)
    let eq = Number(cash)||0;
    for (const s of Object.keys(pos||{})){
      const m = addKRW(s);
      let px = (i===daysKST.length-1 ? (tickers[m] ?? undefined) : undefined);
      if (px==null) px = closesByMkt[m]?.[dayKey];
      if (px==null) px = last[s] ?? 0;
      eq += (Number(pos[s])||0) * Number(px||0);
    }
    equityCurve.push(eq);
  }

  // 수익률은 첫 날 대비 누적(%)
  const base = equityCurve[0] || 0;
  const returnSeries = equityCurve.map(v => safePct(v - base, base));
  return { equityCurve, returnSeries };
}

/* ===== 월 실현손익(FIFO) ===== */
function computeRealizedPnL_FIFO(preRowsBeforeStart, txRowsPeriod, initCash){
  // 시작 시점 상태
  const st = bootstrapState(preRowsBeforeStart, initCash);
  let cash = st.cash;
  const lots = cloneLots(st.lots);
  let realized = 0;

  for (const t of txRowsPeriod){
    const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){
      cash -= amt; (lots[sym] ||= []).push({qty, cost:px});
    } else if (side==='sell'||side==='ask'){
      cash += amt;
      let r=qty, pnl=0; const q=(lots[sym] ||= []);
      while (r>1e-12 && q.length){
        const lot = q[0];
        const take = Math.min(r, lot.qty);
        pnl += (px - lot.cost) * take;
        lot.qty -= take; r -= take;
        if (lot.qty <= 1e-12) q.shift();
      }
      realized += pnl;
    }
  }
  return realized;
}

/* ===== Peer 평균(간단형) — 트랜잭션 기반 (15일 창) ===== */
async function computePeerAvgReturnSeriesSimple_KST(openingEq, startUTC, endUTC, daysKST){
  const [rows] = await tradingPool.query(
    `SELECT user_id, market, side, price, quantity, created_at, id
       FROM (${UNION_SQL}) t
      WHERE t.created_at>=? AND t.created_at<?
      ORDER BY user_id, created_at, id`, [startUTC,endUTC]
  );
  if (!rows.length) return daysKST.map(()=>0);
  const byUser=new Map();
  for (const r of rows){ if(!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }

  const curves=[];
  for (const [,list] of byUser){
    let cash=openingEq, pos={}, last={}; const by={};
    for (const t of list){
      const sym=stripKRW(t.market), side=String(t.side||'').toLowerCase();
      const qty=Number(t.quantity)||0, px=Number(t.price)||0, amt=px*qty;
      if(side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; }
      else if(side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px; }
      by[toKSTDateKey(t.created_at)] = cash + Object.keys(pos).reduce((s,k)=>s+(pos[k]||0)*(last[k]||0),0);
    }
    const eq=[]; let prev=openingEq;
    for(const k of daysKST){ const v=(by[k]!=null)?by[k]:prev; eq.push(v); prev=v; }
    curves.push(eq);
  }
  const n=curves.length;
  return daysKST.map((_,i)=> n ? (curves.reduce((s,c)=>s + safePct((c[i]-openingEq), openingEq),0)/n) : 0 );
}
