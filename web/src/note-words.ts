// Denominations in words, the way a note engraver would set them.
// Integers 1..999999; anything else falls back to digits.

const UNITS = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE']
const TEENS = ['TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']

const belowThousand = (n: number): string => {
  const parts: string[] = []
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  if (hundreds) parts.push(`${UNITS[hundreds]} HUNDRED`)
  if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10]!)
  else {
    const tens = Math.floor(rest / 10)
    const units = rest % 10
    if (tens) parts.push(TENS[tens]!)
    if (units) parts.push(UNITS[units]!)
  }
  return parts.join(' ')
}

export const amountInWords = (sats: number): string => {
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > 999_999_999_999) {
    return sats.toLocaleString('en-GB').replace(/,/g, ' ')
  }
  const parts: string[] = []
  const groups: Array<[number, string]> = [
    [1_000_000_000, 'BILLION'],
    [1_000_000, 'MILLION'],
    [1_000, 'THOUSAND']
  ]
  let rest = sats
  for (const [size, name] of groups) {
    const count = Math.floor(rest / size)
    if (count) parts.push(`${belowThousand(count)} ${name}`)
    rest %= size
  }
  if (rest) parts.push(belowThousand(rest))
  return parts.join(' ')
}
