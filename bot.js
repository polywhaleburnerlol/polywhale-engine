// ═══════════════════════════════════════════════════════════════════════════════
// Polymarket Whale Copy-Trader Bot  (v2.1 — Paginated Discovery, Status Heartbeat)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Monitors an array of whale addresses on Polymarket via WebSocket and mirrors
// their trades in real-time as $1.00 FOK (Fill-or-Kill) market orders.
//
// v2.0 changes:
//   • Multi-whale portfolio — tracks N whales from a comma-separated env var
//   • Order book via clobClient.getSnapshot() (fixes getMarketOrderBook crash)
//   • State persistence — filled orders saved to trades.json, loaded on boot
//   • HTTP heartbeat — keeps Render's free tier from timing out on port scan
//   • Hardened success check — only logs FILLED when response.success === true
//
// v2.1 changes:
//   • Paginated position discovery — loops offset/limit to get ALL positions
//   • Retry mechanism — 2 retries with 2s delay on 400/timeout per whale
//   • Status heartbeat — logs monitoring status every 5s when idle
//   • Diagnostic verbosity — dumps raw API response when 0 assets found
//
// Architecture:
//   1. Bootstraps every whale's current open positions from the Data API
//   2. Opens a single CLOB Market WebSocket subscribed to the union of all
//      whale asset_ids
//   3. When a trade event fires, checks each whale via the Data API
//   4. Executes a $1.00 FOK market order copying the whale's direction
//   5. Persists every confirmed fill to trades.json for crash recovery
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
// WHALE_ADDRESSES: comma-separated list in .env, e.g.
//   WHALE_ADDRESSES=0xabc...,0xdef...,0x123...
// Falls back to the single WHALE_ADDRESS var for backwards compatibility.
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

  // Target whales to copy (array of lowercase addresses)
  WHALE_ADDRESSES: parseWhaleAddresses(),

  // Trade sizing — spend exactly $1.00 USDC per copied trade
  TRADE_AMOUNT_USD: 1.0,

  // Static slippage ceiling (kept as a hard-cap safety net)
  MAX_SLIPPAGE: 0.05,

  // Liquidity engine: order book must fill within this % of whale's price
  MAX_SLIPPAGE_PCT: 0.01,

  // How often to refresh whale positions to discover new markets (ms)
  POSITION_REFRESH_INTERVAL_MS: 60_000,

  // WebSocket reconnection
  WS_RECONNECT_BASE_MS: 1_000,
  WS_RECONNECT_MAX_MS: 30_000,
  WS_PING_INTERVAL_MS: 15_000,

  // Dedup window: ignore duplicate trade signals within this window (ms)
  DEDUP_WINDOW_MS: 5_000,

  // Pagination settings for Data API /positions
  POSITIONS_PAGE_LIMIT: 100,       // items per page (API default max)

  // Retry settings for whale position fetches
  FETCH_MAX_RETRIES: 2,            // retry up to 2× on 400/timeout
  FETCH_RETRY_DELAY_MS: 2_000,     // wait 2s between retries
  FETCH_TIMEOUT_MS: 15_000,        // per-request timeout

  // Status heartbeat interval (passive monitoring log)
  STATUS_LOG_INTERVAL_MS: 5_000,

  // Persistence file path
  TRADES_DB_PATH: path.resolve(process.cwd(), "trades.json"),

  // HTTP heartbeat port (Render expects a listening port)
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
// Logging
// ─────────────────────────────────────────────────────────────────────────────
const log = {
  info:  (msg, ...a) => console.log(`[${ts()}] ℹ️  ${msg}`, ...a),
  trade: (msg, ...a) => console.log(`[${ts()}] 💰 ${msg}`, ...a),
  whale: (msg, ...a) => console.log(`[${ts()}] 🐋 ${msg}`, ...a),
  warn:  (msg, ...a) => console.warn(`[${ts()}] ⚠️  ${msg}`, ...a),
  error: (msg, ...a) => console.error(`[${ts()}] ❌ ${msg}`, ...a),
  ws:    (msg, ...a) => console.log(`[${ts()}] 🔌 ${msg}`, ...a),
  db:    (msg, ...a) => console.log(`[${ts()}] 💾 ${msg}`, ...a),
};
function ts() {
  return new Date().toISOString().slice(11, 23);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Heartbeat — prevents Render "Port Scan Timeout"
// ─────────────────────────────────────────────────────────────────────────────
// Uses Node's built-in http module — no Express dependency needed.
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
// State Persistence Layer — trades.json
// ─────────────────────────────────────────────────────────────────────────────
// Schema per entry:
//   { orderID, price, side, whaleAddress, assetID, title, outcome, filledAt }
//
// On startup the bot loads the file so it knows its current holdings even
// after a Render free-tier restart / crash.
// ─────────────────────────────────────────────────────────────────────────────
class TradeStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.trades = [];        // in-memory mirror of trades.json
    this._writeLock = false; // simple guard against concurrent writes
  }

  /** Load existing trades.json into memory (safe on first boot / missing file) */
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

  /** Append a filled trade and flush to disk */
  async record(entry) {
    this.trades.push({ ...entry, filledAt: new Date().toISOString() });
    await this._flush();
    log.db(
      `Persisted fill #${this.trades.length}: ${entry.side} ` +
      `${entry.assetID?.slice(0, 12)}… from whale ${entry.whaleAddress?.slice(0, 10)}…`,
    );
  }

  /** Return all trades for a given asset (useful for position awareness) */
  tradesForAsset(assetID) {
    return this.trades.filter((t) => t.assetID === assetID);
  }

  /** Serialise-safe write with basic lock to avoid concurrent corruptions */
  async _flush() {
    if (this._writeLock) return;
    this._writeLock = true;
    try {
      const data = JSON.stringify(this.trades, null, 2);
      fs.writeFileSync(this.filePath, data, "utf-8");
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

  // ── Self-Trade Prevention (checks against ALL tracked whales) ──
  if (CONFIG.WHALE_ADDRESSES.includes(myAddress)) {
    console.error("═══════════════════════════════════════════════════════════");
    console.error("🛑  SELF-TRADE PREVENTION TRIGGERED");
    console.error("    Your wallet address matches one of the target whales.");
    console.error("    This would create an infinite copy-trade loop.");
    console.error(`    Your address:  ${myAddress}`);
    console.error("═══════════════════════════════════════════════════════════");
    process.exit(1);
  }

  const creds = {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };

  const signatureType = 0; // 0 = EOA, 1 = Magic/Email proxy

  const client = new ClobClient(
    CONFIG.CLOB_HOST,
    CONFIG.CHAIN_ID,
    signer,
    creds,
    signatureType,
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
// Whale Position Discovery  (multi-whale, paginated, with retries)
// ─────────────────────────────────────────────────────────────────────────────
// For each whale:
//   1. Paginates through the Data API /positions endpoint (offset + limit)
//      until an empty page is returned, collecting ALL active positions.
//   2. Retries up to FETCH_MAX_RETRIES times on 400s / timeouts / network
//      errors, with a FETCH_RETRY_DELAY_MS pause between attempts.
//   3. Logs the raw API response body when a whale yields 0 assets so you
//      can diagnose exactly what the API is returning.
//
// Returns a single merged Map of asset_id → metadata across all whales.
// ─────────────────────────────────────────────────────────────────────────────

/** Sleep helper */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a single page of positions for one whale with timeout support.
 * Returns the parsed JSON array, or throws on failure.
 */
async function fetchPositionsPage(addr, offset, limit) {
  const url =
    `${CONFIG.DATA_API}/positions` +
    `?user=${addr}` +
    `&offset=${offset}` +
    `&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "(unreadable)");
      const err = new Error(
        `HTTP ${resp.status} from /positions for ${addr} ` +
        `(offset=${offset}): ${body}`,
      );
      err.status = resp.status;
      err.body = body;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch ALL positions for a single whale, paginating until the API returns
 * an empty page.  Retries on transient errors (400, timeout, network).
 */
async function fetchWhalePositionsPaginated(addr) {
  const allPositions = [];
  let offset = 0;
  const limit = CONFIG.POSITIONS_PAGE_LIMIT;

  // Outer loop: pages
  while (true) {
    let page = null;
    let lastError = null;

    // Inner loop: retries per page
    for (let attempt = 0; attempt <= CONFIG.FETCH_MAX_RETRIES; attempt++) {
      try {
        page = await fetchPositionsPage(addr, offset, limit);
        lastError = null;
        break; // success — exit retry loop
      } catch (err) {
        lastError = err;
        const retryable =
          err.name === "AbortError" ||                     // timeout
          (err.status && err.status >= 400 && err.status < 500) || // 4xx
          err.message?.includes("fetch failed");           // network

        if (retryable && attempt < CONFIG.FETCH_MAX_RETRIES) {
          log.warn(
            `  Retry ${attempt + 1}/${CONFIG.FETCH_MAX_RETRIES} for ${addr.slice(0, 10)}… ` +
            `(offset=${offset}): ${err.message}`,
          );
          await sleep(CONFIG.FETCH_RETRY_DELAY_MS);
        }
      }
    }

    // If all retries failed for this page, abort this whale entirely
    if (lastError) {
      log.error(
        `  Gave up fetching positions for ${addr} after ` +
        `${CONFIG.FETCH_MAX_RETRIES + 1} attempts: ${lastError.message}`,
      );
      break;
    }

    // An empty page (or non-array) means we've consumed all positions
    if (!Array.isArray(page) || page.length === 0) break;

    allPositions.push(...page);

    // If the page was smaller than the limit, there are no more pages
    if (page.length < limit) break;

    offset += limit;
  }

  return allPositions;
}

async function fetchAllWhalePositions() {
  const combined = new Map();

  // Fetch all whales in parallel (each whale paginates internally)
  const results = await Promise.allSettled(
    CONFIG.WHALE_ADDRESSES.map(async (addr) => {
      const positions = await fetchWhalePositionsPaginated(addr);
      return { addr, positions };
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      log.error(`Whale position fetch rejected: ${result.reason}`);
      continue;
    }

    const { addr, positions } = result.value;
    const addrTag = `${addr.slice(0, 10)}…${addr.slice(-4)}`;

    // ── Enhanced Error Verbosity: log raw response when 0 assets found ──
    if (!positions || positions.length === 0) {
      log.warn(
        `  🔍 Whale ${addrTag} returned 0 positions. ` +
        `Attempting single diagnostic fetch…`,
      );
      // Fire a one-shot diagnostic request so the raw response is visible in logs
      try {
        const diagUrl = `${CONFIG.DATA_API}/positions?user=${addr}&limit=5`;
        const diagResp = await fetch(diagUrl);
        const diagStatus = diagResp.status;
        const diagBody = await diagResp.text().catch(() => "(unreadable)");
        log.warn(
          `  🔍 Diagnostic for ${addrTag}: HTTP ${diagStatus} | ` +
          `body (first 500 chars): ${diagBody.slice(0, 500)}`,
        );
      } catch (diagErr) {
        log.warn(`  🔍 Diagnostic fetch itself failed for ${addrTag}: ${diagErr.message}`);
      }
      continue;
    }

    let added = 0;
    for (const pos of positions) {
      if (pos.asset && pos.size > 0 && !combined.has(pos.asset)) {
        combined.set(pos.asset, {
          conditionId: pos.conditionId,
          title: pos.title || "Unknown Market",
          outcome: pos.outcome || "Unknown",
          slug: pos.slug || "",
          curPrice: pos.curPrice || 0,
          whaleAddress: addr,
        });
        added++;
      }
    }

    log.info(
      `  ${addrTag}: ${positions.length} raw position(s) → ${added} new asset(s) added`,
    );
  }

  return combined;
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

// ─────────────────────────────────────────────────────────────────────────────
// Whale Trade Verification  (multi-whale)
// ─────────────────────────────────────────────────────────────────────────────
// Queries every tracked whale in parallel.  Returns the first match with a
// `whaleAddress` field attached so the caller knows exactly who traded.
// ─────────────────────────────────────────────────────────────────────────────
async function verifyWhaleTrade(assetId) {
  const now = Math.floor(Date.now() / 1000);
  const lookback = now - 30; // last 30 seconds

  const results = await Promise.allSettled(
    CONFIG.WHALE_ADDRESSES.map(async (addr) => {
      const url =
        `${CONFIG.DATA_API}/activity` +
        `?user=${addr}` +
        `&type=TRADE` +
        `&start=${lookback}` +
        `&sortBy=TIMESTAMP&sortDirection=DESC`;

      const resp = await fetch(url);
      if (!resp.ok) return null;

      const activities = await resp.json();
      const match = activities.find((a) => a.asset === assetId);
      if (match) {
        return {
          whaleAddress: addr,
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
      return null;
    }),
  );

  // Return the first whale that actually matched
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidity Engine — Order Book Depth Analysis  (uses getSnapshot)
// ─────────────────────────────────────────────────────────────────────────────
// clobClient.getSnapshot(tokenID) returns the L2 order book:
//   { bids: [{ price: "0.55", size: "120" }, …],
//     asks: [{ price: "0.56", size: "80"  }, …] }
//
// We walk the relevant side (asks for BUY, bids for SELL) and verify that
// TRADE_AMOUNT_USD can be completely filled within a 1% band of the whale's
// reported price.
//
// Returns:
//   { ok: true,  effectivePrice, fillableVolume }   — safe to execute
//   { ok: false, reason, effectivePrice?, fillableVolume? } — skip trade
// ─────────────────────────────────────────────────────────────────────────────
async function checkLiquidity(clobClient, asset, side, whalePrice) {
  let snapshot;
  try {
    snapshot = await clobClient.getSnapshot(asset);
  } catch (err) {
    return {
      ok: false,
      reason: `Order book snapshot fetch failed: ${err.message}`,
    };
  }

  if (!snapshot) {
    return { ok: false, reason: "Snapshot returned null/undefined" };
  }

  // For a BUY copy we lift the Asks; for a SELL copy we hit the Bids
  const levels = side === "BUY"
    ? (snapshot.asks || [])
    : (snapshot.bids || []);

  if (levels.length === 0) {
    return { ok: false, reason: "No liquidity levels on relevant side of book" };
  }

  // 1% price band boundaries
  const maxDeviation = whalePrice * CONFIG.MAX_SLIPPAGE_PCT;
  const priceCeiling = side === "BUY"
    ? Math.min(whalePrice + maxDeviation, 0.99)  // worst ask we'd accept
    : whalePrice;                                  // sells: anything ≥ floor
  const priceFloor = side === "BUY"
    ? whalePrice                                   // buys:  anything ≤ ceiling
    : Math.max(whalePrice - maxDeviation, 0.01);   // worst bid we'd accept

  // Walk the book accumulating fillable USDC within the band
  let fillableVolume = 0;   // cumulative USDC we can fill
  let sharesAccum    = 0;   // cumulative shares for VWAP
  let costAccum      = 0;   // cumulative cost   for VWAP

  for (const level of levels) {
    const levelPrice = parseFloat(level.price);
    const levelSize  = parseFloat(level.size);   // shares/contracts at this level

    // Asks are sorted ascending; bids are sorted descending
    if (side === "BUY"  && levelPrice > priceCeiling) break;
    if (side === "SELL" && levelPrice < priceFloor)   break;

    const levelNotional = levelPrice * levelSize;
    const remainingUSD  = CONFIG.TRADE_AMOUNT_USD - fillableVolume;
    const takeUSD       = Math.min(levelNotional, remainingUSD);
    const takeShares    = takeUSD / levelPrice;

    fillableVolume += takeUSD;
    sharesAccum    += takeShares;
    costAccum      += takeShares * levelPrice;

    if (fillableVolume >= CONFIG.TRADE_AMOUNT_USD) break;
  }

  // Volume-weighted average price across consumed levels
  const effectivePrice = sharesAccum > 0 ? costAccum / sharesAccum : 0;

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
// Trade Execution Engine
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

// ─────────────────────────────────────────────────────────────────────────────
// executeCopyTrade — Hardened, persistence-aware, multi-whale
// ─────────────────────────────────────────────────────────────────────────────
async function executeCopyTrade(clobClient, whaleTrade, tradeStore) {
  const { side, price, asset, conditionId, outcome, title, whaleAddress } = whaleTrade;

  if (isDuplicate(asset, side)) {
    log.warn(`Dedup: skipping duplicate ${side} on "${title}" (${outcome})`);
    return;
  }

  const whaleTag = whaleAddress
    ? `whale ${whaleAddress.slice(0, 8)}…${whaleAddress.slice(-4)}`
    : "whale (unknown)";

  log.whale(`Detected ${whaleTag} ${side} on "${title}" [${outcome}] @ ${price}`);

  // ── Step 1: Market metadata ──
  const marketInfo = await fetchMarketInfo(conditionId);
  if (!marketInfo) {
    log.error(`Cannot fetch market info for conditionId=${conditionId} — skipping`);
    return;
  }

  // ── Step 2: Liquidity pre-flight via order book depth ──
  const whalePrice = parseFloat(price);
  const liquidity = await checkLiquidity(clobClient, asset, side, whalePrice);

  if (!liquidity.ok) {
    log.warn(
      `⛔ LIQUIDITY WARNING: Spread too wide — skipping ${side} on "${title}" [${outcome}]`,
    );
    log.warn(
      `   Reason: ${liquidity.reason} | ` +
      `whalePrice=${whalePrice.toFixed(4)} | ` +
      `1% band=±${(whalePrice * CONFIG.MAX_SLIPPAGE_PCT).toFixed(4)}`,
    );
    return;
  }

  // ── Step 3: Worst acceptable price from the 1% liquidity band ──
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
    `token=${asset.slice(0, 12)}… | worst_price=${worstPrice.toFixed(4)} | ` +
    `tick=${marketInfo.tickSize} | negRisk=${marketInfo.negRisk} | ` +
    `bookDepth=$${liquidity.fillableVolume.toFixed(4)} available | ` +
    `triggered by ${whaleTag}`,
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
    // ONLY log FILLED when the CLOB explicitly returns { success: true }.
    // A 403 geoblock, network error, or any response without an explicit
    // true value for .success is treated as a failure.
    if (
      response &&
      typeof response === "object" &&
      response.success === true
    ) {
      const orderId = response.orderID || response.orderIds?.[0] || "N/A";
      log.trade(
        `✅ Order FILLED — ${side} "${title}" [${outcome}] | ` +
        `orderID=${orderId} | via ${whaleTag}`,
      );

      // ── Persist the fill to trades.json ──
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
      // Explicit failure or ambiguous response — never treat as success
      const reason =
        response?.errorMsg ||
        response?.error ||
        response?.message ||
        JSON.stringify(response);
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
      `🚫 ACCESS DENIED (403) — your IP or account may be geoblocked by Polymarket. ` +
      `${side} "${title}" [${outcome}] was NOT executed.`,
    );
  } else if (msg.includes("not enough balance") || msg.includes("insufficient")) {
    log.error(
      `💸 INSUFFICIENT FUNDS — cannot ${side} "${title}" [${outcome}]. ` +
      `Top up your Polymarket wallet with USDC.e on Polygon.`,
    );
  } else if (msg.includes("slippage") || msg.includes("FOK") || msg.includes("not enough liquidity")) {
    log.error(
      `📉 SLIPPAGE/LIQUIDITY — FOK order for "${title}" [${outcome}] could not fill. ` +
      `The order book may have moved since the whale's trade.`,
    );
  } else if (msg.includes("rate limit") || msg.includes("429")) {
    log.error(`⏳ RATE LIMITED — backing off. Will retry on next signal.`);
  } else {
    log.error(`Order failed for "${title}" [${outcome}]: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Manager  (multi-whale aware)
// ─────────────────────────────────────────────────────────────────────────────
// Connects to the CLOB Market WebSocket and subscribes to the union of all
// asset_ids held by any tracked whale.  When a `last_trade_price` event fires
// we verify which whale made the trade, then execute our copy order.
//
// Race-condition guard: a per-asset lock (_processingLock) prevents two
// simultaneous events on the same asset from spawning duplicate orders — this
// matters when multiple whales trade the same market at the same time.
// ─────────────────────────────────────────────────────────────────────────────
class WhaleWatcher {
  constructor(clobClient, myAddress, tradeStore) {
    this.clobClient = clobClient;
    this.myAddress = myAddress;
    this.tradeStore = tradeStore;
    this.ws = null;
    this.pingInterval = null;
    this.positionRefreshInterval = null;
    this.reconnectAttempt = 0;
    this.subscribedAssets = new Set();
    this.assetMap = new Map();   // asset_id → position metadata
    this.isShuttingDown = false;
    this._processingLock = new Set(); // per-asset lock to prevent races
    this._statusInterval = null;      // periodic status heartbeat timer
    this._lastActivityTs = Date.now(); // tracks last whale trade for idle detection
  }

  async start() {
    log.info("═══════════════════════════════════════════════════════════");
    log.info("  Polymarket Whale Copy-Trader Bot  v2.1");
    log.info("═══════════════════════════════════════════════════════════");
    log.info(`  Tracking ${CONFIG.WHALE_ADDRESSES.length} whale(s):`);
    for (const addr of CONFIG.WHALE_ADDRESSES) {
      log.info(`    • ${addr}`);
    }
    log.info(`  Trade amount:   $${CONFIG.TRADE_AMOUNT_USD} USDC (FOK)`);
    log.info(`  Max slippage:   ${(CONFIG.MAX_SLIPPAGE_PCT * 100).toFixed(1)}% (order book depth)`);
    log.info(`  Your address:   ${this.myAddress}`);
    log.info(`  Trade history:  ${this.tradeStore.trades.length} prior fill(s) loaded`);
    log.info("═══════════════════════════════════════════════════════════");

    // 1. Bootstrap: discover all whales' current positions
    await this.refreshWhalePositions();

    // 2. Connect WebSocket
    this.connect();

    // 3. Start the passive monitoring status heartbeat
    this.startStatusHeartbeat();

    // 4. Periodically refresh to discover new markets any whale enters
    this.positionRefreshInterval = setInterval(async () => {
      await this.refreshWhalePositions();
      this.subscribeNewAssets();
    }, CONFIG.POSITION_REFRESH_INTERVAL_MS);
  }

  async refreshWhalePositions() {
    try {
      this.assetMap = await fetchAllWhalePositions();

      const uniqueConditions = new Set(
        [...this.assetMap.values()].map((v) => v.conditionId),
      );
      log.whale(
        `Tracking ${this.assetMap.size} asset(s) ` +
        `across ${uniqueConditions.size} market(s) ` +
        `from ${CONFIG.WHALE_ADDRESSES.length} whale(s)`,
      );
    } catch (err) {
      log.error(`Failed to refresh whale positions: ${err.message}`);
    }
  }

  connect() {
    if (this.isShuttingDown) return;

    log.ws(`Connecting to ${CONFIG.WS_URL}…`);
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
        "No whale has open positions — WebSocket will idle. " +
        "Positions will be rechecked in 60s.",
      );
      return;
    }

    const subscribeMsg = JSON.stringify({
      assets_ids: assetIds,
      type: "market",
      custom_feature_enabled: true,
    });
    this.ws.send(subscribeMsg);
    this.subscribedAssets = new Set(assetIds);

    log.ws(`Subscribed to ${assetIds.length} asset(s)`);
  }

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
      return; // pong frames, malformed messages, etc.
    }

    if (Array.isArray(data)) {
      // Process events concurrently — the per-asset lock inside processEvent
      // prevents duplicate orders when multiple events fire on the same asset
      await Promise.allSettled(data.map((event) => this.processEvent(event)));
    } else {
      await this.processEvent(data);
    }
  }

  async processEvent(event) {
    if (event.event_type !== "last_trade_price") return;

    const assetId = event.asset_id;
    if (!assetId || !this.assetMap.has(assetId)) return;

    // ── Per-asset lock: prevents race conditions when multiple whales ──
    // ── or rapid-fire events hit the same asset simultaneously        ──
    if (this._processingLock.has(assetId)) return;
    this._processingLock.add(assetId);

    try {
      log.info(
        `Trade detected on tracked asset ${assetId.slice(0, 16)}… | ` +
        `price=${event.price} side=${event.side} size=${event.size}`,
      );

      // Check all whales — returns the first match with whaleAddress attached
      const whaleTrade = await verifyWhaleTrade(assetId);
      if (!whaleTrade) {
        log.info("  → Not a tracked whale's trade, ignoring.");
        return;
      }

      const whaleTag =
        `${whaleTrade.whaleAddress.slice(0, 8)}…${whaleTrade.whaleAddress.slice(-4)}`;
      log.whale(
        `CONFIRMED ${whaleTag} ${whaleTrade.side} on "${whaleTrade.title}" ` +
        `[${whaleTrade.outcome}] @ ${whaleTrade.price} (${whaleTrade.size} shares)`,
      );

      // Reset idle timer — the status heartbeat uses this
      this._lastActivityTs = Date.now();

      await executeCopyTrade(this.clobClient, whaleTrade, this.tradeStore);
    } finally {
      this._processingLock.delete(assetId);
    }
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

  startStatusHeartbeat() {
    this.stopStatusHeartbeat();
    this._statusInterval = setInterval(() => {
      const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      const idleSec = ((Date.now() - this._lastActivityTs) / 1000).toFixed(0);
      const wsState = this.ws?.readyState === WebSocket.OPEN ? "OPEN" : "CLOSED";
      console.log(
        `[${ts()}] 📡 [STATUS] Engine active | ` +
        `WS=${wsState} | ` +
        `Monitoring ${this.assetMap.size} asset(s) from ${CONFIG.WHALE_ADDRESSES.length} whale(s) | ` +
        `Idle ${idleSec}s | ` +
        `Memory: ${memMB}MB`,
      );
    }, CONFIG.STATUS_LOG_INTERVAL_MS);
  }

  stopStatusHeartbeat() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }

  cleanup() {
    this.stopPing();
    this.stopStatusHeartbeat();
  }

  scheduleReconnect() {
    if (this.isShuttingDown) return;

    this.reconnectAttempt++;
    const delay = Math.min(
      CONFIG.WS_RECONNECT_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      CONFIG.WS_RECONNECT_MAX_MS,
    );
    log.ws(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt #${this.reconnectAttempt})…`);
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
