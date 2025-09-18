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
    if (!ths.some((t) => /평가금액/.test(t))) {
      const th = document.createElement('th');
      th.textContent = '평가금액 (이익/손실)';
      hdr.appendChild(th);
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

    // 렌더 대상 심볼: (포지션 수량>0) ∪ (지갑 수량>0)
    const symSet = new Set();
    positions.forEach((p) => {
      if ((p.quantity || 0) > 0) symSet.add(String(p.symbol).toUpperCase());
    });
    Object.entries(balanceQty).forEach(([s, q]) => {
      if ((q || 0) > 0) symSet.add(s);
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

    // 행 구성 (수량: 포지션 수량 우선, 없으면 지갑 잔고)
    const rows = syms.map((s) => {
      const p = posMap[s];
      const qty =
        (p && (p.quantity || p.quantity === 0))
          ? Number(p.quantity)
          : Number(balanceQty[s] || 0);
      const price =
        (p && (p.current_price || p.current_price === 0))
          ? Number(p.current_price)
          : Number(priceMap[s] || 0);
      const value = Math.round(qty * price);

      let pnlHTML;
      if (p && typeof p.pnl === 'number') {
        const sign = p.pnl >= 0 ? '+' : '−';
        const color = p.pnl >= 0 ? plusColor : minusColor;
        pnlHTML = ` <span style="color:${color}">(${sign} ${KRW(Math.abs(p.pnl))})</span>`;
      } else if (qty > 0) {
        pnlHTML = ` <span style="opacity:.6">(원가 정보 없음)</span>`;
      } else {
        pnlHTML = '';
      }

      return `
        <tr>
          <td>${koLabel(s)}</td>
          <td>${fmtQty(qty)}</td>
          <td>${KRW(value)}${pnlHTML}</td>
        </tr>
      `;
    });

    tbody.innerHTML = rows.length
      ? rows.join('')
      : `<tr><td colspan="3" style="opacity:.7">보유 중인 자산이 없습니다.</td></tr>`;
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
