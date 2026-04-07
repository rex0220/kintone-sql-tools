// ============================================================
// kintone グローバル API の最小型宣言
// ============================================================

declare const kintone: {
  $PLUGIN_ID: string;
  api<T = unknown>(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    params: Record<string, unknown>
  ): Promise<T>;

  plugin: {
    app: {
      getConfig(pluginId: string): Record<string, string>;
      setConfig(config: Record<string, string>, callback?: () => void): void;
    };
  };

  events: {
    on(
      events: string | string[],
      handler: (event: Record<string, unknown>) => unknown
    ): void;
  };

  app: {
    getId(): number | null;
    getHeaderSpaceElement(): HTMLElement | null;
    record: {
      getHeaderMenuSpaceElement(): HTMLElement | null;
      getSpaceElement(id: string): HTMLElement | null;
      get(): { record: Record<string, { value: unknown }> } | null;
    };
  };

  getLoginUser(): { code: string; name: string };
};
