import { BotCredentialsError, resolveBotCredentials } from './botCredentials';

const valid = {
  BOT_ID: 'fa233b8e-51c1-44dd-9913-95304352e193',
  BOT_PASSWORD: 'not-a-real-secret',
  AAD_APP_TENANT_ID: 'f36f6414-cb7d-4545-9cf2-7574f7b5c584',
};

describe('resolveBotCredentials', () => {
  test('returns the identity when every value is present', () => {
    expect(resolveBotCredentials(valid)).toEqual({
      appId: valid.BOT_ID,
      appPassword: valid.BOT_PASSWORD,
      tenantId: valid.AAD_APP_TENANT_ID,
    });
  });

  test.each(['BOT_ID', 'BOT_PASSWORD', 'AAD_APP_TENANT_ID'])(
    'refuses to start when %s is missing, empty or whitespace',
    name => {
      for (const value of [undefined, '', '   ']) {
        expect(() =>
          resolveBotCredentials({ ...valid, [name]: value }),
        ).toThrow(BotCredentialsError);
      }
      expect(() =>
        resolveBotCredentials({ ...valid, [name]: undefined }),
      ).toThrow(`${name} is not set`);
    },
  );

  test('refuses a BOT_ID that is not an application id', () => {
    for (const value of ['your-bot-id', '00000000', 'not a guid at all']) {
      expect(() => resolveBotCredentials({ ...valid, BOT_ID: value })).toThrow(
        'BOT_ID is not an Entra application id',
      );
    }
  });

  test('trims surrounding whitespace from the ids but keeps the password exact', () => {
    const resolved = resolveBotCredentials({
      ...valid,
      BOT_ID: `  ${valid.BOT_ID} `,
      AAD_APP_TENANT_ID: ` ${valid.AAD_APP_TENANT_ID}\n`,
      BOT_PASSWORD: ' pass with spaces ',
    });
    expect(resolved.appId).toBe(valid.BOT_ID);
    expect(resolved.tenantId).toBe(valid.AAD_APP_TENANT_ID);
    expect(resolved.appPassword).toBe(' pass with spaces ');
  });

  test('never echoes the password in an error', () => {
    try {
      resolveBotCredentials({ ...valid, BOT_ID: '' });
    } catch (error) {
      expect(String(error)).not.toContain(valid.BOT_PASSWORD);
    }
  });
});
