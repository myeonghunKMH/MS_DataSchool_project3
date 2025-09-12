// src/config.js
module.exports = {
  PORT: process.env.PORT || 3000,
  DEFAULT_USER: "testuser",
  MARKET_CODES: ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
  UPBIT_WS_URL: "wss://api.upbit.com/websocket/v1",
  DB_CONFIG: {
    host: "39.117.10.117",
    port: 33306,
    user: "remoteuser",
    password: "MSFPTeam1",
    database: "RT_trading_db",
    connectionLimit: 10,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true,
    charset: 'utf8mb4'
  },
};