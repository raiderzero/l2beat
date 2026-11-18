import type { Logger } from '@l2beat/backend-tools'
import type {
  ChainBlockRecord,
  ChainHeadCursorRecord,
  Database,
} from '@l2beat/database'
import { UnixTime } from '@l2beat/shared-pure'
import { Indexer } from '@l2beat/uif'
import { createIndexerId } from '../../tools/uif/indexerIdentity'
import {
  ManagedChildIndexer,
  type ManagedChildIndexerOptions,
} from '../../tools/uif/ManagedChildIndexer'
import type { ChainHeadIndexer } from './ChainHeadIndexer'

const CLEAN_EVERY = 10 * UnixTime.MINUTE

export interface HeadReaderIndexerOptions
  extends Omit<
    ManagedChildIndexerOptions,
    'parents' | 'minHeight' | 'updateRetryStrategy' | 'invalidateRetryStrategy'
  > {
  chain: string
  head: ChainHeadIndexer
  /** Blocks read in one update */
  batchSize: number
  /** Seconds. What was derived from older blocks is deleted */
  keepFor: number
  db: Database
}

/**
 * An indexer that derives rows from a chain's newest blocks, for one chain
 * and one height. It keeps the rows of the last `keepFor` seconds, and they
 * are always from the chain the head follows: its cursor names the block it
 * stopped at, and whatever it derived is deleted and derived again once the
 * head no longer has that block.
 *
 * The cursor is the promise to whoever reads the rows: everything from block
 * `sinceNumber` up to block `number` is there. Rows and cursor change in one
 * transaction, so a reader that takes both in one snapshot never sees more
 * promised than stored.
 *
 * Not for an indexer with several configurations of different heights. Those
 * stay under the clock, and one of these adds the newest blocks on top
 */
export abstract class HeadReaderIndexer extends ManagedChildIndexer {
  private readonly cursorId: string
  /** The cursor was on the head at some point since the process started */
  private followed = false
  private cleanedAt = 0

  constructor(
    private readonly reader: HeadReaderIndexerOptions,
    logger: Logger,
  ) {
    super(
      {
        ...reader,
        parents: [reader.head],
        minHeight: 0,
        updateRetryStrategy: Indexer.getLiveRetryStrategy(),
        invalidateRetryStrategy: Indexer.getLiveRetryStrategy(),
      },
      logger,
    )
    this.cursorId = createIndexerId(reader.name, reader.tags?.tag)
  }

  /**
   * Derives the rows of the blocks, both ends included. Every block is one
   * the head has stored. Returns what saves them; it runs in a transaction,
   * after the rows of these blocks and above were deleted
   */
  protected abstract read(
    from: number,
    to: number,
  ): Promise<() => Promise<void>>
  /** Deletes what was derived from the blocks above the number */
  protected abstract deleteAfter(number: number): Promise<number>
  /** Deletes what was derived from the blocks older than the timestamp */
  protected abstract deleteBefore(timestamp: UnixTime): Promise<number>

  override async update(from: number, to: number): Promise<number> {
    await this.clean()

    const cursor = await this.getCursor()
    const continues =
      cursor !== undefined &&
      // behind the height only if the cursor was written by something else
      cursor.number >= from - 1 &&
      cursor.timestamp >= this.oldestKept() &&
      (await this.isOnHead(cursor))
    // Otherwise it is the first run, the rows are too old to add to, or the
    // head left the block the indexer stopped at without lowering its
    // height: it restarted, or the process died between the head dropping
    // blocks and this indexer hearing of it. Nothing tells which rows are
    // still right, so all are derived again from the blocks the head has now
    const start = continues ? from : await this.findOldestKept()
    // a chain with no block fresh enough to keep
    if (start === undefined || start > to) {
      await this.forget()
      return to
    }

    let end = Math.min(start + this.reader.batchSize - 1, to)
    // UIF takes the height right below the update's for neither syncing
    // nor invalidating
    if (end === from - 1) end = from
    const blocks = await this.reader.db.chainBlock.getByNumberRange(
      this.reader.chain,
      start,
      end,
    )
    if (blocks.length !== end - start + 1) {
      throw new Error('Blocks to read are not stored by the chain head', {
        cause: { chain: this.reader.chain, start, end, stored: blocks.length },
      })
    }

    const save = await this.read(start, end)
    const first = blocks[0]
    const last = blocks[blocks.length - 1]
    await this.reader.db.transaction(async () => {
      await this.deleteAfter(continues ? start - 1 : -1)
      await save()
      await this.reader.db.chainHeadCursor.upsert({
        indexerId: this.cursorId,
        chain: this.reader.chain,
        sinceNumber: continues ? cursor.sinceNumber : first.number,
        sinceTimestamp: continues ? cursor.sinceTimestamp : first.timestamp,
        number: last.number,
        hash: last.hash,
        timestamp: last.timestamp,
      })
    })
    if (!continues) {
      this.logger.info('Started over from the blocks the chain head has', {
        start,
        previous: cursor?.number,
      })
    }
    this.followed = true
    return end
  }

  /**
   * The chain no longer has the blocks above the height. UIF also calls this
   * with the indexer's own height at every start and after a failed update,
   * when there is nothing to delete
   */
  override async invalidate(targetHeight: number): Promise<number> {
    const cursor = await this.getCursor()
    if (cursor === undefined || cursor.number <= targetHeight) {
      return targetHeight
    }

    const [block] = await this.reader.db.chainBlock.getByNumberRange(
      this.reader.chain,
      targetHeight,
      targetHeight,
    )
    // The head lowering its height says its block there is the one this
    // indexer read. A height from before the process started says nothing:
    // the head may have dropped blocks then, with the notice lost
    const sameChain = this.followed || (await this.isOnHead(cursor))
    if (
      !sameChain ||
      block === undefined ||
      block.number < cursor.sinceNumber
    ) {
      await this.forget()
      return targetHeight
    }

    const deleted = await this.reader.db.transaction(async () => {
      const deleted = await this.deleteAfter(targetHeight)
      await this.reader.db.chainHeadCursor.upsert({
        ...cursor,
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
      })
      return deleted
    })
    this.logger.info('Deleted what the chain no longer has', {
      after: targetHeight,
      deleted,
    })
    return targetHeight
  }

  private getCursor(): Promise<ChainHeadCursorRecord | undefined> {
    return this.reader.db.chainHeadCursor.findByIndexerId(this.cursorId)
  }

  /** Whether the head has stored this very block, so that it can serve the ones after it */
  private async isOnHead(
    block: Pick<ChainBlockRecord, 'number' | 'hash'>,
  ): Promise<boolean> {
    const [onHead] = await this.reader.db.chainBlock.getByNumberRange(
      this.reader.chain,
      block.number,
      block.number,
    )
    return onHead?.hash === block.hash
  }

  private oldestKept(): UnixTime {
    return UnixTime.now() - this.reader.keepFor
  }

  /** The oldest block worth reading that the head has. None on a chain with no block that fresh */
  private async findOldestKept(): Promise<number | undefined> {
    const oldest = await this.reader.db.chainBlock.findOldestSince(
      this.reader.chain,
      this.oldestKept(),
    )
    return oldest?.number
  }

  private async forget() {
    const deleted = await this.reader.db.transaction(async () => {
      await this.reader.db.chainHeadCursor.deleteByIndexerIds([this.cursorId])
      return await this.deleteAfter(-1)
    })
    if (deleted > 0) {
      this.logger.info('Deleted everything, to start over', { deleted })
    }
  }

  /**
   * Deletes what is older than is kept, and moves the cursor's start up to
   * the oldest block still covered, so that it never promises deleted rows
   */
  private async clean() {
    const now = UnixTime.now()
    if (now - this.cleanedAt < CLEAN_EVERY) return

    const oldestKept = this.oldestKept()
    const [cursor, oldest] = await Promise.all([
      this.getCursor(),
      this.reader.db.chainBlock.findOldestSince(this.reader.chain, oldestKept),
    ])
    const deleted = await this.reader.db.transaction(async () => {
      if (cursor !== undefined && cursor.sinceTimestamp < oldestKept) {
        if (oldest !== undefined && oldest.number <= cursor.number) {
          await this.reader.db.chainHeadCursor.upsert({
            ...cursor,
            sinceNumber: oldest.number,
            sinceTimestamp: oldest.timestamp,
          })
        } else {
          // nothing it covers is kept
          await this.reader.db.chainHeadCursor.deleteByIndexerIds([
            this.cursorId,
          ])
        }
      }
      return await this.deleteBefore(oldestKept)
    })
    this.cleanedAt = now
    this.logger.info('Deleted what is older than kept', { deleted })
  }
}
