// UIController.js - UI 컴트롤러
/**
 * 역할: 사용자 인터페이스 업데이트 및 표시 관리
 * 주요 기능:
 * - 코인 탭 및 요약 정보 표시 (updateCoinTabs, updateCoinSummary)
 * - 거래 패널 UI 업데이트 (updateTradingPanel)
 * - 호가창 데이터 표시 (updateOrderbook)
 * - 대기/체결 주문 리스트 표시 (updatePendingOrdersList, updateFilledOrdersList)
 * - 사용자 데이터 초기화 및 로드 (setupInitialData, fetchUserData)
 * - 가격/수량 자동 계산 UI 반영 (updateOrderTotal, updateQuantityFromPrice)
 * - 코인 전환 처리 (switchCoin)
 */
import { MARKET_CODES, COIN_NAMES } from "./constants.js";
import { Utils } from "./utils.js";

export class UIController {
  // 사용자 인터페이스 업데이트 및 표시 관리 담당 클래스
  constructor(state, domManager) {
    this.state = state;
    this.dom = domManager;
    this.chart = null; // 🔧 ChartManager 참조 추가
    this.trading = null; // 🔧 TradingManager 참조 추가
    this.setupInitialData();
  }

  // 🔧 매니저 인스턴스 설정 메서드
  setManagers(chartManager, tradingManager) {
    this.chart = chartManager;
    this.trading = tradingManager;
  }

  async setupInitialData() {
    this.fetchUserData();
    this.updateCoinTabs();
    this.updateCoinSummary();
    this.updateTradingPanel();
  }

  showPendingOrders() {
    this.dom.elements.pendingOrdersSection.classList.remove("hidden");
    this.dom.elements.filledOrdersSection.classList.add("hidden");
    this.updatePendingOrdersList(this.state.pendingOrders);
  }

  showFilledOrders() {
    this.dom.elements.pendingOrdersSection.classList.add("hidden");
    this.dom.elements.filledOrdersSection.classList.remove("hidden");
    this.updateFilledOrdersList(this.state.filledOrders);
  }

  updatePendingOrdersList(orders) {
    const listElement = this.dom.elements.pendingOrdersList;
    const validOrders = orders || [];

    if (!listElement) return;

    if (validOrders.length === 0) {
      listElement.innerHTML = `<div class="no-orders-message">대기 중인 주문이 없습니다.</div>`;
      return;
    }

    const orderItemsHTML = validOrders
      .map((order) => {
        const coinSymbol = order.market ? order.market.split("-")[1] : "";
        const sideText = order.side === "bid" ? "매수" : "매도";
        const sideClass = order.side === "bid" ? "positive" : "negative";
        const priceText = `${Utils.formatKRW(order.price)}원`;
        const quantityText = `${Utils.formatCoinAmount(order.quantity, 4)}개`;

        const remainingQuantity = order.remaining_quantity || order.quantity;
        const isPartialFilled = remainingQuantity < order.quantity;
        const remainingText = isPartialFilled
          ? `(잔여: ${Utils.formatCoinAmount(remainingQuantity, 4)}개)`
          : "";

        const statusBadge = isPartialFilled
          ? '<span class="status-badge partial">부분체결</span>'
          : "";

        const totalAmount = order.price * order.quantity;
        const totalText = `총 ${Utils.formatKRW(totalAmount)}원`;

        const progressPercent = isPartialFilled
          ? (
              ((order.quantity - remainingQuantity) / order.quantity) *
              100
            ).toFixed(1)
          : 0;

        return `
          <div class="pending-order-item ${
            isPartialFilled ? "partial-filled" : ""
          }">
            <div class="order-header">
              <div class="order-main-info">
                <span class="order-side ${sideClass}">${sideText}</span>
                <span class="coin-name">${coinSymbol}</span>
                ${statusBadge}
              </div>
              <button class="cancel-btn" data-order-id="${
                order.id || order.orderId
              }">취소</button>
            </div>
            <div class="order-details">
              <div class="order-info">
                <span class="order-price">${priceText}</span>
                <span class="order-quantity">${quantityText} ${remainingText}</span>
              </div>
              <div class="order-total">${totalText}</div>
            </div>
            ${
              isPartialFilled
                ? `
              <div class="order-progress">
                <div class="progress-bar">
                  <div class="progress-fill" style="width: ${progressPercent}%"></div>
                </div>
                <span class="progress-text">${progressPercent}% 체결</span>
              </div>
            `
                : ""
            }
            <div class="order-time">${Utils.formatDateTime(
              order.created_at
            )}</div>
          </div>
        `;
      })
      .join("");

    listElement.innerHTML = orderItemsHTML;
  }

  updateFilledOrdersList(transactions) {
    const listElement = this.dom.elements.filledOrdersList;
    if (!listElement) return;

    if (!transactions || transactions.length === 0) {
      listElement.innerHTML = `<div class="no-orders-message">체결된 주문이 없습니다.</div>`;
      return;
    }

    const transactionItemsHTML = transactions
      .map((t) => {
        const coinSymbol = t.market ? t.market.split("-")[1] : "";
        const sideText = t.side === "bid" ? "매수" : "매도";
        const sideClass = t.side === "bid" ? "positive" : "negative";

        return `
          <div class="transaction-item">
            <div class="transaction-header">
              <span class="tx-side ${sideClass}">${sideText}</span>
              <span class="tx-coin">${coinSymbol}</span>
              <span class="tx-type">${
                t.type === "market" ? "시장가" : "지정가"
              }</span>
            </div>
            <div class="transaction-details">
              <span class="tx-price">체결가: ${Utils.formatKRW(
                t.price
              )}원</span>
              <span class="tx-quantity">수량: ${Utils.formatCoinAmount(
                t.quantity,
                4
              )}개</span>
              <span class="tx-total">금액: ${Utils.formatKRW(
                t.total_amount
              )}원</span>
            </div>
            <div class="tx-time">${Utils.formatDateTime(t.created_at)}</div>
          </div>
        `;
      })
      .join("");

    listElement.innerHTML = transactionItemsHTML;
  }

  updateCoinTabs() {
    const container = this.dom.elements.coinTabs;
    if (!container) return;

    if (container.children.length === 0) {
      MARKET_CODES.forEach((code) => {
        const tab = document.createElement("div");
        tab.className = `coin-tab ${
          code === this.state.activeCoin ? "active" : ""
        }`;
        tab.innerText = COIN_NAMES[code];
        tab.onclick = () => this.switchCoin(code);
        container.appendChild(tab);
      });
    }

    Array.from(container.children).forEach((tab) => {
      if (tab.innerText === COIN_NAMES[this.state.activeCoin]) {
        tab.classList.add("active");
      } else {
        tab.classList.remove("active");
      }
    });
  }

  updateCoinSummary() {
    const container = this.dom.elements.coinSummary;
    const data = this.state.latestTickerData[this.state.activeCoin];

    if (!data || !container) return;

    const priceChange = data.trade_price - data.prev_closing_price;
    const changePriceClass = priceChange >= 0 ? "positive" : "negative";
    const changeRateClass = priceChange >= 0 ? "positive" : "negative";

    container.innerHTML = `
      <div class="summary-left">
        <div class="summary-main">
          <span class="summary-name">${COIN_NAMES[this.state.activeCoin]}</span>
          <span class="summary-price ${changePriceClass}">${Utils.formatKRW(
      data.trade_price
    )} KRW</span>
        </div>
        <div class="summary-sub">
          <span class="${changePriceClass}">${Utils.formatKRW(
      priceChange
    )} KRW</span>
          <span class="${changeRateClass}">${Utils.formatPercent(
      data.change_rate
    )}%</span>
        </div>
      </div>
      <div class="summary-right">
        <div class="summary-item">
          <span class="summary-label">고가</span>
          <span class="summary-value">${Utils.formatKRW(data.high_price)}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">저가</span>
          <span class="summary-value">${Utils.formatKRW(data.low_price)}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">거래대금(24H)</span>
          <span class="summary-value">${Utils.formatKRW(
            data.acc_trade_price_24h
          )}</span>
        </div>
      </div>
    `;
  }

  updateOrderbook(orderbook, unifiedListElement) {
    if (!orderbook?.orderbook_units || !unifiedListElement)
      return;

    // 매수/매도 각각 20개씩 표시
    const asks = orderbook.orderbook_units.sort(
      (a, b) => a.ask_price - b.ask_price  // 매도호가: 낮은 가격부터 (현재가에서 가까운 순)
    ).slice(0, 20);

    const bids = orderbook.orderbook_units.sort(
      (a, b) => b.bid_price - a.bid_price  // 매수호가: 높은 가격부터 (현재가에서 가까운 순)
    ).slice(0, 20);

    // 체결강도 업데이트
    this.updateMarketPressure(asks, bids);

    // 호가창 타입 판단: ID로 확실하게 구분
    const isCumulativeElement = unifiedListElement.id === 'grouped-unified-list';

    if (isCumulativeElement) {
      // 누적 호가창 업데이트
      this.updateUnifiedCumulativeOrderbook(unifiedListElement, asks, bids);
    } else {
      // 일반 호가창 업데이트
      this.updateUnifiedGeneralOrderbook(unifiedListElement, asks, bids);
    }
  }

  updateUnifiedGeneralOrderbook(unifiedListElement, asks, bids) {
    // 일반 호가창에서도 개별 수량 비례 막대 표시를 위해 최대값 계산
    const allUnits = [...asks, ...bids];
    const maxSize = Math.max(...allUnits.map(unit => Math.max(unit.ask_size || 0, unit.bid_size || 0)));

    // 개별 수량 퍼센티지 추가
    const asksWithPercentage = asks.map(unit => ({
      ...unit,
      individual_percentage: (unit.ask_size / maxSize) * 100
    }));

    const bidsWithPercentage = bids.map(unit => ({
      ...unit,
      individual_percentage: (unit.bid_size / maxSize) * 100
    }));

    // 통합 리스트 업데이트: 매도(위) + 매수(아래)
    this.updateUnifiedOrderbookList(unifiedListElement, asksWithPercentage, bidsWithPercentage, 'general');
  }

  updateUnifiedCumulativeOrderbook(unifiedListElement, asks, bids) {
    // 누적 데이터 계산
    const cumulativeAsks = this.calculateCumulative(asks, 'ask');
    const cumulativeBids = this.calculateCumulative(bids, 'bid');

    // 통합 리스트 업데이트
    this.updateUnifiedOrderbookList(unifiedListElement, cumulativeAsks, cumulativeBids, 'cumulative');

    // 누적 차트 업데이트
    this.updateCumulativeChart(cumulativeAsks, cumulativeBids);
  }

  updateUnifiedOrderbookList(listElement, asks, bids, mode = 'general') {
    // 총 아이템 수: 매도 30개 + 매수 30개
    const totalItems = 60;

    // DOM 요소 캐시
    if (!listElement._unifiedItems) {
      listElement._unifiedItems = [];
      for (let i = 0; i < totalItems; i++) {
        const div = document.createElement("div");
        listElement.appendChild(div);
        listElement._unifiedItems.push(div);
      }
    }

    const items = listElement._unifiedItems;
    const currentPrice = this.getCurrentPrice();

    // 매도호가 표시 (역순: 높은 가격부터)
    const reversedAsks = [...asks].reverse();
    for (let i = 0; i < 30; i++) {
      const item = items[i];
      if (i < reversedAsks.length) {
        const unit = reversedAsks[i];
        const price = unit.ask_price || unit.price;
        item.className = 'orderbook-unit ask-item';

        // 현재가와 일치하면 특별 스타일 적용 (코인별 가격 단위 적용)
        const priceStep = Utils.getPriceStep(currentPrice, this.state.activeCoin);
        if (Math.abs(price - currentPrice) < priceStep) {
          item.classList.add('current-price-highlight');
        }

        if (mode === 'general') {
          item.classList.add('general-grid');
          item.classList.remove('cumulative-grid');
          this.updateGeneralItem(item, unit, 'ask', 0);
        } else {
          item.classList.add('cumulative-grid');
          item.classList.remove('general-grid');
          this.updateCumulativeItem(item, unit, 'ask', 0);
        }
        item.style.display = 'grid';
      } else {
        item.style.display = 'none';
      }
    }

    // 매수호가 표시 (정순: 높은 가격부터)
    for (let i = 0; i < 30; i++) {
      const item = items[30 + i];
      if (i < bids.length) {
        const unit = bids[i];
        const price = unit.bid_price || unit.price;
        item.className = 'orderbook-unit bid-item';

        // 현재가와 일치하면 특별 스타일 적용 (코인별 가격 단위 적용)
        const priceStep = Utils.getPriceStep(currentPrice, this.state.activeCoin);
        if (Math.abs(price - currentPrice) < priceStep) {
          item.classList.add('current-price-highlight');
        }

        if (mode === 'general') {
          item.classList.add('general-grid');
          item.classList.remove('cumulative-grid');
          this.updateGeneralItem(item, unit, 'bid', 0);
        } else {
          item.classList.add('cumulative-grid');
          item.classList.remove('general-grid');
          this.updateCumulativeItem(item, unit, 'bid', 0);
        }
        item.style.display = 'grid';
      } else {
        item.style.display = 'none';
      }
    }
  }

  // 현재가 가져오기
  getCurrentPrice() {
    const tickerData = this.state.latestTickerData[this.state.activeCoin];
    return tickerData ? tickerData.trade_price : 160000000; // 기본값
  }

  calculateCumulative(units, type) {
    const totalSize = units.reduce((sum, unit) => {
      const sizeKey = type === 'ask' ? 'ask_size' : 'bid_size';
      return sum + unit[sizeKey];
    }, 0);

    // 최대 개별 수량 찾기 (막대 스케일링용)
    const maxIndividualSize = Math.max(...units.map(unit => {
      const sizeKey = type === 'ask' ? 'ask_size' : 'bid_size';
      return unit[sizeKey];
    }));

    // 매수/매도별로 다른 누적 방식
    let cumulativeSize = 0;
    const result = [];

    if (type === 'ask') {
      // 매도호가: 현재가에서 멀어질수록 누적 증가 (위로 갈수록)
      for (let i = units.length - 1; i >= 0; i--) {
        const unit = units[i];
        const sizeKey = 'ask_size';
        cumulativeSize += unit[sizeKey];

        // 개별 수량 기준 막대 크기 (최대 수량 대비 비율)
        const individualPercentage = (unit[sizeKey] / maxIndividualSize) * 100;
        // 누적 수량 기준 막대 크기
        const cumulativePercentage = Math.min((cumulativeSize / totalSize) * 100, 100);

        result.unshift({
          ...unit,
          cumulative_size: cumulativeSize,
          percentage: cumulativePercentage,
          individual_percentage: individualPercentage
        });
      }
    } else {
      // 매수호가: 현재가에서 멀어질수록 누적 증가 (아래로 갈수록)
      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const sizeKey = 'bid_size';
        cumulativeSize += unit[sizeKey];

        // 개별 수량 기준 막대 크기 (최대 수량 대비 비율)
        const individualPercentage = (unit[sizeKey] / maxIndividualSize) * 100;
        // 누적 수량 기준 막대 크기
        const cumulativePercentage = Math.min((cumulativeSize / totalSize) * 100, 100);

        result.push({
          ...unit,
          cumulative_size: cumulativeSize,
          percentage: cumulativePercentage,
          individual_percentage: individualPercentage
        });
      }
    }

    return result;
  }

  updateSpreadInfo(asks, bids) {
    const spreadInfoGeneral = document.getElementById('spread-info');
    const spreadInfoGrouped = document.getElementById('spread-info-grouped');

    if (asks.length > 0 && bids.length > 0) {
      const bestAsk = asks[asks.length - 1].ask_price; // 가장 낮은 매도가
      const bestBid = bids[0].bid_price; // 가장 높은 매수가
      const spread = bestAsk - bestBid;
      const spreadPercentage = ((spread / bestBid) * 100).toFixed(3);

      // 현재가는 중간값으로 계산
      const currentPrice = (bestAsk + bestBid) / 2;
      const priceChange = this.state.latestTickerData[this.state.activeCoin]?.change_rate || 0;
      const changeClass = priceChange >= 0 ? 'positive' : 'negative';

      [spreadInfoGeneral, spreadInfoGrouped].forEach(element => {
        if (element) {
          const priceValue = element.querySelector('.price-value');
          const priceChangeElement = element.querySelector('.price-change');
          const spreadAmount = element.querySelector('span:last-child');

          if (priceValue) priceValue.textContent = Utils.formatKRW(currentPrice);
          if (priceChangeElement) {
            priceChangeElement.textContent = `${(priceChange * 100).toFixed(2)}%`;
            priceChangeElement.className = `price-change ${changeClass}`;
          }
          if (spreadAmount) spreadAmount.textContent = `${Utils.formatKRW(spread)} (${spreadPercentage}%)`;
        }
      });
    }
  }

  updateMarketPressure(asks, bids) {
    const askPressureBar = document.getElementById('ask-pressure-bar');
    const bidPressureBar = document.getElementById('bid-pressure-bar');
    const pressureRatio = document.getElementById('pressure-ratio');

    if (asks.length > 0 && bids.length > 0) {
      const totalAskSize = asks.reduce((sum, unit) => sum + unit.ask_size, 0);
      const totalBidSize = bids.reduce((sum, unit) => sum + unit.bid_size, 0);
      const totalSize = totalAskSize + totalBidSize;

      const askPercent = (totalAskSize / totalSize) * 100;
      const bidPercent = (totalBidSize / totalSize) * 100;

      if (askPressureBar) askPressureBar.style.width = `${askPercent}%`;
      if (bidPressureBar) bidPressureBar.style.width = `${bidPercent}%`;
      if (pressureRatio) {
        pressureRatio.innerHTML = `매도 ${totalAskSize.toFixed(3)} | 매수 ${totalBidSize.toFixed(3)}`;
      }
    }
  }

  updateOrderbookList(listElement, units, type, mode = 'general') {
    const maxItems = 30; // 더 많은 호가 표시

    // DOM 요소 캐시 - 한 번만 생성하고 재사용
    if (!listElement._orderbookItems) {
      listElement._orderbookItems = [];
      for (let i = 0; i < maxItems; i++) {
        const div = document.createElement("div");
        div.className = `orderbook-unit ${type}`;

        listElement.appendChild(div);
        listElement._orderbookItems.push(div);

        // 이벤트 리스너 등록
        div.addEventListener('click', () => {
          if (div._unitData && div._priceData) {
            this.handleOrderbookClick(div._unitData, div._priceData, type, div);
          }
        });
      }
    }

    const items = listElement._orderbookItems;

    // 각 아이템 업데이트
    for (let i = 0; i < maxItems; i++) {
      const div = items[i];

      if (i < units.length) {
        const unit = units[i];
        const priceKey = type === 'ask' ? 'ask_price' : 'bid_price';
        const sizeKey = type === 'ask' ? 'ask_size' : 'bid_size';
        const price = unit[priceKey];
        const size = unit[sizeKey];

        // 압력 바 너비 계산 (상대적 크기)
        const maxSize = Math.max(...units.map(u => u[sizeKey]));
        const pressureWidth = ((size / maxSize) * 100).toFixed(1);

        // 내용 업데이트
        if (mode === 'cumulative') {
          this.updateCumulativeItem(div, unit, type, pressureWidth);
        } else {
          this.updateGeneralItem(div, unit, type, pressureWidth);
        }

        // 클릭 핸들러를 위한 데이터 저장
        div._unitData = unit;
        div._priceData = price;

        // 압력 바 너비 설정
        const before = div.querySelector('::before') || div;
        if (before.style) {
          before.style.setProperty('--pressure-width', `${pressureWidth}%`);
        }

        // 표시
        div.style.display = 'grid';
      } else {
        // 숨기기
        div.style.display = 'none';
        div._unitData = null;
        div._priceData = null;
      }
    }
  }

  updateGeneralItem(div, unit, type, pressureWidth) {
    const priceKey = type === 'ask' ? 'ask_price' : 'bid_price';
    const sizeKey = type === 'ask' ? 'ask_size' : 'bid_size';

    // 업비트 스타일: 수량 | 호가 | 호가주문
    const price = unit[priceKey];
    const size = unit[sizeKey];
    const priceChange = this.calculatePriceChange(price);

    div.innerHTML = `
      <div class="orderbook-item size-item">${Utils.formatCoinAmount(size, 3)}</div>
      <div class="orderbook-item price-item">${Utils.formatKRW(price)}</div>
      <div class="orderbook-item order-item">${priceChange >= 0 ? '+' : ''}${(priceChange * 100).toFixed(2)}%</div>
    `;

    // 압력 바 너비 설정 (개별 수량 기준)
    const individualWidth = unit.individual_percentage || pressureWidth;
    div.style.setProperty('--pressure-width', individualWidth + '%');
  }

  updateCumulativeItem(div, unit, type, pressureWidth) {
    const priceKey = type === 'ask' ? 'ask_price' : 'bid_price';
    const sizeKey = type === 'ask' ? 'ask_size' : 'bid_size';

    // 업비트 누적호가 스타일: 호가 | 변동률 | 수량 | 금액 | 누적
    const price = unit[priceKey];
    const size = unit[sizeKey];
    const priceChange = this.calculatePriceChange(price);
    const amount = price * size; // 금액 = 호가 × 수량
    const cumulativeAmount = unit.cumulative_size ? unit.cumulative_size * price : 0;

    div.innerHTML = `
      <div class="orderbook-item price-item">${Utils.formatKRW(price)}</div>
      <div class="orderbook-item change-item">${priceChange >= 0 ? '+' : ''}${(priceChange * 100).toFixed(2)}%</div>
      <div class="orderbook-item size-item">${Utils.formatCoinAmount(size, 3)}</div>
      <div class="orderbook-item amount-item">${Utils.formatKRW(amount).replace('원', '').replace(',', '.')}</div>
      <div class="orderbook-item cumulative-item">${Utils.formatKRW(cumulativeAmount).replace('원', '').replace(',', '.')}</div>
    `;

    // 압력 바 너비 설정 (개별 수량 기준으로 비례 표현)
    const individualWidth = unit.individual_percentage || 0;
    div.style.setProperty('--cumulative-width', individualWidth + '%');
    div.style.setProperty('--pressure-width', individualWidth + '%');
  }

  calculatePriceChange(price) {
    // 전일 종가 대비 변동률 계산 (업비트 방식)
    const prevClosingPrice = this.state.latestTickerData[this.state.activeCoin]?.prev_closing_price || price;
    if (prevClosingPrice === price) return 0;
    return (price - prevClosingPrice) / prevClosingPrice;
  }

  updateCumulativeChart(cumulativeAsks, cumulativeBids) {
    const canvas = document.getElementById('cumulative-depth-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = width;
    canvas.height = height;

    ctx.clearRect(0, 0, width, height);

    // 간단한 누적 차트 그리기
    const totalItems = Math.max(cumulativeAsks.length, cumulativeBids.length);
    if (totalItems === 0) return;

    const stepWidth = width / totalItems;

    // 매도 (빨간색)
    ctx.fillStyle = 'rgba(244, 67, 54, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, height);
    cumulativeAsks.forEach((ask, index) => {
      const x = stepWidth * index;
      const y = height - (ask.percentage / 100) * height;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.fill();

    // 매수 (초록색)
    ctx.fillStyle = 'rgba(76, 175, 80, 0.3)';
    ctx.beginPath();
    ctx.moveTo(0, height);
    cumulativeBids.forEach((bid, index) => {
      const x = stepWidth * index;
      const y = height - (bid.percentage / 100) * height;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(width, height);
    ctx.fill();
  }

  handleOrderbookClick(unit, price, type, div) {
    if (this.state.activeTradingType !== "limit") return;

    let shouldSetPrice = false;

    if (type === 'ask' && this.state.activeTradingSide === "bid") {
      // 매수 시에는 매도호가 클릭
      shouldSetPrice = true;
    } else if (type === 'bid' && this.state.activeTradingSide === "ask") {
      // 매도 시에는 매수호가 클릭
      shouldSetPrice = true;
    }

    if (shouldSetPrice) {
      this.dom.setOrderPrice(price);
      this.updateOrderTotal();

      // 부드러운 시각적 피드백 - 스케일 없이 배경색만
      div.style.transition = 'background-color 0.1s ease';
      div.style.backgroundColor = "rgba(255, 255, 255, 0.2)";

      setTimeout(() => {
        div.style.backgroundColor = "";
        div.style.transition = "";
      }, 150);
    }
  }

  // 🔧 거래 타입/사이드 변경 시 현재가 설정 개선
  updateTradingPanel() {
    const coinCode = this.state.activeCoin;
    const coinName = coinCode.split("-")[1];

    if (this.state.activeTradingSide === "bid") {
      this.dom.updateAvailableAmount(this.state.userKRWBalance, "KRW");
    } else {
      const coinBalance =
        this.state.userCoinBalance[this.state.activeCoin] || 0;
      this.dom.updateAvailableAmount(coinBalance, coinName);
    }

    const buyButton = document.querySelector(".bid-button");
    const sellButton = document.querySelector(".ask-button");

    if (this.state.activeTradingSide === "bid") {
      buyButton?.classList.remove("hidden");
      sellButton?.classList.add("hidden");
    } else {
      buyButton?.classList.add("hidden");
      sellButton?.classList.remove("hidden");
    }

    this.updateTradingInputs();
    this.createPercentageDropdown();

    // 🔧 지정가로 전환될 때 현재가 자동 설정
    if (this.state.activeTradingType === "limit") {
      const currentPrice =
        this.state.latestTickerData[this.state.activeCoin]?.trade_price || 0;
      if (currentPrice > 0) {
        const adjustedPrice = Utils.adjustPriceToStep(
          currentPrice,
          this.state.activeCoin
        );
        this.dom.setOrderPrice(adjustedPrice);

        // 🔧 가격 설정 후 기존 수량이나 총액이 있으면 재계산
        const existingQuantity =
          Utils.parseNumber(this.dom.elements.orderQuantity?.value) || 0;
        const existingTotal =
          Utils.parseNumber(this.dom.elements.orderTotal?.value) || 0;

        if (existingQuantity > 0) {
          this.updateOrderTotal();
        } else if (existingTotal > 0) {
          this.updateQuantityFromTotal();
        }
      }
    }
  }

  // 🔧 개선된 거래 입력 필드 표시
  updateTradingInputs() {
    const priceGroup = document.querySelector(".price-input-group");
    const quantityGroup = document.querySelector(".quantity-input-group");
    const totalGroup = document.querySelector(".total-input-group");
    const marketTotalGroup = document.querySelector(".market-total-group");

    // 모든 그룹 숨기기
    [priceGroup, quantityGroup, totalGroup, marketTotalGroup].forEach(
      (element) => {
        if (element) element.classList.add("hidden");
      }
    );

    if (this.state.activeTradingType === "limit") {
      // 🔧 지정가: 가격, 수량, 총액 모두 표시 (모두 입력 가능)
      [priceGroup, quantityGroup, totalGroup].forEach((element) => {
        if (element) element.classList.remove("hidden");
      });

      if (this.dom.elements.orderPrice) {
        this.dom.elements.orderPrice.disabled = false;
      }
      if (this.dom.elements.orderQuantity) {
        this.dom.elements.orderQuantity.disabled = false;
      }
      if (this.dom.elements.orderTotal) {
        this.dom.elements.orderTotal.disabled = false; // 🔧 총액 입력 가능하게 변경
      }
    } else if (this.state.activeTradingType === "market") {
      if (this.state.activeTradingSide === "bid") {
        // 시장가 매수: 총액만 표시
        if (marketTotalGroup) marketTotalGroup.classList.remove("hidden");
      } else {
        // 시장가 매도: 수량만 표시
        if (quantityGroup) quantityGroup.classList.remove("hidden");
      }
    }
  }

  // 🔧 가격-수량-총액 상호 연동 업데이트
  updateOrderTotal() {
    if (this.state.activeTradingType !== "limit") return;

    const orderPrice =
      Utils.parseNumber(this.dom.elements.orderPrice?.value) || 0;
    const orderQuantity =
      Utils.parseNumber(this.dom.elements.orderQuantity?.value) || 0;

    if (orderPrice > 0 && orderQuantity > 0) {
      const total = orderPrice * orderQuantity;
      this.dom.elements.orderTotal.value = Utils.formatKRW(total);
    }
  }

  // 🔧 총액에서 수량 계산
  updateQuantityFromTotal() {
    if (this.state.activeTradingType !== "limit") return;

    const orderTotal =
      Utils.parseNumber(this.dom.elements.orderTotal?.value) || 0;
    const orderPrice =
      Utils.parseNumber(this.dom.elements.orderPrice?.value) || 0;

    if (orderPrice > 0 && orderTotal > 0) {
      const quantity = Utils.calculateQuantityFromTotal(orderTotal, orderPrice);
      this.dom.elements.orderQuantity.value = Utils.formatCoinAmount(quantity);
    }
  }

  // 🔧 가격에서 수량 계산 (총액이 고정된 경우)
  updateQuantityFromPrice() {
    if (this.state.activeTradingType !== "limit") return;

    const orderTotal =
      Utils.parseNumber(this.dom.elements.orderTotal?.value) || 0;
    const orderPrice =
      Utils.parseNumber(this.dom.elements.orderPrice?.value) || 0;

    if (orderPrice > 0 && orderTotal > 0) {
      const quantity = Utils.calculateQuantityFromTotal(orderTotal, orderPrice);
      this.dom.elements.orderQuantity.value = Utils.formatCoinAmount(quantity);
    }
  }

  updateMarketQuantity() {
    if (
      this.state.activeTradingType !== "market" ||
      this.state.activeTradingSide !== "bid"
    )
      return;

    const orderTotal =
      Utils.parseNumber(this.dom.elements.orderTotalMarket?.value) || 0;
    const currentPrice =
      this.state.latestTickerData[this.state.activeCoin]?.trade_price || 0;

    if (currentPrice > 0 && this.dom.elements.orderQuantity) {
      const quantity = orderTotal / currentPrice;
      this.dom.elements.orderQuantity.value = Utils.formatCoinAmount(quantity);
    }
  }

  // 🔧 개선된 퍼센트 드롭다운 (코인별 호가 단위 적용)
  createPercentageDropdown() {
    const dropdown = this.dom.elements.pricePercentageDropdown;
    if (!dropdown) return;

    dropdown.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "현재가 대비 설정";
    placeholder.disabled = true;
    placeholder.selected = true;
    placeholder.hidden = true;
    dropdown.appendChild(placeholder);

    [-20, -15, -10, -5, 0, 5, 10, 15, 20].forEach((percent) => {
      const option = document.createElement("option");
      option.value = percent;
      option.textContent = `${percent}%`;
      dropdown.appendChild(option);
    });

    dropdown.addEventListener("blur", () => {
      dropdown.value = "";
    });
  }

  switchCoin(code) {
    if (this.state.activeCoin === code) return;

    this.state.activeCoin = code;
    this.updateCoinTabs();
    this.updateCoinSummary();

    if (this.state.activeOrderbookType === "general") {
      this.updateOrderbook(
        this.state.latestOrderbookData[code].general,
        this.dom.elements.generalUnifiedList
      );
    } else {
      // 누적 호가도 일반 호가 데이터를 사용
      this.updateOrderbook(
        this.state.latestOrderbookData[code].general,
        this.dom.elements.groupedUnifiedList
      );
    }

    // 🔧 코인 전환 시 차트 및 기술지표 다시 렌더링
    if (this.chart) {
      this.chart.fetchAndRender().then(() => {
        // 차트 렌더링 완료 후 기술지표 복원
        this.restoreActiveIndicators();
      });
    }

    // 🔧 코인 전환 시 현재가로 가격 설정 (호가 단위 적용)
    if (this.state.activeTradingType === "limit") {
      const currentPrice = this.state.latestTickerData[code]?.trade_price || 0;
      if (currentPrice > 0) {
        const adjustedPrice = Utils.adjustPriceToStep(currentPrice, code);
        this.dom.setOrderPrice(adjustedPrice);
      }
    }

    this.updateTradingPanel();
  }

  // 🔧 활성 기술지표 복원 메서드
  async restoreActiveIndicators() {
    if (!this.chart) return;

    console.log("기술지표 복원 시작:", this.state.activeIndicators);

    // 이동평균선 복원
    for (const maPeriod of this.state.activeIndicators.movingAverages) {
      console.log(`MA${maPeriod} 복원 중...`);
      await this.chart.addMovingAverage(parseInt(maPeriod));

      // UI 체크박스 상태 동기화
      const checkbox = document.querySelector(`input[data-ma="${maPeriod}"]`);
      if (checkbox) checkbox.checked = true;
    }

    // 기술지표 복원
    for (const indicator of this.state.activeIndicators.technicalIndicators) {
      console.log(`${indicator} 지표 복원 중...`);
      await this.chart.addIndicator(indicator);

      // UI 체크박스 상태 동기화
      const checkbox = document.querySelector(`input[data-indicator="${indicator}"]`);
      if (checkbox) checkbox.checked = true;

      // 지표 차트 UI 상태 동기화
      if (indicator === "RSI") {
        const rsiChart = document.getElementById("rsiChart");
        if (rsiChart) rsiChart.classList.remove("hidden");
      } else if (indicator === "MACD") {
        const macdChart = document.getElementById("macdChart");
        if (macdChart) macdChart.classList.remove("hidden");
      }
    }

    console.log("기술지표 복원 완료");
  }

  async fetchUserData() {
    try {
      const response = await fetch("/api/balance");
      if (!response.ok) {
        throw new Error("잔고 정보를 가져오는 데 실패했습니다.");
      }
      const data = await response.json();
      this.state.userKRWBalance = Math.floor(data.krw_balance || 0);
      this.state.userCoinBalance = {
        "KRW-BTC": data.btc_balance || 0,
        "KRW-ETH": data.eth_balance || 0,
        "KRW-XRP": data.xrp_balance || 0,
      };
      this.dom.updateAvailableAmount(this.state.userKRWBalance);
    } catch (error) {
      console.error("사용자 데이터 불러오기 오류:", error);
    }
  }

}
