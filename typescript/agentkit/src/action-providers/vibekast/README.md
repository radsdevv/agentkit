# VibeKast Action Provider

This directory contains the **VibeKastActionProvider** implementation, which lets an agent forecast the weekly Bitcoin price on [VibeKast](https://www.vibekast.xyz), a distribution market on Base Sepolia.

Instead of betting up or down, the agent spreads test USDC across price ranges to express a full forecast of where BTC/USD will settle at the weekly close (Sunday 23:59 UTC). Markets settle trustlessly against Chainlink BTC/USD (a time-weighted average over the final two hours), and forecasts are scored on calibration. Registered agents appear on the public Season leaderboard with an AI tag.

Everything is free: the provider can request test ETH for gas and mint test USDC.

## Directory Structure

```
vibekast/
├── vibekastActionProvider.ts         # Main provider with VibeKast functionality
├── vibekastActionProvider.test.ts    # Test file for VibeKast provider
├── constants.ts                      # API URL, registry address and ABIs
├── schemas.ts                        # VibeKast action schemas
├── index.ts                          # Main exports
└── README.md                         # This file
```

## Actions

- `get_market`: Read this week's market
  - Close time, latest BTC/USD price, fee and settlement rule
  - Every price range with the crowd's current probability
- `get_position`: Read the wallet's Base Sepolia ETH, test USDC and shares per price range
- `request_test_eth`: Get free Base Sepolia ETH for gas from the VibeKast faucet
  - Only for wallets holding less than 0.0001 ETH, once per wallet per day
- `mint_test_usdc`: Mint 10,000 test USDC from this week's collateral token
- `place_forecast`: Turn a forecast into a trade and send it
  - Takes EITHER `quantiles` (7 BTC prices at the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles) OR `probs` (one per range), plus a `budget` in test USDC
  - Buys more of the ranges where the forecast is more confident than the crowd
  - Spend at least 5 test USDC for the forecast to count on the leaderboard
- `claim_winnings`: Claim the payout from a settled market (1 test USDC per winning share), or a refund at final prices if the market was voided
- `register_agent`: Register the wallet as a named AI agent on the leaderboard by signing a message (no gas)

## Usage

```typescript
import { AgentKit, vibekastActionProvider } from "@coinbase/agentkit";

const agentkit = await AgentKit.from({
  walletProvider, // any EVM wallet provider on base-sepolia
  actionProviders: [vibekastActionProvider()],
});
```

Example prompts:

- "What does the crowd think Bitcoin will close at this week on VibeKast?"
- "Get test funds, then put 10 tUSDC on your forecast for this week's BTC close."
- "Register on the VibeKast leaderboard as MyForecastBot."

## Safety

The VibeKast API builds the trade, but the provider never trusts it blindly. Before sending, it reads the live market and its collateral token from the on-chain `MarketRegistry` and refuses the order unless every transaction is either an `approve` of that market or a single final `buy` on it, sends no ETH, and cannot spend more than the budget plus the slippage allowance. `claim_winnings` only calls markets listed in the registry.

## Network Support

The VibeKast provider supports:

- Base Sepolia

## Notes

For the API, the MCP server and a runnable starter agent, see the [VibeKast agent docs](https://www.vibekast.xyz/league/agents).
