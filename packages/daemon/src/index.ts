// @ccpool/daemon — the long-running observer process (no IPC).

export { Daemon, startDaemon } from "./daemon.js";
export type { DaemonDeps, AccountProfile, ProfileLoader } from "./daemon.js";
export { Pipeline } from "./pipeline.js";
export type { PipelineDeps } from "./pipeline.js";
export { spawnDetached } from "./spawn.js";
export type { SpawnDetachedOptions } from "./spawn.js";
export {
  daemonPaths,
  isAlive,
  readPid,
  acquireLock,
  reassertLock,
  releaseLock,
  makeLogger,
  AlreadyRunningError,
} from "./lifecycle.js";
export type { DaemonPaths, Logger, LogLevel } from "./lifecycle.js";
