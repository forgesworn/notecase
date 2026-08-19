import {describe, expect, it} from 'vitest'
import {BackupError, exportBackup, importBackup} from '../src/backup.ts'
import {emptyWallet} from '../src/types.ts'

// The portable backup: sealed under its own passphrase, never under the
// device PIN - a file must survive an offline brute force, a PIN pad only
// has to survive a thumb.

const sample = () => {
  const data = emptyWallet()
  data.notes.push({
    id: 'a'.repeat(64),
    k1: 'b'.repeat(64),
    amountMsat: 21_000,
    baseUrl: 'https://mint.example/w',
    callback: 'https://mint.example/w/cb',
    mintHost: 'mint.example',
    state: 'live',
    origin: 'mint',
    createdAt: 1,
    updatedAt: 1
  })
  return data
}

describe('backup', () => {
  it('round-trips a wallet under its passphrase', async () => {
    const data = sample()
    const file = await exportBackup(data, 'correct horse battery')
    const restored = await importBackup(file, 'correct horse battery')
    expect(restored).toEqual(data)
    // and the file itself is an envelope, not plaintext
    expect(file).not.toContain('b'.repeat(64))
  })

  it('refuses a short passphrase at export', async () => {
    await expect(exportBackup(sample(), 'short')).rejects.toThrow(BackupError)
  })

  it('rejects a wrong passphrase without leaking anything else', async () => {
    const file = await exportBackup(sample(), 'correct horse battery')
    await expect(importBackup(file, 'incorrect horse battery')).rejects.toThrow('Wrong passphrase')
  })

  it('rejects files that are not backups', async () => {
    await expect(importBackup('{"hello":"world"}', 'correct horse battery')).rejects.toThrow('not a notecase backup')
    await expect(importBackup('nonsense', 'correct horse battery')).rejects.toThrow('not a notecase backup')
  })
})
