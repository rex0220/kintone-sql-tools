import {
  createReadonlyKintoneClient,
  explainQuery,
  KsqlEngineError,
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
  runQuery,
} as EnginePublicApi;

registerEngineVersion(window, version, publicApi);
