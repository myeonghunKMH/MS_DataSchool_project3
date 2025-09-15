// src/config.js - 환경변수 기반으로 통합된 설정
module.exports = {
  PORT: process.env.PORT || 3000,
  DEFAULT_USER: process.env.DEFAULT_USER || "testuser",
  MARKET_CODES: process.env.MARKET_CODES ? process.env.MARKET_CODES.split(',') : ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
  UPBIT_WS_URL: process.env.UPBIT_WS_URL || "wss://api.upbit.com/websocket/v1",
  // DB 설정은 이미 services/database.js에서 환경변수로 관리되므로 중복 제거
};