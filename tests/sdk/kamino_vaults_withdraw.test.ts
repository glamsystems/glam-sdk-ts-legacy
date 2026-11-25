import { BN } from "@coral-xyz/anchor";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BaseClient } from "../../src/client/base";
import { KaminoVaultsClient } from "../../src/client/kamino/vaults";

const key = () => Keypair.generate().publicKey;

/** A mint account as the token program stores it. */
function mintAccount() {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt(0),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
}

/** A reserve as KaminoLendingClient parses it, with what withdrawTx reads. */
function reserve(address: PublicKey) {
  return {
    getAddress: () => address,
    lendingMarket: key(),
    liquidity: { supplyVault: key() },
    collateral: { mintPubkey: key() },
  };
}

const allocation = (reserveKey: PublicKey, ctokenVault: PublicKey) => ({
  reserve: reserveKey,
  ctokenVault,
});

/** The withdraw instruction's accounts, built against fakes of the chain. */
async function withdrawAccounts(
  allocations: ReturnType<typeof allocation>[],
  cachedFirst: PublicKey[] = [],
) {
  const base = Object.create(BaseClient.prototype) as BaseClient;
  let accounts: Record<string, PublicKey> = {};
  const builder = {
    accounts: (given: Record<string, PublicKey>) => {
      accounts = given;
      return builder;
    },
    remainingAccounts: () => builder,
    preInstructions: () => builder,
    transaction: async () => ({}),
  };
  Object.defineProperties(base, {
    provider: {
      value: {
        connection: { getAccountInfo: jest.fn(async () => mintAccount()) },
        publicKey: key(),
      },
    },
    statePda: { value: key() },
    vaultPda: { value: key() },
    extKaminoProgram: {
      value: { methods: { vaultsWithdraw: () => builder } },
    },
    intoVersionedTransaction: { value: jest.fn(async (tx: unknown) => tx) },
  });

  // The lending client keeps the reserves it parsed and returns a request
  // in the order it cached them.
  const cache = new Map<string, ReturnType<typeof reserve>>();
  const kaminoLending = {
    fetchAndParseReserves: jest.fn(async (keys: PublicKey[]) => {
      keys.forEach((k) => {
        if (!cache.has(k.toBase58())) {
          cache.set(k.toBase58(), reserve(k));
        }
      });
      const wanted = new Set(keys.map((k) => k.toBase58()));
      return [...cache.values()].filter((r) =>
        wanted.has(r.getAddress().toBase58()),
      );
    }),
    getMarketAuthority: () => key(),
  };
  await kaminoLending.fetchAndParseReserves(cachedFirst);

  const client = new KaminoVaultsClient(base, kaminoLending as never);
  Object.defineProperty(client, "globalConfigPda", { value: key() });
  client.fetchAndParseVaultState = jest.fn(async () => ({
    tokenMint: key(),
    tokenProgram: TOKEN_PROGRAM_ID,
    sharesMint: key(),
    tokenVault: key(),
    baseVaultAuthority: key(),
    vaultAllocationStrategy: allocations,
  })) as never;
  client.composeRemainingAccounts = jest.fn(async () => []) as never;

  await client.txBuilder.withdrawTx(key(), new BN(1), {});
  return accounts;
}

describe("a Kamino vault withdrawal from a reserve", () => {
  const [r0, r1, c0, c1] = [key(), key(), key(), key()];

  it("takes the reserve and its ctoken vault from the first allocation", async () => {
    const accounts = await withdrawAccounts([
      allocation(r0, c0),
      allocation(r1, c1),
    ]);
    expect(accounts.withdrawFromReserveReserve.equals(r0)).toBe(true);
    expect(accounts.withdrawFromReserveCtokenVault.equals(c0)).toBe(true);
  });

  // The reserve came from the allocations without empty entries, the ctoken
  // vault from entry 0 as it stood.
  it("takes both from one entry when entry 0 is empty", async () => {
    const accounts = await withdrawAccounts([
      allocation(PublicKey.default, PublicKey.default),
      allocation(r1, c1),
    ]);
    expect(accounts.withdrawFromReserveReserve.equals(r1)).toBe(true);
    expect(accounts.withdrawFromReserveCtokenVault.equals(c1)).toBe(true);
  });

  // The lending client answers in the order it cached the reserves, so the
  // first reserve answered need not be the first allocation's.
  it("takes the first allocation's reserve when another was cached first", async () => {
    const accounts = await withdrawAccounts(
      [allocation(r0, c0), allocation(r1, c1)],
      [r1],
    );
    expect(accounts.withdrawFromReserveReserve.equals(r0)).toBe(true);
    expect(accounts.withdrawFromReserveCtokenVault.equals(c0)).toBe(true);
  });

  it("refuses a vault with no reserve allocation", async () => {
    const vault = withdrawAccounts([
      allocation(PublicKey.default, PublicKey.default),
    ]);
    await expect(vault).rejects.toThrow("has no reserve allocation");
  });
});
