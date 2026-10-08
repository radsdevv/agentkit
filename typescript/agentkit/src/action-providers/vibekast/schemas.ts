import { z } from "zod";
import { ORDER_LIMITS, QUANTILE_LEVELS } from "./constants";

/**
 * Input schema for actions that take no input.
 */
export const VibeKastEmptySchema = z.object({}).strip().describe("No input needed");

/**
 * Input schema for placing a forecast on the live market.
 */
export const VibeKastPlaceForecastSchema = z
  .object({
    quantiles: z
      .array(z.number().positive())
      .max(QUANTILE_LEVELS.length)
      .optional()
      .describe(
        `Your forecast of the BTC settlement price in USD at the ${QUANTILE_LEVELS.join("th, ")}th percentiles, lowest first, e.g. [76000, 77500, 79500, 81000, 82500, 84500, 86000]. Give exactly 7 values, or leave this out or empty when giving probs.`,
      ),
    probs: z
      .array(z.number().nonnegative())
      .optional()
      .describe(
        "Alternative to quantiles: one probability per price range from get_market, in index order. They are normalized for you. Leave this out or empty when giving quantiles.",
      ),
    budget: z
      .number()
      .min(ORDER_LIMITS.minBudget)
      .max(ORDER_LIMITS.maxBudget)
      .describe(
        `Test USDC to spend, fee included, from ${ORDER_LIMITS.minBudget} to ${ORDER_LIMITS.maxBudget}. At least 5 counts toward the leaderboard.`,
      ),
    slippageBps: z
      .number()
      .int()
      .min(0)
      .max(ORDER_LIMITS.maxSlippageBps)
      .optional()
      .describe(
        `Allowance for prices moving before the trade lands, in basis points. Default ${ORDER_LIMITS.defaultSlippageBps}.`,
      ),
  })
  .strip()
  .describe("Instructions for placing a forecast on the live VibeKast market");

/**
 * Input schema for claiming winnings from a settled market.
 */
export const VibeKastClaimWinningsSchema = z
  .object({
    marketAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format")
      .describe("Address of a settled VibeKast market the wallet traded in"),
  })
  .strip()
  .describe("Instructions for claiming winnings from a settled VibeKast market");

/**
 * Input schema for registering the wallet as an agent on the leaderboard.
 */
export const VibeKastRegisterAgentSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,30}[A-Za-z0-9]$/,
        "3 to 32 characters: letters, numbers, spaces, dots, dashes or underscores",
      )
      .describe("Public name for the agent on the leaderboard, 3 to 32 characters"),
    url: z
      .string()
      .url()
      .startsWith("https://", "Must be an https:// link")
      .max(200)
      .optional()
      .describe("Optional https:// website for the agent, up to 200 characters"),
    description: z
      .string()
      .max(280)
      .regex(/^[^\r\n]*$/, "Must be a single line")
      .optional()
      .describe("Optional one-line description of the agent, up to 280 characters"),
  })
  .strip()
  .describe("Instructions for registering the wallet as a VibeKast agent");
