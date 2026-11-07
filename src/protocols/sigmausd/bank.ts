// The SigmaUSD bank as a venue: mint or redeem SigUSD and SigRSV against the bank box at the oracle price, through
// Fleet's AgeUSD plugin, with no implementor fee. The protocol fee (2%) is the bank's own. Compared on the Swap tab
// against the pool route for the same tokens.
import type { Amount, Box, EIP12UnsignedTransaction } from "@fleet-sdk/common";
import { AgeUSDExchangePlugin, SIGMA_USD_PARAMETERS, SigmaUSDBank, type CoinType } from "@fleet-sdk/ageusd-plugin";
import { ErgoAddress, TransactionBuilder } from "@fleet-sdk/core";
import type { Explorer } from "../../explorer.ts";

/**
 * The miner fee on a bank transaction, 0.003 ERG, three times the page's usual 0.001. The bank box is shared and
 * spent every few blocks (a bot trading cents of SigUSD at 0.0011 ERG on about 1,190 bytes). Chaining off the
 * mempool (`loadBank`) covers a spend already pending when the page reads; a spend that arrives while the phone is
 * signing still conflicts, and a node keeps the one paying more per byte. At 0.001 on about 1,250 bytes the page's
 * transaction lost that tie; at 0.003 it wins it.
 */
export const BANK_FEE = 3_000_000n;

export const SIGUSD_ID = SIGMA_USD_PARAMETERS.tokens.stableCoinId;
export const SIGRSV_ID = SIGMA_USD_PARAMETERS.tokens.reserveCoinId;
export const BANK_NFT = SIGMA_USD_PARAMETERS.tokens.nftId;
export const ORACLE_NFT = SIGMA_USD_PARAMETERS.oracle.nftId;

export function coinOf(tokenId: string): CoinType | undefined {
  return tokenId === SIGUSD_ID ? "stable" : tokenId === SIGRSV_ID ? "reserve" : undefined;
}

/**
 * The bank and its oracle as they stand now, mempool included: each is chained off any unconfirmed transaction
 * that spends it. The bank box is spent every few blocks (a bot trades against it), so the confirmed box is often
 * already spent in the mempool, and a mint built on it is refused as a double spend.
 */
export async function loadBank(explorer: Explorer): Promise<SigmaUSDBank> {
  const [bankBox, oracleBox] = await Promise.all([
    explorer.latestByToken(BANK_NFT),
    explorer.latestByToken(ORACLE_NFT),
  ]);
  return new SigmaUSDBank(bankBox as never, oracleBox as never);
}

export interface BankQuote {
  /** nanoERG the user pays (mint) or receives (redeem), all fees and the miner fee included */
  erg: bigint;
  allowed: boolean;
  reserveRatioAfter: bigint;
}

export function mintQuote(bank: SigmaUSDBank, coin: CoinType, amount: bigint): BankQuote {
  return {
    erg: bank.getMintingCostFor(amount, coin, "total", BANK_FEE),
    allowed: bank.canMint(amount, coin),
    reserveRatioAfter: bank.getReserveRatioFor("minting", amount, coin),
  };
}

export function redeemQuote(bank: SigmaUSDBank, coin: CoinType, amount: bigint): BankQuote {
  return {
    erg: bank.getRedeemingAmountFor(amount, coin, "total", BANK_FEE),
    allowed: bank.canRedeem(amount, coin),
    reserveRatioAfter: bank.getReserveRatioFor("redeeming", amount, coin),
  };
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
    .extend(
      AgeUSDExchangePlugin(p.bank, { mint: p.coin, amount: p.amount, recipient: p.user, transactionFee: BANK_FEE }),
    )
    .sendChangeTo(p.user)
    .payFee(BANK_FEE)
    .build()
    .toEIP12Object();
}

export function buildRedeem(p: BankParams): EIP12UnsignedTransaction {
  return new TransactionBuilder(p.height)
    .from(p.inputs)
    .extend(
      AgeUSDExchangePlugin(p.bank, { redeem: p.coin, amount: p.amount, recipient: p.user, transactionFee: BANK_FEE }),
    )
    .sendChangeTo(p.user)
    .payFee(BANK_FEE)
    .build()
    .toEIP12Object();
}
