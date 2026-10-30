// The SigmaUSD bank contract on the mock chain, seeded like the live bank: mint SigUSD, redeem it.
import { MockChain } from "@fleet-sdk/mock-chain";
import { afterEach, describe, expect, it } from "vitest";
import { SIGMA_USD_PARAMETERS, SigmaUSDBank } from "@fleet-sdk/ageusd-plugin";
import { SLong } from "@fleet-sdk/serializer";
import { buildMint, buildRedeem, mintQuote, redeemQuote } from "./bank";

const P = SIGMA_USD_PARAMETERS;
const ERG = 1_000_000_000n;

describe("SigmaUSD bank", () => {
  const chain = new MockChain({ height: 1_900_000 });
  const user = chain.newParty("user");
  const bank = chain.addParty(P.contract, "bank");
  // the oracle is a data input: any box with the oracle NFT and R4 = nanoERG per USD
  const oracle = chain.newParty("oracle");
  afterEach(() => chain.reset({ clearParties: true }));

  function seed() {
    // 2,000,000 ERG in reserve, 100,000 SigUSD (liabilities 300,000 ERG at 3 ERG/USD: ratio 667%) and 10,000,000 SigRSV out
    const stableCirc = 100_000_00n,
      reserveCirc = 10_000_000n;
    bank.addBalance(
      {
        nanoergs: 2_000_000n * ERG,
        tokens: [
          { tokenId: P.tokens.stableCoinId, amount: 10_000_000_000_000n - stableCirc },
          { tokenId: P.tokens.reserveCoinId, amount: 10_000_000_000_000n - reserveCirc },
          { tokenId: P.tokens.nftId, amount: 1n },
        ],
      },
      { R4: SLong(stableCirc).toHex(), R5: SLong(reserveCirc).toHex() },
    );
    oracle.addBalance(
      { nanoergs: 1n * ERG, tokens: [{ tokenId: P.oracle.nftId, amount: 1n }] },
      { R4: SLong(3_000_000_000n).toHex() },
    ); // 1 USD = 3 ERG, as nanoERG per cent * 100
    user.addBalance({ nanoergs: 100n * ERG });
    chain.addParty(bank);
    chain.addParty(oracle);
    chain.addParty(user);
    return new SigmaUSDBank(bank.utxos.at(0) as never, oracle.utxos.at(0) as never);
  }

  it("mints 10 SigUSD at the oracle price plus the 2% protocol fee, then redeems them", () => {
    const b = seed();
    expect(b.reserveRatio).toBeGreaterThan(400n);
    expect(b.reserveRatio).toBeLessThan(800n);
    const q = mintQuote(b, "stable", 1_000n);
    expect(q.allowed).toBe(true);
    const before = user.balance.nanoergs;
    const mint = buildMint({
      height: chain.height,
      inputs: user.utxos.toArray(),
      user: user.address,
      bank: b,
      coin: "stable",
      amount: 1_000n,
    });
    expect(chain.execute(mint, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([{ tokenId: P.tokens.stableCoinId, amount: 1_000n }]);
    expect(before - user.balance.nanoergs).toBe(q.erg);

    const b2 = new SigmaUSDBank(bank.utxos.at(0) as never, oracle.utxos.at(0) as never);
    const r = redeemQuote(b2, "stable", 1_000n);
    expect(r.allowed).toBe(true);
    const red = buildRedeem({
      height: chain.height,
      inputs: user.utxos.toArray(),
      user: user.address,
      bank: b2,
      coin: "stable",
      amount: 1_000n,
    });
    expect(chain.execute(red, { signers: [user] })).toBe(true);
    expect(user.balance.tokens).toEqual([]);
    expect(r.erg).toBeLessThan(q.erg); // the two fees
  });
});
