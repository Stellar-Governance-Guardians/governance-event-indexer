/** Type declarations for scripts/check-pins.mjs (the JS is the source of truth). */

export interface PinCheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export type PinFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface CheckPinsOptions {
  online?: boolean;
  fetchImpl?: PinFetch;
}

export declare function sha256File(path: string): string;
export declare function sha256Bytes(bytes: Uint8Array): string;

export declare function pinnedUrls(locks: {
  schema: { parserRepo: string; commitSha: string; path: string; sha256: string };
  registry: { parserRepo: string; commitSha: string; path: string; sha256: string };
  parser: { assetUrl: string; sha256: string };
}): { label: string; url: string; sha256: string }[];

export declare function checkPins(options?: CheckPinsOptions): Promise<{
  results: PinCheckResult[];
  mode: 'online' | 'offline';
}>;
