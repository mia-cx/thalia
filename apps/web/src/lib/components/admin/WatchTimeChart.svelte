<script lang="ts">
import * as Tooltip from "$lib/components/ui/tooltip/index.ts";
import { formatWatchTime, type HistoryInsights } from "$lib/history.ts";

/** Weekly watch time as columns, oldest week first; each column names its week and total on hover and focus. */
const { weeks }: { weeks: HistoryInsights["weeks"] } = $props();

const dayFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const peak = $derived(Math.max(...weeks.map((week) => week.seconds)));
const peakIndex = $derived(
  peak === 0 ? -1 : weeks.findIndex((week) => week.seconds === peak),
);
// Every third week carries a date, counted back from this week.
const labelled = (index: number) => (weeks.length - 1 - index) % 3 === 0;
</script>

<div class="px-4 pt-4 pb-3">
  <ol
    class="flex h-40 items-end gap-0.5 border-b border-separator"
    aria-label="Watch time per week"
  >
    {#each weeks as week, index (week.start)}
      {@const date = dayFormat.format(new Date(week.start))}
      {@const total = formatWatchTime(week.seconds)}
      <li class="relative flex h-full min-w-0 flex-1 flex-col justify-end">
        {#if index === peakIndex}
          <span
            class="pointer-events-none absolute left-1/2 -translate-x-1/2 text-caption-1 whitespace-nowrap text-label-secondary tabular-nums"
            style:bottom="calc((100% - 1.25rem) * {week.seconds / peak} + 0.25rem)"
            aria-hidden="true">{total}</span
          >
        {/if}
        <Tooltip.Root delayDuration={0}>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="group flex h-[calc(100%-1.25rem)] w-full cursor-default items-end justify-center rounded-xs"
                aria-label="Week of {date}: {total}"
              >
                <span
                  class="block w-full max-w-6 rounded-t-xs bg-tint transition-opacity duration-(--duration-quick) group-hover:opacity-80"
                  style:height="{peak === 0 ? 0 : (week.seconds / peak) * 100}%"
                ></span>
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>
            <span class="font-semibold tabular-nums">{total}</span>
            <span class="text-label-secondary">Week of {date}</span>
          </Tooltip.Content>
        </Tooltip.Root>
      </li>
    {/each}
  </ol>
  <div class="mt-1.5 flex gap-0.5" aria-hidden="true">
    {#each weeks as week, index (week.start)}
      <span
        class="min-w-0 flex-1 text-center text-caption-1 whitespace-nowrap text-label-secondary"
        >{labelled(index) ? dayFormat.format(new Date(week.start)) : ""}</span
      >
    {/each}
  </div>
</div>
