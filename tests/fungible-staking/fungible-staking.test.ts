import { findAta } from "@cardinal/common";
import { BN, Wallet } from "@project-serum/anchor";
import { getAccount, getMint } from "@solana/spl-token";
import type { Keypair } from "@solana/web3.js";
import { PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "console";

import {
  createStakeEntryAndStakeMint,
  createStakePool,
  initializeRewardEntry,
  rewardDistributor,
  stake,
  unstake,
} from "../../src";
import { RewardDistributorKind } from "../../src/programs/rewardDistributor";
import { getRewardDistributor } from "../../src/programs/rewardDistributor/accounts";
import { findRewardDistributorId } from "../../src/programs/rewardDistributor/pda";
import { ReceiptType } from "../../src/programs/stakePool";
import { getStakeEntry } from "../../src/programs/stakePool/accounts";
import { findStakeEntryIdFromMint } from "../../src/programs/stakePool/utils";
import {
  createMint,
  executeTransaction,
  newAccountWithLamports,
} from "../utils";
import type { CardinalProvider } from "../workspace";
import { getProvider } from "../workspace";

describe("Fungible staking", () => {
  let provider: CardinalProvider;
  let stakePoolId: PublicKey;
  let originalMintTokenAccountId: PublicKey;
  let originalMintId: PublicKey;
  let rewardMintId: PublicKey;

  const maxSupply = 100;
  const stakingAmount = 10;
  let stakeMintKeypair: Keypair | undefined;

  beforeAll(async () => {
    provider = await getProvider();
    // original mint
    const mintAuthority = await newAccountWithLamports(provider.connection);
    [originalMintTokenAccountId, originalMintId] = await createMint(
      provider.connection,
      new Wallet(mintAuthority),
      { target: provider.wallet.publicKey, amount: stakingAmount }
    );

    // reward mint
    [, rewardMintId] = await createMint(
      provider.connection,
      new Wallet(mintAuthority),
      { target: provider.wallet.publicKey, amount: maxSupply }
    );
  });

  it("Create Pool", async () => {
    let transaction: Transaction;
    [transaction, stakePoolId] = await createStakePool(
      provider.connection,
      provider.wallet,
      {}
    );

    await executeTransaction(provider.connection, transaction, provider.wallet);
  });

  it("Create Reward Distributor", async () => {
    const transaction = new Transaction();
    await rewardDistributor.transaction.withInitRewardDistributor(
      transaction,
      provider.connection,
      provider.wallet,
      {
        stakePoolId: stakePoolId,
        rewardMintId: rewardMintId,
        kind: RewardDistributorKind.Treasury,
        maxSupply: new BN(maxSupply),
      }
    );
    await executeTransaction(provider.connection, transaction, provider.wallet);

    const rewardDistributorId = findRewardDistributorId(stakePoolId);
    const rewardDistributorData = await getRewardDistributor(
      provider.connection,
      rewardDistributorId
    );

    expect(rewardDistributorData.parsed.rewardMint.toString()).toEqual(
      rewardMintId.toString()
    );
  });

  it("Init Reward Entry", async () => {
    const rewardDistributorId = findRewardDistributorId(stakePoolId);
    const transaction = await initializeRewardEntry(
      provider.connection,
      provider.wallet,
      {
        originalMintId: originalMintId,
        stakePoolId: stakePoolId,
      }
    );
    await executeTransaction(provider.connection, transaction, provider.wallet);

    const rewardDistributorData = await getRewardDistributor(
      provider.connection,
      rewardDistributorId
    );

    expect(rewardDistributorData.parsed.rewardMint.toString()).toEqual(
      rewardMintId.toString()
    );
  });

  it("Init fungible stake entry and stake mint", async () => {
    let transaction: Transaction;

    [transaction, , stakeMintKeypair] = await createStakeEntryAndStakeMint(
      provider.connection,
      provider.wallet,
      {
        stakePoolId: stakePoolId,
        originalMintId: originalMintId,
      }
    );
    await executeTransaction(
      provider.connection,
      transaction,
      provider.wallet,
      {
        signers: stakeMintKeypair ? [stakeMintKeypair] : [],
      }
    );

    const stakeEntryData = await getStakeEntry(
      provider.connection,
      await findStakeEntryIdFromMint(
        provider.connection,
        provider.wallet.publicKey,
        stakePoolId,
        originalMintId
      )
    );

    expect(stakeEntryData.parsed.originalMint.toString()).toEqual(
      originalMintId.toString()
    );
    expect(stakeEntryData.parsed.pool.toString()).toEqual(
      stakePoolId.toString()
    );
    if (stakeMintKeypair) {
      expect(stakeEntryData.parsed.stakeMint?.toString()).toEqual(
        stakeMintKeypair.publicKey.toString()
      );

      expect(
        (await getMint(provider.connection, stakeMintKeypair.publicKey))
          .isInitialized
      ).toBeTruthy();
    }
  });

  it("Stake half", async () => {
    const transaction = await stake(provider.connection, provider.wallet, {
      stakePoolId: stakePoolId,
      originalMintId: originalMintId,
      userOriginalMintTokenAccountId: originalMintTokenAccountId,
      receiptType: ReceiptType.Receipt,
      amount: new BN(stakingAmount / 2),
    });
    await executeTransaction(provider.connection, transaction, provider.wallet);

    const stakeEntryData = await getStakeEntry(
      provider.connection,
      await findStakeEntryIdFromMint(
        provider.connection,
        provider.wallet.publicKey,
        stakePoolId,
        originalMintId
      )
    );

    const userOriginalMintTokenAccountId = await findAta(
      originalMintId,
      provider.wallet.publicKey,
      true
    );

    const stakeEntryOriginalMintTokenAccountId = await findAta(
      originalMintId,
      stakeEntryData.pubkey,
      true
    );

    if (stakeMintKeypair) {
      const userReceiptTokenAccountId = await findAta(
        stakeMintKeypair.publicKey,
        provider.wallet.publicKey,
        true
      );

      expect(stakeEntryData.parsed.amount.toNumber()).toEqual(
        stakingAmount / 2
      );
      expect(stakeEntryData.parsed.lastStakedAt.toNumber()).toBeGreaterThan(0);
      expect(stakeEntryData.parsed.lastStaker.toString()).toEqual(
        provider.wallet.publicKey.toString()
      );

      const checkUserOriginalTokenAccount = await getAccount(
        provider.connection,
        userOriginalMintTokenAccountId
      );
      expect(Number(checkUserOriginalTokenAccount.amount)).toEqual(
        stakingAmount / 2
      );

      const checkStakeEntryOriginalMintTokenAccount = await getAccount(
        provider.connection,
        stakeEntryOriginalMintTokenAccountId
      );
      expect(Number(checkStakeEntryOriginalMintTokenAccount.amount)).toEqual(
        stakingAmount / 2
      );

      const userReceiptTokenAccount = await getAccount(
        provider.connection,
        userReceiptTokenAccountId
      );
      expect(Number(userReceiptTokenAccount.amount)).toEqual(1);
    }
  });

  it("Stake another half", async () => {
    try {
      await stake(provider.connection, provider.wallet, {
        stakePoolId: stakePoolId,
        originalMintId: originalMintId,
        userOriginalMintTokenAccountId: originalMintTokenAccountId,
        receiptType: ReceiptType.Receipt,
        amount: new BN(stakingAmount / 2),
      });
      assert(
        false,
        "Staked ix should have failed because there are tokens already staked"
      );
    } catch (e) {
      assert(true);
    }
  });

  it("Unstake", async () => {
    const transaction = await unstake(provider.connection, provider.wallet, {
      stakePoolId: stakePoolId,
      originalMintId: originalMintId,
    });
    await executeTransaction(provider.connection, transaction, provider.wallet);

    const stakeEntryData = await getStakeEntry(
      provider.connection,
      await findStakeEntryIdFromMint(
        provider.connection,
        provider.wallet.publicKey,
        stakePoolId,
        originalMintId
      )
    );
    expect(stakeEntryData.parsed.lastStaker.toString()).toEqual(
      PublicKey.default.toString()
    );
    expect(stakeEntryData.parsed.lastStakedAt.toNumber()).toBeGreaterThan(0);

    const userOriginalMintTokenAccountId = await findAta(
      originalMintId,
      provider.wallet.publicKey,
      true
    );
    const checkUserOriginalTokenAccount = await getAccount(
      provider.connection,
      userOriginalMintTokenAccountId
    );
    expect(Number(checkUserOriginalTokenAccount.amount)).toEqual(10);
    expect(checkUserOriginalTokenAccount.isFrozen).toEqual(false);
  });
});
