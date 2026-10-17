/** A browser as the tab registry's UI routes report it (`BrowserView` in
 *  tabRegistry.ts, as seen over JSON). */
export interface Browser {
  id: string;
  label: string;
  startedAt: number;
  browserCdpUrl: string;
  pageCdpUrlTemplate: string;
  devtoolsFrontendUrl: string;
  /** Chromium's pid, when the registrant reported one. */
  pid?: number;
  /** Chrome-wide page claims, `targetId → terminal tab id` (see tabRegistry). */
  pageOwners?: Record<string, string>;
}
