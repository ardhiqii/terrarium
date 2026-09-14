/** Shared server-only encryption for GitHub credentials at rest. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const CIPHER = 'aes-256-gcm'
const IV_BYTES = 12

function keyFromSecret(secret: string): Buffer {
  return createHash('sha256').update(`terrarium:github-token:${secret}`).digest()
}
export interface EncryptedGithubToken {
  iv: string
  tag: string
  ciphertext: string
}

export function encryptGithubToken(token: string, secret: string): EncryptedGithubToken {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(CIPHER, keyFromSecret(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

export function decryptGithubToken(
  row: Pick<EncryptedGithubToken, 'iv' | 'tag' | 'ciphertext'>,
  secret: string,
): string | null {
  try {
    const decipher = createDecipheriv(
      CIPHER,
      keyFromSecret(secret),
      Buffer.from(row.iv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(row.tag, 'base64url'))
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
