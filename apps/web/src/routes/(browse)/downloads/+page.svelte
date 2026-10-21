<script lang="ts">
import DownloadIcon from "@lucide/svelte/icons/download";
import FolderInputIcon from "@lucide/svelte/icons/folder-input";
import FolderOutputIcon from "@lucide/svelte/icons/folder-output";
import PauseIcon from "@lucide/svelte/icons/pause";
import PlayIcon from "@lucide/svelte/icons/play";
import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
import Trash2Icon from "@lucide/svelte/icons/trash-2";
import XIcon from "@lucide/svelte/icons/x";
import { onMount } from "svelte";
import { toast } from "svelte-sonner";
import {
  formatBytes,
  itemHref,
  landscapeArtwork,
  seasonLabel,
} from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import EmptyState from "$lib/components/admin/EmptyState.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Progress } from "$lib/components/ui/progress/index.ts";
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import {
  type DownloadedItem,
  type DownloadRecord,
  downloadFolder,
  downloads,
  downloadsSupported,
  folderSupported,
  groupDownloads,
} from "$lib/downloads/index.ts";
import {
  browserDecodes,
  offlineHref,
  offlinePlan,
} from "$lib/offline/playable.ts";

const supported = downloadsSupported();
const canLink = folderSupported();
const unavailable = $derived($downloads.unavailable);
const storage = $derived($downloads.storage);
const records = $derived($downloads.records);
const ready = $derived($downloads.ready);
const persisted = $derived($downloads.persisted);
const groups = $derived(groupDownloads(records));
const folder = $derived($downloadFolder);
const folderOpen = $derived(folder?.access === "granted");

onMount(() => {
  if (supported) void downloads.restore();
  if (canLink) void downloadFolder.restore();
});

function caption(record: DownloadRecord): string {
  if ($downloads.moving.includes(record.versionId)) return "Moving…";
  const size =
    record.bytes === 0
      ? formatBytes(record.written)
      : `${formatBytes(record.written)} of ${formatBytes(record.bytes)}`;
  switch (record.state) {
    case "complete": {
      const plan = offlinePlan(record.streams, browserDecodes);
      return [
        formatBytes(record.bytes),
        record.fileName === null || folder === undefined
          ? null
          : `In ${folder.name}`,
        "reason" in plan ? plan.reason : null,
      ]
        .filter((part) => part !== null)
        .join(" · ");
    }
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

function episodeCaption(episode: DownloadedItem): string {
  const { episodeNumber, episodeEndNumber } = episode.detail;
  if (episodeNumber === null) return caption(episode);
  const number =
    episodeEndNumber === null
      ? `Episode ${episodeNumber}`
      : `Episodes ${episodeNumber}–${episodeEndNumber}`;
  return `${number} · ${caption(episode)}`;
}

async function update(call: () => Promise<void>) {
  try {
    await call();
  } catch {
    toast.error("Couldn't update the download");
  }
}

async function changeFolder(call: () => Promise<void>) {
  try {
    await call();
  } catch (error) {
    // Closing the picker is a choice, not a failure.
    if (error instanceof DOMException && error.name === "AbortError") return;
    toast.error("Couldn't update the download folder");
  }
}
</script>

<svelte:head>
  <title>Downloads · Thalia</title>
</svelte:head>

<div class="pt-4 lg:pt-8">
  <h1 class="mb-5 px-14 text-large-title lg:px-0">Downloads</h1>

  {#if !supported || unavailable}
    <p class="text-subheadline text-label-secondary">
      This browser can't save downloads.
    </p>
  {:else}
    <div class="flex flex-col gap-8">
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
          {#if canLink}
            <ListRow
              title="Download folder"
              caption={folder === undefined
                ? "None"
                : folderOpen
                  ? folder.name
                  : `${folder.name} · Needs access`}
            >
              {#snippet actions()}
                <div class="flex items-center gap-2">
                  {#if folder === undefined}
                    <Button
                      variant="secondary"
                      size="sm"
                      onclick={() => void changeFolder(downloadFolder.link)}
                      >Choose folder</Button
                    >
                  {:else}
                    {#if folderOpen}
                      <Button
                        variant="secondary"
                        size="sm"
                        onclick={() => void changeFolder(downloadFolder.link)}
                        >Change</Button
                      >
                    {:else}
                      <Button
                        size="sm"
                        onclick={() => void changeFolder(downloadFolder.allow)}
                        >Allow access</Button
                      >
                    {/if}
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => void changeFolder(downloadFolder.unlink)}
                      >Unlink</Button
                    >
                  {/if}
                </div>
              {/snippet}
            </ListRow>
          {/if}
        {/if}
      </FormGroup>

      {#if !ready}
        <FormGroup loading={2} />
      {:else if records.length === 0}
        <FormGroup>
          <EmptyState icon={DownloadIcon} title="No downloads">
            <Button variant="secondary" href="/movies">Browse movies</Button>
          </EmptyState>
        </FormGroup>
      {:else}
        {#if groups.movies.length > 0}
          <FormGroup title="Movies">
            {#each groups.movies as movie (movie.versionId)}
              <ListRow
                title={movie.title}
                caption={caption(movie)}
                href={itemHref(movie.detail) ?? undefined}
              >
                {#snippet leading()}
                  <div class="w-10">
                    <Artwork
                      artworkId={movie.detail.posterArtworkId}
                      title={movie.detail.title}
                      sizes="2.5rem"
                      fallbackTitle={false}
                    />
                  </div>
                {/snippet}
                {#snippet detail()}
                  {@render progress(movie)}
                {/snippet}
                {#snippet actions()}
                  {@render controls(movie)}
                {/snippet}
              </ListRow>
            {/each}
          </FormGroup>
        {/if}

        {#each groups.shows as show (show.id)}
          {@const headingId = `show-${show.id}`}
          <section aria-labelledby={headingId} class="flex flex-col gap-4">
            <div class="flex items-center gap-3 px-1">
              <div class="w-10 shrink-0">
                <Artwork
                  artworkId={show.posterArtworkId}
                  title={show.title}
                  sizes="2.5rem"
                  kind="show"
                  fallbackTitle={false}
                />
              </div>
              <h2 id={headingId} class="min-w-0 text-headline">{show.title}</h2>
            </div>
            {#each show.seasons as season (season.id)}
              <div>
                <h3 class="mb-2 px-1 text-subheadline font-semibold text-label-secondary">
                  {seasonLabel(season.seasonNumber)}
                </h3>
                <div class="rounded-lg bg-elevated contrast-more:ring-1 contrast-more:ring-separator">
                  {#each season.episodes as episode (episode.versionId)}
                    <ListRow
                      title={episode.detail.title}
                      caption={episodeCaption(episode)}
                      href={itemHref(episode.detail) ?? undefined}
                    >
                      {#snippet leading()}
                        <div class="w-20">
                          <Artwork
                            artworkId={landscapeArtwork(episode.detail)}
                            title={episode.detail.title}
                            sizes="5rem"
                            shape="landscape"
                            kind="episode"
                          />
                        </div>
                      {/snippet}
                      {#snippet detail()}
                        {@render progress(episode)}
                      {/snippet}
                      {#snippet actions()}
                        {@render controls(episode)}
                      {/snippet}
                    </ListRow>
                  {/each}
                </div>
              </div>
            {/each}
          </section>
        {/each}

        {#if groups.other.length > 0}
          <FormGroup>
            {#each groups.other as record (record.versionId)}
              <ListRow title={record.title} caption={caption(record)}>
                {#snippet detail()}
                  {@render progress(record)}
                {/snippet}
                {#snippet actions()}
                  {@render controls(record)}
                {/snippet}
              </ListRow>
            {/each}
          </FormGroup>
        {/if}
      {/if}
    </div>
  {/if}
</div>

{#snippet progress(record: DownloadRecord)}
  {#if record.state !== "complete"}
    <Progress
      value={record.bytes === 0 ? null : record.written}
      max={record.bytes}
      class="mt-1.5"
    />
  {/if}
{/snippet}

{#snippet controls(record: DownloadRecord)}
  <div class="flex items-center gap-1">
    {#if $downloads.moving.includes(record.versionId) || (record.fileName !== null && !folderOpen)}
      <!-- Nothing to do until the move ends or the folder opens. -->
    {:else if record.state === "queued" || record.state === "downloading"}
      {@render action("Pause download", PauseIcon, () =>
        downloads.pause(record.versionId),
      )}
      {@render action("Cancel download", XIcon, () =>
        downloads.remove(record.versionId),
      )}
    {:else if record.state === "paused"}
      {@render action("Resume download", PlayIcon, () =>
        downloads.resume(record.versionId),
      )}
      {@render action("Cancel download", XIcon, () =>
        downloads.remove(record.versionId),
      )}
    {:else if record.state === "failed"}
      {@render action("Try again", RotateCcwIcon, () =>
        downloads.resume(record.versionId),
      )}
      {@render action("Cancel download", XIcon, () =>
        downloads.remove(record.versionId),
      )}
    {:else}
      {#if !("reason" in offlinePlan(record.streams, browserDecodes))}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="ghost"
                size="icon-sm"
                aria-label="Play"
                href={offlineHref(record)}
              >
                <PlayIcon />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Play</Tooltip.Content>
        </Tooltip.Root>
      {/if}
      {#if record.fileName !== null}
        {@render action("Move to browser storage", FolderOutputIcon, () =>
          downloads.move(record.versionId, "browser"),
        )}
      {:else if folderOpen}
        {@render action("Move to folder", FolderInputIcon, () =>
          downloads.move(record.versionId, "folder"),
        )}
      {/if}
      {@render action("Delete download", Trash2Icon, () =>
        downloads.remove(record.versionId),
      )}
    {/if}
  </div>
{/snippet}

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
