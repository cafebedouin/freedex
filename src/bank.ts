// The SigmaUSD bank as a venue: mint or redeem SigUSD and SigRSV against the bank box at the oracle price, through
// Fleet's AgeUSD plugin, with no implementor fee. The protocol fee (2%) is the bank's own. Compared on the Swap tab
// against the pool route for the same tokens.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { AgeUSDExchangePlugin, SIGMA_USD_PARAMETERS, SigmaUSDBank, type CoinType } from "@fleet-sdk/ageusd-plugin";
import { ErgoAddress, TransactionBuilder } from "@fleet-sdk/core";
import type { Explorer } from "./explorer.ts";
import { FEE } from "./orders.ts";

export const SIGUSD_ID = SIGMA_USD_PARAMETERS.tokens.stableCoinId;
export const SIGRSV_ID = SIGMA_USD_PARAMETERS.tokens.reserveCoinId;
export const BANK_NFT = SIGMA_USD_PARAMETERS.tokens.nftId;
export const ORACLE_NFT = SIGMA_USD_PARAMETERS.oracle.nftId;

export function coinOf(tokenId: string): CoinType | undefined {
  return tokenId === SIGUSD_ID ? "stable" : tokenId === SIGRSV_ID ? "reserve" : undefined;
}

/** The bank and its oracle as they stand now. */
export async function loadBank(explorer: Explorer): Promise<SigmaUSDBank> {
  const [bankBoxes, oracleBoxes] = await Promise.all([explorer.byToken(BANK_NFT, 1), explorer.byToken(ORACLE_NFT, 1)]);
  if (!bankBoxes[0] || !oracleBoxes[0]) throw new Error("bank or oracle box not found");
  return new SigmaUSDBank(bankBoxes[0] as never, oracleBoxes[0] as never);
}

export interface BankQuote {
  /** nanoERG the user pays (mint) or receives (redeem), all fees and the miner fee included */
  erg: bigint;
  allowed: boolean;
  reserveRatioAfter: bigint;
}

export function mintQuote(bank: SigmaUSDBank, coin: CoinType, amount: bigint): BankQuote {
  return { erg: bank.getMintingCostFor(amount, coin, "total", FEE), allowed: bank.canMint(amount, coin), reserveRatioAfter: bank.getReserveRatioFor("minting", amount, coin) };
}

export function redeemQuote(bank: SigmaUSDBank, coin: CoinType, amount: bigint): BankQuote {
  return { erg: bank.getRedeemingAmountFor(amount, coin, "total", FEE), allowed: bank.canRedeem(amount, coin), reserveRatioAfter: bank.getReserveRatioFor("redeeming", amount, coin) };
}

export interface BankParams {
  height: number;
  inputs: Box<Amount>[];
  user: ErgoAddress;
  bank: SigmaUSDBank;
  coin: CoinType;
  amount: bigint;
}

export function buildMint(p: BankParams): EIP12UnsignedTransaction {
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .extend(AgeUSDExchangePlugin(p.bank, { mint: p.coin, amount: p.amount, recipient: p.user, transactionFee: FEE }))
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}

export function buildRedeem(p: BankParams): EIP12UnsignedTransaction {
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .extend(AgeUSDExchangePlugin(p.bank, { redeem: p.coin, amount: p.amount, recipient: p.user, transactionFee: FEE }))
    .sendChangeTo(p.user)
    .payFee(FEE)
    .build()
    .toEIP12Object();
}
