// localStorage can be missing or throw (private windows, blocked storage).
// Everything here degrades to "not remembered".

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export const BUYER_TOKEN_KEY = "plusone.buyerToken";
export const SELLER_TOKEN_KEY = "plusone.sellerToken";
