<script lang="ts">
import { onDestroy } from "svelte";
import { checkHealth } from "$lib/admin.ts";
import { client } from "$lib/api.ts";
import { cardLabel, formatBytes, itemHref } from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import FormRow from "$lib/components/admin/FormRow.svelte";
import LibraryStats from "$lib/components/admin/LibraryStats.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import ScanState from "$lib/components/admin/ScanState.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import { Progress } from "$lib/components/ui/progress/index.ts";
import { type FailureCode, readFailure } from "$lib/errors.ts";
import { followEvents } from "$lib/events.ts";
import { resource } from "$lib/resource.svelte.ts";
import type { ScanStatus } from "$lib/scan.ts";
import {
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
let scans = $state<Record<string, ScanStatus | null>>({});
let stats = $state<readonly LibraryStatsData[]>([]);
let gaps = $state<readonly LibraryGaps[]>([]);
let statsFailures = $state<
  Record<string, { code: FailureCode; message: string } | undefined>
>({});

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

function clientLabel(session: Session) {
  if (session.clientName === null) return "Unknown app";
  if (session.deviceName === null) return session.clientName;
  return `${session.clientName} on ${session.deviceName}`;
}

// One library's stats and gaps reload together; a scan's event burst coalesces
// to one in-flight refetch plus one rerun when it was marked dirty.
const refreshing = new Map<string, { running: boolean; dirty: boolean }>();

async function loadLibraryStats(libraryId: string) {
  try {
    const [nextStats, nextGaps] = await Promise.all([
      client.libraries.stats({ id: libraryId }),
      client.libraries.metadataGaps({ id: libraryId }),
    ]);
    const [statEntry] = nextStats;
    const [gapEntry] = nextGaps;
    if (statEntry !== undefined) stats = replaceLibraryEntry(stats, statEntry);
    if (gapEntry !== undefined) gaps = replaceLibraryEntry(gaps, gapEntry);
    statsFailures = { ...statsFailures, [libraryId]: undefined };
  } catch (error) {
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
  const [statsResult, gapsResult] = await Promise.allSettled([
    client.libraries.stats({}),
    client.libraries.metadataGaps({}),
  ]);
  const failures: typeof statsFailures = {};
  if (statsResult.status === "fulfilled") stats = statsResult.value;
  else
    for (const library of list)
      failures[library.id] = readFailure(statsResult.reason);
  if (gapsResult.status === "fulfilled") gaps = gapsResult.value;
  else
    for (const library of list)
      failures[library.id] = readFailure(gapsResult.reason);
  statsFailures = failures;
}

const controller = new AbortController();
void loadHealth();
void followEvents(
  (signal) => client.events.stream(undefined, { signal }),
  (event) => {
    if (event.kind === "library.changed" || event.kind === "job.progress")
      void loadScans();
    if (event.kind === "library.changed") {
      refreshLibraryStats(event.libraryId);
      void freeSpace.reload();
    }
    if (event.kind === "session.state") void sessions.reload();
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
    />
  {/each}

  {#if (freeSpace.data !== undefined && freeSpace.data.length > 0) || freeSpace.failure !== undefined}
    <FormGroup title="Free space" failure={freeSpace.failure ?? undefined}>
      {#each freeSpace.data ?? [] as filesystem (filesystem.roots[0]?.id)}
        {#if filesystem.state === "available"}
          {@const multiLibrary =
            new Set(filesystem.roots.map((root) => root.libraryId)).size > 1}
          <FormRow
            label="{formatBytes(filesystem.availableBytes)} free of {formatBytes(
              filesystem.totalBytes,
            )}"
          >
            <span class="block text-footnote text-label-secondary"
              >{filesystem.roots
                .map((root) =>
                  multiLibrary ? `${root.libraryName}: ${root.path}` : root.path,
                )
                .join(" · ")}</span
            >
            <Progress
              value={filesystem.usedBytes}
              max={filesystem.totalBytes}
              aria-label="Used"
              class="mt-2"
            />
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
</AdminPage>
