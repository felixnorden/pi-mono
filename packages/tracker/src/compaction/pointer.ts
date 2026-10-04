import { formatItemRef } from "../core/deps.ts";
import type { CompactionCandidate } from "./candidate.ts";

/** The custom-message type the resume turn carries. */
export const SMART_COMPACTION_CUSTOM_TYPE = "tracker/smart-compaction";

/**
 * A continuation note naming the next ready item after compaction. It reads as
 * a continuation of the current work, never as a new request, and it is never
 * written to a plan file.
 */
export const resumePointer = (candidate: CompactionCandidate): string =>
  `Continue the ${candidate.listName} tracker list. ` +
  `The earlier context was compacted after the completed work. ` +
  `The next ready item is #${formatItemRef(candidate.listName, candidate.id)}: ${candidate.text}.`;
