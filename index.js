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
const bip39 = require("bip39");

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
  return json.record || { users: {}, schedules: [], alerts: [], tx_log: [], one_time_sends: [] };
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

function hashPin(pin) {
  return crypto.createHash("sha256").update(pin + ENCRYPTION_KEY).digest("hex");
}

// ─── Wallet ───────────────────────────────────────────────────────────────────
function generateWallet() {
  const walletMnemonic = bip39.generateMnemonic();
  const seed = bip39.mnemonicToSeedSync(walletMnemonic);
  const walletPk = seed.slice(0, 32).toString("hex");
  const pk = PrivateKey.fromHex(walletPk);
  return {
    privateKey: walletPk,
    mnemonic: walletMnemonic,
    address: pk.toPublicKey().toAddress().toBech32(),
  };
}

function walletFromMnemonic(inputMnemonic) {
  if (!bip39.validateMnemonic(inputMnemonic)) throw new Error("Invalid seed phrase");
  const seed = bip39.mnemonicToSeedSync(inputMnemonic);
  const walletPk = seed.slice(0, 32).toString("hex");
  const pk = PrivateKey.fromHex(walletPk);
  return {
    privateKey: walletPk,
    address: pk.toPublicKey().toAddress().toBech32(),
  };
}

function walletFromPrivateKey(pkHex) {
  const cleaned = pkHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) throw new Error("Invalid private key. Must be a 64-character hex string.");
  const pk = PrivateKey.fromHex(cleaned);
  return {
    privateKey: cleaned,
    address: pk.toPublicKey().toAddress().toBech32(),
  };
}

// ─── Injective ────────────────────────────────────────────────────────────────
const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc);

async function getBalance(address) {
  try {
    const bal = await bankApi.fetchBalance({ accountAddress: address, denom: INJ_DENOM });
    return parseFloat(bal.amount) / 1e18;
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
3. one_time_send  -> { "intent": "one_time_send", "to": "<inj address>", "amount": <number>, "send_at": "<ISO datetime string>" }
4. set_alert      -> { "intent": "set_alert", "type": "below", "threshold": <number> }
5. check_balance  -> { "intent": "check_balance" }
6. list_schedules -> { "intent": "list_schedules" }
7. cancel_schedule-> { "intent": "cancel_schedule", "schedule_id": <number or null> }
8. list_alerts    -> { "intent": "list_alerts" }
9. cancel_alert   -> { "intent": "cancel_alert", "alert_id": <number or null> }
10. tx_history    -> { "intent": "tx_history" }
11. help          -> { "intent": "help" }
12. unknown       -> { "intent": "unknown" }

Cron mappings:
- "every day at 9am"       -> "0 9 * * *"
- "every Monday"           -> "0 9 * * 1"
- "every Friday at 6pm"    -> "0 18 * * 5"
- "every 1st of the month" -> "0 9 1 * *"

IMPORTANT RULES:
- Amount is always a number in INJ. "2000 inj", "2000 INJ", "2,000 INJ" all mean amount: 2000
- INJ addresses start with "inj1"
- If user says "in X minutes/hours" or "at 9am tomorrow" or "tonight" = one_time_send, calculate send_at from current time
- Only use schedule_send for clearly recurring patterns (every day, every week, every month)
- Never return unknown for send, alert, or balance requests — always try to parse them`;

async function parseIntent(userMessage) {
  try {
    const now = new Date().toISOString();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Current time: ${now}\n\nUser message: ${userMessage}` }],
    });
    const raw = response.content[0].text.trim();
    console.log("AI INTENT:", raw);
    return JSON.parse(raw);
  } catch (e) {
    console.log("PARSE ERROR:", e.message);
    return { intent: "unknown" };
  }
}

// ─── PIN state (in-memory) ────────────────────────────────────────────────────
// Tracks pending PIN actions per user
// { telegramId: { action: "set_pin"|"verify_pin", pendingAction: {...} } }
const pinState = {};

// ─── Inline keyboard ──────────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🏦 Wallet", callback_data: "wallet" },
        { text: "💰 Balance", callback_data: "balance" },
      ],
      [
        { text: "📅 Schedules", callback_data: "schedules" },
        { text: "🔔 Alerts", callback_data: "alerts" },
      ],
      [
        { text: "📋 History", callback_data: "history" },
        { text: "🔑 Private Key", callback_data: "seedphrase" },
      ],
      [
        { text: "📥 Import Wallet", callback_data: "import" },
        { text: "🔐 Set PIN", callback_data: "setpin" },
      ],
    ],
  },
};

// ─── PIN helpers ──────────────────────────────────────────────────────────────
function requiresPin(user) {
  return user && user.pin_hash;
}

async function verifyPinThen(ctx, user, action) {
  const telegramId = String(ctx.from.id);
  if (!requiresPin(user)) {
    return action();
  }
  pinState[telegramId] = { action: "verify_pin", pendingAction: action };
  ctx.reply("🔐 Enter your PIN to continue:");
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
      `💰 Balance: *${bal.toFixed(4)} INJ*\n` +
      `🔐 PIN: ${user.pin_hash ? "Enabled ✅" : "Not set"}\n\n` +
      `What would you like to do?`,
      MAIN_MENU
    );
  }

  const newWallet = generateWallet();
  db.users[telegramId] = {
    telegram_id: telegramId,
    username: ctx.from.username || "",
    address: newWallet.address,
    encrypted_pk: encrypt(newWallet.privateKey),
    pin_hash: null,
    created_at: Date.now(),
  };
  await writeDB(db);

  await ctx.replyWithMarkdown(
    `⚡ *INJ Spend Agent activated!*\n\n` +
    `Your INJ wallet:\n\`${newWallet.address}\`\n\n` +
    `Deposit INJ to this address to get started.\n\n` +
    `Then just type naturally or use the menu below:`,
    MAIN_MENU
  );

  return ctx.replyWithMarkdown(
    `🔑 *Your Seed Phrase*\n\n` +
    `\`${newWallet.mnemonic}\`\n\n` +
    `⚠️ *Save these 12 words somewhere safe and delete this message.*\n` +
    `Anyone with this phrase can access your wallet.\n` +
    `The bot does NOT store your seed phrase.`
  );
});

// /help
bot.command("help", (ctx) => {
  ctx.replyWithMarkdown(`⚡ *InjiPay — INJ Spend Agent*\nChoose an option:`, MAIN_MENU);
});

// /setpin
bot.command("setpin", async (ctx) => {
  const telegramId = String(ctx.from.id);
  pinState[telegramId] = { action: "set_pin" };
  ctx.reply("🔐 Choose a 4-6 digit PIN.\n\nType your new PIN now:");
});

// /removepin
bot.command("removepin", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const db = await readDB();
  const user = db.users[telegramId];
  if (!user) return ctx.reply("Use /start first.");
  if (!user.pin_hash) return ctx.reply("You don't have a PIN set.");

  pinState[telegramId] = { action: "verify_pin", pendingAction: async () => {
    const db2 = await readDB();
    db2.users[telegramId].pin_hash = null;
    await writeDB(db2);
    ctx.reply("✅ PIN removed successfully.");
  }};
  ctx.reply("🔐 Enter your current PIN to remove it:");
});

// /import (seed phrase)
bot.command("import", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const parts = ctx.message.text.split(" ");
  parts.shift();
  const inputMnemonic = parts.join(" ").trim();

  if (!inputMnemonic || parts.length < 12) {
    return ctx.reply(
      "Send your 12-word seed phrase like this:\n\n/import word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12"
    );
  }

  try {
    const imported = walletFromMnemonic(inputMnemonic);
    const db = await readDB();
    const existingPin = db.users[telegramId]?.pin_hash || null;
    db.users[telegramId] = {
      telegram_id: telegramId,
      username: ctx.from.username || "",
      address: imported.address,
      encrypted_pk: encrypt(imported.privateKey),
      pin_hash: existingPin,
      created_at: Date.now(),
    };
    await writeDB(db);
    ctx.replyWithMarkdown(
      `✅ *Wallet Imported via Seed Phrase!*\n\n` +
      `Address: \`${imported.address}\`\n\n` +
      `⚠️ *Delete your seed phrase message immediately for security.*`,
      MAIN_MENU
    );
  } catch (e) {
    ctx.reply(`Failed to import: ${e.message}`);
  }
});

// /importpk (private key)
bot.command("importpk", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const parts = ctx.message.text.split(" ");
  parts.shift();
  const pkHex = parts.join("").trim();

  if (!pkHex) {
    return ctx.reply(
      "Send your private key like this:\n\n/importpk your64characterhexkeyhere"
    );
  }

  try {
    const imported = walletFromPrivateKey(pkHex);
    const db = await readDB();
    const existingPin = db.users[telegramId]?.pin_hash || null;
    db.users[telegramId] = {
      telegram_id: telegramId,
      username: ctx.from.username || "",
      address: imported.address,
      encrypted_pk: encrypt(imported.privateKey),
      pin_hash: existingPin,
      created_at: Date.now(),
    };
    await writeDB(db);
    ctx.replyWithMarkdown(
      `✅ *Wallet Imported via Private Key!*\n\n` +
      `Address: \`${imported.address}\`\n\n` +
      `⚠️ *Delete your private key message immediately for security.*`,
      MAIN_MENU
    );
  } catch (e) {
    ctx.reply(`Failed to import: ${e.message}`);
  }
});

// /wallet
bot.command("wallet", async (ctx) => {
  const db = await readDB();
  const user = db.users[String(ctx.from.id)];
  if (!user) return ctx.reply("Use /start first.");
  const bal = await getBalance(user.address);
  ctx.replyWithMarkdown(
    `🏦 *Your Wallet*\n\nAddress: \`${user.address}\`\nBalance: *${bal.toFixed(4)} INJ*`
  );
});

// /seedphrase (shows private key, PIN protected)
bot.command("seedphrase", async (ctx) => {
  const db = await readDB();
  const user = db.users[String(ctx.from.id)];
  if (!user) return ctx.reply("Use /start first.");

  await verifyPinThen(ctx, user, async () => {
    ctx.replyWithMarkdown(
      `🔑 *Your Private Key*\n\n\`${decrypt(user.encrypted_pk)}\`\n\n` +
      `⚠️ *Delete this message immediately after saving.*\n` +
      `Never share this with anyone.`
    );
  });
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
  ctx.replyWithMarkdown(`📅 *Active Schedules*\n\n${lines.join("\n\n")}`);
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
  ctx.replyWithMarkdown(`🔔 *Active Alerts*\n\n${lines.join("\n")}`);
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

// ─── Button callbacks ─────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  const action = ctx.callbackQuery.data;
  const telegramId = String(ctx.from.id);
  const db = await readDB();
  const user = db.users[telegramId];

  await ctx.answerCbQuery();

  if (action === "wallet" || action === "balance") {
    if (!user) return ctx.reply("Use /start first.");
    const bal = await getBalance(user.address);
    ctx.replyWithMarkdown(
      `🏦 *Your Wallet*\n\nAddress: \`${user.address}\`\nBalance: *${bal.toFixed(4)} INJ*`
    );
  } else if (action === "schedules") {
    const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
    if (!rows.length) return ctx.reply("No active schedules.");
    const lines = rows.map((r) => `*#${r.id}* ${r.label || r.cron_expr} — ${r.amount_inj} INJ`);
    ctx.replyWithMarkdown(`📅 *Active Schedules*\n\n${lines.join("\n")}`);
  } else if (action === "alerts") {
    const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
    if (!rows.length) return ctx.reply("No active alerts.");
    const lines = rows.map((r) => `*#${r.id}* below ${r.threshold_inj} INJ`);
    ctx.replyWithMarkdown(`🔔 *Active Alerts*\n\n${lines.join("\n")}`);
  } else if (action === "history") {
    const rows = db.tx_log.filter((t) => t.telegram_id === telegramId).slice(-5).reverse();
    if (!rows.length) return ctx.reply("No transactions yet.");
    const lines = rows.map((r) =>
      `${r.status === "success" ? "OK" : "FAILED"} | ${r.amount_inj} INJ | ${new Date(r.created_at).toLocaleDateString()}`
    );
    ctx.reply(`Recent Transactions\n\n${lines.join("\n")}`);
  } else if (action === "seedphrase") {
    if (!user) return ctx.reply("Use /start first.");
    await verifyPinThen(ctx, user, async () => {
      ctx.replyWithMarkdown(
        `🔑 *Your Private Key*\n\n\`${decrypt(user.encrypted_pk)}\`\n\n` +
        `⚠️ *Delete this message immediately after saving.*`
      );
    });
  } else if (action === "import") {
    ctx.reply(
      "To import a wallet, use one of these commands:\n\n" +
      "*Seed phrase (12 words):*\n/import word1 word2 ... word12\n\n" +
      "*Private key (hex):*\n/importpk your64charhexkey",
      { parse_mode: "Markdown" }
    );
  } else if (action === "setpin") {
    pinState[telegramId] = { action: "set_pin" };
    ctx.reply("🔐 Choose a 4-6 digit PIN.\n\nType your new PIN now:");
  }
});

// ─── Natural language + PIN handler ──────────────────────────────────────────
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from.id);

  // ── PIN flow ────────────────────────────────────────────────────────────────
  if (pinState[telegramId]) {
    const state = pinState[telegramId];

    if (state.action === "set_pin") {
      if (!/^\d{4,6}$/.test(text)) {
        return ctx.reply("PIN must be 4-6 digits. Try again:");
      }
      const db = await readDB();
      if (!db.users[telegramId]) return ctx.reply("Use /start first.");
      db.users[telegramId].pin_hash = hashPin(text);
      await writeDB(db);
      delete pinState[telegramId];
      return ctx.reply("✅ PIN set successfully! You'll need it for sensitive actions.");
    }

    if (state.action === "verify_pin") {
      const db = await readDB();
      const user = db.users[telegramId];
      if (!user) return ctx.reply("Use /start first.");

      if (hashPin(text) === user.pin_hash) {
        delete pinState[telegramId];
        return state.pendingAction();
      } else {
        delete pinState[telegramId];
        return ctx.reply("❌ Wrong PIN. Action cancelled.");
      }
    }
  }

  // ── Normal message ──────────────────────────────────────────────────────────
  const db = await readDB();
  const user = db.users[telegramId];
  if (!user) return ctx.reply("Use /start first.");

  await ctx.sendChatAction("typing");
  const intent = await parseIntent(text);

  switch (intent.intent) {

    case "check_balance": {
      const bal = await getBalance(user.address);
      ctx.replyWithMarkdown(`💰 Balance: *${bal.toFixed(4)} INJ*\n\`${user.address}\``);
      break;
    }

    case "send_now": {
      if (!intent.to || !intent.amount) {
        return ctx.reply('Specify address and amount. E.g. "Send 2 INJ to inj1..."');
      }
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address. Must start with inj1");
      const bal = await getBalance(user.address);
      if (bal < intent.amount) {
        return ctx.reply(`Not enough balance. Have ${bal.toFixed(4)} INJ, need ${intent.amount} INJ.`);
      }

      await verifyPinThen(ctx, user, async () => {
        await ctx.reply(`Sending ${intent.amount} INJ...`);
        try {
          const pk = decrypt(user.encrypted_pk);
          const txHash = await sendInj(pk, intent.to, intent.amount);
          const db2 = await readDB();
          db2.tx_log.push({
            telegram_id: telegramId, type: "send", to_address: intent.to,
            amount_inj: intent.amount, tx_hash: txHash, status: "success", created_at: Date.now()
          });
          await writeDB(db2);
          ctx.reply(`✅ Sent ${intent.amount} INJ\nTo: ${intent.to}\nhttps://explorer.injective.network/transaction/${txHash}`);
        } catch (e) {
          const db2 = await readDB();
          db2.tx_log.push({
            telegram_id: telegramId, type: "send", to_address: intent.to,
            amount_inj: intent.amount, status: "failed", note: e.message, created_at: Date.now()
          });
          await writeDB(db2);
          ctx.reply(`❌ Failed: ${e.message}`);
        }
      });
      break;
    }

    case "one_time_send": {
      if (!intent.to || !intent.amount || !intent.send_at) {
        return ctx.reply('Try: "Send 2 INJ to inj1... at 9am tomorrow"');
      }
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      const sendAt = new Date(intent.send_at);
      if (isNaN(sendAt.getTime())) return ctx.reply("Could not understand that time.");

      const jobId = Date.now();
      if (!db.one_time_sends) db.one_time_sends = [];
      db.one_time_sends.push({
        id: jobId, telegram_id: telegramId, to_address: intent.to,
        amount_inj: intent.amount, send_at: sendAt.toISOString(),
        active: true, created_at: Date.now(),
      });
      await writeDB(db);
      ctx.reply(
        `✅ One-time send scheduled!\n\n${intent.amount} INJ to ${intent.to.slice(0, 20)}...\nSends at: ${sendAt.toLocaleString()}\n\nThe agent will execute this automatically.`
      );
      break;
    }

    case "schedule_send": {
      if (!intent.to || !intent.amount || !intent.cron) {
        return ctx.reply('Need more info. Try: "Send 2 INJ to inj1... every Monday"');
      }
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      if (!cron.validate(intent.cron)) return ctx.reply("Could not parse that schedule.");

      const schedId = Date.now();
      db.schedules.push({
        id: schedId, telegram_id: telegramId, label: intent.label || "Scheduled Payment",
        cron_expr: intent.cron, to_address: intent.to, amount_inj: intent.amount,
        active: true, created_at: Date.now(),
      });
      await writeDB(db);
      registerCronJob(telegramId, schedId, intent.cron, intent.to, intent.amount, intent.label);
      ctx.reply(`✅ Schedule created!\n\n${intent.amount} INJ to ${intent.to.slice(0, 20)}...\n${intent.label || intent.cron}\n\nCancel: /cancelschedule ${schedId}`);
      break;
    }

    case "set_alert": {
      if (!intent.threshold) return ctx.reply('Try: "Alert me when balance drops below 5 INJ"');
      const alertId = Date.now();
      db.alerts.push({
        id: alertId, telegram_id: telegramId, type: "below",
        threshold_inj: intent.threshold, active: true, created_at: Date.now(),
      });
      await writeDB(db);
      ctx.reply(`✅ Alert set! Notify when balance drops below ${intent.threshold} INJ.\nCancel: /cancelalert ${alertId}`);
      break;
    }

    case "list_schedules": {
      const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
      if (!rows.length) return ctx.reply("No active schedules.");
      ctx.reply(`Active Schedules\n\n${rows.map((r) => `#${r.id} — ${r.label || r.cron_expr} — ${r.amount_inj} INJ`).join("\n")}`);
      break;
    }

    case "list_alerts": {
      const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
      if (!rows.length) return ctx.reply("No active alerts.");
      ctx.reply(`Active Alerts\n\n${rows.map((r) => `#${r.id} — below ${r.threshold_inj} INJ`).join("\n")}`);
      break;
    }

    case "tx_history": {
      const rows = db.tx_log.filter((t) => t.telegram_id === telegramId).slice(-5).reverse();
      if (!rows.length) return ctx.reply("No transactions yet.");
      ctx.reply(`Recent Transactions\n\n${rows.map((r) => `${r.status === "success" ? "OK" : "FAILED"} | ${r.amount_inj} INJ | ${new Date(r.created_at).toLocaleDateString()}`).join("\n")}`);
      break;
    }

    case "help": {
      ctx.replyWithMarkdown(`⚡ *InjiPay*\nChoose an option:`, MAIN_MENU);
      break;
    }

    case "cancel_schedule": {
      if (!intent.schedule_id) {
        const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
        if (!rows.length) return ctx.reply("No active schedules.");
        return ctx.reply(rows.map((r) => `#${r.id} — ${r.label}`).join("\n") + "\n\nUse: /cancelschedule id");
      }
      const sc = db.schedules.find((s) => s.id === intent.schedule_id && s.telegram_id === telegramId);
      if (!sc) return ctx.reply("Schedule not found.");
      sc.active = false;
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
      const al = db.alerts.find((a) => a.id === intent.alert_id && a.telegram_id === telegramId);
      if (!al) return ctx.reply("Alert not found.");
      al.active = false;
      await writeDB(db);
      ctx.reply("Alert removed.");
      break;
    }

    default:
      ctx.replyWithMarkdown(
        `I did not understand that. Try:\n\n` +
        `"Send 2 INJ to inj1..."\n` +
        `"Pay inj1... 1 INJ every Monday"\n` +
        `"Alert me if balance drops below 5 INJ"\n\n` +
        `Or use the menu:`,
        MAIN_MENU
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
      bot.telegram.sendMessage(telegramId, `⚠️ Scheduled payment failed: not enough balance. Need ${amountInj} INJ, have ${bal.toFixed(4)} INJ.`);
      return;
    }
    try {
      const pk = decrypt(user.encrypted_pk);
      const txHash = await sendInj(pk, toAddress, amountInj);
      schedule.last_run = Date.now();
      db.tx_log.push({ telegram_id: telegramId, type: "scheduled", to_address: toAddress, amount_inj: amountInj, tx_hash: txHash, status: "success", created_at: Date.now() });
      await writeDB(db);
      bot.telegram.sendMessage(telegramId, `✅ Scheduled payment sent!\n${amountInj} INJ\nhttps://explorer.injective.network/transaction/${txHash}`);
    } catch (e) {
      db.tx_log.push({ telegram_id: telegramId, type: "scheduled", to_address: toAddress, amount_inj: amountInj, status: "failed", note: e.message, created_at: Date.now() });
      await writeDB(db);
      bot.telegram.sendMessage(telegramId, `❌ Scheduled payment failed: ${e.message}`);
    }
  });
  activeCronJobs[jobKey] = task;
}

// One-time send polling every minute
cron.schedule("* * * * *", async () => {
  const db = await readDB();
  const now = Date.now();
  const pending = (db.one_time_sends || []).filter((s) => s.active && new Date(s.send_at).getTime() <= now);
  for (const job of pending) {
    const user = db.users[job.telegram_id];
    if (!user) { job.active = false; continue; }
    const bal = await getBalance(user.address);
    if (bal < job.amount_inj) {
      bot.telegram.sendMessage(job.telegram_id, `⚠️ One-time send failed: not enough balance. Need ${job.amount_inj} INJ, have ${bal.toFixed(4)} INJ.`);
      job.active = false;
      continue;
    }
    try {
      const pk = decrypt(user.encrypted_pk);
      const txHash = await sendInj(pk, job.to_address, job.amount_inj);
      job.active = false;
      db.tx_log.push({ telegram_id: job.telegram_id, type: "one-time", to_address: job.to_address, amount_inj: job.amount_inj, tx_hash: txHash, status: "success", created_at: Date.now() });
      bot.telegram.sendMessage(job.telegram_id, `✅ One-time send executed!\n${job.amount_inj} INJ\nhttps://explorer.injective.network/transaction/${txHash}`);
    } catch (e) {
      job.active = false;
      db.tx_log.push({ telegram_id: job.telegram_id, type: "one-time", to_address: job.to_address, amount_inj: job.amount_inj, status: "failed", note: e.message, created_at: Date.now() });
      bot.telegram.sendMessage(job.telegram_id, `❌ One-time send failed: ${e.message}`);
    }
  }
  if (pending.length > 0) await writeDB(db);
});

// Alert polling every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  const db = await readDB();
  const activeAlerts = db.alerts.filter((a) => a.active && a.type === "below");
  for (const alert of activeAlerts) {
    const user = db.users[alert.telegram_id];
    if (!user) continue;
    const bal = await getBalance(user.address);
    if (bal < alert.threshold_inj) {
      bot.telegram.sendMessage(alert.telegram_id, `🚨 Balance Alert! Dropped below ${alert.threshold_inj} INJ. Current: ${bal.toFixed(4)} INJ\n\nDeposit to: ${user.address}`);
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
