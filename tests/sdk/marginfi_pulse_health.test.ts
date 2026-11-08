import { PublicKey, SystemProgram } from "@solana/web3.js";

import { MarginfiClient } from "../../src/client/marginfi";
import { MARGINFI_PROGRAM_ID } from "../../src/constants";

const PULSE_DISCRIMINATOR = [186, 52, 117, 97, 34, 74, 39, 253];
const BANK_REFRESH_DISCRIMINATOR = [192, 19, 201, 135, 105, 203, 32, 222];

const ACCOUNT_DISCRIMINATOR = Buffer.from([
  67, 178, 130, 109, 126, 114, 28, 42,
]);
const BANK_DISCRIMINATOR = Buffer.from([142, 49, 166, 242, 50, 66, 97, 188]);
const ACCOUNT_GROUP_OFFSET = 8;
const ACCOUNT_BALANCES_OFFSET = 72;
const BALANCE_LEN = 104;
const BALANCE_COUNT = 16;
const BANK_MINT_OFFSET = 8;
const BANK_GROUP_OFFSET = 41;
const BANK_ORACLE_KEYS_OFFSET = 610;
const BANK_DATA_LEN = 1700;

const MARGINFI_ACCOUNT = PublicKey.unique();
const GROUP = PublicKey.unique();
const OTHER_GROUP = PublicKey.unique();

function accountData(group: PublicKey, banks: PublicKey[]): Buffer {
  const data = Buffer.alloc(
    ACCOUNT_BALANCES_OFFSET + BALANCE_LEN * BALANCE_COUNT,
  );
  ACCOUNT_DISCRIMINATOR.copy(data, 0);
  group.toBuffer().copy(data, ACCOUNT_GROUP_OFFSET);
  banks.forEach((bank, index) => {
    const offset = ACCOUNT_BALANCES_OFFSET + index * BALANCE_LEN;
    data[offset] = 1;
    bank.toBuffer().copy(data, offset + 1);
  });
  return data;
}

function bankData(group: PublicKey, oracles: PublicKey[]): Buffer {
  const data = Buffer.alloc(BANK_DATA_LEN);
  BANK_DISCRIMINATOR.copy(data, 0);
  PublicKey.unique().toBuffer().copy(data, BANK_MINT_OFFSET);
  group.toBuffer().copy(data, BANK_GROUP_OFFSET);
  oracles.forEach((oracle, index) => {
    oracle.toBuffer().copy(data, BANK_ORACLE_KEYS_OFFSET + index * 32);
  });
  return data;
}

function info(data: Buffer, owner = MARGINFI_PROGRAM_ID) {
  return { data, owner, executable: false, lamports: 0, rentEpoch: 0 };
}

function makeClient(
  account: ReturnType<typeof info>,
  banks: Map<string, ReturnType<typeof info>>,
) {
  const getAccountInfo = jest.fn(async (key: PublicKey) =>
    key.equals(MARGINFI_ACCOUNT)
      ? account
      : (banks.get(key.toBase58()) ?? null),
  );
  const connection = {
    getAccountInfo,
    getMultipleAccountsInfo: jest.fn(async (keys: PublicKey[]) =>
      keys.map(() => null),
    ),
  };
  const client = new MarginfiClient({ connection } as any);
  return { client, getAccountInfo };
}

describe("Marginfi health pulse", () => {
  const bankA = PublicKey.unique();
  const bankB = PublicKey.unique();
  const oraclesA = [PublicKey.unique()];
  const oraclesB = [PublicKey.unique(), PublicKey.unique()];

  it("carries the account, the group and each bank with its oracles", async () => {
    const { client, getAccountInfo } = makeClient(
      info(accountData(GROUP, [bankA, bankB])),
      new Map([
        [bankA.toBase58(), info(bankData(GROUP, oraclesA))],
        [bankB.toBase58(), info(bankData(GROUP, oraclesB))],
      ]),
    );

    const { ixs, banks } = await client.pulseHealthIx(MARGINFI_ACCOUNT);

    expect(
      getAccountInfo.mock.calls.filter(([k]) => k.equals(MARGINFI_ACCOUNT)),
    ).toHaveLength(1);
    const pulse = ixs[ixs.length - 1];
    expect(pulse.programId.equals(MARGINFI_PROGRAM_ID)).toBe(true);
    expect([...pulse.data]).toEqual(PULSE_DISCRIMINATOR);
    expect(pulse.keys[0]).toEqual({
      pubkey: MARGINFI_ACCOUNT,
      isSigner: false,
      isWritable: true,
    });
    expect(pulse.keys[1]).toEqual({
      pubkey: GROUP,
      isSigner: false,
      isWritable: false,
    });
    // Banks in descending order of their 32 key bytes, each with its oracles.
    const ordered = [
      { bank: bankA, oracles: oraclesA },
      { bank: bankB, oracles: oraclesB },
    ].sort((a, b) => Buffer.compare(b.bank.toBuffer(), a.bank.toBuffer()));
    const readOnly = (pubkey: PublicKey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    });
    const expected = ordered.flatMap(({ bank, oracles }) => [
      { pubkey: bank, isSigner: false, isWritable: true },
      ...oracles.map(readOnly),
    ]);
    expect(banks.map((bank) => bank.address)).toEqual(
      ordered.map(({ bank }) => bank),
    );
    expect(pulse.keys.slice(2)).toEqual(expected);

    const refreshes = ixs.slice(0, -1);
    expect(refreshes).toHaveLength(2);
    refreshes.forEach((ix, index) => {
      expect([...ix.data]).toEqual(BANK_REFRESH_DISCRIMINATOR);
      expect(ix.keys).toEqual([
        readOnly(GROUP),
        { pubkey: ordered[index].bank, isSigner: false, isWritable: true },
        ...ordered[index].oracles.map(readOnly),
      ]);
    });
  });

  it("carries only the account and the group when no balance is active", async () => {
    const { client } = makeClient(info(accountData(GROUP, [])), new Map());

    const { ixs, banks } = await client.pulseHealthIx(MARGINFI_ACCOUNT);

    expect(banks).toEqual([]);
    expect(ixs).toHaveLength(1);
    expect(ixs[0].keys.map((k) => k.pubkey.toBase58())).toEqual([
      MARGINFI_ACCOUNT.toBase58(),
      GROUP.toBase58(),
    ]);
    expect(ixs[0].keys[1].isWritable).toBe(false);
  });

  it("takes the group from the account and refuses a bank of another group", async () => {
    const { client } = makeClient(
      info(accountData(GROUP, [bankA])),
      new Map([[bankA.toBase58(), info(bankData(OTHER_GROUP, oraclesA))]]),
    );

    let thrown: Error | undefined;
    let result: unknown;
    try {
      result = await client.pulseHealthIx(MARGINFI_ACCOUNT);
    } catch (error) {
      thrown = error as Error;
    }

    expect(result).toBeUndefined();
    expect(thrown?.message).toContain(bankA.toBase58());
    expect(thrown?.message).toContain(OTHER_GROUP.toBase58());
    expect(thrown?.message).toContain(MARGINFI_ACCOUNT.toBase58());
    expect(thrown?.message).toContain(GROUP.toBase58());
    expect(thrown?.message).toContain(
      `Marginfi bank ${bankA} belongs to group ${OTHER_GROUP}, but account ${MARGINFI_ACCOUNT} belongs to group ${GROUP}. No health pulse was built.`,
    );
  });

  it("keeps the ownership error for an account the program does not own", async () => {
    const { client } = makeClient(
      info(accountData(GROUP, []), SystemProgram.programId),
      new Map(),
    );

    await expect(client.pulseHealthIx(MARGINFI_ACCOUNT)).rejects.toThrow(
      `Marginfi account ${MARGINFI_ACCOUNT} is owned by ${SystemProgram.programId}, expected ${MARGINFI_PROGRAM_ID}`,
    );
  });
});
