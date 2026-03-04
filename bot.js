// ═══════════════════════════════════════════════════════════════════════════════
// Polymarket Whale Copy-Trader Bot  (v3.1 — Production-Ready)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Monitors an array of whale addresses on Polymarket and mirrors their trades
// in real-time as $1.00 FOK (Fill-or-Kill) market orders.
//
// v3.1 — production polish:
//   • pollAllWhaleActivity: public method name for the core polling loop
//   • [HEARTBEAT] every 10s with exact format:
//       Whales Scanned | Total Assets Hooked | Last API Response | Memory
//   • [TRADE SIGNAL] bold banner on every detection BEFORE order placement
//   • Verbose WebSocket reconnect: every attempt logged with delay + attempt #
//   • Kept: HTTP heartbeat :3000, trades.json, liquidity engine, hardened gate
//
// v3.0 — architectural overhaul:
//   The /positions endpoint returns empty arrays for many CLOB-native whales.
//   This version ABANDONS position-fetching as the primary discovery mechanism
//   and replaces it with a high-frequency Activity Poller that hits the
//   /activity?type=TRADE endpoint for every whale every 2 seconds.
//
//   When a new trade appears in any whale's activity feed the bot:
//     1. Instantly adds that asset_id to the Global Watchlist
//     2. Hot-subscribes it on the Market WebSocket for future price signals
//     3. Fires a copy-trade immediately — no waiting for a WS echo
//
//   The WebSocket remains as a secondary detection path: if an already-watched
//   asset fires a `last_trade_price` event the bot still verifies and copies.
//
//   This means the bot is NEVER idle — it is always polling, always watching.
//
// Preserved from v2.x:
//   • HTTP heartbeat on PORT (Render free-tier keep-alive)
//   • trades.json persistence layer (crash recovery)
//   • Liquidity engine (order book depth analysis via getOrderBook)
//   • Hardened success gate (response.success === true only)
//   • Multi-whale support from comma-separated env var
// ═══════════════════════════════════════════════════════════════════════════════

import "dotenv/config";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
function parseWhaleAddresses() {
  const raw =
    process.env.WHALE_ADDRESSES ||
    process.env.WHALE_ADDRESS ||
    "0xc088343e85E0Bd8334e662D358Ad92aeC5F945CA";

  return [...new Set(
    raw
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0),
  )];
}

const CONFIG = Object.freeze({
  // Polymarket endpoints
  CLOB_HOST: "https://clob.polymarket.com",
  WS_URL: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  DATA_API: "https://data-api.polymarket.com",
  GAMMA_API: "https://gamma-api.polymarket.com",
  CHAIN_ID: 137,

  // Target whales
  WHALE_ADDRESSES: parseWhaleAddresses(),

  // Trade sizing
  TRADE_AMOUNT_USD: 1.0,

  // Slippage
  MAX_SLIPPAGE: 0.05,
  MAX_SLIPPAGE_PCT: 0.01,

  // ── Activity Poller (the new primary detection engine) ──
  ACTIVITY_POLL_INTERVAL_MS: 2_000,   // poll every whale every 2 seconds
  ACTIVITY_LOOKBACK_SEC: 10,          // only consider trades from last 10s
  ACTIVITY_LIMIT: 5,                  // fetch 5 most recent trades per whale
  ACTIVITY_FETCH_TIMEOUT_MS: 8_000,   // per-request timeout

  // WebSocket
  WS_RECONNECT_BASE_MS: 1_000,
  WS_RECONNECT_MAX_MS: 30_000,
  WS_PING_INTERVAL_MS: 15_000,

  // Dedup — widened to 10s so the Activity Poller and WS path don't double-fire
  DEDUP_WINDOW_MS: 10_000,

  // [HEARTBEAT] log interval — proves the bot is alive in Render logs
  HEARTBEAT_LOG_INTERVAL_MS: 10_000,

  // Persistence
  TRADES_DB_PATH: path.resolve(process.cwd(), "trades.json"),

  // Render heartbeat
  HEARTBEAT_PORT: parseInt(process.env.PORT, 10) || 3000,
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
// Logging  (with colour-coded BUY / SELL helpers)
// ─────────────────────────────────────────────────────────────────────────────
const log = {
  info:  (msg, ...a) => console.log(`[${ts()}] ℹ️  ${msg}`, ...a),
  trade: (msg, ...a) => console.log(`[${ts()}] 💰 ${msg}`, ...a),
  whale: (msg, ...a) => console.log(`[${ts()}] 🐋 ${msg}`, ...a),
  warn:  (msg, ...a) => console.warn(`[${ts()}] ⚠️  ${msg}`, ...a),
  error: (msg, ...a) => console.error(`[${ts()}] ❌ ${msg}`, ...a),
  ws:    (msg, ...a) => console.log(`[${ts()}] 🔌 ${msg}`, ...a),
  db:    (msg, ...a) => console.log(`[${ts()}] 💾 ${msg}`, ...a),
  hb:    (msg, ...a) => console.log(`[${ts()}] 💓 ${msg}`, ...a),
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

/** Returns 🟢 for BUY, 🔴 for SELL */
function sideEmoji(side) {
  return side === "BUY" ? "🟢" : "🔴";
}

/** Truncated whale address tag for log readability */
function wTag(addr) {
  if (!addr) return "whale(?)";
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Heartbeat — prevents Render "Port Scan Timeout"  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function startHeartbeatServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      whales: CONFIG.WHALE_ADDRESSES.length,
    }));
  });

  server.listen(CONFIG.HEARTBEAT_PORT, () => {
    log.info(`Heartbeat HTTP server listening on :${CONFIG.HEARTBEAT_PORT}`);
  });

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Persistence Layer — trades.json  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
class TradeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.trades = [];
    this._writeLock = false;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.trades = parsed;
          log.db(`Loaded ${this.trades.length} historical trade(s) from ${this.filePath}`);
          return;
        }
      }
    } catch (err) {
      log.warn(`Could not parse ${this.filePath}, starting fresh: ${err.message}`);
    }
    this.trades = [];
    log.db("No prior trade history found — starting with empty ledger.");
  }

  async record(entry) {
    this.trades.push({ ...entry, filledAt: new Date().toISOString() });
    await this._flush();
    log.db(
      `Persisted fill #${this.trades.length}: ${entry.side} ` +
      `${entry.assetID?.slice(0, 12)}… from whale ${entry.whaleAddress?.slice(0, 10)}…`,
    );
  }

  tradesForAsset(assetID) {
    return this.trades.filter((t) => t.assetID === assetID);
  }

  async _flush() {
    if (this._writeLock) return;
    this._writeLock = true;
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.trades, null, 2), "utf-8");
    } catch (err) {
      log.error(`Failed to write ${this.filePath}: ${err.message}`);
    } finally {
      this._writeLock = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOB Client Initialization
// ─────────────────────────────────────────────────────────────────────────────
async function createClobClient() {
  const signer = new Wallet(process.env.PRIVATE_KEY);
  const myAddress = (await signer.getAddress()).toLowerCase();

  if (CONFIG.WHALE_ADDRESSES.includes(myAddress)) {
    console.error("═══════════════════════════════════════════════════════════");
    console.error("🛑  SELF-TRADE PREVENTION TRIGGERED");
    console.error("    Your wallet address matches one of the target whales.");
    console.error(`    Your address:  ${myAddress}`);
    console.error("═══════════════════════════════════════════════════════════");
    process.exit(1);
  }

  const creds = {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  const client = new ClobClient(
    CONFIG.CLOB_HOST,
    CONFIG.CHAIN_ID,
    signer,
    creds,
    0, // signatureType: 0 = EOA
  );

  const ok = await client.getOk();
  if (ok !== "OK") throw new Error(`CLOB health check failed: ${ok}`);

  log.info(`CLOB client initialized — your address: ${myAddress}`);
  return { client, myAddress };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gamma Market Info  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity Engine — Order Book Depth  (uses getOrderBook)
// ─────────────────────────────────────────────────────────────────────────────
async function checkLiquidity(clobClient, asset, side, whalePrice) {
  let orderBook;
  try {
    orderBook = await clobClient.getOrderBook(asset);
  } catch (err) {
    return { ok: false, reason: `Order book fetch failed: ${err.message}` };
  }

  if (!orderBook) return { ok: false, reason: "Order book returned null/undefined" };

  const levels = side === "BUY"
    ? (orderBook.asks || [])
    : (orderBook.bids || []);

  if (levels.length === 0) {
    return { ok: false, reason: "No liquidity on relevant side of book" };
  }

  const maxDev = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  const ceiling = side === "BUY" ? Math.min(whalePrice + maxDev, 0.99) : whalePrice;
  const floor   = side === "BUY" ? whalePrice : Math.max(whalePrice - maxDev, 0.01);

  let fillVol = 0, shares = 0, cost = 0;

  for (const lv of levels) {
    const lp = parseFloat(lv.price);
    const ls = parseFloat(lv.size);

    if (side === "BUY"  && lp > ceiling) break;
    if (side === "SELL" && lp < floor)   break;

    const notional  = lp * ls;
    const remaining = CONFIG.TRADE_AMOUNT_USD - fillVol;
    const takeUSD   = Math.min(notional, remaining);
    const takeSh    = takeUSD / lp;

    fillVol += takeUSD;
    shares  += takeSh;
    cost    += takeSh * lp;

    if (fillVol >= CONFIG.TRADE_AMOUNT_USD) break;
  }

  const effectivePrice = shares > 0 ? cost / shares : 0;

  if (fillVol < CONFIG.TRADE_AMOUNT_USD) {
    return {
      ok: false,
      reason: `Only $${fillVol.toFixed(4)} fillable in 1% band (need $${CONFIG.TRADE_AMOUNT_USD})`,
      fillableVolume: fillVol,
      effectivePrice,
    };
  }

  return { ok: true, effectivePrice, fillableVolume: fillVol };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade Execution Engine  (dedup, liquidity check, hardened success gate)
// ─────────────────────────────────────────────────────────────────────────────
const recentTrades = new Map(); // dedup: "assetId:side" → timestamp

function isDuplicate(assetId, side) {
  const key = `${assetId}:${side}`;
  const last = recentTrades.get(key);
  const now = Date.now();
  if (last && now - last < CONFIG.DEDUP_WINDOW_MS) return true;
  recentTrades.set(key, now);
  // Prune old entries
  for (const [k, v] of recentTrades) {
    if (now - v > CONFIG.DEDUP_WINDOW_MS * 2) recentTrades.delete(k);
  }
  return false;
}

async function executeCopyTrade(clobClient, whaleTrade, tradeStore) {
  const { side, price, asset, conditionId, outcome, title, whaleAddress } = whaleTrade;

  if (isDuplicate(asset, side)) {
    log.warn(`Dedup: skipping duplicate ${side} on "${title}" (${outcome})`);
    return;
  }

  const tag = wTag(whaleAddress);
  const emoji = sideEmoji(side);

  console.log(
    `[${ts()}] ${emoji} COPY-TRADE TRIGGERED — ${tag} ${side} ` +
    `"${title}" [${outcome}] @ ${price}`,
  );

  // ── Step 1: Market metadata ──
  const marketInfo = await fetchMarketInfo(conditionId);
  if (!marketInfo) {
    log.error(`Cannot fetch market info for conditionId=${conditionId} — skipping`);
    return;
  }

  // ── Step 2: Liquidity pre-flight ──
  const whalePrice = parseFloat(price);
  const liquidity = await checkLiquidity(clobClient, asset, side, whalePrice);

  if (!liquidity.ok) {
    log.warn(
      `⛔ LIQUIDITY WARNING: Spread too wide — skipping ${side} on "${title}" [${outcome}]`,
    );
    log.warn(
      `   Reason: ${liquidity.reason} | whalePrice=${whalePrice.toFixed(4)} | ` +
      `1% band=±${(whalePrice * CONFIG.MAX_SLIPPAGE_PCT).toFixed(4)}`,
    );
    return;
  }

  // ── Step 3: Compute worst acceptable price ──
  const maxDev = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  const worstPrice = side === "BUY"
    ? Math.min(whalePrice + maxDev, 0.99)
    : Math.max(whalePrice - maxDev, 0.01);

  const orderSide = side === "BUY" ? Side.BUY : Side.SELL;

  log.trade(
    `Placing FOK ${side} | $${CONFIG.TRADE_AMOUNT_USD} USDC | ` +
    `token=${asset.slice(0, 12)}… | worst=${worstPrice.toFixed(4)} | ` +
    `tick=${marketInfo.tickSize} | negRisk=${marketInfo.negRisk} | ` +
    `depth=$${liquidity.fillableVolume.toFixed(4)} | via ${tag}`,
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
      OrderType.FOK,
    );

    // ── Hardened success gate ──
    if (
      response &&
      typeof response === "object" &&
      response.success === true
    ) {
      const orderId = response.orderID || response.orderIds?.[0] || "N/A";
      console.log(
        `[${ts()}] ${emoji} ✅ FILLED — ${side} "${title}" [${outcome}] | ` +
        `orderID=${orderId} | via ${tag}`,
      );

      await tradeStore.record({
        orderID: orderId,
        price: worstPrice,
        side,
        whaleAddress: whaleAddress || "unknown",
        assetID: asset,
        title,
        outcome,
      });
    } else {
      const reason =
        response?.errorMsg || response?.error ||
        response?.message  || JSON.stringify(response);
      const status = response?.status || response?.statusCode || "";
      log.error(
        `Order NOT confirmed — ${side} "${title}" [${outcome}] | ` +
        `status=${status} | reason=${reason}`,
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
      `🚫 ACCESS DENIED (403) — your IP may be geoblocked. ` +
      `${side} "${title}" [${outcome}] was NOT executed.`,
    );
  } else if (msg.includes("not enough balance") || msg.includes("insufficient")) {
    log.error(
      `💸 INSUFFICIENT FUNDS — cannot ${side} "${title}" [${outcome}]. Top up USDC.e.`,
    );
  } else if (msg.includes("slippage") || msg.includes("FOK") || msg.includes("not enough liquidity")) {
    log.error(
      `📉 SLIPPAGE/LIQUIDITY — FOK for "${title}" [${outcome}] could not fill.`,
    );
  } else if (msg.includes("rate limit") || msg.includes("429")) {
    log.error(`⏳ RATE LIMITED — will retry on next signal.`);
  } else {
    log.error(`Order failed for "${title}" [${outcome}]: ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVITY POLLER — Primary Detection Engine
// ═══════════════════════════════════════════════════════════════════════════════
// Every ACTIVITY_POLL_INTERVAL_MS (2s), we hit:
//   /activity?user={addr}&type=TRADE&limit=5&start={now-10s}
// for every whale in parallel.
//
// We fingerprint each trade with a composite key:
//   `${whaleAddr}:${asset}:${side}:${timestamp}`
// and compare against a seen-set.  When a NEW trade appears:
//   1. Log it with 🟢 BUY / 🔴 SELL colour coding
//   2. Add the asset to the Global Watchlist
//   3. Hot-subscribe it on the WebSocket (via callback)
//   4. Fire executeCopyTrade immediately — no WS echo needed
//
// The poller is ALWAYS running.  There is no idle state.
// ═══════════════════════════════════════════════════════════════════════════════
class ActivityPoller {
  /**
   * @param {Object}     clobClient  — authenticated CLOB client
   * @param {TradeStore}  tradeStore  — persistence layer
   * @param {Function}    onNewAsset  — callback(assetId) to hot-subscribe on WS
   */
  constructor(clobClient, tradeStore, onNewAsset) {
    this.clobClient = clobClient;
    this.tradeStore = tradeStore;
    this.onNewAsset = onNewAsset;

    // Fingerprint set: tracks which exact trade events we've already processed
    // Key format: "whaleAddr:assetId:side:timestamp"
    this.seenTrades = new Set();

    // Global Watchlist: every asset_id the bot has ever seen a whale touch.
    // Grows monotonically within a session — assets are never removed.
    this.watchlist = new Set();

    // Stats exposed to the pulse log
    this.pollCount = 0;
    this.lastPollTs = 0;
    this.signalsDetected = 0;

    this._pollTimer = null;
    this._isPolling = false; // overlap guard
  }

  start() {
    log.info(
      `Activity Poller started — polling ${CONFIG.WHALE_ADDRESSES.length} whale(s) ` +
      `every ${CONFIG.ACTIVITY_POLL_INTERVAL_MS / 1000}s`,
    );
    // Fire the first poll immediately, then repeat on the interval
    this.pollAllWhaleActivity();
    this._pollTimer = setInterval(() => this.pollAllWhaleActivity(), CONFIG.ACTIVITY_POLL_INTERVAL_MS);
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── Core poll cycle — public name for external reference ──
  async pollAllWhaleActivity() {
    if (this._isPolling) return;   // previous cycle still in-flight
    this._isPolling = true;

    try {
      const results = await Promise.allSettled(
        CONFIG.WHALE_ADDRESSES.map((addr) => this._pollOneWhale(addr)),
      );

      for (const r of results) {
        if (r.status === "rejected") {
          log.warn(`Activity poll error: ${r.reason}`);
        }
      }

      this.pollCount++;
      this.lastPollTs = Date.now();
    } finally {
      this._isPolling = false;
    }

    // Periodic housekeeping on the seen-set
    this._pruneSeenTrades();
  }

  // ── Fetch recent activity for one whale and process new trades ──
  async _pollOneWhale(addr) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - CONFIG.ACTIVITY_LOOKBACK_SEC;

    const url =
      `${CONFIG.DATA_API}/activity` +
      `?user=${addr}` +
      `&type=TRADE` +
      `&limit=${CONFIG.ACTIVITY_LIMIT}` +
      `&start=${start}` +
      `&sortBy=TIMESTAMP&sortDirection=DESC`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.ACTIVITY_FETCH_TIMEOUT_MS);

    let activities;
    try {
      const resp = await fetch(url, { signal: controller.signal });

      if (!resp.ok) {
        log.warn(`Activity API returned ${resp.status} for ${wTag(addr)}`);
        return;
      }

      activities = await resp.json();
    } catch (err) {
      if (err.name === "AbortError") {
        log.warn(`Activity poll timed out for ${wTag(addr)}`);
      } else {
        log.warn(`Activity poll failed for ${wTag(addr)}: ${err.message}`);
      }
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!Array.isArray(activities) || activities.length === 0) return;

    for (const act of activities) {
      if (!act.asset || !act.side || !act.price) continue;

      // Composite fingerprint for this exact trade event
      const tradeKey =
        `${addr}:${act.asset}:${act.side}:${act.timestamp || act.createdAt || ""}`;

      if (this.seenTrades.has(tradeKey)) continue;
      this.seenTrades.add(tradeKey);

      // ──────────────────────────────────────────────────────────
      //  [TRADE SIGNAL] — BOLD banner logged BEFORE order is sent
      // ──────────────────────────────────────────────────────────
      this.signalsDetected++;

      const emoji = sideEmoji(act.side);
      const tag = wTag(addr);

      console.log("");
      console.log(`[${ts()}] ═══════════════════════════════════════════════════`);
      console.log(`[${ts()}] ${emoji}  [TRADE SIGNAL]  ${act.side}  ${emoji}`);
      console.log(`[${ts()}]    Whale:   ${tag}`);
      console.log(`[${ts()}]    Market:  "${act.title || "?"}"`);
      console.log(`[${ts()}]    Side:    ${act.side}  [${act.outcome || "?"}]`);
      console.log(`[${ts()}]    Price:   ${act.price}  (${act.size || "?"} shares)`);
      console.log(`[${ts()}]    Asset:   ${act.asset?.slice(0, 20)}…`);
      console.log(`[${ts()}] ═══════════════════════════════════════════════════`);
      console.log("");

      // Add to global watchlist + hot-subscribe on WS if first time seeing it
      const isNewAsset = !this.watchlist.has(act.asset);
      this.watchlist.add(act.asset);
      if (isNewAsset) {
        this.onNewAsset(act.asset);
      }

      // Build the trade object for executeCopyTrade
      const whaleTrade = {
        whaleAddress: addr,
        side: act.side,
        price: act.price,
        size: act.size,
        asset: act.asset,
        conditionId: act.conditionId,
        outcome: act.outcome || "Unknown",
        title: act.title || "Unknown Market",
        slug: act.slug || "",
      };

      // Fire immediately — don't wait for a WebSocket echo.
      // Errors are caught internally by executeCopyTrade.
      executeCopyTrade(this.clobClient, whaleTrade, this.tradeStore).catch((err) => {
        log.error(`Copy-trade execution error: ${err.message}`);
      });
    }
  }

  // ── Prune the seen-set periodically so it doesn't grow unbounded ──
  _pruneSeenTrades() {
    if (this.pollCount % 50 !== 0) return; // every ~100s at 2s interval
    const maxSize = CONFIG.WHALE_ADDRESSES.length * CONFIG.ACTIVITY_LIMIT * 120;
    if (this.seenTrades.size > maxSize) {
      log.info(`Pruning seen-trades set (was ${this.seenTrades.size} entries)`);
      this.seenTrades.clear();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WHALE WATCHER  — WebSocket manager + orchestrator
// ═══════════════════════════════════════════════════════════════════════════════
// The WebSocket is kept PERMANENTLY open.  It never idles, never says
// "no positions".  Assets are added on-the-fly by the Activity Poller via
// hotSubscribe().
//
// If a `last_trade_price` event fires on an already-subscribed asset, the bot
// verifies which whale traded and copies — this provides a secondary signal
// path in case the Activity Poller is between poll cycles.
// ═══════════════════════════════════════════════════════════════════════════════
class WhaleWatcher {
  constructor(clobClient, myAddress, tradeStore) {
    this.clobClient = clobClient;
    this.myAddress = myAddress;
    this.tradeStore = tradeStore;

    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempt = 0;
    this.subscribedAssets = new Set();
    this.isShuttingDown = false;
    this._processingLock = new Set();

    // Activity Poller — primary detection engine
    this.activityPoller = new ActivityPoller(
      clobClient,
      tradeStore,
      (assetId) => this.hotSubscribe(assetId), // callback to subscribe new assets
    );

    // Heartbeat timer
    this._heartbeatInterval = null;
  }

  async start() {
    log.info("═══════════════════════════════════════════════════════════");
    log.info("  Polymarket Whale Copy-Trader Bot  v3.1  (Production-Ready)");
    log.info("═══════════════════════════════════════════════════════════");
    log.info(`  Tracking ${CONFIG.WHALE_ADDRESSES.length} whale(s):`);
    for (const addr of CONFIG.WHALE_ADDRESSES) {
      log.info(`    • ${addr}`);
    }
    log.info(`  Detection:      Activity polling every ${CONFIG.ACTIVITY_POLL_INTERVAL_MS / 1000}s`);
    log.info(`  Trade amount:   $${CONFIG.TRADE_AMOUNT_USD} USDC (FOK)`);
    log.info(`  Max slippage:   ${(CONFIG.MAX_SLIPPAGE_PCT * 100).toFixed(1)}% (order book depth)`);
    log.info(`  Dedup window:   ${CONFIG.DEDUP_WINDOW_MS / 1000}s`);
    log.info(`  Your address:   ${this.myAddress}`);
    log.info(`  Trade history:  ${this.tradeStore.trades.length} prior fill(s) loaded`);
    log.info("═══════════════════════════════════════════════════════════");

    // 1. Open WebSocket immediately (always-on, even with 0 assets)
    this.connect();

    // 2. Start Activity Poller — the primary eye
    this.activityPoller.start();

    // 3. Start the 10-second [HEARTBEAT] logger
    this._startHeartbeat();
  }

  // ── Hot-subscribe: called by Activity Poller when a new asset is discovered ──
  hotSubscribe(assetId) {
    if (this.subscribedAssets.has(assetId)) return;
    this.subscribedAssets.add(assetId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        assets_ids: [assetId],
        type: "market",
        custom_feature_enabled: true,
      });
      this.ws.send(msg);
      log.ws(`Hot-subscribed new asset ${assetId.slice(0, 16)}…`);
    }
  }

  // ── WebSocket lifecycle ──

  connect() {
    if (this.isShuttingDown) return;

    const attempt = this.reconnectAttempt || 0;
    const attemptTag = attempt > 0 ? ` (reconnect #${attempt})` : " (initial)";

    log.ws(`Connecting to ${CONFIG.WS_URL}…${attemptTag}`);
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.on("open", () => {
      log.ws(`✅ WebSocket CONNECTED${attemptTag} — ready to receive events`);
      this.reconnectAttempt = 0;
      this._resubscribeAll();
      this._startPing();
    });

    this.ws.on("message", (raw) => {
      this._handleMessage(raw);
    });

    this.ws.on("close", (code, reason) => {
      log.ws(`❌ WebSocket CLOSED — code=${code} reason="${reason || "none"}"${attemptTag}`);
      this._stopPing();
      this._scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      log.error(`WebSocket ERROR${attemptTag}: ${err.message}`);
    });
  }

  /** After a reconnect, re-subscribe all assets the Activity Poller has found */
  _resubscribeAll() {
    const ids = [...this.subscribedAssets];
    if (ids.length === 0) {
      log.ws(
        "WebSocket open — 0 assets subscribed yet. " +
        "Activity Poller will add them as whales trade.",
      );
      return;
    }

    const msg = JSON.stringify({
      assets_ids: ids,
      type: "market",
      custom_feature_enabled: true,
    });
    this.ws.send(msg);
    log.ws(`Re-subscribed to ${ids.length} asset(s) after reconnect`);
  }

  // ── WS message handling (secondary detection path) ──

  async _handleMessage(raw) {
    let data;
    try {
      const text = typeof raw === "string" ? raw : raw.toString();
      data = JSON.parse(text);
    } catch {
      return;
    }

    if (Array.isArray(data)) {
      await Promise.allSettled(data.map((e) => this._processWsEvent(e)));
    } else {
      await this._processWsEvent(data);
    }
  }

  async _processWsEvent(event) {
    if (event.event_type !== "last_trade_price") return;

    const assetId = event.asset_id;
    if (!assetId || !this.subscribedAssets.has(assetId)) return;

    // Per-asset lock — prevents races
    if (this._processingLock.has(assetId)) return;
    this._processingLock.add(assetId);

    try {
      // The Activity Poller has most likely already caught this trade and
      // fired executeCopyTrade.  The dedup window (10s) will absorb the
      // duplicate.  But if the poller was between cycles, this catches it.
      const whaleTrade = await this._verifyAnyWhaleTrade(assetId);
      if (!whaleTrade) return;

      const emoji = sideEmoji(whaleTrade.side);
      const tag = wTag(whaleTrade.whaleAddress);

      console.log(
        `[${ts()}] ${emoji} 🔌 WS SIGNAL (secondary) — ${tag} ${whaleTrade.side} ` +
        `"${whaleTrade.title}" [${whaleTrade.outcome}] @ ${whaleTrade.price}`,
      );

      await executeCopyTrade(this.clobClient, whaleTrade, this.tradeStore);
    } finally {
      this._processingLock.delete(assetId);
    }
  }

  /** Check all whales' recent activity for a matching trade on this asset */
  async _verifyAnyWhaleTrade(assetId) {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 30;

    const results = await Promise.allSettled(
      CONFIG.WHALE_ADDRESSES.map(async (addr) => {
        const url =
          `${CONFIG.DATA_API}/activity?user=${addr}` +
          `&type=TRADE&start=${start}` +
          `&sortBy=TIMESTAMP&sortDirection=DESC`;

        const resp = await fetch(url);
        if (!resp.ok) return null;

        const acts = await resp.json();
        const match = acts.find((a) => a.asset === assetId);
        if (match) {
          return {
            whaleAddress: addr,
            side: match.side,
            price: match.price,
            size: match.size,
            asset: match.asset,
            conditionId: match.conditionId,
            outcome: match.outcome,
            title: match.title,
            slug: match.slug,
          };
        }
        return null;
      }),
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) return r.value;
    }
    return null;
  }

  // ── 10-second [HEARTBEAT] log — never-silent proof of life ──

  _startHeartbeat() {
    this._heartbeatInterval = setInterval(() => {
      const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const lastResp = this.activityPoller.lastPollTs > 0
        ? new Date(this.activityPoller.lastPollTs).toISOString().slice(11, 23)
        : "pending…";

      log.hb(
        `[HEARTBEAT] Whales Scanned: ${CONFIG.WHALE_ADDRESSES.length} | ` +
        `Total Assets Hooked: ${this.subscribedAssets.size} | ` +
        `Last API Response: ${lastResp} | ` +
        `Memory: ${memMB}MB`,
      );
    }, CONFIG.HEARTBEAT_LOG_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  // ── Ping / Reconnect ──

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, CONFIG.WS_PING_INTERVAL_MS);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.isShuttingDown) return;

    this.reconnectAttempt++;
    const delay = Math.min(
      CONFIG.WS_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      CONFIG.WS_RECONNECT_MAX_MS,
    );
    log.ws(
      `🔄 RECONNECT SCHEDULED — attempt #${this.reconnectAttempt} ` +
      `in ${(delay / 1000).toFixed(1)}s ` +
      `(backoff: ${CONFIG.WS_RECONNECT_BASE_MS}ms × 2^${this.reconnectAttempt - 1}, ` +
      `cap: ${CONFIG.WS_RECONNECT_MAX_MS / 1000}s)`,
    );
    setTimeout(() => {
      log.ws(
        `🔄 RECONNECT FIRING NOW — attempt #${this.reconnectAttempt} | ` +
        `${this.subscribedAssets.size} asset(s) to re-subscribe`,
      );
      this.connect();
    }, delay);
  }

  // ── Graceful shutdown ──

  shutdown() {
    this.isShuttingDown = true;
    this._stopPing();
    this._stopHeartbeat();
    this.activityPoller.stop();
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

  // ── HTTP heartbeat (Render port scan prevention) ──
  startHeartbeatServer();

  // ── Load persistent trade history ──
  const tradeStore = new TradeStore(CONFIG.TRADES_DB_PATH);
  tradeStore.load();

  // ── Initialize CLOB client ──
  const { client: clobClient, myAddress } = await createClobClient();

  // ── Start watcher ──
  const watcher = new WhaleWatcher(clobClient, myAddress, tradeStore);

  // Graceful shutdown
  const shutdown = () => {
    log.info("Received shutdown signal…");
    watcher.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
