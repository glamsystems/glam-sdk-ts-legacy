/**
 * The legacy side of the executed equivalence scenarios.
 *
 * Each scenario under fixtures/equivalence/localnet is a workflow both SDKs
 * run against the settlement lane's validator. This suite drives the legacy
 * `GlamClient` through it, from a vault and identities of its own, and writes
 * what the shared observer in scripts/equivalence/executed.cjs saw to the
 * directory the lane names. The Kit row writes its outcome beside it, and the
 * lane holds both to the scenario and to each other.
 *
 * The identities are deterministic and are not the Kit row's: the legacy
 * manager and investors are the keys whose 32 seed bytes are 31, 32 and 33,
 * where the lane's Kit identities use 11, 12 and 13. The one key both sides
 * share is the authority of the lane's base mint (seed 11), which this suite
 * uses only to mint the legacy investors the balance the lane mints its own
 * investors, with the legacy manager paying the fee. Its State is created
 * through the legacy SDK with the same name, symbol and base asset as the Kit
 * row's.
 *
 * It runs only inside the lane, which names the cluster in
 * GLAM_EQUIVALENCE_LOCALNET_RPC; elsewhere it is skipped, and the lane counts a
 * skip as a failure.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { GlamClient, nameToChars, StateAccountType } from "../../src";
import { ClusterNetwork } from "../../src/clientConfig";

type ExecutedModule =
  typeof import("../../../scripts/equivalence/executed.cjs");
type Step = Parameters<ExecutedModule["runExecuted"]>[0]["steps"][number];
const {
  EXECUTED_OUTPUT_ENV,
  executedScenarioIds,
  loadExecutedScenario,
  runExecuted,
  writeExecuted,
}: ExecutedModule = require(
  join(__dirname, "..", "..", "..", "scripts", "equivalence", "executed.cjs"),
);

const RPC = process.env.GLAM_EQUIVALENCE_LOCALNET_RPC;
const seeded = (byte: number) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => byte));
// The lane's base mint and its authority, as the lane derives them.
const BASE_MINT = seeded(21).publicKey;
const MINT_AUTHORITY = seeded(11);
// What the lane mints each of its investors when it creates the base mint.
const INVESTOR_BALANCE = 1_000_000_000_000n;
const VAULT_NAME = "Lane equivalence vault";

const variantOf = (value: object) => Object.keys(value)[0];

(RPC ? describe : describe.skip)(
  "settlement lane: executed equivalence, legacy side",
  () => {
    jest.setTimeout(600_000);

    it("runs every executed scenario through the legacy SDK and writes its outcome", async () => {
      const url = RPC!;
      const output =
        process.env[EXECUTED_OUTPUT_ENV] ??
        mkdtempSync(join(tmpdir(), "glam-executed-"));
      const connection = new Connection(url, "confirmed");
      const identities = {
        manager: seeded(31),
        investorA: seeded(32),
        investorB: seeded(33),
      };
      for (const keypair of Object.values(identities)) {
        const signature = await connection.requestAirdrop(
          keypair.publicKey,
          10 * LAMPORTS_PER_SOL,
        );
        const latest = await connection.getLatestBlockhash("confirmed");
        await connection.confirmTransaction(
          { signature, ...latest },
          "confirmed",
        );
      }
      const clientFor = (keypair: Keypair, statePda?: PublicKey) =>
        new GlamClient({
          provider: new AnchorProvider(connection, new Wallet(keypair), {
            commitment: "confirmed",
            preflightCommitment: "confirmed",
          }),
          cluster: ClusterNetwork.Localnet,
          ...(statePda ? { statePda } : {}),
        });

      const ids = executedScenarioIds();
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const scenario = loadExecutedScenario(id);
        const managerClient = clientFor(identities.manager);
        await managerClient.mint.initialize({
          accountType: StateAccountType.TOKENIZED_VAULT,
          name: nameToChars(VAULT_NAME),
          symbol: "LANEQ",
          uri: "",
          baseAssetMint: BASE_MINT,
        } as any);
        const statePda = managerClient.statePda;
        const clients = {
          manager: managerClient,
          investorA: clientFor(identities.investorA, statePda),
          investorB: clientFor(identities.investorB, statePda),
        };
        const escrow = managerClient.escrowPda;
        const vault = managerClient.vaultPda;
        const shareMint = managerClient.mintPda;
        const assetOf = (owner: PublicKey) =>
          getAssociatedTokenAddressSync(
            BASE_MINT,
            owner,
            true,
            TOKEN_PROGRAM_ID,
          );
        const sharesOf = (owner: PublicKey) =>
          getAssociatedTokenAddressSync(
            shareMint,
            owner,
            true,
            TOKEN_2022_PROGRAM_ID,
          );

        // The same accounts the lane's vault staging opens before a row uses
        // them, and the same base balance it mints each investor.
        const payer = identities.manager;
        const setup = new Transaction();
        for (const owner of [vault, escrow])
          setup.add(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              assetOf(owner),
              owner,
              BASE_MINT,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          );
        for (const owner of [
          escrow,
          identities.investorA.publicKey,
          identities.investorB.publicKey,
        ])
          setup.add(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              sharesOf(owner),
              owner,
              shareMint,
              TOKEN_2022_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          );
        for (const investor of [identities.investorA, identities.investorB])
          setup.add(
            createAssociatedTokenAccountIdempotentInstruction(
              payer.publicKey,
              assetOf(investor.publicKey),
              investor.publicKey,
              BASE_MINT,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
            createMintToInstruction(
              BASE_MINT,
              assetOf(investor.publicKey),
              MINT_AUTHORITY.publicKey,
              INVESTOR_BALANCE,
            ),
          );
        await sendAndConfirmTransaction(
          connection,
          setup,
          [payer, MINT_AUTHORITY],
          { commitment: "confirmed" },
        );

        const accounts: Record<string, string> = {
          manager: identities.manager.publicKey.toBase58(),
          investorA: identities.investorA.publicKey.toBase58(),
          investorB: identities.investorB.publicKey.toBase58(),
          "investorA.asset": assetOf(identities.investorA.publicKey).toBase58(),
          "investorA.shares": sharesOf(
            identities.investorA.publicKey,
          ).toBase58(),
          "investorB.asset": assetOf(identities.investorB.publicKey).toBase58(),
          "investorB.shares": sharesOf(
            identities.investorB.publicKey,
          ).toBase58(),
          escrow: escrow.toBase58(),
          "escrow.asset": assetOf(escrow).toBase58(),
          "escrow.shares": sharesOf(escrow).toBase58(),
          vault: vault.toBase58(),
          "vault.asset": assetOf(vault).toBase58(),
          state: statePda.toBase58(),
          queue: managerClient.requestQueuePda.toBase58(),
          shares: shareMint.toBase58(),
        };
        expect(Object.keys(accounts).sort()).toEqual(
          [...scenario.watched].sort(),
        );

        // The legacy client sends without a preflight, so a refused step can
        // land and fail with its fee charged. The signatures it sent are
        // handed to the observer with the failure, which nets that fee as it
        // nets a landed step's.
        const run = async (step: Step): Promise<readonly string[]> => {
          const client = clients[step.signer as keyof typeof clients];
          if (client === undefined)
            throw new Error(
              `${step.id}: no legacy identity for ${step.signer}`,
            );
          const sent: string[] = [];
          const record = (signature: string) => sent.push(signature);
          client.onSentListeners.add(record);
          try {
            return await runAction(client, step);
          } catch (failure) {
            if (typeof failure === "object" && failure !== null)
              (failure as { landedSignatures?: string[] }).landedSignatures =
                sent;
            throw failure;
          } finally {
            client.onSentListeners.delete(record);
          }
        };
        const runAction = async (
          client: GlamClient,
          step: Step,
        ): Promise<readonly string[]> => {
          switch (step.action) {
            case "subscribe":
              return [
                await client.invest.subscribe(new BN(step.amount!), true),
              ];
            case "redeem": {
              const amount =
                step.amount === "all"
                  ? (
                      await connection.getTokenAccountBalance(
                        new PublicKey(accounts[`${step.signer}.shares`]),
                        "confirmed",
                      )
                    ).value.amount
                  : step.amount!;
              return [await client.invest.queuedRedeem(new BN(amount))];
            }
            case "cancel":
              return [await client.invest.cancel()];
            case "claim":
              return [await client.invest.claim()];
            case "fulfill":
              return [
                await client.invest.fulfill(null, {
                  preInstructions: await client.price.priceVaultIxs(),
                }),
              ];
          }
        };
        const queue = async () =>
          (await managerClient.fetchRequestQueue()).data.map((row: any) => ({
            user: row.user.toBase58(),
            requestType: variantOf(row.requestType),
            incoming: BigInt(row.incoming.toString()),
            outgoing: BigInt(row.outgoing.toString()),
            createdAt: BigInt(row.createdAt.toString()),
            fulfilledAt: BigInt(row.fulfilledAt.toString()),
          }));
        const result = await runExecuted(
          scenario,
          { accounts, run, queue },
          url,
        );
        writeExecuted(output, id, "legacy", result);
        console.log(
          `executed equivalence: ${id} legacy outcome written to ${output}`,
        );
      }
    });
  },
);
