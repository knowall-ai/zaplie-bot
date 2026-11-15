// Only members of the bot's own tenant are set up or answered. An install
// "for everyone" also reaches the tenant's guests, who must get no LNbits
// account, no reply and no error message.
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { TeamsInfo } from 'botbuilder';
import type { TurnContext } from 'botbuilder';
import { FetchUserMiddleware } from './fetchUserMiddleware';
import { UserService } from './userService';
import { memberVerdict, parseGuestAllowlist } from './memberGate';

const HOME = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const originalTenant = process.env.AAD_APP_TENANT_ID;

const makeContext = (activity: Record<string, unknown>) =>
  ({
    activity,
    turnState: new Map<string, unknown>(),
    sendActivity: jest.fn(),
  }) as unknown as TurnContext & { sendActivity: jest.Mock };

const run = async (member: Record<string, unknown> | Error) => {
  const getMember = jest.spyOn(TeamsInfo, 'getMember');
  if (member instanceof Error) {
    getMember.mockRejectedValue(member);
  } else {
    getMember.mockResolvedValue(member as never);
  }
  const ensureUserSetup = jest
    .spyOn(UserService.prototype, 'ensureUserSetup')
    .mockResolvedValue({ id: 'lnbits-user' } as never);
  const next = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  // An install event is a conversationUpdate from the person it was installed for.
  const context = makeContext({
    type: 'conversationUpdate',
    from: { id: '29:someone', aadObjectId: 'aad-someone' },
  });
  await new FetchUserMiddleware(UserService.getInstance()).onTurn(
    context,
    next,
  );
  return { ensureUserSetup, next, context };
};

beforeEach(() => {
  process.env.AAD_APP_TENANT_ID = HOME;
  delete process.env.ZAPLIE_GUEST_ALLOWLIST;
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalTenant === undefined) {
    delete process.env.AAD_APP_TENANT_ID;
  } else {
    process.env.AAD_APP_TENANT_ID = originalTenant;
  }
});

describe('FetchUserMiddleware serves members of its own tenant only', () => {
  test('a member of the home tenant is set up and the turn continues', async () => {
    const { ensureUserSetup, next, context } = await run({
      id: '29:someone',
      userRole: 'user',
      tenantId: HOME,
    });
    expect(ensureUserSetup).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(context.turnState.get('user')).toEqual({ id: 'lnbits-user' });
  });

  test.each([
    ['a guest of the home tenant', { userRole: 'guest', tenantId: HOME }],
    [
      'an anonymous meeting participant',
      { userRole: 'anonymous', tenantId: HOME },
    ],
    ['a member of another tenant', { userRole: 'user', tenantId: OTHER }],
    ['a member with no role reported', { tenantId: HOME }],
    ['a member with no tenant reported', { userRole: 'user' }],
  ])(
    '%s gets no LNbits account, no reply and no error',
    async (_label, fields) => {
      const { ensureUserSetup, next, context } = await run({
        id: '29:someone',
        ...fields,
      });
      expect(ensureUserSetup).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(context.sendActivity).not.toHaveBeenCalled();
      expect(context.turnState.get('user')).toBeUndefined();
    },
  );

  test('a sender Teams cannot resolve ends the turn quietly, without an apology', async () => {
    const { ensureUserSetup, next, context } = await run(
      new Error('Member not found'),
    );
    expect(ensureUserSetup).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(context.sendActivity).not.toHaveBeenCalled();
  });

  test('a guest is refused even when the role differs only in case or spacing', async () => {
    const { ensureUserSetup } = await run({
      id: '29:x',
      userRole: ' Guest ',
      tenantId: HOME,
    });
    expect(ensureUserSetup).not.toHaveBeenCalled();
  });
});

describe('a guest the organisation lets in (ZAPLIE_GUEST_ALLOWLIST)', () => {
  test('is set up like a member once listed', async () => {
    process.env.ZAPLIE_GUEST_ALLOWLIST = 'thomas@client.example';
    const { ensureUserSetup, next } = await run({
      id: '29:thomas',
      userRole: 'guest',
      tenantId: HOME,
      email: 'Thomas@Client.example',
    });
    expect(ensureUserSetup).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('memberVerdict', () => {
  const none = parseGuestAllowlist('');

  test('matches the tenant id case-insensitively', () => {
    expect(
      memberVerdict(
        { userRole: 'user', tenantId: HOME.toUpperCase() },
        HOME,
        none,
      ),
    ).toEqual({ allowed: true, via: 'member' });
  });

  test('refuses everyone when the bot has no home tenant configured', () => {
    expect(
      memberVerdict({ userRole: 'user', tenantId: HOME }, '', none),
    ).toEqual({
      allowed: false,
      reason: 'no_tenant_configured',
    });
  });

  test.each([
    [{ userRole: 'guest', tenantId: HOME }, 'guest'],
    [{ userRole: 'anonymous', tenantId: HOME }, 'anonymous'],
    [{ userRole: 'user', tenantId: OTHER }, 'other_tenant'],
    [{ tenantId: HOME }, 'not_a_member'],
    [null, 'not_a_member'],
  ])('%j is refused as %s by default', (member, reason) => {
    expect(memberVerdict(member, HOME, none)).toEqual({
      allowed: false,
      reason,
    });
  });

  test.each([
    [
      'a person by email',
      'thomas@client.example',
      { email: 'thomas@client.example' },
    ],
    ['a whole domain', '@client.example', { email: 'anne@client.example' }],
    [
      'an Entra object id',
      '0a1b2c3d-0000-4000-8000-00000000abcd',
      { aadObjectId: '0A1B2C3D-0000-4000-8000-00000000ABCD' },
    ],
  ])('lets a guest in by %s', (_label, raw, fields) => {
    expect(
      memberVerdict(
        { userRole: 'guest', tenantId: HOME, ...fields },
        HOME,
        parseGuestAllowlist(raw),
      ),
    ).toEqual({ allowed: true, via: 'allowlist' });
  });

  test('lets a listed user from another tenant in, but not an unlisted one', () => {
    const list = parseGuestAllowlist('@partner.example');
    expect(
      memberVerdict(
        { userRole: 'user', tenantId: OTHER, email: 'a@partner.example' },
        HOME,
        list,
      ),
    ).toEqual({ allowed: true, via: 'allowlist' });
    expect(
      memberVerdict(
        { userRole: 'user', tenantId: OTHER, email: 'a@else.example' },
        HOME,
        list,
      ),
    ).toEqual({ allowed: false, reason: 'other_tenant' });
  });

  test('a guest not on the list is still refused', () => {
    expect(
      memberVerdict(
        { userRole: 'guest', tenantId: HOME, email: 'someone@other.example' },
        HOME,
        parseGuestAllowlist('thomas@client.example, @partner.example'),
      ),
    ).toEqual({ allowed: false, reason: 'guest' });
  });

  test('an anonymous participant is never let in, even when its email is listed', () => {
    expect(
      memberVerdict(
        { userRole: 'anonymous', email: 'thomas@client.example' },
        HOME,
        parseGuestAllowlist('thomas@client.example'),
      ),
    ).toEqual({ allowed: false, reason: 'anonymous' });
  });

  test('parses entries case-insensitively and ignores blanks and spacing', () => {
    const list = parseGuestAllowlist(
      ' Thomas@Client.example ,, @Partner.Example ,ABC-1 ',
    );
    expect([...list.emails]).toEqual(['thomas@client.example']);
    expect([...list.domains]).toEqual(['partner.example']);
    expect([...list.ids]).toEqual(['abc-1']);
  });

  test('a lone "@" is not a domain that matches everyone', () => {
    expect([...parseGuestAllowlist('@').domains]).toEqual([]);
  });
});
