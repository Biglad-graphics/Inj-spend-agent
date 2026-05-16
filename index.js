// ============================================================
// INJ Autonomous Spend Agent — Telegram Bot
// Stack: Telegraf + Injective SDK + Claude AI + node-cron
// ============================================================

require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const {
  PrivateKey,
  InjectiveDirectEthSecp256k1Wallet,
} = require("@injectivelabs/sdk-ts");
const { ChainGrpcBankApi, IndexerGrpcExplorerApi } = require("@injectivelabs/sdk-ts");
const { MsgSend } = require("@injectivelabs/sdk-ts");
const { MsgBroadcasterWithPk } = require("@injectivelabs/sdk-ts");
const { Network, getNetworkEndpoints } = require("@injectivelabs/networks");
const { BigNumberInBase } = require("@injectivelabs/utils");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const Database = require("better-sqlite3");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 32-char secret for AES-256
const NETWORK = Network.Mainnet;
const ENDPOINTS = getNetworkEndpoints(NETWORK);
const INJ_DENOM = "inj";
const INJ_DECIMALS = 18;

if (!BOT_TOKEN || !ANTHROPIC_API_KEY || !ENCRYPTION_KEY) {
  console.error("❌ Missing env vars: BOT_TOKEN, ANTHROPIC_API_KEY, ENCRYPTION_KEY");
  process.exit(1);
}

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database("/app/data/agent.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   TEXT PRIMARY KEY,
    username      TEXT,
    address       TEXT NOT NULL,
    encrypted_pk  TEXT NOT NULL,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   TEXT NOT NULL,
    label         TEXT,
    cron_expr     TEXT NOT NULL,
    to_address    TEXT NOT NULL,
    amount_inj    REAL NOT NULL,
    active        INTEGER DEFAULT 1,
    last_run      INTEGER,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   TEXT NOT NULL,
    type          TEXT NOT NULL,
    threshold_inj REAL NOT NULL,
    active        INTEGER DEFAULT 1,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS tx_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id   TEXT NOT NULL,
    type          TEXT NOT NULL,
    to_address    TEXT,
    amount_inj    REAL,
    tx_hash       TEXT,
    status        TEXT,
    note          TEXT,
    created_at    INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// ─── Encryption helpers ────────────────────────────────────────────────────────
const KEY = Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32));

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decrypt(data) {
  const [ivHex, encHex] = data.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ─── Wallet helpers ────────────────────────────────────────────────────────────
function generateWallet() {
  const pk = PrivateKey.generate();
  return {
    privateKey: pk.toHex(),
    address: pk.toPublicKey().toAddress().toBech32(),
  };
}

function getPrivateKeyForUser(telegramId) {
  const row = db.prepare("SELECT encrypted_pk FROM users WHERE telegram_id = ?").get(telegramId);
  if (!row) return null;
  return decrypt(row.encrypted_pk);
}

// ─── Injective SDK helpers ─────────────────────────────────────────────────────
const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc);

async function getBalance(address) {
  try {
    const bal = await bankApi.fetchBalance({ accountAddress: address, denom: INJ_DENOM });
    const inj = new BigNumberInBase(bal.amount).toWei(INJ_DECIMALS).toNumber() / 1e18;
    return inj;
  } catch {
    return 0;
  }
}

async function sendInj(fromPkHex, toAddress, amountInj) {
  const pk = PrivateKey.fromHex(fromPkHex);
  const injectiveAddress = pk.toPublicKey().toAddress().toBech32();

  const amountInWei = new BigNumberInBase(amountInj).toWei(INJ_DECIMALS).toFixed(0);

  const msg = MsgSend.fromJSON({
    srcInjectiveAddress: injectiveAddress,
    dstInjectiveAddress: toAddress,
    amount: { denom: INJ_DENOM, amount: amountInWei },
  });

  const broadcaster = new MsgBroadcasterWithPk({
    privateKey: fromPkHex,
    network: NETWORK,
  });

  const result = await broadcaster.broadcast({ msgs: msg });
  return result.txHash;
}

// ─── Claude AI intent parser ───────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: "https://cc.freemodel.dev",
});

const SYSTEM_PROMPT = `You are an intent parser for an Injective blockchain spend agent Telegram bot.

Parse user messages and return ONLY valid JSON (no markdown, no explanation).

Possible intent types:
1. send_now       — immediate transfer
2. schedule_send  — recurring transfer
3. set_alert      — balance alert
4. check_balance  — view wallet balance
5. list_schedules — list active schedules
6. cancel_schedule — cancel a schedule by ID
7. list_alerts    — list active alerts
8. cancel_alert   — cancel an alert by ID
9. tx_history     — view recent transactions
10. help          — general help
11. unknown       — unrecognized intent

For send_now:
{ "intent": "send_now", "to": "<inj address>", "amount": <number>, "memo": "<optional>" }

For schedule_send, map natural language to cron:
- "every day at 9am"      → "0 9 * * *"
- "every Monday"          → "0 9 * * 1"
- "every Friday at 6pm"   → "0 18 * * 5"
- "every 1st of the month"→ "0 9 1 * *"
{ "intent": "schedule_send", "to": "<inj address>", "amount": <number>, "cron": "<cron expr>", "label": "<human label>" }

For set_alert:
{ "intent": "set_alert", "type": "below", "threshold": <number> }

For cancel_schedule:
{ "intent": "cancel_schedule", "schedule_id": <number or null> }

For cancel_alert:
{ "intent": "cancel_alert", "alert_id": <number or null> }

For others:
{ "intent": "check_balance" }
{ "intent": "list_schedules" }
{ "intent": "list_alerts" }
{ "intent": "tx_history" }
{ "intent": "help" }
{ "intent": "unknown", "message": "what i understood" }

INJ addresses start with "inj1". Amount is always in INJ (not wei).
If amount or address is missing for send/schedule, set them to null.`;

async function parseIntent(userMessage) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    const text = response.content[0].text.trim();
    return JSON.parse(text);
  } catch (e) {
    return { intent: "unknown", message: "Parse error" };
  }
}

// ─── Bot setup ─────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── Middleware: ensure user is registered ─────────────────────────────────────
async function ensureUser(ctx, next) {
  const telegramId = String(ctx.from.id);
  const existing = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
  if (!existing) {
    ctx.state.needsWallet = true;
  }
  ctx.state.telegramId = telegramId;
  ctx.state.user = existing || null;
  return next();
}

bot.use(ensureUser);

// ─── /start ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const existing = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);

  if (existing) {
    const bal = await getBalance(existing.address);
    return ctx.replyWithMarkdown(
      `👋 Welcome back *${ctx.from.first_name}*!\n\n` +
      `🏦 Your wallet: \`${existing.address}\`\n` +
      `💰 Balance: *${bal.toFixed(4)} INJ*\n\n` +
      `Just tell me what to do — send INJ, schedule payments, or set alerts.\n` +
      `Type /help to see all commands.`
    );
  }

  // New user → generate wallet
  const { privateKey, address } = generateWallet();
  const encryptedPk = encrypt(privateKey);

  db.prepare(
    "INSERT INTO users (telegram_id, username, address, encrypted_pk) VALUES (?, ?, ?, ?)"
  ).run(telegramId, ctx.from.username || "", address, encryptedPk);

  return ctx.replyWithMarkdown(
    `⚡ *INJ Spend Agent activated!*\n\n` +
    `Your dedicated INJ wallet has been created:\n\n` +
    `\`${address}\`\n\n` +
    `📥 *Deposit INJ to this address to get started.*\n\n` +
    `Once funded, you can:\n` +
    `• Send INJ instantly\n` +
    `• Schedule recurring payments\n` +
    `• Set balance alerts\n\n` +
    `Just type naturally — I understand plain English.\n` +
    `_e.g. "Send 2 INJ to inj1... every Friday"_`
  );
});

// ─── /wallet ──────────────────────────────────────────────────────────────────
bot.command("wallet", async (ctx) => {
  const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(ctx.state.telegramId);
  if (!user) return ctx.reply("Use /start first.");
  const bal = await getBalance(user.address);
  ctx.replyWithMarkdown(
    `🏦 *Your Wallet*\n\n` +
    `Address: \`${user.address}\`\n` +
    `Balance: *${bal.toFixed(4)} INJ*\n\n` +
    `_Deposit INJ to this address to fund your agent._`
  );
});

// ─── /help ────────────────────────────────────────────────────────────────────
bot.command("help", (ctx) => {
  ctx.replyWithMarkdown(
    `⚡ *INJ Spend Agent — Commands*\n\n` +
    `Just type naturally or use these shortcuts:\n\n` +
    `*Wallet*\n` +
    `/wallet — view address & balance\n` +
    `/history — recent transactions\n\n` +
    `*Payments*\n` +
    `_"Send 5 INJ to inj1abc..."_\n` +
    `_"Pay inj1xyz... 2 INJ now"_\n\n` +
    `*Scheduled Payments*\n` +
    `_"Send 1 INJ to inj1... every Monday"_\n` +
    `_"Pay inj1... 2 INJ on the 1st of every month"_\n` +
    `/schedules — list all schedules\n` +
    `/cancelschedule <id> — stop a schedule\n\n` +
    `*Alerts*\n` +
    `_"Alert me if balance drops below 5 INJ"_\n` +
    `/alerts — list active alerts\n` +
    `/cancelalert <id> — remove an alert\n\n` +
    `*Balance*\n` +
    `_"What's my balance?"_`
  );
});

// ─── /history ─────────────────────────────────────────────────────────────────
bot.command("history", (ctx) => {
  const rows = db.prepare(
    "SELECT * FROM tx_log WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 10"
  ).all(ctx.state.telegramId);

  if (!rows.length) return ctx.reply("No transactions yet.");

  const lines = rows.map((r) => {
    const date = new Date(r.created_at * 1000).toLocaleDateString();
    const status = r.status === "success" ? "✅" : "❌";
    return `${status} ${r.type} • ${r.amount_inj} INJ • ${date}\n` +
      (r.tx_hash ? `   [tx](https://explorer.injective.network/transaction/${r.tx_hash})` : `   ${r.note || ""}`);
  });

  ctx.replyWithMarkdown(`📋 *Recent Transactions*\n\n${lines.join("\n\n")}`, {
    disable_web_page_preview: true,
  });
});

// ─── /schedules ───────────────────────────────────────────────────────────────
bot.command("schedules", (ctx) => {
  const rows = db.prepare(
    "SELECT * FROM schedules WHERE telegram_id = ? AND active = 1"
  ).all(ctx.state.telegramId);

  if (!rows.length) return ctx.reply("No active schedules.");

  const lines = rows.map(
    (r) => `*#${r.id}* ${r.label || "Payment"}\n` +
      `  → ${r.amount_inj} INJ to \`${r.to_address.slice(0, 16)}...\`\n` +
      `  ⏰ ${r.cron_expr}`
  );

  ctx.replyWithMarkdown(`📅 *Active Schedules*\n\n${lines.join("\n\n")}`);
});

// ─── /cancelschedule ──────────────────────────────────────────────────────────
bot.command("cancelschedule", (ctx) => {
  const id = ctx.message.text.split(" ")[1];
  if (!id) return ctx.reply("Usage: /cancelschedule <id>");

  const row = db.prepare(
    "SELECT * FROM schedules WHERE id = ? AND telegram_id = ?"
  ).get(id, ctx.state.telegramId);

  if (!row) return ctx.reply("Schedule not found.");

  db.prepare("UPDATE schedules SET active = 0 WHERE id = ?").run(id);
  ctx.reply(`✅ Schedule #${id} cancelled.`);
});

// ─── /alerts ──────────────────────────────────────────────────────────────────
bot.command("alerts", (ctx) => {
  const rows = db.prepare(
    "SELECT * FROM alerts WHERE telegram_id = ? AND active = 1"
  ).all(ctx.state.telegramId);

  if (!rows.length) return ctx.reply("No active alerts.");

  const lines = rows.map(
    (r) => `*#${r.id}* Alert when balance drops below *${r.threshold_inj} INJ*`
  );

  ctx.replyWithMarkdown(`🔔 *Active Alerts*\n\n${lines.join("\n")}`);
});

// ─── /cancelalert ─────────────────────────────────────────────────────────────
bot.command("cancelalert", (ctx) => {
  const id = ctx.message.text.split(" ")[1];
  if (!id) return ctx.reply("Usage: /cancelalert <id>");

  const row = db.prepare(
    "SELECT * FROM alerts WHERE id = ? AND telegram_id = ?"
  ).get(id, ctx.state.telegramId);

  if (!row) return ctx.reply("Alert not found.");

  db.prepare("UPDATE alerts SET active = 0 WHERE id = ?").run(id);
  ctx.reply(`✅ Alert #${id} removed.`);
});

// ─── Natural language message handler ─────────────────────────────────────────
bot.on("text", async (ctx) => {
  const telegramId = ctx.state.telegramId;
  const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);

  if (!user) {
    return ctx.reply("Please use /start to set up your wallet first.");
  }

  const text = ctx.message.text;
  if (text.startsWith("/")) return; // already handled by commands

  await ctx.sendChatAction("typing");

  const intent = await parseIntent(text);

  switch (intent.intent) {

    // ── check_balance ──────────────────────────────────────────────────────────
    case "check_balance": {
      const bal = await getBalance(user.address);
      ctx.replyWithMarkdown(
        `💰 *Balance: ${bal.toFixed(4)} INJ*\n\`${user.address}\``
      );
      break;
    }

    // ── send_now ───────────────────────────────────────────────────────────────
    case "send_now": {
      if (!intent.to || !intent.amount) {
        return ctx.reply("Please specify a recipient address and amount.\nE.g. \"Send 2 INJ to inj1abc...\"");
      }

      if (!intent.to.startsWith("inj1")) {
        return ctx.reply("❌ Invalid Injective address. Must start with inj1...");
      }

      const bal = await getBalance(user.address);
      if (bal < intent.amount) {
        return ctx.replyWithMarkdown(
          `❌ Insufficient balance.\nYou have *${bal.toFixed(4)} INJ*, trying to send *${intent.amount} INJ*.`
        );
      }

      await ctx.reply(`⏳ Sending ${intent.amount} INJ to ${intent.to.slice(0, 20)}...`);

      try {
        const pk = getPrivateKeyForUser(telegramId);
        const txHash = await sendInj(pk, intent.to, intent.amount);

        db.prepare(
          "INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, tx_hash, status) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(telegramId, "send", intent.to, intent.amount, txHash, "success");

        ctx.replyWithMarkdown(
          `✅ *Sent ${intent.amount} INJ*\n\nTo: \`${intent.to}\`\n` +
          `[View on Explorer](https://explorer.injective.network/transaction/${txHash})`,
          { disable_web_page_preview: false }
        );
      } catch (e) {
        db.prepare(
          "INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, status, note) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(telegramId, "send", intent.to, intent.amount, "failed", e.message);

        ctx.reply(`❌ Transaction failed: ${e.message}`);
      }
      break;
    }

    // ── schedule_send ──────────────────────────────────────────────────────────
    case "schedule_send": {
      if (!intent.to || !intent.amount || !intent.cron) {
        return ctx.reply(
          "I need more info. Try:\n\"Send 2 INJ to inj1abc... every Monday\""
        );
      }

      if (!intent.to.startsWith("inj1")) {
        return ctx.reply("❌ Invalid Injective address. Must start with inj1...");
      }

      if (!cron.validate(intent.cron)) {
        return ctx.reply("❌ Couldn't parse that schedule. Try: \"every Monday\", \"every day at 9am\", \"every 1st of the month\".");
      }

      db.prepare(
        "INSERT INTO schedules (telegram_id, label, cron_expr, to_address, amount_inj) VALUES (?, ?, ?, ?, ?)"
      ).run(telegramId, intent.label || "Scheduled Payment", intent.cron, intent.to, intent.amount);

      const row = db.prepare("SELECT last_insert_rowid() as id").get();

      // Register the cron job live
      registerCronJob(telegramId, row.id, intent.cron, intent.to, intent.amount, intent.label);

      ctx.replyWithMarkdown(
        `✅ *Schedule Created! (#${row.id})*\n\n` +
        `💸 ${intent.amount} INJ → \`${intent.to.slice(0, 20)}...\`\n` +
        `⏰ ${intent.label || intent.cron}\n\n` +
        `Cancel anytime: /cancelschedule ${row.id}`
      );
      break;
    }

    // ── set_alert ──────────────────────────────────────────────────────────────
    case "set_alert": {
      if (!intent.threshold) {
        return ctx.reply("Please specify a threshold. E.g. \"Alert me when balance drops below 5 INJ\"");
      }

      db.prepare(
        "INSERT INTO alerts (telegram_id, type, threshold_inj) VALUES (?, ?, ?)"
      ).run(telegramId, intent.type || "below", intent.threshold);

      const row = db.prepare("SELECT last_insert_rowid() as id").get();

      ctx.replyWithMarkdown(
        `🔔 *Alert Set! (#${row.id})*\n\n` +
        `You'll be notified when your balance drops below *${intent.threshold} INJ*.\n\n` +
        `Cancel anytime: /cancelalert ${row.id}`
      );
      break;
    }

    // ── list_schedules ─────────────────────────────────────────────────────────
    case "list_schedules": {
      ctx.message.text = "/schedules";
      return bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: "/schedules" } });
    }

    // ── list_alerts ────────────────────────────────────────────────────────────
    case "list_alerts": {
      ctx.message.text = "/alerts";
      return bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: "/alerts" } });
    }

    // ── tx_history ─────────────────────────────────────────────────────────────
    case "tx_history": {
      const rows = db.prepare(
        "SELECT * FROM tx_log WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 10"
      ).all(telegramId);

      if (!rows.length) return ctx.reply("No transactions yet.");

      const lines = rows.map((r) => {
        const date = new Date(r.created_at * 1000).toLocaleDateString();
        const status = r.status === "success" ? "✅" : "❌";
        return `${status} ${r.type} • ${r.amount_inj} INJ • ${date}` +
          (r.tx_hash ? `\n   [tx](https://explorer.injective.network/transaction/${r.tx_hash})` : "");
      });

      ctx.replyWithMarkdown(`📋 *Recent Transactions*\n\n${lines.join("\n\n")}`, {
        disable_web_page_preview: true,
      });
      break;
    }

    // ── help ───────────────────────────────────────────────────────────────────
    case "help": {
      ctx.message.text = "/help";
      bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: "/help" } });
      break;
    }

    // ── cancel_schedule ────────────────────────────────────────────────────────
    case "cancel_schedule": {
      if (!intent.schedule_id) {
        const rows = db.prepare("SELECT * FROM schedules WHERE telegram_id = ? AND active = 1").all(telegramId);
        if (!rows.length) return ctx.reply("No active schedules to cancel.");
        const lines = rows.map((r) => `#${r.id} — ${r.label || r.cron_expr}`).join("\n");
        return ctx.reply(`Which schedule?\n${lines}\n\nUse: /cancelschedule <id>`);
      }
      db.prepare("UPDATE schedules SET active = 0 WHERE id = ? AND telegram_id = ?").run(intent.schedule_id, telegramId);
      ctx.reply(`✅ Schedule #${intent.schedule_id} cancelled.`);
      break;
    }

    // ── cancel_alert ───────────────────────────────────────────────────────────
    case "cancel_alert": {
      if (!intent.alert_id) {
        const rows = db.prepare("SELECT * FROM alerts WHERE telegram_id = ? AND active = 1").all(telegramId);
        if (!rows.length) return ctx.reply("No active alerts.");
        const lines = rows.map((r) => `#${r.id} — below ${r.threshold_inj} INJ`).join("\n");
        return ctx.reply(`Which alert?\n${lines}\n\nUse: /cancelalert <id>`);
      }
      db.prepare("UPDATE alerts SET active = 0 WHERE id = ? AND telegram_id = ?").run(intent.alert_id, telegramId);
      ctx.reply(`✅ Alert #${intent.alert_id} removed.`);
      break;
    }

    // ── unknown ────────────────────────────────────────────────────────────────
    default: {
      ctx.reply(
        `I didn't understand that. Try:\n\n` +
        `• "Send 2 INJ to inj1..."\n` +
        `• "Pay inj1... 1 INJ every Monday"\n` +
        `• "Alert me if balance drops below 5 INJ"\n` +
        `• "What's my balance?"\n\n` +
        `/help for all commands.`
      );
    }
  }
});

// ─── Cron job registry ─────────────────────────────────────────────────────────
const activeCronJobs = {};

function registerCronJob(telegramId, scheduleId, cronExpr, toAddress, amountInj, label) {
  if (!cron.validate(cronExpr)) return;

  const jobKey = `${telegramId}_${scheduleId}`;
  if (activeCronJobs[jobKey]) activeCronJobs[jobKey].stop();

  const task = cron.schedule(cronExpr, async () => {
    const schedule = db.prepare("SELECT * FROM schedules WHERE id = ? AND active = 1").get(scheduleId);
    if (!schedule) {
      task.stop();
      return;
    }

    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
    if (!user) return;

    const bal = await getBalance(user.address);

    if (bal < amountInj) {
      bot.telegram.sendMessage(
        telegramId,
        `⚠️ Scheduled payment failed: insufficient balance.\n` +
        `Need ${amountInj} INJ, have ${bal.toFixed(4)} INJ.\n` +
        `Schedule: ${label || `#${scheduleId}`}`
      );

      db.prepare(
        "INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, status, note) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(telegramId, "scheduled", toAddress, amountInj, "failed", "Insufficient balance");
      return;
    }

    try {
      const pk = getPrivateKeyForUser(telegramId);
      const txHash = await sendInj(pk, toAddress, amountInj);

      db.prepare("UPDATE schedules SET last_run = strftime('%s','now') WHERE id = ?").run(scheduleId);
      db.prepare(
        "INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, tx_hash, status) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(telegramId, "scheduled", toAddress, amountInj, txHash, "success");

      bot.telegram.sendMessage(
        telegramId,
        `✅ Scheduled payment sent!\n\n` +
        `💸 ${amountInj} INJ → ${toAddress.slice(0, 20)}...\n` +
        `🔗 https://explorer.injective.network/transaction/${txHash}`,
        { parse_mode: "Markdown", disable_web_page_preview: false }
      );
    } catch (e) {
      db.prepare(
        "INSERT INTO tx_log (telegram_id, type, to_address, amount_inj, status, note) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(telegramId, "scheduled", toAddress, amountInj, "failed", e.message);

      bot.telegram.sendMessage(
        telegramId,
        `❌ Scheduled payment failed: ${e.message}`
      );
    }
  });

  activeCronJobs[jobKey] = task;
}

// ─── Load existing schedules on startup ───────────────────────────────────────
function loadSchedules() {
  const rows = db.prepare("SELECT * FROM schedules WHERE active = 1").all();
  console.log(`📅 Loading ${rows.length} active schedule(s)...`);
  rows.forEach((r) => {
    registerCronJob(r.telegram_id, r.id, r.cron_expr, r.to_address, r.amount_inj, r.label);
  });
}

// ─── Alert polling (every 5 minutes) ──────────────────────────────────────────
cron.schedule("*/5 * * * *", async () => {
  const alerts = db.prepare("SELECT * FROM alerts WHERE active = 1 AND type = 'below'").all();
  for (const alert of alerts) {
    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(alert.telegram_id);
    if (!user) continue;
    const bal = await getBalance(user.address);
    if (bal < alert.threshold_inj) {
      bot.telegram.sendMessage(
        alert.telegram_id,
        `🚨 *Balance Alert!*\n\nYour balance dropped below *${alert.threshold_inj} INJ*.\nCurrent: *${bal.toFixed(4)} INJ*\n\nDeposit to: \`${user.address}\``,
        { parse_mode: "Markdown" }
      );
    }
  }
});

// ─── Launch ────────────────────────────────────────────────────────────────────
loadSchedules();

bot.launch().then(() => {
  console.log("⚡ INJ Spend Agent bot is live!");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
