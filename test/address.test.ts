import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {bytesToHex} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {noteK1} from 'lnurlcash-kit'
import {WalletUsageError} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// Claiming name@mint. The mint takes a note of its own as the fee and
// reads the buyer's identity off a NIP-98 signature, so no account exists
// anywhere - the name belongs to a Nostr key, and payouts to it arrive
// sealed to that key.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
afterEach(async () => {
  await mint?.close()
  mint = null
})

const hostOf = (theMint: Mint): string => new URL(theMint.url).host

type Registration = {name: string; note?: string; auth: Event; url: string}

// A mint that sells names, standing in front of the mock: the discovery
// document gains a price, and POST /names is answered here.
const sellingNames = (theMint: Mint, options: {priceMsat: number | null; refuse?: string}) => {
  const seen: Registration[] = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.pathname.startsWith('/.well-known/lnurlw/')) {
      const body = (await (await fetch(input, init)).json()) as Record<string, unknown>
      return Response.json({...body, ...(options.priceMsat === null ? {} : {namePriceMsat: options.priceMsat})})
    }
    if (url.pathname === '/names') {
      const raw = String(init?.body ?? '')
      const header = new Headers(init?.headers).get('authorization') ?? ''
      const auth = JSON.parse(atob(header.replace(/^Nostr /, ''))) as Event
      const parsed = JSON.parse(raw) as {name: string; note?: string}
      seen.push({name: parsed.name, ...(parsed.note ? {note: parsed.note} : {}), auth, url: url.toString()})
      if (options.refuse) return Response.json({status: 'ERROR', reason: options.refuse}, {status: 400})
      // paid for with a note of this mint: the mint burns it
      if (parsed.note) {
        const k1 = noteK1(parsed.note)
        if (k1) theMint.state.settleMelt(k1)
      }
      return Response.json({status: 'OK', name: parsed.name})
    }
    return fetch(input, init)
  }
  return {fetchImpl, seen}
}

const fund = (theMint: Mint, amountMsat: number): string => {
  const k1 = freshK1()
  theMint.state.creditNote(k1, amountMsat)
  return `${theMint.url}/w?k1=${k1}&amount=${amountMsat}`
}

describe('claiming a lightning address', () => {
  it('pays the mint with one of its own notes and signs the request as this wallet', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 21_000})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    expect(await wallet.namePriceMsat()).toBe(21_000)
    // typed with a capital, stored the way an address is read
    const claimed = await wallet.registerName({name: 'Donkey'})

    expect(claimed.address).toBe(`donkey@${hostOf(mint)}`)
    expect(claimed.paidMsat).toBe(21_000)
    expect(wallet.lightningAddress()).toBe(`donkey@${hostOf(mint)}`)
    expect(wallet.balanceMsat()).toBe(79_000)

    const request = stub.seen[0]!
    expect(request.name).toBe('donkey')
    // NIP-98: kind 27235, signed by this wallet's key, over this URL,
    // this method and this exact body
    expect(request.auth.kind).toBe(27235)
    expect(verifyEvent(request.auth)).toBe(true)
    expect(request.auth.pubkey).toBe(wallet.nostrIdentity()!.pubkey)
    expect(request.auth.tags.find(tag => tag[0] === 'u')?.[1]).toBe(request.url)
    expect(request.auth.tags.find(tag => tag[0] === 'method')?.[1]).toBe('POST')
    expect(request.auth.tags.find(tag => tag[0] === 'payload')?.[1]).toBe(
      bytesToHex(sha256(utf8ToBytes(JSON.stringify({name: 'donkey', note: request.note}))))
    )
    expect(Math.abs(request.auth.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(60)
    // the note really was one of this mint's, and it really was burned
    expect(mint.state.noteState(noteK1(request.note!)!)).toBe('burned')
  })

  it('leaves the money alone when the mint refuses', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 21_000, refuse: 'that name is taken'})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    await expect(wallet.registerName({name: 'donkey'})).rejects.toThrow('that name is taken')
    expect(wallet.lightningAddress()).toBeNull()
    // the fee note came home under a fresh secret
    expect(wallet.balanceMsat()).toBe(100_000)
    expect(wallet.sentNotes()).toEqual([])
  })

  it('refuses a mint that is not handing out names, without touching a note', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: null})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    expect(await wallet.namePriceMsat()).toBeNull()
    await expect(wallet.registerName({name: 'donkey'})).rejects.toThrow(WalletUsageError)
    expect(wallet.balanceMsat()).toBe(100_000)
    expect(stub.seen).toEqual([])
  })

  it('refuses a name the rules do not allow before anything goes out', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 21_000})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    for (const bad of ['ab', '-nope', 'has space', 'name@host', 'x'.repeat(33)]) {
      await expect(wallet.registerName({name: bad})).rejects.toThrow(WalletUsageError)
    }
    expect(stub.seen).toEqual([])
  })

  it('takes a free name without cutting a note at all', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 0})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    const claimed = await wallet.registerName({name: 'donkey'})
    expect(claimed.paidMsat).toBe(0)
    expect(stub.seen[0]!.note).toBeUndefined()
    expect(wallet.balanceMsat()).toBe(100_000)
  })
})

describe('a note that arrived as a zap', () => {
  it('carries who sent it and what they wrote', async () => {
    const {unwrapNote, wrapNote, identityFromSecret, buildNoteRumor} = await import('../src/nostr.ts')
    const {nip59} = await import('nostr-tools')
    const zapper = generateSecretKey()
    const mintKey = generateSecretKey()
    const recipient = identityFromSecret(bytesToHex(generateSecretKey()))
    const noteUrl = `lnurlw://mint.example/w?k1=${'ab'.repeat(32)}&amount=21000`

    const zapRequest = finalizeEvent(
      {
        kind: 9734,
        created_at: Math.floor(Date.now() / 1000),
        content: 'for the article',
        tags: [['amount', '21000']]
      },
      zapper
    )
    const rumor = buildNoteRumor(noteUrl, 21_000, recipient.pubkey)
    const wrap = nip59.wrapEvent(
      {...rumor, tags: [...(rumor.tags ?? []), ['description', JSON.stringify(zapRequest)]]},
      mintKey,
      recipient.pubkey
    )

    const opened = unwrapNote(wrap, recipient)
    expect(opened.zap).toEqual({
      senderPubkey: getPublicKey(zapper),
      content: 'for the article',
      amountMsat: 21_000
    })

    // a plain hand-over carries none of that, and nothing breaks
    const plain = unwrapNote(wrapNote(noteUrl, 21_000, recipient.pubkey, identityFromSecret(bytesToHex(mintKey))), recipient)
    expect(plain.zap).toBeNull()
  })

  it('ignores a description the payer did not actually sign', async () => {
    const {unwrapNote, identityFromSecret, buildNoteRumor} = await import('../src/nostr.ts')
    const {nip59} = await import('nostr-tools')
    const mintKey = generateSecretKey()
    const recipient = identityFromSecret(bytesToHex(generateSecretKey()))
    const noteUrl = `lnurlw://mint.example/w?k1=${'cd'.repeat(32)}&amount=21000`
    const forged = finalizeEvent(
      {kind: 9734, created_at: Math.floor(Date.now() / 1000), content: 'from someone important', tags: []},
      generateSecretKey()
    )
    const rumor = buildNoteRumor(noteUrl, 21_000, recipient.pubkey)
    const wrap = nip59.wrapEvent(
      {
        ...rumor,
        tags: [...(rumor.tags ?? []), ['description', JSON.stringify({...forged, sig: 'ff'.repeat(64)})]]
      },
      mintKey,
      recipient.pubkey
    )
    expect(unwrapNote(wrap, recipient).zap).toBeNull()
  })
})
