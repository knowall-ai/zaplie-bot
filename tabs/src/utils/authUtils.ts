export function generateState(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const hashed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(hashed))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function getHashParameters(hash: string): Record<string, string> {
  const hashParams: Record<string, string> = {};
  hash
    .substring(1)
    .split('&')
    .forEach(function (item) {
      const s = item.split('=');
      const k = s[0];
      const v = s[1] && decodeURIComponent(s[1]);
      hashParams[k] = v;
    });
  return hashParams;
}

export function handleAuthError(errorType: string, errorMessage: any): void {
  const err = JSON.stringify({
    error: errorType,
    message: JSON.stringify(errorMessage, null, 2),
  });
  console.error('Authentication Error:', err);
}