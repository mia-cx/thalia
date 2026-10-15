<script lang="ts">
import { formatBytes, formatDuration } from "$lib/browse.ts";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import MetadataGapDialog from "$lib/components/admin/MetadataGapDialog.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import type { FailureCode } from "$lib/errors.ts";
import {
  formatCodecs,
  formatCount,
  formatDynamicRange,
  formatResolution,
  type LibraryGaps,
  type LibraryStats,
  type MetadataGap,
} from "$lib/stats.ts";

/** One library's stats card on the Overview: counts, mixes and gap rows. */
const {
  library,
  stats,
  gaps,
  failure,
  onretry,
  revision,
}: {
  library: { id: string; name: string; medium: "movies" | "shows" };
  stats: LibraryStats | undefined;
  gaps: LibraryGaps | undefined;
  failure?: { code: FailureCode; message: string } | undefined;
  onretry: () => void;
  /** Bumps on library.changed for this library; passed to the gap dialog. */
  revision: number;
} = $props();

const gapRows = $derived(
  (
    [
      ["poster", "No poster"],
      ["backdrop", "No backdrop"],
      ["overview", "No overview"],
      ["providerIds", "No provider IDs"],
      ...(library.medium === "shows"
        ? [["still", "Episodes without a still"]]
        : []),
    ] as [MetadataGap, string][]
  ).map(([key, label]) => ({ key, label, count: gaps?.[key] ?? 0 })),
);

let dialogOpen = $state(false);
let dialogGap = $state<{ key: MetadataGap; label: string } | undefined>(
  undefined,
);

function openGap(row: { key: MetadataGap; label: string }) {
  dialogGap = row;
  dialogOpen = true;
}
</script>

<FormGroup
  title={library.name}
  loading={
    failure === undefined && (stats === undefined || gaps === undefined)
      ? 3
      : undefined
  }
  {failure}
>
  {#if stats !== undefined && gaps !== undefined}
    {#if library.medium === "movies"}
      <FormRow label="Movies" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatCount(stats.kinds.movies)}</span
        >
      </FormRow>
    {:else}
      <FormRow label="Shows" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatCount(stats.kinds.shows)}</span
        >
      </FormRow>
      <FormRow label="Seasons" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatCount(stats.kinds.seasons)}</span
        >
      </FormRow>
      <FormRow label="Episodes" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatCount(stats.kinds.episodes)}</span
        >
      </FormRow>
    {/if}
    <FormRow label="Size" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatBytes(stats.bytes)}</span
      >
    </FormRow>
    <FormRow label="Runtime" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatDuration(stats.runtimeSeconds)}</span
      >
    </FormRow>
    <FormRow label="Added in the last 30 days" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatCount(stats.addedLast30Days)}</span
      >
    </FormRow>
    <FormRow label="With more than one version" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatCount(stats.multiVersionItems)}</span
      >
    </FormRow>
    <FormRow label="Resolution" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatResolution(stats.resolution)}</span
      >
    </FormRow>
    <FormRow label="Dynamic range" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatDynamicRange(stats.dynamicRange)}</span
      >
    </FormRow>
    <FormRow label="Video codecs" inline>
      <span class="text-subheadline text-label-secondary"
        >{formatCodecs(stats.codecs)}</span
      >
    </FormRow>
    {#each gapRows as row (row.key)}
      {#if row.count > 0}
        <ListRow
          title={row.label}
          onclick={() => openGap(row)}
        >
          <span class="text-subheadline text-label-secondary"
            >{formatCount(row.count)}</span
          >
        </ListRow>
      {:else}
        <ListRow title={row.label}>
          <span class="text-subheadline text-label-secondary">0</span>
        </ListRow>
      {/if}
    {/each}
  {/if}
  {#snippet actions()}
    {#if failure}
      <Button variant="secondary" onclick={onretry}>Try again</Button>
    {/if}
  {/snippet}
</FormGroup>

<MetadataGapDialog
  bind:open={dialogOpen}
  libraryId={library.id}
  libraryName={library.name}
  gap={dialogGap}
  {revision}
  count={dialogGap === undefined || gaps === undefined
    ? 0
    : gaps[dialogGap.key]}
/>
