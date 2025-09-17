// report.js — 오늘(한국시간)까지, 마지막 포인트는 "현금 + 현재가×수량", 중복체결 제거, KST 일관화
const axios = require('axios');
const { keycloak } = require("./services/keycloak-config.js");
const { tradingPool } = require("./services/database.js"); // RT_trading_db 풀

const INIT_CASH = Number(process.env.INIT_CASH || 10_000_000);
const MS9H = 9 * 60 * 60 * 1000;

// ===== 거래 원본 (중복 제거) =====
// 1) transactions 전부
// 2) pending_orders 중 filled 이면서, 동일 체결(유저/심볼/사이드/가격/수량/±300초)이 transactions에 없을 때만 포함
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

      // === 이번 달/전월 KST 월경계 (DB 비교는 UTC) ===
      const now = new Date();
      const { start: thisStartUTC, end: thisEndUTC } = monthRangeKST(now);
      const { start: prevStartUTC, end: prevEndUTC } = monthRangeKST(addMonths(now, -1));

      // === 오늘(한국시간)까지만 ===
      const clampedEndUTC = clampEndToTodayKST(thisEndUTC);

      // --- 월초 이전 거래로 '월초 상태' 복원 ---
      const [preRows] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at < ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, thisStartUTC]
      );
      const opening = bootstrapState(preRows, INIT_CASH);
      const openingEq_tx = calcEquityTx(opening.cash, opening.pos, opening.lastPrice); // 체결가 기준 월초 자산

      // 이번 달(오늘까지) / 전월 거래
      const [txThis] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, thisStartUTC, clampedEndUTC]
      );
      const [txPrev] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, prevStartUTC, prevEndUTC]
      );

      // KPI: 거래 건수
      const [[{ trades_curr }]] = await tradingPool.query(
        `SELECT COUNT(*) AS trades_curr
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?`,
        [userId, thisStartUTC, clampedEndUTC]
      );
      const [[{ trades_prev }]] = await tradingPool.query(
        `SELECT COUNT(*) AS trades_prev
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?`,
        [userId, prevStartUTC, prevEndUTC]
      );

      // Top 종목 (거래금액 비중)
      const [topRows] = await tradingPool.query(
        `SELECT market, SUM(price*quantity) AS vol
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
          GROUP BY market ORDER BY vol DESC LIMIT 5`,
        [userId, thisStartUTC, clampedEndUTC]
      );
      const volSum = topRows.reduce((s, r) => s + Number(r.vol || 0), 0);
      const topSymbols = topRows.map(r => ({
        symbol: clean(r.market),
        share: volSum ? Number(r.vol)/volSum : 0
      }));

      // 최근 체결 20건
      const [recent] = await tradingPool.query(
        `SELECT id,created_at,market,side,price,quantity
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 20`,
        [userId]
      );

      // === 월초 상태에서 이번 달 거래 반영 (체결가 기준) — 과거 구간 ===
      const {
        equityCurve: equityCurve_tx,
        returnSeries: returnSeries_tx,
        monthlyPnL,
        perFillPnl,
        monthEndEq: monthEndEq_tx,
        daysKST
      } = computeFromTxWithOpening_KST(txThis, thisStartUTC, clampedEndUTC, opening, openingEq_tx);

      // === 마지막 포인트(오늘)는 "현금 + 현재가×수량"으로 재평가 ===
      const todayKey = toKSTDateKey(new Date());
      const liveEq = await calcEquityLiveByUpbit(opening, txThis); // 현재가 조회
      const equityCurve = equityCurve_tx.slice();
      const returnSeries = returnSeries_tx.slice();
      if (daysKST.length && daysKST[daysKST.length - 1] === todayKey && Number.isFinite(liveEq)) {
        equityCurve[equityCurve.length - 1] = liveEq;
        returnSeries[returnSeries.length - 1] = safePct(liveEq - openingEq_tx, openingEq_tx);
      }

      // 전월 실현 손익(비교, 체결가 기준)
      const [prePrevRows] = await tradingPool.query(
        `SELECT id,market,side,price,quantity,created_at
           FROM (${UNION_SQL}) t
          WHERE t.user_id=? AND t.created_at < ?
          ORDER BY t.created_at ASC, t.id ASC`,
        [userId, prevStartUTC]
      );
      const prevOpening = bootstrapState(prePrevRows, INIT_CASH);
      const { monthlyPnL: prevPnL } =
        computeFromTxWithOpening_KST(
          txPrev, prevStartUTC, prevEndUTC,
          prevOpening, calcEquityTx(prevOpening.cash, prevOpening.pos, prevOpening.lastPrice)
        );

      // 전체 평균 수익률(간단형, 체결가 기준)
      const peerAvgReturnSeries = await computePeerAvgReturnSeriesSimple_KST(
        calcEquityTx(opening.cash, opening.pos, opening.lastPrice),
        thisStartUTC, clampedEndUTC, daysKST
      );

      const monthlyReturnPct = safePct((equityCurve.at(-1) ?? monthEndEq_tx) - openingEq_tx, openingEq_tx);
      const returnRankPctile = await computeReturnPercentileSimple_KST(
        openingEq_tx, thisStartUTC, clampedEndUTC, monthlyReturnPct
      );

      const recentFills = recent.map(r => ({
        ts: r.created_at,
        sym: r.market,
        side: r.side,
        price: Number(r.price)||0,
        qty: Number(r.quantity)||0,
        pnl: perFillPnl.get(r.id) ?? 0
      }));

      res.json({
        days: daysKST, // 'YYYY-MM-DD' (KST, 오늘까지만)
        my: {
          monthlyTrades: trades_curr,
          monthlyTradesDiff: trades_curr - (Number(trades_prev)||0),
          monthlyPnL: Math.round(monthlyPnL||0),
          monthlyPnLDiff: Math.round((monthlyPnL||0) - (prevPnL||0)),
          monthlyReturnPct: round1(monthlyReturnPct),
          returnRankPctile,
          topSymbols,
          equityCurve: equityCurve.map(v=>Math.round(v||0)),
          returnSeries: returnSeries.map(round1),
          peerAvgReturnSeries: (peerAvgReturnSeries||[]).map(round1),
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

/* ---------- Helpers ---------- */
function monthRangeKST(anchor){
  const kst = new Date(anchor.getTime() + MS9H);
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth();
  const startKST = new Date(Date.UTC(y, m,   1));
  const endKST   = new Date(Date.UTC(y, m+1, 1));
  return { start: new Date(startKST.getTime() - MS9H), end: new Date(endKST.getTime() - MS9H) };
}
function addMonths(d,m){ const x=new Date(d); x.setUTCMonth(x.getUTCMonth()+m); return x; }
function clampEndToTodayKST(endUTC){
  const now = new Date();
  const nowKST = new Date(now.getTime() + MS9H);
  const todayKey = nowKST.toISOString().slice(0,10);
  const kstTomorrow00UTC = new Date(new Date(todayKey + 'T00:00:00Z').getTime() - MS9H + 24*60*60*1000);
  return new Date(Math.min(endUTC.getTime(), kstTomorrow00UTC.getTime()));
}
const round1 = v => Math.round((Number(v)||0)*10)/10;
const safePct = (num,den) => (den && Math.abs(den)>1e-9) ? (num/den)*100 : 0;
const clean = s => String(s||'').replace(/^KRW[-/]/,'');

function toKSTDateKey(dt){
  const d = new Date(dt);
  if (isNaN(d)) return String(dt).slice(0,10);
  const k = new Date(d.getTime() + MS9H);
  return k.toISOString().slice(0,10);
}

function buildDaysKST(startUTC,endUTC){
  const out=[]; let t = startUTC.getTime() + MS9H; let end = endUTC.getTime() + MS9H;
  const day = 24*60*60*1000;
  for (let x = t; x < end; x += day){ out.push(new Date(x).toISOString().slice(0,10)); }
  return out;
}

/** 월초 이전 거래를 모두 반영해 월초 상태 복원 (체결가 기준) */
function bootstrapState(rows, initCash){
  let cash = initCash; const pos={}, lastPrice={}, lots={};
  for (const t of rows){
    const sym = clean(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; lastPrice[sym]=px; (lots[sym] ||= []).push({qty,cost:px}); }
    else if (side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; lastPrice[sym]=px;
      let r=qty; const q=(lots[sym] ||= []); while(r>1e-12 && q.length){ const lot=q[0]; const take=Math.min(r,lot.qty); lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift(); }
    }
  }
  return { cash, pos, lots, lastPrice };
}

/** 체결가 기준 평가 (백업값) */
function calcEquityTx(cash,pos,last){
  let v = Number(cash)||0;
  for (const s of Object.keys(pos||{})){
    const px = Number(last[s])||0;
    v += (Number(pos[s])||0) * px;
  }
  return v;
}

/** 실시간 현재가로 "오늘" 평가 — Upbit REST (공개) 사용 */
async function calcEquityLiveByUpbit(opening, txThis){
  // 월초 상태 복제 후 이번달 체결 반영 → 보유수량/현금 업데이트
  let cash = opening.cash;
  const pos={...opening.pos}, last={...opening.lastPrice}, lots=cloneLots(opening.lots);

  for (const t of txThis){
    const sym = clean(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){
      cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; (lots[sym] ||= []).push({qty,cost:px});
    }else if (side==='sell'||side==='ask'){
      cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px;
      let r=qty; const q=(lots[sym] ||= []);
      while(r>1e-12 && q.length){ const lot=q[0]; const take=Math.min(r,lot.qty); lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift(); }
    }
  }

  // 현재가 조회 (보유 종목만)
  const markets = Object.keys(pos).filter(s=> (pos[s]||0) !== 0).map(s => `KRW-${s}`);
  let prices = {};
  if (markets.length){
    try{
      const { data } = await axios.get('https://api.upbit.com/v1/ticker', { params: { markets: markets.join(',') } });
      for (const row of data) { prices[row.market] = Number(row.trade_price)||0; }
    }catch{
      // 실패 시 마지막 체결가로 fallback
      for (const s of Object.keys(pos)) prices[`KRW-${s}`] = Number(last[s])||0;
    }
  }

  let eq = Number(cash)||0;
  for (const s of Object.keys(pos)){
    const px = prices[`KRW-${s}`] ?? (Number(last[s])||0);
    eq += (Number(pos[s])||0) * px;
  }
  return eq;
}

function cloneLots(obj){ const out={}; for(const k of Object.keys(obj||{})){ out[k]=(obj[k]||[]).map(x=>({qty:x.qty, cost:x.cost})); } return out; }

/** 월초 상태에서 이번 달 거래 적용 (KST 일자 기준, 체결가 기준 누적) */
function computeFromTxWithOpening_KST(rows, startUTC, endUTC, opening, openingEq){
  let cash = opening.cash;
  const pos={...opening.pos}, lastPrice={...opening.lastPrice}, lots=cloneLots(opening.lots);
  const perFillPnl = new Map(); let realized = 0;
  const byDayEq = {};

  for (const t of rows){
    const sym = clean(t.market), side = String(t.side||'').toLowerCase();
    const qty = Number(t.quantity)||0, px = Number(t.price)||0, amt = px*qty;
    if (side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; lastPrice[sym]=px; (lots[sym] ||= []).push({qty,cost:px}); perFillPnl.set(t.id,0); }
    else if (side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; lastPrice[sym]=px;
      let r=qty, pnl=0; const q=(lots[sym] ||= []);
      while(r>1e-12 && q.length){ const lot=q[0]; const take=Math.min(r,lot.qty); pnl+=(px-lot.cost)*take; lot.qty-=take; r-=take; if(lot.qty<=1e-12) q.shift(); }
      realized += pnl; perFillPnl.set(t.id, pnl);
    }
    byDayEq[toKSTDateKey(t.created_at)] = calcEquityTx(cash,pos,lastPrice);
  }

  const daysKST = buildDaysKST(startUTC,endUTC); // 오늘까지
  const equityCurve=[]; const returnSeries=[];
  let prevEq = openingEq;
  for (const k of daysKST){
    const eq = (byDayEq[k]!=null) ? byDayEq[k] : prevEq;
    equityCurve.push(eq);
    returnSeries.push( safePct(eq - openingEq, openingEq) );
    prevEq = eq;
  }
  const monthEndEq = equityCurve[equityCurve.length-1] ?? openingEq;
  return { equityCurve, returnSeries, monthlyPnL: realized, perFillPnl, monthEndEq, daysKST };
}

/* 평균/백분위 간단형 (체결가 기준) */
async function computePeerAvgReturnSeriesSimple_KST(openingEq, startUTC, endUTC, daysKST){
  const [rows] = await tradingPool.query(
    `SELECT user_id, market, side, price, quantity, created_at, id
       FROM (${UNION_SQL}) t
      WHERE t.created_at>=? AND t.created_at<?
      ORDER BY user_id, created_at, id`, [startUTC,endUTC]
  );
  if (!rows.length) return daysKST.map(()=>0);
  const byUser=new Map();
  for (const r of rows){
    if(!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  const curves=[];
  for (const [,list] of byUser){
    let cash=openingEq, pos={}, last={}; const by={};
    for (const t of list){
      const sym=clean(t.market), side=String(t.side||'').toLowerCase();
      const qty=Number(t.quantity)||0, px=Number(t.price)||0, amt=px*qty;
      if(side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; }
      else if(side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px; } // ★ 괄호 수정 완료
      by[toKSTDateKey(t.created_at)] = calcEquityTx(cash,pos,last);
    }
    const eq=[]; let prev=openingEq;
    for(const k of daysKST){ const v=(by[k]!=null)?by[k]:prev; eq.push(v); prev=v; }
    curves.push(eq);
  }
  const n=curves.length;
  return daysKST.map((_,i)=> n ? (curves.reduce((s,c)=>s + safePct((c[i]-openingEq), openingEq),0)/n) : 0 );
}

async function computeReturnPercentileSimple_KST(openingEq, startUTC, endUTC, my){
  const [users]=await tradingPool.query(
    `SELECT user_id FROM (${UNION_SQL}) t
      WHERE t.created_at>=? AND t.created_at<? GROUP BY user_id`,[startUTC,endUTC]
  );
  if(!users.length) return 100;
  const rets=[];
  for (const u of users){
    const [tx]=await tradingPool.query(
      `SELECT id,market,side,price,quantity,created_at
         FROM (${UNION_SQL}) t
        WHERE t.user_id=? AND t.created_at>=? AND t.created_at<?
        ORDER BY t.created_at ASC, t.id ASC`,[u.user_id,startUTC,endUTC]
    );
    let cash=openingEq,pos={},last={};
    for (const t of tx){
      const sym=clean(t.market), side=String(t.side||'').toLowerCase();
      const qty=Number(t.quantity)||0, px=Number(t.price)||0, amt=px*qty;
      if(side==='buy'||side==='bid'){ cash-=amt; pos[sym]=(pos[sym]||0)+qty; last[sym]=px; }
      else if(side==='sell'||side==='ask'){ cash+=amt; pos[sym]=(pos[sym]||0)-qty; last[sym]=px; }
    }
    const endEq=calcEquityTx(cash,pos,last);
    rets.push( safePct(endEq - openingEq, openingEq) );
  }
  rets.sort((a,b)=>b-a);
  const rank = 1 + rets.findIndex(v => my >= v);
  return Math.round((rank / rets.length) * 100);
}
