// ============================================================
// InjiPay — P2P Cashout Module (INJ → Naira)
// ============================================================

const PROFIT_RATE = 0.054;
const BOT_INJ_WALLET = "inj1t0gw53gp69z9yygdcqdr5399guwqzkyq76qnlz";
const ADMIN_GROUP_ID = "-1003970109129";

async function getInjNgnRate() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=injective-protocol&vs_currencies=ngn"
  );
  const json = await res.json();
  const marketRate = json["injective-protocol"].ngn;
  const ourRate = marketRate * (1 - PROFIT_RATE);
  return { marketRate, ourRate };
}

const p2pState = {};

function registerP2PHandlers(bot, { readDB, writeDB, getActiveWallet, decrypt, sendInj }) {

  bot.action("p2p_sell", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const db = await readDB();
    const user = db.users[telegramId];
    if (!user) return ctx.reply("Use /start first.");

    const activeWallet = getActiveWallet(user);
    if (!activeWallet) return ctx.reply("No active wallet. Go to My Wallets.");

    try {
      const { ourRate } = await getInjNgnRate();
      p2pState[telegramId] = { step: "await_amount", ourRate };

      await ctx.replyWithMarkdown(
        `💱 *Sell INJ for Naira*\n\n` +
        `📊 Rate: *₦${ourRate.toLocaleString("en-NG", { maximumFractionDigits: 2 })}/INJ*\n\n` +
        `How many INJ do you want to sell?\n` +
        `_(Minimum: 0.1 INJ)_`
      );
    } catch (e) {
      ctx.reply("❌ Could not fetch rate right now. Try again in a moment.");
    }
  });

  bot.action(/^p2p_paid_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from.id);
    if (!ADMIN_IDS.includes(adminId)) return ctx.reply("Not authorised.");

    const tradeId = ctx.match[1];
    const db = await readDB();
    const trade = (db.p2p_trades || []).find((t) => t.id === tradeId);
    if (!trade) return ctx.reply("Trade not found.");
    if (trade.status !== "pending_payment") return ctx.reply("Trade already resolved.");

    trade.status = "completed";
    trade.paid_at = Date.now();
    trade.paid_by = adminId;
    await writeDB(db);

    await ctx.telegram.sendMessage(
      trade.telegram_id,
      `✅ *Payment Confirmed!*\n\n` +
      `₦${trade.naira_amount.toLocaleString("en-NG")} has been sent to your account.\n\n` +
      `🏦 *${trade.bank_name}*\n` +
      `💳 ${trade.account_number}\n\n` +
      `Trade ID: \`${tradeId}\``,
      { parse_mode: "Markdown" }
    );

    await ctx.editMessageText(
      `✅ *PAID* — Trade ${tradeId}\n` +
      `User: @${trade.username || trade.telegram_id}\n` +
      `Amount: ₦${trade.naira_amount.toLocaleString("en-NG")}\n` +
      `Bank: ${trade.bank_name} — ${trade.account_number}\n` +
      `Paid by admin: ${adminId}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.action(/^p2p_refund_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const adminId = String(ctx.from.id);
    if (!ADMIN_IDS.includes(adminId)) return ctx.reply("Not authorised.");

    const tradeId = ctx.match[1];
    const db = await readDB();
    const trade = (db.p2p_trades || []).find((t) => t.id === tradeId);
    if (!trade) return ctx.reply("Trade not found.");
    if (trade.status !== "pending_payment") return ctx.reply("Trade already resolved.");

    trade.status = "refunded";
    trade.refunded_at = Date.now();
    await writeDB(db);

    await ctx.telegram.sendMessage(
      trade.telegram_id,
      `❌ *Trade Cancelled*\n\n` +
      `Your P2P cashout has been cancelled.\n` +
      `Trade ID: \`${tradeId}\`\n\n` +
      `Contact support if you believe this is an error.`,
      { parse_mode: "Markdown" }
    );

    await ctx.editMessageText(
      `❌ *REFUNDED* — Trade ${tradeId}\n` +
      `User: @${trade.username || trade.telegram_id}`,
      { parse_mode: "Markdown" }
    );
  });
}

async function handleP2PText(ctx, { readDB, writeDB, getActiveWallet, decrypt, sendInj }) {
  const telegramId = String(ctx.from.id);
  const state = p2pState[telegramId];
  if (!state) return false;

  const text = ctx.message.text.trim();

  if (state.step === "await_amount") {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 0.1) {
      ctx.reply("❌ Please enter a valid amount (minimum 0.1 INJ):");
      return true;
    }

    const db = await readDB();
    const user = db.users[telegramId];
    const activeWallet = getActiveWallet(user);
    if (!activeWallet) {
      delete p2pState[telegramId];
      ctx.reply("No active wallet found.");
      return true;
    }

    let ourRate = state.ourRate;
    try {
      const fresh = await getInjNgnRate();
      ourRate = fresh.ourRate;
    } catch (_) {}

    const nairaAmount = amount * ourRate;
    p2pState[telegramId] = { ...state, step: "await_confirm", amountInj: amount, nairaAmount, ourRate };

    await ctx.replyWithMarkdown(
      `💱 *Confirm Sale*\n\n` +
      `You sell: *${amount} INJ*\n` +
      `You receive: *₦${nairaAmount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}*\n` +
      `Rate: ₦${ourRate.toLocaleString("en-NG", { maximumFractionDigits: 2 })}/INJ\n\n` +
      `Proceed?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Confirm", callback_data: "p2p_confirm" },
            { text: "❌ Cancel",  callback_data: "p2p_cancel"  },
          ]],
        },
      }
    );
    return true;
  }

  if (state.step === "await_bank_name") {
    p2pState[telegramId] = { ...state, step: "await_account_number", bankName: text };
    ctx.reply("💳 Enter your account number:");
    return true;
  }

  if (state.step === "await_account_number") {
    if (!/^\d{10}$/.test(text)) {
      ctx.reply("❌ Account number must be exactly 10 digits. Try again:");
      return true;
    }
    p2pState[telegramId] = { ...state, step: "await_account_name", accountNumber: text };
    ctx.reply("👤 Enter the account name (as on your bank):");
    return true;
  }

  if (state.step === "await_account_name") {
    const accountName = text;
    const { amountInj, nairaAmount, ourRate, bankName, accountNumber } = state;
    delete p2pState[telegramId];

    const db = await readDB();
    const user = db.users[telegramId];
    const activeWallet = getActiveWallet(user);

    if (!activeWallet) {
      ctx.reply("❌ No active wallet found.");
      return true;
    }

    await ctx.reply("⏳ Processing your sale — withdrawing INJ...");

    try {
      const pk = decrypt(activeWallet.encrypted_pk);
      const txHash = await sendInj(pk, BOT_INJ_WALLET, amountInj);

      const tradeId = `P2P-${Date.now()}`;
      if (!db.p2p_trades) db.p2p_trades = [];
      db.p2p_trades.push({
        id: tradeId,
        telegram_id: telegramId,
        username: user.username || "",
        wallet_id: activeWallet.id,
        amount_inj: amountInj,
        naira_amount: nairaAmount,
        rate: ourRate,
        bank_name: bankName,
        account_number: accountNumber,
        account_name: accountName,
        tx_hash: txHash,
        status: "pending_payment",
        created_at: Date.now(),
      });

      if (!db.tx_log) db.tx_log = [];
      db.tx_log.push({
        telegram_id: telegramId,
        type: "p2p_sell",
        amount_inj: amountInj,
        tx_hash: txHash,
        status: "success",
        note: `P2P cashout — ₦${nairaAmount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}`,
        created_at: Date.now(),
      });

      await writeDB(db);

      await ctx.replyWithMarkdown(
        `✅ *INJ Received!*\n\n` +
        `${amountInj} INJ has been withdrawn from *${activeWallet.name}*.\n\n` +
        `💸 *₦${nairaAmount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}* will be sent to:\n` +
        `🏦 ${bankName}\n` +
        `💳 ${accountNumber}\n` +
        `👤 ${accountName}\n\n` +
        `_You'll be notified once payment is confirmed._\n` +
        `Trade ID: \`${tradeId}\``
      );

      // Notify admin group
      await ctx.telegram.sendMessage(
        ADMIN_GROUP_ID,
          `🔔 *New P2P Cashout Request*\n\n` +
          `👤 User: ${user.username ? "@" + user.username.replace(/_/g, "\\_") : telegramId}\n` +
          `💰 INJ sold: *${amountInj} INJ*\n` +
          `💵 Naira to pay: *₦${nairaAmount.toLocaleString("en-NG", { maximumFractionDigits: 2 })}*\n\n` +
          `🏦 Bank: *${bankName}*\n` +
          `💳 Account No: *${accountNumber}*\n` +
          `👤 Account Name: *${accountName}*\n\n` +
          `🔗 Tx: https://explorer.injective.network/transaction/${txHash}\n` +
          `🆔 Trade ID: ${tradeId}`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Mark as Paid",  callback_data: `p2p_paid_${tradeId}`   },
                { text: "❌ Cancel/Refund", callback_data: `p2p_refund_${tradeId}` },
              ]],
            },
          }
        );

    } catch (e) {
      ctx.reply(`❌ Transaction failed: ${e.message}\n\nYour funds are safe — nothing was withdrawn.`);
    }

    return true;
  }

  return false;
}

function registerP2PConfirmHandlers(bot) {
  bot.action("p2p_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from.id);
    const state = p2pState[telegramId];
    if (!state || state.step !== "await_confirm") {
      return ctx.reply("Session expired. Tap Sell INJ again.");
    }
    p2pState[telegramId] = { ...state, step: "await_bank_name" };
    ctx.reply("🏦 Enter your bank name (e.g. GTBank, Access, Opay):");
  });

  bot.action("p2p_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    delete p2pState[String(ctx.from.id)];
    ctx.reply("❌ Sale cancelled.");
  });
}

module.exports = { registerP2PHandlers, registerP2PConfirmHandlers, handleP2PText, p2pState };
