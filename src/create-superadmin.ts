import { runCreateSuperadmin } from "./auth/cli/create-superadmin-command.js";

/** `node dist/create-superadmin.js [username] [--reset]`: see README "Authentication". */
process.exitCode = await runCreateSuperadmin(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
