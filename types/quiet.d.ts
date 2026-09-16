// Minimal typing for the emscripten factory in vendor/quiet/quiet-emscripten.js.

export type Pointer = number;

export interface QuietModuleOptions {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  locateFile?: (path: string) => string;
  /** Sync read of the memory initializer (Deno path). */
  readBinary?: (path: string) => Uint8Array;
  /** Async read of the memory initializer (browser and worker path). */
  readAsync?: (
    path: string,
    onload: (data: ArrayBuffer) => void,
    onerror: () => void,
  ) => void;
  onRuntimeInitialized?: () => void;
}

export interface QuietModule extends QuietModuleOptions {
  calledRun?: boolean;
  HEAPF32: Float32Array;
  HEAPU8: Uint8Array;
  _malloc(bytes: number): Pointer;
  _free(ptr: Pointer): void;
  intArrayFromString(text: string): number[];
  ccall(
    name: string,
    returnType: "number" | null,
    argTypes: ("number" | "array")[],
    args: (number | Uint8Array | number[])[],
  ): number;
}

export default function createQuiet(options: QuietModuleOptions): QuietModule;
