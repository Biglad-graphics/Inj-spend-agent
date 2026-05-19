// ============================================================
// InjiPay — Credit & Debit Alert Module
// Polls every 30 seconds for incoming/outgoing INJ transactions
// ============================================================

const cron = require("node-cron");
const { ChainGrpcBankApi, IndexerGrpcExplorerApi } = require("@injectivelabs/sdk-ts");
const { getNetworkEndpoints, Network } = require("@injectivelabs/networks");

const NETWORK   = Network.Mainnet;
const ENDPOINTS = getNetworkEndpoints(NETWORK);
const explorerApi = new IndexerGrpcExplorerApi(ENDPOINTS.indexer);

// Tracks last known balance per wallet address (in-memory)
// { "inj1abc...": { balance: 5.23, lastChecked: timestamp } }
const balanceCache = {};

function registerAlertPoller(bot, { readDB }) {

  // Poll every 30 seconds
  cron.schedule("*/30 * * * * *", async () => {
    try {
      const db = await readDB();
      const users = db.users || {};

      for (const [telegramId, user] of Object.entries(users)) {
        if (!user.wallets) continue;

        // Check all wallets, not just active one
        for (const wallet of user.wallets) {
          const address = wallet.address;

          try {
            // Fetch current balance
            const bankApi = new ChainGrpcBankApi(ENDPOINTS.grpc);
            const bal = await bankApi.fetchBalance({ accountAddress: address, denom: "inj" });
            const currentBalance = parseFloat(bal.amount) / 1e18;

            const cached = balanceCache[address];

            if (!cached) {
              // First time seeing this wallet — just store, don't alert
              balanceCache[address] = { balance: currentBalance, lastChecked: Date.now() };
              continue;
            }

            const diff = currentBalance - cached.balance;

            if (Math.abs(diff) < 0.000001) {
              // No change
              balanceCache[address].lastChecked = Date.now();
              continue;
            }

            // Fetch latest tx to get the other party's address
            let counterparty = "Unknown";
            let txHash = "";
            try {
              const txs = await explorerApi.fetchAccountTransactions({
                address,
                limit: 1,
              });
              if (txs.data && txs.data.length > 0) {
                const tx = txs.data[0];
                txHash = tx.hash || "";
                // Try to extract counterparty from messages
                const msg = tx.messages?.[0];
                if (msg) {
                  if (diff > 0) {
                    counterparty = msg.value?.sender || msg.sender || "Unknown";
                  } else {
                    counterparty = msg.value?.recipient || msg.recipient || "Unknown";
                  }
                }
              }
            } catch (_) {}

            const isCredit = diff > 0;
            const absAmount = Math.abs(diff).toFixed(4);
            const txLink = txHash
              ? `\n🔗 https://explorer.injective.network/transaction/${txHash}`
              : "";

            if (isCredit) {
              await bot.telegram.sendMessage(
                telegramId,
                `🟢 *Credit Alert — ${wallet.name}*\n\n` +
                `+${absAmount} INJ received\n` +
                `From: \`${counterparty.slice(0, 20)}...\`\n` +
                `Balance: *${currentBalance.toFixed(4)} INJ*` +
                txLink,
                { parse_mode: "Markdown" }
              );
            } else {
              await bot.telegram.sendMessage(
                telegramId,
                `🔴 *Debit Alert — ${wallet.name}*\n\n` +
                `-${absAmount} INJ sent\n` +
                `To: \`${counterparty.slice(0, 20)}...\`\n` +
                `Balance: *${currentBalance.toFixed(4)} INJ*` +
                txLink,
                { parse_mode: "Markdown" }
              );
            }

            // Update cache
            balanceCache[address] = { balance: currentBalance, lastChecked: Date.now() };

          } catch (walletErr) {
            // Skip this wallet silently — don't break the loop
            console.log(`Alert poll error for ${address}: ${walletErr.message}`);
          }
        }
      }
    } catch (err) {
      console.log("Alert poller error:", err.message);
    }
  });

  console.log("✅ Credit/Debit alert poller started (every 30s)");
}

module.exports = { registerAlertPoller };
