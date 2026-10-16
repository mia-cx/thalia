<script lang="ts">
import PlayIcon from "@lucide/svelte/icons/play";
import type { client } from "$lib/api.ts";
import { artworkSrcset, artworkUrl, episodeCode } from "$lib/browse.ts";
import { Button } from "$lib/components/ui/button/index.ts";
import type { PlayerState } from "$lib/player-state.ts";
import { cn } from "$lib/utils.ts";

type NextEpisode = NonNullable<
  Awaited<ReturnType<typeof client.playback.next>>
>;

const {
  episode,
  upNext,
  controls,
  onplay,
  ondismiss,
}: {
  /** The Episode the card offers. */
  episode: NextEpisode;
  /** The card's countdown state. */
  upNext: NonNullable<PlayerState["upNext"]>;
  /** Whether the player controls show; the card follows them except while counting down. */
  controls: boolean;
  onplay: () => void;
  ondismiss: () => void;
} = $props();

const visible = $derived(controls || upNext.remaining !== null);
const counting = $derived(upNext.remaining !== null);
const dismissLabel = $derived(
  upNext.at === "credits"
    ? "Watch credits"
    : upNext.remaining !== null
      ? "Cancel"
      : "Close",
);
const code = $derived(episodeCode(episode));
const announce = $derived(
  `Next episode: ${[code, episode.title].filter((part) => part !== null).join(", ")}.${
    upNext.remaining !== null ? ` Plays in ${upNext.total} seconds.` : ""
  }`,
);

// The ring depletes once per second; its transition smooths the jump.
const ringRadius = 15.5;
const ringLength = 2 * Math.PI * ringRadius;
const ringOffset = $derived(
  ringLength * (1 - (upNext.remaining ?? upNext.total) / upNext.total),
);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events, a11y_interactive_supports_focus, a11y_no_noninteractive_element_interactions: the stopPropagation keeps card clicks off the stage's play toggle -->
<div
  role="region"
  aria-label="Next episode"
  class={cn(
    "material-thick absolute z-10 flex w-72 flex-col gap-2 rounded-xl p-3 shadow-float transition-opacity ease-smooth-out max-sm:inset-x-4 max-sm:w-auto",
    visible
      ? "opacity-100 duration-(--duration-fast)"
      : "pointer-events-none opacity-0 duration-(--duration-medium)",
  )}
  style="bottom: calc(var(--controls-height, 0px) + 0.75rem); right: max(var(--gutter, 1rem), env(safe-area-inset-right));"
  onclick={(event) => event.stopPropagation()}
>
  {#key `${episode.id}:${upNext.at}`}
    <p class="sr-only" aria-live="polite">{announce}</p>
  {/key}
  <p class="text-caption-1 font-semibold tracking-wide text-white/70 uppercase">
    Next episode
  </p>
  <div class="flex items-center gap-3">
    <div
      class="aspect-video w-28 shrink-0 overflow-hidden rounded-md bg-white/10"
    >
      {#if episode.thumbArtworkId !== null}
        <img
          src={artworkUrl(episode.thumbArtworkId, 320)}
          srcset={artworkSrcset(episode.thumbArtworkId, [320, 480])}
          sizes="112px"
          alt=""
          class="size-full object-cover"
        />
      {/if}
    </div>
    <div class="min-w-0">
      {#if code !== null}
        <p class="text-footnote text-white/70">{code}</p>
      {/if}
      <p class="truncate text-subheadline font-semibold">{episode.title}</p>
    </div>
  </div>
  <div class="flex items-center gap-2">
    <Button
      variant="glass"
      class="relative flex-1"
      aria-label="Play next episode"
      onclick={onplay}
    >
      <span class="relative inline-flex size-5 items-center justify-center">
        <PlayIcon fill="currentColor" aria-hidden="true" />
        {#if counting}
          <svg
            aria-hidden="true"
            class="absolute -inset-1.5 size-8 -rotate-90"
            viewBox="0 0 36 36"
          >
            <circle
              cx="18"
              cy="18"
              r={ringRadius}
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-dasharray={ringLength}
              stroke-dashoffset={ringOffset}
              class="next-episode-ring"
            />
          </svg>
        {/if}
      </span>
      Play
    </Button>
    <Button variant="glass" onclick={ondismiss}>{dismissLabel}</Button>
  </div>
</div>

<style>
  .next-episode-ring {
    transition: stroke-dashoffset 1s linear;
  }

  @media (prefers-reduced-motion: reduce) {
    .next-episode-ring {
      transition: none;
    }
  }
</style>
