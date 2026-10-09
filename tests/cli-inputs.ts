/**
 * Running a subcommand in a test with exactly the inputs the test gives (#428).
 *
 * A subcommand reads its inputs from `process.env`, and a test that lays its
 * inputs over whatever is already there runs against the environment `vitest`
 * was started in as well. The build agent runs the gate inside a job that sets
 * `BRANCH`, `GH_REPO`, `OUTPUT_DIR` and the rest, so a test that forgot one of
 * them passed there and failed on CI's clean runner (#424).
 *
 * So for the length of a run, every input the subcommand declares in `RUNNERS`
 * or `COMMANDS` is either given by the test or unset, and the environment is
 * put back exactly as it was afterwards, however the run ended: a variable that
 * was unset before is unset again. Variables the subcommand does not declare
 * (`PATH`, the `gh` replay's `GH_REPLAY_*`) pass through, and are set here too
 * where a test gives them. `init` and `doctor` are in neither map, so they
 * declare nothing to unset.
 *
 * The one place a test that runs the CLI writes `process.env`:
 * `tests/agent-cli.test.ts` fails on any other.
 */
import { run, type CliIo } from "../cli.js";
import { COMMANDS, RUNNERS } from "../shared/contract.js";

/** Variable to its value for the run, or `undefined` to have it unset. */
export type Given = Readonly<Record<string, string | undefined>>;

/** The input names `subcommand` declares, or none for a name in neither map. */
export const declaredInputs = (subcommand: string | undefined): readonly string[] => {
  const declared = [...Object.entries(RUNNERS), ...Object.entries(COMMANDS)].find(([name]) => name === subcommand);
  return declared === undefined ? [] : Object.keys(declared[1].inputs);
};

const put = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

/**
 * Runs `body` with `given` set and every other input `subcommand` declares
 * unset, then restores what it touched, whether `body` returned or threw.
 */
export const withInputs = async <T>(
  subcommand: string | undefined,
  given: Given,
  body: () => T | Promise<T>,
): Promise<T> => {
  const unset = declaredInputs(subcommand).filter((name) => !Object.hasOwn(given, name));
  const saved = new Map([...Object.keys(given), ...unset].map((name) => [name, process.env[name]]));
  try {
    for (const name of unset) put(name, undefined);
    for (const [name, value] of Object.entries(given)) put(name, value);
    return await body();
  } finally {
    for (const [name, value] of saved) put(name, value);
  }
};

export interface Captured {
  code: number;
  out: string;
  err: string;
}

/** The CLI run in-process on `argv`, with exactly `given` of its subcommand's inputs, and what it printed. */
export const invoke = (argv: string[], given: Given = {}): Promise<Captured> =>
  withInputs(argv[0], given, async () => {
    let out = "";
    let err = "";
    const io: CliIo = {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    };
    return { code: await run(argv, io), out, err };
  });
