const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  DEFAULT_ADMIN_CONFIG,
  createAdminConfigStore,
  resolveDataFilePath,
  resolveMaxRewardSats,
} = require('./adminConfigStore');

const temporaryDirectories = [];

const makeTemporaryPath = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zaplie-config-store-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'nested', 'admin-config.json');
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('requires an absolute persistent config path in production', () => {
  expect(() => resolveDataFilePath({ NODE_ENV: 'production' })).toThrow(
    'ZAPLIE_CONFIG_FILE',
  );
  expect(() => resolveDataFilePath({})).toThrow('ZAPLIE_CONFIG_FILE');
  expect(() =>
    resolveDataFilePath({ NODE_ENV: 'development', RUNNING_ON_AZURE: '1' }),
  ).toThrow('ZAPLIE_CONFIG_FILE');
  expect(() =>
    resolveDataFilePath({ NODE_ENV: 'production', ZAPLIE_CONFIG_FILE: 'data.json' }),
  ).toThrow('absolute path');

  const absolutePath = makeTemporaryPath();
  expect(
    resolveDataFilePath({ NODE_ENV: 'production', ZAPLIE_CONFIG_FILE: absolutePath }),
  ).toBe(path.resolve(absolutePath));
});

test('allows the repository data file only outside production', () => {
  expect(resolveDataFilePath({ NODE_ENV: 'test' })).toBe(
    path.join(__dirname, 'data.json'),
  );
  expect(resolveDataFilePath({ NODE_ENV: 'development' })).toBe(
    path.join(__dirname, 'data.json'),
  );
});

test('seeds a missing persistent file without overwriting existing configuration', () => {
  const filePath = makeTemporaryPath();
  const store = createAdminConfigStore({ filePath, maxRewardSats: 10000 });

  expect(store.readAdminConfig(store.readData())).toEqual(DEFAULT_ADMIN_CONFIG);

  const existing = {
    rewardName: 'points',
    botPersona: 'Be concise.',
    rewardAmounts: { githubPrMergedSats: 2500 },
  };
  fs.writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`);

  const reopened = createAdminConfigStore({ filePath, maxRewardSats: 10000 });
  expect(reopened.readAdminConfig(reopened.readData())).toEqual(existing);
});

test('fails loud without replacing malformed persisted configuration', () => {
  const filePath = makeTemporaryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{not-json');

  expect(() => createAdminConfigStore({ filePath, maxRewardSats: 10000 })).toThrow();
  expect(fs.readFileSync(filePath, 'utf8')).toBe('{not-json');
});

test('validates the configured server-side reward cap', () => {
  expect(resolveMaxRewardSats({})).toBe(10000);
  expect(resolveMaxRewardSats({ REWARDS_MAX_AMOUNT_SATS: '5000' })).toBe(5000);
  expect(() => resolveMaxRewardSats({ REWARDS_MAX_AMOUNT_SATS: '0' })).toThrow(
    'positive safe integer',
  );
  expect(() => resolveMaxRewardSats({ REWARDS_MAX_AMOUNT_SATS: '1.5' })).toThrow(
    'positive safe integer',
  );
});
