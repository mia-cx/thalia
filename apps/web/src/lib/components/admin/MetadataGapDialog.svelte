<script lang="ts">
import { toast } from "svelte-sonner";
import { client } from "$lib/api.ts";
import { itemHref } from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Dialog from "$lib/components/ui/dialog/index.ts";
import { formatCount, type MetadataGapItem } from "$lib/stats.ts";

/** The dialog listing one metadata gap's Items, with per-row refresh. */
let {
  open = $bindable(false),
  libraryId,
  libraryName,
  gap,
  count,
}: {
  open?: boolean;
  libraryId: string;
  libraryName: string;
  /** The gap being listed, or undefined while closed. */
  gap: { key: string; label: string } | undefined;
  count: number;
} = $props();

type GapKey = "poster" | "backdrop" | "overview" | "providerIds" | "still";

let items = $state<MetadataGapItem[]>([]);
let cursor = $state<string | null>(null);
let loading = $state(false);
let refreshed = $state(new Set<string>());

async function loadMore() {
  if (gap === undefined) return;
  loading = true;
  try {
    const page = await client.libraries.metadataGapItems({
      libraryId,
      gap: gap.key as GapKey,
      ...(cursor === null ? {} : { cursor }),
    });
    items = [...items, ...page.items];
    cursor = page.cursor;
  } catch (error) {
    toast.error("Couldn't load the list");
  } finally {
    loading = false;
  }
}

async function refresh(item: MetadataGapItem) {
  try {
    await client.items.refresh({ id: item.id });
    refreshed = new Set(refreshed).add(item.id);
  } catch {
    toast.error("Couldn't refresh metadata");
  }
}

function caption(item: MetadataGapItem): string {
  if (item.kind === "episode" && item.show !== null)
    return `${item.show.title} · S${item.seasonNumber}, E${item.episodeNumber}`;
  return item.year === null ? "" : String(item.year);
}

// A reopened dialog starts from the first page again.
$effect(() => {
  if (open) {
    items = [];
    cursor = null;
    refreshed = new Set();
    void loadMore();
  }
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
    <div class="rounded-lg bg-elevated">
      {#each items as item (item.id)}
        {@const href = itemHref(item)}
        {@const captionText = caption(item)}
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
          {#if refreshed.has(item.id)}
            <Button variant="secondary" size="sm" disabled
              >Refresh queued</Button
            >
          {:else}
            <Button
              variant="secondary"
              size="sm"
              onclick={() => refresh(item)}>Refresh metadata</Button
            >
          {/if}
        </div>
      {:else}
        {#if !loading}
          <div class="relative min-h-12 px-4 py-2.5">
            <span class="text-subheadline text-label-secondary"
              >Nothing missing.</span
            >
          </div>
        {/if}
      {/each}
    </div>
    {#if cursor !== null}
      <Dialog.Footer>
        <Button variant="secondary" onclick={loadMore} disabled={loading}
          >Show more</Button
        >
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
