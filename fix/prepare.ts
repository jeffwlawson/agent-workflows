import type { FetchingIo } from "../shared/command-io.js";
import type { COMMANDS } from "../shared/contract.js";
import type { InputValues } from "../shared/env.js";
import { fetchRescue } from "../shared/rescue.js";

type Declared = (typeof COMMANDS)["fix:prepare"];
type Inputs = InputValues<Declared["inputs"]>;
type Io = FetchingIo<Declared["outputs"]>;

/**
 * `fix:prepare` (#471): the rescue branch an earlier run of this pull request
 * left when it stopped (#303), where there is one, fetched into the checkout
 * as `refs/rescue/<RESCUE_BRANCH>` for the runner to resume from. The runner
 * decides whether it still builds on the head; this only fetches it.
 *
 * It runs before anything of the pull request's has run on the runner, so the
 * token it reads and fetches with meets no git config entry or hook the pull
 * request's code left behind. It reads with the workflow token and writes
 * nothing to the record: it is handed no writer.
 *
 * **An unreadable answer stops the run**, rather than reading as "no
 * rescue": a run that started over without the rescue, and succeeded, would
 * delete it. So a 404 for the branch is the one answer that is "none", and any
 * other failure to read its tip, or to fetch a rescue that is there, stops
 * with a sentence.
 */
export const prepare = async (inputs: Inputs, io: Io): Promise<void> => {
  await fetchRescue(io.github, io.fetcher, inputs.RESCUE_BRANCH);
};
