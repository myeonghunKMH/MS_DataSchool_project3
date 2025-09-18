// src/services/order-matching-engine.js - 개선된 버전
const KRWUtils = require("../utils/krw-utils");

class OrderMatchingEngine {
  constructor(dbManager) {
    this.db = dbManager;
    this.isProcessing = false;
    this.processingMarkets = new Set(); // 마켓별 동시 처리 방지
  }

  /**
   * 호가창 데이터를 받아서 대기 주문과 매칭 처리
   */
  async processOrderbook(market, orderbookData) {
    if (this.processingMarkets.has(market) || !orderbookData?.orderbook_units) {
      return;
    }

    this.processingMarkets.add(market);

    try {
      // 해당 마켓의 대기 주문들을 가져옴
      const pendingOrders = await this.db.getMarketPendingOrders(market);

      if (pendingOrders.length === 0) {
        return;
      }

      // 매수/매도 주문 분리
      const buyOrders = pendingOrders.filter((order) => order.side === "bid");
      const sellOrders = pendingOrders.filter((order) => order.side === "ask");

      // 호가창에서 매도호가(asks)와 매수호가(bids) 추출
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

      // 매수 주문 체결 처리 (호가창의 매도호가와 매칭)
      for (const buyOrder of buyOrders) {
        await this.matchBuyOrder(buyOrder, asks);
      }

      // 매도 주문 체결 처리 (호가창의 매수호가와 매칭)
      for (const sellOrder of sellOrders) {
        await this.matchSellOrder(sellOrder, bids);
      }
    } catch (error) {
      console.error(`❌ 주문 매칭 처리 오류 (${market}):`, error);
    } finally {
      this.processingMarkets.delete(market);
    }
  }

  /**
   * 매수 주문과 호가창의 매도호가 매칭
   */
  async matchBuyOrder(buyOrder, asks) {
    const orderPrice = KRWUtils.toInteger(buyOrder.price);

    // 주문 가격 이하의 매도호가 찾기 (가격 오름차순 정렬)
    const matchableAsks = asks
      .filter((ask) => ask.price <= orderPrice)
      .sort((a, b) => a.price - b.price);

    if (matchableAsks.length === 0) {
      return; // 체결 가능한 가격 없음
    }

    let remainingQuantity = buyOrder.remaining_quantity;

    for (const ask of matchableAsks) {
      if (remainingQuantity <= 0.00000001) break; // 소수점 정밀도 고려

      const executableQuantity = Math.min(remainingQuantity, ask.size);
      const executionPrice = ask.price;

      if (executableQuantity > 0.00000001) {
        // 최소 실행 수량 체크

        await this.executeTrade(
          buyOrder,
          executionPrice,
          executableQuantity,
          remainingQuantity - executableQuantity
        );

        remainingQuantity -= executableQuantity;
        ask.size -= executableQuantity; // 호가창 물량 차감
      }
    }
  }

  /**
   * 매도 주문과 호가창의 매수호가 매칭
   */
  async matchSellOrder(sellOrder, bids) {
    const orderPrice = KRWUtils.toInteger(sellOrder.price);

    // 주문 가격 이상의 매수호가 찾기 (가격 내림차순 정렬)
    const matchableBids = bids
      .filter((bid) => bid.price >= orderPrice)
      .sort((a, b) => b.price - a.price);

    if (matchableBids.length === 0) {
      return; // 체결 가능한 가격 없음
    }

    let remainingQuantity = sellOrder.remaining_quantity;

    for (const bid of matchableBids) {
      if (remainingQuantity <= 0.00000001) break;

      const executableQuantity = Math.min(remainingQuantity, bid.size);
      const executionPrice = bid.price;

      if (executableQuantity > 0.00000001) {

        await this.executeTrade(
          sellOrder,
          executionPrice,
          executableQuantity,
          remainingQuantity - executableQuantity
        );

        remainingQuantity -= executableQuantity;
        bid.size -= executableQuantity; // 호가창 물량 차감
      }
    }
  }

  /**
   * 🔧 개선된 실제 거래 체결 처리 (부분 체결 및 가격 차이 환불 처리)
   * 🔒 동시성 문제 해결: DB 락을 이용한 중복 체결 방지
   */
  async executeTrade(
    order,
    executionPrice,
    executedQuantity,
    remainingQuantity
  ) {
    const totalAmount = KRWUtils.calculateTotal(
      executionPrice,
      executedQuantity
    );

    // 남은 수량이 매우 작으면 완전 체결로 처리
    if (remainingQuantity < 0.00000001) {
      remainingQuantity = 0;
    }

    // 🔒 중복 처리 방지: 주문 상태를 원자적으로 확인 및 업데이트
    const connection = await this.db.pool.getConnection();

    try {
      await connection.beginTransaction();

      // 주문이 여전히 처리 가능한 상태인지 확인하고 락 획득
      const [orderCheck] = await connection.execute(`
        SELECT id, status, remaining_quantity
        FROM pending_orders
        WHERE id = ? AND status IN ('pending', 'partial')
        FOR UPDATE
      `, [order.id]);

      if (orderCheck.length === 0) {
        // 이미 다른 프로세스에서 처리됨
        console.log(`⚠️ 주문 ${order.id}이 이미 처리되었습니다. 건너뜁니다.`);
        await connection.rollback();
        return;
      }

      const currentOrder = orderCheck[0];

      // 남은 수량이 실행하려는 수량보다 작으면 조정
      if (currentOrder.remaining_quantity < executedQuantity) {
        executedQuantity = currentOrder.remaining_quantity;
        remainingQuantity = 0;
      }

      // 실행할 수량이 너무 작으면 취소
      if (executedQuantity < 0.00000001) {
        console.log(`⚠️ 주문 ${order.id}의 실행 가능한 수량이 없습니다.`);
        await connection.rollback();
        return;
      }

      // 실제 총액 재계산
      const actualTotalAmount = KRWUtils.calculateTotal(executionPrice, executedQuantity);

      // 매수 주문의 경우 가격 차이만큼 환불 처리
      if (order.side === "bid" && remainingQuantity > 0) {
        const priceDifference = order.price - executionPrice;
        if (priceDifference > 0) {
          const refundAmount = KRWUtils.calculateTotal(
            priceDifference,
            executedQuantity
          );
          // 환불 금액을 잔고에 추가 (connection 사용)
          await connection.execute(`
            UPDATE users SET krw_balance = krw_balance + ? WHERE id = ?
          `, [refundAmount, order.user_id]);
        }
      }

      // 🔒 중복 방지: connection을 사용한 체결 처리
      await this.executeOrderFillTransactionWithConnection(
        connection,
        order.user_id,
        order.id,
        order.market,
        order.side,
        executionPrice,
        executedQuantity,
        actualTotalAmount,
        remainingQuantity
      );

      const status = remainingQuantity <= 0 ? "filled" : "partial";

      await connection.commit();

      // 커밋 후 알림 전송
      if (status === "filled") {
        // 완전체결된 주문을 transactions에 저장
        await this.db.saveCompletedOrderToTransactions(order.user_id, order.id);

        // 체결 알림 전송
        this.notifyOrderFill({
          userId: order.user_id,
          orderId: order.id,
          market: order.market,
          side: order.side,
          executionPrice: executionPrice,
          executedQuantity: order.quantity, // 전체 주문 수량
          remainingQuantity: remainingQuantity,
          totalAmount: KRWUtils.calculateTotal(order.price, order.quantity), // 전체 주문 금액
          status: status,
        });
      }

    } catch (error) {
      await connection.rollback();
      console.error(`❌ 거래 체결 처리 실패 (주문ID: ${order.id}):`, error);
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * 🔒 DB 연결을 직접 사용한 주문 체결 처리 (중복 방지용)
   */
  async executeOrderFillTransactionWithConnection(
    connection,
    userId,
    orderId,
    market,
    side,
    executionPrice,
    executedQuantity,
    totalAmount,
    remainingQuantity
  ) {
    const coinName = market.split("-")[1].toLowerCase();
    const newStatus = remainingQuantity <= 0 ? "filled" : "partial";

    // 잔고 업데이트
    if (side === "bid") {
      // 매수: 코인 잔고 증가
      await connection.execute(`
        UPDATE users SET ${coinName}_balance = ${coinName}_balance + ? WHERE id = ?
      `, [executedQuantity, userId]);
    } else {
      // 매도: KRW 잔고 증가
      await connection.execute(`
        UPDATE users SET krw_balance = krw_balance + ? WHERE id = ?
      `, [totalAmount, userId]);
    }

    // 주문 상태 업데이트
    await connection.execute(`
      UPDATE pending_orders
      SET remaining_quantity = ?, status = ?, updated_at = NOW()
      WHERE id = ?
    `, [remainingQuantity, newStatus, orderId]);

    // 체결 기록 저장
    await connection.execute(`
      INSERT INTO order_fills (order_id, user_id, market, side, price, quantity, amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [orderId, userId, market, side, executionPrice, executedQuantity, totalAmount]);

    console.log(`✅ 체결 완료: ${market} ${side} - ${executedQuantity}개 x ${executionPrice.toLocaleString()}원 = ${totalAmount.toLocaleString()}원`);
  }

  /**
   * 🔧 체결 알림을 WebSocket을 통해 클라이언트에게 전송
   */
  notifyOrderFill(orderFillData) {
    // WebSocketManager 인스턴스에 접근하여 체결 알림 전송
    // 이는 메인 앱에서 주입받아야 함
    if (this.wsManager) {
      this.wsManager.broadcastOrderFillNotification(
        orderFillData.userId,
        orderFillData
      );
    }
  }

  /**
   * WebSocketManager 인스턴스 설정
   */
  setWebSocketManager(wsManager) {
    this.wsManager = wsManager;
  }

  /**
   * 🔧 주문 매칭 통계 정보
   */
  getMatchingStats() {
    return {
      isProcessing: this.isProcessing,
      processingMarkets: Array.from(this.processingMarkets),
      activeMarketsCount: this.processingMarkets.size,
    };
  }

  /**
   * 🔧 특정 마켓의 대기 주문 개수 확인
   */
  async getPendingOrdersCount(market) {
    try {
      const orders = await this.db.getMarketPendingOrders(market);
      return {
        total: orders.length,
        buyOrders: orders.filter((o) => o.side === "bid").length,
        sellOrders: orders.filter((o) => o.side === "ask").length,
      };
    } catch (error) {
      console.error(`대기 주문 개수 조회 오류 (${market}):`, error);
      return { total: 0, buyOrders: 0, sellOrders: 0 };
    }
  }
}

module.exports = OrderMatchingEngine;
