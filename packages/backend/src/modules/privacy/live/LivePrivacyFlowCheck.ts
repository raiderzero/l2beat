import type { Logger } from '@l2beat/backend-tools'
import type { Database, PrivacyFlowEventRecord } from '@l2beat/database'
import {
  createIndexerId,
  INDEXER_NAMES,
} from '../../../tools/uif/indexerIdentity'
import { resolvePrivacyBlockRange } from '../utils/privacyLogIndexerUtils'

type Flow = Pick<
  PrivacyFlowEventRecord,
  'configurationId' | 'txHash' | 'logIndex' | 'count' | 'amount'
>

/**
 * Compares the flows the hourly indexer has just stored with the ones stored
 * block by block for the same blocks. The two read the chain on their own, an
 * hour or more apart, so a difference means the live flows cannot be shown
 * on top of the hourly ones as they are
 */
export class LivePrivacyFlowCheck {
  constructor(
    private readonly $: { chain: string; db: Database },
    private readonly logger: Logger,
  ) {
    this.logger = logger.for(this).tag({ tag: $.chain, chain: $.chain })
  }

  /**
   * `sealed` are all the flows of these configurations in the hours, both
   * ends as the hourly indexer takes them. Never fails: the hours are stored
   * whatever the newest blocks say
   */
  async run(
    configurationIds: string[],
    from: number,
    to: number,
    sealed: Flow[],
  ): Promise<void> {
    try {
      const live = await this.getLive(configurationIds, from, to)
      if (live === undefined) return

      const difference = compare(sealed, live.flows)
      const range = {
        from,
        to,
        blockFrom: live.blockFrom,
        blockTo: live.blockTo,
      }
      if (difference.total === 0) {
        this.logger.info('Live flows match the hourly ones', {
          ...range,
          flows: sealed.length,
        })
      } else {
        this.logger.error('Live flows differ from the hourly ones', {
          ...range,
          ...difference,
        })
      }
    } catch (error) {
      this.logger.warn('Live flows could not be compared', { from, to, error })
    }
  }

  /** Undefined when the newest blocks stored do not cover every block of the hours */
  private async getLive(configurationIds: string[], from: number, to: number) {
    const { blockFrom, blockTo } = await resolvePrivacyBlockRange(
      this.$.db.privacyBlockTimestamp,
      this.$.chain,
      from,
      to,
    )
    // one snapshot, or the cursor could promise blocks whose flows the
    // second query no longer finds
    return await this.$.db.transaction(async () => {
      const cursor = await this.$.db.chainHeadCursor.findByIndexerId(
        createIndexerId(INDEXER_NAMES.LIVE_PRIVACY_FLOW, this.$.chain),
      )
      if (
        cursor === undefined ||
        cursor.sinceNumber > blockFrom ||
        cursor.number < blockTo
      ) {
        return undefined
      }
      const ids = new Set(configurationIds)
      const flows = await this.$.db.livePrivacyFlowEvent.getByChainInBlockRange(
        this.$.chain,
        blockFrom,
        blockTo,
      )
      return {
        blockFrom,
        blockTo,
        flows: flows.filter((flow) => ids.has(flow.configurationId)),
      }
    }, 'repeatable read')
  }
}

function compare(sealed: Flow[], live: Flow[]) {
  const liveByKey = new Map(live.map((flow) => [key(flow), flow]))
  const sealedKeys = new Set(sealed.map(key))

  const missing = sealed.filter((flow) => !liveByKey.has(key(flow)))
  const extra = live.filter((flow) => !sealedKeys.has(key(flow)))
  const changed = sealed.filter((flow) => {
    const other = liveByKey.get(key(flow))
    return (
      other !== undefined &&
      (other.count !== flow.count || other.amount !== flow.amount)
    )
  })

  return {
    total: missing.length + extra.length + changed.length,
    /** Stored for the hours, not for the newest blocks */
    missing: missing.length,
    /** Stored for the newest blocks, not for the hours */
    extra: extra.length,
    /** Stored by both, with another count or amount */
    changed: changed.length,
    examples: [...missing, ...extra, ...changed].slice(0, 5).map(key),
  }
}

function key(flow: Flow) {
  return `${flow.configurationId}:${flow.txHash}:${flow.logIndex}`
}
