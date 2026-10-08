/**
 * A review body from what the runner decided, the way it reaches the pull
 * request (ADR 0007): the runner's hand-over, `reviewBodyHandOver`, rendered
 * by the formatter `review:publish` calls, with every closure holding unless
 * `closed` names the threads that did. So a test of what a body says is a
 * test of both halves, and of the seam between them.
 */
import {
  renderReviewPost,
  reviewBodyHandOver,
  type ReviewBodyHandOver,
  type ReviewBodyParts,
  type ReviewDecisions,
  type ReviewPost,
} from "../../shared/review-output.js";

/** The runner's decisions, and the parts only publish formats. */
export type Decided = ReviewDecisions & Partial<Omit<ReviewBodyParts, keyof ReviewBodyHandOver>>;

export const postDecided = ({ closed, roundNote, redTestsBlock, runUrl, header, log, ...decisions }: Decided): ReviewPost =>
  renderReviewPost({
    ...reviewBodyHandOver(decisions),
    closed: closed ?? new Set(decisions.resolved.flatMap((finding) => finding.threadId ?? [])),
    ...(roundNote === undefined ? {} : { roundNote }),
    ...(redTestsBlock === undefined ? {} : { redTestsBlock }),
    ...(runUrl === undefined ? {} : { runUrl }),
    ...(header === undefined ? {} : { header }),
    ...(log === undefined ? {} : { log }),
  });

export const renderDecided = (parts: Decided): string => postDecided(parts).body;
