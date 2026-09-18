// The minimal Canvas2D subset `renderPlot` (plot.ts) draws through (GRV-0022 acceptance, ADR-0002
// guard-rail 6, research §3): both `CanvasRenderingContext2D` (browser) and `@napi-rs/canvas`'s
// context satisfy this structurally, with no adapter -- `renderPlot` never imports either, so the
// same function runs unchanged in the page and under Node (src/headless/render.ts,
// tests/render/*.test.ts). Only what plot.ts and bodies.ts actually call is listed here (YAGNI).
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: 'left' | 'right' | 'center' | 'start' | 'end';
  textBaseline: 'top' | 'middle' | 'bottom' | 'alphabetic' | 'hanging' | 'ideographic';
}
