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

// === 풀 2개 생성 ===
// 기존 서비스용(crypto_data). 서버의 기존 import 호환을 위해 이름 'pool'도 유지.
const cryptoDbName = process.env.DB_NAME || 'crypto_data';
const pool = makePool(cryptoDbName);

// Q&A 전용(qna)
const qnaDbName = process.env.QNA_DB_NAME || 'qna';
const qnaPool = makePool(qnaDbName);

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
