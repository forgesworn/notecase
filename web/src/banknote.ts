import {renderSVG} from 'uqr'
import {rosette} from './guilloche.ts'
import {amountInWords} from './note-words.ts'

// The note as the mint prints it: full intaglio artwork (engraved plates,
// no text baked in) with every word, numeral, serial and QR letterpressed
// over it in HTML, so any denomination prints. The silver series -
// graphite and steel-blue on pale silver paper. Shared design language
// with the moneyer mint: a note minted there looks the same held here.
//
// Zones are percentages of the plate, measured off the artwork. The
// portrait plate carries the live note (its square panel takes the QR);
// the landscape plate prints the wide-screen specimen. Type is sized in
// cqw so the print scales with the paper.

const esc = (value: string): string => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

// A circular seal: text on a ring around a small rosette, pure SVG. The
// ring reads the case's own motto - the issuing mint is named on the
// ledger beneath the note, not forged onto its face.
const seal = (): string => {
  const inner = rosette(64).replace('<svg ', '<svg x="28" y="28" ')
  return `<svg class="nb-seal" viewBox="0 0 120 120" aria-hidden="true">
    <defs><path id="sealring" d="M60 14a46 46 0 1 1-.01 0z"/></defs>
    <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="60" cy="60" r="44" fill="none" stroke="currentColor" stroke-width="0.8"/>
    <text font-size="9.5" letter-spacing="2.2" fill="currentColor" font-family="IBM Plex Mono, monospace">
      <textPath href="#sealring" startOffset="0">NOTECASE · MONEY AS A SECRET ·</textPath>
    </text>
    ${inner}
  </svg>`
}

// Corner numerals compact past a million - fifteen digits in a forty-pixel
// medallion is nobody's denomination.
const cornerText = (sats: number): string => {
  const compact = (value: number, suffix: string): string => {
    const short = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
    return `${short}${suffix}`
  }
  if (sats >= 1_000_000_000) return compact(sats / 1_000_000_000, 'B')
  if (sats >= 1_000_000) return compact(sats / 1_000_000, 'M')
  return sats.toLocaleString('en-GB').replace(/,/g, ' ')
}

const corner = (sats: number, at: 'tl' | 'tr', withValue: boolean): string => {
  const text = cornerText(sats)
  const size = Math.min(4.6, 26 / Math.max(text.length, 2))
  return `<b class="nb-corner ${at}" style="font-size:${size.toFixed(2)}cqw"${withValue ? ' data-value' : ''}>${text}</b>`
}

export type BanknoteArgs = {
  sats: number
  serialHex: string
  host: string
  variant: {kind: 'specimen'} | {kind: 'live'; qrText: string}
}

export const banknote = (args: BanknoteArgs): HTMLElement => {
  const serial = `${args.serialHex.slice(0, 4)}…${args.serialHex.slice(-4)}`.toUpperCase()
  const words = amountInWords(args.sats)
  const live = args.variant.kind === 'live'

  // The two prints share the cartouche stack; the zones differ per plate.
  // The oval narrows at its foot, so the portrait serial travels light -
  // the seal and the QR itself carry the issuer.
  const cartouche = (foot: boolean, withHost: boolean): string => `
    <div class="nb-cartouche">
      <div class="nb-title">LNURLCASH<br/> BEARER NOTE</div>
      <div class="nb-words${words.length > 14 ? ' long' : ''}">${esc(words)}</div>
      <div class="nb-sats">SATS</div>
      <div class="nb-promise">Pays the bearer on demand,<br/>no questions asked</div>
      ${foot ? `<div class="nb-foot">32 BYTES · A CLAIM ON A VERY SMALL NODE<br/>NOT LEGAL TENDER</div>` : ''}
      <div class="nb-serial">Nº ${esc(serial)} · SERIES 2026${withHost ? ` · ${esc(args.host)}` : ''}</div>
    </div>`

  const template = document.createElement('template')
  if (live) {
    const qr = renderSVG((args.variant as {qrText: string}).qrText, {border: 1})
    template.innerHTML = `
    <div class="nb nb--p" role="img" aria-label="A bearer note for ${args.sats} sats">
      ${corner(args.sats, 'tl', true)}${corner(args.sats, 'tr', false)}
      ${cartouche(false, false)}
      <div class="nb-panel nb-panel--captioned">
        <div class="covered">
          <div class="qr nb-qr" role="img" aria-label="The note itself">${qr}</div>
          <canvas class="scratch-foil" tabindex="0" role="button" aria-label="Scratch away the silver to reveal the code. Press Enter to reveal it at once."></canvas>
        </div>
        <div class="nb-panelfoot"><span>32 BYTES · A CLAIM ON A VERY SMALL NODE</span><br/><span>· NOT LEGAL TENDER ·</span></div>
      </div>
      ${seal()}
    </div>`
  } else {
    // The specimen prints twice: the landscape plate for wide screens, the
    // portrait plate for narrow ones. CSS shows exactly one.
    template.innerHTML = `
    <div class="nb-specimen-pair" aria-label="A specimen bearer note">
      <div class="nb nb--l" role="img">
        ${corner(args.sats, 'tl', false)}${corner(args.sats, 'tr', false)}
        ${cartouche(true, true)}
        <div class="nb-overstamp">SPECIMEN</div>
      </div>
      <div class="nb nb--p" role="img">
        ${corner(args.sats, 'tl', false)}${corner(args.sats, 'tr', false)}
        ${cartouche(false, false)}
        <div class="nb-panel"><div class="nb-foot nb-foot--panel">32 BYTES<br/>A CLAIM ON A<br/>VERY SMALL NODE<br/>· NOT LEGAL TENDER ·</div></div>
        ${seal()}
        <div class="nb-overstamp">SPECIMEN</div>
      </div>
    </div>`
  }
  return template.content.firstElementChild as HTMLElement
}
