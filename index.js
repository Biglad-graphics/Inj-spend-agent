// ============================================================
// InjiPay — Autonomous INJ Spend Agent
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
const { registerP2PHandlers, registerP2PConfirmHandlers, handleP2PText } = require("./p2p");
const { registerAlertPoller } = require("./alerts");

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
const MAX_WALLETS = 5;

if (!BOT_TOKEN || !ANTHROPIC_API_KEY || !ENCRYPTION_KEY || !JSONBIN_KEY || !JSONBIN_BIN_ID) {
  console.error("Missing env vars.");
  process.exit(1);
}

// ─── JSONbin ──────────────────────────────────────────────────────────────────
async function readDB() {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { "X-Master-Key": JSONBIN_KEY },
  });
  const json = await res.json();
  return json.record || { users: {}, schedules: [], alerts: [], tx_log: [], one_time_sends: [], p2p_trades: [] };
}

async function writeDB(data) {
  await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Master-Key": JSONBIN_KEY },
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

// ─── Wallet helpers ───────────────────────────────────────────────────────────
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
  return { privateKey: walletPk, address: pk.toPublicKey().toAddress().toBech32() };
}

function walletFromPrivateKey(pkHex) {
  const cleaned = pkHex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) throw new Error("Invalid private key. Must be 64-character hex.");
  const pk = PrivateKey.fromHex(cleaned);
  return { privateKey: cleaned, address: pk.toPublicKey().toAddress().toBech32() };
}

// ─── User helpers ─────────────────────────────────────────────────────────────
function getActiveWallet(user) {
  if (!user.wallets || user.wallets.length === 0) return null;
  return user.wallets.find((w) => w.active) || user.wallets[0];
}

function migrateUser(user) {
  if (!user.wallets) {
    user.wallets = [{
      id: Date.now(),
      name: "Wallet 1",
      address: user.address,
      encrypted_pk: user.encrypted_pk,
      active: true,
    }];
    delete user.address;
    delete user.encrypted_pk;
  }
  return user;
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
  const broadcaster = new MsgBroadcasterWithPk({ privateKey: fromPkHex, network: NETWORK });
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
- Amount is always a number in INJ. "2000 inj", "2000 INJ" all mean amount: 2000
- INJ addresses start with "inj1"
- If user says "in X minutes/hours" or "at 9am tomorrow" = one_time_send, calculate send_at from current time
- Only use schedule_send for clearly recurring patterns
- Never return unknown for send, alert, or balance requests`;

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

// ─── PIN state ────────────────────────────────────────────────────────────────
const pinState = {};
const namingState = {};

// ─── Menus ────────────────────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "💼 My Wallets", callback_data: "my_wallets" },
        { text: "➕ Add Wallet", callback_data: "add_wallet" },
      ],
      [
        { text: "📅 Schedules", callback_data: "schedules" },
        { text: "🔔 Alerts",    callback_data: "alerts"    },
      ],
      [
        { text: "📋 History",   callback_data: "history" },
        { text: "🔐 Set PIN",   callback_data: "setpin"  },
      ],
      [
        { text: "💱 Sell INJ", callback_data: "p2p_sell" },
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
  if (!requiresPin(user)) return action();
  pinState[telegramId] = { action: "verify_pin", pendingAction: action };
  ctx.reply("🔐 Enter your PIN to continue:");
}

// ─── Show wallets ─────────────────────────────────────────────────────────────
async function showWallets(ctx, db, telegramId) {
  const user = db.users[telegramId];
  if (!user || !user.wallets || user.wallets.length === 0) {
    return ctx.reply("No wallets found. Use /start to create one.");
  }

  for (const w of user.wallets) {
    const bal = await getBalance(w.address);
    const activeLabel = w.active ? " ✅ Active" : "";
    await ctx.replyWithMarkdown(
      `💼 *${w.name}*${activeLabel}\n\`${w.address}\`\nBalance: *${bal.toFixed(4)} INJ*`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "🔄 Switch", callback_data: `switch_wallet_${w.id}` },
            { text: "🔑 Key",    callback_data: `wallet_key_${w.id}`    },
            { text: "🗑️ Delete", callback_data: `delete_wallet_${w.id}` },
          ]],
        },
      }
    );
  }
}

// ─── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Register P2P handlers
registerP2PHandlers(bot, { readDB, writeDB, getActiveWallet, decrypt, sendInj });
registerP2PConfirmHandlers(bot);

// /start
bot.start(async (ctx) => {
  const telegramId = String(ctx.from.id);
  const db = await readDB();

  if (db.users[telegramId]) {
    let user = migrateUser(db.users[telegramId]);
    db.users[telegramId] = user;
    await writeDB(db);

    const active = getActiveWallet(user);
    const bal = active ? await getBalance(active.address) : 0;
    return ctx.replyWithMarkdown(
      `👋 Welcome back *${ctx.from.first_name}*!\n\n` +
      `💼 Active: *${active ? active.name : "None"}*\n` +
      `🏦 \`${active ? active.address : "No wallet"}\`\n` +
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
    wallets: [{
      id: Date.now(),
      name: "Wallet 1",
      address: newWallet.address,
      encrypted_pk: encrypt(newWallet.privateKey),
      active: true,
    }],
    pin_hash: null,
    created_at: Date.now(),
  };
  await writeDB(db);

  await ctx.replyWithMarkdown(
    `⚡ *InjiPay activated!*\n\n` +
    `Your first INJ wallet:\n\`${newWallet.address}\`\n\n` +
    `Deposit INJ to get started. You can add up to ${MAX_WALLETS} wallets.\n\n` +
    `Type naturally or use the menu:`,
    MAIN_MENU
  );

  return ctx.replyWithMarkdown(
    `🔑 *Seed Phrase for Wallet 1*\n\n\`${newWallet.mnemonic}\`\n\n` +
    `⚠️ *Save these 12 words and delete this message.*\n` +
    `The bot does NOT store your seed phrase.`
  );
});

// /help
bot.command("help", (ctx) => {
  ctx.replyWithMarkdown(`⚡ *InjiPay — INJ Spend Agent*\nChoose an option:`, MAIN_MENU);
});

// /wallets
bot.command("wallets", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const db = await readDB();
  if (!db.users[telegramId]) return ctx.reply("Use /start first.");
  await showWallets(ctx, db, telegramId);
});

// /addwallet
bot.command("addwallet", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const db = await readDB();
  const user = db.users[telegramId];
  if (!user) return ctx.reply("Use /start first.");
  if (user.wallets && user.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`You can only have up to ${MAX_WALLETS} wallets.`);
  }
  namingState[telegramId] = { action: "name_new_wallet", type: "generate" };
  ctx.reply("What would you like to name this wallet?\n\nE.g. Savings, Trading, Main");
});

// /import
bot.command("import", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const parts = ctx.message.text.split(" ");
  parts.shift();
  const inputMnemonic = parts.join(" ").trim();
  if (!inputMnemonic || parts.length < 12) {
    return ctx.reply("Usage:\n/import word1 word2 ... word12");
  }
  try {
    const imported = walletFromMnemonic(inputMnemonic);
    const db = await readDB();
    const user = db.users[telegramId];
    if (!user) return ctx.reply("Use /start first.");
    if (user.wallets && user.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`Max ${MAX_WALLETS} wallets reached. Delete one first.`);
    }
    namingState[telegramId] = { action: "name_new_wallet", type: "import", imported };
    ctx.reply("Wallet found! What would you like to name it?\n\nE.g. My Ledger, DeFi Wallet");
  } catch (e) {
    ctx.reply(`Failed: ${e.message}`);
  }
});

// /importpk
bot.command("importpk", async (ctx) => {
  const telegramId = String(ctx.from.id);
  const parts = ctx.message.text.split(" ");
  parts.shift();
  const pkHex = parts.join("").trim();
  if (!pkHex) return ctx.reply("Usage:\n/importpk your64charhexkey");
  try {
    const imported = walletFromPrivateKey(pkHex);
    const db = await readDB();
    const user = db.users[telegramId];
    if (!user) return ctx.reply("Use /start first.");
    if (user.wallets && user.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`Max ${MAX_WALLETS} wallets reached. Delete one first.`);
    }
    namingState[telegramId] = { action: "name_new_wallet", type: "import", imported };
    ctx.reply("Wallet found! What would you like to name it?\n\nE.g. My Ledger, DeFi Wallet");
  } catch (e) {
    ctx.reply(`Failed: ${e.message}`);
  }
});

// /setpin
bot.command("setpin", async (ctx) => {
  const telegramId = String(ctx.from.id);
  pinState[telegramId] = { action: "set_pin" };
  ctx.reply("🔐 Choose a 4-6 digit PIN:");
});

// ─── Callback handler ─────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.callbackQuery.data;
  const telegramId = String(ctx.from.id);
  const db = await readDB();
  const user = db.users[telegramId] ? migrateUser(db.users[telegramId]) : null;

  if (action === "my_wallets") {
    if (!user) return ctx.reply("Use /start first.");
    await showWallets(ctx, db, telegramId);

  } else if (action === "add_wallet") {
    if (!user) return ctx.reply("Use /start first.");
    if (user.wallets && user.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`You can only have up to ${MAX_WALLETS} wallets.`);
    }
    namingState[telegramId] = { action: "name_new_wallet", type: "generate" };
    ctx.reply("What would you like to name this wallet?\n\nE.g. Savings, Trading, Main");

  } else if (action.startsWith("switch_wallet_")) {
    const wId = parseInt(action.replace("switch_wallet_", ""));
    if (!user) return ctx.reply("Use /start first.");
    user.wallets.forEach((w) => w.active = false);
    const switched = user.wallets.find((w) => w.id === wId);
    if (!switched) return ctx.reply("Wallet not found.");
    switched.active = true;
    db.users[telegramId] = user;
    await writeDB(db);
    ctx.reply(`✅ Switched to *${switched.name}*`, { parse_mode: "Markdown" });

  } else if (action.startsWith("wallet_key_")) {
    const wId = parseInt(action.replace("wallet_key_", ""));
    if (!user) return ctx.reply("Use /start first.");
    const w = user.wallets.find((w) => w.id === wId);
    if (!w) return ctx.reply("Wallet not found.");
    await verifyPinThen(ctx, user, async () => {
      ctx.replyWithMarkdown(
        `🔑 *Private Key — ${w.name}*\n\n\`${decrypt(w.encrypted_pk)}\`\n\n` +
        `⚠️ Delete this message immediately after saving.`
      );
    });

  } else if (action.startsWith("delete_wallet_")) {
    const wId = parseInt(action.replace("delete_wallet_", ""));
    if (!user) return ctx.reply("Use /start first.");
    if (user.wallets.length === 1) return ctx.reply("You must have at least one wallet.");
    const w = user.wallets.find((w) => w.id === wId);
    if (!w) return ctx.reply("Wallet not found.");
    await verifyPinThen(ctx, user, async () => {
      const db2 = await readDB();
      let u = db2.users[telegramId];
      u.wallets = u.wallets.filter((w) => w.id !== wId);
      if (!u.wallets.find((w) => w.active)) u.wallets[0].active = true;
      db2.users[telegramId] = u;
      await writeDB(db2);
      ctx.reply(`🗑️ *${w.name}* deleted. ${u.wallets.find((w) => w.active).name} is now active.`, { parse_mode: "Markdown" });
    });

  } else if (action.startsWith("cancel_sched_")) {
    const id = parseInt(action.replace("cancel_sched_", ""));
    const s = db.schedules.find((s) => s.id === id && s.telegram_id === telegramId);
    if (!s) return ctx.reply("Schedule not found.");
    s.active = false;
    await writeDB(db);
    ctx.reply(`✅ Schedule #${id} cancelled.`);

  } else if (action.startsWith("cancel_alert_")) {
    const id = parseInt(action.replace("cancel_alert_", ""));
    const a = db.alerts.find((a) => a.id === id && a.telegram_id === telegramId);
    if (!a) return ctx.reply("Alert not found.");
    a.active = false;
    await writeDB(db);
    ctx.reply(`✅ Alert #${id} removed.`);

  } else if (action === "schedules") {
    const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
    if (!rows.length) return ctx.reply("No active schedules.");
    for (const r of rows) {
      await ctx.replyWithMarkdown(
        `📅 *#${r.id}* ${r.label || "Payment"}\n${r.amount_inj} INJ to \`${r.to_address.slice(0, 20)}...\`\n⏰ ${r.cron_expr}`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `cancel_sched_${r.id}` }]] } }
      );
    }

  } else if (action === "alerts") {
    const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
    if (!rows.length) return ctx.reply("No active alerts.");
    for (const r of rows) {
      await ctx.replyWithMarkdown(
        `🔔 *Alert #${r.id}*\nNotify when balance drops below *${r.threshold_inj} INJ*`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Alert", callback_data: `cancel_alert_${r.id}` }]] } }
      );
    }

  } else if (action === "history") {
    const rows = db.tx_log.filter((t) => t.telegram_id === telegramId).slice(-5).reverse();
    if (!rows.length) return ctx.reply("No transactions yet.");
    const lines = rows.map((r) =>
      `${r.status === "success" ? "✅" : "❌"} ${r.amount_inj} INJ | ${new Date(r.created_at).toLocaleDateString()}`
    );
    ctx.reply(`Recent Transactions\n\n${lines.join("\n")}`);

  } else if (action === "setpin") {
    pinState[telegramId] = { action: "set_pin" };
    ctx.reply("🔐 Choose a 4-6 digit PIN:");

  } else if (action === "import") {
    ctx.reply(
      "To import a wallet:\n\n*Seed phrase:*\n/import word1 word2 ... word12\n\n*Private key:*\n/importpk your64charhexkey",
      { parse_mode: "Markdown" }
    );
  }
});

// ─── Natural language + PIN + naming handler ──────────────────────────────────
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  const telegramId = String(ctx.from.id);

  // ── P2P flow (must be first) ─────────────────────────────────────────────────
  const p2pHandled = await handleP2PText(ctx, { readDB, writeDB, getActiveWallet, decrypt, sendInj });
  if (p2pHandled) return;

  // ── Wallet naming flow ───────────────────────────────────────────────────────
  if (namingState[telegramId]) {
    const state = namingState[telegramId];
    if (state.action === "name_new_wallet") {
      const name = text.slice(0, 30);
      const db = await readDB();
      const user = db.users[telegramId];
      if (!user) return ctx.reply("Use /start first.");

      let newAddress, newEncryptedPk, mnemonic;

      if (state.type === "generate") {
        const w = generateWallet();
        newAddress = w.address;
        newEncryptedPk = encrypt(w.privateKey);
        mnemonic = w.mnemonic;
      } else {
        newAddress = state.imported.address;
        newEncryptedPk = encrypt(state.imported.privateKey);
      }

      user.wallets.forEach((w) => w.active = false);
      user.wallets.push({
        id: Date.now(),
        name,
        address: newAddress,
        encrypted_pk: newEncryptedPk,
        active: true,
      });
      db.users[telegramId] = user;
      await writeDB(db);
      delete namingState[telegramId];

      await ctx.replyWithMarkdown(
        `✅ *${name}* added and set as active!\n\nAddress: \`${newAddress}\``,
        MAIN_MENU
      );

      if (mnemonic) {
        ctx.replyWithMarkdown(
          `🔑 *Seed Phrase for ${name}*\n\n\`${mnemonic}\`\n\n` +
          `⚠️ Save these 12 words and delete this message.`
        );
      }
      return;
    }
  }

  // ── PIN flow ─────────────────────────────────────────────────────────────────
  if (pinState[telegramId]) {
    const state = pinState[telegramId];

    if (state.action === "set_pin") {
      if (!/^\d{4,6}$/.test(text)) return ctx.reply("PIN must be 4-6 digits. Try again:");
      const db = await readDB();
      if (!db.users[telegramId]) return ctx.reply("Use /start first.");
      db.users[telegramId].pin_hash = hashPin(text);
      await writeDB(db);
      delete pinState[telegramId];
      return ctx.reply("✅ PIN set successfully!");
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

  // ── Natural language ─────────────────────────────────────────────────────────
  const db = await readDB();
  let user = db.users[telegramId];
  if (!user) return ctx.reply("Use /start first.");
  user = migrateUser(user);
  db.users[telegramId] = user;

  const activeWallet = getActiveWallet(user);
  if (!activeWallet) return ctx.reply("No active wallet. Use /wallets to manage your wallets.");

  await ctx.sendChatAction("typing");
  const intent = await parseIntent(text);

  switch (intent.intent) {

    case "check_balance": {
      const bal = await getBalance(activeWallet.address);
      ctx.replyWithMarkdown(`💼 *${activeWallet.name}*\n\`${activeWallet.address}\`\n💰 Balance: *${bal.toFixed(4)} INJ*`);
      break;
    }

    case "send_now": {
      if (!intent.to || !intent.amount) return ctx.reply('Try: "Send 2 INJ to inj1..."');
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      const bal = await getBalance(activeWallet.address);
      if (bal < intent.amount) return ctx.reply(`Not enough balance. Have ${bal.toFixed(4)} INJ, need ${intent.amount} INJ.`);

      await verifyPinThen(ctx, user, async () => {
        await ctx.reply(`Sending ${intent.amount} INJ from ${activeWallet.name}...`);
        try {
          const pk = decrypt(activeWallet.encrypted_pk);
          const txHash = await sendInj(pk, intent.to, intent.amount);
          const db2 = await readDB();
          db2.tx_log.push({ telegram_id: telegramId, type: "send", to_address: intent.to, amount_inj: intent.amount, tx_hash: txHash, status: "success", created_at: Date.now() });
          await writeDB(db2);
          ctx.reply(`✅ Sent ${intent.amount} INJ\nFrom: ${activeWallet.name}\nTo: ${intent.to}\nhttps://explorer.injective.network/transaction/${txHash}`);
        } catch (e) {
          ctx.reply(`❌ Failed: ${e.message}`);
        }
      });
      break;
    }

    case "one_time_send": {
      if (!intent.to || !intent.amount || !intent.send_at) return ctx.reply('Try: "Send 2 INJ to inj1... at 9am tomorrow"');
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      const sendAt = new Date(intent.send_at);
      if (isNaN(sendAt.getTime())) return ctx.reply("Could not understand that time.");
      if (!db.one_time_sends) db.one_time_sends = [];
      db.one_time_sends.push({ id: Date.now(), telegram_id: telegramId, wallet_id: activeWallet.id, to_address: intent.to, amount_inj: intent.amount, send_at: sendAt.toISOString(), active: true, created_at: Date.now() });
      await writeDB(db);
      ctx.reply(`✅ Scheduled!\n${intent.amount} INJ from ${activeWallet.name}\nTo: ${intent.to.slice(0, 20)}...\nAt: ${sendAt.toLocaleString()}`);
      break;
    }

    case "schedule_send": {
      if (!intent.to || !intent.amount || !intent.cron) return ctx.reply('Try: "Send 2 INJ to inj1... every Monday"');
      if (!intent.to.startsWith("inj1")) return ctx.reply("Invalid address.");
      if (!cron.validate(intent.cron)) return ctx.reply("Could not parse that schedule.");
      const schedId = Date.now();
      db.schedules.push({ id: schedId, telegram_id: telegramId, wallet_id: activeWallet.id, label: intent.label || "Scheduled Payment", cron_expr: intent.cron, to_address: intent.to, amount_inj: intent.amount, active: true, created_at: Date.now() });
      await writeDB(db);
      registerCronJob(telegramId, schedId, intent.cron, intent.to, intent.amount, intent.label);
      ctx.reply(`✅ Schedule created!\n${intent.amount} INJ from ${activeWallet.name}\nTo: ${intent.to.slice(0, 20)}...\n${intent.label || intent.cron}`);
      break;
    }

    case "set_alert": {
      if (!intent.threshold) return ctx.reply('Try: "Alert me when balance drops below 5 INJ"');
      const alertId = Date.now();
      db.alerts.push({ id: alertId, telegram_id: telegramId, wallet_id: activeWallet.id, type: "below", threshold_inj: intent.threshold, active: true, created_at: Date.now() });
      await writeDB(db);
      ctx.replyWithMarkdown(
        `🔔 Alert set for *${activeWallet.name}*!\nNotify when balance drops below *${intent.threshold} INJ*`,
        { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Alert", callback_data: `cancel_alert_${alertId}` }]] } }
      );
      break;
    }

    case "list_schedules": {
      const rows = db.schedules.filter((s) => s.telegram_id === telegramId && s.active);
      if (!rows.length) return ctx.reply("No active schedules.");
      for (const r of rows) {
        await ctx.replyWithMarkdown(
          `📅 *#${r.id}* ${r.label || "Payment"}\n${r.amount_inj} INJ to \`${r.to_address.slice(0, 20)}...\``,
          { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: `cancel_sched_${r.id}` }]] } }
        );
      }
      break;
    }

    case "list_alerts": {
      const rows = db.alerts.filter((a) => a.telegram_id === telegramId && a.active);
      if (!rows.length) return ctx.reply("No active alerts.");
      for (const r of rows) {
        await ctx.replyWithMarkdown(
          `🔔 *Alert #${r.id}* — below ${r.threshold_inj} INJ`,
          { reply_markup: { inline_keyboard: [[{ text: "❌ Cancel Alert", callback_data: `cancel_alert_${r.id}` }]] } }
        );
      }
      break;
    }

    case "tx_history": {
      const rows = db.tx_log.filter((t) => t.telegram_id === telegramId).slice(-5).reverse();
      if (!rows.length) return ctx.reply("No transactions yet.");
      ctx.reply(`Recent Transactions\n\n${rows.map((r) => `${r.status === "success" ? "✅" : "❌"} ${r.amount_inj} INJ | ${new Date(r.created_at).toLocaleDateString()}`).join("\n")}`);
      break;
    }

    case "help":
      ctx.replyWithMarkdown(`⚡ *InjiPay*\nChoose an option:`, MAIN_MENU);
      break;

    default:
      ctx.replyWithMarkdown(
        `I did not understand that. Try:\n\n"Send 2 INJ to inj1..."\n"Pay inj1... 1 INJ every Monday"\n"Alert me if balance drops below 5 INJ"\n\nOr use the menu:`,
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
    const w = schedule.wallet_id ? user.wallets.find((w) => w.id === schedule.wallet_id) : getActiveWallet(user);
    if (!w) return;
    const bal = await getBalance(w.address);
    if (bal < amountInj) {
      bot.telegram.sendMessage(telegramId, `⚠️ Scheduled payment failed: not enough balance in ${w.name}. Need ${amountInj} INJ, have ${bal.toFixed(4)} INJ.`);
      return;
    }
    try {
      const pk = decrypt(w.encrypted_pk);
      const txHash = await sendInj(pk, toAddress, amountInj);
      schedule.last_run = Date.now();
      db.tx_log.push({ telegram_id: telegramId, type: "scheduled", to_address: toAddress, amount_inj: amountInj, tx_hash: txHash, status: "success", created_at: Date.now() });
      await writeDB(db);
      bot.telegram.sendMessage(telegramId, `✅ Scheduled payment sent from ${w.name}!\n${amountInj} INJ\nhttps://explorer.injective.network/transaction/${txHash}`);
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
    const w = job.wallet_id ? user.wallets.find((w) => w.id === job.wallet_id) : getActiveWallet(user);
    if (!w) { job.active = false; continue; }
    const bal = await getBalance(w.address);
    if (bal < job.amount_inj) {
      bot.telegram.sendMessage(job.telegram_id, `⚠️ One-time send failed: not enough balance in ${w.name}.`);
      job.active = false;
      continue;
    }
    try {
      const pk = decrypt(w.encrypted_pk);
      const txHash = await sendInj(pk, job.to_address, job.amount_inj);
      job.active = false;
      db.tx_log.push({ telegram_id: job.telegram_id, type: "one-time", to_address: job.to_address, amount_inj: job.amount_inj, tx_hash: txHash, status: "success", created_at: Date.now() });
      bot.telegram.sendMessage(job.telegram_id, `✅ One-time send executed from ${w.name}!\n${job.amount_inj} INJ\nhttps://explorer.injective.network/transaction/${txHash}`);
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
    const w = alert.wallet_id ? user.wallets.find((w) => w.id === alert.wallet_id) : getActiveWallet(user);
    if (!w) continue;
    const bal = await getBalance(w.address);
    if (bal < alert.threshold_inj) {
      bot.telegram.sendMessage(alert.telegram_id, `🚨 Balance Alert — ${w.name}!\nDropped below ${alert.threshold_inj} INJ. Current: ${bal.toFixed(4)} INJ\n\nDeposit to: ${w.address}`);
    }
  }
});

// ─── Launch ───────────────────────────────────────────────────────────────────
async function loadSchedules() {
  const db = await readDB();
  const active = db.schedules.filter((s) => s.active);
  console.log(`Loading ${active.length} active schedule(s)...`);
  active.forEach((s) => registerCronJob(s.telegram_id, s.id, s.cron_expr, s.to_address, s.amount_inj, s.label));
  registerAlertPoller(bot, { readDB });
}

loadSchedules();
bot.launch().then(() => console.log("INJ Spend Agent is live!"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
