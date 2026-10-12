import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

const W = "#fff";
const stroke = { fill: "none", stroke: W, strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };

// 1) Face search: brackets breathe in, a scan line sweeps the face, the face
//    "locks" (brackets snap tight + a soft glow), then everything relaxes. Loops.
export const FaceScan: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lock = spring({ frame: f - 40, fps, config: { damping: 11, stiffness: 180 } });
  const release = interpolate(f, [60, 72], [0, 1], { ...clamp, easing: Easing.inOut(Easing.ease) });
  const pull = interpolate(f, [0, 36], [0, 1], { ...clamp, easing: Easing.inOut(Easing.ease) });
  const inset = 1.2 * pull + 0.9 * lock * (1 - release);           // brackets move toward the face
  const scanY = interpolate(f, [6, 38], [7, 17], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const scanOn = interpolate(f, [4, 8, 36, 40], [0, 1, 1, 0], clamp);
  const glow = lock * (1 - release);
  const c = (x: number, y: number, dx: number, dy: number) => `M${x} ${y + dy * 3.4}V${y}H${x + dx * 3.4}`;
  const k = 1 - inset * 0.075;
  return (
    <AbsoluteFill>
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <defs>
          <filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={0.9 * glow} /></filter>
          <linearGradient id="scan" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={W} stopOpacity="0" /><stop offset="1" stopColor={W} stopOpacity=".9" />
          </linearGradient>
        </defs>
        <g {...stroke} transform={`translate(12 12) scale(${k}) translate(-12 -12)`}>
          <path d={c(4, 4, 1, 1)} /><path d={c(20, 4, -1, 1)} />
          <path d={c(4, 20, 1, -1)} /><path d={c(20, 20, -1, -1)} />
        </g>
        <g {...stroke} filter={glow > 0.05 ? "url(#g)" : undefined} opacity={glow * 0.9}>
          <circle cx="12" cy="11" r="3" /><path d="M7.5 17a5 5 0 0 1 9 0" />
        </g>
        <g {...stroke}><circle cx="12" cy="11" r="3" /><path d="M7.5 17a5 5 0 0 1 9 0" /></g>
        <rect x="6" y={scanY - 2.2} width="12" height="2.2" fill="url(#scan)" opacity={scanOn * 0.55} />
        <line x1="6" x2="18" y1={scanY} y2={scanY} stroke={W} strokeWidth="1.1" strokeLinecap="round" opacity={scanOn} />
      </svg>
    </AbsoluteFill>
  );
};

// 2) Share a moment: a camera; the shutter presses (camera dips, lens closes),
//    the flash bursts from the top corner, then it settles. Loops.
export const CameraFlash: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const press = interpolate(f, [16, 20, 26], [0, 1, 0], clamp);
  const burst = spring({ frame: f - 20, fps, config: { damping: 14, stiffness: 140 } });
  const fade = interpolate(f, [19, 21, 46], [0, 1, 0], { ...clamp, easing: Easing.out(Easing.quad) });
  const lensR = 3.5 - 1.4 * press;
  const ray = burst * 4.2;
  return (
    <AbsoluteFill>
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <defs><radialGradient id="fl"><stop offset="0" stopColor={W} /><stop offset="1" stopColor={W} stopOpacity="0" /></radialGradient></defs>
        <g transform={`translate(0 ${press * 0.8}) scale(1 ${1 - press * 0.04})`} style={{ transformOrigin: "12px 19px" }}>
          <g {...stroke}>
            <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z" />
            <circle cx="12" cy="13.5" r={lensR} />
          </g>
          <circle cx="12" cy="13.5" r={Math.max(0, lensR - 1.6)} fill={W} opacity={0.35 + 0.65 * press} />
          <circle cx="17.8" cy="10.8" r="0.7" fill={W} />
        </g>
        {/* flash: glow + four rays from the top-right corner */}
        <circle cx="18.5" cy="5" r={1 + 4 * burst} fill="url(#fl)" opacity={fade * 0.95} />
        <g stroke={W} strokeWidth="1.5" strokeLinecap="round" opacity={fade}>
          {[[-1, 0], [1, 0], [0, -1], [0, 1], [0.7, -0.7], [-0.7, -0.7]].map(([dx, dy], i) => (
            <line key={i} x1={18.5 + dx * (1 + ray * 0.35)} y1={5 + dy * (1 + ray * 0.35)} x2={18.5 + dx * (1.6 + ray)} y2={5 + dy * (1.6 + ray)} />
          ))}
        </g>
      </svg>
    </AbsoluteFill>
  );
};

// 3) Browse all: a 2-column wall of photo tiles scrolls up inside the frame,
//    each column at its own pace (like flicking through a gallery). Seamless loop.
export const BrowseTiles: React.FC = () => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = f / durationInFrames;
  const ease = (x: number) => x - Math.sin(2 * Math.PI * x) / (2 * Math.PI) * 0.6;   // gentle surge, still loops
  const tile = 6.5, gap = 1.5, step = tile + gap;   // one tile row = 9 units
  // each column repeats every `rows` tiles and moves exactly one repeat per loop -> seamless
  const col = (x: number, off: number, rows: number) => {
    const shift = ease(t) * step * rows;
    return Array.from({ length: rows * 2 + 3 }, (_, i) => (
      <rect key={i} x={x} y={4.5 + off + (i - 1) * step - shift} width={tile} height={tile} rx="1.6" opacity={0.92} />
    ));
  };
  return (
    <AbsoluteFill>
      <svg viewBox="0 0 24 24" width="100%" height="100%">
        <defs>
          <clipPath id="frame"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /></clipPath>
          <linearGradient id="fadeY" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#000" /><stop offset=".22" stopColor="#fff" /><stop offset=".78" stopColor="#fff" /><stop offset="1" stopColor="#000" />
          </linearGradient>
          <mask id="m"><rect x="0" y="0" width="24" height="24" fill="url(#fadeY)" /></mask>
        </defs>
        <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" {...stroke} strokeWidth={1.2} opacity={0.35} />
        <g clipPath="url(#frame)" fill={W}>
          {col(4.5, 0, 2)}
          {col(13, -4, 2)}
        </g>
      </svg>
    </AbsoluteFill>
  );
};
