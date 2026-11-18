import type { Logger } from '@l2beat/backend-tools'
import type {
  ChainHeadCursorRecord,
  Database,
  LivePrivacyFlowEventRecord,
} from '@l2beat/database'
import { UnixTime } from '@l2beat/shared-pure'
import { expect, mockFn, mockObject } from 'earl'
import { mockDatabase } from '../../../test/database'
import { LivePrivacyFlowCheck } from './LivePrivacyFlowCheck'

/**
 * Methodology: the hours 10:00 to 11:00 are blocks 100 to 200. The check
 * answers through its log lines only, so they are what the tests read
 */
const FROM = UnixTime.fromDate(new Date('2026-11-18T10:00:00Z'))
const TO = FROM + UnixTime.HOUR

describe(LivePrivacyFlowCheck.name, () => {
  it('reports a match when the newest blocks hold the flows of the hours', async () => {
    const { check, logged } = setup({
      cursor: cursor(100, 250),
      live: [flow('a', 100), flow('a', 200)],
    })

    await check.run(['a'], FROM, TO, [flow('a', 100), flow('a', 200)])

    expect(logged()).toEqual([
      [
        'info',
        'Live flows match the hourly ones',
        { from: FROM, to: TO, blockFrom: 100, blockTo: 200, flows: 2 },
      ],
    ])
  })

  it('reports each flow only one of them has, and each stored with another count or amount', async () => {
    const { check, logged } = setup({
      cursor: cursor(100, 250),
      live: [
        flow('a', 120),
        { ...flow('a', 130), amount: 999n },
        { ...flow('a', 140), count: 0 },
        flow('a', 150),
      ],
    })

    await check.run(['a'], FROM, TO, [
      flow('a', 110),
      flow('a', 130),
      flow('a', 140),
      flow('a', 150),
    ])

    expect(logged()).toEqual([
      [
        'error',
        'Live flows differ from the hourly ones',
        {
          from: FROM,
          to: TO,
          blockFrom: 100,
          blockTo: 200,
          total: 4,
          missing: 1,
          extra: 1,
          changed: 2,
          examples: [
            'a:0xtx110:0',
            'a:0xtx120:0',
            'a:0xtx130:0',
            'a:0xtx140:0',
          ],
        },
      ],
    ])
  })

  it('leaves out the flows of configurations the hours were not stored for', async () => {
    const { check, logged } = setup({
      cursor: cursor(100, 250),
      live: [flow('a', 100), flow('still catching up', 150)],
    })

    await check.run(['a'], FROM, TO, [flow('a', 100)])

    expect(logged().map(([level]) => level)).toEqual(['info'])
  })

  for (const [name, stored] of [
    ['start after the first block of the hours', cursor(101, 250)],
    ['end before the last block of the hours', cursor(100, 199)],
    ['were never stored', undefined],
  ] as const) {
    it(`says nothing when the newest blocks ${name}`, async () => {
      const { check, logged } = setup({ cursor: stored, live: [] })

      await check.run(['a'], FROM, TO, [flow('a', 150)])

      expect(logged()).toEqual([])
    })
  }

  it('does not fail the hours when the comparison cannot be made', async () => {
    const { check, logged } = setup({
      cursor: cursor(100, 250),
      live: [],
      fail: new Error('Connection lost'),
    })

    await check.run(['a'], FROM, TO, [])

    expect(logged().map(([level, message]) => [level, message])).toEqual([
      ['warn', 'Live flows could not be compared'],
    ])
  })

  function setup(stored: {
    cursor: ChainHeadCursorRecord | undefined
    live: LivePrivacyFlowEventRecord[]
    fail?: Error
  }) {
    const lines: unknown[][] = []
    const log = (level: string) =>
      mockFn((...args: unknown[]) => {
        lines.push([level, ...args])
      })
    const logger: Logger = mockObject<Logger>({
      for: () => logger,
      tag: () => logger,
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    })

    const db = mockDatabase({
      privacyBlockTimestamp: mockObject<Database['privacyBlockTimestamp']>({
        findBlockNumberByChainAndTimestamp: async (_, timestamp) =>
          timestamp === FROM ? 100 : 200,
      }),
      chainHeadCursor: mockObject<Database['chainHeadCursor']>({
        findByIndexerId: async (indexerId) =>
          indexerId === 'live_privacy_flow::ethereum'
            ? stored.cursor
            : undefined,
      }),
      livePrivacyFlowEvent: mockObject<Database['livePrivacyFlowEvent']>({
        getByChainInBlockRange: async (_, from, to) => {
          if (stored.fail) throw stored.fail
          return stored.live.filter(
            (f) => f.blockNumber >= from && f.blockNumber <= to,
          )
        },
      }),
    })

    return {
      check: new LivePrivacyFlowCheck({ chain: 'ethereum', db }, logger),
      logged: () => lines,
    }
  }
})

function cursor(sinceNumber: number, number: number): ChainHeadCursorRecord {
  return {
    indexerId: 'live_privacy_flow::ethereum',
    chain: 'ethereum',
    sinceNumber,
    sinceTimestamp: FROM,
    number,
    hash: `0x${number}`,
    timestamp: TO,
  }
}

function flow(
  configurationId: string,
  blockNumber: number,
): LivePrivacyFlowEventRecord {
  return {
    configurationId,
    projectId: 'project',
    bucketId: 'bucket',
    chain: 'ethereum',
    direction: 'deposit',
    timestamp: FROM + blockNumber,
    blockNumber,
    blockHash: `0x${blockNumber}`,
    txHash: `0xtx${blockNumber}`,
    logIndex: 0,
    count: 1,
    amount: 100n,
  }
}
