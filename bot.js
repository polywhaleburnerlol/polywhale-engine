// ═══════════════════════════════════════════════════════════════════════════════
// Polymarket Whale Copy-Trader Bot
// ═══════════════════════════════════════════════════════════════════════════════
// Monitors a target whale address on Polymarket via WebSocket and mirrors their
// trades in real-time as $1.00 FOK (Fill-or-Kill) market orders.
//
// Architecture:
//   1. Bootstraps the whale's current open positions from the Data API
//   2. Opens a CLOB Market WebSocket to receive real-time trade events
//   3. Cross-references each trade against the whale via the Data API
//   4. Executes a $1.00 FOK market order copying the whale's direction
//
// Why this architecture?
//   - The CLOB "user" channel only streams YOUR OWN authenticated trades
//   - The CLOB "market" channel streams `last_trade_price` for all trades on
//     subscribed asset_ids — but does NOT include maker/taker addresses
//   - Therefore: we subscribe to the whale's known asset_ids on the market
//     channel, and when a trade fires, we verify it was the whale via a fast
//     Data API call before copying. This avoids setInterval polling entirely.
//   - As a supplementary safety net, we periodically refresh the whale's
//     position list to pick up any NEW markets the whale enters.
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = Object.freeze({
  // Polymarket endpoints
  CLOB_HOST: "https://clob.polymarket.com",
  WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  DATA_API: "https://data-api.polymarket.com",
  GAMMA_API: "https://gamma-api.polymarket.com",
  CHAIN_ID: 137,

  // Target whale to copy
  WHALE_ADDRESS: (
    process.env.WHALE_ADDRESS ||
    "0xc088343e85E0Bd8334e662D358Ad92aeC5F945CA"
  ).toLowerCase(),

  // Trade sizing — spend exactly $1.00 USDC per copied trade
  TRADE_AMOUNT_USD: 1.0,

  // Slippage protection: worst acceptable price deviation from whale's price
  // e.g. 0.05 means we'll accept up to 5 cents worse than the whale's price
  MAX_SLIPPAGE: 0.05,

  // Liquidity engine: max acceptable deviation from whale's price (1% = 0.01)
  // The order book must have enough depth to fill our order within this band
  MAX_SLIPPAGE_PCT: 0.01,

  // How often to refresh the whale's position list to discover new markets (ms)
  POSITION_REFRESH_INTERVAL_MS: 60_000,

  // WebSocket reconnection
  WS_RECONNECT_BASE_MS: 1_000,
  WS_RECONNECT_MAX_MS: 30_000,
  WS_PING_INTERVAL_MS: 15_000,

  // Dedup window: ignore duplicate trade signals within this window (ms)
  DEDUP_WINDOW_MS: 5_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// Environment validation
// ─────────────────────────────────────────────────────────────────────────────
function validateEnv() {
  const required = ["PRIVATE_KEY", "POLY_API_KEY", "POLY_SECRET", "POLY_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
    console.error("   Create a .env file with: PRIVATE_KEY, POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE");
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────
const log = {
  info: (msg, ...args) => console.log(`[${ts()}] ℹ️  ${msg}`, ...args),
  trade: (msg, ...args) => console.log(`[${ts()}] 💰 ${msg}`, ...args),
  whale: (msg, ...args) => console.log(`[${ts()}] 🐋 ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[${ts()}] ⚠️  ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[${ts()}] ❌ ${msg}`, ...args),
  ws: (msg, ...args) => console.log(`[${ts()}] 🔌 ${msg}`, ...args),
};
function ts() {
  return new Date().toISOString().slice(11, 23);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOB Client Initialization
// ─────────────────────────────────────────────────────────────────────────────
async function createClobClient() {
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const myAddress = (await signer.getAddress()).toLowerCase();

  // ── Self-Trade Prevention ──
  if (myAddress === CONFIG.WHALE_ADDRESS) {
    console.error("═══════════════════════════════════════════════════════════");
    console.error("🛑  SELF-TRADE PREVENTION TRIGGERED");
    console.error("    Your wallet address matches the target whale address.");
    console.error("    This would create an infinite copy-trade loop.");
    console.error(`    Your address:  ${myAddress}`);
    console.error(`    Whale address: ${CONFIG.WHALE_ADDRESS}`);
    console.error("═══════════════════════════════════════════════════════════");
    process.exit(1);
  }

  const creds = {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  // signatureType 0 = EOA/MetaMask, 1 = Magic/Email proxy
  // Using 0 for direct private key usage; change to 1 if using Magic wallet
  const signatureType = 0;

  const client = new ClobClient(
    CONFIG.CLOB_HOST,
    CONFIG.CHAIN_ID,
    signer,
    creds,
    signatureType
  );

  // Verify connectivity
  const ok = await client.getOk();
  if (ok !== "OK") {
    throw new Error(`CLOB health check failed: ${ok}`);
  }

  log.info(`CLOB client initialized — your address: ${myAddress}`);
  return { client, myAddress };
}

// ─────────────────────────────────────────────────────────────────────────────
// Whale Position Discovery
// ─────────────────────────────────────────────────────────────────────────────
// Fetches the whale's current open positions from the Data API and returns
// a Map of asset_id → position metadata (conditionId, outcome, side, etc.)
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWhalePositions() {
  const url = `${CONFIG.DATA_API}/positions?user=${CONFIG.WHALE_ADDRESS}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Data API /positions returned ${resp.status}: ${await resp.text()}`);
  }
  const positions = await resp.json();
  const assetMap = new Map();

  for (const pos of positions) {
    if (pos.asset && pos.size > 0) {
      assetMap.set(pos.asset, {
        conditionId: pos.conditionId,
        title: pos.title || "Unknown Market",
        outcome: pos.outcome || "Unknown",
        slug: pos.slug || "",
        curPrice: pos.curPrice || 0,
      });
    }
  }

  return assetMap;
}

// Fetches market metadata from Gamma to get tickSize and negRisk for a token
async function fetchMarketInfo(conditionId) {
  try {
    const url = `${CONFIG.GAMMA_API}/markets?condition_id=${conditionId}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const markets = await resp.json();
    if (markets && markets.length > 0) {
      const m = markets[0];
      return {
        tickSize: m.minimum_tick_size || "0.01",
        negRisk: m.neg_risk || false,
        tokens: m.tokens || [],
        question: m.question || "",
      };
    }
  } catch (err) {
    log.warn(`Failed to fetch market info for ${conditionId}: ${err.message}`);
  }
  return null;
}

// Quick check: was a recent trade on this asset actually by the whale?
// Queries the Data API /activity endpoint for the whale's most recent activity.
async function verifyWhaleTrade(assetId) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const lookback = now - 30; // last 30 seconds
    const url =
      `${CONFIG.DATA_API}/activity` +
      `?user=${CONFIG.WHALE_ADDRESS}` +
      `&type=TRADE` +
      `&start=${lookback}` +
      `&sortBy=TIMESTAMP&sortDirection=DESC`;

    const resp = await fetch(url);
    if (!resp.ok) return null;

    const activities = await resp.json();
    // Find a trade matching this asset
    const match = activities.find((a) => a.asset === assetId);
    if (match) {
      return {
        side: match.side,       // "BUY" or "SELL"
        price: match.price,
        size: match.size,
        asset: match.asset,
        conditionId: match.conditionId,
        outcome: match.outcome,
        title: match.title,
        slug: match.slug,
      };
    }
  } catch (err) {
    log.warn(`Whale verification failed: ${err.message}`);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Execution Engine
// ─────────────────────────────────────────────────────────────────────────────
// Deduplication: prevent firing multiple orders for the same trade signal
const recentTrades = new Map(); // asset_id+side → timestamp

function isDuplicate(assetId, side) {
  const key = `${assetId}:${side}`;
  const last = recentTrades.get(key);
  const now = Date.now();
  if (last && now - last < CONFIG.DEDUP_WINDOW_MS) {
    return true;
  }
  recentTrades.set(key, now);
  // Prune old entries
  for (const [k, v] of recentTrades) {
    if (now - v > CONFIG.DEDUP_WINDOW_MS * 2) recentTrades.delete(k);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity Engine — Order Book Depth Analysis
// ─────────────────────────────────────────────────────────────────────────────
// Fetches the L2 order book for an asset and determines whether TRADE_AMOUNT_USD
// can be filled within MAX_SLIPPAGE_PCT of the whale's reported price.
//
// Returns:
//   { ok: true,  effectivePrice, fillableVolume }   — safe to execute
//   { ok: false, reason, effectivePrice?, fillableVolume? } — skip trade
// ─────────────────────────────────────────────────────────────────────────────
async function checkLiquidity(clobClient, asset, side, whalePrice) {
  let orderBook;
  try {
    orderBook = await clobClient.getMarketOrderBook(asset);
  } catch (err) {
    return {
      ok: false,
      reason: `Order book fetch failed: ${err.message}`,
    };
  }

  if (!orderBook) {
    return { ok: false, reason: "Order book returned null/undefined" };
  }

  // For a BUY copy, we lift the Asks (sell side of the book).
  // For a SELL copy, we hit the Bids (buy side of the book).
  const levels = side === "BUY"
    ? (orderBook.asks || [])
    : (orderBook.bids || []);

  if (levels.length === 0) {
    return { ok: false, reason: "No liquidity levels on relevant side of book" };
  }

  // The 1% price band we'll tolerate
  const maxDeviation = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  const priceCeiling = side === "BUY"
    ? Math.min(whalePrice + maxDeviation, 0.99)  // worst ask we'd accept
    : whalePrice;                                  // for sells, anything at or above floor
  const priceFloor = side === "BUY"
    ? whalePrice                                   // for buys, anything at or below ceiling
    : Math.max(whalePrice - maxDeviation, 0.01);   // worst bid we'd accept

  // Walk the book levels, accumulating fill volume within the price band
  let fillableVolume = 0;   // total USDC fillable within band
  let weightedCostSum = 0;  // for VWAP calculation

  for (const level of levels) {
    const levelPrice = parseFloat(level.price);
    const levelSize  = parseFloat(level.size);

    // Check price is within our acceptable band
    if (side === "BUY" && levelPrice > priceCeiling) break;   // asks sorted ascending
    if (side === "SELL" && levelPrice < priceFloor) break;     // bids sorted descending

    const levelNotional = levelPrice * levelSize; // USDC value at this level

    const remaining = CONFIG.TRADE_AMOUNT_USD - fillableVolume;
    const take = Math.min(levelNotional, remaining);

    fillableVolume += take;
    weightedCostSum += levelPrice * (take / levelPrice); // shares × price for VWAP

    if (fillableVolume >= CONFIG.TRADE_AMOUNT_USD) break;
  }

  const effectivePrice = fillableVolume > 0
    ? weightedCostSum / (fillableVolume / (fillableVolume / weightedCostSum || 1))
    : 0;

  if (fillableVolume < CONFIG.TRADE_AMOUNT_USD) {
    return {
      ok: false,
      reason:
        `Only $${fillableVolume.toFixed(4)} fillable within 1% band ` +
        `(need $${CONFIG.TRADE_AMOUNT_USD})`,
      fillableVolume,
      effectivePrice,
    };
  }

  return { ok: true, effectivePrice, fillableVolume };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Execution — Hardened
// ─────────────────────────────────────────────────────────────────────────────
async function executeCopyTrade(clobClient, whaleTrade) {
  const { side, price, asset, conditionId, outcome, title } = whaleTrade;

  if (isDuplicate(asset, side)) {
    log.warn(`Dedup: skipping duplicate ${side} on "${title}" (${outcome})`);
    return;
  }

  log.whale(`Detected whale ${side} on "${title}" [${outcome}] @ ${price}`);

  // ── Step 1: Fetch market-specific parameters (tickSize, negRisk) ──
  const marketInfo = await fetchMarketInfo(conditionId);
  if (!marketInfo) {
    log.error(`Cannot fetch market info for conditionId=${conditionId} — skipping`);
    return;
  }

  // ── Step 2: Liquidity pre-flight via order book depth analysis ──
  const whalePrice = parseFloat(price);
  const liquidity = await checkLiquidity(clobClient, asset, side, whalePrice);

  if (!liquidity.ok) {
    log.warn(
      `⛔ LIQUIDITY WARNING: Spread too wide — skipping ${side} on "${title}" [${outcome}]`
    );
    log.warn(
      `   Reason: ${liquidity.reason} | ` +
      `whalePrice=${whalePrice.toFixed(4)} | ` +
      `1% band=±${(whalePrice * CONFIG.MAX_SLIPPAGE_PCT).toFixed(4)}`
    );
    return;
  }

  // ── Step 3: Compute worst acceptable price from the liquidity band ──
  const maxDeviation = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  let worstPrice;
  if (side === "BUY") {
    worstPrice = Math.min(whalePrice + maxDeviation, 0.99);
  } else {
    worstPrice = Math.max(whalePrice - maxDeviation, 0.01);
  }

  const orderSide = side === "BUY" ? Side.BUY : Side.SELL;

  log.trade(
    `Placing FOK ${side} | $${CONFIG.TRADE_AMOUNT_USD} USDC | ` +
    `token=${asset.slice(0, 12)}... | worst_price=${worstPrice.toFixed(4)} | ` +
    `tick=${marketInfo.tickSize} | negRisk=${marketInfo.negRisk} | ` +
    `bookDepth=$${liquidity.fillableVolume.toFixed(4)} available`
  );

  // ── Step 4: Place the order ──
  try {
    const response = await clobClient.createAndPostMarketOrder(
      {
        tokenID: asset,
        side: orderSide,
        amount: CONFIG.TRADE_AMOUNT_USD,
        price: worstPrice,
      },
      {
        tickSize: marketInfo.tickSize,
        negRisk: marketInfo.negRisk,
      },
      OrderType.FOK
    );

    // ── Hardened success check ──
    // Only declare FILLED when the response object explicitly confirms it.
    // A 403, network error, or missing `success` field must never be logged
    // as a fill.
    if (
      response &&
      typeof response === "object" &&
      response.success === true
    ) {
      const orderId =
        response.orderID || response.orderIds?.[0] || "N/A";
      log.trade(
        `✅ Order FILLED — ${side} "${title}" [${outcome}] | orderID=${orderId}`
      );
    } else {
      // Explicit failure or ambiguous response — never treat as success
      const reason =
        response?.errorMsg ||
        response?.error ||
        response?.message ||
        JSON.stringify(response);
      const status = response?.status || response?.statusCode || "";
      log.error(
        `Order NOT confirmed — ${side} "${title}" [${outcome}] | ` +
        `status=${status} | reason=${reason}`
      );
    }
  } catch (err) {
    handleOrderError(err, side, title, outcome);
  }
}

function handleOrderError(err, side, title, outcome) {
  const msg = err.message || String(err);

  if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("geo")) {
    log.error(
      `🚫 ACCESS DENIED (403) — your IP or account may be geoblocked by Polymarket. ` +
      `${side} "${title}" [${outcome}] was NOT executed.`
    );
  } else if (msg.includes("not enough balance") || msg.includes("insufficient")) {
    log.error(
      `💸 INSUFFICIENT FUNDS — cannot ${side} "${title}" [${outcome}]. ` +
      `Top up your Polymarket wallet with USDC.e on Polygon.`
    );
  } else if (msg.includes("slippage") || msg.includes("FOK") || msg.includes("not enough liquidity")) {
    log.error(
      `📉 SLIPPAGE/LIQUIDITY — FOK order for "${title}" [${outcome}] could not fill. ` +
      `The order book may have moved since the whale's trade.`
    );
  } else if (msg.includes("rate limit") || msg.includes("429")) {
    log.error(`⏳ RATE LIMITED — backing off. Will retry on next signal.`);
  } else {
    log.error(`Order failed for "${title}" [${outcome}]: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Manager
// ─────────────────────────────────────────────────────────────────────────────
// Connects to the CLOB Market WebSocket and subscribes to all asset_ids
// where the whale has open positions. When a `last_trade_price` event fires,
// we verify the whale made the trade and then execute our copy order.
// ─────────────────────────────────────────────────────────────────────────────
class WhaleWatcher {
  constructor(clobClient, myAddress) {
    this.clobClient = clobClient;
    this.myAddress = myAddress;
    this.ws = null;
    this.pingInterval = null;
    this.positionRefreshInterval = null;
    this.reconnectAttempt = 0;
    this.subscribedAssets = new Set();
    this.assetMap = new Map();   // asset_id → position metadata
    this.isShuttingDown = false;
  }

  async start() {
    log.info("═══════════════════════════════════════════════════════════");
    log.info("  Polymarket Whale Copy-Trader Bot");
    log.info("═══════════════════════════════════════════════════════════");
    log.info(`  Target whale:   ${CONFIG.WHALE_ADDRESS}`);
    log.info(`  Trade amount:   $${CONFIG.TRADE_AMOUNT_USD} USDC (FOK)`);
    log.info(`  Max slippage:   ${CONFIG.MAX_SLIPPAGE}`);
    log.info(`  Your address:   ${this.myAddress}`);
    log.info("═══════════════════════════════════════════════════════════");

    // 1. Bootstrap: discover whale's current positions
    await this.refreshWhalePositions();

    // 2. Connect WebSocket
    this.connect();

    // 3. Periodically refresh positions to discover new markets the whale enters
    this.positionRefreshInterval = setInterval(async () => {
      await this.refreshWhalePositions();
      this.subscribeNewAssets();
    }, CONFIG.POSITION_REFRESH_INTERVAL_MS);
  }

  async refreshWhalePositions() {
    try {
      this.assetMap = await fetchWhalePositions();
      log.whale(
        `Tracking ${this.assetMap.size} whale positions ` +
        `across ${new Set([...this.assetMap.values()].map((v) => v.conditionId)).size} markets`
      );
    } catch (err) {
      log.error(`Failed to refresh whale positions: ${err.message}`);
    }
  }

  connect() {
    if (this.isShuttingDown) return;

    log.ws(`Connecting to ${CONFIG.WS_URL}...`);
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.on("open", () => {
      log.ws("Connected ✓");
      this.reconnectAttempt = 0;
      this.subscribeAll();
      this.startPing();
    });

    this.ws.on("message", (raw) => {
      this.handleMessage(raw);
    });

    this.ws.on("close", (code, reason) => {
      log.ws(`Disconnected (code=${code}, reason=${reason || "none"})`);
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`WebSocket error: ${err.message}`);
      // 'close' event will follow and trigger reconnection
    });
  }

  subscribeAll() {
    const assetIds = [...this.assetMap.keys()];
    if (assetIds.length === 0) {
      log.warn(
        "Whale has no open positions — WebSocket will idle. " +
        "Positions will be rechecked in 60s."
      );
      return;
    }

    // The market channel accepts asset_ids (token IDs)
    const subscribeMsg = JSON.stringify({
      assets_ids: assetIds,
      type: "market",
      custom_feature_enabled: true,
    });
    this.ws.send(subscribeMsg);
    this.subscribedAssets = new Set(assetIds);

    log.ws(`Subscribed to ${assetIds.length} asset(s)`);
  }

  // Subscribe only to newly discovered assets (whale entered a new market)
  subscribeNewAssets() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const currentAssets = [...this.assetMap.keys()];
    const newAssets = currentAssets.filter((a) => !this.subscribedAssets.has(a));

    if (newAssets.length > 0) {
      const msg = JSON.stringify({
        assets_ids: newAssets,
        operation: "subscribe",
        custom_feature_enabled: true,
      });
      this.ws.send(msg);
      newAssets.forEach((a) => this.subscribedAssets.add(a));
      log.ws(`Subscribed to ${newAssets.length} new asset(s)`);
    }
  }

  async handleMessage(raw) {
    let data;
    try {
      const text = typeof raw === "string" ? raw : raw.toString();
      data = JSON.parse(text);
    } catch {
      return; // Ignore malformed messages (pong frames, etc.)
    }

    // We're interested in last_trade_price events — these fire whenever a
    // trade executes on a subscribed asset_id
    if (Array.isArray(data)) {
      for (const event of data) {
        await this.processEvent(event);
      }
    } else {
      await this.processEvent(data);
    }
  }

  async processEvent(event) {
    if (event.event_type !== "last_trade_price") return;

    const assetId = event.asset_id;
    if (!assetId || !this.assetMap.has(assetId)) return;

    // A trade happened on one of the whale's assets.
    // Verify it was actually the whale (not someone else trading in that market).
    log.info(
      `Trade detected on whale's asset ${assetId.slice(0, 16)}... | ` +
      `price=${event.price} side=${event.side} size=${event.size}`
    );

    const whaleTrade = await verifyWhaleTrade(assetId);
    if (!whaleTrade) {
      log.info("  → Not the whale's trade, ignoring.");
      return;
    }

    log.whale(
      `CONFIRMED whale ${whaleTrade.side} on "${whaleTrade.title}" ` +
      `[${whaleTrade.outcome}] @ ${whaleTrade.price} (${whaleTrade.size} shares)`
    );

    // Execute our copy trade
    await executeCopyTrade(this.clobClient, whaleTrade);
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, CONFIG.WS_PING_INTERVAL_MS);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  cleanup() {
    this.stopPing();
  }

  scheduleReconnect() {
    if (this.isShuttingDown) return;

    this.reconnectAttempt++;
    const delay = Math.min(
      CONFIG.WS_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      CONFIG.WS_RECONNECT_MAX_MS
    );
    log.ws(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${this.reconnectAttempt})...`);
    setTimeout(() => this.connect(), delay);
  }

  shutdown() {
    this.isShuttingDown = true;
    this.cleanup();
    if (this.positionRefreshInterval) {
      clearInterval(this.positionRefreshInterval);
    }
    if (this.ws) {
      this.ws.close(1000, "Bot shutting down");
    }
    log.info("Bot shut down gracefully.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  validateEnv();

  const { client: clobClient, myAddress } = await createClobClient();

  const watcher = new WhaleWatcher(clobClient, myAddress);

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = () => {
    log.info("Received shutdown signal...");
    watcher.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Catch unhandled rejections to prevent silent crashes
  process.on("unhandledRejection", (err) => {
    log.error(`Unhandled rejection: ${err}`);
  });

  await watcher.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  console.error(err);
  process.exit(1);
});
