// realtime.js - 실시간 웹소켓 연결 및 데이터 브로드캐스팅
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const db = require("./services/database.js");

// 설정값 - 통합된 설정 사용
const CONFIG = {
  MARKET_CODES: process.env.MARKET_CODES
    ? process.env.MARKET_CODES.split(",")
    : ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
  UPBIT_WS_URL: process.env.UPBIT_WS_URL || "wss://api.upbit.com/websocket/v1",
  DEFAULT_USER: process.env.DEFAULT_USER || "testuser",
};

// KRW 유틸리티 사용
const KRWUtils = db.KRWUtils;



// 실시간 데이터 웹소켓 매니저
class WebSocketManager {
  constructor(clientWebSocketServer) {
    this.upbitWs = null;
    this.clientWss = clientWebSocketServer;
    this.currentMarketPrices = {};
    this.latestOrderbooks = {};
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.heartbeatInterval = null;

  }

  connect() {
    this.upbitWs = new WebSocket(CONFIG.UPBIT_WS_URL);

    this.upbitWs.onopen = () => {
      console.log("✅ 업비트 웹소켓 서버에 연결되었습니다.");
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.sendSubscriptionRequest();
      this.startHeartbeat();
    };

    this.upbitWs.onmessage = (event) => {
      this.handleMessage(event);
    };

    this.upbitWs.onclose = (event) => {
      console.log(
        `⚠️ 업비트 웹소켓 연결이 끊어졌습니다. 코드: ${event.code}, 이유: ${event.reason}`
      );
      this.isConnected = false;
      this.stopHeartbeat();
      this.handleReconnection();
    };

    this.upbitWs.onerror = (error) => {
      console.error("❌ 업비트 웹소켓 오류:", error);
      this.isConnected = false;
    };
  }

  handleReconnection() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      console.log(
        `재연결 시도 ${this.reconnectAttempts}/${this.maxReconnectAttempts} (${
          delay / 1000
        }초 후)`
      );

      setTimeout(() => this.connect(), delay);
    } else {
      console.error("❌ 웹소켓 재연결 실패 - 최대 시도 횟수 초과");
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.upbitWs && this.upbitWs.readyState === WebSocket.OPEN) {
        this.upbitWs.ping();
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  sendSubscriptionRequest() {
    const requestMessage = [
      { ticket: uuidv4() },
      { type: "ticker", codes: CONFIG.MARKET_CODES },
      { type: "orderbook", codes: CONFIG.MARKET_CODES, level: 0 },
      { type: "orderbook", codes: ["KRW-BTC"], level: 1000000 },
      { type: "orderbook", codes: ["KRW-ETH"], level: 10000 },
      { type: "orderbook", codes: ["KRW-XRP"], level: 1 },
      { format: "DEFAULT" },
    ];

    this.upbitWs.send(JSON.stringify(requestMessage));
    console.log("📡 업비트 웹소켓 구독 요청 전송 완료");
  }

  async handleMessage(event) {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "ticker") {
        this.handleTickerData(data);
      } else if (data.type === "orderbook") {
        await this.handleOrderbookData(data);
      }

      this.broadcastToClients(event.data);
    } catch (error) {
      console.error("웹소켓 메시지 처리 오류:", error);
    }
  }

  handleTickerData(data) {
    const code = data.code;
    if (!CONFIG.MARKET_CODES.includes(code)) return;

    this.currentMarketPrices[code] = KRWUtils.toInteger(data.trade_price);

    if (!this.latestOrderbooks[code]) {
      this.latestOrderbooks[code] = {};
    }
    this.latestOrderbooks[code].lastPrice = this.currentMarketPrices[code];
  }

  async handleOrderbookData(data) {
    const code = data.code;
    if (!CONFIG.MARKET_CODES.includes(code)) return;

    this.latestOrderbooks[code] = {
      ...this.latestOrderbooks[code],
      data: data,
      lastUpdated: Date.now(),
    };

  }

  broadcastToClients(data) {
    const connectedClients = Array.from(this.clientWss.clients).filter(
      (client) => client.readyState === WebSocket.OPEN
    );

    if (connectedClients.length > 0) {
      connectedClients.forEach((client) => {
        try {
          client.send(data);
        } catch (error) {
          console.error("클라이언트 메시지 전송 오류:", error);
        }
      });
    }
  }

  broadcastOrderFillNotification(userId, orderDetails) {
    const notification = {
      type: "order_filled",
      userId: userId,
      timestamp: Date.now(),
      data: {
        ...orderDetails,
        executionTime: new Date().toISOString(),
        marketPrice: this.currentMarketPrices[orderDetails.market],
      },
    };

    console.log(
      `📢 체결 알림 브로드캐스트: 사용자 ${userId}, ${orderDetails.market} ${orderDetails.side}`
    );

    this.clientWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(notification));
        } catch (error) {
          console.error("체결 알림 전송 오류:", error);
        }
      }
    });
  }

  getCurrentPrice(market) {
    const price = this.currentMarketPrices[market];
    if (!price) {
      console.warn(`⚠️ ${market}의 현재 가격 정보가 없습니다.`);
      return 0;
    }
    return price;
  }

  getIntegerPrices() {
    const integerPrices = {};
    Object.keys(this.currentMarketPrices).forEach((market) => {
      integerPrices[market] = KRWUtils.toInteger(
        this.currentMarketPrices[market]
      );
    });
    return integerPrices;
  }

  close() {
    console.log("🔌 웹소켓 매니저 종료 중...");

    this.stopHeartbeat();

    if (this.upbitWs) {
      this.upbitWs.close();
    }

    this.clientWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1000, "서버 종료");
      }
    });

    console.log("✅ 웹소켓 매니저 종료 완료");
  }
}


// 실시간 시스템 등록 함수
function registerRealtime(app, wss) {
  console.log("🚀 실시간 거래 시스템 초기화 중...");

  // 웹소켓 매니저 초기화
  const wsManager = new WebSocketManager(wss);

  // 웹소켓 연결 시작
  wsManager.connect();

  // 클라이언트 연결 처리
  wss.on("connection", (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`🔗 클라이언트 연결됨 (IP: ${clientIP})`);

    const prices = wsManager.getIntegerPrices();
    if (Object.keys(prices).length > 0) {
      ws.send(
        JSON.stringify({
          type: "initial_prices",
          data: prices,
        })
      );
    }

    ws.on("close", () => {
      console.log(`🔌 클라이언트 연결 끊김 (IP: ${clientIP})`);
    });

    ws.on("error", (error) => {
      console.error("클라이언트 웹소켓 오류:", error);
    });
  });

  // 거래 관련 API 라우트는 trading 모듈에서 처리

  console.log("✅ 실시간 거래 시스템 초기화 완료");

  // 정리 함수 반환
  return {
    close: () => {
      wsManager.close();
    },
  };
}


module.exports = registerRealtime;
