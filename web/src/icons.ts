// Inline stroke icons, one visual family, sized by the CSS that places
// them. Icon-first UI: every action reads at a glance before any label.

const svg = (body: string, viewBox = '0 0 24 24'): string =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="14" rx="4.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 10h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="14.5" y="11.5" width="5.5" height="4" rx="2" fill="currentColor"/></svg>`,
  receive: svg('<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M4.5 20h15"/>'),
  send: svg('<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M4.5 4h15"/>'),
  mint: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8.2v7.6"/><path d="M15 9.8c-.6-1-1.7-1.6-3-1.6-1.8 0-3.2 1-3.2 2.4 0 3 6.4 1.6 6.4 4.4 0 1.4-1.4 2.4-3.2 2.4-1.3 0-2.4-.6-3-1.6"/>'),
  melt: svg('<path d="M13 3 5.5 13.5H11L9.5 21 17 10.5h-5.5L13 3z"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.15-1.44l2.02-1.57-2-3.46-2.37.96a7 7 0 0 0-2.5-1.45L13.7 2.5h-3.4l-.3 2.54a7 7 0 0 0-2.5 1.45l-2.37-.96-2 3.46 2.02 1.57a7 7 0 0 0 0 2.88L3.13 15l2 3.46 2.37-.96a7 7 0 0 0 2.5 1.45l.3 2.55h3.4l.3-2.55a7 7 0 0 0 2.5-1.45l2.37.96 2-3.46-2.02-1.56A7 7 0 0 0 19 12z"/>'),
  back: svg('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10" rx="3"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'),
  face: svg('<path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8"/><path d="M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8"/><path d="M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16"/><path d="M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16"/><path d="M8.5 9.5v1.5"/><path d="M15.5 9.5v1.5"/><path d="M9 15.2c.8.8 1.9 1.3 3 1.3s2.2-.5 3-1.3"/>'),
  backspace: svg('<path d="M8.5 5h11A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11L3 12l5.5-7z"/><path d="m11.5 9.5 5 5"/><path d="m16.5 9.5-5 5"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>'),
  paste: svg('<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 12h6"/><path d="M9 16h4"/>'),
  refresh: svg('<path d="M20 11.5A8 8 0 1 0 18.4 17"/><path d="M20 5v6.5h-6.5"/>'),
  check: svg('<path d="m4.5 12.5 5 5 10-11"/>'),
  note: svg('<rect x="2.5" y="6" width="19" height="12" rx="3"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01"/><path d="M18 14.5v.01"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  bolt: svg('<path d="M13 2 4.5 13.5H11L9.5 22 18 10.5h-6.5L13 2z"/>'),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg(
    '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="m4.5 4.5 15 15"/>'
  ),
  history: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.5"/>'),
  scan: svg('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>'),
  share: svg('<circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="m8.4 10.8 6.8-4"/><path d="m8.4 13.2 6.8 4"/>'),
  star: svg('<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8L12 3.5z"/>'),
  trash: svg('<path d="M4.5 6.5h15"/><path d="M8 6.5V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5"/><path d="M6.5 6.5 7.5 20a1.5 1.5 0 0 0 1.5 1h6a1.5 1.5 0 0 0 1.5-1l1-13.5"/><path d="M10 10.5v6"/><path d="M14 10.5v6"/>'),
  shield: svg('<path d="M12 2.5 4.5 5.5v6c0 4.6 3.2 8 7.5 10 4.3-2 7.5-5.4 7.5-10v-6L12 2.5z"/><path d="m8.8 12 2.2 2.2 4.2-4.6"/>'),
  download: svg('<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>'),
  upload: svg('<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 19.5h15"/>'),
  chevron: svg('<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>'),
  x: svg('<path d="m6 6 12 12"/><path d="m18 6-12 12"/>'),
  qr: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M13.5 13.5h3v3h-3z"/><path d="M20.5 13.5v3"/><path d="M13.5 20.5h3"/><path d="M20.5 20.5v.01"/>'),
  wallet: svg('<rect x="2.5" y="6" width="19" height="13" rx="3.5"/><path d="M2.5 10h12"/><rect x="15" y="11.5" width="4.5" height="3.5" rx="1.75" fill="currentColor" stroke="none"/>'),
  undo: svg('<path d="M8.5 5 4 9.5 8.5 14"/><path d="M4 9.5h9.5a6 6 0 0 1 0 12H9"/>'),
  hourglass: svg('<path d="M6.5 3h11"/><path d="M6.5 21h11"/><path d="M8 3v3.5c0 2.5 4 4 4 5.5s-4 3-4 5.5V21"/><path d="M16 3v3.5c0 2.5-4 4-4 5.5s4 3 4 5.5V21"/>'),
  tag: svg('<path d="M20.5 12.5 12.5 20.5a2.5 2.5 0 0 1-3.5 0l-5.5-5.5a2.5 2.5 0 0 1 0-3.5l8-8H19a2 2 0 0 1 2 2v6.5z"/><circle cx="16.5" cy="7.5" r="1.2"/>'),
  offline: svg('<path d="M13 2 4.5 13.5H11L9.5 22 18 10.5h-6.5L13 2z"/><path d="m3 3 18 18"/>'),
  drawer: svg('<rect x="3" y="5" width="18" height="6" rx="1.5"/><rect x="3" y="13" width="18" height="6" rx="1.5"/><path d="M10 8h4"/><path d="M10 16h4"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11.2V16"/><path d="M12 8v.01"/>')
} as const

export type IconName = keyof typeof icons
