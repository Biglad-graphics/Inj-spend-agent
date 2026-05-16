// ============================================================
// INJ Autonomous Spend Agent — Telegram Bot
// Stack: Telegraf + Injective SDK + Claude AI + node-cron + JSONbin
// ============================================================

require("dotenv").config();
const { Telegraf } = require("telegraf");
const { PrivateKey } = require("@injectivelabs/sdk-ts");
const { ChainGrpcBankApi } = require("@injectivelabs/sdk-ts");
const { MsgSend } = require("@injectivelabs/sdk-ts");
const { MsgBroadcasterWithPk } = require("@injectivelabs/sdk-ts");
const { Network, getNetworkEndpoints } = require("@injectivelabs/networks");
const { BigNumberInBase } = require("@injectivelabs/utils");
const Anthropic = require("@anthropic-ai/sdk");
const cron = require("node-cron");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const NETWORK = Network.Mainnet;
const ENDPOINTS = getNetworkEndpoints(NETWORK);
const INJ_DENOM = "inj";
const INJ_DECIMALS = 18;

if (!BOT_TOKEN || !ANTHROPIC_API_KEY || !ENCRYPTION_KEY || !JSONBIN_KEY || !JSONBIN_BIN_ID) {
  console.error("Missing env vars: BOT_TOKEN, ANTHROPIC_API_KEY, ENCRYPTION_KEY, JSONBIN_KEY, JSONBIN_BIN_ID");
  process.exit(1);
}

// ─── JSONbin ──────────────────────────────────────────────────────────────────
async function readDB() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { "X-Master-Key": JSONBIN_KEY },
  });
  const json = await res.json();
  return json.record || { users: {}, schedules: [], alerts: [], tx_log: [] };
}

async function writeDB(data) {
  await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": JSONBIN_KEY,
    },
    body: JSON.stringify(data),
  });
}

// ─── Encryption ───────────────────────────────────────────────────────────────
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

// ─── Wallet ───────────────────────────────────────────────────────────────────
function generateWallet() {
  const pk = PrivateKey.generate();
  return {
    privateKey: pk.toPrivateKeyHex(),
    address: pk.toPublicKey().toAddress().toBech32(),
  };
}

// ─── Injective ────────────────────────────────────────────────────────────────
const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc);

async function getBalance(address) {
  try {
    const bal = await bankApi.fetchBalance({ accountAddress: address, denom: INJ_DENOM });
    return parseFloat(new BigNumberInBase(bal.amount).toWei(INJ_DECIMALS).toNumber() / 1e18);
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

// ─── Claude AI ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: "https://cc.freemodel.dev",
});

const SYSTEM_PROMPT = `You are an intent parser for an Injective blockchain spend agent Telegram bot.
Parse user messages and return ONLY valid JSON (no markdown, no explanation).

Possible intents:
1. send_now       -> { "intent": "send_now", "to": "<inj address>", "amount": <number> }
2. schedule_send  -> { "intent": "schedule_send", "to": "<inj address>", "amount": <number>, "cron": "<cron expr>", "label": "<human label>" }
3. set_alert      -> { "intent": "set_alert", "type": "below", "threshold": <number> }
4. check_balance  -> { "intent": "check_balance" }
5. list_schedules -> { "intent": "list_schedules" }
6. cancel_schedule-> { "intent": "cancel_schedule", "schedule_id": <number or null> }
7. list_alerts    -> { "intent": "list_alerts" }
8. cancel_alert   -> { "intent": "cancel_alert", "alert_id": <number or null> }
9. tx_history     -> { "intent": "tx_history" }
10. help          -> { "intent": "help" }
11. unknown       -> { "intent": "unknown" }

Cron mappings:
- "every day at 9am"       -> "0 9 * * *"
- "every Monday"           -> "0 9 * * 1"
- "every Friday at 6pm"    -> "0 18 * * 5"
- "every 1st of the month" -> "0 9 1 * *"

INJ addresses start with "inj1". Amount is always in INJ.`;

async function parseIntent(userMessage) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    return JSON.parse(response.content[0].text.trim());
  } catch {
    return { intent: "unknown" };
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const db = await readDB();

  if (db.users[telegramId]) {
    const user = db.users[telegramId];
    const bal = await getBalance(user.address);
    return ctx.replyWithMarkdown(
      `👋 Welcome back *${ctx.from.first_name}*!\n\n` +
      `🏦 Wallet: \`${user.address}\`\n` +
      `💰 Balance: *${bal.toFixed(4)} INJ*\n\n` +
      `Just tell me what to do. /help for commands.`
    );
  }

  const { privateKey, address } = generateWallet();
  db.users[telegramId] = {
    telegram_id: telegramId,
    username: ctx.from.username || "",
    address,
    encrypted_pk: encrypt(privateKey),
    created_at: Date.now(),
  };
  await writeDB(db);

  return ctx.replyWithMarkdown(
    `*INJ Spend Agent activated!*\n\n` +
    `Your INJ wallet:\n\`${address}\`\n\n` +
    `Deposit INJ to this address to get started.\n\n` +
    `Then just type naturally:\n` +
    `_"Send 2 INJ to inj1... every Friday"_\n` +
    `_"Alert me if balance drops below 5 INJ"_\n\n` +
    `/help for all commands.`
  );
});

// /wallet
bot.command("wallet", async (ctx) => {
  const db = await readDB();
  const user = db.users[String(ctx.from.id)];
  if (!user) return ctx.reply("Use /start first.");
  const bal = await getBalance(user.address);
  ctx.replyWithMarkdown(
    `*Your Wallet*\n\nAddress: \`${user.address}\`\nBalance: *${bal.toFixed(4)} INJ*`
  );
});

// /help
bot.command("help", (ctx) => {
  ctx.replyWithMarkdown(
    `*INJ Spend Agent*\n\n` +
    `*Wallet*\n/wallet — address and balance\n/history — transactions\n\n` +
    `*Send*\n_"Send 5 INJ to inj1..."_\n_"Pay inj1... 2 INJ now"_\n\n` +
    `*Schedule*\n_"Send 1 INJ to inj1... every Monday"_\n` +
    `/schedules — list schedules\n/cancelschedule id\n\n` +
    `*Alerts*\n_"Alert me when balance drops below 5 INJ"_\n` +
    `/alerts — list alerts\n/cancelalert id`
  );
});

// /schedules
bot.command("schedules", async (ctx) => {
  const db = await readDB();
  const telegramId = String(ctx.from.id);
  const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
  if (!rows.length) return ctx.reply("No active schedules.");
  const lines = rows.map((r) =>
    `*#${r.id}* ${r.label || "Payment"}\n  ${r.amount_inj} INJ to \`${r.to_address.slice(0, 16)}...\`\n  ${r.cron_expr}`
  );
  ctx.replyWithMarkdown(`*Active Schedules*\n\n${lines.join("\n\n")}`);
});

// /cancelschedule
bot.command("cancelschedule", async (ctx) => {
  const id = parseInt(ctx.message.text.split(" ")[1]);
  if (!id) return ctx.reply("Usage: /cancelschedule id");
  const db = await readDB();
  const telegramId = String(ctx.from.id);
  const s = db.schedules.find((s) => s.id === id && s.telegram_id === telegramId);
  if (!s) return ctx.reply("Schedule not found.");
  s.active = false;
  await writeDB(db);
  ctx.reply(`Schedule #${id} cancelled.`);
});

// /alerts
bot.command("alerts", async (ctx) => {
  const db = await readDB();
  const telegramId = String(ctx.from.id);
  const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
  if (!rows.length) return ctx.reply("No active alerts.");
  const lines = rows.map((r) => `*#${r.id}* Alert when balance drops below *${r.threshold_inj} INJ*`);
  ctx.replyWithMarkdown(`*Active Alerts*\n\n${lines.join("\n")}`);
});

// /cancelalert
bot.command("cancelalert", async (ctx) => {
  const id = parseInt(ctx.message.text.split(" ")[1]);
  if (!id) return ctx.reply("Usage: /cancelalert id");
  const db = await readDB();
  const telegramId = String(ctx.from.id);
  const a = db.alerts.find((a) => a.id === id && a.telegram_id === telegramId);
  if (!a) return ctx.reply("Alert not found.");
  a.active = false;
  await writeDB(db);
  ctx.reply(`Alert #${id} removed.`);
});

// /history
bot.command("history", async (ctx) => {
  const db = await readDB();
  const telegramId = String(ctx.from.id);
  const rows = db.tx_log
    .filter((t) => t.telegram_id === telegramId)
    .slice(-10)
    .reverse();
  if (!rows.length) return ctx.reply("No transactions yet.");
  const lines = rows.map((r) => {
    const date = new Date(r.created_at).toLocaleDateString();
    const status = r.status === "success" ? "OK" : "FAILED";
    return `${status} | ${r.type} | ${r.amount_inj} INJ | ${date}` +
      (r.tx_hash ? `\nhttps://explorer.injective.network/transaction/${r.tx_hash}` : "");
  });
  ctx.reply(`Recent Transactions\n\n${lines.join("\n\n")}`);
});

// Natural language handler
bot.on("text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from.id);
  const db = await readDB();
  const user = db.users[telegramId];

  if (!user) return ctx.reply("Use /start first.");

  await ctx.sendChatAction("typing");
  const intent = await parseIntent(text);

  switch (intent.intent) {

    case "check_balance": {
      const bal = await getBalance(user.address);
      ctx.replyWithMarkdown(`Balance: *${bal.toFixed(4)} INJ*\n\`${user.address}\``);
      break;
    }

    case "send_now": {
      if (!intent.to || !intent.amount) {
        return ctx.reply('Specify address and amount. E.g. "Send 2 INJ to inj1..."');
      }
      if (!intent.to.startsWith("inj1")) {
        return ctx.reply("Invalid address. Must start with inj1");
      }
      const bal = await getBalance(user.address);
      if (bal < intent.amount) {
        return ctx.reply(`Not enough balance. Have ${bal.toFixed(4)} INJ, need ${intent.amount} INJ.`);
      }
      await ctx.reply(`Sending ${intent.amount} INJ...`);
      try {
        const pk = decrypt(user.encrypted_pk);
        const txHash = await sendInj(pk, intent.to, intent.amount);
        db.tx_log.push({
          telegram_id: telegramId, type: "send", to_address: intent.to,
          amount_inj: intent.amount, tx_hash: txHash, status: "success", created_at: Date.now()
        });
        await writeDB(db);
        ctx.reply(
          `Sent ${intent.amount} INJ\nTo: ${intent.to}\nhttps://explorer.injective.network/transaction/${txHash}`
        );
      } catch (e) {
        db.tx_log.push({
          telegram_id: telegramId, type: "send", to_address: intent.to,
          amount_inj: intent.amount, status: "failed", note: e.message, created_at: Date.now()
        });
        await writeDB(db);
        ctx.reply(`Failed: ${e.message}`);
      }
      break;
    }

    case "schedule_send": {
      if (!intent.to || !intent.amount || !intent.cron) {
        return ctx.reply('Need more info. Try: "Send 2 INJ to inj1... every Monday"');
      }
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      if (!cron.validate(intent.cron)) return ctx.reply("Could not parse that schedule.");

      const id = Date.now();
      db.schedules.push({
        id, telegram_id: telegramId, label: intent.label || "Scheduled Payment",
        cron_expr: intent.cron, to_address: intent.to, amount_inj: intent.amount,
        active: true, created_at: Date.now(),
      });
      await writeDB(db);
      registerCronJob(telegramId, id, intent.cron, intent.to, intent.amount, intent.label);
      ctx.reply(
        `Schedule created!\n\n${intent.amount} INJ to ${intent.to.slice(0, 20)}...\n${intent.label || intent.cron}\n\nCancel: /cancelschedule ${id}`
      );
      break;
    }

    case "set_alert": {
      if (!intent.threshold) return ctx.reply('Try: "Alert me when balance drops below 5 INJ"');
      const id = Date.now();
      db.alerts.push({
        id, telegram_id: telegramId, type: "below",
        threshold_inj: intent.threshold, active: true, created_at: Date.now(),
      });
      await writeDB(db);
      ctx.reply(
        `Alert set! You will be notified when balance drops below ${intent.threshold} INJ.\nCancel: /cancelalert ${id}`
      );
      break;
    }

    case "list_schedules": {
      const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
      if (!rows.length) return ctx.reply("No active schedules.");
      const lines = rows.map((r) => `#${r.id} — ${r.label || r.cron_expr} — ${r.amount_inj} INJ`);
      ctx.reply(`Active Schedules\n\n${lines.join("\n")}`);
      break;
    }

    case "list_alerts": {
      const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
      if (!rows.length) return ctx.reply("No active alerts.");
      const lines = rows.map((r) => `#${r.id} — below ${r.threshold_inj} INJ`);
      ctx.reply(`Active Alerts\n\n${lines.join("\n")}`);
      break;
    }

    case "tx_history": {
      const rows = db.tx_log.filter((t) => t.telegram_id === telegramId).slice(-5).reverse();
      if (!rows.length) return ctx.reply("No transactions yet.");
      const lines = rows.map((r) => `${r.status === "success" ? "OK" : "FAILED"} | ${r.amount_inj} INJ | ${new Date(r.created_at).toLocaleDateString()}`);
      ctx.reply(`Recent Transactions\n\n${lines.join("\n")}`);
      break;
    }

    case "help": {
      ctx.reply(
        "Commands:\n\n" +
        "/wallet — address and balance\n" +
        "/schedules — active schedules\n" +
        "/alerts — active alerts\n" +
        "/history — recent transactions\n\n" +
        "Or just type naturally:\n" +
        '"Send 2 INJ to inj1..."\n' +
        '"Pay inj1... 1 INJ every Monday"\n' +
        '"Alert me if balance drops below 5 INJ"'
      );
      break;
    }

    case "cancel_schedule": {
      if (!intent.schedule_id) {
        const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
        if (!rows.length) return ctx.reply("No active schedules.");
        return ctx.reply(rows.map((r) => `#${r.id} — ${r.label}`).join("\n") + "\n\nUse: /cancelschedule id");
      }
      const s = db.schedules.find((s) => s.id === intent.schedule_id && s.telegram_id === telegramId);
      if (!s) return ctx.reply("Schedule not found.");
      s.active = false;
      await writeDB(db);
      ctx.reply("Schedule cancelled.");
      break;
    }

    case "cancel_alert": {
      if (!intent.alert_id) {
        const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
        if (!rows.length) return ctx.reply("No active alerts.");
        return ctx.reply(rows.map((r) => `#${r.id} — below ${r.threshold_inj} INJ`).join("\n") + "\n\nUse: /cancelalert id");
      }
      const a = db.alerts.find((a) => a.id === intent.alert_id && a.telegram_id === telegramId);
      if (!a) return ctx.reply("Alert not found.");
      a.active = false;
      await writeDB(db);
      ctx.reply("Alert removed.");
      break;
    }

    default:
      ctx.reply(
        "I did not understand that. Try:\n\n" +
        '"Send 2 INJ to inj1..."\n' +
        '"Pay inj1... 1 INJ every Monday"\n' +
        '"Alert me if balance drops below 5 INJ"\n' +
        '"What is my balance?"\n\n' +
        "/help for all commands."
      );
  }
});

// ─── Cron jobs ────────────────────────────────────────────────────────────────
const activeCronJobs = {};

function registerCronJob(telegramId, scheduleId, cronExpr, toAddress, amountInj, label) {
  if (!cron.validate(cronExpr)) return;
  const jobKey = `${telegramId}_${scheduleId}`;
  if (activeCronJobs[jobKey]) activeCronJobs[jobKey].stop();

  const task = cron.schedule(cronExpr, async () => {
    const db = await readDB();
    const schedule = db.schedules.find((s) => s.id === scheduleId && s.active);
    if (!schedule) return task.stop();

    const user = db.users[telegramId];
    if (!user) return;

    const bal = await getBalance(user.address);
    if (bal < amountInj) {
      bot.telegram.sendMessage(
        telegramId,
        `Scheduled payment failed: not enough balance. Need ${amountInj} INJ, have ${bal.toFixed(4)} INJ.`
      );
      return;
    }

    try {
      const pk = decrypt(user.encrypted_pk);
      const txHash = await sendInj(pk, toAddress, amountInj);
      schedule.last_run = Date.now();
      db.tx_log.push({
        telegram_id: telegramId, type: "scheduled", to_address: toAddress,
        amount_inj: amountInj, tx_hash: txHash, status: "success", created_at: Date.now()
      });
      await writeDB(db);
      bot.telegram.sendMessage(
        telegramId,
        `Scheduled payment sent!\n${amountInj} INJ\nhttps://explorer.injective.network/transaction/${txHash}`
      );
    } catch (e) {
      db.tx_log.push({
        telegram_id: telegramId, type: "scheduled", to_address: toAddress,
        amount_inj: amountInj, status: "failed", note: e.message, created_at: Date.now()
      });
      await writeDB(db);
      bot.telegram.sendMessage(telegramId, `Scheduled payment failed: ${e.message}`);
    }
  });

  activeCronJobs[jobKey] = task;
}

// Alert polling every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  const db = await readDB();
  const activeAlerts = db.alerts.filter((a) => a.active && a.type === "below");
  for (const alert of activeAlerts) {
    const user = db.users[alert.telegram_id];
    if (!user) continue;
    const bal = await getBalance(user.address);
    if (bal < alert.threshold_inj) {
      bot.telegram.sendMessage(
        alert.telegram_id,
        `Balance Alert! Balance dropped below ${alert.threshold_inj} INJ. Current: ${bal.toFixed(4)} INJ\n\nDeposit to: ${user.address}`
      );
    }
  }
});

// Load schedules on startup
async function loadSchedules() {
  const db = await readDB();
  const active = db.schedules.filter((s) => s.active);
  console.log(`Loading ${active.length} active schedule(s)...`);
  active.forEach((s) => registerCronJob(s.telegram_id, s.id, s.cron_expr, s.to_address, s.amount_inj, s.label));
}

// ─── Launch ───────────────────────────────────────────────────────────────────
loadSchedules();
bot.launch().then(() => console.log("INJ Spend Agent is live!"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
