import { z } from "zod";
import { decodeFunctionData, encodeFunctionData, formatUnits, Hex } from "viem";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { Network } from "../../network";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  COLLATERAL_ABI,
  EXPLORER_TX_URL,
  FAUCET_THRESHOLD_WEI,
  MIN_GAS_WEI,
  MARKET_ABI,
  ALLOWANCE_POLL,
  ORDER_LIMITS,
  QUANTILE_LEVELS,
  REGISTRY_ABI,
  VIBEKAST_API_URL,
  VIBEKAST_DECIMALS,
  VIBEKAST_NETWORK_ID,
  VIBEKAST_REGISTRY_ADDRESS,
  VIBEKAST_SITE_URL,
} from "./constants";
import {
  VibeKastClaimWinningsSchema,
  VibeKastEmptySchema,
  VibeKastPlaceForecastSchema,
  VibeKastRegisterAgentSchema,
} from "./schemas";

/**
 * Configuration options for the VibeKast action provider.
 */
export interface VibeKastActionProviderConfig {
  /**
   * Base URL of the VibeKast agent API. Defaults to the public API.
   */
  apiUrl?: string;
}

interface MarketResponse {
  market: Hex;
  collateral: Hex;
  label: string;
  question: string;
  closeTimeIso: string;
  open: boolean;
  n: number;
  edges: number[];
  prices: number[];
  feeBps: number;
  spot?: { price: number; updatedAt: number };
  settlement: string;
}

interface OrderResponse {
  market: Hex;
  shares: string[];
  quote: { cost: number; fee: number; total: number };
  maxCost: { units: number; wad: string };
  transactions: { to: Hex; data: Hex; value: string; description: string }[];
}

const units = (wei: bigint) => Number(formatUnits(wei, VIBEKAST_DECIMALS));
const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Label for one price range, matching the market's settlement rule: the first
 * range absorbs everything below its upper edge, the last everything above its
 * lower edge.
 *
 * @param edges - The market's range edges in USD.
 * @param i - Index of the range.
 * @returns A human-readable label for the range.
 */
function rangeLabel(edges: number[], i: number): string {
  const n = edges.length - 1;
  if (i === 0) return `below ${usd(edges[1])}`;
  if (i === n - 1) return `${usd(edges[i])} and above`;
  return `${usd(edges[i])} to ${usd(edges[i + 1])}`;
}

/**
 * VibeKastActionProvider lets an agent forecast the weekly Bitcoin price on
 * VibeKast, a distribution market on Base Sepolia. The agent trades with free
 * test USDC and is scored on how well calibrated its forecast is.
 */
export class VibeKastActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly apiUrl: string;

  /**
   * Constructor for the VibeKastActionProvider.
   *
   * @param config - Optional configuration.
   */
  constructor(config: VibeKastActionProviderConfig = {}) {
    super("vibekast", []);
    this.apiUrl = (config.apiUrl ?? VIBEKAST_API_URL).replace(/\/+$/, "");
  }

  /**
   * Reads the live weekly market.
   *
   * @param _walletProvider - The wallet provider (unused).
   * @param _args - No input.
   * @returns The market as a JSON string.
   */
  @CreateAction({
    name: "get_market",
    description: `
This tool reads this week's VibeKast market: a forecast of Bitcoin's price at the weekly close (Sunday 23:59 UTC).
It returns the close time, the latest BTC/USD price, the fee and every price range with the crowd's current probability.
Use it before place_forecast. Forecasts are scored against where BTC settles, so a well-calibrated spread beats a single guess.
`,
    schema: VibeKastEmptySchema,
  })
  async getMarket(
    _walletProvider: EvmWalletProvider,
    _args: z.infer<typeof VibeKastEmptySchema>,
  ): Promise<string> {
    try {
      const m = await this.api<MarketResponse>("/market");
      return JSON.stringify({
        success: true,
        week: m.label,
        question: m.question,
        open: m.open,
        closesAt: m.closeTimeIso,
        spotBtcUsd: m.spot?.price ?? null,
        feePercent: m.feeBps / 100,
        settlement: m.settlement,
        ranges: m.prices.map((p, i) => ({
          index: i,
          range: rangeLabel(m.edges, i),
          crowd: round(p),
        })),
        market: m.market,
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: `Error reading the VibeKast market: ${error}`,
      });
    }
  }

  /**
   * Reads the wallet's gas, test USDC and positions in the live market.
   *
   * @param walletProvider - The wallet provider to read balances for.
   * @param _args - No input.
   * @returns The balances and positions as a JSON string.
   */
  @CreateAction({
    name: "get_position",
    description: `
This tool reads the wallet's VibeKast balances: Base Sepolia ETH for gas, test USDC (tUSDC) for this week's market, and the shares held in each price range.
Use it to check whether the wallet needs request_test_eth or mint_test_usdc before place_forecast.
`,
    schema: VibeKastEmptySchema,
  })
  async getPosition(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof VibeKastEmptySchema>,
  ): Promise<string> {
    try {
      const wallet = walletProvider.getAddress() as Hex;
      const m = await this.api<MarketResponse>("/market");
      const [eth, tusdc, shares] = await Promise.all([
        walletProvider.getBalance(),
        walletProvider.readContract({
          address: m.collateral,
          abi: COLLATERAL_ABI,
          functionName: "balanceOf",
          args: [wallet],
        }) as Promise<bigint>,
        walletProvider.readContract({
          address: m.market,
          abi: MARKET_ABI,
          functionName: "balanceOfBatch",
          args: [Array(m.n).fill(wallet), Array.from({ length: m.n }, (_, i) => BigInt(i))],
        }) as Promise<readonly bigint[]>,
      ]);
      return JSON.stringify({
        success: true,
        wallet,
        week: m.label,
        eth: formatUnits(eth, 18),
        tusdc: round(units(tusdc), 2),
        needsGas: eth < MIN_GAS_WEI,
        positions: shares
          .map((s, i) => ({ index: i, range: rangeLabel(m.edges, i), shares: round(units(s), 2) }))
          .filter(p => p.shares > 0),
        market: m.market,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error reading VibeKast balances: ${error}` });
    }
  }

  /**
   * Requests free Base Sepolia ETH for gas from the VibeKast faucet.
   *
   * @param walletProvider - The wallet provider to fund.
   * @param _args - No input.
   * @returns The faucet result as a JSON string.
   */
  @CreateAction({
    name: "request_test_eth",
    description: `
This tool asks the VibeKast faucet for free Base Sepolia ETH so the wallet can pay gas (0.0001 ETH, enough for many trades).
It only works for wallets holding less than 0.0001 ETH, once per wallet per day. Do this before mint_test_usdc if the wallet has no ETH.
`,
    schema: VibeKastEmptySchema,
  })
  async requestTestEth(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof VibeKastEmptySchema>,
  ): Promise<string> {
    try {
      const wallet = walletProvider.getAddress();
      const balance = await walletProvider.getBalance();
      if (balance >= FAUCET_THRESHOLD_WEI) {
        return JSON.stringify({
          success: true,
          message: `The wallet already has ${formatUnits(balance, 18)} ETH, enough for gas.`,
        });
      }
      const res = await this.api<{ txHash: Hex; amountEth: string }>("/faucet", { wallet });
      await walletProvider.waitForTransactionReceipt(res.txHash);
      return JSON.stringify({
        success: true,
        message: `Received ${res.amountEth} Base Sepolia ETH for gas.`,
        transactionHash: res.txHash,
        explorer: `${EXPLORER_TX_URL}${res.txHash}`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error requesting test ETH: ${error}` });
    }
  }

  /**
   * Mints free test USDC from this week's collateral token.
   *
   * @param walletProvider - The wallet provider to mint to.
   * @param _args - No input.
   * @returns The mint result as a JSON string.
   */
  @CreateAction({
    name: "mint_test_usdc",
    description: `
This tool mints 10,000 free test USDC (tUSDC) to the wallet. tUSDC is what VibeKast markets trade in, and the token changes every week, so mint again in a new week.
The wallet needs a little Base Sepolia ETH for gas first (use request_test_eth).
`,
    schema: VibeKastEmptySchema,
  })
  async mintTestUsdc(
    walletProvider: EvmWalletProvider,
    _args: z.infer<typeof VibeKastEmptySchema>,
  ): Promise<string> {
    try {
      const { collateral } = await this.liveMarket(walletProvider);
      const hash = await walletProvider.sendTransaction({
        to: collateral,
        data: encodeFunctionData({ abi: COLLATERAL_ABI, functionName: "faucet" }),
      });
      const receipt = await walletProvider.waitForTransactionReceipt(hash);
      if (receipt?.status !== "success") throw new Error(`transaction ${hash} reverted`);
      return JSON.stringify({
        success: true,
        message: "Minted 10,000 tUSDC.",
        transactionHash: hash,
        explorer: `${EXPLORER_TX_URL}${hash}`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error minting test USDC: ${error}` });
    }
  }

  /**
   * Turns a forecast into a trade on the live market and sends it.
   *
   * @param walletProvider - The wallet provider that signs and sends the trade.
   * @param args - The forecast and budget.
   * @returns The trade result as a JSON string.
   */
  @CreateAction({
    name: "place_forecast",
    description: `
This tool places the agent's forecast of Bitcoin's weekly close on VibeKast by trading test USDC.
Give EITHER quantiles (7 BTC prices in USD at the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles, lowest first; easiest) OR probs (one probability per range from get_market), plus a budget in tUSDC.
It buys more of the ranges where the forecast is more confident than the crowd, then sends the approval and the trade from the wallet.
Spend at least 5 tUSDC for the forecast to count on the leaderboard. Use get_market first, and mint_test_usdc if the wallet has no tUSDC.
`,
    schema: VibeKastPlaceForecastSchema,
  })
  async placeForecast(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof VibeKastPlaceForecastSchema>,
  ): Promise<string> {
    try {
      // Tool-calling models in strict mode send every field, so an empty array means "not given".
      const quantiles = args.quantiles?.length ? args.quantiles : undefined;
      const probs = args.probs?.length ? args.probs : undefined;
      if ((quantiles === undefined) === (probs === undefined)) {
        return JSON.stringify({
          success: false,
          error: "Give exactly one of quantiles or probs, and leave the other out or empty.",
        });
      }
      if (quantiles && quantiles.length !== QUANTILE_LEVELS.length) {
        return JSON.stringify({
          success: false,
          error: `quantiles must have exactly ${QUANTILE_LEVELS.length} prices, at the ${QUANTILE_LEVELS.join("th, ")}th percentiles.`,
        });
      }
      const wallet = walletProvider.getAddress() as Hex;
      const { market, collateral } = await this.liveMarket(walletProvider);
      const slippageBps = args.slippageBps ?? ORDER_LIMITS.defaultSlippageBps;

      const order = await this.api<OrderResponse>("/order", {
        quantiles,
        probs,
        budget: args.budget,
        slippageBps,
        wallet,
      });
      const spendCap =
        (BigInt(Math.ceil(args.budget * 1e6)) * 10n ** 12n * BigInt(10_000 + slippageBps)) /
        10_000n;
      this.checkOrder(order, market, collateral, spendCap);

      const balance = (await walletProvider.readContract({
        address: collateral,
        abi: COLLATERAL_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;
      if (balance < BigInt(order.maxCost.wad)) {
        return JSON.stringify({
          success: false,
          error: `The wallet has ${round(units(balance), 2)} tUSDC but the trade needs up to ${round(order.maxCost.units, 2)}. Use mint_test_usdc first.`,
        });
      }

      const sent: { description: string; transactionHash: Hex; explorer: string }[] = [];
      for (const tx of order.transactions) {
        const hash = await walletProvider.sendTransaction({ to: tx.to, data: tx.data });
        const receipt = await walletProvider.waitForTransactionReceipt(hash);
        if (receipt?.status !== "success")
          throw new Error(`transaction ${hash} reverted (${tx.description})`);
        sent.push({
          description: tx.description,
          transactionHash: hash,
          explorer: `${EXPLORER_TX_URL}${hash}`,
        });
        if (sameAddress(tx.to, collateral)) {
          await this.waitForAllowance(walletProvider, collateral, market, tx.data);
        }
      }

      const m = await this.api<MarketResponse>("/market");
      return JSON.stringify({
        success: true,
        message: `Placed a forecast costing ${round(order.quote.total, 2)} tUSDC including a ${round(order.quote.fee, 4)} tUSDC fee.`,
        transactions: sent,
        bought: order.shares
          .map((s, i) => ({
            index: i,
            range: rangeLabel(m.edges, i),
            shares: round(units(BigInt(s)), 2),
          }))
          .filter(b => b.shares > 0),
        leaderboard: `${VIBEKAST_SITE_URL}/season`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error placing forecast: ${error}` });
    }
  }

  /**
   * Claims winnings, or a refund at final prices, from a settled market.
   *
   * @param walletProvider - The wallet provider holding the shares.
   * @param args - The market to claim from.
   * @returns The claim result as a JSON string.
   */
  @CreateAction({
    name: "claim_winnings",
    description: `
This tool claims the wallet's payout from a settled VibeKast market: 1 tUSDC per share in the winning range, or a refund at final prices if the market was voided.
It takes the address of a past VibeKast market. Markets settle shortly after their Sunday close. It does nothing if there is nothing to claim.
`,
    schema: VibeKastClaimWinningsSchema,
  })
  async claimWinnings(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof VibeKastClaimWinningsSchema>,
  ): Promise<string> {
    try {
      const market = args.marketAddress as Hex;
      if (!(await this.isVibeKastMarket(walletProvider, market))) {
        return JSON.stringify({ success: false, error: `${market} is not a VibeKast market.` });
      }
      const read = <T>(functionName: "resolved" | "voided" | "winningBucket" | "n") =>
        walletProvider.readContract({
          address: market,
          abi: MARKET_ABI,
          functionName,
        }) as Promise<T>;
      const [resolved, voided] = await Promise.all([
        read<boolean>("resolved"),
        read<boolean>("voided"),
      ]);
      if (!resolved && !voided) {
        return JSON.stringify({
          success: false,
          error: "This market has not settled yet. Try again after it resolves.",
        });
      }

      const wallet = walletProvider.getAddress() as Hex;
      const n = Number(await read<bigint>("n"));
      const shares = (await walletProvider.readContract({
        address: market,
        abi: MARKET_ABI,
        functionName: "balanceOfBatch",
        args: [Array(n).fill(wallet), Array.from({ length: n }, (_, i) => BigInt(i))],
      })) as readonly bigint[];
      const claimable = voided
        ? shares.some(s => s > 0n)
        : shares[Number(await read<bigint>("winningBucket"))] > 0n;
      if (!claimable) {
        return JSON.stringify({ success: true, message: "Nothing to claim in this market." });
      }

      const hash = await walletProvider.sendTransaction({
        to: market,
        data: encodeFunctionData({
          abi: MARKET_ABI,
          functionName: voided ? "redeemVoided" : "redeem",
        }),
      });
      const receipt = await walletProvider.waitForTransactionReceipt(hash);
      if (receipt?.status !== "success") throw new Error(`transaction ${hash} reverted`);
      return JSON.stringify({
        success: true,
        message: voided
          ? "Claimed a refund at final prices from the voided market."
          : "Claimed winnings.",
        transactionHash: hash,
        explorer: `${EXPLORER_TX_URL}${hash}`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error claiming winnings: ${error}` });
    }
  }

  /**
   * Registers the wallet as a named agent on the VibeKast leaderboard by
   * signing a message. No transaction or gas is needed.
   *
   * @param walletProvider - The wallet provider that signs the registration.
   * @param args - The agent's public name and optional details.
   * @returns The registration result as a JSON string.
   */
  @CreateAction({
    name: "register_agent",
    description: `
This tool registers the wallet as a named AI agent on the VibeKast Season leaderboard by signing a message (no gas needed).
Registered agents earn Season points under the same rules as human traders and are shown with an AI tag.
It takes a public name (3 to 32 characters) and an optional https website and one-line description. Ask the user for the name if unsure.
`,
    schema: VibeKastRegisterAgentSchema,
  })
  async registerAgent(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof VibeKastRegisterAgentSchema>,
  ): Promise<string> {
    try {
      const name = args.name.trim();
      const url = args.url?.trim() || null;
      const description = args.description?.trim() || null;
      const wallet = walletProvider.getAddress().toLowerCase();
      const issuedAt = new Date().toISOString();
      const message = vibekastRegistrationMessage({ name, wallet, url, description, issuedAt });
      const signature = await walletProvider.signMessage(message);
      await this.api("/register", { name, wallet, url, description, issuedAt, signature });
      return JSON.stringify({
        success: true,
        message: `Registered "${name}". Trades from this wallet now earn Season points, shown with an AI tag.`,
        leaderboard: `${VIBEKAST_SITE_URL}/season`,
      });
    } catch (error) {
      return JSON.stringify({ success: false, error: `Error registering agent: ${error}` });
    }
  }

  /**
   * Checks if the action provider supports the given network.
   *
   * @param network - The network to check.
   * @returns True if the network is Base Sepolia.
   */
  supportsNetwork = (network: Network) => network.networkId === VIBEKAST_NETWORK_ID;

  /**
   * Calls the VibeKast agent API.
   *
   * @param path - API path, e.g. "/market".
   * @param body - JSON body; when given the request is a POST.
   * @returns The parsed JSON response.
   */
  private async api<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error ?? `VibeKast API returned ${res.status}`);
    return json as T;
  }

  /**
   * Reads the live market and its collateral straight from the chain, so the
   * wallet only ever sends to contracts it verified itself.
   *
   * @param walletProvider - The wallet provider to read with.
   * @returns The live market and collateral token addresses.
   */
  private async liveMarket(
    walletProvider: EvmWalletProvider,
  ): Promise<{ market: Hex; collateral: Hex }> {
    const market = (await walletProvider.readContract({
      address: VIBEKAST_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "latest",
    })) as Hex;
    const collateral = (await walletProvider.readContract({
      address: market,
      abi: MARKET_ABI,
      functionName: "collateral",
    })) as Hex;
    return { market, collateral };
  }

  /**
   * Waits until an approval is visible to the RPC node. Load-balanced RPCs can
   * lag a block behind the receipt, and the buy would then fail gas estimation.
   *
   * @param walletProvider - The wallet provider to read with.
   * @param collateral - The collateral token.
   * @param market - The approved spender.
   * @param approveData - Calldata of the approval that was just mined.
   */
  private async waitForAllowance(
    walletProvider: EvmWalletProvider,
    collateral: Hex,
    market: Hex,
    approveData: Hex,
  ): Promise<void> {
    const [, amount] = decodeFunctionData({ abi: COLLATERAL_ABI, data: approveData }).args as [
      Hex,
      bigint,
    ];
    const owner = walletProvider.getAddress() as Hex;
    for (let attempt = 0; attempt < ALLOWANCE_POLL.attempts; attempt++) {
      const allowance = (await walletProvider.readContract({
        address: collateral,
        abi: COLLATERAL_ABI,
        functionName: "allowance",
        args: [owner, market],
      })) as bigint;
      if (allowance >= amount) return;
      await new Promise(resolve => setTimeout(resolve, ALLOWANCE_POLL.intervalMs));
    }
    throw new Error("the approval did not become visible on the RPC node in time; try again");
  }

  /**
   * Checks whether an address is a market in the VibeKast registry.
   *
   * @param walletProvider - The wallet provider to read with.
   * @param market - The address to check.
   * @returns True if the registry lists the market.
   */
  private async isVibeKastMarket(walletProvider: EvmWalletProvider, market: Hex): Promise<boolean> {
    const count = (await walletProvider.readContract({
      address: VIBEKAST_REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: "count",
    })) as bigint;
    for (let i = count - 1n; i >= 0n; i--) {
      const listed = (await walletProvider.readContract({
        address: VIBEKAST_REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: "marketAt",
        args: [i],
      })) as Hex;
      if (sameAddress(listed, market)) return true;
    }
    return false;
  }

  /**
   * Refuses any transaction from the API that is not an approval of the live
   * market or a buy on it, or that could spend more than the budget plus
   * slippage.
   *
   * @param order - The order returned by the API.
   * @param market - The live market, read from the chain.
   * @param collateral - The market's collateral token, read from the chain.
   * @param spendCap - The most the wallet may spend, in wei.
   */
  private checkOrder(order: OrderResponse, market: Hex, collateral: Hex, spendCap: bigint): void {
    if (!sameAddress(order.market, market))
      throw new Error("the API returned an order for a different market");
    if (BigInt(order.maxCost.wad) > spendCap)
      throw new Error("the order would spend more than the budget");
    const buys = order.transactions.filter(tx => sameAddress(tx.to, market));
    if (buys.length !== 1 || order.transactions[order.transactions.length - 1] !== buys[0]) {
      throw new Error("the order must end with exactly one buy");
    }
    for (const tx of order.transactions) {
      if (BigInt(tx.value || "0") !== 0n) throw new Error("the order must not send ETH");
      if (sameAddress(tx.to, collateral)) {
        const call = decodeFunctionData({ abi: COLLATERAL_ABI, data: tx.data });
        if (call.functionName !== "approve")
          throw new Error("unexpected call to the collateral token");
        const [spender, amount] = call.args as [Hex, bigint];
        if (!sameAddress(spender, market) || amount > spendCap)
          throw new Error("unexpected approval");
      } else if (sameAddress(tx.to, market)) {
        const call = decodeFunctionData({ abi: MARKET_ABI, data: tx.data });
        if (call.functionName !== "buy") throw new Error("unexpected call to the market");
        const [, maxCost] = call.args as [readonly bigint[], bigint];
        if (maxCost > spendCap) throw new Error("the trade would spend more than the budget");
      } else {
        throw new Error(`the order sends to an unknown contract ${tx.to}`);
      }
    }
  }
}

/**
 * The exact message a wallet signs (EIP-191) to register on the VibeKast
 * Agent League.
 *
 * @param f - The registration fields.
 * @param f.name - The agent's public name.
 * @param f.wallet - The wallet address, lowercase.
 * @param f.url - The agent's website, or null.
 * @param f.description - The agent's description, or null.
 * @param f.issuedAt - ISO 8601 UTC timestamp of signing.
 * @returns The message to sign.
 */
export function vibekastRegistrationMessage(f: {
  name: string;
  wallet: string;
  url: string | null;
  description: string | null;
  issuedAt: string;
}): string {
  return [
    "VibeKast Agent League registration",
    `Agent: ${f.name}`,
    `Wallet: ${f.wallet.toLowerCase()}`,
    `Website: ${f.url ?? "none"}`,
    `About: ${f.description ?? "none"}`,
    "Chain ID: 84532",
    `Issued at: ${f.issuedAt}`,
  ].join("\n");
}

export const vibekastActionProvider = (config?: VibeKastActionProviderConfig) =>
  new VibeKastActionProvider(config);
