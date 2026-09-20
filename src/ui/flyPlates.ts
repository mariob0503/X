/** Short-lived plate sprites that arc from a player zone toward the dumbbell (or miss toward opponent). */

export interface FlyPlateSpawn {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  quality: number;
  count?: number;
  /** If true, plate is a miss trajectory (extra wild arc). */
  miss?: boolean;
}

interface FlyPlate {
  el: HTMLDivElement;
  t0: number;
  dur: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  arc: number;
  rot0: number;
  rot1: number;
}

export class FlyPlateLayer {
  private root: HTMLElement;
  private plates: FlyPlate[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
  }

  spawn(opts: FlyPlateSpawn): void {
    const n = opts.count ?? 1 + Math.floor(Math.random() * 3);
    const good = opts.quality >= 0.55;
    const color = opts.miss
      ? '#ffcc33'
      : good
        ? '#06E113'
        : `rgb(${220 + Math.floor((1 - opts.quality) * 35)}, ${40 + Math.floor(opts.quality * 40)}, ${55})`;

    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'fly-plate' + (opts.miss ? ' fly-plate-miss' : '');
      el.style.setProperty('--plate-color', color);
      el.style.borderColor = color;
      this.root.appendChild(el);

      const jitterX = (Math.random() - 0.5) * (opts.miss ? 28 : 8);
      const jitterY = (Math.random() - 0.5) * (opts.miss ? 28 : 18);
      const plate: FlyPlate = {
        el,
        t0: performance.now(),
        dur: (opts.miss ? 520 : 380) + Math.random() * 220,
        x0: opts.fromX + jitterX * 0.35,
        y0: opts.fromY + (Math.random() - 0.5) * 10,
        x1: opts.miss ? opts.toX + jitterX : opts.toX + jitterX * 0.25,
        y1: opts.toY + jitterY,
        arc: opts.miss ? -40 - Math.random() * 40 : -80 - Math.random() * 70,
        rot0: (Math.random() - 0.5) * 40,
        rot1: (Math.random() - 0.5) * (opts.miss ? 420 : 280),
      };
      this.plates.push(plate);
      this.paint(plate, 0);
    }
  }

  update(now = performance.now()): void {
    const keep: FlyPlate[] = [];
    for (const p of this.plates) {
      const u = (now - p.t0) / p.dur;
      if (u >= 1) {
        p.el.remove();
        continue;
      }
      this.paint(p, easeOutCubic(u));
      keep.push(p);
    }
    this.plates = keep;
  }

  clear(): void {
    for (const p of this.plates) p.el.remove();
    this.plates = [];
  }

  private paint(p: FlyPlate, u: number): void {
    const x = p.x0 + (p.x1 - p.x0) * u;
    const y = p.y0 + (p.y1 - p.y0) * u + p.arc * Math.sin(Math.PI * u);
    const rot = p.rot0 + (p.rot1 - p.rot0) * u;
    const scale = 1.05 - u * 0.35;
    const opacity = u < 0.12 ? u / 0.12 : u > 0.75 ? (1 - u) / 0.25 : 1;
    p.el.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${scale})`;
    p.el.style.opacity = String(Math.max(0, opacity));
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
