// src/services/trading-service.js (Enhanced for Order Matching)
const KRWUtils = require("../utils/krw-utils");
const CONFIG = require("../config");

class TradingService {
  constructor(dbManager, wsManager) {
    this.db = dbManager;
    this.ws = wsManager;
  }

  calculateTradeAmounts(
    market,
    side,
    type,
    normalizedPrice,
    normalizedQuantity
  ) {
    let finalPrice, finalQuantity, totalAmount;

    if (type === "market") {
      const currentPrice = this.ws.getCurrentPrice(market);
      if (!currentPrice) {
        throw new Error("현재 시장가를 가져올 수 없습니다.");
      }

      if (side === "bid") {
        // 시장가 매수: 총액 기준
        totalAmount = KRWUtils.toInteger(normalizedPrice);
        finalPrice = KRWUtils.toInteger(currentPrice);
        finalQuantity = totalAmount / finalPrice;
      } else {
        // 시장가 매도: 수량 기준
        finalQuantity = normalizedQuantity;
        finalPrice = KRWUtils.toInteger(currentPrice);
        totalAmount = KRWUtils.calculateTotal(finalPrice, finalQuantity);
      }
    } else {
      // 지정가 주문
      finalPrice = KRWUtils.toInteger(normalizedPrice);
      finalQuantity = normalizedQuantity;
      totalAmount = KRWUtils.calculateTotal(finalPrice, finalQuantity);

      console.log(
        `📝 지정가 주문 접수: ${market} ${side} - 가격: ${finalPrice.toLocaleString()}, 수량: ${finalQuantity}, 총액: ${totalAmount.toLocaleString()}`
      );
    }

    return { finalPrice, finalQuantity, totalAmount };
  }

  async executeOrder(market, side, type, normalizedPrice, normalizedQuantity) {
    const userId = await this.db.getUserById(CONFIG.DEFAULT_USER);
    if (!userId) {
      throw new Error("사용자를 찾을 수 없습니다.");
    }

    const { finalPrice, finalQuantity, totalAmount } =
      this.calculateTradeAmounts(
        market,
        side,
        type,
        normalizedPrice,
        normalizedQuantity
      );

    if (type === "limit") {
      // 지정가 주문: 잔고 예약 후 대기 주문 생성
      await this.reserveBalanceForLimitOrder(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount
      );

      return await this.db.createPendingOrder(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount,
        type
      );
    } else {
      // 시장가 주문: 즉시 체결
      await this.db.executeTradeTransaction(
        userId,
        market,
        side,
        finalPrice,
        finalQuantity,
        totalAmount,
        type
      );

      return {
        market,
        side,
        type,
        price: KRWUtils.toInteger(finalPrice),
        quantity: finalQuantity,
        totalAmount: KRWUtils.toInteger(totalAmount),
      };
    }
  }

  /**
   * 지정가 주문을 위한 잔고 예약 처리
   */
  async reserveBalanceForLimitOrder(
    userId,
    market,
    side,
    price,
    quantity,
    totalAmount
  ) {
    const sql = require("mssql");
    const request = new sql.Request(this.db.pool);

    request.input("userId", sql.Int, userId);

    if (side === "bid") {
      // 매수 주문: KRW 잔고에서 총액만큼 차감
      const requiredAmount = KRWUtils.toInteger(totalAmount);

      // 현재 잔고 확인
      const balanceResult = await request.query(`
        SELECT krw_balance FROM users WITH (UPDLOCK) WHERE id = @userId
      `);

      const currentBalance = KRWUtils.toInteger(
        balanceResult.recordset[0]?.krw_balance || 0
      );

      if (currentBalance < requiredAmount) {
        throw new Error("잔액이 부족합니다.");
      }

      const newBalance = currentBalance - requiredAmount;

      await request.input("newBalance", sql.Decimal(18, 0), newBalance).query(`
          UPDATE users SET krw_balance = @newBalance WHERE id = @userId
        `);

      console.log(
        `💰 매수 주문 잔고 예약: ${requiredAmount.toLocaleString()}원 차감 (잔여: ${newBalance.toLocaleString()}원)`
      );
    } else {
      // 매도 주문: 코인 잔고에서 수량만큼 차감
      const coinName = market.split("-")[1].toLowerCase();

      // 현재 코인 잔고 확인
      const balanceResult = await request.query(`
        SELECT ${coinName}_balance FROM users WITH (UPDLOCK) WHERE id = @userId
      `);

      const currentCoinBalance =
        balanceResult.recordset[0]?.[`${coinName}_balance`] || 0;

      if (currentCoinBalance < quantity) {
        throw new Error("보유 코인이 부족합니다.");
      }

      const newCoinBalance = currentCoinBalance - quantity;

      await request.input("newCoinBalance", sql.Decimal(18, 8), newCoinBalance)
        .query(`
          UPDATE users SET ${coinName}_balance = @newCoinBalance WHERE id = @userId
        `);

      console.log(
        `🪙 매도 주문 잔고 예약: ${quantity}개 ${coinName.toUpperCase()} 차감 (잔여: ${newCoinBalance}개)`
      );
    }
  }
}

module.exports = TradingService;
