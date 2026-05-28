// ============================================================
// InjiPay — PostgreSQL Database Module
// Replaces JSONBin with Railway PostgreSQL
// ============================================================

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize database tables
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        wallets JSONB,
        pin_hash TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id BIGINT PRIMARY KEY,
        telegram_id TEXT NOT NULL,
        wallet_id BIGINT,
        label TEXT,
        cron_expr TEXT,
        to_address TEXT,
        amount_inj NUMERIC,
        active BOOLEAN,
        last_run BIGINT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id BIGINT PRIMARY KEY,
        telegram_id TEXT NOT NULL,
        wallet_id BIGINT,
        type TEXT,
        threshold_inj NUMERIC,
        active BOOLEAN,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS tx_log (
        id SERIAL PRIMARY KEY,
        telegram_id TEXT NOT NULL,
        type TEXT,
        to_address TEXT,
        amount_inj NUMERIC,
        tx_hash TEXT,
        status TEXT,
        note TEXT,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS one_time_sends (
        id BIGINT PRIMARY KEY,
        telegram_id TEXT NOT NULL,
        wallet_id BIGINT,
        to_address TEXT,
        amount_inj NUMERIC,
        send_at TEXT,
        active BOOLEAN,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS p2p_trades (
        id TEXT PRIMARY KEY,
        telegram_id TEXT NOT NULL,
        username TEXT,
        wallet_id BIGINT,
        amount_inj NUMERIC,
        naira_amount NUMERIC,
        rate NUMERIC,
        bank_name TEXT,
        account_number TEXT,
        account_name TEXT,
        tx_hash TEXT,
        status TEXT,
        paid_at BIGINT,
        paid_by TEXT,
        refunded_at BIGINT,
        created_at BIGINT
      );
    `);
    console.log("✅ Database tables initialized");
  } catch (err) {
    console.error("Database init error:", err);
  }
}

// Read all data (mimics old readDB structure)
async function readDB() {
  try {
    const usersRes = await pool.query("SELECT * FROM users");
    const schedulesRes = await pool.query("SELECT * FROM schedules");
    const alertsRes = await pool.query("SELECT * FROM alerts");
    const txLogRes = await pool.query("SELECT * FROM tx_log ORDER BY created_at DESC LIMIT 1000");
    const oneTimeSendsRes = await pool.query("SELECT * FROM one_time_sends");
    const p2pTradesRes = await pool.query("SELECT * FROM p2p_trades");

    const users = {};
    usersRes.rows.forEach((row) => {
      users[row.telegram_id] = {
        telegram_id: row.telegram_id,
        username: row.username,
        wallets: row.wallets,
        pin_hash: row.pin_hash,
        created_at: row.created_at,
      };
    });

    return {
      users,
      schedules: schedulesRes.rows,
      alerts: alertsRes.rows,
      tx_log: txLogRes.rows,
      one_time_sends: oneTimeSendsRes.rows,
      p2p_trades: p2pTradesRes.rows,
    };
  } catch (err) {
    console.error("readDB error:", err);
    return { users: {}, schedules: [], alerts: [], tx_log: [], one_time_sends: [], p2p_trades: [] };
  }
}

// Write all data back (syncs changes)
async function writeDB(data) {
  try {
    // Write users
    for (const [telegramId, user] of Object.entries(data.users || {})) {
      await pool.query(
        `INSERT INTO users (telegram_id, username, wallets, pin_hash, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (telegram_id) DO UPDATE SET
         username = $2, wallets = $3, pin_hash = $4`,
        [telegramId, user.username, JSON.stringify(user.wallets), user.pin_hash, user.created_at]
      );
    }

    // Write schedules
    for (const sched of data.schedules || []) {
      await pool.query(
        `INSERT INTO schedules (id, telegram_id, wallet_id, label, cron_expr, to_address, amount_inj, active, last_run, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET active = $8, last_run = $9`,
        [sched.id, sched.telegram_id, sched.wallet_id, sched.label, sched.cron_expr, sched.to_address, sched.amount_inj, sched.active, sched.last_run, sched.created_at]
      );
    }

    // Write alerts
    for (const alert of data.alerts || []) {
      await pool.query(
        `INSERT INTO alerts (id, telegram_id, wallet_id, type, threshold_inj, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET active = $6`,
        [alert.id, alert.telegram_id, alert.wallet_id, alert.type, alert.threshold_inj, alert.active, alert.created_at]
      );
    }

    // Write tx_log (append only, don't update)
    for (const tx of data.tx_log || []) {
      if (!tx.id) {
        await pool.query(
          `INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, tx_hash, status, note, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tx.telegram_id, tx.type, tx.to_address, tx.amount_inj, tx.tx_hash, tx.status, tx.note, tx.created_at]
        );
      }
    }

    // Write one_time_sends
    for (const ots of data.one_time_sends || []) {
      await pool.query(
        `INSERT INTO one_time_sends (id, telegram_id, wallet_id, to_address, amount_inj, send_at, active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET active = $7`,
        [ots.id, ots.telegram_id, ots.wallet_id, ots.to_address, ots.amount_inj, ots.send_at, ots.active, ots.created_at]
      );
    }

    // Write p2p_trades
    for (const trade of data.p2p_trades || []) {
      await pool.query(
        `INSERT INTO p2p_trades (id, telegram_id, username, wallet_id, amount_inj, naira_amount, rate, bank_name, account_number, account_name, tx_hash, status, paid_at, paid_by, refunded_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO UPDATE SET status = $12, paid_at = $13, paid_by = $14, refunded_at = $15`,
        [trade.id, trade.telegram_id, trade.username, trade.wallet_id, trade.amount_inj, trade.naira_amount, trade.rate, trade.bank_name, trade.account_number, trade.account_name, trade.tx_hash, trade.status, trade.paid_at, trade.paid_by, trade.refunded_at, trade.created_at]
      );
    }
  } catch (err) {
    console.error("writeDB error:", err);
  }
}

module.exports = { pool, initDB, readDB, writeDB };
