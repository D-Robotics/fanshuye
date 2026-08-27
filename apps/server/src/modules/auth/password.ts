import { hash, verify, type Algorithm, type Options, type Version } from '@node-rs/argon2';

export const PASSWORD_HASH_OPTIONS = Object.freeze({
  // @node-rs/argon2 declares these as ambient const enums, which cannot be
  // referenced by member name under isolatedModules. 2 is Argon2id; 1 is v19.
  algorithm: 2 as Algorithm,
  version: 1 as Version,
  memoryCost: 19_456,
  timeCost: 3,
  outputLen: 32,
  parallelism: 1,
}) satisfies Readonly<Options>;

// A valid, fixed-cost Argon2id hash used only to keep the unknown-account login
// path from skipping the expensive password verification step.
const UNKNOWN_ACCOUNT_HASH =
  '$argon2id$v=19$m=19456,t=3,p=1$Ue2GCUqCYvLeNGd7CZDruQ$ch3P+5unSF+sYaj3Sc+PNajAtoXre7resfGpqzZ+5No';

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

export function verifyPassword(
  passwordHash: string | undefined,
  password: string,
): Promise<boolean> {
  return verify(passwordHash ?? UNKNOWN_ACCOUNT_HASH, password);
}
