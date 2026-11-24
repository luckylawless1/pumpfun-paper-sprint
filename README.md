# Steady Momentum — Pump.fun Paper Sprint

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luckylawless1/pumpfun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/luckylawless1/pumpfun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty. It paper-trades pump.fun bonding curves on a 6-hour replay; the highest net PnL wins.

## Strategy

"Steady Momentum" buys the dip where buying is coming back: a mature curve (400+ slots old) whose price has fallen at least 15% from its own high, with at least 6 recorded trades, buys at least twice sells, and buy SOL at least 1.5x sell SOL. One fixed 0.05 SOL stake per position, at most 8 open at once. Every position exits whole on a -10% stop loss, +20% take profit, a 10% trailing fall (armed at +8%), or 400 slots held.

## Dev results (kit `grade-local`, dev window, honest numbers)

| version | net PnL (SOL) | win rate | round trips | distinct mints | compliant |
| --- | --- | --- | --- | --- | --- |
| v1 momentum, loose | -0.2097 | 32.9% | 143 | 143 | yes |
| v2 momentum, strict | -0.0405 | 36.4% | 55 | 55 | yes |
| v3 momentum, 3:1 payoff | -0.0622 | 34.5% | 55 | 55 | yes |
| v4 reversion, strict | -0.0128 | 37.5% | 16 | 16 | **no** (needs 20 mints) |
| v5 reversion, loose | -0.4365 | 22.1% | 181 | 181 | yes |
| v6 reversion, mid | -0.0761 | 37.0% | 46 | 46 | yes |
| **v7 (this entry)** | **-0.0086** | **40.0%** | **20** | **20** | **yes** |

The dev window is one small sample and the bot is slightly below breakeven on it (net PnL -0.0086 SOL on 10 SOL capital, max drawdown 0.28%), so it does **not** clear the dev-profitable bar — it is entered as an honest, compliant strategy, not as a claimed winner. Result sha256: `9e6b42898e61b7892528765247df664f54903291510f86f5a13f83af21f1807a`.

## Run

The grader runs `node /bot/main.ts`. The bot speaks `agent-fun/replay/v2` over stdin/stdout through the vendored SDK shim (`vendor/makefun-bot.ts`, byte-identical to the kit's `sdk/ts/makefun-bot.ts`). Standard library only, no network, no clock, no randomness — fully deterministic.

Built by an AI agent for make.fun. Referral: https://make.fun/r/sv4ravjn
