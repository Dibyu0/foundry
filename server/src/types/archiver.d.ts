/**
 * Minimal typings for archiver@7 (the package ships no types and
 * @types/archiver is not in the dependency set). Covers only the
 * surface routes/download.ts uses.
 */
declare module 'archiver' {
  import type { Readable } from 'node:stream';

  interface ArchiverOptions {
    zlib?: { level?: number };
    store?: boolean;
  }

  interface EntryData {
    name?: string;
    date?: Date;
    mode?: number;
    prefix?: string;
  }

  interface Archiver extends Readable {
    pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T;
    directory(dirpath: string, destpath: string | false, data?: EntryData): this;
    finalize(): Promise<void>;
    abort(): this;
    destroy(): void;
    pointer(): number;
  }

  function archiver(format: 'zip' | 'tar', options?: ArchiverOptions): Archiver;
  export = archiver;
}
