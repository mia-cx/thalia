<script lang="ts">
import HistoryIcon from "@lucide/svelte/icons/history";
import { client } from "$lib/api.ts";
import { cardLabel, formatDuration, itemHref } from "$lib/browse.ts";
import Artwork from "$lib/components/Artwork.svelte";
import AdminPage from "$lib/components/admin/AdminPage.svelte";
import EmptyState from "$lib/components/admin/EmptyState.svelte";
import FormGroup from "$lib/components/admin/FormGroup.svelte";
import ListRow from "$lib/components/admin/ListRow.svelte";
import Failure from "$lib/components/Failure.svelte";
import { Button } from "$lib/components/ui/button/index.ts";
import * as Select from "$lib/components/ui/select/index.ts";
import { readFailure } from "$lib/errors.ts";
import { groupByDay, type Play } from "$lib/history.ts";
import type { PageProps } from "./$types";

const { data }: PageProps = $props();

const scopes = [
  { value: "mine", label: "Yours" },
  { value: "everyone", label: "Everyone's" },
];

let scope = $state<"mine" | "everyone">("mine");
let plays = $state<Play[] | undefined>(undefined);
let cursor = $state<string | null>(null);
let loading = $state(false);
let failure = $state<ReturnType<typeof readFailure> | undefined>(undefined);
// A scope switch drops answers still in flight for the previous one.
let generation = 0;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

async function load(more: boolean) {
  const ticket = more ? generation : ++generation;
  if (!more) plays = undefined;
  loading = true;
  failure = undefined;
  try {
    const page = await client.history.list({
      everyone: scope === "everyone",
      cursor: more ? (cursor ?? undefined) : undefined,
    });
    if (ticket !== generation) return;
    plays = [...(more ? (plays ?? []) : []), ...page.items];
    cursor = page.cursor;
  } catch (error) {
    if (ticket === generation) failure = readFailure(error);
  } finally {
    if (ticket === generation) loading = false;
  }
}

void load(false);

function caption(play: Play) {
  const parts = [
    timeFormat.format(new Date(play.startedAt)),
    formatDuration(play.playedSeconds),
  ];
  return scope === "everyone"
    ? [play.user.displayName, ...parts].join(" · ")
    : parts.join(" · ");
}
</script>

<AdminPage title="History">
  {#snippet actions()}
    {#if data.me.admin}
      <Select.Root
        type="single"
        value={scope}
        onValueChange={(value) => {
          if (value !== "mine" && value !== "everyone") return;
          scope = value;
          void load(false);
        }}
        items={scopes}
      >
        <Select.Trigger class="w-36" aria-label="Whose history"
          ><Select.Value /></Select.Trigger
        >
        <Select.Content>
          {#each scopes as option (option.value)}
            <Select.Item value={option.value} label={option.label}
              >{option.label}</Select.Item
            >
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
  {/snippet}

  {#if plays === undefined}
    {#if failure}
      <Failure {failure} />
      <div>
        <Button variant="secondary" onclick={() => load(false)}
          >Try again</Button
        >
      </div>
    {:else}
      <FormGroup title="Today" loading={3}><span></span></FormGroup>
    {/if}
  {:else if plays.length === 0}
    <FormGroup>
      <EmptyState icon={HistoryIcon} title="Nothing watched yet">
        <Button variant="secondary" href="/">Go to Home</Button>
      </EmptyState>
    </FormGroup>
  {:else}
    {#each groupByDay(plays) as day (day.heading)}
      <FormGroup title={day.heading}>
        {#each day.plays as play (play.id)}
          {@const href = itemHref(play.item)}
          <ListRow
            title={cardLabel(play.item)}
            caption={caption(play)}
            href={href ?? undefined}
          >
            {#snippet leading()}
              <span class="block w-8 shrink-0">
                <Artwork
                  artworkId={play.item.show?.posterArtworkId ??
                    play.item.posterArtworkId}
                  title={cardLabel(play.item)}
                  sizes="2rem"
                  kind={play.item.kind}
                  fallbackTitle={false}
                />
              </span>
            {/snippet}
          </ListRow>
        {/each}
      </FormGroup>
    {/each}
    {#if failure}
      <Failure {failure} />
    {/if}
    {#if cursor !== null}
      <div>
        <Button
          variant="secondary"
          onclick={() => load(true)}
          disabled={loading}>Show more</Button
        >
      </div>
    {/if}
  {/if}
</AdminPage>
