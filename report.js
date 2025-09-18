// report.js — 최근 15일(그래프), 월(MTD) KPI, MtM(일봉) + 오늘 현재가 반영, 월 실현손익(FIFO),
// 피어 평균 수익률: 이상치 클리핑(±300%) + 상하 10% 트림 평균(로버스트)
const axios = require('axios');
const { keycloak } = require("./services/keycloak-config.js");
const { tradingPool } = require("./services/database.js");

const INIT_CASH = Number(process.env.INIT_CASH || 10_000_000); // 초기 현금(백테스트/기본값)
const MS9H = 9 * 60 * 60 * 1000;

/* ======================== 공통 SQL ======================== */
// transactions + pending_orders(filled) 중복 제거 병합
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

/* ======================== 라우트 등록 ======================== */
module.exports = function registerReport(app) {
  app.get("/api/user/report", keycloak.protect(), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      /* ===== 그래프 기간: 최근 15일(KST) ===== */
      const { startUTC: startUTC_15d, endUTC: endUTC_15d, daysKST } = lastNDaysRangeKST(15);

      /* ===== KPI 기간: 이번 달(KST) ===== */
      const now = new Date();
      const { start: monthStartUTC, end: monthEndUTC } = monthRangeKST(now);
      const endUTC_MTD = clampEndToTodayKST(monthEndUTC);

      /* ===== 시작 이전 거래로 상태 복원 (그래프용) ===== */
      const [preRows] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at < ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, startUTC_15d]
      );
      const opening = bootstrapState(preRows, INIT_CASH);

      /* ===== 15일 구간 거래 (그래프용) ===== */
      const [txWindow] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, startUTC_15d, endUTC_15d]
      );

      /* ===== 시세: 일봉 종가 + 실시간 현재가 ===== */
      const marketsNeeded = collectMarkets(opening, txWindow);
      const closes = await fetchDailyCloses(marketsNeeded, daysKST); // { 'KRW-BTC': { 'YYYY-MM-DD': px, ... }, ... }
      const tickers = await fetchTickers(marketsNeeded);            // { 'KRW-BTC': px, ... }

      /* ===== 내 MtM: equityCurve / returnSeries ===== */
      const { equityCurve, returnSeries } = computeMyMtMSeries15D(opening, txWindow, daysKST, closes, tickers);

      /* ===== KPI: 이번 달 내 거래 횟수 (월초~오늘 KST) ===== */
      const [[{ trades_mtd }]] = await tradingPool.query(
        `SELECT COUNT(*) AS trades_mtd
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?`,
        [userId, monthStartUTC, endUTC_MTD]
      );

      /* ===== Top 거래 종목(최근 15일) ===== */
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

      /* ===== 전체 평균 수익률(로버스트) ===== */
      const openingEq_base = equityCurve.length
        ? equityCurve[0]
        : calcEquityTx(opening.cash, opening.pos, opening.lastPrice);

      const peerAvgReturnSeries = await computePeerAvgReturnSeriesRobust_KST(
        openingEq_base, startUTC_15d, endUTC_15d, daysKST
      );

      /* ===== (MTD) 월 실현손익(FIFO) ===== */
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

      /* ===== 최근 체결 20건 + 각 매도건의 실현손익(FIFO) ===== */
      const [recent] = await tradingPool.query(
        `SELECT id,created_at,market,side,price,quantity
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 20`,
        [userId]
      );

      // 최근 목록의 가장 이른 시각을 구해, 그 이전까지를 프리롤, 그 이후를 창으로 잡아 FIFO 누적
      const recentIds = new Set(recent.map(r => r.id));
      const earliestTs = recent.length ? recent.reduce((m, r) => (r.created_at < m ? r.created_at : m), recent[0].created_at) : null;

      let realizedMap = {};
      if (earliestTs) {
        const [preBeforeRecent] = await tradingPool.query(
          `SELECT id,market,side,price,quantity,created_at
             FROM (${UNION_SQL}) t
            WHERE t.user_id=? AND t.created_at < ?
            ORDER BY t.created_at ASC, t.id ASC`,
          [userId, earliestTs]
        );
        const [windowAsc] = await tradingPool.query(
          `SELECT id,market,side,price,quantity,created_at
             FROM (${UNION_SQL}) t
            WHERE t.user_id=? AND t.created_at >= ?
            ORDER BY t.created_at ASC, t.id ASC`,
          [userId, earliestTs]
        );
        realizedMap = computePerTradeRealizedFIFO(preBeforeRecent, windowAsc, INIT_CASH, recentIds);
      }

      const recentFills = recent.map(r => {
        const qty = Number(r.quantity) || 0;
        const px  = Number(r.price) || 0;
        const total = Math.round(qty * px);
        const realized = (realizedMap[r.id] != null) ? Math.round(realizedMap[r.id]) : null;
        return {
          id: r.id,
          ts: r.created_at,
          sym: r.market,
          side: r.side,
          price: px,
          qty,
          total,
          realized
        };
      });

      /* ===== 응답 ===== */
      const monthlyReturnPct = openingEq_base
        ? round1(safePct((equityCurve.at(-1) ?? openingEq_base) - openingEq_base, openingEq_base))
        : 0;

      res.json({
        days: daysKST, // 그래프 구간: 최근 15일
        my: {
          monthlyTrades: trades_mtd,
          monthlyTradesDiff: null,

          monthlyPnL: Math.round(monthlyPnL || 0),
          monthlyPnLDiff: null,

          monthlyReturnPct,
          returnRankPctile: null,

          topSymbols,

          equityCurve: equityCurve.map(v => (Number.isFinite(v) ? v : 0)),
          returnSeries: returnSeries.map(round1),

          peerAvgReturnSeries: (peerAvgReturnSeries || []).map(round1),

          marketReturnSeries: new Array(daysKST.length).fill(0),

          recentFills
        }
      });
    } catch (e) {
      console.error('report api error:', e);
      res.status(500).json({ error: 'Failed to build report' });
    }
  });
};

/* ================= Helpers: 시간/기간 ================= */
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
function lastNDaysRangeKST(n){
  const now = new Date();
  const todayKST = new Date(now.getTime() + MS9H);
  const todayKey = todayKST.toISOString().slice(0,10); // YYYY-MM-DD
  const startKeyUTC = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - MS9H - (n-1)*(24*60*60*1000));
  const endUTC   = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() - MS9H + (1)*(24*60*60*1000)); // 내일 00:00(KST) UTC
  const daysKST=[]; const day=24*60*60*1000;
  for(let t=startKeyUTC.getTime()+MS9H; t<endUTC.getTime()+MS9H; t+=day){
    daysKST.push(new Date(t).toISOString().slice(0,10));
  }
  return { startUTC: new Date(startKeyUTC), endUTC, daysKST };
}
const toKSTDateKey = (dt) => {
  const d = new Date(dt);
  if (isNaN(d)) return String(dt).slice(0,10);
  const k = new Date(d.getTime() + MS9H);
  return k.toISOString().slice(0,10);
};

/* ================= Helpers: 수치/유틸 ================= */
const round1 = v => Math.round((Number(v)||0)*10)/10;
const safePct = (num,den) => (den && Math.abs(den)>1e-9) ? (num/den)*100 : 0;
const norm = s => String(s || '').trim().toUpperCase();
const stripKRW = s => norm(s).replace(/^KRW[-/]/i, '');
const addKRW   = s => norm(s).startsWith('KRW-') ? norm(s) : `KRW-${norm(s)}`;

/* ================= Helpers: 포지션/로트 ================= */
function bootstrapState(rows, initCash){
  let cash = initCash; const pos={}, lastPrice={}, lots={};
  for (const t of rows){
    const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){
      cash-=amt; pos[sym]=(pos[sym]||0)+qty; lastPrice[sym]=px; (lots[sym] ||= []).push({qty,cost:px});
    } else if (side==='sell'||side==='ask'){
      cash+=amt; pos[sym]=(pos[sym]||0)-qty; lastPrice[sym]=px;
      let r=qty; const q=(lots[sym] ||= []);
      while(r>1e-12 && q.length){
        const lot=q[0]; const take=Math.min(r,lot.qty);
        lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift();
      }
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
function cloneLots(obj){
  const out={};
  for(const k of Object.keys(obj||{})){
    out[k]=(obj[k]||[]).map(x=>({qty:x.qty, cost:x.cost}));
  }
  return out;
}
function collectMarkets(opening, txList){
  const set = new Set();
  for (const s of Object.keys(opening.pos||{})) if ((opening.pos[s]||0)!==0) set.add(addKRW(s));
  for (const t of txList){ const s=addKRW(stripKRW(t.market)); set.add(s); }
  return Array.from(set);
}

/* ================= 시세(Upbit) ================= */
async function fetchDailyCloses(markets, daysKST){
  const out = {};
  if (!markets.length) return out;
  await Promise.all(markets.map(async m=>{
    try{
      const { data } = await axios.get('https://api.upbit.com/v1/candles/days', { params:{ market:m, count: daysKST.length+2 }});
      const map = {};
      for (const c of data){
        const key = String(c.candle_date_time_kst).slice(0,10);
        map[key] = Number(c.trade_price) || 0;
      }
      out[m] = map;
    }catch{
      out[m] = {};
    }
  }));
  return out;
}
async function fetchTickers(markets){
  if (!markets.length) return {};
  try{
    const { data } = await axios.get('https://api.upbit.com/v1/ticker', { params:{ markets: markets.join(',') }});
    const px={}; for (const r of data){ px[r.market] = Number(r.trade_price)||0; } return px;
  }catch{
    return {};
  }
}

/* ================= 평가곡선(MtM) ================= */
function computeMyMtMSeries15D(opening, txList, daysKST, closesByMkt, tickers){
  let cash = opening.cash;
  const pos={...opening.pos}, last={...opening.lastPrice};
  const lots = cloneLots(opening.lots);

  const byDay = new Map();
  for (const t of txList){
    const day = toKSTDateKey(t.created_at);
    if(!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const equityCurve=[];

  for (let i=0;i<daysKST.length;i++){
    const dayKey = daysKST[i];

    const list = byDay.get(dayKey) || [];
    for (const t of list){
      const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
      const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
      if (side==='buy'||side==='bid'){
        cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; (lots[sym] ||= []).push({qty,cost:px});
      } else if (side==='sell'||side==='ask'){
        cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px;
        let r=qty; const q=(lots[sym] ||= []);
        while(r>1e-12 && q.length){
          const lot=q[0]; const take=Math.min(r,lot.qty);
          lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift();
        }
      }
    }

    let eq = Number(cash)||0;
    for (const s of Object.keys(pos||{})){
      const m = addKRW(s);
      let px = (i===daysKST.length-1 ? (tickers[m] ?? undefined) : undefined);
      if (px==null) px = closesByMkt[m]?.[dayKey];
      if (px==null) px = last[s];
      if (px==null) px = 0;
      eq += (Number(pos[s])||0) * Number(px||0);
    }
    equityCurve.push(eq);
  }

  const base = equityCurve[0] || 0;
  const returnSeries = equityCurve.map(v => safePct(v - base, base));
  return { equityCurve, returnSeries };
}

/* ================= 월 실현손익(FIFO) — 구간 합산 ================= */
function computeRealizedPnL_FIFO(preRowsBeforeStart, txRowsPeriod, initCash){
  const st = bootstrapState(preRowsBeforeStart, initCash);
  let realized = 0;
  const lots = cloneLots(st.lots);

  for (const t of txRowsPeriod){
    const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0;
    if (side==='buy'||side==='bid'){
      (lots[sym] ||= []).push({qty, cost:px});
    } else if (side==='sell'||side==='ask'){
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

/* ================= 매도 행별 실현손익(FIFO) — 맵(id→pnl) ================= */
function computePerTradeRealizedFIFO(preRowsBeforeStart, txRowsAsc, initCash, targetIdSet){
  const st = bootstrapState(preRowsBeforeStart, initCash);
  const lots = cloneLots(st.lots);
  const out = {};
  for (const t of txRowsAsc){
    const sym = stripKRW(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0;
    if (side==='buy'||side==='bid'){
      (lots[sym] ||= []).push({qty, cost:px});
    } else if (side==='sell'||side==='ask'){
      let r=qty, pnl=0; const q=(lots[sym] ||= []);
      while (r>1e-12 && q.length){
        const lot = q[0];
        const take = Math.min(r, lot.qty);
        pnl += (px - lot.cost) * take;
        lot.qty -= take; r -= take;
        if (lot.qty <= 1e-12) q.shift();
      }
      if (targetIdSet && targetIdSet.has(t.id)) out[t.id] = pnl;
    }
  }
  return out;
}

/* ================= 피어 평균(로버스트) ================= */
// 상하 10% 절단 평균
function trimmedMean(arr, trim=0.10){
  const vals = arr.filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
  if (!vals.length) return 0;
  const k = Math.floor(vals.length * trim);
  const sliced = vals.slice(k, vals.length - k);
  if (!sliced.length) return vals[Math.floor(vals.length/2)]; // 중앙값 대체
  return sliced.reduce((s,v)=>s+v,0) / sliced.length;
}

// 이상치 클리핑
const clampPct = (x, a=-300, b=300) => Math.max(a, Math.min(b, x));

async function computePeerAvgReturnSeriesRobust_KST(openingEq, startUTC, endUTC, daysKST){
  const [rows] = await tradingPool.query(
    `SELECT user_id, market, side, price, quantity, created_at, id
       FROM (${UNION_SQL}) t
      WHERE t.created_at>=? AND t.created_at<?
      ORDER BY user_id, created_at, id`, [startUTC, endUTC]
  );
  if (!rows.length) return daysKST.map(()=>0);

  const byUser=new Map();
  for (const r of rows){
    if(!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  const retByDay = daysKST.map(()=>[]);

  for (const [,list] of byUser){
    // 간이 equity: 체결가 기준, 포지션/현금 업데이트
    let cash = openingEq;
    const pos={}, last={}, eqByDay={};

    for (const t of list){
      const sym=stripKRW(t.market), side=String(t.side||'').toLowerCase();
      const qty=Number(t.quantity)||0, px=Number(t.price)||0, amt=px*qty;
      if (side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; }
      else if (side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px; }
      const eqNow = cash + Object.keys(pos).reduce((s,k)=> s + (pos[k]||0)*(last[k]||0), 0);
      eqByDay[toKSTDateKey(t.created_at)] = eqNow;
    }

    // 일자별 곡선(거래 없으면 전일값 유지)
    let prev = openingEq;
    const curve=[];
    for (const d of daysKST){
      const v = (eqByDay[d] != null) ? eqByDay[d] : prev;
      curve.push(v); prev=v;
    }

    const base = curve[0];
    if (!Number.isFinite(base) || Math.abs(base) < 1e-8) continue; // 비정상 사용자 제외

    for (let i=0;i<daysKST.length;i++){
      let r = ((curve[i] - base) / base) * 100;
      if (!Number.isFinite(r)) continue;
      retByDay[i].push(clampPct(r, -300, 300)); // ±300% 클리핑
    }
  }

  // 날짜별 상하 10% 절단 평균
  return daysKST.map((_,i)=> trimmedMean(retByDay[i], 0.10));
}
