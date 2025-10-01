// public/mypage.js
(function () {
  const KRW = (v) => '₩' + (Number(v || 0)).toLocaleString('ko-KR');
  const fmtQty = (v) => (Number(v || 0)).toLocaleString('ko-KR', { maximumFractionDigits: 8 });
  const plusColor = '#FF6B6B';   // + 빨강
  const minusColor = '#84ceff';  // - 파랑

  const koLabel = (sym) => ({
    BTC: '비트코인 (BTC)',
    ETH: '이더리움 (ETH)',
    XRP: '리플 (XRP)',
  }[String(sym || '').toUpperCase()] || sym);

  const addKRW = (s) =>
    (String(s || '').toUpperCase().startsWith('KRW-')
      ? String(s).toUpperCase()
      : `KRW-${String(s || '').toUpperCase()}`);

  function pickTbody() {
    return (
      document.getElementById('holdingsBody') ||
      document.querySelector('.holdings table tbody') ||
      document.querySelector('table tbody')
    );
  }

  function ensureHeader() {
    const hdr = document.querySelector('table thead tr');
    if (!hdr) return;

    const ths = Array.from(hdr.querySelectorAll('th')).map((th) =>
      th.textContent.trim()
    );
    
    // 4컬럼 구조 확인: 종목, 보유수량, 평균매입가, 평가금액
    const expectedCols = ['종목', '보유수량', '평균매입가', '평가금액'];
    const currentCols = ths.length;
    
    if (currentCols < 4) {
      console.warn('테이블 헤더가 4컬럼 구조가 아닙니다.');
    }
  }

  async function fetchJSON(url, opts) {
    try {
      const r = await fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch {
      return null;
    }
  }

  async function fetchUpbitPrices(symbols) {
    const need = Array.from(new Set(symbols.map((s) => addKRW(s))));
    if (!need.length) return {};
    try {
      const r = await fetch('https://api.upbit.com/v1/ticker?markets=' + need.join(','));
      if (!r.ok) return {};
      const data = await r.json();
      const out = {};
      for (const d of data || []) {
        const sym = String(d.market || '').replace(/^KRW-/, '');
        out[sym] = Number(d.trade_price) || 0;
      }
      return out;
    } catch {
      return {};
    }
  }

  async function loadHoldings() {
    const tbody = pickTbody();
    if (!tbody) return;
    ensureHeader();

    // 1) 서버 계산 포지션 + 2) 사용자 잔고 동시 로드
    const [hold, user] = await Promise.all([
      fetchJSON('/api/user/holdings'), // { positions: [...] }
      fetchJSON('/api/user'),          // { btc_balance, eth_balance, xrp_balance, ... }
    ]);

    const positions = (hold && Array.isArray(hold.positions)) ? hold.positions : [];
    const posMap = {};
    for (const p of positions) posMap[String(p.symbol).toUpperCase()] = p;

    // 지갑 잔고 기반 수량 (거래내역 없어도 표시되게)
    const balanceQty = {
      BTC: Number(user?.btc_balance || 0),
      ETH: Number(user?.eth_balance || 0),
      XRP: Number(user?.xrp_balance || 0),
    };

    // 렌더 대상 심볼 결정
    // 수정: 포지션에서 수량이 0보다 크거나, 지갑에서 수량이 0보다 큰 경우만 표시
    // 단, 매우 작은 값(0.00000001 미만)은 0으로 간주
    const symSet = new Set();
    const THRESHOLD = 0.00000001; // 아주 작은 수량은 무시
    
    positions.forEach((p) => {
      const qty = Number(p.quantity || 0);
      if (qty > THRESHOLD) {
        symSet.add(String(p.symbol).toUpperCase());
      }
    });
    
    Object.entries(balanceQty).forEach(([s, q]) => {
      if (q > THRESHOLD) {
        // 포지션에 없는 경우에만 지갑 잔고 기반으로 추가
        // 포지션에 이미 있다면 포지션 정보를 우선시
        if (!posMap[s]) {
          symSet.add(s);
        }
      }
    });

    const syms = Array.from(symSet).sort();

    // 가격 확보: holdings.current_price 우선, 없으면 Upbit로 보충
    const havePrice = {};
    const needPrice = [];
    for (const s of syms) {
      const p = posMap[s];
      if (p && (p.current_price || p.current_price === 0)) {
        havePrice[s] = Number(p.current_price) || 0;
      } else {
        needPrice.push(s);
      }
    }
    const fetched = needPrice.length ? await fetchUpbitPrices(needPrice) : {};
    const priceMap = Object.assign({}, havePrice, fetched);

    // 4컬럼 행 구성: 종목 | 보유수량 | 평균매입가 | 평가금액(손익)
    const rows = syms.map((s) => {
      const p = posMap[s];
      
      // 포지션이 있으면 포지션의 수량 사용, 없으면 지갑 잔고 사용
      // 중요: 포지션 수량이 0이면 표시하지 않아야 함
      let qty = 0;
      if (p) {
        qty = Number(p.quantity || 0);
        // 포지션이 있는데 수량이 0이면 건너뛰기
        if (qty <= THRESHOLD) return null;
      } else {
        // 포지션이 없으면 지갑 잔고 확인
        qty = Number(balanceQty[s] || 0);
        if (qty <= THRESHOLD) return null;
      }
      
      const currentPrice =
        (p && (p.current_price || p.current_price === 0))
          ? Number(p.current_price)
          : Number(priceMap[s] || 0);
      const value = Math.round(qty * currentPrice);

      // 평균매입가 (avg_cost 또는 avg_price 필드 사용)
      const avgPrice = p ? (Number(p.avg_cost) || Number(p.avg_price) || 0) : 0;
      const avgPriceText = avgPrice > 0 ? 
        `<span class="avg-price">${KRW(avgPrice)}</span>` : 
        '<span style="opacity:.6">-</span>';

      // 손익 계산
      let pnlHTML = '';
      if (p && typeof p.pnl === 'number') {
        const sign = p.pnl >= 0 ? '+' : '−';
        const color = p.pnl >= 0 ? plusColor : minusColor;
        pnlHTML = `<br><small style="color:${color}">(${sign}${KRW(Math.abs(p.pnl))})</small>`;
      } else if (qty > 0) {
        pnlHTML = `<br><small style="opacity:.6">(원가 정보 없음)</small>`;
      }

      return `
        <tr>
          <td><strong>${koLabel(s)}</strong></td>
          <td>${fmtQty(qty)}</td>
          <td>${avgPriceText}</td>
          <td>${KRW(value)}${pnlHTML}</td>
        </tr>
      `;
    }).filter(row => row !== null); // null 값 필터링

    tbody.innerHTML = rows.length
      ? rows.join('')
      : `<tr><td colspan="4" style="opacity:.7; text-align:center;">보유 중인 자산이 없습니다.</td></tr>`;
  }

  // 초기 로드 + 새로고침 버튼 이벤트 등록
  window.addEventListener('load', () => {
    loadHoldings();

    const btn = document.getElementById('refreshHoldingsBtn');
    if (btn) {
      btn.addEventListener('click', loadHoldings);
    }
  });
})();