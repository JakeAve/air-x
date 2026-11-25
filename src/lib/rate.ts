/**
 * How fast a camera codec's frames go out: `packetsPerCode * fps` packets per
 * second. A codec whose only knob is fps leaves `packetsPerCode` out (1).
 */
export interface CameraRate {
  fps: number;
  packetsPerCode?: number;
}

/** One ack's worth of what the receiver saw, all at `rate` as far as the sender knows. */
export interface RateSample {
  rate: CameraRate;
  /**
   * Share of fresh symbols the receiver heard since its last ack, counted
   * from the first id it saw to the highest: 0 to 1. Measured on the
   * receiver, so when it started looking does not matter. Undefined when
   * the ack had no figure, or on silence.
   */
  heard?: number;
  /** `silentAfter` fresh symbols went out with no ack: nothing is known. */
  silent?: boolean;
}

/**
 * The decision engine: called once per sample, returns the rate to use next
 * (the same rate to hold). `sendBundle` knows nothing else about the choice,
 * so a different engine is a different function.
 */
export type RatePolicy = (sample: RateSample) => CameraRate;

/** Fresh symbols a sender shows with no report heard before it tells the policy so. */
export const SILENT_AFTER = 240;

export interface LadderOptions {
  /** The rates to move between, in strictly rising packets per second. */
  ladder: CameraRate[];
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
    { packetsPerCode: 2, fps: 5 },
    { packetsPerCode: 3, fps: 5 },
    { packetsPerCode: 4, fps: 5 },
    { packetsPerCode: 6, fps: 5 },
    { packetsPerCode: 6, fps: 7 },
    { packetsPerCode: 7, fps: 7 },
    { packetsPerCode: 9, fps: 7 },
    { packetsPerCode: 9, fps: 10 },
  ],
  raiseAt: 0.9,
  lowerBelow: 0.5,
  retryAfter: 4,
};

/** Cimbar's ladder, fps only (its frames hold a fixed 7.5 KB): guesses, as above. */
export const CIMBAR_LADDER: CameraRate[] = [6, 8, 10, 12, 15, 20].map((
  fps,
) => ({
  fps,
}));

const perSecond = (rate: CameraRate) => (rate.packetsPerCode ?? 1) * rate.fps;

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
  return ({ rate, heard, silent }) => {
    const now = perSecond(rate);
    if (heard === undefined && !silent) return rate;
    const share = heard ?? 0;
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
