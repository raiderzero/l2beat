import type { Logger } from '@l2beat/backend-tools'
import type { Database } from '@l2beat/database'
import type { IRpcClient } from '@l2beat/shared'
import { hashJson } from '@l2beat/shared'
import { UnixTime } from '@l2beat/shared-pure'
import type { IndexerService } from '../../../tools/uif/IndexerService'
import { INDEXER_NAMES } from '../../../tools/uif/indexerIdentity'
import type { Configuration } from '../../../tools/uif/multi/types'
import type { ChainHeadIndexer } from '../../chain-head/ChainHeadIndexer'
import { HeadReaderIndexer } from '../../chain-head/HeadReaderIndexer'
import type { PrivacyFlowIndexerConfig } from '../types'
import { extractPrivacyFlows } from '../utils/extractPrivacyFlows'
import {
  matchPrivacyLogs,
  queryPrivacyLogs,
} from '../utils/privacyLogIndexerUtils'
import { ReceiptLogCache } from '../utils/ReceiptLogCache'

/**
 * The hourly indexer stores an hour an hour after it ends, so it reads flows
 * up to two hours old. The rest leaves it time to catch up while the newest
 * blocks still cover what it has not stored
 */
export const LIVE_PRIVACY_FLOWS_KEPT_FOR = 4 * UnixTime.HOUR
/** Blocks an update reads. Each block's logs are asked for on their own */
export const LIVE_PRIVACY_FLOWS_BATCH_SIZE = 100

export interface LivePrivacyFlowIndexerDependencies {
  chain: string
  head: ChainHeadIndexer
  configurations: PrivacyFlowIndexerConfig[]
  /** For the receipts and transactions some flows are read from */
  rpcClient: IRpcClient
  indexerService: IndexerService
  db: Database
}

/**
 * Stores a chain's privacy deposits and withdrawals as soon as the chain head
 * has their block, for every flow configuration of the chain at once. The
 * flows are extracted as the hourly indexer extracts them. They carry no USD
 * value: the price of an hour is known only once the hour has passed
 */
export class LivePrivacyFlowIndexer extends HeadReaderIndexer {
  private readonly configurations: Configuration<PrivacyFlowIndexerConfig>[]

  constructor(
    private readonly $: LivePrivacyFlowIndexerDependencies,
    logger: Logger,
  ) {
    super(
      {
        chain: $.chain,
        head: $.head,
        indexerService: $.indexerService,
        db: $.db,
        name: INDEXER_NAMES.LIVE_PRIVACY_FLOW,
        tags: { tag: $.chain, chain: $.chain },
        // a flow's id is made of everything its extraction depends on
        configHash: hashJson($.configurations.map((c) => c.id).sort()),
        batchSize: LIVE_PRIVACY_FLOWS_BATCH_SIZE,
        keepFor: LIVE_PRIVACY_FLOWS_KEPT_FOR,
      },
      logger,
    )
    this.configurations = $.configurations.map((properties) => ({
      id: properties.id,
      properties,
      minHeight: properties.sinceTimestamp,
      maxHeight: null,
    }))
  }

  protected override async read(from: number, to: number) {
    const groups = await queryPrivacyLogs(
      this.configurations,
      (addresses, topics) => this.$.head.getLogs(from, to, addresses, topics),
    )
    const logs = groups.flatMap((group) => group.logs)
    const timestamps = new Map(
      logs.map((log) => [log.blockNumber, log.blockTimestamp]),
    )
    const matches = groups
      .flatMap((group) =>
        matchPrivacyLogs(group.configurations, group.logs, timestamps),
      )
      .filter(
        (match) =>
          match.timestamp >= match.configuration.properties.sinceTimestamp,
      )

    const readBlocks = new Set(logs.map((log) => log.blockHash))
    const flows = await extractPrivacyFlows(
      matches,
      this.$.rpcClient,
      new ReceiptLogCache(
        this.$.rpcClient,
        (blockHash) => blockHash !== undefined && readBlocks.has(blockHash),
      ),
    )

    return async () => {
      await this.$.db.livePrivacyFlowEvent.upsertMany(
        flows.map(({ configuration, log, timestamp, count, amount }) => ({
          configurationId: configuration.id,
          projectId: configuration.properties.projectId,
          bucketId: configuration.properties.bucketId,
          chain: this.$.chain,
          direction: configuration.properties.direction,
          timestamp,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          count,
          amount,
        })),
      )
    }
  }

  protected override deleteAfter(number: number): Promise<number> {
    return this.$.db.livePrivacyFlowEvent.deleteByChainAfter(
      this.$.chain,
      number,
    )
  }

  protected override deleteBefore(timestamp: UnixTime): Promise<number> {
    return this.$.db.livePrivacyFlowEvent.deleteByChainBefore(
      this.$.chain,
      timestamp,
    )
  }
}
