import React, { useEffect, useState } from 'react';

interface StartScreenProps {
  /** Turn the camera on and land on the activity log. */
  onQuickStart: () => void;
  /** Land on the environment page to describe the deployment first. */
  onSetup: () => void;
  /** Backend reachability, mirroring the top bar — worth knowing before choosing. */
  connected: boolean;
  /** True once the environment has been configured at least once. */
  configured: boolean | null;
}

const OPTIONS = [
  {
    id: 'quick' as const,
    title: 'Quick Start',
    tagline: 'Start monitoring now',
    accent: 'blue',
    detail:
      'Turns your camera on and goes straight to the activity log. Detections begin immediately using the current settings.',
    cta: 'Start camera →',
  },
  {
    id: 'setup' as const,
    title: 'Setup',
    tagline: 'Tune it to this place first',
    accent: 'amber',
    detail:
      'Describe the environment and let the agents adjust thresholds, time rules, and which events this deployment should look for.',
    cta: 'Configure →',
  },
];

/** Tailwind needs whole class names, so accents are spelled out per variant. */
const ACCENT: Record<string, { border: string; text: string; button: string }> = {
  blue: {
    border: 'border-blue-600/40 hover:border-blue-500 hover:bg-blue-500/5',
    text: 'text-blue-300',
    button: 'bg-blue-600 group-hover:bg-blue-500',
  },
  amber: {
    border: 'border-amber-600/40 hover:border-amber-500 hover:bg-amber-500/5',
    text: 'text-amber-300',
    button: 'bg-amber-600 group-hover:bg-amber-500',
  },
};

/* ── Security camera outline ──────────────────────────────────────────────── */

/**
 * The outline is drawn in pieces so each can start off-screen and converge.
 * `from` is the piece's offset at the start, in viewBox units — large enough
 * on the x axis to clear the widest viewport before the stage clips it.
 * `delay` staggers the arrivals so the camera assembles rather than snapping.
 */
interface Piece {
  id: string;
  d?: string;
  circle?: { cx: number; cy: number; r: number };
  from: [number, number];
  delay: number;
  width?: number;
}

const VIEW_W = 560;
// Tall enough to hold the camera up top and the floor scene beneath it.
const VIEW_H = 420;

/** Ceiling mount, bracket, and the housing hanging off it. */
const PIECES: Piece[] = [
  { id: 'ceiling', d: 'M150 44 L410 44', from: [-1400, 0], delay: 0 },
  { id: 'bracket', d: 'M246 44 L246 76 L314 76 L314 44', from: [0, -520], delay: 0.06 },
  { id: 'stem', d: 'M280 76 L280 104', from: [0, -520], delay: 0.1 },
  // Sun shade over the housing.
  { id: 'hood', d: 'M222 128 L222 112 Q222 98 236 98 L324 98 Q338 98 338 112 L338 128', from: [1400, -220], delay: 0.14 },
  // Housing body, rounded at the front.
  { id: 'body', d: 'M232 128 L232 186 Q232 212 258 212 L302 212 Q328 212 328 186 L328 128', from: [-1400, 220], delay: 0.2 },
  // Sits between the housing top (128) and the lens rim (148) — any lower and
  // it cuts across the outer circle.
  { id: 'seam', d: 'M234 138 L326 138', from: [1400, 0], delay: 0.3 },
  { id: 'lens-outer', circle: { cx: 280, cy: 178, r: 30 }, from: [-1400, 320], delay: 0.26 },
  { id: 'lens-inner', circle: { cx: 280, cy: 178, r: 15 }, from: [1400, 320], delay: 0.34, width: 3.5 },
];

/** Fraction of the build each piece spends travelling. */
const PIECE_SPAN = 0.55;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Decelerating ease — things arrive settling rather than braking hard. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Sharper version, for the camera pieces: they fly in and drift together. */
const easeOutHard = (t: number) => 1 - Math.pow(1 - t, 4);

/** Carve a sub-range out of a 0..1 driver, itself normalised to 0..1. */
const phase = (progress: number, start: number, end: number) =>
  clamp01((progress - start) / (end - start));

/* ── Timeline ─────────────────────────────────────────────────────────────── */

/** Camera assembly. The driver is linear; the per-piece ease does the slowing. */
const BUILD_DURATION_MS = 3000;

/** Beat between the camera settling and the figure appearing. */
const HOLD_MS = 250;

/** How long the figure takes to walk in and get lit up, once it starts. */
const SCENE_DURATION_MS = 4300;

const TOTAL_MS = BUILD_DURATION_MS + HOLD_MS + SCENE_DURATION_MS;

/* ── Figure walking in ────────────────────────────────────────────────────── */

const FIGURE_START_X = -120;  // off the left edge, with room for the scale below
const FIGURE_END_X = 280;     // directly under the camera
const FIGURE_FEET_Y = 368;

/** Radius of the light pool. Comfortably larger than the ~93-unit figure. */
const LIGHT_RADIUS = 86;

/**
 * The camera and the floor scene are drawn at their own scales rather than
 * being re-measured piece by piece. Each grows or shrinks about a fixed anchor
 * so the parts that should stay put do: the camera about its ceiling mount, the
 * figure about the spot its feet stand on.
 */
const CAMERA_SCALE = 1.22;
const CAMERA_ANCHOR: [number, number] = [280, 44];
/** Lifts the whole camera clear of the light pool below it. */
const CAMERA_OFFSET_Y = -26;
const FIGURE_SCALE = 0.78;
const FIGURE_ANCHOR: [number, number] = [FIGURE_END_X, FIGURE_FEET_Y];

const scaleAbout = ([ax, ay]: [number, number], k: number) =>
  `translate(${ax} ${ay}) scale(${k}) translate(${-ax} ${-ay})`;

/**
 * Stick figure, drawn from the feet up so the walk is a single translate.
 *
 * Limbs swing off one sine wave that decays to nothing as they arrive, so the
 * last stride settles into a stand rather than freezing mid-step.
 */
const StickFigure: React.FC<{ walk: number }> = ({ walk }) => {
  const x = FIGURE_START_X + (FIGURE_END_X - FIGURE_START_X) * easeOut(walk);
  const swing = Math.sin(walk * Math.PI * 6) * (1 - walk);
  // Once stopped, the swing is gone — this opens the stance so the limbs do
  // not collapse into a single line.
  const stance = 12 * walk;
  const legA = 16 * swing + stance;
  const legB = -16 * swing - stance;
  // Arms lead with the opposite side, the way a real gait does.
  const armA = -14 * swing - 0.8 * stance;
  const armB = 14 * swing + 0.8 * stance;

  return (
    <g
      transform={`translate(${x} ${FIGURE_FEET_Y})`}
      opacity={clamp01(walk / 0.12)}
    >
      <circle cx={0} cy={-80} r={13} />
      <path d="M0 -67 L0 -30" />
      <path d={`M${armA.toFixed(1)} -34 L0 -58 L${armB.toFixed(1)} -34`} />
      <path d={`M${legA.toFixed(1)} 0 L0 -30 L${legB.toFixed(1)} 0`} />
    </g>
  );
};

/** The pool of light the camera throws over whoever it has found. */
const Searchlight: React.FC<{ walk: number; lit: number }> = ({ walk, lit }) => {
  const x = FIGURE_START_X + (FIGURE_END_X - FIGURE_START_X) * easeOut(walk);
  const eased = easeOut(lit);
  return (
    <g transform={`translate(${x} ${FIGURE_FEET_Y})`} opacity={eased}>
      <circle
        cx={0}
        cy={-47}
        // Opening up rather than fading in flat reads as a beam widening.
        r={LIGHT_RADIUS * (0.55 + 0.45 * eased)}
        fill="url(#searchlight)"
        stroke="white"
        strokeOpacity={0.4}
        strokeWidth={1.5}
      />
    </g>
  );
};

const PieceGroup: React.FC<{ piece: Piece; progress: number }> = ({ piece, progress }) => {
  const local = easeOutHard(clamp01((progress - piece.delay) / PIECE_SPAN));
  const [fx, fy] = piece.from;
  const remaining = 1 - local;
  return (
    <g
      transform={`translate(${fx * remaining} ${fy * remaining})`}
      // Fading in over the first stretch of travel keeps the edges of the
      // stage from looking like pieces are being flung past it.
      opacity={clamp01(local * 2.5)}
      strokeWidth={piece.width}
    >
      {piece.d ? (
        <path d={piece.d} />
      ) : piece.circle ? (
        <circle cx={piece.circle.cx} cy={piece.circle.cy} r={piece.circle.r} />
      ) : null}
    </g>
  );
};

/**
 * `build` assembles the camera, `scene` runs the figure walking in and being
 * lit. Both come off the same clock; see the timeline constants above.
 */
const CameraScene: React.FC<{ build: number; scene: number }> = ({ build, scene }) => {
  // The walk takes the larger share of a longer scene, so slowing it down does
  // not drag the searchlight out with it.
  const walk = phase(scene, 0, 0.7);
  const lit = phase(scene, 0.66, 1);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      fill="none"
      stroke="white"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Pieces sit far outside the viewBox before they converge, so this must not clip.
      className="w-full h-full overflow-visible"
    >
      <defs>
        <radialGradient id="searchlight">
          <stop offset="0%" stopColor="white" stopOpacity="0.3" />
          <stop offset="60%" stopColor="white" stopOpacity="0.13" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g transform={`translate(0 ${CAMERA_OFFSET_Y}) ${scaleAbout(CAMERA_ANCHOR, CAMERA_SCALE)}`}>
        {PIECES.map((piece) => (
          <PieceGroup key={piece.id} piece={piece} progress={build} />
        ))}
      </g>

      <g transform={scaleAbout(FIGURE_ANCHOR, FIGURE_SCALE)}>
        {/* Light first, so the figure stays legible on top of it. */}
        {lit > 0 && <Searchlight walk={walk} lit={lit} />}
        {walk > 0 && <StickFigure walk={walk} />}
      </g>
    </svg>
  );
};

/* ── Screen ───────────────────────────────────────────────────────────────── */

export const StartScreen: React.FC<StartScreenProps> = ({
  onQuickStart, onSetup, connected, configured,
}) => {
  const handlers = { quick: onQuickStart, setup: onSetup };

  // Anyone who has asked for less motion gets the finished scene immediately.
  const [reducedMotion] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );

  // One clock drives the whole opening: the camera assembles, holds a beat,
  // then the figure walks in and is lit. It runs once and stops — no idle loop
  // ticking behind the buttons afterwards.
  const [elapsed, setElapsed] = useState(reducedMotion ? TOTAL_MS : 0);
  useEffect(() => {
    if (reducedMotion) return;
    let raf = 0;
    let start = 0;
    const tick = (now: number) => {
      if (!start) start = now;
      const t = now - start;
      setElapsed(t);
      if (t < TOTAL_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion]);

  const build = clamp01(elapsed / BUILD_DURATION_MS);
  const scene = clamp01((elapsed - BUILD_DURATION_MS - HOLD_MS) / SCENE_DURATION_MS);

  return (
    <div className="h-screen overflow-y-auto overflow-x-hidden bg-dash-bg text-gray-100">
      <div className="min-h-screen flex flex-col items-center justify-center px-6 py-8">
        <div className="w-full max-w-4xl flex flex-col items-center">
          {/* Same face as the Setup page heading, but sized off the viewport so
              all 26 characters stay on one line at any width — hence the
              override of aurora-title's own clamp. */}
          <h1
            className="aurora-text aurora-title aurora-compact text-center whitespace-nowrap
              text-[clamp(1.125rem,3.4vw,3rem)]"
          >
            Anomaly Explanation Engine
            <span className="aurora" aria-hidden="true">
              <span className="aurora__item" />
              <span className="aurora__item" />
              <span className="aurora__item" />
              <span className="aurora__item" />
            </span>
          </h1>
          <p className="text-gray-500 mt-3 text-center text-[clamp(0.8125rem,1.5vw,1.0625rem)]">
            Detection events, reasoned over and explained.
          </p>

          {/* Stage. Width-capped against viewport height so a short window
              shrinks the camera rather than crowding out the buttons. */}
          <div
            className="relative w-full my-4 shrink-0"
            style={{ maxWidth: 'min(30rem, 46vh)', aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
          >
            <CameraScene build={build} scene={scene} />
          </div>

          <div className="flex items-center gap-2 mb-5">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                connected ? 'bg-green-500' : 'bg-red-500 animate-pulse-fast'
              }`}
            />
            <span className="font-mono text-xs text-gray-500">
              {connected ? 'backend connected' : 'backend unreachable — start the server'}
            </span>
          </div>

          {/* Always interactive — the animation is decoration, not a gate. */}
          <div className="grid gap-4 sm:grid-cols-2 w-full">
            {OPTIONS.map((opt) => {
              const accent = ACCENT[opt.accent];
              return (
                <button
                  key={opt.id}
                  onClick={handlers[opt.id]}
                  className={`group text-left rounded-lg border bg-dash-panel p-4 flex flex-col
                    transition-colors duration-150 ${accent.border}`}
                >
                  <h2 className={`font-mono text-xs font-semibold tracking-widest uppercase ${accent.text}`}>
                    {opt.title}
                  </h2>
                  <p className="text-sm text-gray-200 mt-1">{opt.tagline}</p>
                  <p className="text-xs text-gray-500 leading-relaxed mt-2">{opt.detail}</p>
                  <span
                    className={`mt-4 self-start px-3 py-1.5 rounded text-xs font-semibold text-white
                      transition-colors duration-150 ${accent.button}`}
                  >
                    {opt.cta}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="text-xs text-gray-600 text-center mt-6">
            {configured === false
              ? 'No environment configured yet — Setup takes a minute and makes the detections a lot less noisy.'
              : 'Either way, you can switch between the tabs at any time.'}
          </p>
        </div>
      </div>
    </div>
  );
};
