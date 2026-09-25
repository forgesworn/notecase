import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools'
import {schnorr} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import {
  cashNodeToCx1,
  decodeCx1,
  deriveCashRoot,
  deriveLegacyCashAddressNode,
  deriveNotePubkey,
  encodeCx1,
  noteK1
} from '../src/lnurlcash.js'
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

type Registration = {name: string; note?: string; cx1?: string | null; sig?: string; auth: Event; url: string}

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

// The current reference lnurl-mint's signed POST/DELETE /p/{username}
// management surface. The reserved-name probe can never reach storage.
const referenceNames = () => {
  const seen: Array<{method: string; username: string; cx1?: string; sig: string; npub?: string}> = []
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    if (url.pathname === '/p/_' && init?.method === 'POST') {
      return Response.json({status: 'ERROR', reason: 'Invalid or reserved username.'})
    }
    const match = url.pathname.match(/^\/p\/([^/]+)$/)
    if (match && (init?.method === 'POST' || init?.method === 'DELETE')) {
      const cx1 = url.searchParams.get('cx1')
      const npub = url.searchParams.get('npub')
      seen.push({
        method: init.method,
        username: decodeURIComponent(match[1]!),
        ...(cx1 ? {cx1} : {}),
        sig: url.searchParams.get('sig') ?? '',
        ...(npub ? {npub} : {})
      })
      return Response.json({status: 'OK'})
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
    // with no recovery words, the branch it asks to be paid on comes from
    // its Nostr key, and that branch proves it agrees: its index-0 key over
    // sha256("LNURLcash:register:<domain>:<name>"), the domain being the
    // mint's bare hostname
    const cx1 = wallet.addressCx1(hostOf(mint))
    expect(cx1).toMatch(/^cx1/)
    expect(request.cx1).toBe(cx1)
    expect(request.auth.tags.find(tag => tag[0] === 'payload')?.[1]).toBe(
      bytesToHex(sha256(utf8ToBytes(JSON.stringify({name: 'donkey', note: request.note, cx1, sig: request.sig}))))
    )
    const branch = decodeCx1(cx1!)!
    const pk0 = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    const domain = new URL(mint.url).hostname
    expect(schnorr.verify(hexToBytes(request.sig!), sha256(utf8ToBytes(`LNURLcash:register:${domain}:donkey`)), pk0)).toBe(true)
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

  it("claims a reference lnurl-mint name on its wallet's watch-only branch", async () => {
    mint = await createMockMint()
    const reference = referenceNames()
    const {wallet} = makeWallet({fetch: reference.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)

    expect(await wallet.namePriceMsat()).toBe(0)
    const claimed = await wallet.registerName({name: 'Donkey'})

    expect(claimed).toEqual({address: `donkey@${hostOf(mint)}`, paidMsat: 0, toKeys: true})
    expect(reference.seen).toEqual([
      {
        method: 'POST',
        username: 'donkey',
        cx1: wallet.addressCx1(hostOf(mint)),
        sig: expect.stringMatching(/^[0-9a-f]{128}$/),
        npub: wallet.nostrIdentity()!.npub
      }
    ])
    // What the reference mint checks: a BIP-340 signature over
    // sha256("LNURLcash:register:<domain>:<name>") by pk_0 of the submitted
    // cx1, the domain being its own bare hostname - never the port.
    const branch = decodeCx1(reference.seen[0]!.cx1!)!
    const pk0 = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    const domain = new URL(mint.url).hostname
    const digest = sha256(utf8ToBytes(`LNURLcash:register:${domain}:donkey`))
    expect(schnorr.verify(hexToBytes(reference.seen[0]!.sig!), digest, pk0)).toBe(true)
    expect(schnorr.verify(hexToBytes(reference.seen[0]!.sig!), sha256(utf8ToBytes('LNURLcash:register:donkey')), pk0)).toBe(false)
    expect(wallet.lightningAddress()).toBe(`donkey@${hostOf(mint)}`)
  })

  it('updates and unregisters a reference address with action-separated proofs', async () => {
    mint = await createMockMint()
    const reference = referenceNames()
    const {wallet, data} = makeWallet({fetch: reference.fetchImpl})
    await wallet.addMint(`mint@${hostOf(mint)}`)

    await wallet.registerName({name: 'donkey'})
    const firstCx1 = reference.seen[0]!.cx1
    // A wallet created before recovery words used its Nostr branch. Adding a
    // seed changes the preferred receiving branch, but the old registered
    // branch must authorise that one migration.
    data.seedHex = freshK1()
    await expect(wallet.payNameToKeys(true)).resolves.toEqual({
      address: `donkey@${hostOf(mint)}`,
      toKeys: true
    })
    await expect(wallet.unregisterName()).resolves.toEqual({address: `donkey@${hostOf(mint)}`})

    expect(reference.seen.map(request => request.method)).toEqual(['POST', 'POST', 'DELETE'])
    expect(reference.seen[0]!.sig).toBe(reference.seen[1]!.sig)
    expect(reference.seen[1]!.cx1).not.toBe(firstCx1)
    expect(reference.seen[2]!.sig).not.toBe(reference.seen[1]!.sig)
    expect(wallet.lightningAddress()).toBeNull()
  })
})

describe("a reference name on the old m/139'/1' branch", () => {
  it("moves onto the spec's branch, proven by the old branch's index-0 key", async () => {
    mint = await createMockMint()
    const reference = referenceNames()
    const {wallet, data} = makeWallet({fetch: reference.fetchImpl})
    data.seedHex = freshK1()
    await wallet.addMint(`mint@${hostOf(mint)}`)
    await wallet.ensureNostrIdentity()
    const host = hostOf(mint)
    const legacy = cashNodeToCx1(deriveLegacyCashAddressNode(deriveCashRoot(hexToBytes(data.seedHex)), host))
    const legacyCx1 = encodeCx1(legacy.pubkeyXOnly, legacy.chainCode)
    // what a wallet before 2026-09-16 recorded
    data.settings.lightningAddress = `donkey@${host}`
    data.settings.lightningAddressCx1 = legacyCx1

    await expect(wallet.payNameToKeys(true)).resolves.toEqual({address: `donkey@${host}`, toKeys: true})
    const moved = reference.seen[0]!
    expect(moved.cx1).toBe(wallet.addressCx1(host))
    expect(moved.cx1).not.toBe(legacyCx1)
    const pk0 = deriveNotePubkey(legacy.pubkeyXOnly, legacy.chainCode, 0)
    const domain = new URL(mint.url).hostname
    expect(schnorr.verify(hexToBytes(moved.sig!), sha256(utf8ToBytes(`LNURLcash:register:${domain}:donkey`)), pk0)).toBe(true)
    expect(data.settings.lightningAddressCx1).toBe(moved.cx1)
  })
})

// A mint on cash.example.com, test vector 2's domain, that manages names
// either way a mint does: moneyer's NIP-98 POST /names with its body, or the
// reference's POST/DELETE /p/{name}. The moneyer route enforces the branch
// proof as a mint following LUD-25 does - set proven by the branch on file,
// or by the new one when there is none, cleared by the branch on file - and
// publishes the branch on file as text/xpub on the name's payRequest.
const namesAt = (route: 'moneyer' | 'reference', onFile: Record<string, string | null> = {}) => {
  const origin = 'https://cash.example.com'
  const posts: Array<{method: string; name: string; cx1?: string | null; sig?: string}> = []
  const proven = (cx1: string, action: 'register' | 'unregister', name: string, sig: string | undefined) => {
    if (!sig) return false
    const branch = decodeCx1(cx1)!
    const pk0 = deriveNotePubkey(branch.pubkeyXOnly, branch.chainCode, 0)
    return schnorr.verify(hexToBytes(sig), sha256(utf8ToBytes(`LNURLcash:${action}:cash.example.com:${name}`)), pk0)
  }
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const lnurlp = url.pathname.match(/^\/\.well-known\/lnurlp\/([^/]+)$/)
    if (url.pathname === '/.well-known/lnurlw/mint') {
      return Response.json({
        tag: 'withdrawRequest',
        callback: `${origin}/cb`,
        minWithdrawable: 1000,
        maxWithdrawable: 1000,
        payLink: `${origin}/.well-known/lnurlp/mint`,
        mintPubkey: `02${'11'.repeat(32)}`,
        ...(route === 'moneyer' ? {namePriceMsat: 0} : {})
      })
    }
    if (lnurlp && lnurlp[1] !== 'mint') {
      const cx1 = onFile[lnurlp[1]!]
      if (cx1 === undefined) return Response.json({status: 'ERROR', reason: 'Unknown user.'}, {status: 404})
      const metadata = [['text/identifier', `${lnurlp[1]}@cash.example.com`], ...(cx1 ? [['text/xpub', `${cx1}:0`]] : [])]
      return Response.json({
        tag: 'payRequest',
        callback: `${origin}/z/cb/${lnurlp[1]}`,
        minSendable: 1000,
        maxSendable: 1_000_000,
        metadata: JSON.stringify(metadata)
      })
    }
    if (url.pathname === '/names' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {name: string; cx1?: string | null; sig?: string}
      posts.push({method: 'POST', ...body})
      const current = onFile[body.name]
      if (body.cx1 === null && current && !proven(current, 'unregister', body.name, body.sig)) {
        return Response.json({status: 'ERROR', reason: 'Setting or clearing a cx1 needs "sig".'}, {status: 403})
      }
      if (typeof body.cx1 === 'string' && !proven(current ?? body.cx1, 'register', body.name, body.sig)) {
        return Response.json({status: 'ERROR', reason: 'Setting or clearing a cx1 needs "sig".'}, {status: 403})
      }
      if (body.cx1 !== undefined) onFile[body.name] = body.cx1
      return Response.json({status: 'OK', name: body.name, cx1: onFile[body.name] ?? null, paidMsat: 0})
    }
    if (url.pathname === '/p/_' && init?.method === 'POST') {
      return Response.json({status: 'ERROR', reason: route === 'reference' ? 'Invalid or reserved username.' : 'Not found'})
    }
    const reference = url.pathname.match(/^\/p\/([^/]+)$/)
    if (route === 'reference' && reference && (init?.method === 'POST' || init?.method === 'DELETE')) {
      posts.push({method: init.method, name: reference[1]!, cx1: url.searchParams.get('cx1'), sig: url.searchParams.get('sig') ?? ''})
      return Response.json({status: 'OK'})
    }
    return Response.json({status: 'ERROR', reason: 'Not found.'}, {status: 404})
  }
  return {fetchImpl, posts, onFile}
}

// Test vector 2's seed: its m/139' branch at cash.example.com is the vector's.
const VECTOR2_SEED =
  'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542'
const VECTOR2_CX1 =
  'cx1vjy9489tj0kq29mphzstsrsc2jnpsev834v0w23kth7kgzzs7e6kh9tet7vq0tdgtjx22rkf8jfpfqapsw4la49rkj47dw2u3xyqxpspgvxpa'

const vectorWallet = (fetchImpl: typeof globalThis.fetch) => {
  const made = makeWallet({fetch: fetchImpl})
  made.data.seedHex = VECTOR2_SEED
  made.data.mints.push({
    input: 'mint@cash.example.com',
    host: 'cash.example.com',
    payUrl: 'https://cash.example.com/.well-known/lnurlp/mint',
    addedAt: 1
  })
  made.data.settings.defaultMintHost = 'cash.example.com'
  return made
}

describe('test vector 2, through the wallet', () => {
  it('registers and releases a reference name with exactly the proofs the spec prints', async () => {
    const names = namesAt('reference')
    const {wallet} = vectorWallet(names.fetchImpl)
    expect(wallet.addressCx1('cash.example.com')).toBe(VECTOR2_CX1)

    await wallet.registerName({name: 'alice'})
    await wallet.unregisterName()
    expect(names.posts).toEqual([
      {
        method: 'POST',
        name: 'alice',
        cx1: VECTOR2_CX1,
        sig: '9d96780fe55f602a9e238a4b2640a9f8ca939cacbbcde109cfd6ba94a6f9d46ff4aaf56ba1e4e72696f7c0e8833445bd194bd06155a133cf524eb587d52e8d22'
      },
      {
        method: 'DELETE',
        name: 'alice',
        cx1: null,
        sig: '7250ab2403333eb5ed73f7a212ac4f35b58f426fe5c2acb8b2194a112881332bfbeebeba0bc4615bcf361bc125d5a4149ddbe4b6ea3b755b711fefd8bba58728'
      }
    ])
  })

  it('sends the same register proof in a moneyer name request', async () => {
    const names = namesAt('moneyer')
    const {wallet} = vectorWallet(names.fetchImpl)
    const claimed = await wallet.registerName({name: 'alice'})
    expect(claimed.toKeys).toBe(true)
    expect(names.posts[0]).toMatchObject({
      name: 'alice',
      cx1: VECTOR2_CX1,
      sig: '9d96780fe55f602a9e238a4b2640a9f8ca939cacbbcde109cfd6ba94a6f9d46ff4aaf56ba1e4e72696f7c0e8833445bd194bd06155a133cf524eb587d52e8d22'
    })
  })
})

describe('the branch proof on a moneyer name', () => {
  it("proves a move off the old m/139'/1' branch with that branch, which the mint publishes", async () => {
    const legacy = cashNodeToCx1(deriveLegacyCashAddressNode(deriveCashRoot(hexToBytes(VECTOR2_SEED)), 'cash.example.com'))
    const legacyCx1 = encodeCx1(legacy.pubkeyXOnly, legacy.chainCode)
    // on file from before 2026-09-16, and nothing about it recorded here
    const names = namesAt('moneyer', {alice: legacyCx1})
    const {wallet} = vectorWallet(names.fetchImpl)

    await expect(wallet.payNameToKeys(true, {name: 'alice'})).resolves.toEqual({
      address: 'alice@cash.example.com',
      toKeys: true
    })
    expect(names.onFile.alice).toBe(VECTOR2_CX1)
    const pk0 = deriveNotePubkey(legacy.pubkeyXOnly, legacy.chainCode, 0)
    expect(
      schnorr.verify(hexToBytes(names.posts[0]!.sig!), sha256(utf8ToBytes('LNURLcash:register:cash.example.com:alice')), pk0)
    ).toBe(true)
  })

  it('proves clearing the branch with the branch on file, as an unregister', async () => {
    const names = namesAt('moneyer', {alice: VECTOR2_CX1})
    const {wallet} = vectorWallet(names.fetchImpl)
    await expect(wallet.payNameToKeys(false, {name: 'alice'})).resolves.toEqual({
      address: 'alice@cash.example.com',
      toKeys: false
    })
    expect(names.onFile.alice).toBeNull()
    expect(names.posts[0]!.sig).toBe(
      '7250ab2403333eb5ed73f7a212ac4f35b58f426fe5c2acb8b2194a112881332bfbeebeba0bc4615bcf361bc125d5a4149ddbe4b6ea3b755b711fefd8bba58728'
    )
  })

  it('cannot prove a change for a branch it does not hold, and passes on what the mint says', async () => {
    const stranger = encodeCx1(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3))
    const names = namesAt('moneyer', {alice: stranger})
    const {wallet} = vectorWallet(names.fetchImpl)
    await expect(wallet.payNameToKeys(true, {name: 'alice'})).rejects.toThrow('needs "sig"')
    expect(names.posts[0]!.sig).toBeUndefined()
    expect(names.onFile.alice).toBe(stranger)
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
