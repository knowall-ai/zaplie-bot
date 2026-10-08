// pulse.test.ts
//
// The agent-pulse library is mocked: these tests pin which AgentActivity
// events Zaplie emits and that a failing library never reaches the caller.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';

import {
  DEFAULT_AGENT_ID,
  commandSubject,
  pulseSettled,
  recordActivity,
  recordRewardOutcome,
  recordZapOutcome,
  resetPulseForTests,
} from './pulse';

const mockEmit = jest.fn<(event: unknown) => Promise<void>>();
const mockCreatePulse = jest.fn((_options: unknown) => ({
  emit: mockEmit,
  flush: async () => undefined,
}));
type Load = NonNullable<Parameters<typeof resetPulseForTests>[0]>;
const library = {
  createPulse: mockCreatePulse,
  activityIdFrom: (id: string) => `sha256:${id}`,
} as unknown as Awaited<ReturnType<Load>>;

const emitted = () =>
  mockEmit.mock.calls.map(([event]) => event as Record<string, unknown>);

describe('agent-pulse wrapper', () => {
  const savedAgentId = process.env.AGENT_ID;
  const savedConnection = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

  beforeEach(() => {
    resetPulseForTests(async () => library);
    mockEmit.mockResolvedValue(undefined);
    delete process.env.AGENT_ID;
    process.env.APPLICATIONINSIGHTS_CONNECTION_STRING =
      'InstrumentationKey=test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = savedAgentId;
    if (savedConnection === undefined)
      delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
    else process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = savedConnection;
  });

  test('defaults the agent id to zaplie and reads the connection string', async () => {
    recordZapOutcome('paid', 'ledger-key', 10);
    await pulseSettled();

    expect(DEFAULT_AGENT_ID).toBe('zaplie');
    expect(mockCreatePulse).toHaveBeenCalledWith({
      connectionString: 'InstrumentationKey=test',
      agentId: 'zaplie',
    });
  });

  test('takes the agent id from AGENT_ID, so test deploys report as zaplie-test', async () => {
    process.env.AGENT_ID = 'zaplie-test';

    recordZapOutcome('paid', 'ledger-key', 10);
    await pulseSettled();

    expect(mockCreatePulse).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'zaplie-test' }),
    );
  });

  test('builds the pulse once', async () => {
    recordZapOutcome('paid', 'a', 1);
    recordZapOutcome('paid', 'b', 1);
    await pulseSettled();

    expect(mockCreatePulse).toHaveBeenCalledTimes(1);
  });

  test('a paid zap is zap.sent with the amount as a sats measurement and a hashed id', async () => {
    recordZapOutcome('paid', 'tenant|conv|card|recipient', 21);
    await pulseSettled();

    expect(emitted()).toEqual([
      {
        activityType: 'zap.sent',
        title: 'Sent a zap · teams',
        level: 'success',
        subject: 'teams',
        channel: 'teams',
        activityId: 'sha256:tenant|conv|card|recipient',
        measurements: { sats: 21 },
      },
    ]);
  });

  test('a failed zap is a zap.failed error; an unconfirmed one is a warning', async () => {
    recordZapOutcome('failed', 'k1', 5);
    recordZapOutcome('needs-checking', 'k2', 5);
    await pulseSettled();

    const [failed, unknown] = emitted();
    expect(failed).toMatchObject({
      activityType: 'zap.failed',
      level: 'error',
      subject: 'before-payment',
      measurements: { sats: 5 },
    });
    expect(unknown).toMatchObject({
      activityType: 'zap.failed',
      level: 'warning',
      subject: 'outcome-unknown',
    });
  });

  test('automation rewards record sent, queued and failed on the api channel', async () => {
    recordRewardOutcome({ status: 'paid', paymentHash: 'hash-1', sats: 100 });
    recordRewardOutcome({ status: 'pending', requestKey: 'req-1', sats: 50 });
    recordRewardOutcome({ status: 'failed', requestKey: 'req-2' });
    await pulseSettled();

    expect(emitted()).toEqual([
      expect.objectContaining({
        activityType: 'zap.sent',
        subject: 'automation',
        channel: 'api',
        activityId: 'sha256:hash-1',
        measurements: { sats: 100 },
      }),
      expect.objectContaining({
        activityType: 'zap.queued',
        level: 'info',
        channel: 'api',
        measurements: { sats: 50 },
      }),
      expect.objectContaining({
        activityType: 'zap.failed',
        level: 'error',
        channel: 'api',
      }),
    ]);
  });

  test('a throwing library is logged and never reaches the caller', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockEmit.mockImplementationOnce(() => {
      throw new Error('telemetry down');
    });

    expect(() =>
      recordActivity({
        activityType: 'chat.answered',
        title: 'Answered question · assistant',
        level: 'success',
        channel: 'teams',
        upstreamId: 'msg-1',
      }),
    ).not.toThrow();
    await pulseSettled();
    expect(warn).toHaveBeenCalled();
  });

  test('a library that cannot even be created is harmless', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockCreatePulse.mockImplementationOnce(() => {
      throw new Error('bad connection string');
    });

    expect(() => recordZapOutcome('paid', 'k', 1)).not.toThrow();
    await expect(pulseSettled()).resolves.toBeUndefined();
  });

  test('a library that fails to load is harmless', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    resetPulseForTests(() => Promise.reject(new Error('module not found')));

    expect(() => recordZapOutcome('paid', 'k', 1)).not.toThrow();
    await pulseSettled();
    expect(warn).toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('without a connection string nothing is loaded or sent', async () => {
    delete process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    recordZapOutcome('paid', 'k', 1);
    await pulseSettled();

    expect(mockCreatePulse).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('command names become fixed kebab-case subjects', async () => {
    expect(commandSubject('send zap')).toBe('send-zap');
    expect(commandSubject('show  my balance')).toBe('show-my-balance');
  });
});
