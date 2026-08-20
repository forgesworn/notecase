// Engine turning, the way banknote engravers did it: overlapping rings of
// r(θ) = R + A·sin(kθ + φ), drawn as hairline strokes. Nothing here is a
// texture or an image - every line is computed, which is rather the point
// of putting one on a mint.

type Ring = {radius: number; amplitude: number; lobes: number; phase: number; opacity: number}

const ringPath = (ring: Ring, steps = 360): string => {
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI * 2
    const r = ring.radius + ring.amplitude * Math.sin(ring.lobes * theta + ring.phase)
    const x = (r * Math.cos(theta)).toFixed(2)
    const y = (r * Math.sin(theta)).toFixed(2)
    points.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`)
  }
  return points.join('') + 'Z'
}

// A rosette: the medallion form. Deterministic, so the mark is the mark.
export const rosette = (size: number, className = ''): string => {
  const rings: Ring[] = []
  const count = 9
  for (let i = 0; i < count; i++) {
    rings.push({
      radius: 34 + i * 5.2,
      amplitude: 7 + (i % 3) * 4,
      lobes: i % 2 === 0 ? 9 : 12,
      phase: (i * Math.PI) / count,
      opacity: 0.5 - i * 0.035
    })
  }
  const paths = rings
    .map(ring => `<path d="${ringPath(ring)}" opacity="${ring.opacity.toFixed(3)}"/>`)
    .join('')
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="-92 -92 184 184" fill="none" stroke="currentColor" stroke-width="0.55" aria-hidden="true">${paths}</svg>`
}

// A low band of interleaved waves, for the foot of a note: the lathe run
// straight instead of round. w/h in viewBox units.
export const band = (className = ''): string => {
  const w = 400
  const h = 26
  const lines: string[] = []
  for (let i = 0; i < 7; i++) {
    const mid = h / 2
    const amplitude = 3.5 + (i % 3) * 2.4
    const lobes = 6 + (i % 2) * 3
    const phase = (i * Math.PI) / 5
    const points: string[] = []
    for (let x = 0; x <= w; x += 4) {
      const y = mid + amplitude * Math.sin((x / w) * Math.PI * 2 * lobes + phase)
      points.push(`${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`)
    }
    lines.push(`<path d="${points.join('')}" opacity="${(0.4 - i * 0.04).toFixed(2)}"/>`)
  }
  return `<svg class="${className}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="0.6" aria-hidden="true">${lines.join('')}</svg>`
}
