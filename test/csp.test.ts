import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// The web wallet's content policy has to live in two places. A meta
// element covers everything the build can say for itself, but
// `frame-ancestors` is ignored there by specification: a page carrying it
// in the HTML alone has no clickjacking protection at all, and only a
// response header from the host gives it any. So the README documents the
// header the host must send, and these tests hold the two copies to the
// same string - a security policy that disagrees with itself protects
// whichever half the browser happened to read.

const at = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

const metaPolicy = (): string => {
  const found = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(
    at('../web/index.html')
  )
  if (!found?.[1]) throw new Error('web/index.html has no Content-Security-Policy meta tag')
  return found[1]
}

const headerPolicy = (): string => {
  const found = /Content-Security-Policy "([^"]+)"/.exec(at('../README.md'))
  if (!found?.[1]) throw new Error('README documents no Content-Security-Policy header')
  return found[1]
}

const directives = (policy: string): Map<string, string> =>
  new Map(
    policy
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const at = part.indexOf(' ')
        return at === -1 ? ([part, ''] as const) : ([part.slice(0, at), part.slice(at + 1)] as const)
      })
  )

describe('the content policy', () => {
  it('is one policy, whether it arrives as a tag or a header', () => {
    expect(headerPolicy()).toBe(metaPolicy())
  })

  it('lets nothing but our own bundle run', () => {
    const script = directives(metaPolicy()).get('script-src')
    expect(script).toBe("'self'")
    expect(script).not.toContain('unsafe-eval')
  })

  it('refuses framing, a rewritten base and a form post', () => {
    const found = directives(metaPolicy())
    // A wallet in somebody else's iframe is a wallet being clicked for
    // you; a rewritten <base> re-points every relative URL, including the
    // one the bundle loads from.
    expect(found.get('frame-ancestors')).toBe("'none'")
    expect(found.get('base-uri')).toBe("'none'")
    expect(found.get('form-action')).toBe("'none'")
  })

  it('is documented with the header that makes frame-ancestors count', () => {
    // frame-ancestors in the meta tag is decoration. This is the line
    // that actually stops the framing, so it must be in what an operator
    // copies.
    expect(at('../README.md')).toContain('X-Frame-Options DENY')
  })
})
