export type StoredRecord = { id: string; type: string; label: string; lat: number; lon: number; alt?: number; notes?: string };

declare global {
  interface Window {
    amaranData: {
      writeData(records: StoredRecord[]): Promise<{ ok: boolean; error?: string }>;
      readData(): Promise<{ ok: boolean; records?: StoredRecord[]; error?: string }>;
    };
  }
}
export {};
