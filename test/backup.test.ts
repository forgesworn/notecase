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

  it('round-trips a note taken offline, which has no callback yet', async () => {
    const data = sample()
    data.notes.push({
      id: 'c'.repeat(64),
      k1: 'd'.repeat(64),
      amountMsat: 5_000,
      baseUrl: 'https://mint.example/w',
      // no callback: the mint publishes one, and a note URL does not
      // carry it, so a note taken offline has none until reconcile
      callback: '',
      mintHost: 'mint.example',
      state: 'live',
      origin: 'receive',
      unrotated: true,
      createdAt: 2,
      updatedAt: 2
    })
    const file = await exportBackup(data, 'correct horse battery')
    expect(await importBackup(file, 'correct horse battery')).toEqual(data)
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

  it('round-trips a full wallet: mints, pins, pendings and melts too', async () => {
    const data = sample()
    data.mints.push({
      input: 'mint@mint.example',
      host: 'mint.example',
      payUrl: 'https://mint.example/.well-known/lnurlp/mint',
      baseUrl: 'https://mint.example/w',
      label: 'main',
      mintFee: {baseFeeMsat: 1000, feePpm: 0},
      addedAt: 1
    })
    data.pubkeyPins['mint.example'] = 'c'.repeat(66)
    data.pendingMints.push({
      id: 'd'.repeat(64),
      mintHost: 'mint.example',
      baseUrl: 'https://mint.example/w',
      pr: 'lnbc210n1pstaged',
      verifyUrl: `https://mint.example/verify/${'d'.repeat(64)}`,
      grossMsat: 21_000,
      expectedNetMsat: 20_000,
      state: 'claimed',
      preimageHex: 'e'.repeat(64),
      createdAt: 1,
      updatedAt: 1
    })
    data.melts.push({
      paymentHash: 'f'.repeat(64),
      noteId: 'a'.repeat(64),
      pr: 'lnbc210n1pstaged',
      amountMsat: 21_000,
      target: 'invoice',
      state: 'in-flight',
      createdAt: 1,
      updatedAt: 1
    })
    const file = await exportBackup(data, 'correct horse battery')
    const restored = await importBackup(file, 'correct horse battery')
    expect(restored).toEqual(data)
  })

  // The one backup a heartwood's notes ever get. The secrets stay on the
  // board on purpose - a copy restored onto a second one is a double-spend -
  // so what travels is the inventory: what existed, and nothing that spends
  // it (heartwood-esp32#86).
  it('round-trips a linked heartwood and the inventory of what it held', async () => {
    const data = sample()
    data.settings.heartwood = {
      uri: `bunker://${'1'.repeat(64)}?relay=wss%3A%2F%2Fdev.example`,
      devicePubkey: '1'.repeat(64),
      relays: ['wss://dev.example'],
      clientSecretHex: '2'.repeat(64),
      held: {msat: 10_000, notes: 2, at: 1_757_000_000},
      inventory: [
        {id: 'aaaa1111', amountMsat: 9_000, host: 'mint.example/w', state: 'confirmed', label: 'zap'},
        {id: 'bbbb2222', amountMsat: 1_000, host: 'mint.example/w', state: 'confirmed', index: 4},
        {id: 'cccc3333', amountMsat: 5_000, host: 'mint.example/w', state: 'spent'}
      ]
    }
    const file = await exportBackup(data, 'correct horse battery')
    expect(await importBackup(file, 'correct horse battery')).toEqual(data)
  })

  it('restores an older backup, from before the inventory existed', async () => {
    const data = sample()
    // A wallet paired with a locker but taken before anything was written
    // down about it, and a wallet that never paired one at all. Neither is
    // a file to refuse.
    data.settings.heartwood = {
      uri: `bunker://${'1'.repeat(64)}?relay=wss%3A%2F%2Fdev.example`,
      devicePubkey: '1'.repeat(64),
      relays: ['wss://dev.example'],
      clientSecretHex: '2'.repeat(64)
    }
    const paired = await exportBackup(data, 'correct horse battery')
    expect(await importBackup(paired, 'correct horse battery')).toEqual(data)

    delete data.settings.heartwood
    const unpaired = await exportBackup(data, 'correct horse battery')
    expect(await importBackup(unpaired, 'correct horse battery')).toEqual(data)
  })

  it('rejects an inventory carrying anything spendable, or anything shaped to reach a terminal', async () => {
    const withLocker = (note: Record<string, unknown>) => {
      const data = sample()
      data.settings.heartwood = {
        uri: `bunker://${'1'.repeat(64)}?relay=wss%3A%2F%2Fdev.example`,
        devicePubkey: '1'.repeat(64),
        relays: ['wss://dev.example'],
        clientSecretHex: '2'.repeat(64),
        inventory: [note as never]
      }
      return data
    }
    const good = {id: 'aaaa1111', amountMsat: 9_000, host: 'mint.example/w', state: 'confirmed'}
    for (const bad of [
      {...good, k1: 'd'.repeat(64)},
      {...good, sig: 'cs1abc'},
      {...good, secret: 'd'.repeat(64)},
      // and a field nobody designed in, whatever it turned out to hold
      {...good, whatever: 'd'.repeat(64)},
      {...good, host: '<script>alert(1)</script>'},
      {...good, label: 'zap\u001b[2Jgone'},
      {...good, state: 'load-bearing'},
      {...good, amountMsat: '9000'}
    ]) {
      const file = await exportBackup(withLocker(bad), 'correct horse battery')
      await expect(importBackup(file, 'correct horse battery')).rejects.toThrow(
        'The backup decrypted but does not hold a valid wallet.'
      )
    }
    // and the shape it refuses is genuinely narrower than the one it takes
    const fine = await exportBackup(withLocker(good), 'correct horse battery')
    await expect(importBackup(fine, 'correct horse battery')).resolves.toBeTruthy()
  })

  it('rejects a decrypted backup carrying hostile string fields', async () => {
    const tampered = sample()
    tampered.notes[0]!.mintHost = '<script>alert(1)</script>'
    const file = await exportBackup(tampered, 'correct horse battery')
    // rejected with the generic message - the hostile field is never echoed
    await expect(importBackup(file, 'correct horse battery')).rejects.toThrow(
      'The backup decrypted but does not hold a valid wallet.'
    )
  })

  it('rejects a decrypted backup whose amounts are not numbers', async () => {
    const tampered = sample()
    // a hostile file, not a wallet bug: the field is a string on disk
    ;(tampered.notes[0]! as {amountMsat: unknown}).amountMsat = '21000'
    const file = await exportBackup(tampered, 'correct horse battery')
    await expect(importBackup(file, 'correct horse battery')).rejects.toThrow(
      'The backup decrypted but does not hold a valid wallet.'
    )
  })

  it('rejects states outside the enums', async () => {
    const tampered = sample()
    ;(tampered.notes[0]! as {state: unknown}).state = 'load-bearing'
    const file = await exportBackup(tampered, 'correct horse battery')
    await expect(importBackup(file, 'correct horse battery')).rejects.toThrow(BackupError)
  })
})
