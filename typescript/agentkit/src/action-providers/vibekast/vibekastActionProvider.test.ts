import { encodeFunctionData, Hex } from "viem";
import { EvmWalletProvider } from "../../wallet-providers";
import { COLLATERAL_ABI, MARKET_ABI, VIBEKAST_REGISTRY_ADDRESS } from "./constants";
import { VibeKastPlaceForecastSchema } from "./schemas";
import {
  vibekastActionProvider,
  VibeKastActionProvider,
  vibekastRegistrationMessage,
} from "./vibekastActionProvider";

const WALLET = "0x1111111111111111111111111111111111111111" as Hex;
const MARKET = "0x2222222222222222222222222222222222222222" as Hex;
const COLLATERAL = "0x3333333333333333333333333333333333333333" as Hex;
const OLD_MARKET = "0x4444444444444444444444444444444444444444" as Hex;
const STRANGER = "0x5555555555555555555555555555555555555555" as Hex;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const WAD = 10n ** 18n;
const N = 4;

const MARKET_RESPONSE = {
  market: MARKET,
  collateral: COLLATERAL,
  label: "2026-W41",
  question: "BTC price at market close",
  closeTimeIso: "2026-10-11T23:59:00.000Z",
  open: true,
  n: N,
  edges: [60000, 62000, 64000, 66000, 68000],
  prices: [0.1, 0.4, 0.3, 0.2],
  feeBps: 100,
  spot: { price: 63000, updatedAt: 1 },
  settlement: "Chainlink BTC/USD, 2h TWAP",
};

const QUANTILES = [61000, 61500, 62500, 63000, 63500, 64500, 65000];

const approveTx = (spender: Hex = MARKET, amount: bigint = 5n * WAD) => ({
  to: COLLATERAL,
  data: encodeFunctionData({
    abi: COLLATERAL_ABI,
    functionName: "approve",
    args: [spender, amount],
  }),
  value: "0",
  description: "Approve",
});

const buyTx = (maxCost: bigint = 5n * WAD, to: Hex = MARKET) => ({
  to,
  data: encodeFunctionData({
    abi: MARKET_ABI,
    functionName: "buy",
    args: [[0n, 3n * WAD, 2n * WAD, 0n], maxCost],
  }),
  value: "0",
  description: "Buy",
});

const orderResponse = (transactions = [approveTx(), buyTx()], maxCostWad = 5n * WAD) => ({
  market: MARKET,
  shares: ["0", (3n * WAD).toString(), (2n * WAD).toString(), "0"],
  quote: { cost: 4.9, fee: 0.049, total: 4.949 },
  maxCost: { units: Number(maxCostWad) / 1e18, wad: maxCostWad.toString() },
  transactions,
});

const respond = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

describe("VibeKastActionProvider", () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;

  let provider: VibeKastActionProvider;
  let wallet: jest.Mocked<EvmWalletProvider>;
  let chain: Record<string, unknown>;

  beforeEach(() => {
    jest.resetAllMocks();
    provider = vibekastActionProvider();
    chain = {
      latest: MARKET,
      count: 2n,
      marketAt: (i: bigint) => (i === 0n ? OLD_MARKET : MARKET),
      collateral: COLLATERAL,
      balanceOf: 10_000n * WAD,
      allowance: 10_000n * WAD,
      balanceOfBatch: [0n, 0n, 0n, 0n],
      resolved: false,
      voided: false,
      winningBucket: 1n,
      n: BigInt(N),
    };
    wallet = {
      getAddress: jest.fn().mockReturnValue(WALLET),
      getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", networkId: "base-sepolia" }),
      getBalance: jest.fn().mockResolvedValue(10n ** 15n),
      readContract: jest.fn().mockImplementation(async ({ functionName, args }) => {
        const value = chain[functionName];
        return typeof value === "function" ? value(...(args ?? [])) : value;
      }),
      sendTransaction: jest.fn().mockResolvedValue(TX_HASH),
      waitForTransactionReceipt: jest.fn().mockResolvedValue({ status: "success" }),
      signMessage: jest.fn().mockResolvedValue(`0x${"cd".repeat(65)}`),
    } as unknown as jest.Mocked<EvmWalletProvider>;
  });

  describe("supportsNetwork", () => {
    it("supports Base Sepolia only", () => {
      expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-sepolia" })).toBe(
        true,
      );
      expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet" })).toBe(
        false,
      );
      expect(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-devnet" })).toBe(
        false,
      );
    });
  });

  describe("getMarket", () => {
    it("returns the market with labelled ranges", async () => {
      fetchMock.mockResolvedValueOnce(respond(MARKET_RESPONSE));
      const result = JSON.parse(await provider.getMarket(wallet, {}));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.vibekast.xyz/api/agents/v1/market",
        expect.objectContaining({ method: "GET" }),
      );
      expect(result.success).toBe(true);
      expect(result.spotBtcUsd).toBe(63000);
      expect(result.feePercent).toBe(1);
      expect(result.ranges.map((r: { range: string }) => r.range)).toEqual([
        "below $62,000",
        "$62,000 to $64,000",
        "$64,000 to $66,000",
        "$66,000 and above",
      ]);
    });

    it("uses a custom API URL", async () => {
      fetchMock.mockResolvedValueOnce(respond(MARKET_RESPONSE));
      await vibekastActionProvider({ apiUrl: "http://localhost:3000/api/agents/v1/" }).getMarket(
        wallet,
        {},
      );
      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:3000/api/agents/v1/market");
    });

    it("reports API errors", async () => {
      fetchMock.mockResolvedValueOnce(respond({ error: "registry not configured" }, false, 502));
      const result = JSON.parse(await provider.getMarket(wallet, {}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("registry not configured");
    });
  });

  describe("getPosition", () => {
    it("returns balances and non-zero positions", async () => {
      fetchMock.mockResolvedValueOnce(respond(MARKET_RESPONSE));
      chain.balanceOfBatch = [0n, 3n * WAD, 0n, 0n];
      chain.balanceOf = 1234n * WAD;
      const result = JSON.parse(await provider.getPosition(wallet, {}));
      expect(result.success).toBe(true);
      expect(result.tusdc).toBe(1234);
      expect(result.needsGas).toBe(false);
      expect(result.positions).toEqual([{ index: 1, range: "$62,000 to $64,000", shares: 3 }]);
    });
  });

  describe("requestTestEth", () => {
    it("skips the faucet when the wallet already has gas", async () => {
      const result = JSON.parse(await provider.requestTestEth(wallet, {}));
      expect(result.success).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("claims from the faucet and waits for the transfer", async () => {
      wallet.getBalance.mockResolvedValueOnce(0n);
      fetchMock.mockResolvedValueOnce(respond({ txHash: TX_HASH, amountEth: "0.0001" }));
      const result = JSON.parse(await provider.requestTestEth(wallet, {}));
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ wallet: WALLET });
      expect(wallet.waitForTransactionReceipt).toHaveBeenCalledWith(TX_HASH);
      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe(TX_HASH);
    });

    it("passes on faucet refusals", async () => {
      wallet.getBalance.mockResolvedValueOnce(0n);
      fetchMock.mockResolvedValueOnce(respond({ error: "Already claimed today." }, false, 429));
      const result = JSON.parse(await provider.requestTestEth(wallet, {}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("Already claimed today.");
    });
  });

  describe("mintTestUsdc", () => {
    it("calls faucet() on the collateral of the market in the registry", async () => {
      const result = JSON.parse(await provider.mintTestUsdc(wallet, {}));
      expect(wallet.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ address: VIBEKAST_REGISTRY_ADDRESS, functionName: "latest" }),
      );
      expect(wallet.sendTransaction).toHaveBeenCalledWith({
        to: COLLATERAL,
        data: encodeFunctionData({ abi: COLLATERAL_ABI, functionName: "faucet" }),
      });
      expect(result.success).toBe(true);
    });

    it("reports a reverted mint", async () => {
      wallet.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
      const result = JSON.parse(await provider.mintTestUsdc(wallet, {}));
      expect(result.success).toBe(false);
    });
  });

  describe("placeForecast", () => {
    it("builds the order from quantiles, checks it and sends approve then buy", async () => {
      fetchMock
        .mockResolvedValueOnce(respond(orderResponse()))
        .mockResolvedValueOnce(respond(MARKET_RESPONSE));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        quantiles: QUANTILES,
        budget: 5,
        slippageBps: 100,
        wallet: WALLET,
      });
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(2);
      expect(wallet.sendTransaction.mock.calls[0][0].to).toBe(COLLATERAL);
      expect(wallet.sendTransaction.mock.calls[1][0].to).toBe(MARKET);
      expect(result.bought).toEqual([
        { index: 1, range: "$62,000 to $64,000", shares: 3 },
        { index: 2, range: "$64,000 to $66,000", shares: 2 },
      ]);
    });

    it("accepts probs and a buy without an approval", async () => {
      fetchMock
        .mockResolvedValueOnce(respond(orderResponse([buyTx()])))
        .mockResolvedValueOnce(respond(MARKET_RESPONSE));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { probs: [0, 1, 1, 0], budget: 5 }),
      );
      expect(result.success).toBe(true);
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it("requires exactly one of quantiles or probs", async () => {
      const both = JSON.parse(
        await provider.placeForecast(wallet, {
          quantiles: QUANTILES,
          probs: [1, 1, 1, 1],
          budget: 5,
        }),
      );
      const neither = JSON.parse(await provider.placeForecast(wallet, { budget: 5 }));
      expect(both.success).toBe(false);
      expect(neither.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("treats empty arrays as not given, as strict tool-calling models send them", async () => {
      fetchMock
        .mockResolvedValueOnce(respond(orderResponse()))
        .mockResolvedValueOnce(respond(MARKET_RESPONSE));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, probs: [], budget: 5 }),
      );
      expect(result.success).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.quantiles).toEqual(QUANTILES);
      expect(body).not.toHaveProperty("probs");
    });

    it("requires exactly 7 quantiles", async () => {
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES.slice(1), budget: 5 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("exactly 7");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("validates quantiles and budget in the schema", () => {
      expect(
        VibeKastPlaceForecastSchema.safeParse({ quantiles: QUANTILES, budget: 5 }).success,
      ).toBe(true);
      expect(
        VibeKastPlaceForecastSchema.safeParse({ quantiles: [...QUANTILES, 90000], budget: 5 })
          .success,
      ).toBe(false);
      expect(
        VibeKastPlaceForecastSchema.safeParse({ quantiles: QUANTILES, budget: 0.5 }).success,
      ).toBe(false);
      expect(
        VibeKastPlaceForecastSchema.safeParse({ quantiles: QUANTILES, budget: 20_000 }).success,
      ).toBe(false);
    });

    it.each([
      ["a transaction to an unknown contract", [approveTx(), buyTx(5n * WAD, STRANGER)]],
      ["an approval for another spender", [approveTx(STRANGER), buyTx()]],
      ["an approval above the budget", [approveTx(MARKET, 100n * WAD), buyTx()]],
      ["a buy above the budget", [approveTx(), buyTx(100n * WAD)]],
      ["no buy", [approveTx()]],
      ["the buy before the approval", [buyTx(), approveTx()]],
    ])("refuses an order with %s", async (_label, transactions) => {
      fetchMock.mockResolvedValueOnce(respond(orderResponse(transactions)));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(false);
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("refuses an order for a different market", async () => {
      fetchMock.mockResolvedValueOnce(respond({ ...orderResponse(), market: OLD_MARKET }));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(false);
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("asks to mint when the wallet lacks test USDC", async () => {
      chain.balanceOf = 1n * WAD;
      fetchMock.mockResolvedValueOnce(respond(orderResponse()));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("mint_test_usdc");
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("waits for a lagging RPC node to show the approval before buying", async () => {
      let reads = 0;
      chain.allowance = () => (++reads < 2 ? 0n : 10_000n * WAD);
      fetchMock
        .mockResolvedValueOnce(respond(orderResponse()))
        .mockResolvedValueOnce(respond(MARKET_RESPONSE));
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(true);
      expect(reads).toBe(2);
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it("stops after a reverted transaction", async () => {
      fetchMock.mockResolvedValueOnce(respond(orderResponse()));
      wallet.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
      const result = JSON.parse(
        await provider.placeForecast(wallet, { quantiles: QUANTILES, budget: 5 }),
      );
      expect(result.success).toBe(false);
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("claimWinnings", () => {
    it("refuses addresses outside the registry", async () => {
      const result = JSON.parse(await provider.claimWinnings(wallet, { marketAddress: STRANGER }));
      expect(result.success).toBe(false);
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("waits until the market settles", async () => {
      const result = JSON.parse(
        await provider.claimWinnings(wallet, { marketAddress: OLD_MARKET }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not settled");
    });

    it("does nothing without winning shares", async () => {
      chain.resolved = true;
      chain.balanceOfBatch = [5n * WAD, 0n, 0n, 0n];
      const result = JSON.parse(
        await provider.claimWinnings(wallet, { marketAddress: OLD_MARKET }),
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain("Nothing to claim");
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    });

    it("redeems winning shares", async () => {
      chain.resolved = true;
      chain.balanceOfBatch = [0n, 2n * WAD, 0n, 0n];
      const result = JSON.parse(
        await provider.claimWinnings(wallet, { marketAddress: OLD_MARKET }),
      );
      expect(result.success).toBe(true);
      expect(wallet.sendTransaction).toHaveBeenCalledWith({
        to: OLD_MARKET,
        data: encodeFunctionData({ abi: MARKET_ABI, functionName: "redeem" }),
      });
    });

    it("claims refunds from a voided market", async () => {
      chain.voided = true;
      chain.balanceOfBatch = [0n, 0n, 0n, 1n * WAD];
      const result = JSON.parse(
        await provider.claimWinnings(wallet, { marketAddress: OLD_MARKET }),
      );
      expect(result.success).toBe(true);
      expect(wallet.sendTransaction).toHaveBeenCalledWith({
        to: OLD_MARKET,
        data: encodeFunctionData({ abi: MARKET_ABI, functionName: "redeemVoided" }),
      });
    });
  });

  describe("registerAgent", () => {
    it("signs the registration message and submits it", async () => {
      fetchMock.mockResolvedValueOnce(respond({ agent: { name: "Test Bot" } }, true, 201));
      const result = JSON.parse(
        await provider.registerAgent(wallet, { name: "Test Bot", url: "https://example.com" }),
      );
      expect(result.success).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body).toMatchObject({
        name: "Test Bot",
        wallet: WALLET.toLowerCase(),
        url: "https://example.com",
        description: null,
      });
      expect(wallet.signMessage).toHaveBeenCalledWith(
        vibekastRegistrationMessage({
          name: "Test Bot",
          wallet: WALLET,
          url: "https://example.com",
          description: null,
          issuedAt: body.issuedAt,
        }),
      );
    });

    it("passes on registration errors", async () => {
      fetchMock.mockResolvedValueOnce(respond({ error: "That name is taken." }, false, 409));
      const result = JSON.parse(await provider.registerAgent(wallet, { name: "Test Bot" }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("That name is taken.");
    });
  });

  describe("vibekastRegistrationMessage", () => {
    it("matches the format the VibeKast API verifies", () => {
      expect(
        vibekastRegistrationMessage({
          name: "Test Bot",
          wallet: "0xABCDEF0000000000000000000000000000000000",
          url: null,
          description: "Forecasts BTC",
          issuedAt: "2026-10-08T12:00:00.000Z",
        }),
      ).toBe(
        [
          "VibeKast Agent League registration",
          "Agent: Test Bot",
          "Wallet: 0xabcdef0000000000000000000000000000000000",
          "Website: none",
          "About: Forecasts BTC",
          "Chain ID: 84532",
          "Issued at: 2026-10-08T12:00:00.000Z",
        ].join("\n"),
      );
    });
  });
});
