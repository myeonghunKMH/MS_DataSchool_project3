// constants.js - 코인별 호가 단위 적용
export const MARKET_CODES = ["KRW-BTC", "KRW-ETH", "KRW-XRP"];

export const COIN_NAMES = {
  "KRW-BTC": "비트코인",
  "KRW-ETH": "이더리움",
  "KRW-XRP": "리플",
};

// 🔧 코인별 호가 단위 설정
export const COIN_PRICE_STEPS = {
  "KRW-BTC": [
    { min: 10000, step: 1000 }, // 비트코인: 1만원 이상 1000원 단위
    { min: 0, step: 1000 },
  ],
  "KRW-ETH": [
    { min: 10000, step: 1000 }, // 이더리움: 1만원 이상 1000원 단위
    { min: 0, step: 1000 },
  ],
  "KRW-XRP": [
    { min: 100, step: 1 }, // 리플: 기존대로 1원 단위
    { min: 0, step: 1 },
  ],
};

// 🔧 코인별 최소 주문 금액
export const MIN_ORDER_AMOUNTS = {
  "KRW-BTC": 5000,
  "KRW-ETH": 5000,
  "KRW-XRP": 5000,
};

// 기존 PRICE_STEPS는 호환성을 위해 유지 (기본값으로 사용)
export const PRICE_STEPS = [
  { min: 100000000, step: 100000 },
  { min: 50000000, step: 50000 },
  { min: 10000000, step: 10000 },
  { min: 1000000, step: 1000 },
  { min: 100000, step: 100 },
  { min: 10000, step: 10 },
  { min: 1000, step: 5 },
  { min: 100, step: 1 },
  { min: 0, step: 0.1 },
];
