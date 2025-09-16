// crypto-trading-app.js - 암호화폐 거래 애플리케이션 (메인 애플리케이션)
/**
 * 역할: 전체 암호화폐 거래 시스템의 메인 컨트롤러
 * 주요 기능:
 * - 모든 매니저 인스턴스 생성 및 초기화 (constructor)
 * - 매니저 간 참조 설정 및 의존성 주입 (constructor)
 * - 시스템 전체 초기화 및 시작 (initialize)
 * - 주기적 업데이트 관리 (startPeriodicUpdates)
 * - 전역 에러 처리 및 로깅 (handleError)
 * - 시스템 정리 및 종료 (cleanup)
 */
import { TradingState } from "./trading-state.js";
import { DOMManager } from "./dom-manager.js";
import { UIController } from "./ui-controller.js";
import { ChartManager } from "./chart-manager.js";
import { TradingManager } from "./trading-manager.js";
import { EventManager } from "./event-manager.js";
import { WebSocketManager } from "./websocket-manager.js";

export class CryptoTradingApp {
  // 메인 애플리케이션 클래스 - 모든 매니저들을 통합 관리
  constructor() {
    this.state = new TradingState();
    this.domManager = new DOMManager();

    // 매니저 인스턴스 생성
    this.chartManager = new ChartManager(this.state);
    this.tradingManager = new TradingManager(this.state, this.domManager);
    this.uiController = new UIController(this.state, this.domManager);

    // 매니저 간 참조 설정
    this.uiController.setManagers(this.chartManager, this.tradingManager);
    this.tradingManager.setUIController(this.uiController);

    this.eventManager = new EventManager(
      this.state,
      this.domManager,
      this.uiController,
      this.tradingManager,
      this.chartManager
    );

    this.webSocketManager = new WebSocketManager(
      this.state,
      this.uiController,
      this.tradingManager
    );

    console.log("매니저 간 참조 설정 완료");
  }

  async initialize() {
    try {
      this.uiController.updateCoinTabs();
      this.uiController.updateCoinSummary();
      this.uiController.updateTradingPanel();

      await this.chartManager.fetchAndRender();

      this.uiController.updateOrderbook(
        this.state.latestOrderbookData[this.state.activeCoin].general,
        this.domManager.elements.generalUnifiedList
      );

      await this.tradingManager.fetchUserBalance();

      const pendingOrders = await this.tradingManager.fetchPendingOrders();
      this.uiController.updatePendingOrdersList(pendingOrders);

      const filledOrders = await this.tradingManager.fetchFilledOrders();
      this.uiController.updateFilledOrdersList(filledOrders);

      this.eventManager.setupAllEventListeners();
      this.webSocketManager.connect();
      this.startPeriodicUpdates();

      // WebSocket 연결 후 초기 가격 설정을 위해 잠시 대기
      setTimeout(() => {
        const currentPrice =
          this.state.latestTickerData[this.state.activeCoin]?.trade_price || 0;
        if (currentPrice > 0) {
          this.domManager.setOrderPrice(currentPrice);
        }
      }, 1000);

      console.log("✅ 암호화폐 거래 시스템 초기화 완료");
    } catch (error) {
      console.error("초기화 중 오류 발생:", error);
      alert("시스템 초기화 중 오류가 발생했습니다. 페이지를 새로고침해주세요.");
    }
  }

  startPeriodicUpdates() {
    setInterval(() => {
      this.chartManager.checkAutoUpdate();
    }, 10000);

    setInterval(async () => {
      await this.tradingManager.fetchUserBalance();

      const pendingOrders = await this.tradingManager.fetchPendingOrders();
      this.uiController.updatePendingOrdersList(pendingOrders);
    }, 10000);
  }

  handleError(error, context = "알 수 없는 오류") {
    console.error(`${context}:`, error);

    const errorMessages = {
      network: "네트워크 연결을 확인해주세요.",
      websocket: "실시간 데이터 연결에 문제가 있습니다.",
      api: "서버와의 통신에 문제가 있습니다.",
      chart: "차트 로딩 중 문제가 발생했습니다.",
      trading: "거래 처리 중 문제가 발생했습니다.",
    };

    const message =
      errorMessages.api ||
      "일시적인 문제가 발생했습니다. 잠시 후 다시 시도해주세요.";

    if (!error.message?.includes("WebSocket")) {
      console.warn("사용자 알림:", message);
    }
  }

  cleanup() {
    if (this.webSocketManager.ws) {
      this.webSocketManager.ws.close();
    }

    if (this.state.mainChart) {
      this.state.mainChart.destroy();
    }
  }
}
