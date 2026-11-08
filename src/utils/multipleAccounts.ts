import {
  AccountInfo,
  Commitment,
  Connection,
  PublicKey,
} from "@solana/web3.js";

// utils/index.ts does not re-export this module, so the package exports
// nothing from it.

// An endpoint at the standard limit refuses a getMultipleAccountsInfo request
// with more than 100 keys.
const MAX_KEYS_PER_ACCOUNTS_READ = 100;

/** Reads `keys` in batches of at most 100, results in key order. */
export async function getMultipleAccountsInfoBatched(
  connection: Connection,
  keys: PublicKey[],
  commitment?: Commitment,
): Promise<(AccountInfo<Buffer> | null)[]> {
  const batches: PublicKey[][] = [];
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_ACCOUNTS_READ) {
    batches.push(keys.slice(i, i + MAX_KEYS_PER_ACCOUNTS_READ));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      connection.getMultipleAccountsInfo(batch, commitment),
    ),
  );
  return results.flat();
}
