/**
 * Worker-thread entry (bundled to dist/index-worker.js). Owns the session
 * index so indexing never runs on pi's main thread. Protocol and logic live
 * in index-service.ts.
 */
import { parentPort, workerData } from "node:worker_threads";
import { createIndexService, handleWorkerRequest } from "./index-service";
import type { IndexOptions, WorkerRequest } from "./index-service";

const port = parentPort;
if (!port) throw new Error("index-worker must run as a worker thread");

const service = createIndexService(workerData as IndexOptions);
port.on("message", (req: WorkerRequest) => {
  void handleWorkerRequest(service, req, (reply) => port.postMessage(reply));
});
