import { ethers } from "ethers";
import { CONFIG } from "./constants";

/**
 * Delays execution for the specified number of milliseconds
 * @param ms - Number of milliseconds to delay
 * @returns A promise that resolves after the specified delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates exponential backoff delay based on attempt number
 * @param attempt - Current attempt number (0-indexed)
 * @param baseDelay - Base delay in milliseconds
 * @param maxDelay - Maximum delay in milliseconds
 * @returns The calculated delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  baseDelay = 1000,
  maxDelay = 60000,
): number {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  // Add jitter to prevent thundering herd problem
  return delay + Math.floor(Math.random() * 1000);
}

/**
 * Formats a bigint as a string with the specified number of decimals
 * @param value - The bigint value to format
 * @param decimals - Number of decimals the token has
 * @returns A formatted string
 */
export function formatBigInt(value: bigint, decimals = 18): string {
  const divisor = 10n ** BigInt(decimals);
  const integerPart = value / divisor;
  const fractionalPart = value % divisor;

  // Pad the fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, "0");

  // Trim trailing zeros
  const trimmedFractional = fractionalStr.replace(/0+$/, "");

  if (trimmedFractional.length === 0) {
    return integerPart.toString();
  }

  return `${integerPart}.${trimmedFractional}`;
}

/**
 * Truncates an Ethereum address for display
 * @param address - The Ethereum address to truncate
 * @param startLength - Number of characters to keep at the start
 * @param endLength - Number of characters to keep at the end
 * @returns A truncated address string
 */
export function truncateAddress(
  address: string,
  startLength = 6,
  endLength = 4,
): string {
  if (!address) return "";

  const start = address.substring(0, startLength + 2); // +2 for '0x'
  const end = address.substring(address.length - endLength);

  return `${start}...${end}`;
}

/**
 * Creates a formatted token string with symbol
 * @param amount - The token amount as a bigint
 * @param symbol - The token symbol
 * @param decimals - Number of decimals the token has
 * @returns A formatted token amount string with symbol
 */
export function formatTokenAmount(
  amount: bigint,
  symbol = "ETH",
  decimals = 18,
): string {
  return `${formatBigInt(amount, decimals)} ${symbol}`;
}

/**
 * Checks if a transaction is likely to succeed based on gas price and balance
 * @param provider - Ethers provider instance
 * @param address - Address to check
 * @param estimatedGas - Estimated gas amount for the transaction
 * @param gasPrice - Current gas price in wei
 * @returns True if the transaction is likely to succeed, false otherwise
 */
export async function canAffordTransaction(
  provider: ethers.Provider,
  address: string,
  estimatedGas: bigint,
  gasPrice: bigint,
): Promise<boolean> {
  const balance = await provider.getBalance(address);
  const gasCost = estimatedGas * gasPrice;
  const bufferMultiplier = 100n + BigInt(CONFIG.profitability.gasPriceBuffer);
  const bufferedGasCost = (gasCost * bufferMultiplier) / 100n;

  return balance >= bufferedGasCost;
}

/**
 * Groups an array of items by a key
 * @param items - Array of items to group
 * @param keyFn - Function that returns the key for an item
 * @returns An object with items grouped by key
 */
export function groupBy<T, K extends string | number | symbol>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  return items.reduce(
    (result, item) => {
      const key = keyFn(item);
      result[key] = result[key] || [];
      result[key].push(item);
      return result;
    },
    {} as Record<K, T[]>,
  );
}

/**
 * Chunks an array into smaller arrays of a maximum size
 * @param array - The array to chunk
 * @param size - Maximum size of each chunk
 * @returns An array of chunked arrays
 */
export function chunk<T>(array: T[], size: number): T[][] {
  return Array(Math.ceil(array.length / size))
    .fill(null)
    .map((_, index) => array.slice(index * size, (index + 1) * size));
}
