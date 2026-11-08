import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { BaseClient } from "../../src/client/base";
import {
  JupiterBorrowClient,
  JupiterEarnClient,
} from "../../src/client/jupiter-lend";
import { VaultClient } from "../../src/client/vault";
import { ClusterNetwork } from "../../src/clientConfig";
import {
  JUPITER_LENDING_PROGRAM_ID,
  JUPITER_LIQUIDITY_PROGRAM_ID,
  JUPITER_ORACLE_PROGRAM_ID,
  JUPITER_VAULTS_PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
} from "../../src/constants";
import {
  ORACLE_DISCRIMINATOR,
  POSITION_DISCRIMINATOR,
  POSITION_MINT_OFFSET,
  POSITION_TICK_ID_OFFSET,
  POSITION_VAULT_ID_OFFSET,
  TOKEN_RESERVE_DISCRIMINATOR,
  TOKEN_RESERVE_VAULT_OFFSET,
  VAULT_CONFIG_BORROW_TOKEN_OFFSET,
  VAULT_CONFIG_DISCRIMINATOR,
  VAULT_CONFIG_ORACLE_OFFSET,
  VAULT_CONFIG_SUPPLY_TOKEN_OFFSET,
  VAULT_STATE_DISCRIMINATOR,
  VAULT_STATE_VAULT_ID_OFFSET,
  getFTokenMintPda,
  getLendingPda,
  getPositionMintPda,
  getPositionPda,
  getVaultConfigPda,
  getVaultStatePda,
} from "../../src/client/jupiter-lend/shared";

function makeBaseClient(): BaseClient {
  const signer = Keypair.generate().publicKey;
  return new BaseClient({
    cluster: ClusterNetwork.Localnet,
    provider: {
      connection: {
        rpcEndpoint: "http://localhost:8899",
        commitment: "confirmed",
      },
      publicKey: signer,
    } as any,
    statePda: Keypair.generate().publicKey,
    useStaging: false,
  });
}

function makeEarnClient(): JupiterEarnClient {
  return new JupiterEarnClient(makeBaseClient());
}

function makeBorrowClient(): JupiterBorrowClient {
  const base = makeBaseClient();
  return new JupiterBorrowClient(base, new VaultClient(base));
}

function pubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function accountInfo(owner: PublicKey, data: Buffer) {
  return { data, executable: false, lamports: 0, owner, rentEpoch: 0 };
}

function mintData(): Buffer {
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
  return data;
}

/** The liquidity program's TokenReserve address for `mint`. */
function liquidityReserveAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), mint.toBuffer()],
    JUPITER_LIQUIDITY_PROGRAM_ID,
  )[0];
}

function tokenReserveData(mint: PublicKey, vault: PublicKey): Buffer {
  const data = Buffer.alloc(192);
  TOKEN_RESERVE_DISCRIMINATOR.copy(data, 0);
  mint.toBuffer().copy(data, 8);
  vault.toBuffer().copy(data, TOKEN_RESERVE_VAULT_OFFSET);
  return data;
}

/**
 * A Jupiter Borrow vault whose supply and borrow tokens have no Earn market:
 * neither has a Lending account, and both have a TokenReserve at the
 * liquidity program's derived address.
 */
function borrowOperateFixture(client: JupiterBorrowClient) {
  const vaultId = 11;
  const nftId = 7;
  const position = getPositionPda(vaultId, nftId);
  const positionMint = getPositionMintPda(vaultId, nftId);
  const vaultConfig = getVaultConfigPda(vaultId);
  const vaultState = getVaultStatePda(vaultId);
  const oracle = pubkey();
  const supplyToken = pubkey();
  const borrowToken = pubkey();
  const supplyReserve = liquidityReserveAddress(supplyToken);
  const borrowReserve = liquidityReserveAddress(borrowToken);
  const supplyVault = pubkey();
  const borrowVault = pubkey();

  const positionBytes = Buffer.alloc(71);
  POSITION_DISCRIMINATOR.copy(positionBytes, 0);
  positionBytes.writeUInt16LE(vaultId, POSITION_VAULT_ID_OFFSET);
  positionBytes.writeUInt32LE(nftId, POSITION_VAULT_ID_OFFSET + 2);
  positionMint.toBuffer().copy(positionBytes, POSITION_MINT_OFFSET);
  positionBytes.writeUInt32LE(1, POSITION_TICK_ID_OFFSET);

  const vaultStateBytes = Buffer.alloc(128);
  VAULT_STATE_DISCRIMINATOR.copy(vaultStateBytes, 0);
  vaultStateBytes.writeUInt16LE(vaultId, VAULT_STATE_VAULT_ID_OFFSET);

  const vaultConfigBytes = Buffer.alloc(219);
  VAULT_CONFIG_DISCRIMINATOR.copy(vaultConfigBytes, 0);
  vaultConfigBytes.writeUInt16LE(vaultId, 8);
  oracle.toBuffer().copy(vaultConfigBytes, VAULT_CONFIG_ORACLE_OFFSET);
  supplyToken
    .toBuffer()
    .copy(vaultConfigBytes, VAULT_CONFIG_SUPPLY_TOKEN_OFFSET);
  borrowToken
    .toBuffer()
    .copy(vaultConfigBytes, VAULT_CONFIG_BORROW_TOKEN_OFFSET);

  // Discriminator, vault id and a source count of zero.
  const oracleBytes = Buffer.alloc(14);
  ORACLE_DISCRIMINATOR.copy(oracleBytes, 0);

  const accountByKey = new Map(
    [
      [position, accountInfo(JUPITER_VAULTS_PROGRAM_ID, positionBytes)],
      [vaultState, accountInfo(JUPITER_VAULTS_PROGRAM_ID, vaultStateBytes)],
      [vaultConfig, accountInfo(JUPITER_VAULTS_PROGRAM_ID, vaultConfigBytes)],
      [oracle, accountInfo(JUPITER_ORACLE_PROGRAM_ID, oracleBytes)],
      [supplyToken, accountInfo(TOKEN_PROGRAM_ID, mintData())],
      [borrowToken, accountInfo(TOKEN_PROGRAM_ID, mintData())],
      [
        supplyReserve,
        accountInfo(
          JUPITER_LIQUIDITY_PROGRAM_ID,
          tokenReserveData(supplyToken, supplyVault),
        ),
      ],
      [
        borrowReserve,
        accountInfo(
          JUPITER_LIQUIDITY_PROGRAM_ID,
          tokenReserveData(borrowToken, borrowVault),
        ),
      ],
    ].map(([key, info]) => [(key as PublicKey).toBase58(), info]),
  );

  const connection = client.base.connection as any;
  connection.getAccountInfo = jest.fn(
    async (key: PublicKey) => accountByKey.get(key.toBase58()) ?? null,
  );
  // Ticks, tick ids and liquidity positions: one zeroed account per query.
  connection.getProgramAccounts = jest.fn(async () => [
    {
      pubkey: pubkey(),
      account: accountInfo(JUPITER_VAULTS_PROGRAM_ID, Buffer.alloc(40)),
    },
  ]);

  return {
    position,
    supplyToken,
    borrowToken,
    supplyReserve,
    borrowReserve,
    supplyVault,
    borrowVault,
  };
}

describe("Jupiter lend instruction builders", () => {
  it("places GLAM vault ATAs and Jupiter Earn program IDs for deposit", async () => {
    const client = makeEarnClient();
    const mint = pubkey();
    const fTokenMint = pubkey();

    const ix = await client.txBuilder.depositIx(10, 9, {
      mint,
      lendingAdmin: pubkey(),
      lending: pubkey(),
      fTokenMint,
      supplyTokenReservesLiquidity: pubkey(),
      lendingSupplyPositionOnLiquidity: pubkey(),
      rateModel: pubkey(),
      vault: pubkey(),
      liquidity: pubkey(),
      rewardsRateModel: pubkey(),
    });

    expect(ix.programId.equals(client.base.extJupiterProgram.programId)).toBe(
      true,
    );
    expect(ix.keys[1].pubkey.equals(client.base.vaultPda)).toBe(true);
    expect(ix.keys[2].pubkey.equals(client.base.signer)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[4].pubkey.equals(JUPITER_LENDING_PROGRAM_ID)).toBe(true);
    expect(ix.keys[7].pubkey.equals(client.base.getVaultAta(mint))).toBe(true);
    expect(ix.keys[8].pubkey.equals(client.base.getVaultAta(fTokenMint))).toBe(
      true,
    );
    expect(ix.keys[18].pubkey.equals(JUPITER_LIQUIDITY_PROGRAM_ID)).toBe(true);
    expect(ix.keys[20].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[21].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("places Jupiter Borrow program IDs for initPosition", async () => {
    const client = makeBorrowClient();
    const positionMint = pubkey();
    const [metadataAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        positionMint.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    );

    const ix = await client.txBuilder.initPositionIx(7, 42, {
      vaultAdmin: pubkey(),
      vaultState: pubkey(),
      position: pubkey(),
      positionMint,
      positionTokenAccount: pubkey(),
    });

    expect(ix.programId.equals(client.base.extJupiterProgram.programId)).toBe(
      true,
    );
    expect(ix.keys[1].pubkey.equals(client.base.vaultPda)).toBe(true);
    expect(ix.keys[2].pubkey.equals(client.base.signer)).toBe(true);
    expect(ix.keys[2].isSigner).toBe(true);
    expect(ix.keys[4].pubkey.equals(JUPITER_VAULTS_PROGRAM_ID)).toBe(true);
    expect(ix.keys[12].pubkey.equals(metadataAccount)).toBe(true);
    expect(ix.keys[13].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix.keys[14].pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("passes tick debt remaining accounts into the final tick probe", async () => {
    const client = makeBorrowClient();
    const oracleSource = pubkey();
    const tickHasDebt = pubkey();
    const captured: { indices?: Buffer; remaining?: string[] } = {};

    (client.txBuilder as any).operateIx = async (
      _newCol: BN,
      _newDebt: BN,
      _transferType: unknown,
      remainingAccountsIndices: Buffer,
      accounts: { remainingAccounts?: { pubkey: PublicKey }[] },
    ) => {
      captured.indices = Buffer.from(remainingAccountsIndices);
      captured.remaining = accounts.remainingAccounts?.map((a) =>
        a.pubkey.toBase58(),
      );
      return new TransactionInstruction({
        programId: pubkey(),
        keys: [],
        data: Buffer.alloc(0),
      });
    };
    (client.base.connection as any).simulateTransaction = async () => ({
      value: {
        logs: ["Program log: Tick mismatch: expected 2198 but got 2277"],
      },
    });

    const result = await (client as any).simulateExpectedFinalTick(
      new BN(0),
      new BN(-100_000),
      { direct: {} },
      {
        indices: Buffer.from([1, 0, 1]),
        accounts: [
          { pubkey: oracleSource, isSigner: false, isWritable: false },
          { pubkey: tickHasDebt, isSigner: false, isWritable: true },
        ],
      },
      {},
    );

    expect(result).toBe(2198);
    expect(captured.indices?.equals(Buffer.from([1, 0, 1]))).toBe(true);
    expect(captured.remaining).toEqual([
      oracleSource.toBase58(),
      tickHasDebt.toBase58(),
    ]);
  });

  it("rejects an operate deposit whose supply token reserve holds another mint", async () => {
    const client = makeBorrowClient();
    const fixture = borrowOperateFixture(client);
    const connection = client.base.connection as any;
    const real = connection.getAccountInfo;
    const otherMint = pubkey();
    connection.getAccountInfo = jest.fn(async (key: PublicKey) =>
      key.equals(fixture.supplyReserve)
        ? accountInfo(
            JUPITER_LIQUIDITY_PROGRAM_ID,
            tokenReserveData(otherMint, fixture.supplyVault),
          )
        : real(key),
    );
    jest
      .spyOn(client as any, "simulateExpectedFinalTick")
      .mockResolvedValue(null);
    const operate = jest.spyOn(client, "operate").mockResolvedValue("sig");

    await expect(client.deposit(fixture.position, 5)).rejects.toThrow(
      `TokenReserve ${fixture.supplyReserve.toBase58()} mint ${otherMint.toBase58()} does not match expected mint ${fixture.supplyToken.toBase58()}`,
    );
    expect(operate).not.toHaveBeenCalled();
  });

  it("resolves operate reserves and vaults from the liquidity program when the collateral has no Earn market", async () => {
    const client = makeBorrowClient();
    const fixture = borrowOperateFixture(client);
    jest
      .spyOn(client as any, "simulateExpectedFinalTick")
      .mockResolvedValue(null);
    const operate = jest.spyOn(client, "operate").mockResolvedValue("sig");

    await client.deposit(fixture.position, 5);

    expect(operate).toHaveBeenCalledTimes(1);
    const accounts = operate.mock.calls[0][4];
    expect(accounts.supplyTokenReservesLiquidity).toEqual(
      fixture.supplyReserve,
    );
    expect(accounts.borrowTokenReservesLiquidity).toEqual(
      fixture.borrowReserve,
    );
    expect(accounts.vaultSupplyTokenAccount).toEqual(fixture.supplyVault);
    expect(accounts.vaultBorrowTokenAccount).toEqual(fixture.borrowVault);
    const connection = client.base.connection as any;
    const read = connection.getAccountInfo.mock.calls.map(
      ([key]: [PublicKey]) => key.toBase58(),
    );
    for (const mint of [fixture.supplyToken, fixture.borrowToken]) {
      expect(read).not.toContain(
        getLendingPda(mint, getFTokenMintPda(mint)).toBase58(),
      );
    }

    const ix = await client.txBuilder.operateIx(
      5,
      0,
      { direct: {} },
      Buffer.from([0, 0, 0]),
      accounts,
    );
    const keys = ix.keys.map((key) => key.pubkey.toBase58());
    for (const expected of [
      fixture.supplyReserve,
      fixture.borrowReserve,
      fixture.supplyVault,
      fixture.borrowVault,
    ]) {
      expect(keys).toContain(expected.toBase58());
    }
  });
});
