/**
 * The inside end of a `bwrap` sandbox's way out (#461), run by `bwrapArgs`
 * before every command in a sandbox with a network of its own: listen on the
 * sandbox's loopback, at the port the proxy variables name, forward each
 * connection to the socket the host end holds, then run the command and end
 * as it ends.
 *
 * Untrusted, and nothing depends on it: the socket is the sandbox's one way
 * out, and the host end sends whatever reaches it to the proxy alone. Plain
 * JavaScript, not a module `tsc` emits, so it runs from a single file bound
 * into the sandbox with no package beside it; an asset, which
 * `scripts/copy-assets.ts` carries into `dist/`.
 *
 * Arguments: the socket, the port, then the command and its arguments.
 */
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { constants } from "node:os";

const [socket, port, command, ...args] = process.argv.slice(2);

if (socket === undefined || port === undefined || command === undefined) {
  process.stderr.write("relay: expected a socket, a port and a command\n");
  process.exit(2);
}

const server = createServer((client) => {
  const upstream = connect(socket);
  for (const end of [client, upstream]) {
    end.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
  }
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  process.stderr.write(`relay: cannot listen on 127.0.0.1:${port}: ${error.message}\n`);
  process.exit(1);
});

server.listen(Number(port), "127.0.0.1", () => {
  const child = spawn(command, args, { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    process.stderr.write(`relay: cannot run ${command}: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0))));
});
