import {afterEach, describe, expect, it} from 'vitest'
import {createRequire} from 'node:module'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {bolt11PaymentHash} from 'farrier-kit/bolt11'
import {fakeBolt11} from '@forgesworn/moneyer'
import {cx1PubkeyXOnly, decodeCx1, noteK1} from '../src/lnurlcash.js'
import {WalletUsageError} from '../src/wallet.ts'
import {freshK1, makeWallet} from './helpers.ts'

// Claiming name@mint, registered to a LUD-26 share of this wallet's: the
// mint is given the share's watch-only cx1 and the share's proof that it
// agrees, and mints every payment to the name onto the share's own keys.
//
// A moneyer sells names at POST /names, paid with a note of its own and
// owned by the Nostr key that signs the request (NIP-98). Any other mint
// takes LUD-26's registration at the address itself.

type Mint = Awaited<ReturnType<typeof createMockMint>>
let mint: Mint | null = null
afterEach(async () => {
  await mint?.close()
  mint = null
})

const hostOf = (theMint: Mint): string => new URL(theMint.url).host
const domainOf = (theMint: Mint): string => new URL(theMint.url).hostname

// A BIP-340 proof by the share a cx1 exports, over LUD-26's message.
const provenBy = (cx1: string, message: string, sig: string): boolean =>
  schnorr.verify(hexToBytes(sig), sha256(utf8ToBytes(message)), cx1PubkeyXOnly(decodeCx1(cx1)!))

type Registration = {name: string; note?: string; cx1?: string | null; sig?: string; auth: Event; url: string}

// A moneyer selling names, standing in front of the mock: the discovery
// document gains a price, and POST /names is answered here. `refuse` turns
// every request away with that reason; `usedShares` are cx1s it refuses
// as already used, as a mint does a share another device registered.
const sellingNames = (theMint: Mint, options: {priceMsat: number; refuse?: string; usedShares?: string[]}) => {
  const seen: Registration[] = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.pathname.startsWith('/.well-known/lnurlw/')) {
      const body = (await (await fetch(input, init)).json()) as Record<string, unknown>
      return Response.json({...body, namePriceMsat: options.priceMsat})
    }
    if (url.pathname === '/names') {
      const raw = String(init?.body ?? '')
      const header = new Headers(init?.headers).get('authorization') ?? ''
      const auth = JSON.parse(atob(header.replace(/^Nostr /, ''))) as Event
      const parsed = JSON.parse(raw) as {name: string; note?: string; cx1?: string | null; sig?: string}
      seen.push({
        name: parsed.name,
        ...(parsed.note ? {note: parsed.note} : {}),
        ...(parsed.cx1 !== undefined ? {cx1: parsed.cx1} : {}),
        ...(parsed.sig ? {sig: parsed.sig} : {}),
        auth,
        url: url.toString()
      })
      if (options.refuse) return Response.json({status: 'ERROR', reason: options.refuse}, {status: 400})
      if (typeof parsed.cx1 === 'string' && options.usedShares?.includes(parsed.cx1)) {
        return Response.json({status: 'ERROR', reason: 'cx1 already used'}, {status: 409})
      }
      // paid for with a note of this mint: the mint burns it
      if (parsed.note) {
        const k1 = noteK1(parsed.note)
        if (k1) theMint.state.settleMelt(k1)
      }
      return Response.json({status: 'OK', name: parsed.name, cx1: parsed.cx1 ?? null})
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

describe('claiming a moneyer name', () => {
  it('pays the mint with one of its own notes and signs the request as this wallet', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 21_000})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    expect(await wallet.namePriceMsat()).toBe(21_000)
    // with no recovery words, the share comes from its Nostr key: asked for
    // now, before the claim hands it out and moves on to the next
    await wallet.ensureNostrIdentity()
    const cx1 = wallet.addressCx1(hostOf(mint))!
    // typed with a capital, stored the way an address is read
    const claimed = await wallet.registerName({name: 'Donkey'})

    expect(claimed).toEqual({address: `donkey@${hostOf(mint)}`, paidMsat: 21_000, toKeys: true})
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
    expect(Math.abs(request.auth.created_at - Math.floor(Date.now() / 1000))).toBeLessThan(60)
    // a LUD-26 share, 65 bytes, proven by its own key over a message that
    // binds the mint's bare hostname, the name and the cx1 itself
    expect(request.cx1).toBe(cx1)
    expect(decodeCx1(cx1)).not.toBeNull()
    expect(request.auth.tags.find(tag => tag[0] === 'payload')?.[1]).toBe(
      bytesToHex(sha256(utf8ToBytes(JSON.stringify({name: 'donkey', note: request.note, cx1, sig: request.sig}))))
    )
    expect(provenBy(cx1, `LNURLcash:register:${domainOf(mint)}:donkey:${cx1}`, request.sig!)).toBe(true)
    // the note really was one of this mint's, and it really was burned
    expect(mint.state.noteState(noteK1(request.note!)!)).toBe('burned')
    // that share is spent: the next name gets the next one
    expect(wallet.addressCx1(hostOf(mint))).not.toBe(cx1)
  })

  it('leaves the money alone when the mint refuses', async () => {
    mint = await createMockMint()
    const stub = sellingNames(mint, {priceMsat: 21_000, refuse: 'that name is taken'})
    const {wallet} = makeWallet({fetch: stub.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))
    await wallet.ensureNostrIdentity()
    const cx1 = wallet.addressCx1(hostOf(mint))

    await expect(wallet.registerName({name: 'donkey'})).rejects.toThrow('that name is taken')
    expect(wallet.lightningAddress()).toBeNull()
    // the fee note came home under a fresh secret
    expect(wallet.balanceMsat()).toBe(100_000)
    expect(wallet.sentNotes()).toEqual([])
    // and the share the mint never took is still the next to offer
    expect(wallet.addressCx1(hostOf(mint))).toBe(cx1)
  })

  it('moves past a share another device on this seed registered, without paying twice', async () => {
    mint = await createMockMint()
    const {wallet: probe, data: probed} = makeWallet()
    probed.seedHex = freshK1()
    const first = probe.addressCx1(hostOf(mint))!
    const stub = sellingNames(mint, {priceMsat: 21_000, usedShares: [first]})
    const {wallet, data} = makeWallet({fetch: stub.fetchImpl})
    data.seedHex = probed.seedHex
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    const claimed = await wallet.registerName({name: 'donkey'})
    expect(claimed.toKeys).toBe(true)
    expect(stub.seen.map(request => request.cx1)).toEqual([first, data.settings.lightningAddressCx1])
    expect(data.settings.lightningAddressCx1).not.toBe(first)
    // the refused attempt's note came home; only the accepted one was taken
    expect(wallet.balanceMsat()).toBe(79_000)
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

// conformance's mock mint, which serves LUD-26 registration as the spec has
// it: POST, PUT and DELETE at the address, each proof checked, a share
// accepted once only.
describe('registering at the address itself', () => {
  it('registers a share, moves the name to the next with PUT, and releases it', async () => {
    mint = await createMockMint()
    const {wallet, data} = makeWallet()
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    const address = `donkey@${hostOf(mint)}`

    expect(await wallet.namePriceMsat()).toBe(0)
    const first = wallet.addressCx1(hostOf(mint))!
    await expect(wallet.registerName({name: 'Donkey'})).resolves.toEqual({address, paidMsat: 0, toKeys: true})
    expect(mint.state.registrations.get('donkey')).toMatchObject({cx1: first, paid: true})
    expect(data.settings.lightningAddressCx1).toBe(first)

    const second = wallet.addressCx1(hostOf(mint))!
    expect(second).not.toBe(first)
    await expect(wallet.payNameToKeys(true)).resolves.toEqual({address, toKeys: true})
    expect(mint.state.registrations.get('donkey')).toMatchObject({cx1: second})
    expect(data.settings.lightningAddressCx1).toBe(second)
    expect(data.settings.nameKeys).toEqual({[address]: second})

    await expect(wallet.unregisterName()).resolves.toEqual({address})
    expect(mint.state.registrations.has('donkey')).toBe(false)
    expect(wallet.lightningAddress()).toBeNull()
  })

  it('finds the key on file when nothing here recorded it', async () => {
    mint = await createMockMint()
    const seed = freshK1()
    const {wallet: other, data: otherData} = makeWallet()
    otherData.seedHex = seed
    await other.addMint(`mint@${hostOf(mint)}`)
    await other.registerName({name: 'donkey'})

    // the same words on a device that has never seen the name
    const {wallet, data} = makeWallet()
    data.seedHex = seed
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await expect(wallet.unregisterName({name: 'donkey'})).resolves.toEqual({address: `donkey@${hostOf(mint)}`})
    expect(mint.state.registrations.has('donkey')).toBe(false)
  })

  it('moves past a share the mint has seen before, as LUD-26 says', async () => {
    mint = await createMockMint()
    const seed = freshK1()
    const {wallet: other, data: otherData} = makeWallet()
    otherData.seedHex = seed
    await other.addMint(`mint@${hostOf(mint)}`)
    const taken = other.addressCx1(hostOf(mint))!
    await other.registerName({name: 'first'})

    const {wallet, data} = makeWallet()
    data.seedHex = seed
    await wallet.addMint(`mint@${hostOf(mint)}`)
    expect(wallet.addressCx1(hostOf(mint))).toBe(taken)
    await wallet.registerName({name: 'second'})
    expect(mint.state.registrations.get('second')!.cx1).not.toBe(taken)
    expect(data.settings.addressShares).toEqual({[domainOf(mint)]: 2})
  })

  it('says so when the name is someone else\'s, and records nothing', async () => {
    mint = await createMockMint()
    const {wallet: other, data: otherData} = makeWallet()
    otherData.seedHex = freshK1()
    await other.addMint(`mint@${hostOf(mint)}`)
    await other.registerName({name: 'donkey'})

    const {wallet, data} = makeWallet()
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await expect(wallet.registerName({name: 'donkey'})).rejects.toThrow('already registered')
    expect(wallet.lightningAddress()).toBeNull()
    await expect(wallet.unregisterName({name: 'donkey'})).rejects.toThrow(/registered to a key this wallet does not hold/)
    expect(mint.state.registrations.has('donkey')).toBe(true)
  })

  it('waits out a mint that rate-limits the scan, rather than stopping', async () => {
    mint = await createMockMint()
    let limited = 0
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.searchParams.get('p')?.startsWith('cp1') && limited < 3) {
        limited += 1
        // LUD-26's wording, then a reverse proxy's 429, as moneyer.dev's Caddy answers
        return limited === 1
          ? Response.json({status: 'ERROR', reason: 'rate limited'})
          : Response.json({status: 'ERROR', reason: 'Too many requests - wait a moment and try again.'}, {status: 429})
      }
      return fetch(input, init)
    }
    const {wallet, data} = makeWallet({fetch: fetchImpl, rateLimitBackoffMs: 1})
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    const scan = await wallet.scanAddress(hostOf(mint), {gap: 2})
    expect(limited).toBe(3)
    expect(scan.received).toEqual([])
    expect(scan.scanned).toBeGreaterThan(0)
  })

  it('pays an address fee by melting a note of the mint, once it is checked against the fee advertised', async () => {
    mint = await createMockMint({addressFeeMsat: 21_000})
    const theMint = mint
    // the mock's invoices carry only their amount; this gives the fee one a
    // wallet can melt, for the same payment hash
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (init?.method !== 'POST' || !String(input).includes('/.well-known/lnurlp/')) return response
      const body = (await response.json()) as {status: string; pr?: string}
      const held = theMint.state.registrations.get('donkey')
      if (!body.pr || !held?.paymentHash) return Response.json(body)
      return Response.json({...body, pr: fakeBolt11({amountMsat: 21_000, paymentHashHex: held.paymentHash})})
    }
    const {wallet, data} = makeWallet({fetch: fetchImpl})
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    expect(await wallet.namePriceMsat()).toBe(21_000)
    const claimed = await wallet.registerName({name: 'donkey'})
    expect(claimed).toEqual({address: `donkey@${hostOf(mint)}`, paidMsat: 21_000, toKeys: true})
    const melt = wallet.data.melts[0]!
    expect(melt.amountMsat).toBe(21_000)
    // held until the invoice settles, which is the mint's own to settle
    expect(mint.state.registrations.get('donkey')!.paid).toBe(false)
    mint.state.settle(bolt11PaymentHash(melt.pr)!)
    expect(mint.state.registrations.get('donkey')!.paid).toBe(true)
  })

  it('hands back an invoice over the fee advertised, and pays nothing', async () => {
    mint = await createMockMint({addressFeeMsat: 21_000, addressFeeChargedMsat: 50_000})
    const {wallet, data} = makeWallet()
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.receive(fund(mint, 100_000))

    const claimed = await wallet.registerName({name: 'donkey'})
    expect(claimed.paidMsat).toBe(0)
    expect(claimed.feeInvoice).toMatch(/^ln/)
    expect(wallet.data.melts).toEqual([])
    expect(wallet.balanceMsat()).toBe(100_000)
    expect(mint.state.registrations.get('donkey')!.paid).toBe(false)
  })
})

// LUD-26's own vectors (26-vectors.json, as conformance ships it): alice at
// cash.example.com from derivation[1]'s seed, registered to share 0, moved
// to share 1, released by share 1. The wallet sends exactly those proofs.
const specVectors = createRequire(import.meta.url)('lnurlcash-conformance/vectors/spec-vectors.json') as {
  lud26: {
    derivation: Array<{seed: string; domain: string; accounts: Array<{shareable: Array<{cx1: string}>}>}>
    registration: {
      username: string
      domain: string
      cx1: string
      new_cx1: string
      register: {sig: string}
      update: {sig: {sig: string}; newsig: {sig: string}}
      unregister: {sig: string}
    }
  }
}

describe("LUD-26's vectors, through the wallet", () => {
  it('registers, moves and releases alice with exactly the proofs the spec prints', async () => {
    const vectors = specVectors.lud26
    const origin = 'https://cash.example.com'
    const sent: Array<{method: string; form: Record<string, string>}> = []
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname === '/.well-known/lnurlw/mint') return Response.json({status: 'ERROR', reason: 'Not found.'}, {status: 404})
      if (url.pathname === '/.well-known/lnurlp/mint') {
        return Response.json({
          tag: 'payRequest',
          callback: `${origin}/cb`,
          minSendable: 1000,
          maxSendable: 1_000_000,
          metadata: JSON.stringify([['text/plain', 'Mint fees: 0,0']]),
          withdrawLink: `${origin}/w`
        })
      }
      if (url.pathname === '/.well-known/lnurlp/alice' && init?.method) {
        sent.push({method: init.method, form: Object.fromEntries(new URLSearchParams(String(init.body ?? '')))})
        return Response.json({status: 'OK'})
      }
      return Response.json({status: 'ERROR', reason: 'Not found.'}, {status: 404})
    }
    const {wallet, data} = makeWallet({fetch: fetchImpl})
    data.seedHex = vectors.derivation[1]!.seed
    data.mints.push({input: 'mint@cash.example.com', host: 'cash.example.com', payUrl: `${origin}/.well-known/lnurlp/mint`, addedAt: 1})
    data.settings.defaultMintHost = 'cash.example.com'

    await wallet.registerName({name: 'alice'})
    await wallet.payNameToKeys(true)
    await wallet.unregisterName()
    const proofs = vectors.registration
    expect(sent).toEqual([
      // no npub: an unsigned one would tie the name to a Nostr identity
      {method: 'POST', form: {cx1: proofs.cx1, sig: proofs.register.sig}},
      {method: 'PUT', form: {cx1: proofs.new_cx1, sig: proofs.update.sig.sig, newsig: proofs.update.newsig.sig}},
      {method: 'DELETE', form: {sig: proofs.unregister.sig}}
    ])
  })
})

// LUD-26's internal transfer, to a name a stub serves in front of the
// mock: the address's payRequest and its callback, answered as `answer`.
describe('paying a name at the same mint', () => {
  const payee = (theMint: Mint, opts: {callbackOrigin?: string; answer?: Record<string, unknown>} = {}) => {
    const sent: string[] = []
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
      if (url.pathname === '/.well-known/lnurlp/bob') {
        return Response.json({
          tag: 'payRequest',
          callback: `${opts.callbackOrigin ?? theMint.url}/z/cb/bob`,
          minSendable: 1000,
          maxSendable: 1_000_000,
          metadata: JSON.stringify([['text/plain', 'bob']]),
          withdrawLink: `${theMint.url}/w`
        })
      }
      if (url.pathname === '/z/cb/bob') {
        sent.push(url.searchParams.get('k1') ?? '')
        return Response.json(opts.answer ?? {status: 'OK'})
      }
      return fetch(input, init)
    }
    return {fetchImpl, sent}
  }
  const funded = async (fetchImpl: typeof globalThis.fetch) => {
    const {wallet} = makeWallet({fetch: fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint!)}`)
    await wallet.receive(fund(mint!, 50_000))
    return wallet
  }

  it('hands over an exact note at the callback, and writes it off once the mint says OK', async () => {
    mint = await createMockMint()
    const stub = payee(mint)
    const wallet = await funded(stub.fetchImpl)
    const paid = await wallet.payAddressInternally(`bob@${hostOf(mint)}`, 21_000)
    expect(paid).toMatchObject({host: hostOf(mint), ambiguous: false})
    expect(paid!.note.state).toBe('spent')
    expect(stub.sent).toEqual([paid!.note.k1])
    expect(wallet.balanceMsat()).toBe(29_000)
  })

  it('never sends a note to a callback off the mint, whatever the payRequest claims', async () => {
    mint = await createMockMint()
    const stub = payee(mint, {callbackOrigin: 'https://evil.example'})
    const wallet = await funded(stub.fetchImpl)
    expect(await wallet.payAddressInternally(`bob@${hostOf(mint)}`, 21_000)).toBeNull()
    expect(stub.sent).toEqual([])
    expect(wallet.balanceMsat()).toBe(50_000)
  })

  it('never pays an address on another host this way, even one naming the mint as its withdrawLink', async () => {
    mint = await createMockMint()
    const stub = payee(mint)
    const wallet = await funded(stub.fetchImpl)
    expect(await wallet.payAddressInternally('bob@evil.example', 21_000)).toBeNull()
    expect(stub.sent).toEqual([])
  })

  for (const reason of ['pending', 'already in use']) {
    it(`keeps the note handed over when the mint answers "${reason}"`, async () => {
      mint = await createMockMint()
      const stub = payee(mint, {answer: {status: 'ERROR', reason}})
      const wallet = await funded(stub.fetchImpl)
      const paid = await wallet.payAddressInternally(`bob@${hostOf(mint)}`, 21_000)
      expect(paid).toMatchObject({ambiguous: true})
      expect(paid!.note.state).toBe('sent')
      expect(wallet.balanceMsat()).toBe(29_000)
    })
  }

  it('takes the note back on a plain refusal', async () => {
    mint = await createMockMint()
    const stub = payee(mint, {answer: {status: 'ERROR', reason: 'Amount out of range.'}})
    const wallet = await funded(stub.fetchImpl)
    await expect(wallet.payAddressInternally(`bob@${hostOf(mint)}`, 21_000)).rejects.toThrow('Amount out of range.')
    expect(wallet.balanceMsat()).toBe(50_000)
    expect(wallet.sentNotes()).toEqual([])
  })

  it('cuts nothing for an amount the address does not take', async () => {
    mint = await createMockMint()
    const stub = payee(mint)
    const wallet = await funded(stub.fetchImpl)
    expect(await wallet.payAddressInternally(`bob@${hostOf(mint)}`, 2_000_000)).toBeNull()
    expect(wallet.liveNotes()).toHaveLength(1)
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
