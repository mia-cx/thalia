<script lang="ts">
import { untrack } from "svelte";
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import { itemHref } from "$lib/browse.ts";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import { readFailure } from "$lib/errors.ts";
import {
  formatCount,
  type MetadataGap,
  type MetadataGapItem,
} from "$lib/stats.ts";

/** The dialog listing one metadata gap's Items, with per-row refresh. */
let {
  open = $bindable(false),
  libraryId,
  libraryName,
  gap,
  count,
  revision,
}: {
  open?: boolean;
  libraryId: string;
  libraryName: string;
  /** The gap being listed, or undefined while closed. */
  gap: { key: MetadataGap; label: string } | undefined;
  count: number;
  /** Bumps on every library.changed for this library; while open, the list reconciles. */
  revision: number;
} = $props();

let items = $state<MetadataGapItem[]>([]);
let cursor = $state<string | null>(null);
let loading = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
let refreshed = $state(new Set<string>());

// Opening or closing bumps this; a request that answered for an older
// generation is dropped, so a slow first page can't overwrite a new opening.
let generation = 0;

async function loadMore() {
  if (gap === undefined) return;
  const ticket = generation;
  const gapKey = gap.key;
  const after = cursor;
  loading = true;
  try {
    const page = await client.libraries.metadataGapItems({
      libraryId,
      gap: gapKey,
      ...(after === null ? {} : { cursor: after }),
    });
    if (ticket !== generation) return;
    items = [...items, ...page.items];
    cursor = page.cursor;
    failure = undefined;
  } catch (error) {
    if (ticket === generation) failure = readFailure(error);
  } finally {
    if (ticket === generation) loading = false;
  }
}

// While open, a library.changed bumps `revision` and the list reconciles from
// the first page: enough pages to cover what was loaded, then one assignment
// so nothing flashes and Show more keeps paging from a consistent cursor.
async function reconcile() {
  if (gap === undefined) return;
  const ticket = generation;
  const gapKey = gap.key;
  const wanted = items.length;
  const next: MetadataGapItem[] = [];
  let after: string | null = null;
  try {
    do {
      const page = await client.libraries.metadataGapItems({
        libraryId,
        gap: gapKey,
        limit: 100,
        ...(after === null ? {} : { cursor: after }),
      });
      next.push(...page.items);
      after = page.cursor;
      if (ticket !== generation) return;
    } while (after !== null && next.length < wanted);
    items = next;
    cursor = after;
    failure = undefined;
  } catch (error) {
    if (ticket === generation) failure = readFailure(error);
  }
}

// Reconciles serialize with each other and don't trample a Show more in
// flight: one runs at a time, a bump during it schedules one more pass.
const reconciling = { running: false, dirty: false };
function requestReconcile() {
  if (reconciling.running) {
    reconciling.dirty = true;
    return;
  }
  reconciling.running = true;
  void (async () => {
    try {
      do {
        reconciling.dirty = false;
        await reconcile();
      } while (reconciling.dirty);
    } finally {
      reconciling.running = false;
    }
  })();
}

async function refresh(item: MetadataGapItem) {
  try {
    await client.items.refresh({ id: item.id });
    refreshed = new Set(refreshed).add(item.id);
  } catch (error) {
    toast.error(readFailure(error).message);
  }
}

function caption(item: MetadataGapItem): string {
  if (item.kind === "episode" && item.show !== null)
    return `${item.show.title} · S${item.seasonNumber}, E${item.episodeNumber}`;
  return item.year === null ? "" : String(item.year);
}

let seenRevision = -1;

// Open and close bump the generation so pending responses land nowhere; the
// reset and first load are untracked so writing cursor/items doesn't retrigger.
$effect(() => {
  generation += 1;
  if (!open) return;
  untrack(() => {
    items = [];
    cursor = null;
    refreshed = new Set();
    failure = undefined;
    seenRevision = revision;
    void loadMore();
  });
});

// A revision bump while open reconciles the list; reads stay limited to
// `revision` and `open` so the effect never re-fires on list writes.
$effect(() => {
  if (!open || revision === seenRevision) return;
  seenRevision = revision;
  untrack(() => void requestReconcile());
});
</script>

<Dialog.Root bind:open>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{gap?.label}</Dialog.Title>
      <Dialog.Description
        >{formatCount(count)} in {libraryName}</Dialog.Description
      >
    </Dialog.Header>
    <div class="min-w-0 rounded-lg bg-elevated">
      {#each items as item (item.id)}
        {@const href = itemHref(item)}
        {@const captionText = caption(item)}
        {@const queued = refreshed.has(item.id)}
        <div
          class="relative flex min-h-12 items-center gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden"
        >
          <span class="min-w-0 flex-1">
            {#if href === null}
              <span class="block truncate text-subheadline font-medium text-label"
                >{item.title}</span
              >
            {:else}
              <a
                {href}
                class="block truncate text-subheadline font-medium text-label no-underline hover:underline"
                >{item.title}</a
              >
            {/if}
            {#if captionText}
              <span class="block truncate text-footnote text-label-secondary"
                >{captionText}</span
              >
            {/if}
          </span>
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={queued || undefined}
            aria-label="{queued ? 'Refresh queued' : 'Refresh metadata'} for {item.title}"
            onclick={() => {
              if (!queued) void refresh(item);
            }}>{queued ? "Refresh queued" : "Refresh metadata"}</Button
          >
        </div>
      {:else}
        {#if !loading && failure === undefined}
          <div class="relative min-h-12 px-4 py-2.5">
            <span class="text-subheadline text-label-secondary"
              >Nothing missing.</span
            >
          </div>
        {/if}
      {/each}
    </div>
    {#if failure}
      <Failure {failure} />
    {/if}
    {#if cursor !== null || failure}
      <Dialog.Footer>
        {#if cursor !== null}
          <Button variant="secondary" onclick={loadMore} disabled={loading}
            >Show more</Button
          >
        {/if}
        {#if failure}
          <Button variant="secondary" onclick={loadMore} disabled={loading}
            >Try again</Button
          >
        {/if}
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
