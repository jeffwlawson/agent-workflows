import type { Inputs } from "../shared/contract.js";

/**
 * What each of the service orchestrator's processes reads from its
 * environment, declared in the contract's style and read through `readInputs`
 * (`shared/env.ts`), so a missing setting stops the process at start, naming
 * every one missing. A setting is not a runner's input: no subcommand of the
 * loop reads it, so it has no row in the spec's tables. The deployment guide,
 * `docs/deploying-the-service.md`, lists each process's, and
 * `tests/service/settings.test.ts` holds that list equal to this one.
 *
 * No side effects, like `shared/contract.ts`, so the CLI can name a process's
 * settings without loading the process.
 */

const REQUIRED = { required: true } as const;

/**
 * **The dispatcher's settings** (#456). It is the only holder of the GitHub
 * App's key, so everything it reads is about the App, the two doors it opens
 * and the worker it posts to.
 *
 * - `GITHUB_APP_ID`: the App's ID, which signs as the App.
 * - `GITHUB_APP_PRIVATE_KEY_FILE`: a path to the App's private key, in PEM.
 *   A path rather than the key, so the key never sits in an environment a
 *   process listing can show.
 * - `GITHUB_WEBHOOK_SECRET`: the App's webhook secret, which a delivery is
 *   signed with.
 * - `WORKER_URL`: where a job is posted, the worker's job door.
 * - `WORKER_SECRET`: the secret the dispatcher and the worker share. A job
 *   the dispatcher posts and a token request the worker makes are each signed
 *   with it.
 * - `WEBHOOK_HOST` and `WEBHOOK_PORT`: where the webhook door listens, which
 *   whatever brings GitHub's deliveries in forwards to.
 * - `TOKEN_HOST` and `TOKEN_PORT`: where the token door listens. A door of
 *   its own, so the one exposed to the internet mints nothing.
 * - `JOB_DEADLINE_MARGIN_MINUTES`: added to review's time limit for a job's
 *   deadline, past which no token is minted for it. It covers the phases
 *   around the runner's, and the time a job waits in the worker's queue.
 */
export const DISPATCHER = {
  GITHUB_APP_ID: REQUIRED,
  GITHUB_APP_PRIVATE_KEY_FILE: REQUIRED,
  GITHUB_WEBHOOK_SECRET: REQUIRED,
  WORKER_URL: REQUIRED,
  WORKER_SECRET: REQUIRED,
  WEBHOOK_HOST: { required: false, default: "127.0.0.1" },
  WEBHOOK_PORT: { required: false, default: "8790" },
  TOKEN_HOST: { required: false, default: "127.0.0.1" },
  TOKEN_PORT: { required: false, default: "8791" },
  JOB_DEADLINE_MARGIN_MINUTES: { required: false, default: "60" },
} as const satisfies Inputs;

/** Every process of the service orchestrator, by the subcommand that runs it, to its settings. */
export const SERVICE = {
  dispatcher: { settings: DISPATCHER },
} as const satisfies Readonly<Record<string, { readonly settings: Inputs }>>;

export type ServiceProcess = keyof typeof SERVICE;
