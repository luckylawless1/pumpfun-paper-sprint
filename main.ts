// Pump.fun Paper Sprint — "Steady Momentum" bot (agent-fun/replay/v2).
//
// Strategy, in plain terms: watch every bonding curve the harness shows us, and buy the dips
// where buying is coming back. A curve becomes a buy when it is mature (at least 400 slots
// since its CreateEvent — fresh launches are mostly bundled dumps), its price has fallen at
// least 15% from its own high, it has at least 6 recorded trades with buys at least twice
// sells and buy SOL at least 1.5x sell SOL (the dip is meeting fresh buy flow, not a dead
// curve), and its real SOL reserve is between 2 and 100 SOL. Each position is one small fixed
// stake (0.05 SOL), at most 8 open at once, so the bot spreads across many coins instead of
// betting the run on one.
//
// The v1 momentum version of this bot (buy a 20% rise) lost on the dev window with a 36%
// win rate — on this data, buying after the rise means buying the top. The reversion entry
// is the correction: buy the pullback while buyers are still stepping in.
//
// Every position exits whole on the first of: -10% stop loss against cost, +20% take profit,
// a 10% trailing fall from its peak value (once it is up at least 8%), or 400 slots held.
// After an exit the same curve rests 100 slots before it may be bought again, and each curve
// is entered at most once per run — breadth over depth.
//
// Fees are the reason the exits are wide: protocol + creator fees run about 1.25% per side,
// so a round trip costs roughly 2.5% before tx fees; a 30% winner pays for several 15%
// losers. Buys are capped at the harness's own per-mint size limit (state.maxBuyLamports) and
// at the free cash minus a 0.5 SOL reserve, so the bot can never overspend.
//
// hello: the harness greets us once with capital, caps and fees; every batch after that is one
// slot of events, and the orders we return on a batch are the only orders that batch sends.
// slot: all timing here is in slots (never wall time), so two runs of the same window produce
// the same action log byte for byte. No clock, no environment, no Math.random anywhere.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot; the SDK shim
// is vendored byte-for-byte at vendor/makefun-bot.ts (the kit's own sdk/ts/makefun-bot.ts).

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- parameters
const MIN_AGE_SLOTS = 400; // slots since CreateEvent before an entry is allowed
const MIN_TRADES = 6; // recorded trades seen on the curve before an entry
const DIP_FROM_HIGH = 0.15; // price now at least 15% below the curve's own high
const MIN_REAL_SOL = 2; // real SOL reserve floor at entry
const MAX_REAL_SOL = 100; // real SOL reserve ceiling at entry
const MIN_BUY_DOMINANCE = 2; // buy trades at least 2x sell trades in the tape
const MIN_FLOW_DOMINANCE_NUM = 3; // buy SOL at least 3/2 of sell SOL
const MIN_FLOW_DOMINANCE_DEN = 2;
const STAKE_SOL = 0.05; // SOL per position (one fixed stake)
const MAX_POSITIONS = 8; // most momentum positions open at once
const MAX_ENTRIES_PER_CURVE = 1; // breadth over depth: one entry per curve
const STOP_LOSS = 0.1; // sell when value <= cost * (1 - 0.10)
const TAKE_PROFIT = 0.2; // sell when value >= cost * (1 + 0.20)
const TRAIL_ARM = 0.08; // trailing stop arms once value >= cost * (1 + 0.08)
const TRAIL_FALL = 0.1; // sell when value falls 10% from its peak
const MAX_HOLD_SLOTS = 400; // sell after this many slots held
const COOLDOWN_SLOTS = 100; // slots to rest a curve after an exit
const CASH_RESERVE_LAMPORTS = 500_000_000n; // keep 0.5 SOL cash untouched
const BUY_SLIPPAGE_BPS = 1000; // 10% on buys
const SELL_SLIPPAGE_BPS = 10000; // sells always go out (we want out)

// ---------------------------------------------------------------- per-curve tape
interface CurveTape {
  firstPrice: number; // SOL per token when first seen
  firstSlot: number;
  highPrice: number;
  lastPrice: number;
  trades: number;
  buys: number;
  sells: number;
  buyLamports: bigint;
  sellLamports: bigint;
  entries: number;
  cooldownUntil: number;
}

interface OpenPosition {
  buySlot: number;
  peakValue: bigint; // best close value seen (lamports)
}

const tapes = new Map<Pubkey, CurveTape>();
const open = new Map<Pubkey, OpenPosition>();

// Price of one token in SOL, from the curve's virtual reserves.
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// Close value of a holding in lamports at the curve's current price.
function positionValue(tokens: bigint, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): bigint {
  if (curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

function tapeFor(mint: Pubkey, slot: number, price: number): CurveTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      firstPrice: price,
      firstSlot: slot,
      highPrice: price,
      lastPrice: price,
      trades: 0,
      buys: 0,
      sells: 0,
      buyLamports: 0n,
      sellLamports: 0n,
      entries: 0,
      cooldownUntil: -1,
    };
    tapes.set(mint, t);
  }
  return t;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // --- fold this batch's events into our tapes
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        tapeFor(e.mint, e.slot, p);
      } else if (e.event === "TradeEvent") {
        const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        const t = tapeFor(e.mint, e.slot, p);
        t.trades += 1;
        t.lastPrice = p;
        if (p > t.highPrice) t.highPrice = p;
        if (e.is_buy) {
          t.buys += 1;
          t.buyLamports += BigInt(e.sol_amount);
        } else {
          t.sells += 1;
          t.sellLamports += BigInt(e.sol_amount);
        }
      } else {
        // CompleteEvent: the curve is done; drop its tape so it can never be re-entered.
        tapes.delete(e.mint);
      }
    }

    // --- exits first: sell every position that hit a rule
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let pos = open.get(mint);
      if (pos === undefined) {
        // First sight of this position (its buy fill just landed): open its record now.
        pos = { buySlot: state.slot, peakValue: 0n };
        open.set(mint, pos);
      }
      const value = positionValue(holding.token_amount, curve);
      if (value > pos.peakValue) pos.peakValue = value;
      const cost = holding.cost_lamports;
      const stopLine = (cost * BigInt(Math.round((1 - STOP_LOSS) * 100))) / 100n;
      const profitLine = (cost * BigInt(Math.round((1 + TAKE_PROFIT) * 100))) / 100n;
      const armLine = (cost * BigInt(Math.round((1 + TRAIL_ARM) * 100))) / 100n;
      const trailArmed = value >= armLine || pos.peakValue >= armLine;
      const trailLine = (pos.peakValue * BigInt(Math.round((1 - TRAIL_FALL) * 100))) / 100n;
      const heldTooLong = state.slot - pos.buySlot > MAX_HOLD_SLOTS;
      if (value <= stopLine || value >= profitLine || (trailArmed && value <= trailLine) || heldTooLong) {
        orders.push({ side: "sell", mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
        const t = tapes.get(mint);
        if (t !== undefined) t.cooldownUntil = state.slot + COOLDOWN_SLOTS;
        open.delete(mint);
      }
    }

    // --- entries: scan curves in first-seen order (deterministic), buy the ones that qualify
    const pendingBuys = new Set<Pubkey>();
    for (const p of state.pending.values()) if (p.order.side === "buy") pendingBuys.add(p.order.mint);
    let buysThisBatch = 0;
    if (state.committedPositionCount() < MAX_POSITIONS) {
      for (const [mint, curve] of state.curves) {
        if (state.committedPositionCount() + buysThisBatch >= MAX_POSITIONS) break;
        if (curve.complete) continue;
        if (state.positions.has(mint)) continue;
        if (pendingBuys.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        if (t.entries >= MAX_ENTRIES_PER_CURVE) continue;
        if (state.slot < t.cooldownUntil) continue;
        if (curve.created_slot === null || state.slot - curve.created_slot < MIN_AGE_SLOTS) continue;
        if (t.trades < MIN_TRADES) continue;
        if (t.buys < t.sells * MIN_BUY_DOMINANCE) continue;
        if (t.buyLamports * BigInt(MIN_FLOW_DOMINANCE_DEN) < t.sellLamports * BigInt(MIN_FLOW_DOMINANCE_NUM)) continue;
        // Reversion entry: the price has dipped from its high, but buy flow is returning.
        if (t.lastPrice > t.highPrice * (1 - DIP_FROM_HIGH)) continue;
        const realSol = Number(curve.real_quote_reserves) / Number(LAMPORTS_PER_SOL);
        if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;

        const cap = state.maxBuyLamports(mint);
        const stake = BigInt(Math.floor(STAKE_SOL * Number(LAMPORTS_PER_SOL)));
        let size = stake < cap ? stake : cap;
        const free = state.freeCashLamports() - CASH_RESERVE_LAMPORTS;
        if (size > free) size = free;
        if (size < 10_000_000n) continue; // under the 0.01 SOL counted round-trip floor
        orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        buysThisBatch += 1;
        t.entries += 1;
      }
    }

    return orders;
  },

  onDone(state: BotState): void {
    // The harness flattens every position at the end; nothing to do here. Log a one-line
    // summary to stderr (stdout carries replies only): final cash after flattening.
    console.error(`done: batches=${state.seq + 1} cash=${state.cash.toString()} positions=${state.positions.size}`);
  },
});
