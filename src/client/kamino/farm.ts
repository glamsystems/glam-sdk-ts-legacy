import { BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  VersionedTransaction,
  TransactionSignature,
  Transaction,
} from "@solana/web3.js";

import { BaseClient, BaseTxBuilder, TxOptions } from "../base";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { KAMINO_FARM_PROGRAM } from "../../constants";
import { getProgramAccounts } from "../../utils/rpc";
import { getMultipleAccountsInfoBatched } from "../../utils/multipleAccounts";
import { PkMap } from "../../utils";
import { KaminoLendingClient } from "./lending";
import { ParsedFarmState, ParsedFarmUser } from "./types";

// A Kamino Farms user state: its size and its account discriminator.
const FARM_USER_STATE_SIZE = 920;
const FARM_USER_STATE_DISCRIMINATOR = Buffer.from([
  72, 177, 85, 249, 76, 167, 186, 126,
]);

class TxBuilder extends BaseTxBuilder<KaminoFarmClient> {
  public async stakeTx(
    amount: BN,
    farmState: PublicKey,
    txOptions: TxOptions = {},
  ): Promise<VersionedTransaction> {
    const glamSigner = txOptions.signer || this.client.base.signer;

    const farms = await this.client.fetchAndParseFarmStates([farmState]);
    const parsedFarmState = farms.get(farmState);
    if (!parsedFarmState) {
      throw new Error("Farm state not found");
    }
    const { farmTokenMint, farmTokenProgram, farmVault } = parsedFarmState;
    if (farmTokenMint.equals(PublicKey.default)) {
      throw new Error("Delegated farm is not supported");
    }

    const farmUserState = this.client.kaminoLending.getFarmUserState(
      this.client.base.vaultPda,
      farmState,
    );
    const farmUserStateAccountInfo =
      await this.client.base.connection.getAccountInfo(farmUserState);
    const preInstructions = txOptions.preInstructions || [];
    if (!farmUserStateAccountInfo) {
      const initUserIx = await this.client.base.extKaminoProgram.methods
        .farmsInitializeUser()
        .accounts({
          glamState: this.client.base.statePda,
          glamSigner,
          userState: farmUserState,
          farmState,
        })
        .instruction();
      preInstructions.push(initUserIx);
    }

    const tx = await this.client.base.extKaminoProgram.methods
      .farmsStake(amount)
      .accounts({
        glamState: this.client.base.statePda,
        glamSigner,
        userState: farmUserState,
        farmState,
        farmVault,
        userAta: this.client.base.getVaultAta(farmTokenMint, farmTokenProgram),
        tokenMint: farmTokenMint,
        scopePrices: null,
        tokenProgram: farmTokenProgram,
      })
      .preInstructions(preInstructions)
      .transaction();
    const vTx = await this.client.base.intoVersionedTransaction(tx, txOptions);
    return vTx;
  }

  public async unstakeTx(
    amount: BN,
    farmState: PublicKey,
    txOptions: TxOptions = {},
  ): Promise<VersionedTransaction> {
    const glamSigner = txOptions.signer || this.client.base.signer;

    const farms = await this.client.fetchAndParseFarmStates([farmState]);
    const parsedFarmState = farms.get(farmState);
    if (!parsedFarmState) {
      throw new Error("Farm state not found");
    }
    const { farmTokenMint, farmTokenProgram, farmVault } = parsedFarmState;
    if (farmTokenMint.equals(PublicKey.default)) {
      throw new Error("Delegated farm is not supported");
    }
    // The withdrawal below takes the unstaked tokens in the same
    // transaction, and Kamino Farms holds them for the cooldown first.
    if (parsedFarmState.withdrawalCooldownPeriod > 0) {
      throw new Error(
        `Farm ${farmState} holds unstaked tokens for ${parsedFarmState.withdrawalCooldownPeriod} ${parsedFarmState.timeUnit === 0 ? "seconds" : "slots"} before they can be withdrawn, so an unstake that withdraws in the same transaction fails`,
      );
    }

    const farmUserState = this.client.kaminoLending.getFarmUserState(
      this.client.base.vaultPda,
      farmState,
    );
    const userAta = this.client.base.getVaultAta(
      farmTokenMint,
      farmTokenProgram,
    );
    const withdrawIx = await this.client.base.extKaminoProgram.methods
      .farmsWithdrawUnstakedDeposits()
      .accounts({
        glamState: this.client.base.statePda,
        glamSigner,
        userState: farmUserState,
        farmState,
        userAta,
        farmVault,
        farmVaultsAuthority: this.client.farmVaultsAuthority(farmState),
        tokenProgram: farmTokenProgram,
      })
      .instruction();

    const tx = await this.client.base.extKaminoProgram.methods
      .farmsUnstake(amount)
      .accounts({
        glamState: this.client.base.statePda,
        glamSigner,
        userState: farmUserState,
        farmState,
        scopePrices: null,
      })
      .postInstructions([withdrawIx])
      .transaction();
    const vTx = await this.client.base.intoVersionedTransaction(tx, txOptions);
    return vTx;
  }

  public async harvestTx(
    farmUserStates: PublicKey[],
    txOptions: TxOptions = {},
  ): Promise<VersionedTransaction> {
    const glamSigner = txOptions.signer || this.client.base.signer;
    const parsedFarmUserStates = (
      await this.client.findAndParseFarmUserStates(this.client.base.vaultPda)
    ).filter((farmUser) =>
      farmUserStates.find((v) => v.equals(farmUser.pubkey)),
    );

    const parsedFarmStates = await this.client.fetchAndParseFarmStates(
      parsedFarmUserStates.map((f) => f.farmState),
    );

    const tx = new Transaction();
    for (const {
      pubkey: userState,
      farmState,
      unclaimedRewards,
    } of parsedFarmUserStates) {
      const parsedFarmState = parsedFarmStates.get(farmState);
      if (!parsedFarmState) {
        throw new Error("Farm state not found");
      }
      const { globalConfig, rewards } = parsedFarmState;

      for (const { index, mint, tokenProgram, rewardsVault } of rewards) {
        if (unclaimedRewards[index].eq(new BN(0))) {
          continue;
        }

        const vaultAta = this.client.base.getVaultAta(mint, tokenProgram);
        const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          glamSigner,
          vaultAta,
          this.client.base.vaultPda,
          mint,
          tokenProgram,
        );

        const harvestIx = await this.client.base.extKaminoProgram.methods
          .farmsHarvestReward(new BN(index))
          .accounts({
            glamState: this.client.base.statePda,
            glamSigner,
            userState,
            farmState,
            globalConfig,
            rewardMint: mint,
            userRewardAta: vaultAta,
            rewardsVault,
            rewardsTreasuryVault: this.client.rewardsTreasuryVault(
              globalConfig,
              mint,
            ),
            farmVaultsAuthority: this.client.farmVaultsAuthority(farmState),
            scopePrices: null,
            tokenProgram,
          })
          .instruction();
        tx.add(createAtaIx, harvestIx);
      }
    }

    if (tx.instructions.length === 0) {
      throw new Error("No rewards to harvest");
    }

    const vTx = await this.client.base.intoVersionedTransaction(tx, txOptions);
    return vTx;
  }
}

export class KaminoFarmClient {
  txBuilder: TxBuilder;

  public constructor(
    readonly base: BaseClient,
    readonly kaminoLending: KaminoLendingClient,
  ) {
    this.txBuilder = new TxBuilder(this);
  }

  /**
   * Finds and parses farm user states for the given owner. Without
   * `directFarms` it scans Kamino Farms for every user state the owner holds,
   * delegated stakes included.
   *
   * With `directFarms` it reads only the owner's direct stake in each of those
   * farms, the user state at ["user", farm, owner], by its address and without
   * a program scan, which some RPC providers refuse. A delegated stake takes
   * its address from its delegatee, so this read never finds one: it leaves
   * out a farm where the owner has no direct user state, and only the scan
   * finds a delegated stake there.
   */
  async findAndParseFarmUserStates(
    owner: PublicKey,
    directFarms?: PublicKey[],
  ): Promise<ParsedFarmUser[]> {
    if (directFarms) {
      const farmStates = directFarms;
      const addresses = farmStates.map((farmState) =>
        this.kaminoLending.getFarmUserState(owner, farmState),
      );
      const infos = await getMultipleAccountsInfoBatched(
        this.base.connection,
        addresses,
      );
      return infos.flatMap((account, i) => {
        if (!account) {
          return [];
        }
        // The account at the owner's address in a farm is read only when it
        // is a user state of that farm and that owner.
        const { data } = account;
        if (
          !account.owner.equals(KAMINO_FARM_PROGRAM) ||
          data.length !== FARM_USER_STATE_SIZE ||
          !data.subarray(0, 8).equals(FARM_USER_STATE_DISCRIMINATOR) ||
          !new PublicKey(data.subarray(16, 48)).equals(farmStates[i]) ||
          !new PublicKey(data.subarray(48, 80)).equals(owner)
        ) {
          throw new Error(
            `Account ${addresses[i]} is not the Kamino farm user state of ${owner} in farm ${farmStates[i]}`,
          );
        }
        // is_farm_delegated: this read takes direct stakes alone.
        if (data[80] !== 0) {
          throw new Error(
            `Account ${addresses[i]} is a delegated stake of ${owner} in farm ${farmStates[i]}, and this lookup reads direct stakes alone`,
          );
        }
        return [this.parseFarmUserState(addresses[i], data)];
      });
    }

    const accounts = await getProgramAccounts(
      this.base.connection,
      KAMINO_FARM_PROGRAM,
      {
        filters: [
          { dataSize: FARM_USER_STATE_SIZE },
          { memcmp: { offset: 48, bytes: owner.toBase58() } },
        ],
      },
    );
    return accounts.map(({ pubkey, account }) =>
      this.parseFarmUserState(pubkey, account.data),
    );
  }

  private parseFarmUserState(pubkey: PublicKey, data: Buffer): ParsedFarmUser {
    const farmState = new PublicKey(data.subarray(16, 48));

    const rewardsOffset = 248;
    const numRewards = 10;
    const rewardSize = 8;

    const rewardsData = data.subarray(
      rewardsOffset,
      rewardsOffset + numRewards * rewardSize,
    );
    const unclaimedRewards: BN[] = Array.from(
      { length: numRewards },
      (_, i) => {
        const rewardData = rewardsData.subarray(
          i * rewardSize,
          (i + 1) * rewardSize,
        );
        return new BN(rewardData, "le");
      },
    );

    return {
      pubkey,
      farmState,
      unclaimedRewards,
      // active_stake_scaled, a u128 after the three reward arrays.
      activeStakeScaled: new BN(data.subarray(408, 424), "le"),
      // last_stake_ts, a u64 after the delegatee.
      lastStakeTs: new BN(data.subarray(512, 520), "le"),
    };
  }

  async parseFarmState(data: Buffer): Promise<ParsedFarmState> {
    const globalConfig = new PublicKey(data.subarray(40, 72));
    const farmTokenMint = new PublicKey(data.subarray(72, 104));
    const farmTokenDecimals = new BN(data.subarray(104, 112), "le");
    const farmTokenProgram = new PublicKey(data.subarray(112, 144));
    const rewardsOffset = 192;
    const numRewards = 10;
    const rewardSize = 704;

    const rewardsData = data.subarray(
      rewardsOffset,
      rewardsOffset + numRewards * rewardSize,
    );
    const rewards = Array.from({ length: numRewards }, (_, i) => {
      const rewardData = rewardsData.subarray(
        i * rewardSize,
        (i + 1) * rewardSize,
      );
      const mint = new PublicKey(rewardData.subarray(0, 32));
      const tokenProgram = new PublicKey(rewardData.subarray(40, 72));
      const rewardsVault = new PublicKey(rewardData.subarray(120, 152));
      const minClaimDurationSeconds = new BN(
        rewardData.subarray(480, 488),
        "le",
      );

      return {
        index: i,
        mint,
        minClaimDurationSeconds,
        tokenProgram,
        rewardsVault,
      };
    }).filter((r) => {
      if (r.mint.equals(PublicKey.default)) {
        return false;
      }
      // Filter out rewards with minClaimDurationSeconds > 1 year
      if (
        r.minClaimDurationSeconds.div(new BN(365 * 24 * 60 * 60)).gt(new BN(1))
      ) {
        return false;
      }
      return true;
    });

    // After the rewards: num_reward_tokens and num_users, a u64 each, then
    // total_staked_amount and the farm vault.
    const totalStakedAmountOffset =
      rewardsOffset + numRewards * rewardSize + 16;
    const totalStakedAmount = new BN(
      data.subarray(totalStakedAmountOffset, totalStakedAmountOffset + 8),
      "le",
    );
    const farmVaultOffset = totalStakedAmountOffset + 8;
    const farmVault = new PublicKey(
      data.subarray(farmVaultOffset, farmVaultOffset + 32),
    );
    // time_unit, a u8, 104 bytes after the farm vault, and
    // withdrawal_cooldown_period, a u32 just before total_active_stake_scaled.
    const timeUnit = data.readUInt8(farmVaultOffset + 104);
    const withdrawalCooldownPeriod = data.readUInt32LE(farmVaultOffset + 148);
    // total_active_stake_scaled, a u128, 152 bytes after the farm vault.
    const totalActiveStakeScaledOffset = farmVaultOffset + 152;
    const totalActiveStakeScaled = new BN(
      data.subarray(
        totalActiveStakeScaledOffset,
        totalActiveStakeScaledOffset + 16,
      ),
      "le",
    );
    // locking_mode, locking_start_timestamp, locking_duration and
    // locking_early_withdrawal_penalty_bps, u64s from 240 bytes after the
    // farm vault.
    const lockingOffset = farmVaultOffset + 240;
    const lockingField = (index: number) =>
      new BN(
        data.subarray(lockingOffset + index * 8, lockingOffset + index * 8 + 8),
        "le",
      );

    return {
      globalConfig,
      farmTokenMint,
      farmTokenDecimals,
      farmTokenProgram,
      farmVault,
      totalStakedAmount,
      totalActiveStakeScaled,
      withdrawalCooldownPeriod,
      timeUnit,
      lockingMode: lockingField(0),
      lockingStartTimestamp: lockingField(1),
      lockingDuration: lockingField(2),
      lockingEarlyWithdrawalPenaltyBps: lockingField(3),
      rewards,
    };
  }

  async fetchAndParseFarmStates(farms: PublicKey[]) {
    const farmAccounts = await getMultipleAccountsInfoBatched(
      this.base.connection,
      farms,
    );

    const map = new PkMap<ParsedFarmState>();

    for (let i = 0; i < farmAccounts.length; i++) {
      const account = farmAccounts[i];
      if (!account) {
        continue;
      }

      const data = account.data;
      const parsedFarm = await this.parseFarmState(data);
      map.set(farms[i], parsedFarm);
    }

    return map;
  }

  farmVaultTokenAccount = (farm: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), farm.toBuffer(), mint.toBuffer()],
      KAMINO_FARM_PROGRAM,
    )[0];

  farmVaultsAuthority = (farm: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("authority"), farm.toBuffer()],
      KAMINO_FARM_PROGRAM,
    )[0];

  rewardsTreasuryVault = (globalConfig: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("tvault"), globalConfig.toBuffer(), mint.toBuffer()],
      KAMINO_FARM_PROGRAM,
    )[0];

  /**
   * Harvest rewards from Kamino farms
   */
  public async harvest(
    vaultFarmStates: PublicKey[],
    txOptions: TxOptions = {},
  ): Promise<TransactionSignature> {
    const tx = await this.txBuilder.harvestTx(vaultFarmStates, txOptions);
    return await this.base.sendAndConfirm(tx);
  }

  /**
   * Stake tokens to a farm
   */
  public async stake(
    amount: BN,
    farmState: PublicKey,
    txOptions: TxOptions = {},
  ): Promise<TransactionSignature> {
    const tx = await this.txBuilder.stakeTx(amount, farmState, txOptions);
    return await this.base.sendAndConfirm(tx);
  }

  /**
   * Unstake tokens from a farm
   */
  public async unstake(
    amount: BN,
    farmState: PublicKey,
    txOptions: TxOptions = {},
  ): Promise<TransactionSignature> {
    const tx = await this.txBuilder.unstakeTx(amount, farmState, txOptions);
    return await this.base.sendAndConfirm(tx);
  }
}
