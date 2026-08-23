import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {buildNoteUrl, fetchNoteInfo, hashK1} from 'lnurlcash-kit'
import {bytesToHex, hexToBytes, randomBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {ed25519} from '@noble/curves/ed25519.js'
import {
  STORAGE_UNREADABLE,
  VaultClient,
  VaultError,
  collectFromVault,
  depositToVault,
  storageAdvice,
  type VaultNote,
  type VaultTransport
} from '../src/vault.ts'
import {freshK1, makeWallet} from './helpers.ts'

// A hardware vault on the end of a cable.
//
// The device here answers the real lnurl-vault command protocol and holds
// real secrets, so a note that comes off it is a note that works at a real
// mint, and a note put onto it can be exported and spent. What is faked is
// the cable, not the money.

type Held = {id: string; k1: string; state: 'pending' | 'confirmed' | 'spent'; amountMsat: number; host: string; label?: string}

const identityMessage = (nonceHex: string): Uint8Array => {
  const prefix = utf8ToBytes('lnurlvault-id-v1')
  const nonce = hexToBytes(nonceHex)
  const message = new Uint8Array(prefix.length + 1 + nonce.length)
  message.set(prefix)
  message[prefix.length] = 0
  message.set(nonce, prefix.length + 1)
  return message
}

const fakeVault = (options: {gated?: boolean; storage?: string; pageLimit?: number; identityKey?: Uint8Array} = {}) => {
  const identityKey = options.identityKey ?? ed25519.utils.randomSecretKey()
  const held = new Map<string, Held>()
  const seen: Array<Record<string, unknown>> = []
  let approve = true
  const transport: VaultTransport = {
    async request(command) {
      seen.push(command)
      const reply = handle(command)
      return reply
    },
    close: () => {}
  }
  const gatedReply = (): Record<string, unknown> | null =>
    options.gated === false
      ? {ok: false, error: 'unsupported'}
      : approve
        ? null
        : {ok: false, error: 'user_declined'}

  const handle = (command: Record<string, unknown>): Record<string, unknown> => {
    const id = String(command.id ?? '')
    switch (command.cmd) {
      case 'identify': {
        const nonce = String(command.nonce ?? '')
        if (nonce.length < 32 || nonce.length > 64) return {ok: false, error: 'bad_request'}
        return {
          ok: true,
          pubkey: bytesToHex(ed25519.getPublicKey(identityKey)),
          sig: bytesToHex(ed25519.sign(identityMessage(nonce), identityKey))
        }
      }
      case 'get_info':
        return {
          ok: true,
          fw_version: '0.0.7',
          board: 't-display-s3',
          note_count: [...held.values()].filter(note => note.state !== 'spent').length,
          ...(options.storage ? {storage: options.storage} : {storage: 'ok'}),
          capabilities: {buttons: 2, touch: false, gated: options.gated !== false, transports: ['serial']}
        }
      case 'list_notes': {
        const all = [...held.values()]
        const offset = Number(command.offset ?? 0)
        const limit = Math.min(Number(command.limit ?? 10), options.pageLimit ?? 10)
        const page = all.slice(offset, offset + limit)
        const next = offset + page.length
        return {
          ok: true,
          total: all.length,
          offset,
          notes: page.map(note => ({
            id: note.id,
            state: note.state,
            amount_msat: note.amountMsat,
            host: note.host,
            ...(note.label ? {label: note.label} : {})
          })),
          ...(next < all.length ? {next_offset: next} : {})
        }
      }
      case 'new_secret': {
        // The device makes the secret. Only its hash ever leaves.
        const k1 = bytesToHex(randomBytes(32))
        const noteId = bytesToHex(randomBytes(4))
        held.set(noteId, {
          id: noteId,
          k1,
          state: 'pending',
          amountMsat: 0,
          host: '',
          ...(typeof command.label === 'string' ? {label: command.label} : {})
        })
        return {ok: true, id: noteId, h: hashK1(k1)}
      }
      case 'confirm': {
        const note = held.get(id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'pending') return {ok: false, error: 'invalid_state'}
        note.state = 'confirmed'
        note.amountMsat = Number(command.amount_msat ?? 0)
        note.host = String(command.host ?? '')
        return {ok: true}
      }
      case 'discard': {
        const note = held.get(id)
        if (!note) return {ok: false, error: 'not_found'}
        held.delete(id)
        return {ok: true}
      }
      case 'export_secret': {
        const note = held.get(id)
        if (!note) return {ok: false, error: 'not_found'}
        if (note.state !== 'confirmed') return {ok: false, error: 'invalid_state'}
        const refused = gatedReply()
        if (refused) return refused
        return {ok: true, k1: note.k1}
      }
      case 'import_secret': {
        const k1 = String(command.k1 ?? '')
        const existing = [...held.values()].find(note => note.k1 === k1)
        if (existing) return {ok: true, id: existing.id}
        const noteId = bytesToHex(randomBytes(4))
        held.set(noteId, {
          id: noteId,
          k1,
          state: 'confirmed',
          amountMsat: Number(command.amount_msat ?? 0),
          host: String(command.host ?? '')
        })
        return {ok: true, id: noteId}
      }
      case 'mark_spent': {
        const note = held.get(id)
        if (!note) return {ok: false, error: 'not_found'}
        const refused = gatedReply()
        if (refused) return refused
        note.state = 'spent'
        return {ok: true}
      }
      default:
        return {ok: false, error: 'bad_request'}
    }
  }
  return {
    transport,
    held,
    seen,
    identityKey,
    pubkey: bytesToHex(ed25519.getPublicKey(identityKey)),
    // A note the device holds under its own secret, the way one arrives
    // there: minted or received elsewhere and imported.
    put: (k1: string, amountMsat: number, host: string) => {
      const noteId = bytesToHex(randomBytes(4))
      held.set(noteId, {id: noteId, k1, state: 'confirmed', amountMsat, host})
      return {id: noteId, state: 'confirmed' as const, amountMsat, host} satisfies VaultNote
    },
    decline: () => {
      approve = false
    }
  }
}

type Mint = Awaited<ReturnType<typeof createMockMint>>
const open: Mint[] = []
const start = async (): Promise<Mint> => {
  const mint = await createMockMint()
  open.push(mint)
  return mint
}
afterEach(async () => {
  for (const mint of open.splice(0)) await mint.close()
})

const walletAt = async (mint: Mint) => {
  const made = makeWallet()
  await made.wallet.addMint(`mint@${new URL(mint.url).host}`)
  return made
}

const fund = async (made: ReturnType<typeof makeWallet>, mint: Mint, msat: number) => {
  const k1 = freshK1()
  mint.state.creditNote(k1, msat)
  return (await made.wallet.receive(`${mint.url}/w?k1=${k1}&amount=${msat}`)).note
}

describe('taking a note off the vault', () => {
  it('collects it, rotates it here, and writes it off there', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)

    // a note the device holds, live at the mint
    const deviceK1 = freshK1()
    mint.state.creditNote(deviceK1, 30_000)
    const note = vault.put(deviceK1, 30_000, new URL(mint.url).host)

    const result = await collectFromVault(made.wallet, client, note)

    expect(result.clearedOnDevice).toBe(true)
    expect(result.received.note.amountMsat).toBe(30_000)
    expect(made.wallet.balanceMsat()).toBe(30_000)
    // receive() rotates, so the secret the device disclosed is dead - the
    // device could not spend it again even if it kept a copy
    expect(mint.state.noteState(deviceK1)).toBe('burned')
    expect(result.received.note.k1).not.toBe(deviceK1)
    expect(vault.held.get(note.id)?.state).toBe('spent')
  })

  it('does nothing at all when the release is declined on the device', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const vault = fakeVault()
    vault.decline()
    const client = new VaultClient(vault.transport)
    const deviceK1 = freshK1()
    mint.state.creditNote(deviceK1, 30_000)
    const note = vault.put(deviceK1, 30_000, new URL(mint.url).host)

    await expect(collectFromVault(made.wallet, client, note)).rejects.toThrow(/Declined on the device/)
    expect(made.wallet.balanceMsat()).toBe(0)
    expect(mint.state.noteState(deviceK1)).toBe('outstanding')
    expect(vault.held.get(note.id)?.state).toBe('confirmed')
  })

  it('keeps the money when only the second prompt is refused, and says so', async () => {
    // The release lands, the mint burns the secret, and the owner walks
    // away before the write-off prompt. The note is HERE; what is stale is
    // the device's own picture, and a caller told "failed" would go looking
    // for money that is already safe.
    const mint = await start()
    const made = await walletAt(mint)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)
    const deviceK1 = freshK1()
    mint.state.creditNote(deviceK1, 30_000)
    const note = vault.put(deviceK1, 30_000, new URL(mint.url).host)

    const original = vault.transport.request.bind(vault.transport)
    vault.transport.request = async (command, timeoutMs) =>
      command.cmd === 'mark_spent' ? {ok: false, error: 'timeout'} : original(command, timeoutMs)

    const result = await collectFromVault(made.wallet, client, note)
    expect(result.clearedOnDevice).toBe(false)
    expect(made.wallet.balanceMsat()).toBe(30_000)
    expect(vault.held.get(note.id)?.state).toBe('confirmed')
  })

  it('refuses a note from a mint this wallet has never met', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)
    const note = vault.put(freshK1(), 30_000, 'somewhere.example')

    await expect(collectFromVault(made.wallet, client, note)).rejects.toThrow(/does not know somewhere.example/)
    // nothing was even asked of the device
    expect(vault.seen).toHaveLength(0)
  })
})

describe('putting a note onto the vault', () => {
  it('never sends the secret across the cable', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const note = await fund(made, mint, 40_000)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)

    const result = await depositToVault(made.wallet, client, note)

    // The one assertion this whole design exists for: the device makes the
    // secret, and this wallet's own never goes anywhere near it.
    expect(JSON.stringify(vault.seen)).not.toContain(note.k1)
    expect(vault.seen.map(command => command.cmd)).toEqual(['new_secret', 'confirm'])

    expect(result.confirmedOnDevice).toBe(true)
    expect(made.wallet.balanceMsat()).toBe(0)
    expect(made.wallet.noteById(note.id)?.state).toBe('spent')
    expect(mint.state.noteState(note.k1)).toBe('burned')

    // and what the device now holds really is the money: its secret reads
    // back at the mint for the full amount
    const held = vault.held.get(result.deviceNoteId)!
    expect(held.state).toBe('confirmed')
    expect(held.amountMsat).toBe(40_000)
    const info = await fetchNoteInfo(buildNoteUrl(note.baseUrl, held.k1, 40_000))
    expect(info.maxWithdrawable).toBe(40_000)
  })

  it('leaves the note here untouched when the mint refuses', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const note = await fund(made, mint, 40_000)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)

    // A copy of the record as it is now, then the note is rotated behind
    // its back - so the copy still LOOKS live here while its secret is
    // already dead at the mint, which is what a stale record really is.
    const stale = {...note}
    await made.wallet.rotateLive(note)

    await expect(depositToVault(made.wallet, client, stale)).rejects.toThrow()
    // the device was asked for a secret, and it was dropped again
    expect(vault.seen.map(command => command.cmd)).toEqual(['new_secret', 'discard'])
    // the staged device secret was dropped rather than left dangling
    expect([...vault.held.values()]).toHaveLength(0)
    expect(made.wallet.balanceMsat()).toBe(40_000)
  })

  it('writes the note off here even when the device did not record it', async () => {
    // The mint has already rotated the value onto the device's secret by
    // the time confirm is sent. A wallet that kept its note listed because
    // the second half failed would be showing money that is gone.
    const mint = await start()
    const made = await walletAt(mint)
    const note = await fund(made, mint, 40_000)
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)
    const original = vault.transport.request.bind(vault.transport)
    vault.transport.request = async (command, timeoutMs) =>
      command.cmd === 'confirm' ? {ok: false, error: 'storage_full'} : original(command, timeoutMs)

    const result = await depositToVault(made.wallet, client, note)
    expect(result.confirmedOnDevice).toBe(false)
    expect(made.wallet.balanceMsat()).toBe(0)
    expect(made.wallet.noteById(note.id)?.state).toBe('spent')
    // the device holds it as pending, and the secret is still the money
    const held = vault.held.get(result.deviceNoteId)!
    expect(held.state).toBe('pending')
    const info = await fetchNoteInfo(buildNoteUrl(note.baseUrl, held.k1, 40_000))
    expect(info.maxWithdrawable).toBe(40_000)
  })
})

describe('telling one vault from another', () => {
  it('checks the signature over a nonce it chose itself', async () => {
    const vault = fakeVault()
    const client = new VaultClient(vault.transport)
    const first = await client.identify()
    expect(first.pubkey).toBe(vault.pubkey)

    // A different nonce every time. A fixed one would make this a
    // recording that anything holding it could play back.
    const second = await client.identify()
    expect(second.nonce).not.toBe(first.nonce)
    expect(second.pubkey).toBe(first.pubkey)
  })

  it('refuses an answer that does not actually sign the challenge', async () => {
    const vault = fakeVault()
    const other = ed25519.utils.randomSecretKey()
    const client = new VaultClient(vault.transport)
    const original = vault.transport.request.bind(vault.transport)
    vault.transport.request = async (command, timeoutMs) => {
      if (command.cmd !== 'identify') return original(command, timeoutMs)
      // the right shape, signed by somebody else, claiming the real key
      return {
        ok: true,
        pubkey: vault.pubkey,
        sig: bytesToHex(ed25519.sign(identityMessage(String(command.nonce)), other))
      }
    }
    await expect(client.identify()).rejects.toThrow(/does not check out/)
  })
})

describe('what the device says about itself', () => {
  it('pages through every note rather than believing one page', async () => {
    const mint = await start()
    const vault = fakeVault({pageLimit: 3})
    const client = new VaultClient(vault.transport)
    for (let index = 0; index < 7; index += 1) vault.put(freshK1(), 1_000, new URL(mint.url).host)

    const {notes, total} = await client.listNotes()
    expect(total).toBe(7)
    expect(notes).toHaveLength(7)
    expect(new Set(notes.map(note => note.id)).size).toBe(7)
  })

  it('carries the storage state, because an empty vault and an unreadable one look the same', async () => {
    const vault = fakeVault({storage: 'index_unreadable'})
    const client = new VaultClient(vault.transport)
    const info = await client.info()

    expect(info.noteCount).toBe(0)
    expect(info.storage).toBe('index_unreadable')
    expect(STORAGE_UNREADABLE.has(info.storage!)).toBe(true)
    // and the advice says the one thing that must not be done
    expect(storageAdvice(info.storage!)).toMatch(/Reboot it. Do NOT wipe/)
  })

  it('says plainly when a build cannot ask its owner anything', async () => {
    const mint = await start()
    const made = await walletAt(mint)
    const vault = fakeVault({gated: false})
    const client = new VaultClient(vault.transport)
    const deviceK1 = freshK1()
    mint.state.creditNote(deviceK1, 1_000)
    const note = vault.put(deviceK1, 1_000, new URL(mint.url).host)

    const info = await client.info()
    expect(info.capabilities?.gated).toBe(false)
    await expect(collectFromVault(made.wallet, client, note)).rejects.toThrow(VaultError)
    await expect(collectFromVault(made.wallet, client, note)).rejects.toThrow(
      /no on-device confirmation wired/
    )
    expect(mint.state.noteState(deviceK1)).toBe('outstanding')
  })
})
