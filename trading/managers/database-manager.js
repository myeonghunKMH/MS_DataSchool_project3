const mariadb = require("mariadb");
const CONFIG = require("../config");
const KRWUtils = require("../utils/krw-utils");

class DatabaseManager {
  constructor() {
    this.pool = null;
  }

  async connect() {
    try {
      this.pool = mariadb.createPool({ ...CONFIG.DB_CONFIG, connectionLimit: 5 });
      console.log("✅ MariaDB 데이터베이스에 성공적으로 연결되었습니다.");
    } catch (err) {
      console.error("❌ MariaDB 데이터베이스 연결 오류:", err);
      throw err;
    }
  }

  async getUserById(username) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query("SELECT id FROM users WHERE username = ?", [username]);
      return result[0]?.id;
    } finally {
      conn.release();
    }
  }

  async getUserBalance(username) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        SELECT krw_balance, btc_balance, eth_balance, xrp_balance 
        FROM users 
        WHERE username = ?
      `, [username]);
      return result[0];
    } finally {
      conn.release();
    }
  }

  async getUserTransactions(userId, limit, offset) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        SELECT market, side, type, price, quantity, total_amount, created_at
        FROM transactions 
        WHERE user_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `, [userId, parseInt(limit), parseInt(offset)]);
      return result;
    } finally {
      conn.release();
    }
  }

  async getUserPendingOrders(userId) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        SELECT id, market, side, order_type, price, quantity, remaining_quantity, 
               total_amount, status, created_at
        FROM pending_orders 
        WHERE user_id = ? AND status IN ('pending', 'partial')
        ORDER BY created_at DESC
      `, [userId]);
      return result;
    } finally {
      conn.release();
    }
  }

  async getMarketPendingOrders(market) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        SELECT id, user_id, market, side, order_type, price, quantity, 
               remaining_quantity, total_amount, status, created_at
        FROM pending_orders 
        WHERE market = ? AND status IN ('pending', 'partial') AND remaining_quantity > 0
        ORDER BY 
          CASE WHEN side = 'bid' THEN price END DESC,
          CASE WHEN side = 'ask' THEN price END ASC,
          created_at ASC
      `, [market]);
      return result;
    } finally {
      conn.release();
    }
  }

  async createPendingOrder(
    userId,
    market,
    side,
    price,
    quantity,
    totalAmount,
    type
  ) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const result = await conn.query(`
        INSERT INTO pending_orders 
        (user_id, market, side, order_type, price, quantity, remaining_quantity, total_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        market,
        side,
        type,
        KRWUtils.toInteger(price),
        quantity,
        quantity,
        KRWUtils.toInteger(totalAmount),
      ]);

      await conn.commit();

      console.log(
        `📝 지정가 주문 등록: ${market} ${side} ${KRWUtils.toInteger(
          price
        ).toLocaleString()}원 ${quantity}개`
      );

      return {
        orderId: result.insertId,
        status: "pending",
        message: "지정가 주문이 등록되었습니다.",
      };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async cancelPendingOrder(userId, orderId) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const orderResult = await conn.query(`
        SELECT market, side, price, remaining_quantity, total_amount, status
        FROM pending_orders 
        WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial') FOR UPDATE
      `, [orderId, userId]);

      if (orderResult.length === 0) {
        throw new Error("취소할 수 있는 주문을 찾을 수 없습니다.");
      }

      const order = orderResult[0];

      await conn.query(`
        UPDATE pending_orders 
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial')
      `, [orderId, userId]);

      if (order.side === "bid") {
        const refundAmount = KRWUtils.calculateTotal(
          order.price,
          order.remaining_quantity
        );

        await conn.query(`
          UPDATE users 
          SET krw_balance = krw_balance + ?
          WHERE id = ?
        `, [refundAmount, userId]);

        console.log(
          `💰 매수 주문 취소 - KRW 잔고 복구: ${refundAmount.toLocaleString()}원`
        );
      } else if (order.side === "ask") {
        const coinName = order.market.split("-")[1].toLowerCase();

        await conn.query(`
          UPDATE users 
          SET ${coinName}_balance = ${coinName}_balance + ?
          WHERE id = ?
        `, [order.remaining_quantity, userId]);

        console.log(
          `🪙 매도 주문 취소 - ${coinName.toUpperCase()} 잔고 복구: ${
            order.remaining_quantity
          }개`
        );
      }

      await conn.commit();
      console.log(`❌ 주문 취소 완료: ID ${orderId}`);

      return { message: "주문이 성공적으로 취소되었습니다." };
    } catch (error) {
      await conn.rollback();
      console.error("주문 취소 처리 오류:", error);
      throw error;
    } finally {
      conn.release();
    }
  }

  async executeOrderFillTransaction(
    userId,
    orderId,
    market,
    side,
    executionPrice,
    executedQuantity,
    totalAmount,
    remainingQuantity
  ) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const coinName = market.split("-")[1].toLowerCase();

      if (side === "bid") {
        await conn.query(`
          UPDATE users 
          SET ${coinName}_balance = ${coinName}_balance + ?
          WHERE id = ?
        `, [executedQuantity, userId]);

        console.log(
          `🪙 매수 체결 - ${coinName.toUpperCase()} 잔고 증가: ${executedQuantity}개`
        );
      } else {
        await conn.query(`
          UPDATE users 
          SET krw_balance = krw_balance + ?
          WHERE id = ?
        `, [KRWUtils.toInteger(totalAmount), userId]);

        console.log(
          `💰 매도 체결 - KRW 잔고 증가: ${KRWUtils.toInteger(
            totalAmount
          ).toLocaleString()}원`
        );
      }

      await conn.query(`
        INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type) 
        VALUES (?, ?, ?, ?, ?, ?, 'limit')
      `, [userId, market, side, KRWUtils.toInteger(executionPrice), executedQuantity, KRWUtils.toInteger(totalAmount)]);

      const newStatus = remainingQuantity <= 0.00000001 ? "filled" : "partial";

      await conn.query(`
        UPDATE pending_orders 
        SET remaining_quantity = ?, status = ?, updated_at = NOW()
        WHERE id = ?
      `, [remainingQuantity, newStatus, orderId]);

      await conn.commit();

      console.log(
        `✅ 체결 트랜잭션 완료 - 주문ID: ${orderId}, 상태: ${newStatus}, 잔여: ${remainingQuantity}`
      );
    } catch (error) {
      await conn.rollback();
      console.error(`❌ 체결 트랜잭션 실패 - 주문ID: ${orderId}:`, error);
      throw error;
    } finally {
      conn.release();
    }
  }

  async adjustUserBalance(userId, balanceType, amount) {
    const conn = await this.pool.getConnection();
    try {
      const adjustedAmount =
        balanceType === "krw_balance" ? KRWUtils.toInteger(amount) : amount;

      await conn.query(`
        UPDATE users 
        SET ${balanceType} = ${balanceType} + ?
        WHERE id = ?
      `, [adjustedAmount, userId]);

      console.log(
        `🔧 잔고 조정: 사용자 ${userId}, ${balanceType} ${amount > 0 ? "+" : ""}${
          balanceType === "krw_balance"
            ? KRWUtils.toInteger(amount).toLocaleString() + "원"
            : amount + "개"
        }`
      );
    } finally {
      conn.release();
    }
  }

  async executeTradeTransaction(
    userId,
    market,
    side,
    finalPrice,
    finalQuantity,
    totalAmount,
    type
  ) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const coinName = market.split("-")[1].toLowerCase();

      if (side === "bid") {
        await this.processBuyOrder(conn, userId, coinName, totalAmount, finalQuantity);
      } else {
        await this.processSellOrder(
          conn,
          userId,
          coinName,
          finalQuantity,
          totalAmount
        );
      }

      await conn.query(`
        INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [userId, market, side, KRWUtils.toInteger(finalPrice), finalQuantity, KRWUtils.toInteger(totalAmount), type]);

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async processBuyOrder(conn, userId, coinName, totalAmount, finalQuantity) {
    const balanceResult = await conn.query(`
      SELECT krw_balance 
      FROM users WHERE id = ? FOR UPDATE
    `, [userId]);

    const currentBalance = KRWUtils.toInteger(
      balanceResult[0]?.krw_balance || 0
    );
    const requiredAmount = KRWUtils.toInteger(totalAmount);

    if (currentBalance < requiredAmount) {
      throw new Error("잔액이 부족합니다.");
    }

    const newKrwBalance = currentBalance - requiredAmount;

    await conn.query(`
      UPDATE users 
      SET krw_balance = ?, 
          ${coinName}_balance = ${coinName}_balance + ? 
      WHERE id = ?
    `, [newKrwBalance, finalQuantity, userId]);
  }

  async processSellOrder(conn, userId, coinName, finalQuantity, totalAmount) {
    const balanceResult = await conn.query(`
      SELECT ${coinName}_balance, krw_balance 
      FROM users WHERE id = ? FOR UPDATE
    `, [userId]);

    const currentCoinBalance =
      balanceResult[0]?.[`${coinName}_balance`] || 0;
    const currentKrwBalance = KRWUtils.toInteger(
      balanceResult[0]?.krw_balance || 0
    );

    if (currentCoinBalance < finalQuantity) {
      throw new Error("보유 코인이 부족합니다.");
    }

    const addAmount = KRWUtils.toInteger(totalAmount);
    const newKrwBalance = currentKrwBalance + addAmount;

    await conn.query(`
      UPDATE users 
      SET krw_balance = ?, 
          ${coinName}_balance = ${coinName}_balance - ? 
      WHERE id = ?
    `, [newKrwBalance, finalQuantity, userId]);
  }

  async getOrderStatistics() {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        SELECT 
          status,
          COUNT(*) as count,
          AVG(price) as avg_price,
          SUM(total_amount) as total_volume
        FROM pending_orders 
        GROUP BY status
      `);
      return result;
    } finally {
      conn.release();
    }
  }

  async getUserOrderHistory(userId, limit = 100) {
    const conn = await this.pool.getConnection();
    try {
      const result = await conn.query(`
        (SELECT 
          'transaction' as type,
          market, side, price, quantity, total_amount, created_at
        FROM transactions 
        WHERE user_id = ?)
        UNION ALL
        (SELECT 
          'pending' as type,
          market, side, price, remaining_quantity, total_amount, created_at
        FROM pending_orders 
        WHERE user_id = ? AND status IN ('pending', 'partial'))
        ORDER BY created_at DESC
        LIMIT ?
      `, [userId, userId, limit]);
      return result;
    } finally {
      conn.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      console.log("✅ 데이터베이스 연결이 정상적으로 종료되었습니다.");
    }
  }
}

module.exports = DatabaseManager;