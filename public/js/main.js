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
      resolve();
      return;
    }

    // 최대 5초 대기
    let attempts = 0;
    const maxAttempts = 50; // 100ms * 50 = 5초

    const checkLibrary = () => {
      if (window.LightweightCharts) {
        resolve();
      } else if (attempts >= maxAttempts) {
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
    // TradingView 라이브러리 로딩 대기
    await waitForLightweightCharts();

    app = new CryptoTradingApp();
    await app.initialize();
    AIAssistant.init();
  } catch (error) {
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

