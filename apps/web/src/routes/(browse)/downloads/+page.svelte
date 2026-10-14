<script lang="ts">
import DownloadIcon from "@lucide/svelte/icons/download";
import PauseIcon from "@lucide/svelte/icons/pause";
import PlayIcon from "@lucide/svelte/icons/play";
import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import XIcon from "@lucide/svelte/icons/x";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import { formatBytes } from "$lib/browse.ts";
import EmptyState from "$lib/components/admin/EmptyState.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Progress } from "$lib/components/ui/progress/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import {
  type DownloadRecord,
  downloads,
  downloadsSupported,
} from "$lib/downloads/index.ts";

const supported = downloadsSupported();
const storage = $derived($downloads.storage);
const records = $derived($downloads.records);
const ready = $derived($downloads.ready);
const persisted = $derived($downloads.persisted);

onMount(() => {
  if (supported) void downloads.restore();
});

function caption(record: DownloadRecord): string {
  const size = `${formatBytes(record.written)} of ${formatBytes(record.bytes)}`;
  switch (record.state) {
    case "complete":
      return formatBytes(record.bytes);
    case "downloading":
      return size;
    case "queued":
      return `Waiting · ${size}`;
    case "paused":
      return `Paused · ${size}`;
    case "failed":
      return `Failed · ${size}`;
  }
}

async function update(call: () => Promise<void>) {
  try {
    await call();
  } catch {
    toast.error("Couldn't update the download");
  }
}
</script>

<svelte:head>
  <title>Downloads · Thalia</title>
</svelte:head>

<div class="pt-4 lg:pt-8">
  <h1 class="mb-5 pr-14 text-large-title lg:pr-0">Downloads</h1>

  {#if !supported}
    <p class="text-subheadline text-label-secondary">
      This browser can't save downloads.
    </p>
  {:else}
    <div class="flex flex-col gap-6">
      <FormGroup
        title="Storage"
        loading={storage === undefined ? 1 : 0}
        description={persisted === false
          ? "Your browser may delete downloads when storage runs low."
          : undefined}
      >
        {#if storage !== undefined}
          <div class="min-h-12 px-4 py-2.5">
            <div class="flex items-baseline justify-between gap-4">
              <span class="text-subheadline font-medium text-label"
                >Downloads use {formatBytes(storage.downloads)}</span
              >
              <span class="text-footnote text-label-secondary"
                >{formatBytes(storage.quota - storage.usage)} available</span
              >
            </div>
            <Progress
              value={storage.usage}
              max={storage.quota}
              class="mt-2"
            />
          </div>
        {/if}
      </FormGroup>

      <FormGroup title="Downloads" loading={ready ? 0 : 2}>
        {#if ready && records.length === 0}
          <EmptyState icon={DownloadIcon} title="No downloads">
            <Button variant="secondary" href="/movies">Browse movies</Button>
          </EmptyState>
        {:else if ready}
          {#each records as record (record.versionId)}
            <ListRow title={record.title} caption={caption(record)}>
              {#snippet detail()}
                {#if record.state !== "complete"}
                  <Progress
                    value={record.written}
                    max={record.bytes}
                    class="mt-1.5"
                  />
                {/if}
              {/snippet}
              <div class="flex items-center gap-1">
                {#if record.state === "queued" || record.state === "downloading"}
                  {@render action(
                    "Pause download",
                    PauseIcon,
                    () => downloads.pause(record.versionId),
                  )}
                  {@render action(
                    "Cancel download",
                    XIcon,
                    () => downloads.remove(record.versionId),
                  )}
                {:else if record.state === "paused"}
                  {@render action(
                    "Resume download",
                    PlayIcon,
                    () => downloads.resume(record.versionId),
                  )}
                  {@render action(
                    "Cancel download",
                    XIcon,
                    () => downloads.remove(record.versionId),
                  )}
                {:else if record.state === "failed"}
                  {@render action(
                    "Try again",
                    RotateCcwIcon,
                    () => downloads.resume(record.versionId),
                  )}
                  {@render action(
                    "Cancel download",
                    XIcon,
                    () => downloads.remove(record.versionId),
                  )}
                {:else}
                  {@render action(
                    "Delete download",
                    Trash2Icon,
                    () => downloads.remove(record.versionId),
                  )}
                {/if}
              </div>
            </ListRow>
          {/each}
        {/if}
      </FormGroup>
    </div>
  {/if}
</div>

{#snippet action(label: string, Icon: typeof PauseIcon, call: () => Promise<void>)}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onclick={() => void update(call)}
        >
          <Icon />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip.Root>
{/snippet}
