import {afterEach, describe, expect, it} from 'vitest'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initWallet, openWallet, WrongPinError, WalletExistsError} from '../src/store.ts'

const homes: string[] = []
const tempHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'notecase-'))
  homes.push(home)
  return home
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, {recursive: true, force: true})
})

describe('the wallet store', () => {
  it('round-trips an encrypted wallet through the PIN', async () => {
    const home = tempHome()
    const store = await initWallet({pin: '123456', home})
    store.data.settings.defaultMintHost = 'mint.example'
    await store.save()

    const reopened = await openWallet({pin: '123456', home})
    expect(reopened.data.settings.defaultMintHost).toBe('mint.example')
    expect(reopened.encrypted).toBe(true)
  })

  it('refuses the wrong PIN and a missing PIN', async () => {
    const home = tempHome()
    await initWallet({pin: '123456', home})
    await expect(openWallet({pin: '654321', home})).rejects.toThrow(WrongPinError)
    await expect(openWallet({home})).rejects.toThrow(WrongPinError)
  })

  it('never writes secrets to disk in the clear when encrypted', async () => {
    const home = tempHome()
    const store = await initWallet({pin: '123456', home})
    store.data.settings.nwcUri = 'nostr+walletconnect://deadbeef?relay=wss%3A%2F%2Fr&secret=cafebabe'
    await store.save()
    const raw = readFileSync(join(home, 'wallet.json'), 'utf8')
    expect(raw).not.toContain('walletconnect')
    expect(raw).not.toContain('cafebabe')
  })

  it('supports the explicitly insecure plaintext mode', async () => {
    const home = tempHome()
    const store = await initWallet({home})
    expect(store.encrypted).toBe(false)
    store.data.settings.defaultMintHost = 'mint.example'
    await store.save()
    const reopened = await openWallet({home})
    expect(reopened.data.settings.defaultMintHost).toBe('mint.example')
  })

  it('refuses to overwrite an existing wallet', async () => {
    const home = tempHome()
    await initWallet({pin: '123456', home})
    await expect(initWallet({pin: '000000', home})).rejects.toThrow(WalletExistsError)
  })
})
