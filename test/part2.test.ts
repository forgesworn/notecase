import {afterEach, describe, expect, it} from 'vitest'
import {createFakeBackend, createMoneyer, type FakeBackend, type Moneyer} from '@forgesworn/moneyer'
import {ProtocolError, encodeCk1, isCk1, signNoteOwnership} from '../src/lnurlcash.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, randomBytes} from '@noble/hashes/utils.js'
import {exportBackup, importBackup} from '../src/backup.ts'
import {BadSignatureError, WalletUsageError} from '../src/wallet.ts'
import {freshK1, legacyEcdsaCk1, legacySchnorrCk1, makeWallet} from './helpers.ts'
import {moneyerBearerId, taprootMoneyer} from './moneyer.ts'

// LUD-25 Part 2: a note keyed by a public key and spent with its ck1. The
// wallet takes one, checks its cs1 certificate, and rotates it into a secret
// of its own, as lnurl-wallet does.

let mint: {moneyer: Moneyer; backend: FakeBackend} | null = null
const startMint = async () => {
  const backend = createFakeBackend()
  const moneyer = await createMoneyer(
    {
      host: '127.0.0.1',
      port: 0,
      username: 'mint',
      description: 'an LNURLcash note',
      minSendableMsat: 1000,
      maxSendableMsat: 100_000_000,
      minMintMsat: 1000,
      mintFee: null,
      signingKey: bytesToHex(randomBytes(32)),
      dbPath: ':memory:',
      backend: {kind: 'fake'},
      verify: true,
      maxK1s: 21,
      sunset: false
    },
    {backend, confirmDelaysMs: [0, 10]}
  )
  mint = {moneyer, backend}
  return mint
}
afterEach(async () => {
  await mint?.moneyer.close()
  mint = null
})

type PartTwoNote = {id: string; ck1: string; sig: string; url: string; sk: Uint8Array}

type Ck1Signer = (sk: Uint8Array, mintUrl: string) => string

// Signed over the canonical spend transaction's sighash for this mint.
const boundCk1: Ck1Signer = (sk, mintUrl) => {
  const {pubkeyXOnly, signature} = signNoteOwnership(sk, mintUrl)
  return encodeCk1(pubkeyXOnly, signature)
}

// The ck1 a holder hands over, in the newest shape the mint under test reads:
// bound to its domain, or - for the pinned moneyer, which predates that - the
// deprecated fixed-message shape a mint still reads either way.
const newestCk1: Ck1Signer = taprootMoneyer ? boundCk1 : sk => legacySchnorrCk1(sk)

// A Part 2 note on the mint, as a holder would hand it over: ck1, amount, cs1.
const partTwoNote = async (
  theMint: {moneyer: Moneyer},
  amountMsat: number,
  sign: Ck1Signer = newestCk1
): Promise<PartTwoNote> => {
  const sk = secp256k1.utils.randomSecretKey()
  const id = bytesToHex(secp256k1.getPublicKey(sk, true).slice(1))
  theMint.moneyer.store.creditNote(id, amountMsat)
  const ck1 = sign(sk, theMint.moneyer.url)
  const info = (await (await fetch(`${theMint.moneyer.url}/w?k1=${ck1}`)).json()) as {sig: string}
  return {id, ck1, sig: info.sig, url: `${theMint.moneyer.url}/w?k1=${ck1}&amount=${amountMsat}&sig=${info.sig}`, sk}
}

// The same note's ck1 spelled differently: the 65-byte ECDSA shape a
// heartwood still issues for a key this wallet signs as Schnorr.
const otherSpelling = (note: PartTwoNote): string => legacyEcdsaCk1(note.sk)

const statusAtMint = async (theMint: {moneyer: Moneyer}, k1: string): Promise<unknown> =>
  ((await (await fetch(`${theMint.moneyer.url}/w?k1=${k1}`)).json()) as {reason?: unknown}).reason

// A Part 1 note, to pin the mint's key before anything is taken offline.
const pinMint = async (theMint: {moneyer: Moneyer}, wallet: ReturnType<typeof makeWallet>['wallet']) => {
  const k1 = freshK1()
  theMint.moneyer.store.creditNote(moneyerBearerId(k1), 5_000)
  await wallet.receive(`${theMint.moneyer.url}/w?k1=${k1}&amount=5000`)
}

describe('taking a Part 2 note', () => {
  it('checks its certificate and rotates it into a secret of its own', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    const note = await partTwoNote(theMint, 30_000)

    await wallet.receive(note.url)
    expect(wallet.balanceMsat()).toBe(30_000)
    const [held] = wallet.liveNotes()
    expect(held!.k1).toMatch(/^[0-9a-f]{64}$/)
    expect(await statusAtMint(theMint, note.ck1)).toBe('Note already spent.')
  })

  it('still takes one whose ck1 signed the deprecated fixed message', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    const note = await partTwoNote(theMint, 30_000, sk => legacySchnorrCk1(sk))
    await wallet.receive(note.url)
    expect(wallet.balanceMsat()).toBe(30_000)
    expect(await statusAtMint(theMint, note.ck1)).toBe('Note already spent.')
  })

  it.runIf(taprootMoneyer)('takes one whose ck1 is bound to this mint', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    const note = await partTwoNote(theMint, 30_000, boundCk1)
    await wallet.receive(note.url)
    expect(wallet.balanceMsat()).toBe(30_000)
    expect(await statusAtMint(theMint, note.ck1)).toBe('Note already spent.')
  })

  it('refuses one whose ck1 is bound to another mint, before asking this one anything', async () => {
    const theMint = await startMint()
    const {wallet, data} = makeWallet()
    const note = await partTwoNote(theMint, 30_000)
    const elsewhere = boundCk1(note.sk, 'https://other.example')
    await expect(wallet.receive(note.url.replace(note.ck1, elsewhere))).rejects.toThrow(ProtocolError)
    expect(data.notes).toEqual([])
    expect(await statusAtMint(theMint, note.ck1)).toBeUndefined()
  })

  it('refuses one whose certificate belongs to another note', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    const note = await partTwoNote(theMint, 30_000)
    const other = await partTwoNote(theMint, 30_000)
    const forged = note.url.replace(note.sig, other.sig)
    await expect(wallet.receive(forged)).rejects.toThrow(BadSignatureError)
    expect(await statusAtMint(theMint, note.ck1)).toBeUndefined()
  })
})

describe('taking a Part 2 note offline', () => {
  it('takes it on its certificate, and rotates it once back online', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    await pinMint(theMint, wallet)
    const note = await partTwoNote(theMint, 21_000)

    expect(wallet.verifyNoteOffline(note.url).valid).toBe(true)
    await wallet.receiveOffline(note.url)
    const held = wallet.liveNotes().find(record => record.id === note.id)!
    expect(held.unrotated).toBe(true)
    expect(held.k1).toBe(note.ck1)

    await wallet.reconcile()
    expect(wallet.liveNotes().some(record => isCk1(record.k1))).toBe(false)
    expect(wallet.balanceMsat()).toBe(5_000 + 21_000)
    expect(await statusAtMint(theMint, note.ck1)).toBe('Note already spent.')
  })

  it('knows one note under two spellings of its ck1', async () => {
    const theMint = await startMint()
    const {wallet} = makeWallet()
    await pinMint(theMint, wallet)
    const note = await partTwoNote(theMint, 21_000)
    await wallet.receiveOffline(note.url)
    await expect(wallet.receiveOffline(note.url.replace(note.ck1, otherSpelling(note)))).rejects.toThrow(
      WalletUsageError
    )
    expect(wallet.balanceMsat()).toBe(5_000 + 21_000)
  })

  it('backs up and restores a wallet holding one', async () => {
    const theMint = await startMint()
    const {wallet, data} = makeWallet()
    await pinMint(theMint, wallet)
    const note = await partTwoNote(theMint, 21_000)
    await wallet.receiveOffline(note.url)

    const restored = await importBackup(await exportBackup(data, 'correct horse battery'), 'correct horse battery')
    const held = restored.notes.find(record => record.id === note.id)!
    expect(held.k1).toBe(note.ck1)
    expect(held.signature).toBe(note.sig)
  })
})
