
const fs = require('fs');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: fs.readFileSync('/etc/secrets/DB_HOST', 'utf8'),
  port: Number(fs.readFileSync('/etc/secrets/DB_PORT', 'utf8')),
  user: fs.readFileSync('/etc/secrets/DB_USER', 'utf8'),
  password: fs.readFileSync('/etc/secrets/DB_PASSWORD', 'utf8'),
  database: fs.readFileSync('/etc/secrets/DB_NAME', 'utf8'),
  waitForConnections: true,
  connectionLimit: Number(fs.readFileSync('/etc/secrets/DB_POOL_MAX', 'utf8')) || 10,
  queueLimit: 0
});

async function testDBConnection() {
  try {
    const conn = await pool.getConnection();
    conn.release();
    console.log("MariaDB 연결 성공");
    return true;
  } catch (err) {
    console.error("MariaDB 연결 실패:", err);
    return false;
  }
}

async function findOrCreateUser(profile) {
  const { sub: keycloak_uuid, preferred_username: username } = profile;

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE keycloak_uuid = ?', [keycloak_uuid]);
    if (rows.length > 0) {
      return rows[0];
    }

    const [result] = await pool.query('INSERT INTO users (keycloak_uuid, username) VALUES (?, ?)', [keycloak_uuid, username]);
    const [newUserRows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId]);
    return newUserRows[0];

  } catch (error) {
    console.error("Error in findOrCreateUser:", error);
    throw error;
  }
}

async function getUserById(keycloak_uuid) {
    if (!keycloak_uuid) return null;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE keycloak_uuid = ?', [keycloak_uuid]);
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        console.error("Error in getUserById:", error);
        throw error;
    }
}


async function requestDeletion(userId, token) {
    const expires = new Date(Date.now() + 3600 * 1000); // 1 hour expiry
    await pool.query(
        'UPDATE users SET deletion_token = ?, deletion_token_expires_at = ? WHERE id = ?',
        [token, expires, userId]
    );
}

async function createWithdrawalReason(userId, reason) {
    await pool.query('INSERT INTO withdrawal_reasons (user_id, reason) VALUES (?, ?)', [userId, reason]);
}

async function confirmDeletion(token) {
    const [rows] = await pool.query('SELECT * FROM users WHERE deletion_token = ? AND deletion_token_expires_at > NOW()', [token]);
    if (rows.length === 0) {
        return null;
    }
    const user = rows[0];
    const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days from now
    await pool.query(
        'UPDATE users SET status = ?, deletion_scheduled_at = ?, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?',
        ['deletion_scheduled', scheduledDate, user.id]
    );
    return user;
}

async function cancelDeletion(userId) {
    await pool.query(
        'UPDATE users SET status = \'active\', deletion_scheduled_at = NULL, deletion_token = NULL, deletion_token_expires_at = NULL WHERE id = ?',
        [userId]
    );
}

async function findUsersToDelete() {
    const [rows] = await pool.query('SELECT * FROM users WHERE status = \'deletion_scheduled\' AND deletion_scheduled_at < NOW()');
    return rows;
}

async function deleteUser(userId) {
    await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}


async function scheduleDeletionImmediately(userId) {
    const scheduledDate = new Date(Date.now() + 14 * 24 * 3600 * 1000); // 14 days from now
    await pool.query(
        'UPDATE users SET status = ?, deletion_scheduled_at = ? WHERE id = ?',
        ['deletion_scheduled', scheduledDate, userId]
    );
}

module.exports = { pool, testDBConnection, findOrCreateUser, getUserById, requestDeletion, createWithdrawalReason, confirmDeletion, cancelDeletion, findUsersToDelete, deleteUser, scheduleDeletionImmediately };

