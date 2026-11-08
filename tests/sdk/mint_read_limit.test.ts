import {
  MINT_SIZE,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { BaseClient } from "../../src/client/base";
import { ClusterNetwork } from "../../src/clientConfig";
import { GLAM_CONFIG_PROGRAM } from "../../src/constants";
import { GlobalConfig } from "../../src/globalConfig";
import { fetchMintsAndTokenPrograms } from "../../src/utils/accounts";
import { getGlobalConfigPda } from "../../src/utils/glamPDAs";

const GLOBAL_CONFIG_DISCRIMINATOR = [149, 8, 156, 202, 160, 252, 176, 217];

// glam_config's upsert_asset_meta extends the account and sets no cap on
// registrations.
const MINTS = Array.from({ length: 150 }, () => PublicKey.unique());
const INDEX_BY_MINT = new Map(
  MINTS.map((mint, index) => [mint.toBase58(), index]),
);

// Every third mint is a Token-2022 mint, so a result out of key order shows.
const tokenProgramAt = (index: number) =>
  index % 3 === 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

function accountInfo(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 0, owner, rentEpoch: 0 };
}

/** The mint at `index`: its token program as the owner, `index` as the supply. */
function mintAccount(index: number): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt(index),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return accountInfo(tokenProgramAt(index), data);
}

/** A GlobalConfig account with one active registration per mint. */
function globalConfigAccount(mints: PublicKey[]): AccountInfo<Buffer> {
  // GlobalConfig.encode allocates 4096 bytes, fewer than 150 registrations take.
  const buffer = Buffer.alloc(16 * 1024);
  const length = GlobalConfig._layout.encode(
    {
      discriminator: GLOBAL_CONFIG_DISCRIMINATOR,
      admin: PublicKey.default,
      feeAuthority: PublicKey.default,
      referrer: PublicKey.default,
      baseFeeBps: 0,
      flowFeeBps: 0,
      assetMetas: mints.map((asset) => ({
        asset,
        decimals: 6,
        oracle: PublicKey.default,
        oracleSourceOrdinal: 1,
        maxAgeSeconds: 30,
        priority: 0,
        padding: [0, 0, 0],
      })),
    },
    buffer,
  );
  return accountInfo(GLAM_CONFIG_PROGRAM, buffer.subarray(0, length));
}

describe("Mint reads at an endpoint that refuses more than 100 keys per request", () => {
  /**
   * A getMultipleAccountsInfo that refuses more than 100 keys, as the endpoint
   * does. It holds every mint of MINTS but those at the `missing` indexes.
   */
  function limitedRead(missing: number[] = []) {
    return jest.fn(async (keys: PublicKey[], _commitment?: Commitment) => {
      if (keys.length > 100) {
        throw new Error("Too many inputs provided; max 100");
      }
      // A request of 100 keys answers after a shorter one sent with it.
      if (keys.length === 100) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return keys.map((key) => {
        const index = INDEX_BY_MINT.get(key.toBase58());
        return index === undefined || missing.includes(index)
          ? null
          : mintAccount(index);
      });
    });
  }

  function expectConfirmedReadsOfAtMost100(read: jest.Mock) {
    expect(read).toHaveBeenCalled();
    for (const [keys, commitment] of read.mock.calls) {
      expect(keys.length).toBeLessThanOrEqual(100);
      expect(commitment).toBe("confirmed");
    }
  }

  /** A BaseClient whose endpoint holds a GlobalConfig that registers MINTS. */
  function clientAt(getMultipleAccountsInfo: jest.Mock): BaseClient {
    const getAccountInfo = jest.fn(async (key: PublicKey) =>
      key.equals(getGlobalConfigPda()) ? globalConfigAccount(MINTS) : null,
    );
    return Object.assign(Object.create(BaseClient.prototype), {
      cluster: ClusterNetwork.Mainnet,
      provider: { connection: { getAccountInfo, getMultipleAccountsInfo } },
    }) as BaseClient;
  }

  /** The mints `fetchAssetMetas` resolves and their token programs, in map order. */
  async function resolvedTokenPrograms(client: BaseClient) {
    const assetMetas = await client.fetchAssetMetas();
    return Array.from(assetMetas, ([asset, { programId }]) => [
      asset.toBase58(),
      programId.toBase58(),
    ]);
  }

  const expectedTokenPrograms = (missing: number[] = []) =>
    MINTS.flatMap((mint, index) =>
      missing.includes(index)
        ? []
        : [[mint.toBase58(), tokenProgramAt(index).toBase58()]],
    );

  it("fetchAssetMetas resolves the token program of 150 registered mints in registration order", async () => {
    const read = limitedRead();

    const resolved = await resolvedTokenPrograms(clientAt(read));

    expect(resolved).toEqual(expectedTokenPrograms());
    expect(read.mock.calls.map(([keys]) => keys.length)).toEqual([100, 50]);
    expectConfirmedReadsOfAtMost100(read);
  });

  it("fetchAssetMetas resolves the mints the cluster holds when each request misses one", async () => {
    const missing = [7, 120];
    const read = limitedRead(missing);

    const resolved = await resolvedTokenPrograms(clientAt(read));

    expect(resolved).toHaveLength(148);
    expect(resolved).toEqual(expectedTokenPrograms(missing));
    expectConfirmedReadsOfAtMost100(read);
  });

  it("fetchMintsAndTokenPrograms returns 150 mints in key order when the second request answers first", async () => {
    const read = limitedRead();

    const mints = await fetchMintsAndTokenPrograms(
      { getMultipleAccountsInfo: read } as unknown as Connection,
      MINTS,
    );

    expect(mints.map(({ mint }) => Number(mint.supply))).toEqual(
      MINTS.map((_, index) => index),
    );
    expect(mints.map(({ tokenProgram }) => tokenProgram.toBase58())).toEqual(
      MINTS.map((_, index) => tokenProgramAt(index).toBase58()),
    );
    expectConfirmedReadsOfAtMost100(read);
  });

  it("keeps the batched read out of the package's exports", () => {
    const sdk = jest.requireActual("../../src");
    const { getMultipleAccountsInfoBatched } = jest.requireActual(
      "../../src/utils/multipleAccounts",
    );

    expect(sdk.fetchMintsAndTokenPrograms).toBe(fetchMintsAndTokenPrograms);
    expect(getMultipleAccountsInfoBatched).toBeDefined();
    expect(Object.values(sdk)).not.toContain(getMultipleAccountsInfoBatched);
  });
});
