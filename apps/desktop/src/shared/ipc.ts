/** Контракт между окном и главным процессом. Всё, что окно может попросить, перечислено здесь. */
export interface AppInfo {
  version: string;
  platform: string;
  totalMemGB: number;
}

export interface GemmaCodeApi {
  getAppInfo(): Promise<AppInfo>;
}

export const IPC = { appInfo: 'app:info' } as const;
