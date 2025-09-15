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

  updateOrderbook(orderbook, askListElement, bidListElement) {
    if (!orderbook?.orderbook_units || !askListElement || !bidListElement)
      return;

    askListElement.innerHTML = "";
    bidListElement.innerHTML = "";

    const asks = orderbook.orderbook_units.sort(
      (a, b) => b.ask_price - a.ask_price
    );
    const bids = orderbook.orderbook_units.sort(
      (a, b) => b.bid_price - a.bid_price
    );

    asks.slice(0, 10).forEach((unit) => {
      const div = document.createElement("div");
      div.className = "orderbook-unit ask";
      div.innerHTML = `
        <span class="orderbook-price ask">${Utils.formatKRW(
          unit.ask_price
        )}</span>
        <span class="orderbook-size">${Utils.formatCoinAmount(
          unit.ask_size,
          4
        )}</span>
      `;

      div.onclick = () => {
        if (this.state.activeTradingType === "limit") {
          // 매수 시에는 매도호가 클릭 시 해당 가격으로 설정
          if (this.state.activeTradingSide === "bid") {
            this.dom.setOrderPrice(unit.ask_price);
            this.updateOrderTotal();

            // 시각적 피드백
            div.style.backgroundColor = "#444";
            div.style.transform = "scale(1.02)";
            setTimeout(() => {
              div.style.backgroundColor = "";
              div.style.transform = "";
            }, 200);
          }
        }
      };
      askListElement.appendChild(div);
    });

    bids.slice(0, 10).forEach((unit) => {
      const div = document.createElement("div");
      div.className = "orderbook-unit bid";
      div.innerHTML = `
        <span class="orderbook-price bid">${Utils.formatKRW(
          unit.bid_price
        )}</span>
        <span class="orderbook-size">${Utils.formatCoinAmount(
          unit.bid_size,
          4
        )}</span>
      `;

      div.onclick = () => {
        if (this.state.activeTradingType === "limit") {
          // 매도 시에는 매수호가 클릭 시 해당 가격으로 설정
          if (this.state.activeTradingSide === "ask") {
            this.dom.setOrderPrice(unit.bid_price);
            this.updateOrderTotal();

            // 시각적 피드백
            div.style.backgroundColor = "#444";
            div.style.transform = "scale(1.02)";
            setTimeout(() => {
              div.style.backgroundColor = "";
              div.style.transform = "";
            }, 200);
          }
        }
      };
      bidListElement.appendChild(div);
    });
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
        this.dom.elements.generalAskList,
        this.dom.elements.generalBidList
      );
    } else {
      this.updateOrderbook(
        this.state.latestOrderbookData[code].grouped,
        this.dom.elements.groupedAskList,
        this.dom.elements.groupedBidList
      );
    }

    // 🔧 코인 전환 시 차트 다시 렌더링 (추가된 코드)
    if (this.chart) {
      this.chart.fetchAndRender();
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
