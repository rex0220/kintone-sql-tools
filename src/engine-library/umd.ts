import {
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
  runBatch,
  runQuery,
  version,
} from "./index";
import {
  registerEngineVersion,
  type EnginePublicApi,
  type EngineRegistry,
} from "./versionRegistry";

declare global {
  interface Window {
    ksql?: EngineRegistry;
  }
}

const publicApi = {
  version,
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
  runBatch,
  runQuery,
} as EnginePublicApi;

registerEngineVersion(window, version, publicApi);
