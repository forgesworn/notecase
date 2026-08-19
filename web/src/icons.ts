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
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>')
} as const

export type IconName = keyof typeof icons
