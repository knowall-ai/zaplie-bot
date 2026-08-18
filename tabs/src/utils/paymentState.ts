export interface ZapRequest {
  fingerprint: string;
  key: string;
}

export const pickExactWallet = (
  wallets: Wallet[] | null,
  name: 'private' | 'allowance',
): Wallet | null => {
  const matches = (wallets ?? []).filter(
    wallet => wallet.name.trim().toLowerCase() === name,
  );
  return matches.length === 1 ? matches[0] : null;
};

export const prepareZapRequest = (
  current: ZapRequest | null,
  fingerprint: string,
  createKey: () => string = () => crypto.randomUUID(),
): ZapRequest =>
  current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: createKey() };
