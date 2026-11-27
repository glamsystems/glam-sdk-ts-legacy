import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import {
  KaminoVaultsPolicy,
  MintPolicy,
  TransferPolicy,
} from "../../src/deser/integrationPolicies";
import {
  getExtKaminoProgramId,
  getExtSplProgramId,
  getGlamMintProgramId,
} from "../../src/glamExports";
import { IntegrationAcl } from "../../src/models";
import {
  GLAM_MINT_PROTOCOL,
  KAMINO_LENDING_PROTOCOL,
  KAMINO_VAULTS_PROTOCOL,
  SPL_TOKEN_PROTOCOL,
} from "../../src/protocols";
import { compareIntegrationAcls } from "../../src/utils/timelock";

const MINT_PROGRAM = getGlamMintProgramId(false);
const SPL_PROGRAM = getExtSplProgramId(false);
const KAMINO_PROGRAM = getExtKaminoProgramId(false);

const mintPolicy = (minSubscription: number) =>
  new MintPolicy(
    0,
    new BN(0),
    new BN(minSubscription),
    new BN(0),
    0,
    [0, 0, 0, 0, 0, 0, 0],
    null,
    null,
  ).encode();

const acl = (
  integrationProgram: PublicKey,
  protocolsBitmask: number,
  policies: [number, Buffer][] = [],
) =>
  new IntegrationAcl({
    integrationProgram,
    protocolsBitmask,
    protocolPolicies: policies.map(([protocolBitflag, data]) => ({
      protocolBitflag,
      data,
    })),
  });

describe("compareIntegrationAcls policy changes", () => {
  // glam_mint stages a minimum subscription as its protocol policy: the
  // staged list enables the same protocols and stores other policy bytes.
  it("reports a staged policy that differs under the same protocols", () => {
    const live = mintPolicy(0);
    const staged = mintPolicy(5_000_000);

    const diff = compareIntegrationAcls(
      [acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, live]])],
      [acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, staged]])],
      false,
    );

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.policyChanges).toHaveLength(1);
    const [change] = diff.policyChanges;
    expect(change.integrationProgram.equals(MINT_PROGRAM)).toBe(true);
    expect(change.protocolBitflag).toBe(GLAM_MINT_PROTOCOL);
    expect(change.protocolName).toBe("GlamMint");
    expect(change.current?.equals(live)).toBe(true);
    expect(change.staged?.equals(staged)).toBe(true);
    expect(
      MintPolicy.decode(change.staged!).minSubscription.toString(),
    ).toEqual("5000000");
  });

  it("reports nothing for a staged list that stores the same policies", () => {
    const policy = mintPolicy(7);
    const diff = compareIntegrationAcls(
      [acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, policy]])],
      [
        acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
          [GLAM_MINT_PROTOCOL, Buffer.from(policy)],
        ]),
      ],
      false,
    );

    expect(diff.policyChanges).toEqual([]);
  });

  it("reports a policy the staged list adds and one it drops", () => {
    const transfers = new TransferPolicy([PublicKey.unique()]).encode();
    const vaults = new KaminoVaultsPolicy([PublicKey.unique()]).encode();
    const kaminoProtocols = KAMINO_LENDING_PROTOCOL | KAMINO_VAULTS_PROTOCOL;

    const diff = compareIntegrationAcls(
      [
        acl(SPL_PROGRAM, SPL_TOKEN_PROTOCOL),
        acl(KAMINO_PROGRAM, kaminoProtocols, [
          [KAMINO_VAULTS_PROTOCOL, vaults],
        ]),
      ],
      [
        acl(SPL_PROGRAM, SPL_TOKEN_PROTOCOL, [[SPL_TOKEN_PROTOCOL, transfers]]),
        acl(KAMINO_PROGRAM, kaminoProtocols),
      ],
      false,
    );

    expect(diff.modified).toEqual([]);
    expect(
      diff.policyChanges.map((change) => [
        change.protocolName,
        change.current?.toString("hex") ?? null,
        change.staged?.toString("hex") ?? null,
      ]),
    ).toEqual([
      ["SplToken", null, transfers.toString("hex")],
      ["KaminoVaults", vaults.toString("hex"), null],
    ]);
  });

  it("reports the policies of an integration the staged list adds or removes", () => {
    const unlisted = PublicKey.unique();
    const policy = mintPolicy(1);
    const bytes = Buffer.from([1, 2, 3]);

    const diff = compareIntegrationAcls(
      [acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, policy]])],
      [acl(unlisted, 0b100, [[0b100, bytes]])],
      false,
    );

    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(1);
    expect(
      diff.policyChanges.map((change) => [
        change.integrationProgram.toBase58(),
        change.protocolBitflag,
        change.protocolName,
        change.current !== null,
        change.staged !== null,
      ]),
    ).toEqual([
      [MINT_PROGRAM.toBase58(), GLAM_MINT_PROTOCOL, "GlamMint", true, false],
      // A program the SDK does not list has no protocol names.
      [unlisted.toBase58(), 0b100, "Unknown", false, true],
    ]);
  });

  it("keeps reporting protocol changes as before, beside a policy change", () => {
    const kaminoProtocols = KAMINO_LENDING_PROTOCOL | KAMINO_VAULTS_PROTOCOL;
    const vaults = new KaminoVaultsPolicy([PublicKey.unique()]).encode();

    const diff = compareIntegrationAcls(
      [acl(KAMINO_PROGRAM, KAMINO_LENDING_PROTOCOL)],
      [
        acl(KAMINO_PROGRAM, kaminoProtocols, [
          [KAMINO_VAULTS_PROTOCOL, vaults],
        ]),
      ],
      false,
    );

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0].enabledProtocols).toEqual(["KaminoVaults"]);
    expect(diff.modified[0].disabledProtocols).toEqual([]);
    expect(diff.policyChanges.map((change) => change.protocolName)).toEqual([
      "KaminoVaults",
    ]);
  });

  // glam_protocol's `initialize_state` stores the integration list it is
  // given, so a list can hold a program, or a protocol's policy, more than
  // once. The comparison follows the program's own lookups there.
  describe("for a list that holds an entry more than once", () => {
    const first = mintPolicy(1);
    const second = mintPolicy(2);
    const replaced = mintPolicy(3);
    const shown = (diff: ReturnType<typeof compareIntegrationAcls>) =>
      diff.policyChanges.map((change) => [
        change.protocolName,
        change.protocolBitflag,
        change.current?.toString("hex") ?? null,
        change.staged?.toString("hex") ?? null,
      ]);

    // `get_protocol_policy` reads the first policy for a bit, and
    // `set_protocol_policy` replaces the first.
    it("compares the first policy stored for a protocol bit", () => {
      const diff = compareIntegrationAcls(
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, first],
            [GLAM_MINT_PROTOCOL, second],
          ]),
        ],
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, replaced],
            [GLAM_MINT_PROTOCOL, second],
          ]),
        ],
        false,
      );

      expect(shown(diff)).toEqual([
        [
          "GlamMint",
          GLAM_MINT_PROTOCOL,
          first.toString("hex"),
          replaced.toString("hex"),
        ],
      ]);
      expect(diff.identical).toBe(false);
    });

    it("reports no policy change when only a policy behind the first differs", () => {
      const diff = compareIntegrationAcls(
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, first],
            [GLAM_MINT_PROTOCOL, second],
          ]),
        ],
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, first],
            [GLAM_MINT_PROTOCOL, replaced],
          ]),
        ],
        false,
      );

      expect(shown(diff)).toEqual([]);
      expect(diff.modified).toEqual([]);
      expect(diff.identical).toBe(false);
    });

    // The lookup tests `bitflag & bit`, so a policy stored under two bits is
    // read for both, ahead of a later policy stored under one of them.
    it("reads a policy stored under several bits for each of them", () => {
      const both = KAMINO_LENDING_PROTOCOL | KAMINO_VAULTS_PROTOCOL;
      const shared = Buffer.from([1]);
      const behind = Buffer.from([2]);
      const lending = Buffer.from([3]);

      const diff = compareIntegrationAcls(
        [
          acl(KAMINO_PROGRAM, both, [
            [both, shared],
            [KAMINO_VAULTS_PROTOCOL, behind],
          ]),
        ],
        [
          acl(KAMINO_PROGRAM, both, [
            [KAMINO_LENDING_PROTOCOL, lending],
            [both, shared],
            [KAMINO_VAULTS_PROTOCOL, Buffer.from([4])],
          ]),
        ],
        false,
      );

      // The vaults policy read is the shared one on both lists.
      expect(shown(diff)).toEqual([
        ["KaminoLend", KAMINO_LENDING_PROTOCOL, "01", "03"],
      ]);
    });

    it("compares the policies of a program's first entry", () => {
      const diff = compareIntegrationAcls(
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, first]]),
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, second]]),
        ],
        [
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, replaced],
          ]),
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [[GLAM_MINT_PROTOCOL, second]]),
        ],
        false,
      );

      expect(shown(diff)).toEqual([
        [
          "GlamMint",
          GLAM_MINT_PROTOCOL,
          first.toString("hex"),
          replaced.toString("hex"),
        ],
      ]);
    });

    // `check_integration` accepts a protocol that any entry for the program
    // enables, and `enable_protocols` edits the first entry.
    it("counts the protocols every entry for a program enables", () => {
      const diff = compareIntegrationAcls(
        [acl(KAMINO_PROGRAM, KAMINO_LENDING_PROTOCOL), acl(KAMINO_PROGRAM, 0)],
        [
          acl(KAMINO_PROGRAM, KAMINO_LENDING_PROTOCOL | KAMINO_VAULTS_PROTOCOL),
          acl(KAMINO_PROGRAM, 0),
        ],
        false,
      );

      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(
        diff.modified.map((entry) => [
          entry.currentBitmask,
          entry.stagedBitmask,
          entry.enabledProtocols,
          entry.disabledProtocols,
        ]),
      ).toEqual([
        [
          KAMINO_LENDING_PROTOCOL,
          KAMINO_LENDING_PROTOCOL | KAMINO_VAULTS_PROTOCOL,
          ["KaminoVaults"],
          [],
        ],
      ]);
    });

    it("reports no protocol change when a later entry enables what the first did", () => {
      const diff = compareIntegrationAcls(
        [
          acl(KAMINO_PROGRAM, KAMINO_LENDING_PROTOCOL),
          acl(KAMINO_PROGRAM, KAMINO_VAULTS_PROTOCOL),
        ],
        [
          acl(KAMINO_PROGRAM, KAMINO_VAULTS_PROTOCOL),
          acl(KAMINO_PROGRAM, KAMINO_LENDING_PROTOCOL),
        ],
        false,
      );

      expect(diff.modified).toEqual([]);
      expect(diff.policyChanges).toEqual([]);
      expect(diff.identical).toBe(false);
    });
  });

  describe("identical", () => {
    const policy = mintPolicy(7);
    const list = () => [
      acl(SPL_PROGRAM, SPL_TOKEN_PROTOCOL),
      acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
        [GLAM_MINT_PROTOCOL, Buffer.from(policy)],
      ]),
    ];

    it("is true for two lists that store the same entries in the same order", () => {
      expect(compareIntegrationAcls(list(), list(), false).identical).toBe(
        true,
      );
      expect(compareIntegrationAcls(null, [], false).identical).toBe(true);
    });

    it.each([
      ["another order", () => list().reverse()],
      ["another protocol", () => [acl(SPL_PROGRAM, 0b10), list()[1]]],
      [
        "another policy",
        () => [
          list()[0],
          acl(MINT_PROGRAM, GLAM_MINT_PROTOCOL, [
            [GLAM_MINT_PROTOCOL, mintPolicy(8)],
          ]),
        ],
      ],
      ["one entry fewer", () => [list()[0]]],
    ])("is false for a staged list with %s", (_case, staged) => {
      expect(compareIntegrationAcls(list(), staged(), false).identical).toBe(
        false,
      );
    });
  });
});
