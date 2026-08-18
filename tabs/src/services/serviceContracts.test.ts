import { parseAutomationsStats } from './automationsStatsService';
import { parseReportsData } from './reportsService';
import { parseWebhookKeys } from './webhookKeysService';

describe('service response contracts', () => {
  test('rejects malformed reports instead of passing undefined series to charts', () => {
    expect(() => parseReportsData({})).toThrow(
      'Reports response is malformed.',
    );
    expect(() =>
      parseReportsData({
        weeks: 2,
        zapsWeekly: [10],
        automationWeekly: [5, 8],
        totalZapSats: 10,
        totalZapCount: 1,
        totalAutomatedSats: 13,
        totalAutomatedCount: 2,
      }),
    ).toThrow('Reports response is malformed.');
  });

  test('rejects missing automation arrays before rendering filters', () => {
    expect(() => parseAutomationsStats({})).toThrow(
      'Automations stats response is malformed.',
    );
  });

  test('rejects a webhook response without a keys array', () => {
    expect(() => parseWebhookKeys({})).toThrow(
      'Webhook keys response is malformed.',
    );
  });
});
