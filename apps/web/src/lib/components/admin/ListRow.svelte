<script lang="ts">
import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils.ts";

/** A list row inside a panel; with `href` the whole row is a link, with `onclick` a button. `actions` holds trailing controls kept outside the row's link. */
const {
  title,
  caption,
  detail,
  tone = "secondary",
  href,
  onclick,
  current = false,
  leading,
  children,
  actions,
}: {
  title: string;
  caption?: string;
  /** A second caption line, or extra content under the caption such as a progress bar. */
  detail?: string | Snippet;
  /** The caption's colour; destructive marks a failure such as an unreachable registry. */
  tone?: "secondary" | "destructive";
  href?: string;
  onclick?: (event: MouseEvent) => void;
  current?: boolean;
  leading?: Snippet;
  children?: Snippet;
  /** Trailing controls such as a remove button, kept outside the row's link. */
  actions?: Snippet;
} = $props();

const rowClass =
  "relative flex min-h-12 items-center gap-3 px-4 py-2.5 before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-separator first:before:hidden first:rounded-t-lg last:rounded-b-lg";
</script>

{#snippet text()}
  {#if leading}
    <span class="shrink-0">{@render leading()}</span>
  {/if}
  <span class="min-w-0 flex-1">
    <span class="block truncate text-subheadline font-medium text-label"
      >{title}</span
    >
    {#if caption}
      <span
        class="block text-footnote {tone === 'destructive'
          ? 'break-words text-destructive'
          : 'truncate text-label-secondary'}">{caption}</span
      >
    {/if}
    {#if typeof detail === "string"}
      <span class="block truncate text-footnote text-label-secondary"
        >{detail}</span
      >
    {:else if detail}
      {@render detail()}
    {/if}
  </span>
{/snippet}

{#snippet inner()}
  {@render text()}
  {#if children}
    {@render children()}
  {/if}
  {#if href || onclick}
    <ChevronRightIcon class="size-4 shrink-0 text-label-tertiary" />
  {/if}
  {#if actions}
    <span class="relative z-10 shrink-0">{@render actions()}</span>
  {/if}
{/snippet}

{#if href && actions}
  <div
    class={cn(rowClass, "transition-colors hover:bg-fill")}
    aria-current={current ? "page" : undefined}
  >
    <a
      {href}
      class="flex min-w-0 flex-1 items-center gap-3 no-underline after:absolute after:inset-0"
    >
      {@render text()}
    </a>
    {#if children}
      {@render children()}
    {/if}
    <ChevronRightIcon class="size-4 shrink-0 text-label-tertiary" />
    <span class="relative z-10 shrink-0">{@render actions()}</span>
  </div>
{:else if href}
  <a
    {href}
    aria-current={current ? "page" : undefined}
    class={cn(rowClass, "no-underline transition-colors hover:bg-fill")}
  >
    {@render inner()}
  </a>
{:else if onclick}
  <button
    type="button"
    {onclick}
    aria-current={current ? "page" : undefined}
    class={cn(rowClass, "w-full text-start transition-colors hover:bg-fill")}
  >
    {@render inner()}
  </button>
{:else}
  <div class={rowClass} aria-current={current ? "page" : undefined}>
    {@render inner()}
  </div>
{/if}
