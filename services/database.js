const mysql = require('mysql2/promise');

function toInt(v, fallback) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function makePool(dbName) {
  if (!dbName) throw new Error('makePool: database name is required');

  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: toInt(process.env.DB_PORT, 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: dbName,

    waitForConnections: true,
    connectionLimit: toInt(process.env.DB_POOL_MAX, 10),
    queueLimit: 0,

    // 문자열로 날짜 받기(타임존/직렬화 안전)
    dateStrings: true,

    // 커넥션 유지(환경에 따라 무시될 수 있음)
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  // 부팅 시 간단 연결 테스트 로그
  pool.query('SELECT 1').then(
    () => console.log(`[DB] connected: ${dbName}`),
    (err) => console.error(`[DB] connection failed: ${dbName}`, err?.message || err)
  );

  return pool;
}

// === 풀 3개 생성 ===
// 기존 서비스용(crypto_data) - 기본 데이터
const cryptoDbName = process.env.DB_NAME || 'crypto_data';
const pool = makePool(cryptoDbName);

// 거래 전용(RT_trading_db) - pending_orders, transactions 등
const tradingDbName = process.env.TRADING_DB_NAME || 'RT_trading_db';
const tradingPool = makePool(tradingDbName);

// Q&A 전용(qna)
const qnaDbName = process.env.QNA_DB_NAME || 'qna';
const qnaPool = makePool(qnaDbName);

// 키클락 DB 전용
const keycloakDbName = process.env.KEYCLOAK_DB_NAME || 'keycloak';
const keycloakPool = makePool(keycloakDbName);

// === 유틸 ===
async function healthcheck(dbPool) {
  try {
    const [rows] = await dbPool.query('SELECT 1 AS ok');
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

// === 기존 함수들 (모두 기존 'pool' = crypto_data 를 사용) ===
async function testDBConnection() {
  try {
    const conn = await pool.getConnection();
    conn.release();
    console.log('MariaDB 연결 성공');
    return true;
  } catch (err) {
    console.error('MariaDB 연결 실패:', err);
    return false;
  }
}

async function findOrCreateUser(profile) {
  const { sub: keycloak_uuid, preferred_username: username } = profile;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE keycloak_uuid = ?',
      [keycloak_uuid]
    );
    if (rows.length > 0) {
      return rows[0];
    }

    const [result] = await pool.query(
      'INSERT INTO users (keycloak_uuid, username) VALUES (?, ?)',
      [keycloak_uuid, username]
    );
    const [newUserRows] = await pool.query(
      'SELECT * FROM users WHERE id = ?',
      [result.insertId]
    );
    return newUserRows[0];
  } catch (error) {
    console.error('Error in findOrCreateUser:', error);
    throw error;
  }
}

async function getUserById(keycloak_uuid) {
  if (!keycloak_uuid) return null;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE keycloak_uuid = ?',
      [keycloak_uuid]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error in getUserById:', error);
    throw error;
  }
}

async function requestDeletion(userId, token) {
  const expires = new Date(Date.now() + 3600 * 1000); // 1 hour
  await pool.query(
    'UPDATE users SET deletion_token = ?, deletion_token_expires_at = ? WHERE id = ?',
    [token, expires, userId]
  );
}

async function createWithdrawalReason(userId, reason) {
  await pool.query(
    'INSERT INTO withdrawal_reasons (user_id, reason) VALUES (?, ?)',
    [userId, reason]
  );
}

async function confirmDeletion(token) {
  const [rows] = await pool.query(
    'SELECT * FROM users WHERE deletion_token = ? AND deletion_token_expires_at > NOW()',
    [token]
  );
  if (rows.length === 0) {
    return null;
  }
  const user = rows[0];
  const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days
  await pool.query(
    'UPDATE users SET status = ?, deletion_scheduled_at = ?, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?',
    ['deletion_scheduled', scheduledDate, user.id]
  );
  return user;
}

async function cancelDeletion(userId) {
  await pool.query(
    "UPDATE users SET status = 'active', deletion_scheduled_at = NULL, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?",
    [userId]
  );
}

async function findUsersToDelete() {
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE status = 'deletion_scheduled' AND deletion_scheduled_at < NOW()"
  );
  return rows;
}

async function deleteUser(userId) {
  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

async function scheduleDeletionImmediately(userId) {
  const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days
  await pool.query(
    'UPDATE users SET status = ?, deletion_scheduled_at = ? WHERE id = ?',
    ['deletion_scheduled', scheduledDate, userId]
  );
}

// === 내보내기 ===
// - 기존 서버 코드 호환: pool 그대로 export
// - Q&A 전용 풀 추가: qnaPool
module.exports = {
  pool, // 기존(crypto_data)
  qnaPool, // 신규(qna)
  testDBConnection,
  findOrCreateUser,
  getUserById,
  requestDeletion,
  createWithdrawalReason,
  confirmDeletion,
  cancelDeletion,
  findUsersToDelete,
  deleteUser,
  scheduleDeletionImmediately,
  // 유틸
  healthcheck,
};


// ============== 거래 관련 기능 추가 ===============

// KRW 유틸리티 함수들
const KRWUtils = {
  toInteger(amount) {
    const num = Number(amount) || 0;
    return Math.floor(Math.abs(num)) * Math.sign(num);
  },

  calculateTotal(price, quantity) {
    const total = Number(price) * Number(quantity);
    return this.toInteger(total);
  },

  parseNumber(value) {
    if (typeof value === "string") {
      return Number(value.replace(/,/g, "")) || 0;
    }
    return Number(value) || 0;
  },

  processBalance(balance) {
    return {
      ...balance,
      krw_balance: this.toInteger(balance.krw_balance),
    };
  },

  processTransaction(transaction) {
    return {
      ...transaction,
      price: this.toInteger(transaction.price),
      total_amount: this.toInteger(transaction.total_amount),
    };
  }
};

// 사용자 거래 관련 함수들
async function getUserByUsername(username) {
  try {
    const [rows] = await pool.execute(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    return rows[0]?.id || null;
  } catch (error) {
    console.error("getUserByUsername 오류:", error);
    return null;
  }
}

async function getUserBalance(username) {
  try {
    const [rows] = await pool.execute(`
      SELECT krw_balance, btc_balance, eth_balance, xrp_balance
      FROM users
      WHERE username = ?
    `, [username]);
    return rows[0] || null;
  } catch (error) {
    console.error("getUserBalance 오류:", error);
    return null;
  }
}

async function getUserTransactions(userId, limit = 50, offset = 0) {
  try {
    const [rows] = await tradingPool.execute(`
      SELECT market, side, type, price, quantity, total_amount, created_at
      FROM transactions 
      WHERE user_id = ? 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `, [userId, parseInt(limit), parseInt(offset)]);
    return rows;
  } catch (error) {
    console.error("getUserTransactions 오류:", error);
    return [];
  }
}

async function getUserPendingOrders(userId) {
  try {
    const [rows] = await tradingPool.execute(`
      SELECT id, market, side, order_type, price, quantity, remaining_quantity, 
             total_amount, status, created_at
      FROM pending_orders 
      WHERE user_id = ? AND status IN ('pending', 'partial')
      ORDER BY created_at DESC
    `, [userId]);
    return rows;
  } catch (error) {
    console.error("getUserPendingOrders 오류:", error);
    return [];
  }
}

async function getMarketPendingOrders(market) {
  try {
    const [rows] = await tradingPool.execute(`
      SELECT id, user_id, market, side, order_type, price, quantity, 
             remaining_quantity, total_amount, status, created_at
      FROM pending_orders 
      WHERE market = ? AND status IN ('pending', 'partial') AND remaining_quantity > 0
      ORDER BY 
        CASE WHEN side = 'bid' THEN price END DESC,
        CASE WHEN side = 'ask' THEN price END ASC,
        created_at ASC
    `, [market]);
    return rows;
  } catch (error) {
    console.error("getMarketPendingOrders 오류:", error);
    return [];
  }
}

async function createPendingOrder(userId, market, side, price, quantity, totalAmount, type) {
  const connection = await tradingPool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.execute(`
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

    await connection.commit();
    console.log(`📝 지정가 주문 등록: ${market} ${side} ${KRWUtils.toInteger(price).toLocaleString()}원 ${quantity}개`);

    return {
      orderId: result.insertId,
      status: "pending",
      message: "지정가 주문이 등록되었습니다.",
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cancelPendingOrder(userId, orderId) {
  const connection = await tradingPool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.execute(`
      SELECT market, side, price, remaining_quantity, total_amount, status
      FROM pending_orders 
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial') FOR UPDATE
    `, [orderId, userId]);

    if (orderRows.length === 0) {
      throw new Error("취소할 수 있는 주문을 찾을 수 없습니다.");
    }

    const order = orderRows[0];

    await connection.execute(`
      UPDATE pending_orders 
      SET status = 'cancelled', updated_at = NOW()
      WHERE id = ? AND user_id = ? AND status IN ('pending', 'partial')
    `, [orderId, userId]);

    if (order.side === "bid") {
      const refundAmount = KRWUtils.calculateTotal(order.price, order.remaining_quantity);
      
      await connection.execute(`
        UPDATE users 
        SET krw_balance = krw_balance + ?
        WHERE id = ?
      `, [refundAmount, userId]);

      console.log(`💰 매수 주문 취소 - KRW 잔고 복구: ${refundAmount.toLocaleString()}원`);
    } else if (order.side === "ask") {
      const coinName = order.market.split("-")[1].toLowerCase();
      
      await connection.execute(`
        UPDATE users 
        SET ${coinName}_balance = ${coinName}_balance + ?
        WHERE id = ?
      `, [order.remaining_quantity, userId]);

      console.log(`🪙 매도 주문 취소 - ${coinName.toUpperCase()} 잔고 복구: ${order.remaining_quantity}개`);
    }

    await connection.commit();
    console.log(`❌ 주문 취소 완료: ID ${orderId}`);

    return { message: "주문이 성공적으로 취소되었습니다." };
  } catch (error) {
    await connection.rollback();
    console.error("주문 취소 처리 오류:", error);
    throw error;
  } finally {
    connection.release();
  }
}

async function executeTradeTransaction(userId, market, side, finalPrice, finalQuantity, totalAmount, type) {
  const connection = await tradingPool.getConnection();
  try {
    await connection.beginTransaction();

    const coinName = market.split("-")[1].toLowerCase();

    if (side === "bid") {
      await processBuyOrder(connection, userId, coinName, totalAmount, finalQuantity);
    } else {
      await processSellOrder(connection, userId, coinName, finalQuantity, totalAmount);
    }

    await connection.execute(`
      INSERT INTO transactions (user_id, market, side, price, quantity, total_amount, type) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [userId, market, side, KRWUtils.toInteger(finalPrice), finalQuantity, KRWUtils.toInteger(totalAmount), type]);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function processBuyOrder(connection, userId, coinName, totalAmount, finalQuantity) {
  // crypto_data에서 잔고 확인 (pool 사용)
  const poolConnection = await pool.getConnection();
  try {
    const [balanceRows] = await poolConnection.execute(`
      SELECT krw_balance
      FROM users WHERE id = ? FOR UPDATE
    `, [userId]);

    const currentBalance = KRWUtils.toInteger(balanceRows[0]?.krw_balance || 0);
    const requiredAmount = KRWUtils.toInteger(totalAmount);

    console.log(`💰 시장가 매수 잔고 확인 - 사용자 ID: ${userId}`);
    console.log(`💰 현재 잔고: ${currentBalance.toLocaleString()}원`);
    console.log(`💰 필요 금액: ${requiredAmount.toLocaleString()}원`);

    if (currentBalance < requiredAmount) {
      throw new Error(`잔액이 부족합니다. 현재 잔고: ${currentBalance.toLocaleString()}원, 필요 금액: ${requiredAmount.toLocaleString()}원`);
    }

    const newKrwBalance = currentBalance - requiredAmount;

    // crypto_data에서 잔고 차감
    await poolConnection.execute(`
      UPDATE users SET krw_balance = ? WHERE id = ?
    `, [newKrwBalance, userId]);

  } finally {
    poolConnection.release();
  }

  // crypto_data에서 코인 잔고 증가
  const cryptoConnection = await pool.getConnection();
  try {
    await cryptoConnection.execute(`
      UPDATE users
      SET ${coinName}_balance = ${coinName}_balance + ?
      WHERE id = ?
    `, [finalQuantity, userId]);
  } finally {
    cryptoConnection.release();
  }
}

async function processSellOrder(connection, userId, coinName, finalQuantity, totalAmount) {
  // crypto_data에서 잔고 확인 및 업데이트
  const poolConnection = await pool.getConnection();
  try {
    const [balanceRows] = await poolConnection.execute(`
      SELECT ${coinName}_balance, krw_balance
      FROM users WHERE id = ? FOR UPDATE
    `, [userId]);

    const currentCoinBalance = balanceRows[0]?.[`${coinName}_balance`] || 0;
    const currentKrwBalance = KRWUtils.toInteger(balanceRows[0]?.krw_balance || 0);

    console.log(`💰 시장가 매도 잔고 확인 - 사용자 ID: ${userId}`);
    console.log(`💰 현재 ${coinName.toUpperCase()} 잔고: ${currentCoinBalance}개`);
    console.log(`💰 매도 수량: ${finalQuantity}개`);
    console.log(`💰 받을 금액: ${KRWUtils.toInteger(totalAmount).toLocaleString()}원`);

    if (currentCoinBalance < finalQuantity) {
      throw new Error(`보유 코인이 부족합니다. 현재 잔고: ${currentCoinBalance}개, 매도 수량: ${finalQuantity}개`);
    }

    const addAmount = KRWUtils.toInteger(totalAmount);
    const newKrwBalance = currentKrwBalance + addAmount;

    // crypto_data에서 잔고 업데이트
    await poolConnection.execute(`
      UPDATE users
      SET krw_balance = ?,
          ${coinName}_balance = ${coinName}_balance - ?
      WHERE id = ?
    `, [newKrwBalance, finalQuantity, userId]);

  } finally {
    poolConnection.release();
  }
}

// ============== 키클락 동기화 함수 추가 ===============

// 키클락 USER_ENTITY에서 사용자 정보 가져오기
async function getKeycloakUsers() {
  try {
    const [rows] = await keycloakPool.execute(`
      SELECT ID, USERNAME, EMAIL, CREATED_TIMESTAMP, ENABLED
      FROM USER_ENTITY
      WHERE REALM_ID = 'itc'
    `);
    return rows;
  } catch (error) {
    console.error("키클락 사용자 조회 오류:", error);
    return [];
  }
}

// crypto_data.users 테이블에서 기존 키클락 사용자 확인
async function getExistingKeycloakUsers() {
  try {
    const [rows] = await pool.execute(`
      SELECT keycloak_uuid, username
      FROM users
      WHERE keycloak_uuid IS NOT NULL
    `);
    return new Set(rows.map(row => row.keycloak_uuid));
  } catch (error) {
    console.error("기존 키클락 사용자 조회 오류:", error);
    return new Set();
  }
}

// 키클락 사용자를 crypto_data.users에 동기화
async function syncKeycloakUsers() {
  try {
    console.log("🔄 키클락 사용자 동기화 시작...");

    const keycloakUsers = await getKeycloakUsers();
    const existingUsers = await getExistingKeycloakUsers();

    let syncCount = 0;

    for (const kcUser of keycloakUsers) {
      // 이미 존재하는 사용자는 건너뛰기
      if (existingUsers.has(kcUser.ID)) {
        continue;
      }

      // 새 사용자 생성
      try {
        const [result] = await pool.execute(`
          INSERT INTO users (keycloak_uuid, username, created_at)
          VALUES (?, ?, NOW())
        `, [kcUser.ID, kcUser.USERNAME]);

        // 초기 거래 잔고 설정
        await pool.execute(`
          UPDATE users
          SET
            krw_balance = 10000000,
            btc_balance = 0.00000000,
            eth_balance = 0.00000000,
            xrp_balance = 0.00000000
          WHERE id = ?
        `, [result.insertId]);

        syncCount++;
        console.log(`✅ 새 사용자 동기화: ${kcUser.USERNAME} (${kcUser.ID})`);
      } catch (insertError) {
        console.error(`❌ 사용자 동기화 실패: ${kcUser.USERNAME}`, insertError.message);
      }
    }

    console.log(`🎉 키클락 동기화 완료: ${syncCount}명의 새 사용자 추가`);
    return syncCount;
  } catch (error) {
    console.error("키클락 동기화 오류:", error);
    throw error;
  }
}

// 거래 관련 함수들을 exports에 추가
module.exports = {
  ...module.exports, // 기존 exports 유지

  // DB 풀들
  pool,           // crypto_data (기본)
  tradingPool,    // RT_trading_db (거래 전용)
  qnaPool,        // qna (Q&A 전용)
  keycloakPool,   // keycloak (키클락 전용)

  // 거래 관련 함수들 추가
  KRWUtils,
  getUserByUsername,
  getUserBalance,
  getUserTransactions,
  getUserPendingOrders,
  getMarketPendingOrders,
  createPendingOrder,
  cancelPendingOrder,
  executeTradeTransaction,
  processBuyOrder,
  processSellOrder,

  // 키클락 동기화 함수들
  getKeycloakUsers,
  getExistingKeycloakUsers,
  syncKeycloakUsers,

  // KRWUtils 추가
  KRWUtils
};