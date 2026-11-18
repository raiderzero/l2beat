import type {
  ChainBlockRecord,
  ChainHeadCursorRecord,
  Database,
} from '@l2beat/database'
import {
  type EVMBlockWithTransactions,
  NotFoundOnRpcError,
} from '@l2beat/shared'
import type { Log, UnixTime } from '@l2beat/shared-pure'
import { mockFn, mockObject } from 'earl'
import range from 'lodash/range'
import { mockDatabase } from '../../../test/database'
import type { HeadSource } from '../ChainHeadIndexer'

/**
 * A chain for tests that grows, reorganizes and is served as badly as real
 * RPCs serve one. Block `n` has hash `0x<n>`, or `0x<n>-<k>` once the k-th
 * reorg replaced it, and every block points at the hash of the one before it
 * on the chain as it is now
 */
export class FakeChain implements HeadSource {
  private replacedFrom: number[] = []
  private lagging = 0
  private readonly notServedOnce = new Set<number>()
  private readonly forkedOnce = new Set<number>()
  private readonly logsNotServedOnce = new Set<number>()
  /** By the hash of the block they are in, so a reorg takes them off the chain */
  private readonly emitted = new Map<string, Log[]>()

  constructor(
    public latest: number,
    /** Of block 0. Each block comes a second after the one before */
    private readonly genesis: UnixTime,
  ) {}

  getLatestBlockNumber = mockFn(async () => {
    const lagging = this.lagging
    this.lagging = 0
    return this.latest - lagging
  })

  getBlocks = mockFn(async (from: number, to: number) =>
    range(from, to + 1).map((number) => this.serve(number)),
  )

  getBlockHash = mockFn(async (number: number) => this.hashOf(number))

  getLogs = mockFn(async (blockHash: string, addresses: string[]) => {
    const number = range(0, this.latest + 1).find(
      (number) => this.hashOf(number) === blockHash,
    )
    // as a node answers for a block it does not have, or has no longer
    if (number === undefined || this.logsNotServedOnce.delete(number)) {
      throw new Error('Unknown block')
    }
    return (this.emitted.get(blockHash) ?? []).filter((log) =>
      addresses.includes(log.address),
    )
  })

  mine(count = 1) {
    this.latest += count
  }

  /** Adds a log to a block of the chain as it is now */
  emit(number: number, log: Pick<Log, 'address' | 'topics' | 'data'>) {
    const blockHash = this.hashOf(number)
    const logs = this.emitted.get(blockHash) ?? []
    logs.push({
      ...log,
      blockNumber: number,
      blockHash,
      transactionHash: `${blockHash}-tx${logs.length}`,
      logIndex: logs.length,
    })
    this.emitted.set(blockHash, logs)
  }

  /** The block's logs are asked of a node that does not have the block yet */
  failToServeLogsOnce(number: number) {
    this.logsNotServedOnce.add(number)
  }

  /** Replaces the blocks from `from` up, leaving the chain `latest` blocks long */
  reorg(from: number, latest = this.latest) {
    this.replacedFrom.push(from)
    this.latest = latest
  }

  /** The next answer for the latest block number comes from a node this many blocks behind */
  lagOnce(blocks: number) {
    this.lagging = blocks
  }

  /** The block is named as the latest before the answering node has it */
  failToServeOnce(number: number) {
    this.notServedOnce.add(number)
  }

  /** The block is served once by a node on another fork */
  serveFromForkOnce(number: number) {
    this.forkedOnce.add(number)
  }

  block(number: number): EVMBlockWithTransactions {
    return {
      number,
      hash: this.hashOf(number),
      parentHash: this.hashOf(number - 1),
      timestamp: this.genesis + number,
      logsBloom: '0x',
      gasUsed: 2_000_000,
      transactions: [],
    }
  }

  hashOf(number: number) {
    const reorgs = this.replacedFrom.filter((from) => number >= from).length
    return reorgs === 0 ? `0x${number}` : `0x${number}-${reorgs}`
  }

  fetched() {
    return this.getBlocks.calls.map((call) => call.args)
  }

  private serve(number: number): EVMBlockWithTransactions {
    if (number > this.latest || this.notServedOnce.delete(number)) {
      throw new NotFoundOnRpcError('Block not found')
    }
    const block = this.block(number)
    if (!this.forkedOnce.delete(number)) return block
    return { ...block, hash: `${block.hash}x`, parentHash: '0xother' }
  }
}

/** The `ChainBlock` table of one chain, in memory */
export class FakeChainBlocks {
  rows: ChainBlockRecord[]

  readonly repository = mockObject<Database['chainBlock']>({
    getNewest: async (_, limit) => this.rows.slice(-limit),
    getByNumberRange: async (_, from, to) =>
      this.rows.filter((r) => r.number >= from && r.number <= to),
    upsertMany: async (records) => {
      const numbers = new Set(records.map((r) => r.number))
      this.rows = [
        ...this.rows.filter((r) => !numbers.has(r.number)),
        ...records,
      ]
      this.rows.sort((a, b) => a.number - b.number)
      return records.length
    },
    findOldestSince: async (_, timestamp) =>
      this.rows.find((r) => r.timestamp >= timestamp),
    deleteAfter: async (_, number) => this.keep((r) => r.number <= number),
    deleteByChain: async () => this.keep(() => false),
    deleteBefore: async (_, timestamp) =>
      this.keep((r) => r.timestamp >= timestamp),
  })
  readonly db = mockDatabase({ chainBlock: this.repository })

  constructor(chain: string, blocks: EVMBlockWithTransactions[] = []) {
    this.rows = blocks.map((block) => ({
      chain,
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
    }))
  }

  numbers() {
    return this.rows.map((r) => r.number)
  }

  hashes() {
    return this.rows.map((r) => r.hash)
  }

  private keep(predicate: (row: ChainBlockRecord) => boolean) {
    const before = this.rows.length
    this.rows = this.rows.filter(predicate)
    return before - this.rows.length
  }
}

/** The `ChainHeadCursor` table, in memory */
export class FakeChainHeadCursors {
  rows = new Map<string, ChainHeadCursorRecord>()

  readonly repository = mockObject<Database['chainHeadCursor']>({
    findByIndexerId: async (indexerId) => this.rows.get(indexerId),
    upsert: async (record) => {
      this.rows.set(record.indexerId, record)
    },
    deleteByIndexerIds: async (indexerIds) =>
      indexerIds.filter((indexerId) => this.rows.delete(indexerId)).length,
  })
}

/** The `IndexerState` table, in memory: the heights UIF saves */
export class FakeIndexerStates {
  rows = new Map<string, { safeHeight: number; configHash?: string }>()

  readonly repository = mockObject<Database['indexerState']>({
    findByIndexerId: async (indexerId) => {
      const state = this.rows.get(indexerId)
      return state && { indexerId, ...state }
    },
    upsert: async (record) => {
      this.rows.set(record.indexerId, record)
    },
    updateSafeHeight: async (indexerId, safeHeight) => {
      this.rows.set(indexerId, { ...this.rows.get(indexerId), safeHeight })
      return 1
    },
  })
}
