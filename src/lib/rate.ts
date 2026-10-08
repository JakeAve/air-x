/** How fast QR codes go out: `packetsPerCode * fps` packets per second. */
export interface QrRate {
  packetsPerCode: number;
  fps: number;
}

/** What a sender learned about a stretch of fresh symbols, all shown at `rate`. */
export interface RateSample {
  rate: QrRate;
  /** Fresh symbols shown in the stretch. */
  sent: number;
  /** How many of them the receiver heard; undefined when no report came back. */
  heard: number | undefined;
}

/**
 * The decision engine: called once per sample, returns the rate to use next
 * (the same rate to hold). `sendBundle` knows nothing else about the choice,
 * so a different engine is a different function.
 */
export type RatePolicy = (sample: RateSample) => QrRate;

/** Fresh symbols a sender shows with no report heard before it tells the policy so. */
export const SILENT_AFTER = 480;

export interface LadderOptions {
  /** The rates to move between, in strictly rising packets per second. */
  ladder: QrRate[];
  /** Step up when at least this share of the sent symbols was heard. */
  raiseAt: number;
  /** Step down when less than this share was heard, or on silence. */
  lowerBelow: number;
  /** After a step down, the rate it left is tried again on this many-th sample. */
  retryAfter: number;
}

/** Guesses until tried on phones; every one is meant to be changed. */
export const LADDER_DEFAULTS: LadderOptions = {
  ladder: [
    { packetsPerCode: 4, fps: 5 },
    { packetsPerCode: 6, fps: 5 },
    { packetsPerCode: 8, fps: 5 },
    { packetsPerCode: 11, fps: 5 },
    { packetsPerCode: 11, fps: 7 },
    { packetsPerCode: 14, fps: 7 },
    { packetsPerCode: 18, fps: 7 },
    { packetsPerCode: 18, fps: 10 },
  ],
  raiseAt: 0.9,
  lowerBelow: 0.5,
  retryAfter: 4,
};

const perSecond = (rate: QrRate) => rate.packetsPerCode * rate.fps;

/**
 * One step up the ladder on a good sample, one down on a bad one, hold in
 * between. The current rate need not be on the ladder: up is the next faster
 * step, down the next slower.
 */
export function ladderPolicy(options: Partial<LadderOptions> = {}): RatePolicy {
  const { ladder, raiseAt, lowerBelow, retryAfter } = {
    ...LADDER_DEFAULTS,
    ...options,
  };
  /** Packets per second of the rate last stepped down from, off limits while `wait` lasts. */
  let failed = Infinity;
  let wait = 0;
  return ({ rate, sent, heard }) => {
    const now = perSecond(rate);
    const share = heard === undefined ? 0 : heard / sent;
    if (wait > 0) wait--;
    if (share < lowerBelow) {
      const down = ladder.findLast((step) => perSecond(step) < now);
      if (!down) return rate;
      failed = now;
      wait = retryAfter;
      return down;
    }
    if (share >= raiseAt) {
      const up = ladder.find((step) => perSecond(step) > now);
      if (up && (wait === 0 || perSecond(up) < failed)) return up;
    }
    return rate;
  };
}
