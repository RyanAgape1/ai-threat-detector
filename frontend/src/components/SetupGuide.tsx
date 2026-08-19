import React from 'react';

interface SetupGuideProps {
  /** Continue on to the environment page itself. */
  onContinue: () => void;
  /** Return to the landing screen. */
  onBack: () => void;
}

/**
 * Steps are written for whoever actually runs the shop, not for whoever built
 * this. No thresholds, no confidence values, no event types — just what to type
 * in each box and what changes as a result.
 */
const STEPS = [
  {
    n: '1',
    title: 'Tell it where the cameras are',
    body:
      'Pick the kind of place you are watching — a shop, a warehouse, a car park, an office. If none of them fit, choose "Other" and describe it in your own words.',
    why: 'A busy shop and an empty stockroom need very different levels of attention. This is how it knows which one it is looking at.',
  },
  {
    n: '2',
    title: 'Add your opening times',
    body:
      'Fill in the hours you are normally open and tick the days you trade. If you are open around the clock, you can leave it blank.',
    why: 'It is how the system tells ordinary from odd. People walking around at two in the afternoon is just business. The same movement at three in the morning is worth waking someone up for.',
  },
  {
    n: '3',
    title: 'Say what you are actually worried about',
    body:
      'Two boxes further down: "Primary security concerns" and "Additional context". Write plain sentences, the way you would explain it to a new member of staff. "People hang around by the bins out back." "I want to know how long customers wait at the till." "There should always be someone on the front desk."',
    why: 'Both boxes are optional — but this is where the system stops being generic and starts watching for your problems specifically.',
  },
  {
    n: '4',
    title: 'Press "Configure with AI"',
    body:
      'Now it has everything. It reads all of the above and tunes how fussy the cameras are — so write your notes first, or they will not be taken into account.',
    why: 'Somewhere busy gets calmed down so you are not pinged for every customer walking past. Somewhere quiet gets sharpened up so nothing slips by. You can nudge any of it yourself afterwards.',
  },
  {
    n: '5',
    title: 'Let it build your own alerts',
    body:
      'In the "Detection Events" section, press "1 · Analyze context". It reads what you wrote and tells you back, in plain English, what it thinks you want watched — and honestly says so if you have asked for something it cannot do. If that sounds right, press "2 · Design & install" and it builds them for real.',
    why: 'Things like a timer for how long someone stays at a table, a headcount for a queue getting too long, or a warning when a spot that should be staffed has been empty too long. Switch any of them off or change the numbers whenever you like.',
  },
];

const CANNOT = [
  'recognise faces or tell you who someone is',
  'read text, number plates, or badges',
  'judge mood, intent, or how someone is feeling',
];

export const SetupGuide: React.FC<SetupGuideProps> = ({ onContinue, onBack }) => (
  <div className="h-screen overflow-y-auto scrollbar-thin bg-dash-bg text-gray-100">
    <div className="min-h-screen flex flex-col items-center px-6 py-12">
      <div className="w-full max-w-2xl">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-2 mb-8 px-3.5 py-2 rounded border
            border-dash-border-bright bg-dash-panel text-gray-300 text-xs font-semibold
            hover:bg-dash-card-hover hover:text-white hover:border-gray-500 transition-colors"
        >
          <span aria-hidden="true">←</span> Back
        </button>

        {/* The four blobs drift behind the letters; see .aurora in index.css
            for how the blend paints them through the glyphs. */}
        <h1 className="aurora-text aurora-title text-center">
          Setup
          <span className="aurora" aria-hidden="true">
            <span className="aurora__item" />
            <span className="aurora__item" />
            <span className="aurora__item" />
            <span className="aurora__item" />
          </span>
        </h1>

        <p className="text-sm text-gray-400 leading-relaxed max-w-xl mx-auto text-center mt-4">
          The next page teaches the system what your place is like, so it stops guessing.
          It takes about a minute. Nothing here is permanent — you can come back and change
          any of it at any time.
        </p>

        <div className="mt-10 space-y-5">
          {STEPS.map((step) => (
            <div
              key={step.n}
              className="rounded-lg border border-dash-border bg-dash-panel p-5 flex gap-4"
            >
              <span className="font-mono text-xs font-semibold text-amber-400/80 pt-0.5 shrink-0">
                {step.n}
              </span>
              <div>
                <h2 className="text-sm font-semibold text-gray-100">{step.title}</h2>
                <p className="text-xs text-gray-400 leading-relaxed mt-1.5">{step.body}</p>
                <p className="text-xs text-gray-500 leading-relaxed mt-2 border-l-2 border-amber-600/30 pl-3">
                  {step.why}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Said up front rather than after someone has asked for it and been refused. */}
        <div className="mt-6 rounded-lg border border-dash-border bg-dash-bg p-5">
          <h2 className="font-mono text-xs font-semibold tracking-widest uppercase text-gray-400">
            What it cannot do
          </h2>
          <p className="text-xs text-gray-500 leading-relaxed mt-2">
            Worth knowing before you write your notes. The cameras cannot:
          </p>
          <ul className="mt-2 space-y-1">
            {CANNOT.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="text-gray-600 text-xs shrink-0">·</span>
                <span className="text-xs text-gray-500">{item}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 leading-relaxed mt-3">
            Ask for one of those and it will tell you plainly rather than quietly building
            something that only looks like it works.
          </p>
        </div>

        <div className="mt-10 flex items-center gap-4 flex-wrap pb-4">
          <button
            onClick={onContinue}
            className="px-5 py-2.5 bg-amber-600 text-white text-sm font-semibold rounded
              hover:bg-amber-500 transition-colors"
          >
            Ready to continue →
          </button>
          <span className="text-xs text-gray-600">Takes you to the setup page.</span>
        </div>
      </div>
    </div>
  </div>
);
