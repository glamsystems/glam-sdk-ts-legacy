import {
  getExtBridgeProgramId,
  getExtCctpProgramId,
  getExtJupiterProgramId,
  getExtKaminoProgramId,
  getExtLoopscaleProgramId,
  getExtPhoenixProgramId,
  getExtOrcaProgramId,
  getExtNeutralProgramId,
  getGlamMintProgramId,
  getGlamProtocolProgramId,
} from "../../src/glamExports";
import {
  getProgramAndBitflagByProtocolName,
  getProtocolsAndPermissions,
} from "../../src/constants";
import {
  GLAM_MINT_PROTOCOL,
  CCTP_PROTOCOL,
  JUPITER_BORROW_PROTOCOL,
  JUPITER_EARN_PROTOCOL,
  JUPITER_SWAP_PROTOCOL,
  KAMINO_LENDING_PROTOCOL,
  LAYERZERO_OFT_PROTOCOL,
  LOOPSCALE_BORROW_PROTOCOL,
  LOOPSCALE_LENDING_PROTOCOL,
  LOOPSCALE_VAULT_PROTOCOL,
  ORCA_WHIRLPOOLS_PROTOCOL,
  PHOENIX_PROTOCOL,
  SYSTEM_PROTOCOL,
} from "../../src/protocols";
import { parsePermissionNames } from "../../src/utils/bitmask";

const protocolBitflagKey = (bitflag: number) =>
  bitflag.toString(2).padStart(16, "0");

const getPermissionNames = (
  staging: boolean,
  programId: string,
  protocolBitflag: string,
) =>
  Object.values(
    getProtocolsAndPermissions(staging)[programId][protocolBitflag].permissions,
  );

describe("getProtocolsAndPermissions", () => {
  it.each([false, true])(
    "matches Rust ACL constants for staging=%s",
    (staging) => {
      const glamProtocolProgramId =
        getGlamProtocolProgramId(staging).toBase58();
      expect(
        getPermissionNames(
          staging,
          glamProtocolProgramId,
          protocolBitflagKey(SYSTEM_PROTOCOL),
        ),
      ).toEqual(["WSOL", "Transfer", "EmergencyUpdate", "CancelTimelock"]);
      expect(
        getPermissionNames(
          staging,
          glamProtocolProgramId,
          protocolBitflagKey(JUPITER_SWAP_PROTOCOL),
        ),
      ).toEqual([
        "SwapToAny",
        "SwapLST",
        "SwapAllowlisted",
        "SwapFromAny",
        "SkipQuotePriceCheckLimited",
        "SkipQuotePriceCheck",
      ]);

      expect(
        getPermissionNames(
          staging,
          getGlamMintProgramId(staging).toBase58(),
          protocolBitflagKey(GLAM_MINT_PROTOCOL),
        ),
      ).toEqual([
        "MintTokens",
        "BurnTokens",
        "ForceTransfer",
        "SetTokenAccountState",
        "ClaimFees",
        "Fulfill",
        "EmergencyUpdate",
        "CancelRequest",
        "ClaimRequest",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtKaminoProgramId(staging).toBase58(),
          protocolBitflagKey(KAMINO_LENDING_PROTOCOL),
        ),
      ).toEqual([
        "Init",
        "Deposit",
        "Withdraw",
        "Borrow",
        "Repay",
        "Liquidate",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtLoopscaleProgramId(staging).toBase58(),
          protocolBitflagKey(LOOPSCALE_BORROW_PROTOCOL),
        ),
      ).toEqual([
        "CreateLoan",
        "CloseLoan",
        "UpdateLoan",
        "DepositCollateral",
        "WithdrawCollateral",
        "BorrowPrincipal",
        "RepayPrincipal",
        "SetPolicy",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtLoopscaleProgramId(staging).toBase58(),
          protocolBitflagKey(LOOPSCALE_LENDING_PROTOCOL),
        ),
      ).toEqual([
        "CreateStrategy",
        "UpdateStrategy",
        "DepositStrategy",
        "WithdrawStrategy",
        "CloseStrategy",
        "SellLedger",
        "SetPolicy",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtLoopscaleProgramId(staging).toBase58(),
          protocolBitflagKey(LOOPSCALE_VAULT_PROTOCOL),
        ),
      ).toEqual([
        "DepositUserVault",
        "WithdrawUserVault",
        "StakeUserVaultLp",
        "UnstakeUserVaultLp",
        "ClaimVaultRewards",
        "SetPolicy",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtPhoenixProgramId(staging).toBase58(),
          protocolBitflagKey(PHOENIX_PROTOCOL),
        ),
      ).toEqual([
        "InitTrader",
        "Deposit",
        "Withdraw",
        "CreateModifyOrders",
        "CancelOrders",
        "TransferCollateral",
        "UpdateTraderState",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtJupiterProgramId(staging).toBase58(),
          protocolBitflagKey(JUPITER_EARN_PROTOCOL),
        ),
      ).toEqual(["Deposit", "Withdraw"]);

      expect(
        getPermissionNames(
          staging,
          getExtJupiterProgramId(staging).toBase58(),
          protocolBitflagKey(JUPITER_BORROW_PROTOCOL),
        ),
      ).toEqual([
        "InitPosition",
        "DepositCollateral",
        "WithdrawCollateral",
        "Borrow",
        "Repay",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtOrcaProgramId(staging).toBase58(),
          protocolBitflagKey(ORCA_WHIRLPOOLS_PROTOCOL),
        ),
      ).toEqual([
        "OpenPosition",
        "IncreaseLiquidity",
        "DecreaseLiquidity",
        "UpdateFeesAndRewards",
        "CollectFees",
        "CollectReward",
        "ClosePosition",
        "IncreaseLiquidityByTokenAmounts",
        "RepositionLiquidity",
        "InitializeTickArray",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtCctpProgramId(staging).toBase58(),
          protocolBitflagKey(CCTP_PROTOCOL),
        ),
      ).toEqual(["Transfer"]);

      expect(
        getPermissionNames(
          staging,
          getExtNeutralProgramId(staging).toBase58(),
          "0000000000000001",
        ),
      ).toEqual([
        "InitializeBundleDepositor",
        "RequestDeposit",
        "RequestWithdrawal",
        "CloseUserBundleAccount",
      ]);

      expect(
        getPermissionNames(
          staging,
          getExtBridgeProgramId(staging).toBase58(),
          protocolBitflagKey(LAYERZERO_OFT_PROTOCOL),
        ),
      ).toEqual(["Send", "Validate", "Settle", "Pause"]);
      expect(
        getPermissionNames(
          staging,
          getExtBridgeProgramId(staging).toBase58(),
          protocolBitflagKey(CCTP_PROTOCOL),
        ),
      ).toEqual(["Send", "Validate", "Settle", "Pause"]);
    },
  );
});

describe("getProgramAndBitflagByProtocolName", () => {
  it.each([false, true])(
    "resolves every protocol name to one protocol that carries it for staging=%s",
    (staging) => {
      const carriers: Record<string, [string, string][]> = {};
      Object.entries(getProtocolsAndPermissions(staging)).forEach(
        ([programId, protocols]) => {
          Object.entries(protocols).forEach(([bitflag, { name }]) => {
            (carriers[name] ??= []).push([programId, bitflag]);
          });
        },
      );
      const lookup = getProgramAndBitflagByProtocolName(staging);

      expect(Object.keys(lookup).sort()).toEqual(Object.keys(carriers).sort());
      Object.entries(lookup).forEach(([name, resolved]) => {
        expect(carriers[name]).toContainEqual(resolved);
      });
      // A name two programs share needs a rule that says which one it means:
      // without one the lookup keeps whichever the table lists last.
      expect(
        Object.keys(carriers).filter((name) => carriers[name].length > 1),
      ).toEqual(["CCTP"]);
    },
  );

  // Production runs ext_cctp and has no ext_bridge.
  it("resolves CCTP to ext_cctp's protocol on a production vault", () => {
    expect(getProgramAndBitflagByProtocolName(false).CCTP).toEqual([
      getExtCctpProgramId(false).toBase58(),
      protocolBitflagKey(CCTP_PROTOCOL),
    ]);
  });

  it("resolves CCTP to ext_bridge's protocol on a staging vault", () => {
    expect(getProgramAndBitflagByProtocolName(true).CCTP).toEqual([
      getExtBridgeProgramId(true).toBase58(),
      protocolBitflagKey(CCTP_PROTOCOL),
    ]);
  });
});

describe("parsePermissionNames for the name CCTP", () => {
  it("reads ext_cctp's permission on a production vault", () => {
    const parsed = parsePermissionNames({
      protocolName: "CCTP",
      permissionNames: ["Transfer"],
      staging: false,
    });

    expect(parsed.integrationProgram.equals(getExtCctpProgramId(false))).toBe(
      true,
    );
    expect(parsed.protocolBitflag).toBe(CCTP_PROTOCOL);
    expect(parsed.permissionsBitmask.toNumber()).toBe(1 << 0);
    expect(() =>
      parsePermissionNames({
        protocolName: "CCTP",
        permissionNames: ["Send"],
        staging: false,
      }),
    ).toThrow("Unknown permission name Send for protocol name CCTP");
  });

  it("reads ext_bridge's permissions on a staging vault", () => {
    const parsed = parsePermissionNames({
      protocolName: "CCTP",
      permissionNames: ["Send", "Pause"],
      staging: true,
    });

    expect(parsed.integrationProgram.equals(getExtBridgeProgramId(true))).toBe(
      true,
    );
    expect(parsed.protocolBitflag).toBe(CCTP_PROTOCOL);
    expect(parsed.permissionsBitmask.toNumber()).toBe((1 << 0) | (1 << 3));
    expect(() =>
      parsePermissionNames({
        protocolName: "CCTP",
        permissionNames: ["Transfer"],
        staging: true,
      }),
    ).toThrow("Unknown permission name Transfer for protocol name CCTP");
  });
});
