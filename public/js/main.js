// main.js - TradingView Lightweight Charts 버전

import { CryptoTradingApp } from "./crypto-trading-app.js";
import { Utils } from "./utils.js";
import { MARKET_CODES, COIN_NAMES } from "./constants.js";

// AIAssistant.js 같은 일반 스크립트에서 사용할 수 있도록 전역 변수에 할당
window.APP_CONSTANTS = { MARKET_CODES, COIN_NAMES };

let app = null;

// TradingView 라이브러리 로딩 대기
function waitForLightweightCharts() {
  return new Promise((resolve, reject) => {
    // 이미 로드되어 있으면 즉시 resolve
    if (window.LightweightCharts) {
      console.log("✅ TradingView Lightweight Charts 라이브러리 이미 로드됨");
      resolve();
      return;
    }

    // 최대 5초 대기
    let attempts = 0;
    const maxAttempts = 50; // 100ms * 50 = 5초

    const checkLibrary = () => {
      if (window.LightweightCharts) {
        console.log("✅ TradingView Lightweight Charts 라이브러리 로드 완료");
        resolve();
      } else if (attempts >= maxAttempts) {
        console.error(
          "❌ TradingView Lightweight Charts 라이브러리 로딩 시간 초과"
        );
        reject(
          new Error("TradingView Lightweight Charts 라이브러리 로딩 실패")
        );
      } else {
        attempts++;
        setTimeout(checkLibrary, 100);
      }
    };

    checkLibrary();
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    console.log("🔄 TradingView Lightweight Charts 라이브러리 로딩 대기 중...");

    // TradingView 라이브러리 로딩 대기
    await waitForLightweightCharts();

    console.log("🚀 암호화폐 거래 앱 초기화 시작");
    app = new CryptoTradingApp();
    await app.initialize();
    AIAssistant.init();
  } catch (error) {
    console.error("앱 초기화 실패:", error);
    alert(
      `시스템을 불러오는 중 문제가 발생했습니다:\n${error.message}\n\n페이지를 새로고침해주세요.`
    );
  }
});

window.addEventListener("beforeunload", () => {
  if (app) {
    app.cleanup();
  }
});

// 개발용 전역 접근
if (typeof window !== "undefined") {
  window.TradingApp = {
    app: () => app,
    utils: Utils,
    getState: () => app?.state,
    switchCoin: (code) => app?.uiController.switchCoin(code),
    refreshChart: () => app?.chartManager.fetchAndRender(),
    refreshBalance: () => app?.tradingManager.fetchUserBalance(),
    refreshPendingOrders: () => app?.tradingManager.fetchPendingOrders(),
    cancelOrder: (orderId) => app?.tradingManager.cancelOrder(orderId),
    // TradingView 디버깅용
    getChart: () => app?.chartManager.chart,
    isLightweightChartsLoaded: () => !!window.LightweightCharts,
    // 🔍 새로운 디버깅 메서드들
    logViewports: () => app?.chartManager.logAllViewportStates(),
    forceSyncCharts: () => app?.chartManager.forceSyncAllViewports(),
    debugMode: (enabled) => {
      if (app?.chartManager) {
        app.chartManager._debugMode = enabled;
        console.log(`디버그 모드: ${enabled ? '활성화' : '비활성화'}`);
      }
    },
  };
}
