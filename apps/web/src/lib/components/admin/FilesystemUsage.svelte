<script lang="ts">
import { formatBytes } from "$lib/browse.ts";
import {
  type FilesystemSpace,
  filesystemSegments,
  otherTone,
} from "$lib/stats.ts";

/**
 * One available filesystem's usage bar: a segment per library holding media on
 * it, then Other for unexplained usage, over the free track. With `libraryId`
 * only that library's segment shows, for the per-library page.
 */
const {
  filesystem,
  libraryId,
}: {
  filesystem: Extract<FilesystemSpace, { state: "available" }>;
  libraryId?: string;
} = $props();

const { segments, otherBytes } = $derived(
  filesystemSegments(filesystem, libraryId),
);
const multiLibrary = $derived(
  new Set(filesystem.roots.map((root) => root.libraryId)).size > 1,
);
const shownRoots = $derived(
  libraryId === undefined
    ? filesystem.roots
    : filesystem.roots.filter((root) => root.libraryId === libraryId),
);
const ariaLabel = $derived(
  [
    ...segments.map(
      (segment) => `${segment.label} ${formatBytes(segment.bytes)}`,
    ),
    `Other ${formatBytes(otherBytes)}`,
    `${formatBytes(filesystem.availableBytes)} free of ${formatBytes(filesystem.totalBytes)}`,
  ].join(", "),
);
</script>

{#each shownRoots as root (root.id)}
  <span
    class="block truncate text-footnote text-label-secondary"
    title={multiLibrary ? `${root.libraryName} · ${root.path}` : root.path}
    >{multiLibrary ? `${root.libraryName} · ${root.path}` : root.path}</span
  >
{/each}
<div
  role="img"
  aria-label={ariaLabel}
  class="space-usage mt-2 flex h-2 overflow-hidden rounded-full bg-fill"
>
  {#each segments as segment (segment.key)}
    <span
      class="h-full"
      style:width="{(segment.bytes / filesystem.totalBytes) * 100}%"
      style:background={segment.tone}
    ></span>
  {/each}
  {#if otherBytes > 0}
    <span
      class="h-full"
      style:width="{(otherBytes / filesystem.totalBytes) * 100}%"
      style:background={otherTone}
    ></span>
  {/if}
</div>
<ul class="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
  {#each segments as segment (segment.key)}
    <li class="flex items-center gap-1.5 text-footnote text-label-secondary">
      <span
        class="size-2 rounded-full"
        style:background={segment.tone}
        aria-hidden="true"
      ></span>
      {segment.label} · {formatBytes(segment.bytes)}
    </li>
  {/each}
  {#if otherBytes > 0}
    <li class="flex items-center gap-1.5 text-footnote text-label-secondary">
      <span
        class="size-2 rounded-full"
        style:background={otherTone}
        aria-hidden="true"
      ></span>
      Other · {formatBytes(otherBytes)}
    </li>
  {/if}
</ul>

<style>
  /* Forced colors strips the bar's fills; outline the track so it still reads. */
  @media (forced-colors: active) {
    .space-usage {
      border: 1px solid CanvasText;
    }
    .space-usage span {
      forced-color-adjust: none;
    }
  }
</style>
