import { txdb } from "@/common/db";
import { fromBuffer, toBuffer } from "@/common/utils";

export interface Block {
  hash: string;
  number: number;
  timestamp: number;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  mixHash: string;
  receiptsRoot: string;
  miner: string;
  difficulty: string;
  totalDifficulty: string;
  size: number;
  extraData: string;
  gasLimit: number;
  gasUsed: number;
  baseFeePerGas: number;
  uncles: string[];
}

export interface BlockWithTransactions extends Block {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transactions: any[];
}

export const _saveBlock = async (blockData: Block) => {
  const timerStart = Date.now();
  await saveBlock(blockData);
  const timerEnd = Date.now();
  return {
    saveBlocksTime: timerEnd - timerStart,
    endSaveBlocksTime: timerEnd,
  };
};

export const saveBlock = async (block: Block): Promise<Block> => {
  await txdb.none(
    `
      INSERT INTO blocks (
        hash,
        number,
        timestamp,
        parent_hash,
        nonce,
        sha3_uncles,
        logs_bloom,
        transactions_root,
        state_root,
        mix_hash,
        receipts_root,
        miner,
        difficulty,
        total_difficulty,
        size,
        extra_data,
        gas_limit,
        gas_used,
        base_fee_per_gas,
        uncles
      ) VALUES (
        $/hash/,
        $/number/,
        $/timestamp/,
        $/parentHash/,
        $/nonce/,
        $/sha3Uncles/,
        $/logsBloom/,
        $/transactionsRoot/,
        $/stateRoot/,
        $/mixHash/,
        $/receiptsRoot/,
        $/miner/,
        $/difficulty/,
        $/totalDifficulty/,
        $/size/,
        $/extraData/,
        $/gasLimit/,
        $/gasUsed/,
        $/baseFeePerGas/,
        $/uncles/
      )
      ON CONFLICT DO NOTHING
    `,
    {
      hash: toBuffer(block.hash),
      number: Number(block.number),
      timestamp: Number(block.timestamp),
      parentHash: block?.parentHash ? toBuffer(block.parentHash) : null,
      nonce: block?.nonce ? toBuffer(block.nonce) : null,
      sha3Uncles: block?.sha3Uncles ? toBuffer(block.sha3Uncles) : null,
      logsBloom: block?.logsBloom ? toBuffer(block.logsBloom) : null,
      transactionsRoot: block?.transactionsRoot ? toBuffer(block.transactionsRoot) : null,
      stateRoot: block?.stateRoot ? toBuffer(block.stateRoot) : null,
      mixHash: block?.mixHash ? toBuffer(block.mixHash) : null,
      receiptsRoot: block?.receiptsRoot ? toBuffer(block.receiptsRoot) : null,
      miner: block?.miner ? toBuffer(block.miner) : null,
      difficulty: block?.difficulty ? toBuffer(block.difficulty) : null,
      totalDifficulty: block?.totalDifficulty ? toBuffer(block.totalDifficulty) : null,
      size: block.size ? Number(block.size) : null,
      extraData: block?.extraData ? toBuffer(block.extraData) : null,
      gasLimit: block.gasLimit ? Number(block.gasLimit) : null,
      gasUsed: block.gasUsed ? Number(block.gasUsed) : null,
      baseFeePerGas: block.baseFeePerGas ? Number(block.baseFeePerGas) : null,
      uncles: block.uncles.map(toBuffer),
    }
  );

  return block;
};

export const deleteBlock = async (number: number, hash: string) =>
  txdb.none(
    `
      DELETE FROM blocks
      WHERE blocks.hash = $/hash/
        AND blocks.number = $/number/
    `,
    {
      hash: toBuffer(hash),
      number,
    }
  );

export const getBlocks = async (number: number): Promise<Block[]> =>
  txdb
    .manyOrNone(
      `
        SELECT
          *
        FROM blocks
        WHERE blocks.number = $/number/
      `,
      { number }
    )
    .then((result) => {
      return result.map((block) => ({
        hash: fromBuffer(block.hash),
        number: block.number,
        timestamp: block.timestamp,
        parentHash: fromBuffer(block.parent_hash),
        nonce: fromBuffer(block.nonce),
        sha3Uncles: fromBuffer(block.sha3_uncles),
        logsBloom: fromBuffer(block.logs_bloom),
        transactionsRoot: fromBuffer(block.transactions_root),
        stateRoot: fromBuffer(block.state_root),
        mixHash: fromBuffer(block.mix_hash),
        receiptsRoot: fromBuffer(block.receipts_root),
        miner: fromBuffer(block.miner),
        difficulty: fromBuffer(block.difficulty),
        totalDifficulty: fromBuffer(block.total_difficulty),
        size: block.size,
        extraData: fromBuffer(block.extra_data),
        gasLimit: block.gas_limit,
        gasUsed: block.gas_used,
        baseFeePerGas: block.base_fee_per_gas,
        uncles: block.uncles.map(fromBuffer),
      }));
    });

export const getBlockWithNumber = async (
  number: number,
  hash: string
): Promise<{
  hash: string;
  number: number;
} | null> =>
  txdb
    .oneOrNone(
      `
        SELECT
          blocks.hash,
          blocks.timestamp
        FROM blocks
        WHERE blocks.number = $/number/
          AND blocks.hash != $/hash/
      `,
      {
        hash: toBuffer(hash),
        number,
      }
    )
    .then((result) => {
      if (!result) {
        return null;
      }

      return {
        hash: fromBuffer(result.hash),
        number,
      };
    });
