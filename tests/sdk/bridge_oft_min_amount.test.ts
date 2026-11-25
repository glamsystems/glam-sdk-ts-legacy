import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AccountInfo, Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  RouteSets,
  resolveLayerzeroOftMinAmountLd,
} from "../../src/client/bridge";
import { resolveCanonicalLayerzeroOftRouteProfile } from "../../src/client/bridgeRegistry";
import { GlamClient } from "../../src/client";
import { ClusterNetwork } from "../../src/clientConfig";
import { USDT } from "../../src/constants";
import {
  BridgeRoute,
  RouteChain,
  RouteLimits,
  RouteManagementMode,
} from "../../src/deser/integrationPolicies";
import { LAYERZERO_OFT_PROTOCOL } from "../../src/protocols";

/** The LayerZero endpoint id of Arbitrum, the chain of the checked-in USDT0 profile. */
const ARBITRUM = 30110;
/** The cost bound `allow-route` writes when `--max-cost-bps` is omitted. */
const CLI_DEFAULT_MAX_COST_BPS = 10;

const profile = resolveCanonicalLayerzeroOftRouteProfile({
  sourceMint: USDT,
  destinationChain: ARBITRUM,
  cluster: ClusterNetwork.Mainnet,
})!;

/** The program's cost check, RouteLimits::admits: (amount - quote) * 10_000 <= amount * bps. */
function admits(amount: BN, quote: BN, maxCostBps: number): boolean {
  return amount.sub(quote).muln(10_000).lte(amount.muln(maxCostBps));
}

/** Amounts in USDT's base units and the quote a route at the CLI's default bound gives each. */
const QUOTES_AT_CLI_DEFAULT: [number, number][] = [
  [1_000_000, 999_000],
  [1_000_001, 999_001],
  [999, 999],
  [1, 1],
];

function routeLimits(maxCostBps: number): RouteLimits {
  return {
    minAmount: new BN(0),
    maxAmount: new BN(1_000_000_000),
    maxCostBps,
  };
}

/** A USDT0 route to `recipient` through the profile's program, on the CLI's default limits. */
function oftRoute(
  recipient: PublicKey,
  destinationChains: RouteChain[],
): BridgeRoute {
  return {
    sourceMint: USDT,
    destinationRecipient: recipient,
    providerProgram: profile.providerProgram,
    managementMode: RouteManagementMode.UnmanagedOnly,
    limits: routeLimits(CLI_DEFAULT_MAX_COST_BPS),
    controls: { layerzeroOft: { oftStore: profile.providerSender } },
    destinationChains,
  };
}

function routeSets(live: BridgeRoute[] | null): RouteSets {
  return {
    live,
    committed: live,
    pending: null,
    liveHash: live ? Buffer.alloc(32, 1) : null,
    pendingHash: null,
    pendingCleared: false,
    generation: live ? new BN(1) : null,
    committedGeneration: live ? new BN(1) : null,
    pendingGeneration: null,
    paused: false,
  };
}

/** A classic SPL mint of six decimals, as USDT is. */
function mintAccount(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    data,
    executable: false,
    lamports: 0,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  };
}

/**
 * A mainnet client, so the USDT0 profile resolves; nothing here reaches a network. Every account
 * read answers a USDT-like mint, the only account the send reads besides the routes, which
 * `fetchRouteSets` answers.
 */
function offlineMainnetClient(fetchRouteSets: jest.Mock): GlamClient {
  const wallet = new anchor.Wallet(Keypair.generate());
  const connection = new Connection("http://127.0.0.1:1", "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {});
  const glamClient = new GlamClient({
    provider,
    cluster: ClusterNetwork.Mainnet,
    statePda: Keypair.generate().publicKey,
  });
  (connection as any).getAccountInfo = jest.fn(async () => mintAccount());
  // Return the instructions' transaction unbuilt instead of compiling (and simulating) it.
  (glamClient.bridge.txBuilder as any).buildVersionedTx = jest.fn(
    async () => ({}),
  );
  (glamClient.bridge as any).fetchRouteSets = fetchRouteSets;
  return glamClient;
}

/** The send's leading fields: the discriminator, then u32 dst_eid, 32-byte to, u64 amounts. */
function sendAmounts(data: Buffer) {
  return {
    dstEid: data.readUInt32LE(8),
    to: new PublicKey(data.subarray(12, 44)),
    amountLd: new BN(data.subarray(44, 52), "le").toString(),
    minAmountLd: new BN(data.subarray(52, 60), "le").toString(),
  };
}

describe("LayerZero OFT default quote", () => {
  it("concedes exactly a route's cost bound: the CLI's default 10 bps admits each quote", () => {
    for (const [amount, quote] of QUOTES_AT_CLI_DEFAULT) {
      const resolved = resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(amount),
        routeProfile: profile,
        maxCostBps: CLI_DEFAULT_MAX_COST_BPS,
      });
      expect(resolved.toString()).toBe(quote.toString());
      expect(admits(new BN(amount), resolved, CLI_DEFAULT_MAX_COST_BPS)).toBe(
        true,
      );
    }
  });

  it("is the lowest quote the route admits: one unit less costs more than its bound", () => {
    for (const [amount, quote] of QUOTES_AT_CLI_DEFAULT) {
      expect(
        admits(new BN(amount), new BN(quote - 1), CLI_DEFAULT_MAX_COST_BPS),
      ).toBe(false);
    }
  });

  it("without a route takes the profile's 99.5 %, which a route at the CLI's default refuses", () => {
    const resolved = resolveLayerzeroOftMinAmountLd({
      sourceAmount: new BN(1_000_000),
      routeProfile: profile,
    });
    expect(resolved.toString()).toBe("995000");
    expect(admits(new BN(1_000_000), resolved, CLI_DEFAULT_MAX_COST_BPS)).toBe(
      false,
    );

    // A profile without a default share quotes the whole amount.
    expect(
      resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(1_000_000),
        routeProfile: { ...profile, defaultMinAmountBps: undefined },
      }).toString(),
    ).toBe("1000000");
  });

  // The program refuses a quote above the amount sent (InvalidTransferTerms).
  it("refuses an explicit minAmountLd above the amount, and takes one equal to it", () => {
    expect(() =>
      resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(1_000_000),
        minAmountLd: new BN(1_000_001),
        routeProfile: profile,
      }),
    ).toThrow(
      "minAmountLd 1000001 is above the amount sent, 1000000: the program refuses a quote above the amount",
    );
    expect(
      resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(1_000_000),
        minAmountLd: new BN(1_000_000),
        routeProfile: profile,
      }).toString(),
    ).toBe("1000000");
  });

  it("takes an explicit minAmountLd over the profile, and over a cost bound when the bound admits it", () => {
    const resolve = (minAmountLd: number, maxCostBps?: number) =>
      resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(1_000_000),
        minAmountLd: new BN(minAmountLd),
        routeProfile: profile,
        maxCostBps,
      }).toString();
    expect(resolve(900_000)).toBe("900000");
    // The lowest quote the CLI's default 10 bps admits, and one above it.
    expect(resolve(999_000, CLI_DEFAULT_MAX_COST_BPS)).toBe("999000");
    expect(resolve(999_500, CLI_DEFAULT_MAX_COST_BPS)).toBe("999500");
  });

  // The program refuses the send (TransferCostExceedsRoute), and the CLI had
  // confirmed it first.
  it("refuses an explicit minAmountLd under the lowest quote a cost bound admits", () => {
    for (const [amount, minAmountLd, lowest] of [
      [1_000_000, 998_999, 999_000],
      [1_000_000, 900_000, 999_000],
      // 100 USDT at 10 bps quotes at least 99.9 USDT, so 99 USDT is refused.
      [100_000_000, 99_000_000, 99_900_000],
    ]) {
      expect(
        admits(new BN(amount), new BN(minAmountLd), CLI_DEFAULT_MAX_COST_BPS),
      ).toBe(false);
      expect(() =>
        resolveLayerzeroOftMinAmountLd({
          sourceAmount: new BN(amount),
          minAmountLd: new BN(minAmountLd),
          routeProfile: profile,
          maxCostBps: CLI_DEFAULT_MAX_COST_BPS,
        }),
      ).toThrow(
        `minAmountLd ${minAmountLd} is under ${lowest}, the lowest quote a cost bound of 10 bps admits for ${amount} sent: the program refuses a send that costs more than its route allows`,
      );
    }
  });

  it("a send without minAmountLd quotes under the live route on its chain, else under the profile", async () => {
    const recipient = Keypair.generate().publicKey;
    const fetchRouteSets = jest.fn();
    const glamClient = offlineMainnetClient(fetchRouteSets);
    const sendOneUsdt = async (minAmountLd?: BN) => {
      fetchRouteSets.mockClear();
      const { sendInstruction } = await glamClient.bridge.oft.buildSendTx({
        sourceMint: USDT,
        sourceAmount: new BN(1_000_000),
        destinationChain: ARBITRUM,
        destinationRecipient: recipient,
        nativeFeeLamports: new BN(1),
        minAmountLd,
      });
      expect(sendInstruction.programId.equals(profile.providerProgram)).toBe(
        true,
      );
      return sendAmounts(sendInstruction.data);
    };

    // A live route at the CLI's defaults on the send's chain: the quote concedes its 10 bps.
    const onArbitrum = oftRoute(recipient, [
      { chain: new BN(ARBITRUM), limits: null },
    ]);
    fetchRouteSets.mockResolvedValue(routeSets([onArbitrum]));
    const send = await sendOneUsdt();
    expect(send.dstEid).toBe(ARBITRUM);
    expect(send.to.equals(recipient)).toBe(true);
    expect(send.amountLd).toBe("1000000");
    expect(send.minAmountLd).toBe("999000");
    expect(fetchRouteSets).toHaveBeenCalledTimes(1);
    expect(fetchRouteSets).toHaveBeenCalledWith(LAYERZERO_OFT_PROTOCOL);

    // The chain's own limits replace the route's.
    fetchRouteSets.mockResolvedValue(
      routeSets([
        oftRoute(recipient, [
          { chain: new BN(ARBITRUM), limits: routeLimits(5) },
        ]),
      ]),
    );
    expect((await sendOneUsdt()).minAmountLd).toBe("999500");

    // No live route holds the send's identity on its chain: the profile's 99.5 %.
    for (const live of [
      null,
      [oftRoute(recipient, [{ chain: new BN(30101), limits: null }])],
      [
        oftRoute(Keypair.generate().publicKey, [
          { chain: new BN(ARBITRUM), limits: null },
        ]),
      ],
    ]) {
      fetchRouteSets.mockResolvedValue(routeSets(live));
      expect((await sendOneUsdt()).minAmountLd).toBe("995000");
    }

    // An explicit quote the live route admits is sent as given.
    fetchRouteSets.mockResolvedValue(routeSets([onArbitrum]));
    expect((await sendOneUsdt(new BN(999_500))).minAmountLd).toBe("999500");
    expect(fetchRouteSets).toHaveBeenCalledTimes(1);

    // One under its cost bound is refused before the send is built.
    await expect(sendOneUsdt(new BN(990_000))).rejects.toThrow(
      "minAmountLd 990000 is under 999000, the lowest quote a cost bound of 10 bps admits for 1000000 sent",
    );

    // With no live route on the send's chain an explicit quote is sent as given.
    fetchRouteSets.mockResolvedValue(routeSets(null));
    expect((await sendOneUsdt(new BN(990_000))).minAmountLd).toBe("990000");
  });

  // What a caller shows before a send is what the send carries.
  it("resolves the quote a send carries, from the same routes", async () => {
    const recipient = Keypair.generate().publicKey;
    const fetchRouteSets = jest.fn();
    const glamClient = offlineMainnetClient(fetchRouteSets);
    const params = (minAmountLd?: BN) => ({
      sourceMint: USDT,
      sourceAmount: new BN(1_000_000),
      destinationChain: ARBITRUM,
      destinationRecipient: recipient,
      nativeFeeLamports: new BN(1),
      minAmountLd,
    });
    const both = async (minAmountLd?: BN) => {
      fetchRouteSets.mockClear();
      const resolved = await glamClient.bridge.oft.resolveMinAmountLd(
        params(minAmountLd),
      );
      const reads = fetchRouteSets.mock.calls.length;
      const { sendInstruction } = await glamClient.bridge.oft.buildSendTx(
        params(minAmountLd),
      );
      return {
        resolved: resolved.toString(),
        sent: sendAmounts(sendInstruction.data).minAmountLd,
        reads,
      };
    };

    for (const [live, expected] of [
      [
        [oftRoute(recipient, [{ chain: new BN(ARBITRUM), limits: null }])],
        "999000",
      ],
      [
        [
          oftRoute(recipient, [
            { chain: new BN(ARBITRUM), limits: routeLimits(5) },
          ]),
        ],
        "999500",
      ],
      [null, "995000"],
    ] as const) {
      fetchRouteSets.mockResolvedValue(
        routeSets(live as unknown as BridgeRoute[] | null),
      );
      expect(await both()).toEqual({
        resolved: expected,
        sent: expected,
        reads: 1,
      });
    }

    // A quote given is checked against the same routes and taken as it is.
    fetchRouteSets.mockResolvedValue(
      routeSets([
        oftRoute(recipient, [{ chain: new BN(ARBITRUM), limits: null }]),
      ]),
    );
    expect(await both(new BN(999_500))).toEqual({
      resolved: "999500",
      sent: "999500",
      reads: 1,
    });
  });

  // The program refuses an amount outside the range (AmountTooSmall,
  // AmountTooLarge) after the confirmation named it.
  it("refuses an amount outside the live route's range on the send's chain, before the quote", async () => {
    const recipient = Keypair.generate().publicKey;
    const fetchRouteSets = jest.fn(async () =>
      routeSets([
        oftRoute(recipient, [
          {
            chain: new BN(ARBITRUM),
            limits: {
              minAmount: new BN(1_000_000),
              maxAmount: new BN(5_000_000),
              maxCostBps: CLI_DEFAULT_MAX_COST_BPS,
            },
          },
        ]),
      ]),
    );
    const glamClient = offlineMainnetClient(fetchRouteSets);
    const params = (sourceAmount: number, minAmountLd?: BN) => ({
      sourceMint: USDT,
      sourceAmount: new BN(sourceAmount),
      destinationChain: ARBITRUM,
      destinationRecipient: recipient,
      nativeFeeLamports: new BN(1),
      minAmountLd,
    });

    for (const [amount, message] of [
      [
        999_999,
        "The amount sent, 999999, is under 1000000, the least the live route sends on chain 30110: the program refuses a smaller transfer",
      ],
      [
        5_000_001,
        "The amount sent, 5000001, is over 5000000, the most the live route sends on chain 30110: the program refuses a larger transfer",
      ],
    ] as const) {
      for (const minAmountLd of [undefined, new BN(amount)]) {
        await expect(
          glamClient.bridge.oft.resolveMinAmountLd(params(amount, minAmountLd)),
        ).rejects.toThrow(message);
        await expect(
          glamClient.bridge.oft.buildSendTx(params(amount, minAmountLd)),
        ).rejects.toThrow(message);
      }
    }

    // Both ends of the range are sent.
    for (const [amount, quote] of [
      [1_000_000, "999000"],
      [5_000_000, "4995000"],
    ] as const) {
      const { sendInstruction } = await glamClient.bridge.oft.buildSendTx(
        params(amount),
      );
      expect(sendAmounts(sendInstruction.data).minAmountLd).toBe(quote);
    }
  });

  it("refuses a send and its quote when minAmountLd is above the amount, before it reads the routes", async () => {
    const fetchRouteSets = jest.fn();
    const glamClient = offlineMainnetClient(fetchRouteSets);
    const params = {
      sourceMint: USDT,
      sourceAmount: new BN(1_000_000),
      destinationChain: ARBITRUM,
      destinationRecipient: Keypair.generate().publicKey,
      nativeFeeLamports: new BN(1),
      minAmountLd: new BN(1_000_001),
    };
    const message =
      "minAmountLd 1000001 is above the amount sent, 1000000: the program refuses a quote above the amount";
    await expect(
      glamClient.bridge.oft.resolveMinAmountLd(params),
    ).rejects.toThrow(message);
    await expect(glamClient.bridge.oft.buildSendTx(params)).rejects.toThrow(
      message,
    );
    expect(fetchRouteSets).not.toHaveBeenCalled();
  });

  // A BN keeps its sign, and the u64 encoding writes only the magnitude, so -1
  // would go out as 1.
  it("refuses a negative minAmountLd or amount before it reads the routes, and a negative fee before it encodes", async () => {
    // No live route: the quote given is the quote sent.
    const fetchRouteSets = jest.fn(async () => routeSets(null));
    const glamClient = offlineMainnetClient(fetchRouteSets);
    const params = {
      sourceMint: USDT,
      sourceAmount: new BN(1_000_000),
      destinationChain: ARBITRUM,
      destinationRecipient: Keypair.generate().publicKey,
      nativeFeeLamports: new BN(1),
      minAmountLd: new BN(900_000),
    };
    const refused = async (
      changed: Partial<typeof params>,
      message: string,
      quoted = true,
    ) => {
      if (quoted)
        await expect(
          glamClient.bridge.oft.resolveMinAmountLd({ ...params, ...changed }),
        ).rejects.toThrow(message);
      await expect(
        glamClient.bridge.oft.buildSendTx({ ...params, ...changed }),
      ).rejects.toThrow(message);
    };
    await refused(
      { minAmountLd: new BN(-1) },
      "minAmountLd -1 is negative: an OFT send quotes no negative amount",
    );
    await refused(
      { sourceAmount: new BN(-1) },
      "The amount sent, -1, is negative: an OFT send moves no negative amount",
    );
    expect(fetchRouteSets).not.toHaveBeenCalled();
    await refused(
      { nativeFeeLamports: new BN(-1) },
      "-1 is negative, and a u64 field holds no negative value",
      false,
    );
    // The resolver alone takes the same refusals.
    expect(() =>
      resolveLayerzeroOftMinAmountLd({
        sourceAmount: new BN(1_000_000),
        minAmountLd: new BN(-1),
        routeProfile: profile,
      }),
    ).toThrow(
      "minAmountLd -1 is negative: an OFT send quotes no negative amount",
    );
  });
});
