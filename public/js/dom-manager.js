// DOMManager.js - 주문총액 입력 지원 버전

import { Utils } from "./utils.js";

export class DOMManager {
  constructor() {
    this.elements = this.getElements();
  }

  getElements() {
    return {
      pendingOrdersTab: document.getElementById("pending-orders-tab"),
      filledOrdersTab: document.getElementById("filled-orders-tab"),
      pendingOrdersSection: document.getElementById("pending-orders-section"),
      filledOrdersSection: document.getElementById("filled-orders-section"),
      refreshAllOrders: document.getElementById("refresh-all-orders"), // 🔄 전체 새로고침만 유지

      availableAmount: document.getElementById("available-amount"),
      orderPrice: document.getElementById("order-price"),
      orderQuantity: document.getElementById("order-quantity"),
      orderTotal: document.getElementById("order-total"), // 🔧 이제 입력 가능
      orderTotalMarket: document.getElementById("order-total-market"),
      pricePercentageDropdown: document.getElementById(
        "price-percentage-dropdown"
      ),

      // 이벤트 리스너용 추가
      orderPriceInput: document.getElementById("order-price"),
      orderQuantityInput: document.getElementById("order-quantity"),
      orderTotalInput: document.getElementById("order-total"), // 🔧 추가
      orderTotalMarketInput: document.getElementById("order-total-market"),

      coinTabs: document.getElementById("coin-tabs"),
      coinSummary: document.getElementById("coin-summary"),
      chartCanvas: document.getElementById("coinChart"),

      generalAskList: document.getElementById("general-ask-list"),
      generalBidList: document.getElementById("general-bid-list"),
      groupedAskList: document.getElementById("grouped-ask-list"),
      groupedBidList: document.getElementById("grouped-bid-list"),

      pendingOrdersList: document.getElementById("pending-orders-list"),
      filledOrdersList: document.getElementById("filled-orders-list"),

      tradingTabs: document.querySelector(".trading-tabs"),
      tradingTypeBtns: document.querySelectorAll(".trading-type-btn"),
      tradeButtons: document.querySelectorAll(".trade-button"),
      timeTabs: document.getElementById("time-tabs"),
      toggleGeneral: document.getElementById("toggle-general"),
      toggleGrouped: document.getElementById("toggle-grouped"),
      generalOrderbookContainer: document.getElementById(
        "general-orderbook-container"
      ),
      groupedOrderbookContainer: document.getElementById(
        "grouped-orderbook-container"
      ),
      priceBtns: document.querySelectorAll(".price-btn"),
      quantityBtns: document.querySelectorAll(".quantity-btns button"),
      // totalBtns 제거 - 더 이상 사용하지 않음
    };
  }

  updateAvailableAmount(amount, unit = "KRW") {
    if (this.elements.availableAmount) {
      if (unit === "KRW") {
        this.elements.availableAmount.textContent = `${Utils.formatKRW(
          amount
        )} KRW`;
      } else {
        this.elements.availableAmount.textContent = `${Utils.formatCoinAmount(
          amount
        )} ${unit}`;
      }
    }
  }

  setOrderPrice(price) {
    if (this.elements.orderPrice) {
      this.elements.orderPrice.value = Utils.formatKRW(price);
    }
  }

  setOrderQuantity(quantity) {
    if (this.elements.orderQuantity) {
      this.elements.orderQuantity.value = Utils.formatCoinAmount(quantity);
    }
  }

  // 🔧 주문총액 설정 함수 추가
  setOrderTotal(total) {
    if (this.elements.orderTotal) {
      this.elements.orderTotal.value = Utils.formatKRW(total);
    }
  }

  setOrderTotalMarket(total) {
    if (this.elements.orderTotalMarket) {
      this.elements.orderTotalMarket.value = Utils.formatKRW(total);
    }
  }

  // 🔧 개선된 주문 결과 표시 (체결 타입별 다른 스타일)
  showOrderResult(message, isSuccess = true, orderType = null) {
    const toast = document.createElement("div");

    let backgroundColor, borderColor;
    if (isSuccess) {
      if (orderType === "fill") {
        backgroundColor = "linear-gradient(135deg, #00C851, #00ff88)";
        borderColor = "#00C851";
      } else {
        backgroundColor = "#00C851";
        borderColor = "#00C851";
      }
    } else {
      backgroundColor = "#C84A31";
      borderColor = "#C84A31";
    }

    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${backgroundColor};
      color: white;
      padding: 12px 16px;
      border-radius: 6px;
      border-left: 4px solid ${borderColor};
      font-size: 13px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      opacity: 0;
      transition: opacity 0.3s ease;
      max-width: 300px;
      word-wrap: break-word;
    `;

    // 메시지에 줄바꿈이 있으면 처리
    const lines = message.split("\n");
    if (lines.length > 1) {
      toast.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");
    } else {
      toast.textContent = message;
    }

    document.body.appendChild(toast);

    setTimeout(() => (toast.style.opacity = "1"), 10);

    setTimeout(
      () => {
        toast.style.opacity = "0";
        setTimeout(() => {
          if (document.body.contains(toast)) {
            document.body.removeChild(toast);
          }
        }, 300);
      },
      isSuccess ? 3000 : 4000
    ); // 에러는 4초간 표시
  }
}
