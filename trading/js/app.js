// src/js/app.js (Enhanced with Order Matching System)
const express = require("express");
const { Server } = require("ws");
const http = require("http");
const cors = require("cors");
const path = require("path");

// 경로를 한 단계 상위 디렉토리로 변경 (../)
const CONFIG = require("../config");
const database = require("../../services/database");
const WebSocketManager = require("../managers/websocket-manager");
const TradingService = require("../services/trading-service");
const APIRouter = require("../routes/api-router");

class TradingServer {
  constructor() {
    // Express 앱 및 서버 설정
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new Server({ server: this.server });

    // 서비스 인스턴스들
    this.dbManager = database;

    // ✅ WebSocketManager에 dbManager 전달 (주문 매칭 엔진용)
    this.wsManager = new WebSocketManager(this.wss, this.dbManager);

    this.tradingService = new TradingService(this.dbManager, this.wsManager);
    this.apiRouter = new APIRouter(this.dbManager, this.tradingService);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupErrorHandlers();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(cors());
    // `app.js`에서 프로젝트 루트 디렉토리의 `public` 폴더로 이동하는 경로
    this.app.use(express.static(path.join(__dirname, "../../public")));
  }

  setupRoutes() {
    this.app.use("/api", this.apiRouter.router);
  }

  setupWebSocket() {
    this.wss.on("connection", (ws, req) => {
      const clientIP = req.socket.remoteAddress;
      console.log(`🔗 클라이언트 연결됨 (IP: ${clientIP})`);

      // 연결 시 현재 시장가 전송
      const prices = this.wsManager.getIntegerPrices();
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
  }

  setupErrorHandlers() {
    // 예외 처리
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled Rejection at:", promise, "reason:", reason);
    });

    process.on("uncaughtException", (error) => {
      console.error("Uncaught Exception:", error);
      process.exit(1);
    });

    // 서버 종료 처리
    process.on("SIGINT", () => this.shutdown());
  }

  async start() {
    try {
      // 데이터베이스 연결
      await this.dbManager.testDBConnection();

      // 업비트 웹소켓 연결 (주문 매칭 엔진 포함)
      this.wsManager.connect();

      // HTTP 서버 시작
      this.server.listen(CONFIG.PORT, () => {
        console.log(
          `🚀 서버가 http://localhost:${CONFIG.PORT} 에서 실행 중입니다.`
        );
        console.log(`📊 지원 마켓: ${CONFIG.MARKET_CODES.join(", ")}`);
        console.log(`💰 원화 금액은 정수로 처리됩니다.`);
        console.log(`🎯 실시간 주문 매칭 엔진이 활성화되었습니다.`);
      });
    } catch (error) {
      console.error("❌ 서버 시작 실패:", error);
      process.exit(1);
    }
  }

  async shutdown() {
    console.log("\n🛑 서버 종료 중...");

    try {
      // 웹소켓 연결 종료
      this.wsManager.close();

      // 데이터베이스 연결 종료
      // services/database.js는 연결 종료 함수가 없으므로 제거

      // HTTP 서버 종료
      this.server.close(() => {
        console.log("✅ 서버가 정상적으로 종료되었습니다.");
        process.exit(0);
      });
    } catch (error) {
      console.error("❌ 서버 종료 중 오류:", error);
      process.exit(1);
    }
  }
}

module.exports = TradingServer;
