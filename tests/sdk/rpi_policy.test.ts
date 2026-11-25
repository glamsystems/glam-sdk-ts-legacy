import { PublicKey } from "@solana/web3.js";

import { RpiPolicy } from "../../src/deser/integrationPolicies";

// Borsh writes a u32 and a vec length as four little-endian bytes, a bool and
// a unit enum as one byte, and a [u8; 32] or a Pubkey as its 32 bytes.
const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const keys = (list: PublicKey[]) =>
  Buffer.concat([u32(list.length), ...list.map((key) => key.toBuffer())]);

describe("RpiPolicy", () => {
  const mint = PublicKey.unique();
  const custody = PublicKey.unique();
  const submitter = PublicKey.unique();
  const configurers = [PublicKey.unique(), PublicKey.unique()];
  const id = Buffer.alloc(32, 7);

  // ext_rpi's RpiPolicy and PositionConfig, field by field in their order.
  const encoded = Buffer.concat([
    u32(3600),
    u32(2),
    id,
    Buffer.from([1, 2, 1]), // tokenized, wormhole, denominated in a mint
    mint.toBuffer(),
    custody.toBuffer(),
    Buffer.from([1, 1]), // native SOL custody, enabled
    u32(600),
    keys([submitter]),
    keys([]),
    keys(configurers),
    Buffer.alloc(32, 9),
    Buffer.from([0, 0, 0]), // valued, trusted, USD
    PublicKey.default.toBuffer(),
    PublicKey.default.toBuffer(),
    Buffer.from([0, 0]), // SPL token custody, disabled
    u32(0),
    keys([]),
    keys([]),
    keys([]),
  ]);

  it("decodes each position's configuration as ext_rpi stores it", () => {
    const policy = RpiPolicy.decode(encoded);

    expect(policy.defaultFreshnessSecs).toBe(3600);
    expect(policy.positions).toHaveLength(2);
    expect(policy.position(id)).toEqual({
      positionId: Array.from(id),
      positionType: { tokenized: {} },
      sourceType: { wormhole: {} },
      denomination: { denom: { mint: {} }, mint },
      nativeCustodyAccount: custody,
      nativeCustodyKind: { nativeSol: {} },
      enabled: true,
      freshnessOverrideSecs: 600,
      submitAllowlist: [submitter],
      validateAllowlist: [],
      configureAllowlist: configurers,
    });
    expect(policy.position(Buffer.alloc(32, 9))).toMatchObject({
      positionType: { valued: {} },
      sourceType: { trusted: {} },
      denomination: { denom: { usd: {} }, mint: PublicKey.default },
      nativeCustodyKind: { splToken: {} },
      enabled: false,
      freshnessOverrideSecs: 0,
    });
    expect(policy.position(Buffer.alloc(32, 1))).toBeUndefined();
  });

  it("refuses an enum byte ext_rpi has no variant for", () => {
    const corrupt = Buffer.from(encoded);
    corrupt[4 + 4 + 32 + 1] = 3; // a fourth source type
    expect(() => RpiPolicy.decode(corrupt)).toThrow(
      "Invalid RPI source type 3",
    );
  });
});
