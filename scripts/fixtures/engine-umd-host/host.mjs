import vm from "node:vm";

const CURSOR_PATH = "/k/v1/records/cursor.json";

function exactRegistry() {
  const versions = Object.create(null);
  return Object.freeze({
    versions,
    get(version) {
      return Object.prototype.hasOwnProperty.call(versions, version)
        ? versions[version]
        : undefined;
    },
  });
}

export function createEngineUmdHost(options = {}) {
  const state = {
    apiCalls: [],
    fetchCalls: [],
    listeners: [],
    warnings: [],
    errors: [],
    activeCursorIds: new Set(),
    cursorPages: new Map(),
    cursorSequence: 0,
    hostCursorLimit: options.hostCursorLimit ?? 5,
  };

  const api = async (url, method, params) => {
    state.apiCalls.push({ url, method, params });
    if (url.endsWith(CURSOR_PATH) && method === "POST") {
      if (state.activeCursorIds.size >= state.hostCursorLimit) {
        throw Object.assign(new Error("mock host cursor limit exceeded"), {
          code: "GAIA_CO02",
          status: 400,
        });
      }
      const id = `cursor-${++state.cursorSequence}`;
      state.activeCursorIds.add(id);
      state.cursorPages.set(id, 0);
      return { id, totalCount: "501" };
    }
    if (url.endsWith(CURSOR_PATH) && method === "GET") {
      const page = state.cursorPages.get(params.id) ?? 0;
      state.cursorPages.set(params.id, page + 1);
      const start = page === 0 ? 1 : 501;
      const count = page === 0 ? 500 : 1;
      return {
        records: Array.from({ length: count }, (_unused, index) => ({
          $id: { value: String(start + index) },
        })),
        next: true,
      };
    }
    if (url.endsWith(CURSOR_PATH) && method === "DELETE") {
      state.activeCursorIds.delete(params.id);
      return {};
    }
    if (url.endsWith("/k/v1/app/form/fields.json")) {
      return { properties: {} };
    }
    if (url.endsWith("/k/v1/app/settings.json")) {
      return {
        numberPrecision: {
          digits: "30",
          decimalPlaces: "10",
          roundingMode: "HALF_EVEN",
        },
      };
    }
    if (url.endsWith("/k/v1/app/status.json")) {
      return { enable: false, states: null };
    }
    if (url.endsWith("/k/v1/apps.json")) {
      return { apps: [] };
    }
    throw new Error(`Unexpected mock kintone.api call: ${method} ${url}`);
  };
  api.url = (path) => `https://example.cybozu.com${path}`;
  api.urlForGet = (path) => `https://example.cybozu.com${path}?fixture=1`;

  const kintone = {
    api,
    getRequestToken: () => "fixture-token",
  };
  const host = {
    AbortController,
    Headers,
    Request,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    clearTimeout,
    console: {
      error: (...args) => state.errors.push(args),
      warn: (...args) => state.warnings.push(args),
      log: () => undefined,
    },
    fetch: async (...args) => {
      state.fetchCalls.push(args);
      return new Response(JSON.stringify({ records: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    kintone,
    location: { href: "https://example.cybozu.com/k/1/" },
    setTimeout,
  };
  host.addEventListener = (...args) => state.listeners.push(args);
  host.removeEventListener = () => undefined;
  host.window = host;
  if (options.registry !== false) host.ksql = exactRegistry();

  return {
    context: vm.createContext(host),
    host,
    kintone,
    state,
  };
}

export function loadEngineUmd(source, fixture, filename) {
  return vm.runInContext(source, fixture.context, { filename });
}
