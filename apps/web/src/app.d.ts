import type { FailureCode } from "$lib/errors.ts";

declare global {
  /** Safari's power-aware MediaSource; absent elsewhere and from TypeScript's DOM types. */
  var ManagedMediaSource: typeof MediaSource | undefined;

  /** Chromium desktop's folder picker; absent elsewhere and from TypeScript's DOM types. */
  var showDirectoryPicker:
    | ((options?: {
        id?: string;
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>)
    | undefined;

  interface FileSystemHandle {
    /** Chromium's File System Access permission check; absent from TypeScript's DOM types. */
    queryPermission(descriptor: {
      mode: "read" | "readwrite";
    }): Promise<PermissionState>;
    /** Asks the user for access again; needs a user gesture. */
    requestPermission(descriptor: {
      mode: "read" | "readwrite";
    }): Promise<PermissionState>;
  }

  interface HTMLVideoElement {
    /** iOS Safari's native fullscreen video, the only fullscreen on iPhone. */
    webkitEnterFullscreen?(): void;
  }

  namespace App {
    /** What the error page knows about a failed load. */
    interface Error {
      message: string;
      code?: FailureCode;
    }
  }
}
