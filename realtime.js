// realtime.js - 통합된 실시간 거래 기능
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const db = require("./services/database.js");

// 설정값
const CONFIG = {
  MARKET_CODES: ["KRW-BTC", "KRW-ETH", "KRW-XRP"],
  UPBIT_WS_URL: "wss://api.upbit.com/websocket/v1",
  DEFAULT_USER: "testuser", // 기본 사용자 (추후 실제 사용자로 변경)
};

// KRW 유틸리티 (database.js와 동일)
const KRWUtils = db.KRWUtils;

// 주문 매칭 엔진 클래스
class OrderMatchingEngine {
  constructor(dbManager) {
    this.db = dbManager;
    this.isProcessing = false;
    this.processingMarkets = new Set();
  }

  async processOrderbook(market, orderbookData) {
    if (this.processingMarkets.has(market) || !orderbookData?.orderbook_units) {
      return;
    }

    this.processingMarkets.add(market);

    try {
      const pendingOrders = await this.db.getMarketPendingOrders(market);
      if (pendingOrders.length === 0) return;

      const buyOrders = pendingOrders.filter((order) => order.side === "bid");
      const sellOrders = pendingOrders.filter((order) => order.side === "ask");

      const asks = orderbookData.orderbook_units
        .map((unit) => ({
          price: KRWUtils.toInteger(unit.ask_price),
          size: unit.ask_size,
        }))
        .filter((ask) => ask.price > 0 && ask.size > 0);

      const bids = orderbookData.orderbook_units
        .map((unit) => ({
          price: KRWUtils.toInteger(unit.bid_price),
          size: unit.bid_size,
        }))
        .filter((bid) => bid.price > 0 && bid.size > 0);

      for (const buyOrder of buyOrders) {
        await this.matchBuyOrder(buyOrder, asks);
      }

      for (const sellOrder of sellOrders) {
        await this.matchSellOrder(sellOrder, bids);
      }
    } catch (error) {
      console.error(`❌ 주문 매칭 처리 오류 (${market}):`, error);
    } finally {
      this.processingMarkets.delete(market);
    }
  }

  async matchBuyOrder(buyOrder, asks) {
    const orderPrice = KRWUtils.toInteger(buyOrder.price);
    const matchableAsks = asks
      .filter((ask) => ask.price <= orderPrice)
      .sort((a, b) => a.price - b.price);

    if (matchableAsks.length === 0) return;

    let remainingQuantity = buyOrder.remaining_quantity;

    for (const ask of matchableAsks) {
      if (remainingQuantity <= 0.00000001) break;

      const executableQuantity = Math.min(remainingQuantity, ask.size);
      const executionPrice = ask.price;

      if (executableQuantity > 0.00000001) {
        console.log(`💰 매수 체결: ${buyOrder.market} - 가격: ${executionPrice.toLocaleString()}, 수량: ${executableQuantity}`);

        await this.executeTrade(
          buyOrder,
          executionPrice,
          executableQuantity,
          remainingQuantity - executableQuantity
        );

        remainingQuantity -= executableQuantity;
        ask.size -= executableQuantity;
      }
    }
  }

  async matchSellOrder(sellOrder, bids) {
    const orderPrice = KRWUtils.toInteger(sellOrder.price);
    const matchableBids = bids
      .filter((bid) => bid.price >= orderPrice)
      .sort((a, b) => b.price - a.price);

    if (matchableBids.length === 0) return;

    let remainingQuantity = sellOrder.remaining_quantity;

    for (const bid of matchableBids) {
      if (remainingQuantity <= 0.00000001) break;

      const executableQuantity = Math.min(remainingQuantity, bid.size);
      const executionPrice = bid.price;

      if (executableQuantity > 0.00000001) {
        console.log(`💸 매도 체결: ${sellOrder.market} - 가격: ${executionPrice.toLocaleString()}, 수량: ${executableQuantity}`);

        await this.executeTrade(
          sellOrder,
          executionPrice,
          executableQuantity,
          remainingQuantity - executableQuantity
        );

        remainingQuantity -= executableQuantity;
        bid.size -= executableQuantity;
      }
    }
  }

  async executeTrade(order, executionPrice, executedQuantity, remainingQuantity) {
    const totalAmount = KRWUtils.calculateTotal(executionPrice, executedQuantity);

    if (remainingQuantity < 0.00000001) {
      remainingQuantity = 0;
    }

    try {
      await this.executeOrderFillTransaction(
        order.user_id,
        order.id,
        order.market,
        order.side,
        executionPrice,
        executedQuantity,
        totalAmount,
        remainingQuantity
      );

      const status = remainingQuantity <= 0 ? "filled" : "partial";
      
      // 체결 알림 전송
      if (this.wsManager) {
        this.wsManager.broadcastOrderFillNotification(order.user_id, {
          userId: order.user_id,
          orderId: order.id,
          market: order.market,
          side: order.side,
          executionPrice: executionPrice,
          executedQuantity: executedQuantity,
          remainingQuantity: remainingQuantity,
          totalAmount: totalAmount,
          status: status,
        });
      }

      console.log(`✅ 체결 완료 - 주문ID: ${order.id}, 체결가: ${executionPrice.toLocaleString()}, 상태: ${status}`);
    } catch (error) {
      console.error(`❌ 거래 체결 처리 실패 (주문ID: ${order.id}):`, error);
      throw error;
    }
  }

  async executeOrderFillTransaction(userId, orderId, market, side, executionPrice, executedQuantity, totalAmount, remainingQuantity) {
    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();

      const coinName = market.split("-")[1].toLowerCase();

      if (side === "bid") {
        await connection.execute(`
          UPDATE users 
          SET ${coinName}_balance = ${coinName}_balance + ?
          WHERE id = ?
        `, [executedQuantity, userId]);

        // 가격 차이 환불 처리
        const priceDifference = await this.getPriceDifference(connection, orderId, executionPrice);
        if (priceDifference > 0) {
          const refundAmount = KRWUtils.calculateTotal(priceDifference, executedQuantity);
          await connection.execute(`
            UPDATE users 
            SET krw_balance = krw_balance + ?
            WHERE id = ?
          `, [refundAmount, userId]);
          console.log(`💰 매수 가격차이 환불: ${refundAmount.toLocaleString()}원`);
        }
      } else {
        await connection.execute(`
          UPDATE users 
          SET krw_balance = krw_balance + ?
          WHERE id = ?
        `, [KRWUtils.toInteger(totalAmount), userId]);
      }

      await connection.execute(`
        INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type) 
        VALUES (?, ?, ?, ?, ?, ?, 'limit')
      `, [userId, market, side, KRWUtils.toInteger(executionPrice), executedQuantity, KRWUtils.toInteger(totalAmount)]);

      const newStatus = remainingQuantity <= 0.00000001 ? "filled" : "partial";

      await connection.execute(`
        UPDATE pending_orders 
        SET remaining_quantity = ?, status = ?, updated_at = NOW()
        WHERE id = ?
      `, [remainingQuantity, newStatus, orderId]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getPriceDifference(connection, orderId, executionPrice) {
    const [rows] = await connection.execute(`
      SELECT price FROM pending_orders WHERE id = ?
    `, [orderId]);
    
    if (rows.length > 0) {
      const orderPrice = rows[0].price;
      return Math.max(0, orderPrice - executionPrice);
    }
    return 0;
  }

  setWebSocketManager(wsManager) {
    this.wsManager = wsManager;
  }
}

// 웹소켓 매니저 클래스
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

    // 주문 매칭 엔진 초기화
    this.matchingEngine = new OrderMatchingEngine(db);
    this.matchingEngine.setWebSocketManager(this);
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
      console.log(`⚠️ 업비트 웹소켓 연결이 끊어졌습니다. 코드: ${event.code}, 이유: ${event.reason}`);
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

      console.log(`재연결 시도 ${this.reconnectAttempts}/${this.maxReconnectAttempts} (${delay / 1000}초 후)`);

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

    if (data.level === 0) {
      setImmediate(async () => {
        try {
          await this.matchingEngine.processOrderbook(code, data);
        } catch (error) {
          console.error(`주문 매칭 처리 오류 (${code}):`, error);
        }
      });
    }
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

    console.log(`📢 체결 알림 브로드캐스트: 사용자 ${userId}, ${orderDetails.market} ${orderDetails.side}`);

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
      integerPrices[market] = KRWUtils.toInteger(this.currentMarketPrices[market]);
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

// 거래 서비스 클래스
class TradingService {
  constructor(wsManager) {
    this.ws = wsManager;
  }

  calculateTradeAmounts(market, side, type, normalizedPrice, normalizedQuantity) {
    let finalPrice, finalQuantity, totalAmount;

    if (type === "market") {
      const currentPrice = this.ws.getCurrentPrice(market);
      if (!currentPrice) {
        throw new Error("현재 시장가를 가져올 수 없습니다.");
      }

      if (side === "bid") {
        totalAmount = KRWUtils.toInteger(normalizedPrice);
        finalPrice = KRWUtils.toInteger(currentPrice);
        finalQuantity = totalAmount / finalPrice;
      } else {
        finalQuantity = normalizedQuantity;
        finalPrice = KRWUtils.toInteger(currentPrice);
        totalAmount = KRWUtils.calculateTotal(finalPrice, finalQuantity);
      }
    } else {
      finalPrice = KRWUtils.toInteger(normalizedPrice);
      finalQuantity = normalizedQuantity;
      totalAmount = KRWUtils.calculateTotal(finalPrice, finalQuantity);
    }

    return { finalPrice, finalQuantity, totalAmount };
  }

  async executeOrder(market, side, type, normalizedPrice, normalizedQuantity, username) {
    const userId = await db.getUserByUsername(username);
    if (!userId) {
      throw new Error("사용자를 찾을 수 없습니다.");
    }

    const { finalPrice, finalQuantity, totalAmount } = this.calculateTradeAmounts(
      market, side, type, normalizedPrice, normalizedQuantity
    );

    if (type === "limit") {
      await this.reserveBalanceForLimitOrder(userId, market, side, finalPrice, finalQuantity, totalAmount);
      return await db.createPendingOrder(userId, market, side, finalPrice, finalQuantity, totalAmount, type);
    } else {
      await db.executeTradeTransaction(userId, market, side, finalPrice, finalQuantity, totalAmount, type);
      return {
        market, side, type,
        price: KRWUtils.toInteger(finalPrice),
        quantity: finalQuantity,
        totalAmount: KRWUtils.toInteger(totalAmount),
      };
    }
  }

  async reserveBalanceForLimitOrder(userId, market, side, price, quantity, totalAmount) {
    const connection = await db.pool.getConnection();
    try {
      await connection.beginTransaction();

      if (side === "bid") {
        const requiredAmount = KRWUtils.toInteger(totalAmount);
        const [balanceResult] = await connection.execute(`
          SELECT krw_balance FROM users WHERE id = ? FOR UPDATE
        `, [userId]);

        const currentBalance = KRWUtils.toInteger(balanceResult[0]?.krw_balance || 0);
        if (currentBalance < requiredAmount) {
          throw new Error("잔액이 부족합니다.");
        }

        const newBalance = currentBalance - requiredAmount;
        await connection.execute(`
          UPDATE users SET krw_balance = ? WHERE id = ?
        `, [newBalance, userId]);

        console.log(`💰 매수 주문 잔고 예약: ${requiredAmount.toLocaleString()}원 차감`);
      } else {
        const coinName = market.split("-")[1].toLowerCase();
        const [balanceResult] = await connection.execute(`
          SELECT ${coinName}_balance FROM users WHERE id = ? FOR UPDATE
        `, [userId]);

        const currentCoinBalance = balanceResult[0]?.[`${coinName}_balance`] || 0;
        if (currentCoinBalance < quantity) {
          throw new Error("보유 코인이 부족합니다.");
        }

        const newCoinBalance = currentCoinBalance - quantity;
        await connection.execute(`
          UPDATE users SET ${coinName}_balance = ? WHERE id = ?
        `, [newCoinBalance, userId]);

        console.log(`🪙 매도 주문 잔고 예약: ${quantity}개 ${coinName.toUpperCase()} 차감`);
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

// 메인 등록 함수
function registerRealtime(app, wss) {
  console.log("🚀 실시간 거래 시스템 초기화 중...");

  // 웹소켓 매니저 초기화
  const wsManager = new WebSocketManager(wss);
  const tradingService = new TradingService(wsManager);

  // 웹소켓 연결 시작
  wsManager.connect();

  // 클라이언트 연결 처리
  wss.on("connection", (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`🔗 클라이언트 연결됨 (IP: ${clientIP})`);

    const prices = wsManager.getIntegerPrices();
    if (Object.keys(prices).length > 0) {
      ws.send(JSON.stringify({
        type: "initial_prices",
        data: prices,
      }));
    }

    ws.on("close", () => {
      console.log(`🔌 클라이언트 연결 끊김 (IP: ${clientIP})`);
    });

    ws.on("error", (error) => {
      console.error("클라이언트 웹소켓 오류:", error);
    });
  });

  // 거래 관련 API 라우트 추가
  setupTradingRoutes(app, tradingService);

  console.log("✅ 실시간 거래 시스템 초기화 완료");

  // 정리 함수 반환
  return {
    close: () => {
      wsManager.close();
    }
  };
}

// 거래 관련 API 라우트 설정
function setupTradingRoutes(app, tradingService) {
  // 잔고 조회
  app.get("/api/balance", async (req, res) => {
  try {
    // 🔧 개선: 실제 로그인된 사용자 우선, 없으면 기본 사용자
    let username = CONFIG.DEFAULT_USER;
    
    if (req.user?.email) {
      username = req.user.email;
    } else if (req.user?.preferred_username) {
      username = req.user.preferred_username;
    }
    
    console.log(`📊 잔고 조회 요청: ${username}`);
    
    const balance = await db.getUserBalance(username);

    if (!balance) {
      // 🔧 사용자가 없으면 기본 잔고로 초기화 시도
      console.log(`새 사용자 잔고 초기화: ${username}`);
      
      // users 테이블에 사용자 정보가 있는지 확인 후 잔고 초기화
      if (req.user?.id) {
        await db.pool.execute(`
          UPDATE users 
          SET 
            krw_balance = COALESCE(krw_balance, 1000000),
            btc_balance = COALESCE(btc_balance, 0.00000000),
            eth_balance = COALESCE(eth_balance, 0.00000000),
            xrp_balance = COALESCE(xrp_balance, 0.00000000)
          WHERE id = ?
        `, [req.user.id]);
        
        // 다시 조회
        const newBalance = await db.getUserBalance(username);
        if (newBalance) {
          const processedBalance = db.KRWUtils.processBalance(newBalance);
          return res.json(processedBalance);
        }
      }
      
      // 그래도 없으면 기본값 반환
      return res.json({
        krw_balance: 1000000,
        btc_balance: 0.00000000,
        eth_balance: 0.00000000,
        xrp_balance: 0.00000000
      });
    }

    const processedBalance = db.KRWUtils.processBalance(balance);
    res.json(processedBalance);
  } catch (err) {
    console.error("잔고 조회 오류:", err);
    res.status(500).json({
      error: "서버 오류: 잔고 조회에 실패했습니다.",
      code: "INTERNAL_ERROR",
    });
  }
});

  // 거래 주문
  app.post("/api/trade", async (req, res) => {
  try {
    const { market, side, type, price, quantity } = req.body;
    
    // 🔧 개선: 실제 로그인된 사용자 우선
    let username = CONFIG.DEFAULT_USER;
    
    if (req.user?.email) {
      username = req.user.email;
    } else if (req.user?.preferred_username) {
      username = req.user.preferred_username;
    }
    
    console.log(`📈 거래 주문 요청: ${username} - ${market} ${side} ${type}`);

    // 입력값 검증
    if (!market || !side || !type) {
      return res.status(400).json({
        error: "필수 필드가 누락되었습니다.",
        code: "MISSING_FIELDS",
      });
    }

    const normalizedPrice = db.KRWUtils.parseNumber(price);
    const normalizedQuantity = db.KRWUtils.parseNumber(quantity);

    const orderDetails = await tradingService.executeOrder(
      market, side, type, normalizedPrice, normalizedQuantity, username
    );

    res.status(200).json({
      message: "주문이 성공적으로 접수되었습니다.",
      orderDetails,
    });
  } catch (error) {
    console.error("❌ 주문 처리 중 오류 발생:", error.message);
    res.status(500).json({
      error: error.message || "주문 처리 중 서버 오류가 발생했습니다.",
      code: "TRADE_PROCESSING_ERROR",
    });
  }
});

  // 캔들 데이터 조회
  app.get("/api/candles", async (req, res) => {
    const { unit, market, count = 200, to } = req.query;
    const requestCount = Math.min(parseInt(count), 1000);

    if (!unit || !market) {
      return res.status(400).json({
        error: "unit과 market 파라미터가 필요합니다.",
        code: "MISSING_PARAMETERS",
      });
    }

    try {
      const allCandles = [];
      let currentTo = to;
      let remaining = requestCount;

      while (remaining > 0) {
        const batchSize = Math.min(remaining, 200);
        let url;

        if (unit === "1D") {
          url = `https://api.upbit.com/v1/candles/days?market=${market}&count=${batchSize}`;
        } else {
          url = `https://api.upbit.com/v1/candles/minutes/${unit}?market=${market}&count=${batchSize}`;
        }

        if (currentTo && currentTo !== "undefined") {
          const encodedTo = encodeURIComponent(currentTo);
          url += `&to=${encodedTo}`;
        }

        console.log(`📡 업비트 API 호출: ${url}`);

        const response = await axios.get(url, {
          headers: { "Accept-Encoding": "gzip, deflate" },
          timeout: 10000,
        });

        const data = response.data;
        if (data.length === 0) break;

        allCandles.push(...data);
        remaining -= data.length;

        if (data.length < batchSize) break;
        currentTo = data[data.length - 1].candle_date_time_utc;
      }

      console.log(`📊 캔들 데이터 ${allCandles.length}개 반환: ${market} ${unit}`);
      res.json(allCandles);
    } catch (error) {
      console.error("❌ 캔들 데이터 요청 오류:", error.message);
      res.status(500).json({
        error: "캔들 데이터를 가져오는 데 실패했습니다.",
        code: "CANDLE_DATA_ERROR",
      });
    }
  });

  // 거래 내역 조회
  app.get("/api/transactions", async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;
      const username = req.user?.email || CONFIG.DEFAULT_USER;
      const userId = await db.getUserByUsername(username);

      if (!userId) {
        return res.status(404).json({
          error: "사용자를 찾을 수 없습니다.",
          code: "USER_NOT_FOUND",
        });
      }

      const transactions = await db.getUserTransactions(userId, limit, offset);
      const processedTransactions = transactions.map((t) => db.KRWUtils.processTransaction(t));

      res.json(processedTransactions);
    } catch (error) {
      console.error("❌ 거래 내역 조회 오류:", error);
      res.status(500).json({
        error: "거래 내역 조회에 실패했습니다.",
        code: "TRANSACTION_HISTORY_ERROR",
      });
    }
  });

  // 대기 주문 조회
  app.get("/api/pending-orders", async (req, res) => {
    try {
      const username = req.user?.email || CONFIG.DEFAULT_USER;
      const userId = await db.getUserByUsername(username);

      if (!userId) {
        return res.status(404).json({
          error: "사용자를 찾을 수 없습니다.",
          code: "USER_NOT_FOUND",
        });
      }

      const orders = await db.getUserPendingOrders(userId);
      res.json(orders);
    } catch (error) {
      console.error("대기 주문 조회 오류:", error);
      res.status(500).json({
        error: "대기 주문 조회에 실패했습니다.",
        code: "PENDING_ORDERS_ERROR",
      });
    }
  });

  // 대기 주문 취소
  app.delete("/api/pending-orders/:orderId", async (req, res) => {
    try {
      const { orderId } = req.params;
      const username = req.user?.email || CONFIG.DEFAULT_USER;

      if (!orderId || isNaN(orderId)) {
        return res.status(400).json({
          error: "유효한 주문 ID가 필요합니다.",
          code: "INVALID_ORDER_ID",
        });
      }

      const userId = await db.getUserByUsername(username);
      if (!userId) {
        return res.status(404).json({
          error: "사용자를 찾을 수 없습니다.",
          code: "USER_NOT_FOUND",
        });
      }

      const result = await db.cancelPendingOrder(userId, parseInt(orderId));
      res.json(result);
    } catch (error) {
      console.error("주문 취소 오류:", error);
      res.status(500).json({
        error: error.message || "주문 취소에 실패했습니다.",
        code: "CANCEL_ORDER_ERROR",
      });
    }
  });

  console.log("📊 거래 관련 API 라우트 설정 완료");
}

module.exports = registerRealtime;