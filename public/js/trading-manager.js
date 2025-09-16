// TradingManager.js - 거래 처리 매니저
/**
 * 역할: 모의투자 거래 주문 처리 및 검증 담당
 * 주요 기능:
 * - 매수/매도 주문 전송 및 처리 (sendOrder)
 * - 주문 입력값 검증 (가격, 수량, 잔고) (validateLimitOrder, validateMarketBuyOrder, validateMarketSellOrder)
 * - 사용자 잔고 조회 및 업데이트 (fetchUserBalance)
 * - 대기/체결 주문 내역 조회 (fetchPendingOrders, fetchFilledOrders)
 * - 주문 취소 처리 (cancelOrder)
 * - 가격/수량 자동 계산 (adjustPrice, calculatePercentageAmount)
 * - 데이터 전체 새로고침 (refreshAllData)
 */

import { Utils } from "./utils.js";
import { MIN_ORDER_AMOUNTS } from "./constants.js";

export class TradingManager {
  // 거래 주문 처리 및 검증 담당 클래스
  constructor(state, domManager) {
    this.state = state;
    this.dom = domManager;
    this.uiController = null;
  }

  // UIController 참조 설정
  setUIController(uiController) {
    this.uiController = uiController;
  }

  async cancelOrder(orderId) {
    if (!orderId) {
      this.dom.showOrderResult("주문 ID가 없습니다.", false);
      return;
    }

    if (!confirm("정말로 이 주문을 취소하시겠습니까?")) {
      return;
    }

    try {
      const response = await fetch(`/api/pending-orders/${orderId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (response.ok) {
        this.dom.showOrderResult(result.message, true);
        // 🔧 취소 후 자동 새로고침
        await this.refreshAllData();
      } else {
        this.dom.showOrderResult(
          result.error || "주문 취소에 실패했습니다.",
          false
        );
      }
    } catch (error) {
      console.error("주문 취소 오류:", error);
      this.dom.showOrderResult("주문 취소 중 오류가 발생했습니다.", false);
    }
  }

  async sendOrder(side) {
    // 🔧 주문 시작 시 로딩 상태 표시
    const tradeButton = document.querySelector(
      side === "bid" ? ".bid-button" : ".ask-button"
    );
    const originalText = tradeButton?.textContent;
    if (tradeButton) {
      tradeButton.disabled = true;
      tradeButton.innerHTML = `${originalText} <div class="loading-spinner"></div>`;
    }

    const orderData = {
      market: this.state.activeCoin,
      side: side,
      type: this.state.activeTradingType,
    };

    if (this.state.activeTradingType === "limit") {
      const price = Utils.parseNumber(this.dom.elements.orderPrice?.value);
      const quantity = Utils.parseNumber(
        this.dom.elements.orderQuantity?.value
      );

      if (!this.validateLimitOrder(price, quantity)) {
        // 🔧 검증 실패 시 버튼 복구
        if (tradeButton) {
          tradeButton.disabled = false;
          tradeButton.textContent = originalText;
        }
        return { success: false };
      }
      orderData.price = price;
      orderData.quantity = quantity;
    } else if (this.state.activeTradingType === "market") {
      if (side === "bid") {
        const totalAmount = Utils.parseNumber(
          this.dom.elements.orderTotalMarket?.value
        );
        if (!this.validateMarketBuyOrder(totalAmount)) {
          if (tradeButton) {
            tradeButton.disabled = false;
            tradeButton.textContent = originalText;
          }
          return { success: false };
        }
        orderData.price = totalAmount;
        orderData.quantity = 0;
      } else {
        const quantity = Utils.parseNumber(
          this.dom.elements.orderQuantity?.value
        );
        if (!this.validateMarketSellOrder(quantity)) {
          if (tradeButton) {
            tradeButton.disabled = false;
            tradeButton.textContent = originalText;
          }
          return { success: false };
        }
        orderData.quantity = quantity;
        orderData.price = 0;
      }
    }

    try {
      const response = await fetch("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: 'include',
        body: JSON.stringify(orderData),
      });

      const result = await response.json();

      if (response.ok) {
        this.dom.showOrderResult(result.message, true);

        if (result.orderDetails?.status === "pending") {
          this.dom.showOrderResult(
            `지정가 주문이 대기열에 추가되었습니다. (주문ID: ${result.orderDetails.orderId})`,
            true
          );
        }

        // 🔧 주문 성공 후 모든 데이터 새로고침
        await this.refreshAllData();

        this.clearOrderInputs();

        return { success: true };
      } else {
        this.dom.showOrderResult(
          result.error || "주문 처리 중 오류가 발생했습니다.",
          false
        );
      }
    } catch (error) {
      console.error("주문 요청 오류:", error);
      this.dom.showOrderResult("주문 요청 중 오류가 발생했습니다.", false);
    } finally {
      // 🔧 버튼 복구
      if (tradeButton) {
        tradeButton.disabled = false;
        tradeButton.textContent = originalText;
      }
    }

    return { success: false };
  }

  // 🔧 모든 데이터 새로고침 함수
  async refreshAllData() {
    try {
      // 병렬로 실행하여 속도 향상
      const [pendingOrders, filledOrders] = await Promise.all([
        this.fetchPendingOrders(),
        this.fetchFilledOrders(),
        this.fetchUserBalance(),
      ]);

      // UI 업데이트
      if (this.uiController) {
        this.uiController.updatePendingOrdersList(pendingOrders);
        this.uiController.updateFilledOrdersList(filledOrders);
        this.uiController.updateTradingPanel();
      }

      return { pendingOrders, filledOrders };
    } catch (error) {
      console.error("데이터 새로고침 오류:", error);
      throw error;
    }
  }

  clearOrderInputs() {
    if (this.state.activeTradingType === "limit") {
      if (this.dom.elements.orderQuantity) {
        this.dom.elements.orderQuantity.value = "";
      }
      if (this.dom.elements.orderTotal) {
        this.dom.elements.orderTotal.value = "";
      }
    } else if (this.state.activeTradingType === "market") {
      if (this.state.activeTradingSide === "bid") {
        if (this.dom.elements.orderTotalMarket) {
          this.dom.elements.orderTotalMarket.value = "";
        }
      } else {
        if (this.dom.elements.orderQuantity) {
          this.dom.elements.orderQuantity.value = "";
        }
      }
    }
  }

  // 지정가 주문 검증 (코인별 최소 금액 적용)
  validateLimitOrder(price, quantity) {
    if (!price || !quantity || price <= 0 || quantity <= 0) {
      this.dom.showOrderResult(
        "주문 가격과 수량을 올바르게 입력해주세요.",
        false
      );
      return false;
    }

    // 코인별 최소 주문 금액 체크
    const minOrderAmount = MIN_ORDER_AMOUNTS[this.state.activeCoin] || 5000;
    const totalAmount = price * quantity;
    if (totalAmount < minOrderAmount) {
      this.dom.showOrderResult(
        `${
          this.state.activeCoin.split("-")[1]
        } 최소 주문 금액은 ${minOrderAmount.toLocaleString()}원입니다.`,
        false
      );
      return false;
    }

    // 코인별 가격 단위 체크
    const priceStep = Utils.getPriceStep(price, this.state.activeCoin);
    if (price % priceStep !== 0) {
      const adjustedPrice = Utils.adjustPriceToStep(
        price,
        this.state.activeCoin
      );
      this.dom.showOrderResult(
        `${
          this.state.activeCoin.split("-")[1]
        } 가격은 ${priceStep.toLocaleString()}원 단위로 입력해주세요. (권장: ${Utils.formatKRW(
          adjustedPrice
        )}원)`,
        false
      );
      return false;
    }

    // 잔고 확인
    if (this.state.activeTradingSide === "bid") {
      if (this.state.userKRWBalance < totalAmount) {
        this.dom.showOrderResult(
          `잔액이 부족합니다. (필요: ${Utils.formatKRW(
            totalAmount
          )}원, 보유: ${Utils.formatKRW(this.state.userKRWBalance)}원)`,
          false
        );
        return false;
      }
    } else {
      const availableCoin =
        this.state.userCoinBalance[this.state.activeCoin] || 0;
      if (availableCoin < quantity) {
        this.dom.showOrderResult(
          `보유 코인이 부족합니다. (필요: ${Utils.formatCoinAmount(
            quantity
          )}개, 보유: ${Utils.formatCoinAmount(availableCoin)}개)`,
          false
        );
        return false;
      }
    }

    return true;
  }

  validateMarketBuyOrder(totalAmount) {
    if (!totalAmount || totalAmount <= 0) {
      this.dom.showOrderResult("주문 총액을 올바르게 입력해주세요.", false);
      return false;
    }

    const minOrderAmount = MIN_ORDER_AMOUNTS[this.state.activeCoin] || 5000;
    if (totalAmount < minOrderAmount) {
      this.dom.showOrderResult(
        `최소 주문 금액은 ${minOrderAmount.toLocaleString()}원입니다.`,
        false
      );
      return false;
    }

    if (this.state.userKRWBalance < totalAmount) {
      this.dom.showOrderResult(
        `잔액이 부족합니다. (필요: ${Utils.formatKRW(
          totalAmount
        )}원, 보유: ${Utils.formatKRW(this.state.userKRWBalance)}원)`,
        false
      );
      return false;
    }

    return true;
  }

  validateMarketSellOrder(quantity) {
    if (!quantity || quantity <= 0) {
      this.dom.showOrderResult("주문 수량을 올바르게 입력해주세요.", false);
      return false;
    }

    const currentPrice =
      this.state.latestTickerData[this.state.activeCoin]?.trade_price || 0;
    const totalAmount = quantity * currentPrice;
    const minOrderAmount = MIN_ORDER_AMOUNTS[this.state.activeCoin] || 5000;

    if (totalAmount < minOrderAmount) {
      this.dom.showOrderResult(
        `최소 주문 금액은 ${minOrderAmount.toLocaleString()}원입니다.`,
        false
      );
      return false;
    }

    const availableCoin =
      this.state.userCoinBalance[this.state.activeCoin] || 0;
    if (availableCoin < quantity) {
      this.dom.showOrderResult(
        `보유 코인이 부족합니다. (필요: ${Utils.formatCoinAmount(
          quantity
        )}개, 보유: ${Utils.formatCoinAmount(availableCoin)}개)`,
        false
      );
      return false;
    }

    return true;
  }

  async fetchUserBalance() {
    try {
      const response = await fetch("/api/balance", {
        credentials: 'include'
      });
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

      return data;
    } catch (error) {
      console.error("잔고 데이터 로딩 오류:", error);
      throw error;
    }
  }

  async fetchFilledOrders() {
    try {
      const response = await fetch("/api/transactions", {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error("거래 내역을 가져오는 데 실패했습니다.");
      }

      const data = await response.json();
      this.state.filledOrders = data || [];

      return this.state.filledOrders;
    } catch (error) {
      console.error("체결 내역 조회 오류:", error);
      this.state.filledOrders = [];
      return [];
    }
  }

  async fetchPendingOrders() {
    try {
      const response = await fetch("/api/pending-orders", {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error("대기 주문을 가져오는 데 실패했습니다.");
      }

      const data = await response.json();
      this.state.pendingOrders = data || [];

      return this.state.pendingOrders;
    } catch (error) {
      console.error("대기 주문 조회 오류:", error);
      this.state.pendingOrders = [];
      return [];
    }
  }

  // 퍼센트 계산 (1000원 단위)
  calculatePercentageAmount(percent) {
    const percentage = percent / 100;

    if (this.state.activeTradingType === "limit") {
      if (this.state.activeTradingSide === "bid") {
        // 매수: 잔고 기준으로 총액 계산
        let totalAmount = Math.floor(this.state.userKRWBalance * percentage);

        // 1000원 단위로 조정
        if (
          this.state.activeCoin === "KRW-BTC" ||
          this.state.activeCoin === "KRW-ETH"
        ) {
          totalAmount = Math.floor(totalAmount / 1000) * 1000;
        }

        this.dom.setOrderTotal(totalAmount);

        // 가격이 입력되어 있으면 수량 자동 계산
        const orderPrice = Utils.parseNumber(
          this.dom.elements.orderPrice?.value
        );
        if (orderPrice > 0) {
          const quantity = totalAmount / orderPrice;
          this.dom.setOrderQuantity(quantity);
        }
      } else {
        // 매도: 보유 코인 기준으로 수량 계산
        const quantity =
          this.state.userCoinBalance[this.state.activeCoin] * percentage;
        this.dom.setOrderQuantity(quantity);

        // 가격이 입력되어 있으면 총액 자동 계산
        const orderPrice = Utils.parseNumber(
          this.dom.elements.orderPrice?.value
        );
        if (orderPrice > 0) {
          let total = quantity * orderPrice;

          // 총액도 1000원 단위로 조정
          if (
            this.state.activeCoin === "KRW-BTC" ||
            this.state.activeCoin === "KRW-ETH"
          ) {
            total = Math.floor(total / 1000) * 1000;
            // 총액이 조정되었으므로 수량도 다시 계산
            const adjustedQuantity = total / orderPrice;
            this.dom.setOrderQuantity(adjustedQuantity);
          }

          this.dom.setOrderTotal(total);
        }
      }
    } else if (this.state.activeTradingType === "market") {
      if (this.state.activeTradingSide === "bid") {
        let totalAmount = Math.floor(this.state.userKRWBalance * percentage);

        // 시장가 매수도 1000원 단위로 조정
        if (
          this.state.activeCoin === "KRW-BTC" ||
          this.state.activeCoin === "KRW-ETH"
        ) {
          totalAmount = Math.floor(totalAmount / 1000) * 1000;
        }

        this.dom.setOrderTotalMarket(totalAmount);
      } else {
        const quantity =
          this.state.userCoinBalance[this.state.activeCoin] * percentage;
        this.dom.setOrderQuantity(quantity);
      }
    }
  }

  // 가격 조정 (코인별 호가 단위 적용)
  adjustPrice(direction) {
    const currentPrice =
      Utils.parseNumber(this.dom.elements.orderPrice?.value) || 0;
    const step = Utils.getPriceStep(currentPrice, this.state.activeCoin);
    const newPrice =
      direction === "up"
        ? currentPrice + step
        : Math.max(step, currentPrice - step); // 최소값을 step으로 설정

    this.dom.setOrderPrice(newPrice);

    // 가격 변경 시 총액도 업데이트
    if (this.state.activeTradingType === "limit") {
      const quantity =
        Utils.parseNumber(this.dom.elements.orderQuantity?.value) || 0;
      const total = Utils.parseNumber(this.dom.elements.orderTotal?.value) || 0;

      if (quantity > 0) {
        // 수량 기준으로 총액 재계산
        let newTotal = newPrice * quantity;

        // 총액을 1000원 단위로 조정
        if (
          this.state.activeCoin === "KRW-BTC" ||
          this.state.activeCoin === "KRW-ETH"
        ) {
          newTotal = Math.floor(newTotal / 1000) * 1000;
        }

        this.dom.setOrderTotal(newTotal);
      } else if (total > 0) {
        // 총액 기준으로 수량 재계산
        const newQuantity = Utils.calculateQuantityFromTotal(
          total,
          newPrice,
          this.state.activeCoin
        );
        this.dom.setOrderQuantity(newQuantity);
      }
    }
  }

  // 주문총액 변경 시 수량 자동 계산
  updateQuantityFromTotal() {
    if (this.state.activeTradingType !== "limit") return;

    const orderTotal =
      Utils.parseNumber(this.dom.elements.orderTotal?.value) || 0;
    const orderPrice =
      Utils.parseNumber(this.dom.elements.orderPrice?.value) || 0;

    if (orderPrice > 0) {
      const quantity = Utils.calculateQuantityFromTotal(
        orderTotal,
        orderPrice,
        this.state.activeCoin
      );
      this.dom.setOrderQuantity(quantity);
    }
  }
}
