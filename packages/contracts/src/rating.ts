import { z } from "zod";

/**
 * A rating is whatever number the user said: 4.5, 7, 85, 100.
 *
 * The host stores it as given (no rounding, no rescaling), because editing the
 * user's own score is worse than an odd-looking number. What the host *adds* is
 * the scale the bare number implies: 4.7 is a 5-point score, 85 is out of 100.
 * That scale cannot live in `displayProps` — the shipped frontend validates
 * those with a strict schema and would reject an unknown key — so it travels in
 * `sourceData` (`ratingScale`, `ratingRaw`) and is merged back by whoever knows
 * how to render it.
 */
export type RatingScale = 5 | 10 | 100;

/** The largest score we accept at all: a guard against typo'd ids/strings
 *  being coerced into "ratings", not a statement about rating systems. */
export const RATING_MAX = 1000;

/** 5-point is the default range; 10 and 100 are the other common scales. A score
 *  above 100 keeps its original value and is labelled 100-point (the default). */
export function inferRatingScale(rating: number): RatingScale {
  if (rating <= 5) return 5;
  if (rating <= 10) return 10;
  return 100;
}

/** Scores the pre-1–5 frontend can render: an integer star count, nothing else. */
export const LEGACY_RATING_MAX = 5;

/** Whether the shipped frontend would choke on this score (it accepts 1–5 ints). */
export function needsLegacyRatingDowngrade(rating: number): boolean {
  return !Number.isInteger(rating) || rating > LEGACY_RATING_MAX;
}

/** The note that keeps the user's exact words when the score is not sent as a prop. */
export const legacyRatingNote = (rating: number): string => `评分 ${rating}`;

/** The rating field of every card that carries one (BookCard, reading template). */
export const RatingValueSchema = z.number().finite().positive().max(RATING_MAX);
