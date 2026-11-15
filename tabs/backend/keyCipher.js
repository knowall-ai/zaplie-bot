// filepath: tabs/backend/keyCipher.js
// Encrypts LNbits wallet keys before they are written to the people store.
//
// AES-256-GCM with a 32-byte key from ZAPLIE_STORE_KEY (64 hex characters).
// When the variable is unset the key is generated once and kept in
// secrets.json, the same fallback every other internal secret uses
// (secretsStore.js). That keeps local development zero-config, but it puts the
// key beside the data, so production sets ZAPLIE_STORE_KEY in the app settings
// (ideally a Key Vault reference) and the store on disk is then useless alone.
const crypto = require('crypto');
const { getOrCreateSecret } = require('./secretsStore');

const PREFIX = 'enc:v1:';
const KEY_ENV = 'ZAPLIE_STORE_KEY';
const KEY_PATTERN = /^[0-9a-f]{64}$/i;

class KeyCipherError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyCipherError';
    this.status = 500;
  }
}

const loadKey = () => {
  const hex = String(getOrCreateSecret(KEY_ENV, 32)).trim();
  if (!KEY_PATTERN.test(hex)) {
    throw new KeyCipherError(`${KEY_ENV} must be 64 hexadecimal characters (openssl rand -hex 32)`);
  }
  return Buffer.from(hex, 'hex');
};

/**
 * A cipher bound to one key. `keyProvider` is injectable so tests never touch
 * secrets.json; the default reads the key lazily, on first use.
 */
const createKeyCipher = ({ keyProvider = loadKey } = {}) => {
  let key = null;
  const currentKey = () => {
    if (!key) key = keyProvider();
    return key;
  };

  const encrypt = (plaintext) => {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new KeyCipherError('only a non-empty string can be encrypted');
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', currentKey(), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`;
  };

  const decrypt = (sealed) => {
    if (typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) {
      // A plaintext key in the store means it was written by hand or by
      // something else: refuse it rather than use it.
      throw new KeyCipherError('stored wallet key is not encrypted');
    }
    const [ivText, tagText, bodyText] = sealed.slice(PREFIX.length).split(':');
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        currentKey(),
        Buffer.from(ivText, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch (_error) {
      // Never echo the ciphertext or the underlying OpenSSL message.
      throw new KeyCipherError(`stored wallet key could not be decrypted (wrong ${KEY_ENV}?)`);
    }
  };

  return { encrypt, decrypt, isSealed: (value) => typeof value === 'string' && value.startsWith(PREFIX) };
};

module.exports = { KeyCipherError, createKeyCipher };
