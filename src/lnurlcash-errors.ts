// Notecase-owned policy errors retained from the pre-0.14 package surface.
// Wire/service errors come from @lnurlcash/kit; these describe local wallet
// formats or recovery decisions that the protocol package no longer owns.
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export class HashLookupUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HashLookupUnsupportedError'
  }
}
