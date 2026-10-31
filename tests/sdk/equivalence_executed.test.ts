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
 * investors, with the legacy manager paying the fee, and to fund the vault with
 * the base asset a scenario starts it with. The protocol's fee authority the
 * lane's GlobalConfig names, whose base account a fee claim pays, is the lane's
 * key of seed 15, which neither side uses as a manager or an investor; this
 * suite reads that authority from the GlobalConfig rather than assuming it.
 * Each scenario's State is
 * created through the legacy SDK with the name and symbol the scenario
 * states, over the Kit row's base asset, and with the rates it charges.
 *
 * What a scenario stages before its first step (the protocol rates, the
 * integrations, the transfer allowlist, the vault's opening SOL and base
 * asset) goes through the legacy SDK's own setters or plain instructions, and
 * is not compared: only the steps after it are.
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
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  GlamClient,
  nameToChars,
  SPL_TOKEN_PROTOCOL,
  StateAccountType,
  SYSTEM_PROTOCOL,
  WSOL,
} from "../../src";
import { ClusterNetwork } from "../../src/clientConfig";
import { TransferPolicy } from "../../src/deser/integrationPolicies";

type ExecutedModule =
  typeof import("../../../scripts/equivalence/executed.cjs");
type Scenario = Parameters<ExecutedModule["runExecuted"]>[0];
type Step = Scenario["steps"][number];
type FeeRates = NonNullable<NonNullable<Scenario["setup"]>["fees"]>;
const {
  EXECUTED_OUTPUT_ENV,
  FEE_LEDGER_MEMBERS,
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

const variantOf = (value: object) => Object.keys(value)[0];

/**
 * The fee structure a scenario's rates name, as `initialize_mint` takes it.
 * The protocol rates are the program's to set: initialization writes its
 * defaults whatever the model carries.
 */
const feeStructureOf = (fees: FeeRates) => ({
  vault: { subscriptionFeeBps: fees.vaultSubscriptionBps, redemptionFeeBps: 0 },
  manager: {
    subscriptionFeeBps: fees.managerSubscriptionBps,
    redemptionFeeBps: 0,
  },
  management: { feeBps: fees.managementBps },
  performance: {
    feeBps: fees.performanceBps,
    hurdleRateBps: 0,
    hurdleType: { hard: {} },
  },
  protocol: { baseFeeBps: 0, flowFeeBps: 0 },
});

(RPC ? describe : describe.skip)(
  "settlement lane: executed equivalence, legacy side",
  () => {
    jest.setTimeout(1_200_000);

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
        const stage = scenario.setup ?? {};
        const managerClient = clientFor(identities.manager);
        await managerClient.mint.initialize({
          accountType: StateAccountType.TOKENIZED_VAULT,
          name: nameToChars(scenario.vault.name),
          symbol: scenario.vault.symbol,
          uri: "",
          baseAssetMint: BASE_MINT,
          ...(stage.fees ? { feeStructure: feeStructureOf(stage.fees) } : {}),
        } as any);
        const statePda = managerClient.statePda;
        const { feeAuthority: protocolFeeAuthority } =
          await managerClient.fetchGlobalConfig();
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
        // A fee claim names the manager's and the protocol fee authority's
        // base accounts; both exist before the first step, as on the Kit
        // side.
        if (stage.fees)
          for (const owner of [
            identities.manager.publicKey,
            protocolFeeAuthority,
          ])
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
        if (stage.vaultLamports !== undefined)
          setup.add(
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: vault,
              lamports: BigInt(stage.vaultLamports),
            }),
          );
        if (stage.vaultAsset !== undefined)
          setup.add(
            createMintToInstruction(
              BASE_MINT,
              assetOf(vault),
              MINT_AUTHORITY.publicKey,
              BigInt(stage.vaultAsset),
            ),
          );
        await sendAndConfirmTransaction(
          connection,
          setup,
          [payer, MINT_AUTHORITY],
          { commitment: "confirmed" },
        );

        // Wallets no identity is, which hold nothing until a step pays them:
        // the one the transfer policies allow and one they do not.
        const recipient = Keypair.generate().publicKey;
        const stranger = Keypair.generate().publicKey;
        if (stage.protocolFees)
          await managerClient.fees.setProtocolFees(
            stage.protocolFees.baseFeeBps,
            stage.protocolFees.flowFeeBps,
          );
        const integrationOf = {
          System: [managerClient.protocolProgram.programId, SYSTEM_PROTOCOL],
          Token: [managerClient.extSplProgram.programId, SPL_TOKEN_PROTOCOL],
        } as const;
        for (const name of stage.integrations ?? [])
          await managerClient.access.enableProtocols(...integrationOf[name]);
        if (stage.transferAllowlist) {
          const wallets: Record<string, PublicKey> = { recipient, stranger };
          const policy = new TransferPolicy(
            stage.transferAllowlist.map((name) => wallets[name]),
          ).encode();
          for (const name of ["System", "Token"] as const)
            await managerClient.access.setProtocolPolicy(
              ...integrationOf[name],
              policy,
            );
        }

        const known: Record<string, string> = {
          manager: identities.manager.publicKey.toBase58(),
          investorA: identities.investorA.publicKey.toBase58(),
          investorB: identities.investorB.publicKey.toBase58(),
          "manager.asset": assetOf(identities.manager.publicKey).toBase58(),
          "protocolFeeAuthority.asset":
            assetOf(protocolFeeAuthority).toBase58(),
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
          "vault.wsol": getAssociatedTokenAddressSync(
            WSOL,
            vault,
            true,
            TOKEN_PROGRAM_ID,
          ).toBase58(),
          state: statePda.toBase58(),
          queue: managerClient.requestQueuePda.toBase58(),
          shares: shareMint.toBase58(),
          recipient: recipient.toBase58(),
          "recipient.asset": assetOf(recipient).toBase58(),
          stranger: stranger.toBase58(),
          "stranger.asset": assetOf(stranger).toBase58(),
        };
        for (const name of scenario.watched)
          if (!(name in known))
            throw new Error(
              `${id}: the legacy side maps no address to ${name}`,
            );
        const accounts = Object.fromEntries(
          scenario.watched.map((name) => [name, known[name]]),
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
                        new PublicKey(known[`${step.signer}.shares`]),
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
            case "crystallize":
              return [await client.fees.crystallizeFees()];
            case "claimFees":
              return [await client.fees.claimFees()];
            case "transferSol":
              return [
                await client.vault.systemTransfer(
                  new BN(step.amount!),
                  new PublicKey(known[step.to!]),
                ),
              ];
            case "transferToken":
              return [
                await client.vault.tokenTransfer(
                  BASE_MINT,
                  new BN(step.amount!),
                  new PublicKey(known[step.to!]),
                ),
              ];
            case "wrap":
              return [await client.vault.wrap(new BN(step.amount!))];
            case "unwrap":
              return [await client.vault.unwrap()];
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
        const record = (fees: Record<string, unknown>) =>
          Object.fromEntries(
            FEE_LEDGER_MEMBERS.map((member) => [
              member,
              new BN(fees[member] as BN).toString(),
            ]),
          ) as Record<(typeof FEE_LEDGER_MEMBERS)[number], string>;
        const feeLedger = async () => ({
          claimable: record(await managerClient.fees.getClaimableFees()),
          claimed: record(await managerClient.fees.getClaimedFees()),
        });
        const result = await runExecuted(
          scenario,
          {
            accounts,
            programs: {
              glamProtocol: managerClient.protocolProgram.programId.toBase58(),
              glamMint: managerClient.mintProgram.programId.toBase58(),
              extSpl: managerClient.extSplProgram.programId.toBase58(),
            },
            run,
            queue,
            feeLedger,
          },
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
