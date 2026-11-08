import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

import { MintModel } from "../../../src/models/mint";
import {
  CreatedModel,
  StateAccount,
  StateAccountType,
  StateModel,
} from "../../../src/models/state";

/**
 * Runs under native ES2022 class fields (the `anchor-es2022` project is
 * defined in jest.es2022.config.ts). The real models are built without a network.
 */
describe("StateModel under native class fields", () => {
  const key = () => Keypair.generate().publicKey;
  const inherited = [
    "accountType",
    "name",
    "enabled",
    "assets",
    "created",
    "owner",
    "portfolioManagerName",
    "timelockDuration",
    "integrationAcls",
    "delegateAcls",
  ] as const;

  function fullInput() {
    return {
      accountType: StateAccountType.TOKENIZED_VAULT,
      name: [71, 76, 65, 77],
      uri: "https://example.com/state",
      enabled: true,
      oracleConfigs: { padding: [1, 2, 3] } as any,
      assets: [key(), key()],
      created: new CreatedModel({
        key: [1, 2, 3],
        createdBy: key(),
        createdAt: new BN(1234),
      }),
      owner: key(),
      portfolioManagerName: [80, 77],
      borrowable: [key()],
      timelockDuration: 86400,
      integrationAcls: [{ integrationProgram: key() } as any],
      delegateAcls: [{ pubkey: key() } as any],
      id: key(),
      vault: key(),
      mint: key(),
      baseAssetMint: key(),
      baseAssetTokenProgram: 1,
      baseAssetDecimals: 6,
      externalPositions: [key()],
      pricedProtocols: [{ protocol: 1 }],
    };
  }

  it("proves the environment resets a redeclared field", () => {
    class Base {
      value: number | null;
      constructor(v: number) {
        this.value = v;
      }
    }
    class Narrowed extends Base {
      value!: number;
    }
    class Declared extends Base {
      declare value: number;
    }
    expect(new Narrowed(7).value).toBeUndefined();
    expect(new Declared(7).value).toBe(7);
  });

  it("keeps every field that is passed to the constructor", () => {
    const input = fullInput();
    const model = new StateModel(input);
    for (const field of Object.keys(input) as (keyof typeof input)[]) {
      if (field === "mint") {
        continue;
      }
      expect({ field, value: (model as any)[field] }).toEqual({
        field,
        value: input[field],
      });
    }
    expect({ field: "mint", value: model.mint }).toEqual({
      field: "mint",
      value: input.mint,
    });
  });

  it("compares the account type of a vault model", () => {
    const model = new StateModel({ accountType: StateAccountType.VAULT });
    expect(
      StateAccountType.equals(model.accountType, StateAccountType.VAULT),
    ).toBe(true);
    expect(
      StateAccountType.equals(
        model.accountType,
        StateAccountType.TOKENIZED_VAULT,
      ),
    ).toBe(false);
  });

  it("holds parent defaults and own properties for an empty input", () => {
    const model = new StateModel({});
    for (const field of inherited) {
      expect({
        field,
        own: Object.prototype.hasOwnProperty.call(model, field),
      }).toEqual({
        field,
        own: true,
      });
    }
    expect(model.accountType).toBeNull();
    expect(model.name).toBeNull();
    expect(model.enabled).toBeNull();
    expect(model.assets).toBeNull();
    expect(model.created).toBeNull();
    expect(model.owner).toBeNull();
    expect(model.portfolioManagerName).toBeNull();
    expect(model.timelockDuration).toBeNull();
    expect(model.integrationAcls).toEqual([]);
    expect(model.delegateAcls).toEqual([]);
  });

  it("builds a model from onchain accounts", () => {
    const statePda = key();
    const owner = key();
    const asset = key();
    const created = new CreatedModel({
      key: [9, 9],
      createdBy: key(),
      createdAt: new BN(55),
    });
    const param = (name: string, val: unknown) => ({
      name: { [name]: {} },
      value: { [name]: { val } },
    });
    const account = {
      accountType: StateAccountType.SINGLE_ASSET_VAULT,
      owner,
      created,
      baseAssetMint: key(),
      baseAssetTokenProgram: 0,
      baseAssetDecimals: 9,
      integrationAcls: [],
      delegateAcls: [],
      params: [
        [
          param("name", [65, 66]),
          param("enabled", true),
          param("assets", [asset]),
          param("portfolioManagerName", [67, 68]),
          param("timelockDuration", 3600),
        ],
        [],
        [],
        [],
      ],
    } as unknown as StateAccount;

    const model = StateModel.fromOnchainAccounts(statePda, account, false);

    expect(model.id).toEqual(statePda);
    expect(model.accountType).toEqual(account.accountType);
    expect(model.name).toEqual([65, 66]);
    expect(model.enabled).toBe(true);
    expect(model.assets).toEqual([asset]);
    expect(model.created).toEqual(created);
    expect(model.owner).toEqual(owner);
    expect(model.portfolioManagerName).toEqual([67, 68]);
    expect(model.timelockDuration).toBe(3600);
  });
});

describe("MintModel under native class fields", () => {
  it("keeps the fields its parent constructor assigns", () => {
    const delegate = Keypair.generate().publicKey;
    const feeStructure = { vault: { entry: 1, exit: 2 } } as any;
    const notifyAndSettle = { permissionlessFulfillment: true } as any;
    const model = new MintModel({
      symbol: "GLAM",
      name: [1, 2],
      uri: "https://example.com/mint",
      yearInSeconds: 31536000,
      permanentDelegate: delegate,
      defaultAccountStateFrozen: true,
      lockupPeriod: 30,
      maxCap: new BN(100),
      minSubscription: new BN(5),
      minRedemption: new BN(6),
      allowlist: [delegate],
      blocklist: [PublicKey.default],
      feeStructure,
      notifyAndSettle,
    });
    expect(model.symbol).toBe("GLAM");
    expect(model.name).toEqual([1, 2]);
    expect(model.uri).toBe("https://example.com/mint");
    expect(model.yearInSeconds).toBe(31536000);
    expect(model.permanentDelegate).toEqual(delegate);
    expect(model.defaultAccountStateFrozen).toBe(true);
    expect(model.lockupPeriod).toBe(30);
    expect(model.maxCap?.toNumber()).toBe(100);
    expect(model.minSubscription?.toNumber()).toBe(5);
    expect(model.minRedemption?.toNumber()).toBe(6);
    expect(model.allowlist).toEqual([delegate]);
    expect(model.blocklist).toEqual([PublicKey.default]);
    expect(model.feeStructure).toBe(feeStructure);
    expect(model.notifyAndSettle).toBe(notifyAndSettle);
  });
});
