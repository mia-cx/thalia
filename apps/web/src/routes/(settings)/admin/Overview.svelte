<script lang="ts">
import { onDestroy } from "svelte";
import { checkHealth } from "$lib/admin.ts";
import { client } from "$lib/api.ts";
import {
  cardLabel,
  formatBytes,
  formatDuration,
  itemHref,
} from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FilesystemUsage from "$lib/components/admin/FilesystemUsage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import LibraryStats from "$lib/components/admin/LibraryStats.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ScanState from "$lib/components/admin/ScanState.svelte";
import WatchTimeChart from "$lib/components/admin/WatchTimeChart.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { type FailureCode, readFailure } from "$lib/errors.ts";
import { followEvents } from "$lib/events.ts";
import { formatWatchTime, playMethods } from "$lib/history.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { ScanStatus } from "$lib/scan.ts";
import {
  formatCount,
  type LibraryGaps,
  type LibraryStats as LibraryStatsData,
  replaceLibraryEntry,
} from "$lib/stats.ts";

type Session = NonNullable<
  Awaited<ReturnType<typeof client.playback.sessions>>
>[number];

const libraries = resource(() => client.libraries.list());
const sessions = resource(() => client.playback.sessions());
const freeSpace = resource(() => client.libraries.freeSpace());
const summary = resource(() => client.libraries.summary());
const insights = resource(() => client.history.insights());
let scans = $state<Record<string, ScanStatus | null>>({});
let stats = $state<readonly LibraryStatsData[]>([]);
let gaps = $state<readonly LibraryGaps[]>([]);
let statsFailures = $state<
  Record<string, { code: FailureCode; message: string } | undefined>
>({});
// Bumps per library on every library.changed; open gap dialogs reconcile on it.
let revisions = $state<Record<string, number>>({});

let health = $state<"ready" | "no-database" | "unreachable" | undefined>(
  undefined,
);
const healthStates = {
  ready: {
    server: { label: "Online", tone: "bg-success" },
    database: { label: "Connected", tone: "bg-success" },
  },
  "no-database": {
    server: { label: "Online", tone: "bg-success" },
    database: { label: "Unavailable", tone: "bg-destructive" },
  },
  unreachable: {
    server: { label: "Unreachable", tone: "bg-destructive" },
    database: { label: "Unknown", tone: "bg-label-tertiary" },
  },
} as const;

// Event-driven lists also reload on a timer; not every change sends an event.
const reloadMs = 10_000;

async function loadHealth() {
  health = await checkHealth();
}

async function loadScans() {
  const list = libraries.data;
  if (list === undefined) return;
  const entries = await Promise.allSettled(
    list.map(async (library) =>
      client.libraries.scanStatus({ id: library.id }),
    ),
  );
  const next: Record<string, ScanStatus | null> = {};
  for (const [i, entry] of entries.entries())
    next[list[i].id] = entry.status === "fulfilled" ? entry.value : null;
  scans = next;
}

const mediumLabels = { movies: "Movies", shows: "Shows" } as const;

const stateLabels: Record<Session["state"], string> = {
  queued: "Queued",
  starting: "Starting",
  playing: "Playing",
  stopped: "Stopped",
};

function playsCaption(entry: { plays: number; seconds: number }) {
  return `${entry.plays === 1 ? "1 play" : `${formatCount(entry.plays)} plays`} · ${formatWatchTime(entry.seconds)}`;
}

function clientLabel(session: Session) {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

// One library's stats and gaps reload together; a scan's event burst coalesces
// to one in-flight refetch plus one rerun when it was marked dirty.
const refreshing = new Map<string, { running: boolean; dirty: boolean }>();

// A load bumps every library it covers and applies answers only for those
// still at its sequence, so an older whole-list answer can't overwrite a
// newer per-library refetch.
const statsSeq = new Map<string, number>();
function bumpStatsSeq(ids: readonly string[]) {
  const captured = new Map<string, number>();
  for (const id of ids) {
    const next = (statsSeq.get(id) ?? 0) + 1;
    statsSeq.set(id, next);
    captured.set(id, next);
  }
  return captured;
}
const seqMatches = (captured: Map<string, number>, id: string) =>
  statsSeq.get(id) === captured.get(id);

async function loadLibraryStats(libraryId: string) {
  const captured = bumpStatsSeq([libraryId]);
  try {
    const [nextStats, nextGaps] = await Promise.all([
      client.libraries.stats({ id: libraryId }),
      client.libraries.metadataGaps({ id: libraryId }),
    ]);
    if (!seqMatches(captured, libraryId)) return;
    const [statEntry] = nextStats;
    const [gapEntry] = nextGaps;
    if (statEntry !== undefined) stats = replaceLibraryEntry(stats, statEntry);
    if (gapEntry !== undefined) gaps = replaceLibraryEntry(gaps, gapEntry);
    statsFailures = { ...statsFailures, [libraryId]: undefined };
  } catch (error) {
    if (!seqMatches(captured, libraryId)) return;
    statsFailures = { ...statsFailures, [libraryId]: readFailure(error) };
  }
}

function refreshLibraryStats(libraryId: string) {
  const state = refreshing.get(libraryId) ?? { running: false, dirty: false };
  refreshing.set(libraryId, state);
  if (state.running) {
    state.dirty = true;
    return;
  }
  state.running = true;
  void (async () => {
    try {
      do {
        state.dirty = false;
        await loadLibraryStats(libraryId);
      } while (state.dirty);
    } finally {
      state.running = false;
      refreshing.delete(libraryId);
    }
  })();
}

async function loadAllStats() {
  const list = libraries.data;
  if (list === undefined) return;
  const captured = bumpStatsSeq(list.map((library) => library.id));
  const [statsResult, gapsResult] = await Promise.allSettled([
    client.libraries.stats({}),
    client.libraries.metadataGaps({}),
  ]);
  // Merge per library so entries a newer refetch already answered stay put.
  for (const library of list) {
    if (!seqMatches(captured, library.id)) continue;
    const statEntry =
      statsResult.status === "fulfilled"
        ? statsResult.value.find((entry) => entry.libraryId === library.id)
        : undefined;
    const gapEntry =
      gapsResult.status === "fulfilled"
        ? gapsResult.value.find((entry) => entry.libraryId === library.id)
        : undefined;
    if (statEntry !== undefined) stats = replaceLibraryEntry(stats, statEntry);
    if (gapEntry !== undefined) gaps = replaceLibraryEntry(gaps, gapEntry);
    const failed =
      statsResult.status === "rejected"
        ? statsResult.reason
        : gapsResult.status === "rejected"
          ? gapsResult.reason
          : undefined;
    statsFailures = {
      ...statsFailures,
      [library.id]: failed === undefined ? undefined : readFailure(failed),
    };
  }
}

const controller = new AbortController();
void loadHealth();
void followEvents(
  (signal) => client.events.stream(undefined, { signal }),
  (event) => {
    if (event.kind === "library.changed" || event.kind === "job.progress")
      void loadScans();
    if (event.kind === "library.changed") {
      revisions = {
        ...revisions,
        [event.libraryId]: (revisions[event.libraryId] ?? 0) + 1,
      };
      refreshLibraryStats(event.libraryId);
      void freeSpace.reload();
      void summary.reload();
    }
    if (event.kind === "session.state") {
      void sessions.reload();
      if (event.state === "stopped") void insights.reload();
    }
  },
  controller.signal,
);
const timer = setInterval(() => {
  void loadHealth();
  void libraries.reload();
  void loadScans();
  void sessions.reload();
}, reloadMs);
let knownLibraryIds = "";
$effect(() => {
  if (libraries.data !== undefined) void loadScans();
});
$effect(() => {
  const list = libraries.data;
  if (list === undefined) return;
  const ids = list.map((library) => library.id).join("");
  if (ids === knownLibraryIds) return;
  knownLibraryIds = ids;
  void loadAllStats();
  void freeSpace.reload();
  void summary.reload();
});
onDestroy(() => {
  controller.abort();
  clearInterval(timer);
});
</script>

<AdminPage title="Overview">
  <FormGroup title="Health" loading={health === undefined ? 2 : undefined}>
    {#if health}
      {@const state = healthStates[health]}
      <FormRow label="Server" inline>
        <span class="flex items-center gap-2">
          <span class="size-2 rounded-full {state.server.tone}"></span>
          <span class="text-subheadline text-label-secondary"
            >{state.server.label}</span
          >
        </span>
      </FormRow>
      <FormRow label="Database" inline>
        <span class="flex items-center gap-2">
          <span class="size-2 rounded-full {state.database.tone}"></span>
          <span class="text-subheadline text-label-secondary"
            >{state.database.label}</span
          >
        </span>
      </FormRow>
    {/if}
  </FormGroup>

  <FormGroup
    title="Media"
    loading={
      summary.data === undefined && !summary.failure ? 3 : undefined
    }
    failure={summary.failure ?? undefined}
  >
    {#if summary.data !== undefined}
      {@const mediums = new Set(
        (libraries.data ?? []).map((library) => library.medium),
      )}
      {#if summary.data.movies > 0 || mediums.has("movies")}
        <FormRow label="Movies" inline>
          <span class="text-subheadline text-label-secondary"
            >{formatCount(summary.data.movies)}</span
          >
        </FormRow>
      {/if}
      {#if summary.data.shows > 0 || mediums.has("shows")}
        <FormRow label="Shows" inline>
          <span class="text-subheadline text-label-secondary"
            >{formatCount(summary.data.shows)}</span
          >
        </FormRow>
      {/if}
      {#if summary.data.episodes > 0 || mediums.has("shows")}
        <FormRow label="Episodes" inline>
          <span class="text-subheadline text-label-secondary"
            >{formatCount(summary.data.episodes)}</span
          >
        </FormRow>
      {/if}
      <FormRow label="Size on disk" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatBytes(summary.data.bytes)}</span
        >
      </FormRow>
      <FormRow label="Runtime" inline>
        <span class="text-subheadline text-label-secondary"
          >{formatDuration(summary.data.runtimeSeconds)}</span
        >
      </FormRow>
      {@const free = (freeSpace.data ?? []).filter(
        (filesystem) => filesystem.state === "available",
      )}
      {#if free.length > 0}
        <FormRow label="Free space" inline>
          <span class="text-subheadline text-label-secondary"
            >{formatBytes(
              free.reduce((sum, filesystem) => sum + filesystem.availableBytes, 0),
            )} free of {formatBytes(
              free.reduce((sum, filesystem) => sum + filesystem.totalBytes, 0),
            )}</span
          >
        </FormRow>
      {/if}
    {/if}
    {#snippet actions()}
      {#if summary.failure}
        <Button
          variant="secondary"
          onclick={() => summary.reload()}
          disabled={summary.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  <FormGroup
    title="Libraries"
    loading={libraries.data === undefined && !libraries.failure ? 3 : undefined}
    failure={libraries.failure ?? undefined}
  >
    {#if libraries.data !== undefined}
      {#each libraries.data as library (library.id)}
        <ListRow
          title={library.name}
          caption={mediumLabels[library.medium]}
          href="/admin/libraries/{library.id}"
        >
          <ScanState status={scans[library.id]} />
        </ListRow>
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >No libraries yet.</span
          >
        </div>
      {/each}
    {/if}
    {#snippet actions()}
      {#if libraries.failure}
        <Button
          variant="secondary"
          onclick={() => libraries.reload()}
          disabled={libraries.loading}>Try again</Button
        >
      {:else if libraries.data?.length === 0}
        <Button variant="secondary" href="/admin/libraries"
          >Add a library</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#each libraries.data ?? [] as library (library.id)}
    <LibraryStats
      {library}
      stats={stats.find((entry) => entry.libraryId === library.id)}
      gaps={gaps.find((entry) => entry.libraryId === library.id)}
      failure={statsFailures[library.id]}
      onretry={() => refreshLibraryStats(library.id)}
      revision={revisions[library.id] ?? 0}
    />
  {/each}

  {#if (freeSpace.data !== undefined && freeSpace.data.length > 0) || freeSpace.failure !== undefined}
    <FormGroup title="Free space" failure={freeSpace.failure ?? undefined}>
      {#each freeSpace.data ?? [] as filesystem (filesystem.roots[0]?.id)}
        {#if filesystem.state === "available"}
          <FormRow
            label="{formatBytes(filesystem.availableBytes)} free of {formatBytes(
              filesystem.totalBytes,
            )}"
          >
            <FilesystemUsage {filesystem} />
          </FormRow>
        {:else}
          {@const root = filesystem.roots[0]}
          <ListRow
            title={root?.path ?? ""}
            caption="Can't read this folder from the server"
          />
        {/if}
      {/each}
      {#snippet actions()}
        {#if freeSpace.failure}
          <Button
            variant="secondary"
            onclick={() => freeSpace.reload()}
            disabled={freeSpace.loading}>Try again</Button
          >
        {/if}
      {/snippet}
    </FormGroup>
  {/if}

  <FormGroup
    title="Now playing"
    loading={sessions.data === undefined ? 1 : undefined}
    failure={sessions.failure ?? undefined}
  >
    {#each sessions.data ?? [] as session (session.id)}
      {@const href = itemHref(session.item)}
      <ListRow
        title={cardLabel(session.item)}
        caption="{session.user.displayName} · {clientLabel(session)}"
        href={href ?? undefined}
      >
        {#snippet leading()}
          <span class="block w-8 shrink-0">
            <Artwork
              artworkId={session.item.posterArtworkId}
              title={cardLabel(session.item)}
              sizes="2rem"
              kind={session.item.kind}
              fallbackTitle={false}
            />
          </span>
        {/snippet}
        <span
          class="text-subheadline {session.state === 'playing'
            ? 'text-tint'
            : 'text-label-secondary'}">{stateLabels[session.state]}</span
        >
      </ListRow>
    {:else}
      <div class="relative min-h-12 px-4 py-2.5">
        <span class="text-subheadline text-label-secondary"
          >Nothing is playing.</span
        >
      </div>
    {/each}
    {#snippet actions()}
      <Button variant="secondary" size="sm" href="/admin/activity"
        >Open Activity</Button
      >
    {/snippet}
  </FormGroup>
  <FormGroup
    title="Watch time"
    loading={insights.data === undefined && !insights.failure ? 3 : undefined}
    failure={insights.failure ?? undefined}
  >
    {#if insights.data !== undefined}
      <WatchTimeChart weeks={insights.data.weeks} />
    {/if}
    {#snippet actions()}
      {#if insights.failure}
        <Button
          variant="secondary"
          onclick={() => insights.reload()}
          disabled={insights.loading}>Try again</Button
        >
      {/if}
    {/snippet}
  </FormGroup>

  {#if insights.data !== undefined}
    {@const data = insights.data}
    {@const methodTotal =
      data.methods.directPlay + data.methods.remux + data.methods.transcode}
    <FormGroup title="Top titles" description="Last 12 weeks">
      {#each data.topTitles as entry (entry.item.id)}
        {@const href = itemHref(entry.item)}
        <ListRow
          title={cardLabel(entry.item)}
          caption={playsCaption(entry)}
          href={href ?? undefined}
        >
          {#snippet leading()}
            <span class="block w-8 shrink-0">
              <Artwork
                artworkId={entry.item.posterArtworkId}
                title={cardLabel(entry.item)}
                sizes="2rem"
                kind={entry.item.kind}
                fallbackTitle={false}
              />
            </span>
          {/snippet}
        </ListRow>
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >Nothing watched yet.</span
          >
        </div>
      {/each}
    </FormGroup>

    <FormGroup title="Top users" description="Last 12 weeks">
      {#each data.topUsers as entry (entry.user.id)}
        <ListRow
          title={entry.user.displayName}
          caption={playsCaption(entry)}
          href="/admin/users/{entry.user.id}"
        />
      {:else}
        <div class="relative min-h-12 px-4 py-2.5">
          <span class="text-subheadline text-label-secondary"
            >Nothing watched yet.</span
          >
        </div>
      {/each}
    </FormGroup>

    <FormGroup title="Direct play and transcoding" description="Last 12 weeks">
      {#each playMethods as { key, label } (key)}
        {@const seconds = data.methods[key]}
        <FormRow {label} inline>
          <span class="text-subheadline text-label-secondary tabular-nums"
            >{formatWatchTime(seconds)}{methodTotal > 0
              ? ` · ${Math.round((seconds / methodTotal) * 100)}%`
              : ""}</span
          >
        </FormRow>
      {/each}
    </FormGroup>
  {/if}
</AdminPage>

